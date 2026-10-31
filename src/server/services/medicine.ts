import { addDays, daysBetween, isIsoDate } from '@shared/dates'
import type { HealthEvent, MedicineDue, MedicineSchedule, Treatment } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { requireCageDay, requireWritableDay } from './days'
import { getItem, syncLinkedTxn } from './inventory'
import { requirePermission } from './roles'

const treatmentSelect = `SELECT t.id, d.business_date AS date, t.cage_id AS cageId, c.name AS cageName, t.item_id AS itemId,
    i.name AS itemName, i.unit, t.batch_id AS batchId, b.batch_no AS batchNo, b.expiry_date AS expiryDate, t.quantity,
    t.administered_at AS administeredAt, t.reason, t.prescribed_by AS prescribedBy, t.notes, u.display_name AS recordedBy
  FROM medicine_treatments t JOIN farm_days d ON d.id = t.day_id LEFT JOIN cages c ON c.id = t.cage_id
  JOIN inventory_items i ON i.id = t.item_id LEFT JOIN inventory_batches b ON b.id = t.batch_id
  LEFT JOIN users u ON u.id = t.recorded_by`

export async function listTreatments(ctx: Ctx, from: string, to: string, cageId?: number | null): Promise<Treatment[]> {
  return (await ctx.db
    .prepare(
      `${treatmentSelect} WHERE t.organization_id = ? AND d.farm_id = ? AND d.business_date BETWEEN ? AND ? ${cageId ? 'AND t.cage_id = ?' : ''}
       ORDER BY d.business_date DESC, t.id DESC`
    )
    .all(...(cageId ? [ctx.org, ctx.farm, from, to, cageId] : [ctx.org, ctx.farm, from, to]))) as Treatment[]
}

export interface TreatmentInput {
  date: string
  cageId: number | null
  itemId: number
  batchId: number | null
  quantity: number
  administeredAt: string | null
  reason: string
  prescribedBy: string | null
  notes: string | null
}

/**
 * Records a treatment exactly as entered by the farm manager/veterinarian. The application
 * does not suggest medicines or dosages. Usage is deducted from stock via one linked transaction.
 */
