import { addDays, isIsoDate } from '@shared/dates'
import type { FeedingSchedule, FeedingSlot, Withdrawal } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { farmToday } from './days'
import { requirePermission } from './roles'
import { getSettings } from './settings'

/**
 * Feeding schedules (planned times and quantities) and what was actually done, and egg
 * withdrawal periods after treatments.
 *
 * A feeding counts as on time when done up to LATE_MINUTES after its planned time, late after that,
 * and missed when nothing was recorded by MISSED_MINUTES after it (or by the end of a past day).
 */
export const LATE_MINUTES = 30
export const MISSED_MINUTES = 60
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

export async function listSchedules(ctx: Ctx): Promise<FeedingSchedule[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT s.id, s.cage_id AS cageId, c.name AS cageName, s.at_time AS atTime, s.item_id AS itemId, i.name AS itemName,
         s.planned_kg AS plannedKg, s.notes, s.active
       FROM feeding_schedules s LEFT JOIN cages c ON c.id = s.cage_id LEFT JOIN inventory_items i ON i.id = s.item_id
       WHERE s.organization_id = ? AND s.farm_id = ? ORDER BY s.at_time, c.sort_order, s.id`
    )
    .all(ctx.org, ctx.farm)) as (Omit<FeedingSchedule, 'active'> & { active: number })[]
  return rows.map((r) => ({ ...r, active: !!r.active }))
}

export async function saveSchedule(ctx: Ctx, s: Omit<FeedingSchedule, 'cageName' | 'itemName' | 'id'> & { id: number | null }): Promise<number> {
  requirePermission(ctx, 'feeding.manage')
  assert(TIME.test(s.atTime), 'invalid_input', { field: 'atTime' })
  return ctx.db.transaction(async () => {
    if (s.cageId)
      assert(
        await ctx.db.prepare('SELECT 1 AS x FROM cages WHERE id = ? AND organization_id = ? AND farm_id = ?').get(s.cageId, ctx.org, ctx.farm),
        'cage_not_found'
      )
    if (s.itemId) {
      const i = (await ctx.db.prepare('SELECT category FROM inventory_items WHERE id = ? AND organization_id = ?').get(s.itemId, ctx.org)) as
        | { category: string }
        | undefined
      assert(i, 'item_not_found')
      assert(i.category === 'feed', 'item_not_feed')
    }
    const vals = [s.cageId, s.atTime, s.itemId, s.plannedKg, s.notes?.trim() || null, s.active ? 1 : 0]
    if (s.id) {
      const r = await ctx.db
        .prepare(
          'UPDATE feeding_schedules SET cage_id = ?, at_time = ?, item_id = ?, planned_kg = ?, notes = ?, active = ? WHERE id = ? AND organization_id = ? AND farm_id = ?'
        )
        .run(...vals, s.id, ctx.org, ctx.farm)
      assert(r.changes === 1, 'not_found')
      await audit(ctx, { action: 'update', entity: 'feeding_schedule', entityId: s.id, details: s })
      return s.id
    }
    const id = (
      await ctx.db
        .prepare(
          'INSERT INTO feeding_schedules (organization_id, farm_id, cage_id, at_time, item_id, planned_kg, notes, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(ctx.org, ctx.farm, ...vals, ctx.now().toISOString())
    ).lastInsertRowid
    await audit(ctx, { action: 'create', entity: 'feeding_schedule', entityId: id, details: s })
    return id
  })()
}

/** The time now in the farm's time zone, HH:MM. */
async function nowTime(ctx: Ctx): Promise<string> {
  const tz = (await getSettings(ctx)).timezone
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(ctx.now())
}

/** Each active planned feeding of the farm on a date: on time, late, missed or still to come. */
export async function feedingStatus(ctx: Ctx, date: string): Promise<FeedingSlot[]> {
  assert(isIsoDate(date), 'invalid_date')
  const today = await farmToday(ctx)
  const now = date === today ? minutes(await nowTime(ctx)) : date < today ? 24 * 60 + MISSED_MINUTES : -1
  const rows = (await ctx.db
    .prepare(
      `SELECT s.id AS scheduleId, s.at_time AS atTime, s.cage_id AS cageId, c.name AS cageName, i.name AS itemName, s.planned_kg AS plannedKg,
         l.fed_at AS fedAt, l.note, u.display_name AS recordedBy
       FROM feeding_schedules s LEFT JOIN cages c ON c.id = s.cage_id LEFT JOIN inventory_items i ON i.id = s.item_id
       LEFT JOIN feeding_log l ON l.schedule_id = s.id AND l.feed_date = ? LEFT JOIN users u ON u.id = l.recorded_by
       WHERE s.organization_id = ? AND s.farm_id = ? AND s.active = 1 ORDER BY s.at_time, c.sort_order`
    )
    .all(date, ctx.org, ctx.farm)) as Omit<FeedingSlot, 'state'>[]
  return rows.map((r) => {
    const due = minutes(r.atTime)
    const state: FeedingSlot['state'] = r.fedAt
      ? minutes(r.fedAt) - due > LATE_MINUTES
        ? 'late'
        : 'done'
      : now > due + MISSED_MINUTES
        ? 'missed'
        : now >= due
          ? 'due'
          : 'upcoming'
    return { ...r, state }
  })
}

/** Records that a planned feeding was done, and when (once per feeding and date). */
export async function markFed(ctx: Ctx, scheduleId: number, date: string, fedAt: string, note: string | null) {
  const user = requireUser(ctx)
  requirePermission(ctx, 'feed.record')
  assert(isIsoDate(date) && date <= (await farmToday(ctx)), 'invalid_date')
  assert(TIME.test(fedAt), 'invalid_input', { field: 'fedAt' })
  await ctx.db.transaction(async () => {
    const s = await ctx.db
      .prepare('SELECT 1 AS x FROM feeding_schedules WHERE id = ? AND organization_id = ? AND farm_id = ?')
      .get(scheduleId, ctx.org, ctx.farm)
    assert(s, 'not_found')
    const dup = await ctx.db.prepare('SELECT 1 AS x FROM feeding_log WHERE schedule_id = ? AND feed_date = ?').get(scheduleId, date)
    assert(!dup, 'already_done')
    await ctx.db
      .prepare('INSERT INTO feeding_log (organization_id, schedule_id, feed_date, fed_at, note, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.org, scheduleId, date, fedAt, note?.trim() || null, user.id, ctx.now().toISOString())
    await audit(ctx, { action: 'feeding_done', entity: 'feeding_schedule', entityId: scheduleId, details: { date, fedAt, note } })
  })()
}

/**
 * Cages whose eggs are under a withdrawal period on a date: treated with a medicine that has an egg
 * withdrawal period (from its label or the veterinarian), on or before the date, within that period.
 * A withdrawal of N days after a treatment on day T holds back the eggs of days T to T + N − 1;
 * eggs may be used again from day T + N. A treatment of the whole farm holds back every cage.
 */
export async function activeWithdrawals(ctx: Pick<Ctx, 'db' | 'org' | 'farm'>, date: string): Promise<Withdrawal[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT t.cage_id AS cageId, c.name AS cageName, i.name AS item, d.business_date AS treatedOn, i.egg_withdrawal_days AS days
       FROM medicine_treatments t JOIN farm_days d ON d.id = t.day_id JOIN inventory_items i ON i.id = t.item_id
       LEFT JOIN cages c ON c.id = t.cage_id
       WHERE t.organization_id = ? AND d.farm_id = ? AND i.egg_withdrawal_days > 0 AND d.business_date <= ?
         AND d.business_date > DATE_SUB(?, INTERVAL i.egg_withdrawal_days DAY)
       ORDER BY d.business_date`
    )
    .all(ctx.org, ctx.farm, date, date)) as { cageId: number | null; cageName: string | null; item: string; treatedOn: string; days: number }[]
  return rows.map((r) => ({ cageId: r.cageId, cageName: r.cageName, item: r.item, treatedOn: r.treatedOn, eggsUsableFrom: addDays(r.treatedOn, r.days) }))
}
