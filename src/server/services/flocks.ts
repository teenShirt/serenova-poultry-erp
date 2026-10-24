import { addDays, isIsoDate } from '@shared/dates'
import {
  flockAge,
  hatchDateFromArrival,
  stageFor,
  type FarmRow,
  type FlockDetail,
  type FlockInput,
  type FlockPlacement,
  type FlockSummary,
  type HouseRow,
  type ReminderDue,
  type ReminderRow
} from '@shared/flocks'
import type { DailySeriesPoint } from '@shared/types'
import type { Ctx } from '../context'
import { AppError, assert } from '../errors'
import { ensureMainStores } from '../db/migrations'
import { dailySeries } from './analytics'
import { audit } from './audit'
import { farmToday, latestDay } from './days'
import { requirePermission } from './roles'
import { getSettings } from './settings'
import { loadCageDayStats } from './stats'
import { assertModule, getEntitlements, today as platformToday } from './subscriptions'

/**
 * Farms, poultry houses and flocks.
 *
 * A flock is tracked as a group, not bird by bird: its hen count, eggs, deaths, feed, water and
 * treatments are the records of the cages it occupies, for the dates it was placed in them.
 */

const OPEN_END = '9999-12-31'

// ---------------------------------------------------------------- farms

export async function listFarms(ctx: Ctx): Promise<FarmRow[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT f.id, f.code, f.name, f.location, f.status,
         (SELECT COUNT(*) FROM cages c WHERE c.farm_id = f.id AND c.active = 1) AS cages,
         (SELECT COUNT(*) FROM flocks k WHERE k.farm_id = f.id AND k.status = 'active') AS activeFlocks
       FROM farms f WHERE f.organization_id = ? ORDER BY f.status, f.name`
    )
    .all(ctx.org)) as Omit<FarmRow, 'current'>[]
  return rows.map((r) => ({ ...r, current: r.id === ctx.farm }))
}

/** Adds a farm (within the plan's farm limit) or changes one's name and location. */
export async function saveFarm(ctx: Ctx, f: { id: number | null; name: string; location: string | null }): Promise<number> {
  requirePermission(ctx, 'farms.manage')
  const name = f.name.trim()
  assert(name.length >= 2, 'required_field', { field: 'name' })
  return ctx.db.transaction(async () => {
    if (f.id) {
      const r = await ctx.db
        .prepare('UPDATE farms SET name = ?, location = ? WHERE id = ? AND organization_id = ?')
        .run(name, f.location?.trim() || null, f.id, ctx.org)
      assert(r.changes === 1, 'farm_not_found')
      await audit(ctx, { action: 'update', entity: 'farm', entityId: f.id, details: f })
      return f.id
    }
    const e = await getEntitlements(ctx.db, ctx.org, platformToday(ctx))
    if (e.usage.farms >= e.limits.maxFarms) throw new AppError('farm_limit_reached', { limit: e.limits.maxFarms, plan: e.planName })
    if (e.usage.farms >= 1) await assertModule(ctx, 'multi_farm')
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'farm'
    let code = base
    for (let i = 2; await ctx.db.prepare('SELECT 1 AS x FROM farms WHERE organization_id = ? AND code = ?').get(ctx.org, code); i++) code = `${base}-${i}`
    const id = (
      await ctx.db
        .prepare('INSERT INTO farms (organization_id, code, name, location, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(ctx.org, code, name, f.location?.trim() || null, ctx.now().toISOString())
    ).lastInsertRowid
    // Every farm has a main store, from which its daily feed and medicine are taken.
    await ensureMainStores(ctx.db, ctx.org)
    await audit(ctx, { action: 'create', entity: 'farm', entityId: id, details: { name, location: f.location } })
    return id
  })()
}

/** Archives a farm (its records stay; it no longer counts against the plan) or makes it active again. */
export async function setFarmStatus(ctx: Ctx, id: number, status: 'active' | 'archived', reason: string) {
  requirePermission(ctx, 'farms.manage')
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const farm = (await ctx.db.prepare('SELECT status FROM farms WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as { status: string } | undefined
    assert(farm, 'farm_not_found')
    if (status === 'archived') {
      assert(id !== ctx.farm, 'farm_in_use')
      const others = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM farms WHERE organization_id = ? AND status = 'active' AND id <> ?").get(ctx.org, id)) as {
        n: number
      }
      assert(others.n > 0, 'last_farm')
    } else if (farm.status !== 'active') {
      const e = await getEntitlements(ctx.db, ctx.org, platformToday(ctx))
      if (e.usage.farms >= e.limits.maxFarms) throw new AppError('farm_limit_reached', { limit: e.limits.maxFarms, plan: e.planName })
    }
    await ctx.db.prepare('UPDATE farms SET status = ? WHERE id = ? AND organization_id = ?').run(status, id, ctx.org)
    await audit(ctx, { action: status === 'archived' ? 'archive' : 'restore', entity: 'farm', entityId: id, reason: reason.trim() })
  })()
}

/** The farm a user switches to must be an active farm of their organization. */
export async function checkFarmForSwitch(ctx: Ctx, id: number) {
  const ok = await ctx.db.prepare("SELECT 1 AS x FROM farms WHERE id = ? AND organization_id = ? AND status = 'active'").get(id, ctx.org)
  assert(ok, 'farm_not_found')
}

// ---------------------------------------------------------------- houses

export async function listHouses(ctx: Ctx): Promise<HouseRow[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT h.id, h.code, h.name, h.active, h.sort_order AS sortOrder, h.notes,
         (SELECT COUNT(*) FROM cages c WHERE c.house_id = h.id) AS cages
       FROM houses h WHERE h.organization_id = ? AND h.farm_id = ? ORDER BY h.sort_order, h.code`
    )
    .all(ctx.org, ctx.farm)) as (Omit<HouseRow, 'active'> & { active: number })[]
  return rows.map((r) => ({ ...r, active: !!r.active }))
}

