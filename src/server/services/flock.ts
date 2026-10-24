import { randomUUID } from 'node:crypto'
import type { FlockMovement, FlockType } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { assertCageDayValid, getDay, recalcFrom, requireCageDay, requireWritableDay } from './days'

const select = `SELECT m.id, d.business_date AS date, m.cage_id AS cageId, c.name AS cageName, m.type, m.quantity,
    m.reason, m.notes, m.transfer_ref AS transferRef, m.counterpart_cage_id AS counterpartCageId,
    cc.name AS counterpartCageName, u.display_name AS recordedBy, m.created_at AS createdAt
  FROM flock_movements m JOIN farm_days d ON d.id = m.day_id JOIN cages c ON c.id = m.cage_id
  LEFT JOIN cages cc ON cc.id = m.counterpart_cage_id LEFT JOIN users u ON u.id = m.recorded_by`

export async function listMovements(ctx: Ctx, date: string, cageId?: number): Promise<FlockMovement[]> {
  const day = await getDay(ctx, date)
  if (!day) return []
  return (await ctx.db
    .prepare(`${select} WHERE m.day_id = ? ${cageId ? 'AND m.cage_id = ?' : ''} ORDER BY m.id`)
    .all(...(cageId ? [day.id, cageId] : [day.id]))) as FlockMovement[]
}

export async function listMovementsRange(ctx: Ctx, from: string, to: string, cageId?: number | null): Promise<FlockMovement[]> {
  return (await ctx.db
    .prepare(
      `${select} WHERE d.business_date BETWEEN ? AND ? ${cageId ? 'AND m.cage_id = ?' : ''} ORDER BY d.business_date DESC, m.id DESC`
    )
    .all(...(cageId ? [from, to, cageId] : [from, to]))) as FlockMovement[]
}

export interface MovementInput {
  date: string
  cageId: number
  type: Exclude<FlockType, 'transfer_in' | 'transfer_out'>
  quantity: number
  reason: string | null
  notes: string | null
}

const REASON_REQUIRED: FlockType[] = ['removal', 'addition']

/** Records deaths, removals (culls, sales) or additions. Closing hens can never go negative. */
export async function addMovement(ctx: Ctx, m: MovementInput): Promise<number> {
  const user = requireUser(ctx)
  assert(Number.isInteger(m.quantity) && m.quantity > 0, 'invalid_count')
  if (REASON_REQUIRED.includes(m.type)) assert(m.reason && m.reason.trim().length >= 3, 'reason_required')
  return ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, m.date)
    await requireCageDay(ctx, day, m.cageId)
    const info = await ctx.db
      .prepare(
        `INSERT INTO flock_movements (day_id, cage_id, type, quantity, reason, notes, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(day.id, m.cageId, m.type, m.quantity, m.reason?.trim() || null, m.notes, user.id, ctx.now().toISOString())
    await assertCageDayValid(ctx, day.id, m.cageId, m.date)
    await recalcFrom(ctx, m.date)
    const id = Number(info.lastInsertRowid)
    await audit(ctx, { action: 'create', entity: 'flock_movement', entityId: id, dayId: day.id, reason: m.reason, details: m })
    return id
  })()
}

/**
 * Moves hens between two cages: one transfer_out and one transfer_in row sharing a
 * transfer reference, written atomically so the farm total is unchanged.
 */
export async function transferHens(
  ctx: Ctx,
  t: { date: string; fromCageId: number; toCageId: number; quantity: number; reason: string | null; notes: string | null }
): Promise<string> {
  const user = requireUser(ctx)
  assert(t.fromCageId !== t.toCageId, 'transfer_same_cage')
  assert(Number.isInteger(t.quantity) && t.quantity > 0, 'invalid_count')
  return ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, t.date)
    await requireCageDay(ctx, day, t.fromCageId)
    await requireCageDay(ctx, day, t.toCageId)
    const ref = randomUUID()
    const ins = ctx.db.prepare(
      `INSERT INTO flock_movements (day_id, cage_id, type, quantity, reason, notes, transfer_ref, counterpart_cage_id,
         recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const now = ctx.now().toISOString()
    await ins.run(day.id, t.fromCageId, 'transfer_out', t.quantity, t.reason, t.notes, ref, t.toCageId, user.id, now)
    await ins.run(day.id, t.toCageId, 'transfer_in', t.quantity, t.reason, t.notes, ref, t.fromCageId, user.id, now)
    await assertCageDayValid(ctx, day.id, t.fromCageId, t.date)
    await recalcFrom(ctx, t.date)
    await audit(ctx, { action: 'transfer', entity: 'flock_movement', dayId: day.id, reason: t.reason, details: { ...t, ref } })
    return ref
  })()
}

/** Deletes a movement (both sides of a transfer). Rejected if any cage would go negative. */
export async function deleteMovement(ctx: Ctx, id: number, reason: string) {
  requireUser(ctx)
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const row = (await ctx.db
      .prepare('SELECT m.*, d.business_date FROM flock_movements m JOIN farm_days d ON d.id = m.day_id WHERE m.id = ?')
      .get(id)) as
      | { id: number; day_id: number; cage_id: number; transfer_ref: string | null; business_date: string }
      | undefined
    assert(row, 'not_found')
    await requireWritableDay(ctx, row.business_date)
    const rows = row.transfer_ref
      ? ((await ctx.db.prepare('SELECT * FROM flock_movements WHERE transfer_ref = ?').all(row.transfer_ref)) as typeof row[])
      : [row]
    for (const r of rows) await ctx.db.prepare('DELETE FROM flock_movements WHERE id = ?').run(r.id)
    for (const r of rows) await assertCageDayValid(ctx, r.day_id, r.cage_id, row.business_date)
    await recalcFrom(ctx, row.business_date)
    await audit(ctx, { action: 'delete', entity: 'flock_movement', entityId: id, dayId: row.day_id, reason, details: rows })
  })()
}
