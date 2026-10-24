import type { EggCollection, EggSession } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { getDay, requireCageDay, requireWritableDay } from './days'

export interface EggInput {
  date: string
  cageId: number
  session: EggSession
  collectedAt: string | null
  good: number
  damaged: number
  rejected: number
  notes: string | null
}

const select = `SELECT e.id, d.business_date AS date, e.cage_id AS cageId, c.name AS cageName, e.session,
    e.collected_at AS collectedAt, e.good, e.damaged, e.rejected, e.notes, u.display_name AS recordedBy,
    e.updated_at AS updatedAt
  FROM egg_collections e JOIN farm_days d ON d.id = e.day_id JOIN cages c ON c.id = e.cage_id
  LEFT JOIN users u ON u.id = e.recorded_by`

export async function listEggs(ctx: Ctx, date: string, cageId?: number): Promise<EggCollection[]> {
  const day = await getDay(ctx, date)
  if (!day) return []
  return (await ctx.db
    .prepare(`${select} WHERE e.day_id = ? ${cageId ? 'AND e.cage_id = ?' : ''} ORDER BY c.sort_order, c.code, e.session`)
    .all(...(cageId ? [day.id, cageId] : [day.id]))) as EggCollection[]
}

/**
 * Saves the collection for one cage/session. A cage can have only one record per session
 * (UNIQUE constraint), so the same collection can never be counted twice: saving again
 * updates the existing record and the change is audited. `expectedId` guards against
 * accidentally overwriting a record someone else entered.
 */
export async function saveEggs(ctx: Ctx, input: EggInput, expectedId: number | null): Promise<number> {
  const user = requireUser(ctx)
  for (const v of [input.good, input.damaged, input.rejected]) assert(Number.isInteger(v) && v >= 0, 'invalid_count')
  assert(input.good + input.damaged + input.rejected <= 100000, 'count_too_large')
  return ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, input.date)
    await requireCageDay(ctx, day, input.cageId)
    const existing = (await ctx.db
      .prepare('SELECT * FROM egg_collections WHERE day_id = ? AND cage_id = ? AND session = ?')
      .get(day.id, input.cageId, input.session)) as Record<string, unknown> | undefined
    const now = ctx.now().toISOString()
    if (existing) {
      assert(expectedId === existing.id, 'egg_session_exists', { session: input.session })
      await ctx.db
        .prepare(
          `UPDATE egg_collections SET collected_at = ?, good = ?, damaged = ?, rejected = ?, notes = ?, recorded_by = ?,
             updated_at = ? WHERE id = ?`
        )
        .run(input.collectedAt, input.good, input.damaged, input.rejected, input.notes, user.id, now, existing.id)
      await audit(ctx, {
        action: 'update',
        entity: 'egg_collection',
        entityId: existing.id as number,
        dayId: day.id,
        details: { before: existing, after: input }
      })
      return existing.id as number
    }
    assert(expectedId === null, 'record_changed')
    const info = await ctx.db
      .prepare(
        `INSERT INTO egg_collections (day_id, cage_id, session, collected_at, good, damaged, rejected, notes, recorded_by,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(day.id, input.cageId, input.session, input.collectedAt, input.good, input.damaged, input.rejected, input.notes, user.id, now, now)
    const id = Number(info.lastInsertRowid)
    await audit(ctx, { action: 'create', entity: 'egg_collection', entityId: id, dayId: day.id, details: input })
    return id
  })()
}

export async function deleteEggs(ctx: Ctx, id: number, reason: string) {
  requireUser(ctx)
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const row = (await ctx.db
      .prepare('SELECT e.*, d.business_date FROM egg_collections e JOIN farm_days d ON d.id = e.day_id WHERE e.id = ?')
      .get(id)) as (Record<string, unknown> & { business_date: string; day_id: number }) | undefined
    assert(row, 'not_found')
    await requireWritableDay(ctx, row.business_date)
    await ctx.db.prepare('DELETE FROM egg_collections WHERE id = ?').run(id)
    await audit(ctx, { action: 'delete', entity: 'egg_collection', entityId: id, dayId: row.day_id, reason, details: row })
  })()
}
