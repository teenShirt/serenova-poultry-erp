import { feedConsumption } from '@shared/calc'
import type { FeedRecord } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { getDay, requireCageDay, requireWritableDay } from './days'
import { getItem, syncLinkedTxn } from './inventory'

const select = `SELECT f.id, d.business_date AS date, f.cage_id AS cageId, c.name AS cageName, f.item_id AS itemId,
    i.name AS itemName, f.batch_no AS batchNo, f.opening_stock AS openingStock, f.issued, f.returned, f.wasted,
    f.measured_consumption AS measuredConsumption, f.closing_stock AS closingStock, f.notes,
    u.display_name AS recordedBy
  FROM feed_records f JOIN farm_days d ON d.id = f.day_id JOIN cages c ON c.id = f.cage_id
  JOIN inventory_items i ON i.id = f.item_id LEFT JOIN users u ON u.id = f.recorded_by`

type Row = Omit<FeedRecord, 'consumption' | 'method' | 'isEstimate' | 'error'>

function withCalc(r: Row): FeedRecord {
  const c = feedConsumption(r)
  return { ...r, consumption: c.consumption, method: c.method, isEstimate: c.isEstimate, error: c.error }
}

export async function listFeed(ctx: Ctx, date: string, cageId?: number): Promise<FeedRecord[]> {
  const day = await getDay(ctx, date)
  if (!day) return []
  return (
    (await ctx.db
      .prepare(`${select} WHERE f.organization_id = ? AND f.day_id = ? ${cageId ? 'AND f.cage_id = ?' : ''} ORDER BY c.sort_order, c.code, i.name`)
      .all(...(cageId ? [ctx.org, day.id, cageId] : [ctx.org, day.id]))) as Row[]
  ).map(withCalc)
}

/** The cage's feed stock carried from its last counted closing stock for this feed type. */
export async function suggestedOpeningStock(ctx: Ctx, date: string, cageId: number, itemId: number): Promise<number | null> {
  const r = (await ctx.db
    .prepare(
      `SELECT f.closing_stock FROM feed_records f JOIN farm_days d ON d.id = f.day_id
       WHERE f.organization_id = ? AND d.farm_id = ? AND f.cage_id = ? AND f.item_id = ? AND d.business_date < ? ORDER BY d.business_date DESC LIMIT 1`
    )
    .get(ctx.org, ctx.farm, cageId, itemId, date)) as { closing_stock: number | null } | undefined
  return r?.closing_stock ?? null
}

export interface FeedInput {
  date: string
  cageId: number
  itemId: number
  batchNo: string | null
  openingStock: number | null
  issued: number
  returned: number
  wasted: number
  measuredConsumption: number | null
  closingStock: number | null
  notes: string | null
}

/**
 * Saves one cage's feed record for one feed type. The quantity issued (net of returns) is
 * posted to the store inventory as exactly one linked transaction per record, so re-saving
 * adjusts the existing deduction instead of deducting again.
 */
export async function saveFeed(ctx: Ctx, f: FeedInput, expectedId: number | null): Promise<number> {
  const user = requireUser(ctx)
  const calc = feedConsumption(f)
  assert(calc.error !== 'negative_quantity', 'quantity_positive')
  assert(calc.error !== 'returned_exceeds_issued', 'feed_returned_exceeds_issued')
  assert(calc.error !== 'stock_imbalance', 'feed_stock_imbalance')
  return ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, f.date)
    await requireCageDay(ctx, day, f.cageId)
    const item = await getItem(ctx, f.itemId)
    assert(item.category === 'feed', 'item_not_feed')
    const existing = (await ctx.db
      .prepare('SELECT * FROM feed_records WHERE organization_id = ? AND day_id = ? AND cage_id = ? AND item_id = ?')
      .get(ctx.org, day.id, f.cageId, f.itemId)) as Record<string, unknown> | undefined
    const now = ctx.now().toISOString()
    let id: number
    if (existing) {
      assert(expectedId === existing.id, 'feed_record_exists')
      id = existing.id as number
      await ctx.db
        .prepare(
          `UPDATE feed_records SET batch_no = ?, opening_stock = ?, issued = ?, returned = ?, wasted = ?,
             measured_consumption = ?, closing_stock = ?, notes = ?, recorded_by = ?, updated_at = ? WHERE id = ?`
        )
        .run(f.batchNo, f.openingStock, f.issued, f.returned, f.wasted, f.measuredConsumption, f.closingStock, f.notes, user.id, now, id)
    } else {
      assert(expectedId === null, 'record_changed')
      id = Number(
        (await ctx.db
          .prepare(
            `INSERT INTO feed_records (organization_id, day_id, cage_id, item_id, batch_no, opening_stock, issued, returned, wasted,
               measured_consumption, closing_stock, notes, recorded_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(ctx.org, day.id, f.cageId, f.itemId, f.batchNo, f.openingStock, f.issued, f.returned, f.wasted, f.measuredConsumption, f.closingStock, f.notes, user.id, now, now))
          .lastInsertRowid
      )
    }
    const link = { sourceType: 'feed_record', sourceId: id, itemId: f.itemId, batchId: null, date: f.date, dayId: day.id, cageId: f.cageId }
    await syncLinkedTxn(ctx, { ...link, type: 'issue', signedQuantity: -f.issued })
    await syncLinkedTxn(ctx, { ...link, type: 'return', signedQuantity: f.returned })
    await audit(ctx, {
      action: existing ? 'update' : 'create',
      entity: 'feed_record',
      entityId: id,
      dayId: day.id,
      details: existing ? { before: existing, after: f } : f
    })
    return id
  })()
}

export async function deleteFeed(ctx: Ctx, id: number, reason: string) {
  requireUser(ctx)
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const row = (await ctx.db
      .prepare('SELECT f.*, d.business_date FROM feed_records f JOIN farm_days d ON d.id = f.day_id WHERE f.id = ? AND f.organization_id = ? AND d.farm_id = ?')
      .get(id, ctx.org, ctx.farm)) as (Record<string, unknown> & { business_date: string; day_id: number }) | undefined
    assert(row, 'not_found')
    await requireWritableDay(ctx, row.business_date)
    await ctx.db.prepare("DELETE FROM inventory_transactions WHERE organization_id = ? AND source_type = 'feed_record' AND source_id = ?").run(ctx.org, id)
    await ctx.db.prepare('DELETE FROM feed_records WHERE id = ?').run(id)
    await audit(ctx, { action: 'delete', entity: 'feed_record', entityId: id, dayId: row.day_id, reason, details: row })
  })()
}
