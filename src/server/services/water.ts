import { waterConsumption } from '@shared/calc'
import type { WaterRecord } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { AppError, assert } from '../errors'
import { audit } from './audit'
import { getDay, requireCageDay, requireWritableDay } from './days'
import { requirePermission } from './roles'

const select = `SELECT w.id, d.business_date AS date, w.cage_id AS cageId, c.name AS cageName, w.method,
    w.opening_reading AS openingReading, w.closing_reading AS closingReading, w.litres, w.meter_reset AS meterReset,
    w.correction_reason AS correctionReason, w.notes, u.display_name AS recordedBy
  FROM water_records w JOIN farm_days d ON d.id = w.day_id JOIN cages c ON c.id = w.cage_id
  LEFT JOIN users u ON u.id = w.recorded_by`

const toRecord = (r: Record<string, unknown>) => ({ ...(r as unknown as WaterRecord), meterReset: !!r.meterReset })

export async function listWater(ctx: Ctx, date: string): Promise<WaterRecord[]> {
  const day = await getDay(ctx, date)
  if (!day) return []
  return ((await ctx.db.prepare(`${select} WHERE w.organization_id = ? AND w.day_id = ? ORDER BY c.sort_order, c.code`).all(ctx.org, day.id)) as Record<string, unknown>[]).map(
    toRecord
  )
}

/** Opening meter reading = the cage's most recent earlier closing reading. */
export async function suggestedOpeningReading(ctx: Ctx, date: string, cageId: number): Promise<number | null> {
  const r = (await ctx.db
    .prepare(
      `SELECT w.closing_reading FROM water_records w JOIN farm_days d ON d.id = w.day_id
       WHERE w.organization_id = ? AND d.farm_id = ? AND w.cage_id = ? AND d.business_date < ? AND w.closing_reading IS NOT NULL
       ORDER BY d.business_date DESC LIMIT 1`
    )
    .get(ctx.org, ctx.farm, cageId, date)) as { closing_reading: number } | undefined
  return r?.closing_reading ?? null
}

export interface WaterInput {
  date: string
  cageId: number
  method: 'meter' | 'manual'
  openingReading: number | null
  closingReading: number | null
  litres: number | null
  meterReset: boolean
  correctionReason: string | null
  notes: string | null
}

export async function saveWater(ctx: Ctx, w: WaterInput, expectedId: number | null): Promise<number> {
  const user = requireUser(ctx)
  if (w.method === 'meter' && w.closingReading !== null && w.openingReading !== null && w.closingReading < w.openingReading) {
    // A lower closing reading is only valid when a meter was reset/replaced: an authorised correction.
    if (!w.meterReset) throw new AppError('meter_closing_below_opening')
  }
  if (w.meterReset) {
    requirePermission(ctx, 'water.meter_reset')
    assert(w.correctionReason && w.correctionReason.trim().length >= 3, 'reason_required')
  }
  const r = waterConsumption(w)
  if (r.error === 'litres_required_after_reset') throw new AppError('litres_required_after_reset')
  if (r.error) throw new AppError('quantity_positive')
  if (w.method === 'manual') assert(w.litres !== null, 'required_field', { field: 'litres' })
  return ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, w.date)
    await requireCageDay(ctx, day, w.cageId)
    const existing = (await ctx.db
      .prepare('SELECT * FROM water_records WHERE organization_id = ? AND day_id = ? AND cage_id = ?')
      .get(ctx.org, day.id, w.cageId)) as Record<string, unknown> | undefined
    const now = ctx.now().toISOString()
    const vals = [
      w.method,
      w.method === 'meter' ? w.openingReading : null,
      w.method === 'meter' ? w.closingReading : null,
      r.litres,
      w.meterReset ? 1 : 0,
      w.correctionReason?.trim() || null,
      w.notes,
      user.id
    ]
    let id: number
    if (existing) {
      assert(expectedId === existing.id, 'water_record_exists')
      id = existing.id as number
      await ctx.db
        .prepare(
          `UPDATE water_records SET method = ?, opening_reading = ?, closing_reading = ?, litres = ?, meter_reset = ?,
             correction_reason = ?, notes = ?, recorded_by = ?, updated_at = ? WHERE id = ?`
        )
        .run(...vals, now, id)
    } else {
      assert(expectedId === null, 'record_changed')
      id = Number(
        (await ctx.db
          .prepare(
            `INSERT INTO water_records (method, opening_reading, closing_reading, litres, meter_reset, correction_reason,
               notes, recorded_by, organization_id, day_id, cage_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(...vals, ctx.org, day.id, w.cageId, now, now)).lastInsertRowid
      )
    }
    await audit(ctx, {
      action: existing ? 'update' : 'create',
      entity: 'water_record',
      entityId: id,
      dayId: day.id,
      reason: w.meterReset ? w.correctionReason : null,
      details: existing ? { before: existing, after: w } : w
    })
    return id
  })()
}

export async function deleteWater(ctx: Ctx, id: number, reason: string) {
  requireUser(ctx)
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const row = (await ctx.db
      .prepare('SELECT w.*, d.business_date FROM water_records w JOIN farm_days d ON d.id = w.day_id WHERE w.id = ? AND w.organization_id = ? AND d.farm_id = ?')
      .get(id, ctx.org, ctx.farm)) as (Record<string, unknown> & { business_date: string; day_id: number }) | undefined
    assert(row, 'not_found')
    await requireWritableDay(ctx, row.business_date)
    await ctx.db.prepare('DELETE FROM water_records WHERE id = ?').run(id)
    await audit(ctx, { action: 'delete', entity: 'water_record', entityId: id, dayId: row.day_id, reason, details: row })
  })()
}