export async function saveHouse(ctx: Ctx, h: Omit<HouseRow, 'cages' | 'id'> & { id: number | null }): Promise<number> {
  requirePermission(ctx, 'cages.manage')
  const code = h.code.trim()
  assert(code.length > 0, 'required_field', { field: 'code' })
  return ctx.db.transaction(async () => {
    const dup = await ctx.db.prepare('SELECT 1 AS x FROM houses WHERE farm_id = ? AND code = ? AND NOT (id <=> ?)').get(ctx.farm, code, h.id)
    assert(!dup, 'house_code_taken')
    const vals = [code, h.name.trim() || code, h.active ? 1 : 0, h.sortOrder, h.notes?.trim() || null]
    if (h.id) {
      const r = await ctx.db
        .prepare('UPDATE houses SET code = ?, name = ?, active = ?, sort_order = ?, notes = ? WHERE id = ? AND organization_id = ? AND farm_id = ?')
        .run(...vals, h.id, ctx.org, ctx.farm)
      assert(r.changes === 1, 'house_not_found')
      await audit(ctx, { action: 'update', entity: 'house', entityId: h.id, details: h })
      return h.id
    }
    const id = (
      await ctx.db
        .prepare('INSERT INTO houses (organization_id, farm_id, code, name, active, sort_order, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.org, ctx.farm, ...vals, ctx.now().toISOString())
    ).lastInsertRowid
    await audit(ctx, { action: 'create', entity: 'house', entityId: id, details: h })
    return id
  })()
}

// ---------------------------------------------------------------- flocks

interface FlockRowDb {
  id: number
  code: string
  breed: string | null
  source: 'hatched' | 'purchased'
  hatch_date: string
  hatch_date_estimated: number
  arrival_date: string
  initial_count: number
  status: 'active' | 'closed'
  closed_on: string | null
  close_reason: string | null
  notes: string | null
}

async function placements(ctx: Ctx, flockIds: number[]): Promise<Map<number, FlockPlacement[]>> {
  const out = new Map<number, FlockPlacement[]>()
  if (!flockIds.length) return out
  const rows = (await ctx.db
    .prepare(
      `SELECT p.id, p.flock_id AS flockId, p.cage_id AS cageId, c.code AS cageCode, c.name AS cageName, h.name AS houseName,
         p.from_date AS fromDate, p.to_date AS toDate
       FROM flock_placements p JOIN cages c ON c.id = p.cage_id LEFT JOIN houses h ON h.id = c.house_id
       WHERE p.organization_id = ? AND p.flock_id IN (${flockIds.map(() => '?').join(',')})
       ORDER BY p.from_date, c.sort_order, c.code`
    )
    .all(ctx.org, ...flockIds)) as (FlockPlacement & { flockId: number })[]
  for (const { flockId, ...p } of rows) out.set(flockId, [...(out.get(flockId) ?? []), p])
  return out
}

/** Hens in each cage now: the latest day's closing count, or the starting count before any day. */
async function currentCageHens(ctx: Ctx): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  for (const c of (await ctx.db.prepare('SELECT id, initial_hens AS n FROM cages WHERE organization_id = ? AND farm_id = ?').all(ctx.org, ctx.farm)) as {
    id: number
    n: number
  }[]) {
    out.set(c.id, c.n)
  }
  const latest = await latestDay(ctx)
  if (latest) {
    const settings = await getSettings(ctx)
    for (const r of await loadCageDayStats(ctx, settings, latest.date, latest.date)) out.set(r.cageId, r.closing)
  }
  return out
}