export async function addTreatment(ctx: Ctx, t: TreatmentInput): Promise<number> {
  const user = requireUser(ctx)
  assert(t.quantity > 0 && Number.isFinite(t.quantity), 'quantity_positive')
  assert(t.reason.trim().length >= 3, 'reason_required')
  return ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, t.date)
    if (t.cageId) await requireCageDay(ctx, day, t.cageId)
    const item = await getItem(ctx, t.itemId)
    assert(item.category === 'medicine', 'item_not_medicine')
    if (t.batchId) {
      const b = (await ctx.db.prepare('SELECT item_id FROM inventory_batches WHERE id = ? AND organization_id = ?').get(t.batchId, ctx.org)) as
        | { item_id: number }
        | undefined
      assert(b && b.item_id === t.itemId, 'batch_mismatch')
    }
    const id = Number(
      (
        await ctx.db
          .prepare(
            `INSERT INTO medicine_treatments (organization_id, day_id, cage_id, item_id, batch_id, quantity, administered_at, reason,
             prescribed_by, notes, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            ctx.org,
            day.id,
            t.cageId,
            t.itemId,
            t.batchId,
            t.quantity,
            t.administeredAt,
            t.reason.trim(),
            t.prescribedBy,
            t.notes,
            user.id,
            ctx.now().toISOString()
          )
      ).lastInsertRowid
    )
    await syncLinkedTxn(ctx, {
      sourceType: 'treatment',
      sourceId: id,
      type: 'usage',
      itemId: t.itemId,
      batchId: t.batchId,
      signedQuantity: -t.quantity,
      date: t.date,
      dayId: day.id,
      cageId: t.cageId
    })
    await audit(ctx, { action: 'create', entity: 'treatment', entityId: id, dayId: day.id, details: { ...t, item: item.name } })
    await completeSchedules(ctx, t)
    return id
  })()
}

// ---------------------------------------------------------------- medicine schedules

/** Reminders show a planned medicine this many days before it is due. */
export const REMIND_DAYS = 3

const scheduleSelect = `SELECT s.id, s.cage_id AS cageId, c.name AS cageName, s.item_id AS itemId, i.name AS itemName, i.unit, s.dose,
    s.due_date AS dueDate, s.repeat_days AS repeatDays, s.notes, s.active, s.last_done_on AS lastDoneOn
  FROM medicine_schedules s LEFT JOIN cages c ON c.id = s.cage_id JOIN inventory_items i ON i.id = s.item_id`

type ScheduleRow = Omit<MedicineSchedule, 'active'> & { active: number }

export async function listSchedules(ctx: Ctx): Promise<MedicineSchedule[]> {
  const rows = (await ctx.db
    .prepare(`${scheduleSelect} WHERE s.organization_id = ? AND s.farm_id = ? ORDER BY s.active DESC, s.due_date, c.sort_order, s.id`)
    .all(ctx.org, ctx.farm)) as ScheduleRow[]
  return rows.map((r) => ({ ...r, active: !!r.active }))
}

/** Plans a medicine routine (or changes one): the date it is next due, and how often it repeats. */
export async function saveSchedule(ctx: Ctx, s: Omit<MedicineSchedule, 'cageName' | 'itemName' | 'unit' | 'lastDoneOn' | 'id'> & { id: number | null }) {
  const user = requireUser(ctx)
  requirePermission(ctx, 'medicine.schedule')
  assert(isIsoDate(s.dueDate), 'invalid_date')
  return ctx.db.transaction(async () => {
    if (s.cageId)
      assert(
        await ctx.db.prepare('SELECT 1 AS x FROM cages WHERE id = ? AND organization_id = ? AND farm_id = ?').get(s.cageId, ctx.org, ctx.farm),
        'cage_not_found'
      )
    assert((await getItem(ctx, s.itemId)).category === 'medicine', 'item_not_medicine')
    const vals = [s.cageId, s.itemId, s.dose, s.dueDate, s.repeatDays, s.notes?.trim() || null, s.active ? 1 : 0]
    if (s.id) {
      const r = await ctx.db
        .prepare(
          `UPDATE medicine_schedules SET cage_id = ?, item_id = ?, dose = ?, due_date = ?, repeat_days = ?, notes = ?, active = ?
           WHERE id = ? AND organization_id = ? AND farm_id = ?`
        )
        .run(...vals, s.id, ctx.org, ctx.farm)
      assert(r.changes === 1, 'not_found')
      await audit(ctx, { action: 'update', entity: 'medicine_schedule', entityId: s.id, details: s })
      return s.id
    }
    const id = Number(
      (
        await ctx.db
          .prepare(
            `INSERT INTO medicine_schedules (organization_id, farm_id, cage_id, item_id, dose, due_date, repeat_days, notes, active, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(ctx.org, ctx.farm, ...vals, user.id, ctx.now().toISOString())
      ).lastInsertRowid
    )
    await audit(ctx, { action: 'create', entity: 'medicine_schedule', entityId: id, details: s })
    return id
  })()
}

/**
 * A treatment with a planned medicine, for the same cage (or the whole farm, when planned for the
 * whole farm), given from REMIND_DAYS before its due date on, completes it: a repeating plan moves
 * to its next date (the treatment date + its interval), a one-off plan ends.
 */
async function completeSchedules(ctx: Ctx, t: TreatmentInput) {
  const due = (await ctx.db
    .prepare(
      `SELECT id, repeat_days FROM medicine_schedules WHERE organization_id = ? AND farm_id = ? AND active = 1 AND item_id = ?
         AND cage_id <=> ? AND due_date <= ?`
    )
    .all(ctx.org, ctx.farm, t.itemId, t.cageId, addDays(t.date, REMIND_DAYS))) as { id: number; repeat_days: number | null }[]
  for (const s of due) {
    if (s.repeat_days) {
      await ctx.db.prepare('UPDATE medicine_schedules SET due_date = ?, last_done_on = ? WHERE id = ?').run(addDays(t.date, s.repeat_days), t.date, s.id)
    } else {
      await ctx.db.prepare('UPDATE medicine_schedules SET active = 0, last_done_on = ? WHERE id = ?').run(t.date, s.id)
    }
    await audit(ctx, {
      action: 'schedule_done',
      entity: 'medicine_schedule',
      entityId: s.id,
      details: { date: t.date, next: s.repeat_days ? addDays(t.date, s.repeat_days) : null }
    })
  }
}

