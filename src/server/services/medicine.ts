import type { HealthEvent, Treatment } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { requireCageDay, requireWritableDay } from './days'
import { getItem, syncLinkedTxn } from './inventory'

const treatmentSelect = `SELECT t.id, d.business_date AS date, t.cage_id AS cageId, c.name AS cageName, t.item_id AS itemId,
    i.name AS itemName, i.unit, t.batch_id AS batchId, b.batch_no AS batchNo, b.expiry_date AS expiryDate, t.quantity,
    t.administered_at AS administeredAt, t.reason, t.prescribed_by AS prescribedBy, t.notes, u.display_name AS recordedBy
  FROM medicine_treatments t JOIN farm_days d ON d.id = t.day_id LEFT JOIN cages c ON c.id = t.cage_id
  JOIN inventory_items i ON i.id = t.item_id LEFT JOIN inventory_batches b ON b.id = t.batch_id
  LEFT JOIN users u ON u.id = t.recorded_by`

export async function listTreatments(ctx: Ctx, from: string, to: string, cageId?: number | null): Promise<Treatment[]> {
  return (await ctx.db
    .prepare(
      `${treatmentSelect} WHERE d.business_date BETWEEN ? AND ? ${cageId ? 'AND t.cage_id = ?' : ''}
       ORDER BY d.business_date DESC, t.id DESC`
    )
    .all(...(cageId ? [from, to, cageId] : [from, to]))) as Treatment[]
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
      const b = (await ctx.db.prepare('SELECT item_id FROM inventory_batches WHERE id = ?').get(t.batchId)) as { item_id: number } | undefined
      assert(b && b.item_id === t.itemId, 'batch_mismatch')
    }
    const id = Number(
      (await ctx.db
        .prepare(
          `INSERT INTO medicine_treatments (day_id, cage_id, item_id, batch_id, quantity, administered_at, reason,
             prescribed_by, notes, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(day.id, t.cageId, t.itemId, t.batchId, t.quantity, t.administeredAt, t.reason.trim(), t.prescribedBy, t.notes, user.id, ctx.now().toISOString()))
        .lastInsertRowid
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
    return id
  })()
}

export async function deleteTreatment(ctx: Ctx, id: number, reason: string) {
  requireUser(ctx)
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const row = (await ctx.db
      .prepare('SELECT t.*, d.business_date FROM medicine_treatments t JOIN farm_days d ON d.id = t.day_id WHERE t.id = ?')
      .get(id)) as (Record<string, unknown> & { business_date: string; day_id: number }) | undefined
    assert(row, 'not_found')
    await requireWritableDay(ctx, row.business_date)
    await ctx.db.prepare("DELETE FROM inventory_transactions WHERE source_type = 'treatment' AND source_id = ?").run(id)
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
       WHERE d.business_date BETWEEN ? AND ? ${cageId ? 'AND h.cage_id = ?' : ''}
       ORDER BY d.business_date DESC, h.id DESC`
    )
    .all(...(cageId ? [from, to, cageId] : [from, to]))) as HealthEvent[]
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
      (await ctx.db
        .prepare(
          `INSERT INTO health_events (day_id, cage_id, event_time, category, severity, description, action_taken,
             recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(day.id, h.cageId, h.eventTime, h.category, h.severity, h.description.trim(), h.actionTaken, user.id, ctx.now().toISOString()))
        .lastInsertRowid
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
      .prepare('SELECT h.*, d.business_date FROM health_events h JOIN farm_days d ON d.id = h.day_id WHERE h.id = ?')
      .get(id)) as (Record<string, unknown> & { business_date: string; day_id: number }) | undefined
    assert(row, 'not_found')
    await requireWritableDay(ctx, row.business_date)
    await ctx.db.prepare('DELETE FROM health_events WHERE id = ?').run(id)
    await audit(ctx, { action: 'delete', entity: 'health_event', entityId: id, dayId: row.day_id, reason, details: row })
  })()
}