async function flockDeaths(ctx: Ctx, flockIds: number[]): Promise<Map<number, number>> {
  if (!flockIds.length) return new Map()
  const rows = (await ctx.db
    .prepare(
      `SELECT p.flock_id AS id, COALESCE(SUM(m.quantity), 0) AS n
       FROM flock_placements p
       JOIN flock_movements m ON m.cage_id = p.cage_id AND m.type = 'death'
       JOIN farm_days d ON d.id = m.day_id AND d.business_date BETWEEN p.from_date AND COALESCE(p.to_date, '${OPEN_END}')
       WHERE p.organization_id = ? AND p.flock_id IN (${flockIds.map(() => '?').join(',')})
       GROUP BY p.flock_id`
    )
    .all(ctx.org, ...flockIds)) as { id: number; n: number }[]
  return new Map(rows.map((r) => [r.id, Number(r.n)]))
}

export async function listFlocks(ctx: Ctx, includeClosed = true): Promise<FlockSummary[]> {
  const rows = (await ctx.db
    .prepare(`SELECT * FROM flocks WHERE organization_id = ? AND farm_id = ? ${includeClosed ? '' : "AND status = 'active'"} ORDER BY status, hatch_date, code`)
    .all(ctx.org, ctx.farm)) as FlockRowDb[]
  const ids = rows.map((r) => r.id)
  const places = await placements(ctx, ids)
  const deaths = await flockDeaths(ctx, ids)
  const hens = await currentCageHens(ctx)
  const settings = await getSettings(ctx)
  const todayDate = await farmToday(ctx)
  return rows.map((r) => {
    const all = places.get(r.id) ?? []
    const open = all.filter((p) => p.toDate === null)
    const age = flockAge(r.hatch_date, r.status === 'closed' && r.closed_on ? r.closed_on : todayDate)
    return {
      id: r.id,
      code: r.code,
      breed: r.breed,
      source: r.source,
      hatchDate: r.hatch_date,
      hatchDateEstimated: !!r.hatch_date_estimated,
      arrivalDate: r.arrival_date,
      initialCount: r.initial_count,
      status: r.status,
      closedOn: r.closed_on,
      closeReason: r.close_reason,
      notes: r.notes,
      age,
      stage: stageFor(settings.productionStages, age.weeks)?.name ?? null,
      currentHens: r.status === 'active' ? open.reduce((s, p) => s + (hens.get(p.cageId) ?? 0), 0) : 0,
      deaths: deaths.get(r.id) ?? 0,
      cages: open
    }
  })
}

async function getFlockRow(ctx: Ctx, id: number): Promise<FlockRowDb> {
  const r = (await ctx.db.prepare('SELECT * FROM flocks WHERE id = ? AND organization_id = ? AND farm_id = ?').get(id, ctx.org, ctx.farm)) as
    | FlockRowDb
    | undefined
  assert(r, 'flock_not_found')
  return r
}

export async function getFlock(ctx: Ctx, id: number): Promise<FlockDetail> {
  const row = await getFlockRow(ctx, id)
  const summary = (await listFlocks(ctx)).find((f) => f.id === row.id)!
  const placed = (await placements(ctx, [id])).get(id) ?? []
  const treatments = placed.length
    ? ((await ctx.db
        .prepare(
          `SELECT d.business_date AS date, c.code AS cageCode, i.name AS item, t.quantity, i.unit, t.reason, t.prescribed_by AS prescribedBy
           FROM medicine_treatments t JOIN farm_days d ON d.id = t.day_id JOIN cages c ON c.id = t.cage_id
           JOIN inventory_items i ON i.id = t.item_id
           JOIN flock_placements p ON p.cage_id = t.cage_id AND p.flock_id = ? AND d.business_date BETWEEN p.from_date AND COALESCE(p.to_date, '${OPEN_END}')
           WHERE t.organization_id = ? ORDER BY d.business_date DESC, t.id DESC LIMIT 200`
        )
        .all(id, ctx.org)) as FlockDetail['treatments'])
    : []
  return { ...summary, placements: placed, reminders: await remindersFor(ctx, [summary], 10_000), treatments }
}