/** Active planned medicines overdue on a date, due on it, or due within REMIND_DAYS after it. */
export async function dueSchedules(ctx: Ctx, date: string): Promise<MedicineDue[]> {
  assert(isIsoDate(date), 'invalid_date')
  const rows = (await ctx.db
    .prepare(`${scheduleSelect} WHERE s.organization_id = ? AND s.farm_id = ? AND s.active = 1 AND s.due_date <= ? ORDER BY s.due_date, c.sort_order, s.id`)
    .all(ctx.org, ctx.farm, addDays(date, REMIND_DAYS))) as ScheduleRow[]
  return rows.map((r) => {
    const daysLeft = daysBetween(date, r.dueDate)
    return { ...r, active: true, daysLeft, state: daysLeft < 0 ? 'overdue' : daysLeft === 0 ? 'due' : 'upcoming' }
  })
}

export async function deleteTreatment(ctx: Ctx, id: number, reason: string) {
  requireUser(ctx)
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const row = (await ctx.db
      .prepare(
        'SELECT t.*, d.business_date FROM medicine_treatments t JOIN farm_days d ON d.id = t.day_id WHERE t.id = ? AND t.organization_id = ? AND d.farm_id = ?'
      )
      .get(id, ctx.org, ctx.farm)) as (Record<string, unknown> & { business_date: string; day_id: number }) | undefined
    assert(row, 'not_found')
    await requireWritableDay(ctx, row.business_date)
    await ctx.db.prepare("DELETE FROM inventory_transactions WHERE organization_id = ? AND source_type = 'treatment' AND source_id = ?").run(ctx.org, id)
    await ctx.db.prepare('DELETE FROM medicine_treatments WHERE id = ?').run(id)
    await audit(ctx, { action: 'delete', entity: 'treatment', entityId: id, dayId: row.day_id, reason, details: row })
  })()
}

export async function listHealthEvents(ctx: Ctx, from: string, to: string, cageId?: number | null): Promise<HealthEvent[]> {
  return (await ctx.db
    .prepare(
      `SELECT h.id, d.business_date AS date, h.cage_id AS cageId, c.name AS cageName, h.event_time AS eventTime,
         h.category, h.severity, h.description, h.action_taken AS actionTaken, u.display_name AS recordedBy
       FROM health_events h JOIN farm_days d ON d.id = h.day_id LEFT JOIN cages c ON c.id = h.cage_id
       LEFT JOIN users u ON u.id = h.recorded_by
       WHERE h.organization_id = ? AND d.farm_id = ? AND d.business_date BETWEEN ? AND ? ${cageId ? 'AND h.cage_id = ?' : ''}
       ORDER BY d.business_date DESC, h.id DESC`
    )
    .all(...(cageId ? [ctx.org, ctx.farm, from, to, cageId] : [ctx.org, ctx.farm, from, to]))) as HealthEvent[]
}

export interface HealthEventInput {
  date: string
  cageId: number | null
  eventTime: string | null
  category: string
  severity: 'low' | 'medium' | 'high'
  description: string
  actionTaken: string | null
}

/** Health observations are recorded separately from medicine stock transactions. */
export async function addHealthEvent(ctx: Ctx, h: HealthEventInput): Promise<number> {
  const user = requireUser(ctx)
  assert(h.description.trim().length >= 3, 'required_field', { field: 'description' })
  return ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, h.date)
    if (h.cageId) await requireCageDay(ctx, day, h.cageId)
    const id = Number(
      (
        await ctx.db
          .prepare(
            `INSERT INTO health_events (organization_id, day_id, cage_id, event_time, category, severity, description, action_taken,
             recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(ctx.org, day.id, h.cageId, h.eventTime, h.category, h.severity, h.description.trim(), h.actionTaken, user.id, ctx.now().toISOString())
      ).lastInsertRowid
    )
    await audit(ctx, { action: 'create', entity: 'health_event', entityId: id, dayId: day.id, details: h })
    return id
  })()
}

export async function deleteHealthEvent(ctx: Ctx, id: number, reason: string) {
  requireUser(ctx)
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const row = (await ctx.db
      .prepare(
        'SELECT h.*, d.business_date FROM health_events h JOIN farm_days d ON d.id = h.day_id WHERE h.id = ? AND h.organization_id = ? AND d.farm_id = ?'
      )
      .get(id, ctx.org, ctx.farm)) as (Record<string, unknown> & { business_date: string; day_id: number }) | undefined
    assert(row, 'not_found')
    await requireWritableDay(ctx, row.business_date)
    await ctx.db.prepare('DELETE FROM health_events WHERE id = ?').run(id)
    await audit(ctx, { action: 'delete', entity: 'health_event', entityId: id, dayId: row.day_id, reason, details: row })
  })()
}