function resolveHatch(f: FlockInput): { hatch: string; estimated: boolean } {
  assert(isIsoDate(f.arrivalDate), 'invalid_date')
  if (f.hatchDate) {
    assert(isIsoDate(f.hatchDate) && f.hatchDate <= f.arrivalDate, 'hatch_after_arrival')
    return { hatch: f.hatchDate, estimated: false }
  }
  assert(f.ageOnArrivalDays !== null && Number.isInteger(f.ageOnArrivalDays) && f.ageOnArrivalDays >= 0 && f.ageOnArrivalDays <= 1500, 'hatch_or_age_required')
  return { hatch: hatchDateFromArrival(f.arrivalDate, f.ageOnArrivalDays), estimated: true }
}

export async function saveFlock(ctx: Ctx, f: FlockInput): Promise<number> {
  requirePermission(ctx, 'flocks.manage')
  const code = f.code.trim()
  assert(code.length > 0, 'required_field', { field: 'code' })
  const { hatch, estimated } = resolveHatch(f)
  assert(f.arrivalDate <= (await farmToday(ctx)), 'date_in_future')
  return ctx.db.transaction(async () => {
    const dup = await ctx.db.prepare('SELECT 1 AS x FROM flocks WHERE farm_id = ? AND code = ? AND NOT (id <=> ?)').get(ctx.farm, code, f.id)
    assert(!dup, 'flock_code_taken')
    const vals = [code, f.breed?.trim() || null, f.source, hatch, estimated ? 1 : 0, f.arrivalDate, f.initialCount, f.notes?.trim() || null]
    if (f.id) {
      const before = await getFlockRow(ctx, f.id)
      const first = (await ctx.db.prepare('SELECT MIN(from_date) AS d FROM flock_placements WHERE flock_id = ?').get(f.id)) as { d: string | null }
      assert(!first.d || first.d >= f.arrivalDate, 'placement_before_arrival')
      await ctx.db
        .prepare(
          'UPDATE flocks SET code = ?, breed = ?, source = ?, hatch_date = ?, hatch_date_estimated = ?, arrival_date = ?, initial_count = ?, notes = ? WHERE id = ? AND organization_id = ?'
        )
        .run(...vals, f.id, ctx.org)
      await audit(ctx, { action: 'update', entity: 'flock', entityId: f.id, details: { before, after: f } })
      return f.id
    }
    const id = (
      await ctx.db
        .prepare(
          `INSERT INTO flocks (organization_id, farm_id, code, breed, source, hatch_date, hatch_date_estimated, arrival_date, initial_count, notes, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.org, ctx.farm, ...vals, ctx.user?.id ?? null, ctx.now().toISOString())
    ).lastInsertRowid
    await audit(ctx, { action: 'create', entity: 'flock', entityId: id, details: f })
    return id
  })()
}

/**
 * Places a flock in cages from a date. A cage holds one flock at a time: a cage still holding
 * another flock on that date must first be emptied (end that placement).
 */
export async function placeFlock(ctx: Ctx, flockId: number, cageIds: number[], fromDate: string) {
  requirePermission(ctx, 'flocks.manage')
  assert(isIsoDate(fromDate), 'invalid_date')
  assert(cageIds.length > 0, 'required_field', { field: 'cageIds' })
  await ctx.db.transaction(async () => {
    const flock = await getFlockRow(ctx, flockId)
    assert(flock.status === 'active', 'flock_closed')
    assert(fromDate >= flock.arrival_date, 'placement_before_arrival')
    for (const cageId of new Set(cageIds)) {
      const cage = (await ctx.db.prepare('SELECT code FROM cages WHERE id = ? AND organization_id = ? AND farm_id = ?').get(cageId, ctx.org, ctx.farm)) as
        | { code: string }
        | undefined
      assert(cage, 'cage_not_found')
      const clash = (await ctx.db
        .prepare(
          `SELECT k.code FROM flock_placements p JOIN flocks k ON k.id = p.flock_id
           WHERE p.cage_id = ? AND COALESCE(p.to_date, '${OPEN_END}') >= ? LIMIT 1`
        )
        .get(cageId, fromDate)) as { code: string } | undefined
      if (clash) throw new AppError('cage_has_flock', { cage: cage.code, flock: clash.code })
      await ctx.db
        .prepare('INSERT INTO flock_placements (organization_id, flock_id, cage_id, from_date, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(ctx.org, flockId, cageId, fromDate, ctx.now().toISOString())
    }
    await audit(ctx, { action: 'place', entity: 'flock', entityId: flockId, details: { cageIds, fromDate } })
  })()
}

/** Ends a flock's stay in a cage on a date (its last day there). */
export async function endPlacement(ctx: Ctx, flockId: number, cageId: number, toDate: string) {
  requirePermission(ctx, 'flocks.manage')
  assert(isIsoDate(toDate), 'invalid_date')
  await ctx.db.transaction(async () => {
    await getFlockRow(ctx, flockId)
    const p = (await ctx.db
      .prepare('SELECT id, from_date AS fromDate FROM flock_placements WHERE flock_id = ? AND cage_id = ? AND organization_id = ? AND to_date IS NULL')
      .get(flockId, cageId, ctx.org)) as { id: number; fromDate: string } | undefined
    assert(p, 'placement_not_found')
    assert(toDate >= p.fromDate, 'invalid_date')
    await ctx.db.prepare('UPDATE flock_placements SET to_date = ? WHERE id = ?').run(toDate, p.id)
    await audit(ctx, { action: 'unplace', entity: 'flock', entityId: flockId, details: { cageId, toDate } })
  })()
}

/** Closes a flock (sold, culled or moved off the farm): its placements end on that date. */
export async function closeFlock(ctx: Ctx, id: number, date: string, reason: string) {
  requirePermission(ctx, 'flocks.manage')
  assert(isIsoDate(date), 'invalid_date')
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const f = await getFlockRow(ctx, id)
    assert(f.status === 'active', 'flock_closed')
    assert(date >= f.arrival_date, 'invalid_date')
    const late = (await ctx.db.prepare('SELECT MAX(from_date) AS d FROM flock_placements WHERE flock_id = ?').get(id)) as { d: string | null }
    assert(!late.d || date >= late.d, 'invalid_date')
    await ctx.db.prepare('UPDATE flock_placements SET to_date = ? WHERE flock_id = ? AND to_date IS NULL').run(date, id)
    await ctx.db.prepare("UPDATE flocks SET status = 'closed', closed_on = ?, close_reason = ? WHERE id = ?").run(date, reason.trim(), id)
    await audit(ctx, { action: 'close', entity: 'flock', entityId: id, reason: reason.trim(), details: { date } })
  })()
}

/** One point per date with the flock's age; figures are the sums over the cages it occupied that day. */
export async function flockSeries(ctx: Ctx, id: number, from: string, to: string): Promise<(DailySeriesPoint & { ageDays: number; ageWeeks: number })[]> {
  const f = await getFlockRow(ctx, id)
  const placed = (await placements(ctx, [id])).get(id) ?? []
  const inFlock = (cageId: number, date: string) => placed.some((p) => p.cageId === cageId && date >= p.fromDate && date <= (p.toDate ?? OPEN_END))
  const start = from < f.arrival_date ? f.arrival_date : from
  if (start > to) return []
  return (await dailySeries(ctx, start, to, null, (r) => inFlock(r.cageId, r.date))).map((p) => {
    const age = flockAge(f.hatch_date, p.date)
    return { ...p, ageDays: age.days, ageWeeks: age.weeks }
  })
}

// ---------------------------------------------------------------- age reminders

export async function listReminders(ctx: Ctx): Promise<ReminderRow[]> {
  const rows = (await ctx.db
    .prepare('SELECT id, at_week AS atWeek, title, instructions, active FROM flock_reminders WHERE organization_id = ? ORDER BY at_week, id')
    .all(ctx.org)) as (Omit<ReminderRow, 'active'> & { active: number })[]
  return rows.map((r) => ({ ...r, active: !!r.active }))
}

export async function saveReminder(ctx: Ctx, r: Omit<ReminderRow, 'id'> & { id: number | null }): Promise<number> {
  requirePermission(ctx, 'flocks.manage')
  const title = r.title.trim()
  assert(title.length >= 2, 'required_field', { field: 'title' })
  assert(Number.isInteger(r.atWeek) && r.atWeek >= 0 && r.atWeek <= 200, 'invalid_input', { field: 'atWeek' })
  return ctx.db.transaction(async () => {
    const vals = [r.atWeek, title, r.instructions?.trim() || null, r.active ? 1 : 0]
    if (r.id) {
      const u = await ctx.db
        .prepare('UPDATE flock_reminders SET at_week = ?, title = ?, instructions = ?, active = ? WHERE id = ? AND organization_id = ?')
        .run(...vals, r.id, ctx.org)
      assert(u.changes === 1, 'not_found')
      await audit(ctx, { action: 'update', entity: 'flock_reminder', entityId: r.id, details: r })
      return r.id
    }
    const id = (
      await ctx.db
        .prepare('INSERT INTO flock_reminders (organization_id, at_week, title, instructions, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.org, ...vals, ctx.user?.id ?? null, ctx.now().toISOString())
    ).lastInsertRowid
    await audit(ctx, { action: 'create', entity: 'flock_reminder', entityId: id, details: r })
    return id
  })()
}

/**
 * Each active reminder for each flock, from the flock's arrival on (reminders for ages before the
 * flock came to the farm are not shown). A reminder is due during its week of age and overdue after.
 */
export async function remindersFor(ctx: Ctx, flocks: FlockSummary[], horizonWeeks = 1): Promise<ReminderDue[]> {
  const active = flocks.filter((f) => f.status === 'active')
  if (!active.length) return []
  const reminders = (await listReminders(ctx)).filter((r) => r.active)
  const done = (await ctx.db
    .prepare(
      `SELECT r.flock_id AS flockId, r.reminder_id AS reminderId, r.outcome, r.note, r.done_at AS doneAt, u.display_name AS doneBy
       FROM flock_reminder_done r LEFT JOIN users u ON u.id = r.done_by
       WHERE r.organization_id = ? AND r.flock_id IN (${active.map(() => '?').join(',')})`
    )
    .all(ctx.org, ...active.map((f) => f.id))) as {
    flockId: number
    reminderId: number
    outcome: 'done' | 'skipped'
    note: string | null
    doneAt: string
    doneBy: string | null
  }[]
  const out: ReminderDue[] = []
  for (const f of active) {
    const arrivalWeeks = flockAge(f.hatchDate, f.arrivalDate).weeks
    for (const r of reminders) {
      if (r.atWeek < arrivalWeeks) continue
      const d = done.find((x) => x.flockId === f.id && x.reminderId === r.id)
      const state: ReminderDue['state'] = d ? d.outcome : f.age.weeks > r.atWeek ? 'overdue' : f.age.weeks === r.atWeek ? 'due' : 'upcoming'
      if (state === 'upcoming' && r.atWeek - f.age.weeks > horizonWeeks) continue
      const dueOn = addDays(f.hatchDate, r.atWeek * 7)
      out.push({
        flockId: f.id,
        flockCode: f.code,
        reminderId: r.id,
        atWeek: r.atWeek,
        title: r.title,
        instructions: r.instructions,
        state,
        dueOn,
        doneAt: d?.doneAt ?? null,
        doneBy: d?.doneBy ?? null,
        note: d?.note ?? null
      })
    }
  }
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn))
}

/** Marks a reminder done (or skipped) for a flock; anyone who records the farm's work may do this. */
export async function markReminder(ctx: Ctx, flockId: number, reminderId: number, outcome: 'done' | 'skipped', note: string | null) {
  const user = ctx.user
  if (!user) throw new AppError('not_logged_in')
  assert(
    ['flock.record', 'medicine.record', 'flocks.manage'].some((p) => user.permissions.includes(p)),
    'no_permission'
  )
  assert(outcome === 'done' || (note?.trim().length ?? 0) >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const f = await getFlockRow(ctx, flockId)
    assert(f.status === 'active', 'flock_closed')
    const r = await ctx.db.prepare('SELECT 1 AS x FROM flock_reminders WHERE id = ? AND organization_id = ?').get(reminderId, ctx.org)
    assert(r, 'not_found')
    const existing = await ctx.db.prepare('SELECT 1 AS x FROM flock_reminder_done WHERE flock_id = ? AND reminder_id = ?').get(flockId, reminderId)
    assert(!existing, 'already_done')
    await ctx.db
      .prepare('INSERT INTO flock_reminder_done (organization_id, flock_id, reminder_id, outcome, note, done_by, done_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.org, flockId, reminderId, outcome, note?.trim() || null, user.id, ctx.now().toISOString())
    await audit(ctx, { action: `reminder_${outcome}`, entity: 'flock', entityId: flockId, details: { reminderId, note } })
  })()
}
