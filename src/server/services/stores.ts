import { round } from '@shared/calc'
import { isIsoDate } from '@shared/dates'
import type { StockCountInput, StockCountRow, StoreBalance, TransferInput, Warehouse } from '@shared/stores'
import type { InventoryCategory } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { AppError, assert } from '../errors'
import { audit } from './audit'
import { farmToday } from './days'
import { assertDateWritable, assertNotNegative, getItem, getStore } from './inventory'
import { requirePermission } from './roles'
import { getEntitlements, today as platformToday } from './subscriptions'

/**
 * Stores (warehouses). Stock is held per store; every movement names its store. Transfers move stock
 * between stores as a matched pair of movements; stock counts post the difference as a 'count'
 * movement. Nothing already recorded is changed: corrections are new movements.
 */

export async function listWarehouses(ctx: Ctx, includeInactive = true): Promise<Warehouse[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT w.id, w.farm_id AS farmId, f.name AS farmName, w.code, w.name, w.is_main AS isMain, w.active, w.notes
       FROM warehouses w JOIN farms f ON f.id = w.farm_id
       WHERE w.organization_id = ? ${includeInactive ? '' : 'AND w.active = 1'} ORDER BY w.farm_id = ? DESC, f.name, w.is_main DESC, w.name`
    )
    .all(ctx.org, ctx.farm)) as (Omit<Warehouse, 'isMain' | 'active'> & { isMain: number; active: number })[]
  return rows.map((r) => ({ ...r, isMain: !!r.isMain, active: !!r.active }))
}

async function assertStoreSlot(ctx: Ctx) {
  const e = await getEntitlements(ctx.db, ctx.org, platformToday(ctx))
  const used = ((await ctx.db.prepare('SELECT COUNT(*) AS n FROM warehouses WHERE organization_id = ? AND active = 1').get(ctx.org)) as { n: number }).n
  if (used >= e.limits.maxWarehouses) throw new AppError('store_limit_reached', { limit: e.limits.maxWarehouses, plan: e.planName })
}

/** Adds a store to the farm being worked on (within the plan's limit), or renames / deactivates one. */
export async function saveWarehouse(ctx: Ctx, w: { id: number | null; code: string; name: string; active: boolean; notes: string | null }): Promise<number> {
  requirePermission(ctx, 'stores.manage')
  const code = w.code.trim().toUpperCase()
  assert(code.length > 0 && w.name.trim().length > 0, 'required_field', { field: 'name' })
  return ctx.db.transaction(async () => {
    const dup = await ctx.db.prepare('SELECT 1 AS x FROM warehouses WHERE organization_id = ? AND code = ? AND NOT (id <=> ?)').get(ctx.org, code, w.id)
    assert(!dup, 'store_code_taken')
    if (w.id) {
      const before = (await ctx.db.prepare('SELECT is_main, active FROM warehouses WHERE id = ? AND organization_id = ?').get(w.id, ctx.org)) as
        | { is_main: number; active: number }
        | undefined
      assert(before, 'store_not_found')
      if (!w.active && before.active) {
        assert(!before.is_main, 'main_store_required')
        const stock = (await ctx.db
          .prepare(
            'SELECT COALESCE(SUM(ABS(b)), 0) AS s FROM (SELECT SUM(quantity) AS b FROM inventory_transactions WHERE warehouse_id = ? GROUP BY item_id) x'
          )
          .get(w.id)) as { s: number }
        assert(Number(stock.s) < 1e-9, 'store_has_stock')
      }
      if (w.active && !before.active) await assertStoreSlot(ctx)
      await ctx.db
        .prepare('UPDATE warehouses SET code = ?, name = ?, active = ?, notes = ? WHERE id = ?')
        .run(code, w.name.trim(), w.active ? 1 : 0, w.notes?.trim() || null, w.id)
      await audit(ctx, { action: 'update', entity: 'warehouse', entityId: w.id, details: w })
      return w.id
    }
    await assertStoreSlot(ctx)
    const id = (
      await ctx.db
        .prepare('INSERT INTO warehouses (organization_id, farm_id, code, name, active, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.org, ctx.farm, code, w.name.trim(), w.active ? 1 : 0, w.notes?.trim() || null, ctx.now().toISOString())
    ).lastInsertRowid
    await audit(ctx, { action: 'create', entity: 'warehouse', entityId: id, details: w })
    return id
  })()
}

/**
 * Stock of each item in each store of the farm being worked on (or one store), valued at the
 * weighted average cost of what the organization bought (items without purchase costs have no value).
 */
export async function storeBalances(ctx: Ctx, f: { warehouseId?: number | null; category?: InventoryCategory } = {}): Promise<StoreBalance[]> {
  if (f.warehouseId) await getStore(ctx, f.warehouseId, { ofFarm: true })
  const rows = (await ctx.db
    .prepare(
      `SELECT i.id AS itemId, i.name AS itemName, i.category, i.sku, i.unit, w.id AS warehouseId, w.name AS warehouseName,
         i.low_stock_threshold AS lowStockThreshold, i.reorder_level AS reorderLevel, w.is_main AS isMain, COALESCE(SUM(t.quantity), 0) AS balance,
         (SELECT SUM(p.quantity * p.unit_cost) / SUM(p.quantity) FROM inventory_transactions p
            WHERE p.item_id = i.id AND p.type = 'purchase' AND p.unit_cost IS NOT NULL AND p.quantity > 0) AS avgCost
       FROM inventory_items i JOIN warehouses w ON w.organization_id = i.organization_id
       LEFT JOIN inventory_transactions t ON t.item_id = i.id AND t.warehouse_id = w.id
       WHERE i.organization_id = ? AND w.farm_id = ? ${f.warehouseId ? 'AND w.id = ?' : ''} ${f.category ? 'AND i.category = ?' : ''} AND i.active = 1
       GROUP BY i.id, w.id ORDER BY w.is_main DESC, w.name, i.category, i.name`
    )
    .all(ctx.org, ctx.farm, ...(f.warehouseId ? [f.warehouseId] : []), ...(f.category ? [f.category] : []))) as (Omit<
    StoreBalance,
    'value' | 'isLow' | 'needsReorder'
  > & { isMain: number })[]
  // Minimum and reorder levels are for the item on the farm: they are judged on its stock in all the farm's stores.
  const farmTotal = new Map<number, number>()
  for (const r of rows) farmTotal.set(r.itemId, (farmTotal.get(r.itemId) ?? 0) + Number(r.balance))
  return rows
    .filter((r) => Number(r.balance) !== 0 || r.isMain)
    .map(({ isMain: _isMain, ...r }) => {
      const balance = round(Number(r.balance), 3)
      const total = f.warehouseId ? balance : round(farmTotal.get(r.itemId) ?? 0, 3)
      const avgCost = r.avgCost === null ? null : round(Number(r.avgCost), 4)
      return {
        ...r,
        balance,
        avgCost,
        value: avgCost === null ? null : round(balance * avgCost, 2),
        isLow: r.lowStockThreshold !== null && total <= r.lowStockThreshold,
        needsReorder: r.reorderLevel !== null && total <= r.reorderLevel
      }
    })
}

/** Moves stock from a store of this farm to another store of the organization: one movement out, one in. */
export async function transferStock(ctx: Ctx, t: TransferInput): Promise<string> {
  const user = requireUser(ctx)
  requirePermission(ctx, 'inventory.transfer')
  assert(isIsoDate(t.date) && t.date <= (await farmToday(ctx)), 'invalid_date')
  assert(t.lines.length > 0 && t.lines.length <= 50, 'receipt_needs_lines')
  assert(t.fromWarehouseId !== t.toWarehouseId, 'same_store')
  return ctx.db.transaction(async () => {
    await assertDateWritable(ctx, t.date)
    const from = await getStore(ctx, t.fromWarehouseId, { ofFarm: true, active: true })
    const to = await getStore(ctx, t.toWarehouseId, { ofFarm: false, active: true })
    const ref = await transferRef(ctx, t.date)
    const now = ctx.now().toISOString()
    for (const l of t.lines) {
      assert(l.quantity > 0 && Number.isFinite(l.quantity), 'quantity_positive')
      const item = await getItem(ctx, l.itemId)
      let batchId: number | null = null
      if (l.batchNo?.trim()) {
        const b = (await ctx.db
          .prepare('SELECT id FROM inventory_batches WHERE organization_id = ? AND item_id = ? AND batch_no = ?')
          .get(ctx.org, l.itemId, l.batchNo.trim())) as { id: number } | undefined
        assert(b, 'batch_not_found', { batch: l.batchNo })
        batchId = b.id
      }
      const q = round(l.quantity, 3)
      const ins = ctx.db.prepare(
        `INSERT INTO inventory_transactions (organization_id, item_id, warehouse_id, counterpart_warehouse_id, batch_id, txn_date, type, quantity, reference, notes,
           transfer_ref, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      await ins.run(ctx.org, l.itemId, from.id, to.id, batchId, t.date, 'transfer_out', -q, ref, t.notes?.trim() || null, ref, user.id, now)
      await ins.run(ctx.org, l.itemId, to.id, from.id, batchId, t.date, 'transfer_in', q, ref, t.notes?.trim() || null, ref, user.id, now)
      await assertNotNegative(ctx, item.id, batchId, from.id)
    }
    await audit(ctx, { action: 'stock_transfer', entity: 'warehouse', entityId: from.id, details: { ref, from: from.name, to: to.name, lines: t.lines } })
    return ref
  })()
}

async function transferRef(ctx: Ctx, date: string) {
  const stem = `TRF-${date.replace(/-/g, '')}-`
  const r = (await ctx.db
    .prepare('SELECT transfer_ref AS ref FROM inventory_transactions WHERE organization_id = ? AND transfer_ref LIKE ? ORDER BY transfer_ref DESC LIMIT 1')
    .get(ctx.org, stem + '%')) as { ref: string } | undefined
  return stem + String(r ? Number(r.ref.slice(stem.length)) + 1 : 1).padStart(3, '0')
}

/**
 * Records a stock count in one store: for each counted item (and batch), the difference between the
 * count and the stock recorded up to that date is posted as a 'count' movement on that date.
 */
export async function countStock(ctx: Ctx, c: StockCountInput): Promise<number> {
  const user = requireUser(ctx)
  requirePermission(ctx, 'inventory.adjust')
  assert(isIsoDate(c.date) && c.date <= (await farmToday(ctx)), 'invalid_date')
  assert(c.lines.length > 0 && c.lines.length <= 500, 'receipt_needs_lines')
  return ctx.db.transaction(async () => {
    await assertDateWritable(ctx, c.date)
    const store = await getStore(ctx, c.warehouseId, { ofFarm: true, active: true })
    const now = ctx.now().toISOString()
    const id = (
      await ctx.db
        .prepare('INSERT INTO stock_counts (organization_id, warehouse_id, count_date, notes, counted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ctx.org, store.id, c.date, c.notes?.trim() || null, user.id, now)
    ).lastInsertRowid
    const seen = new Set<string>()
    for (const l of c.lines) {
      assert(l.countedQty >= 0 && Number.isFinite(l.countedQty), 'quantity_positive')
      const key = `${l.itemId}:${l.batchId ?? ''}`
      assert(!seen.has(key), 'invalid_input', { field: 'lines' })
      seen.add(key)
      const item = await getItem(ctx, l.itemId)
      if (l.batchId)
        assert(
          await ctx.db.prepare('SELECT 1 AS x FROM inventory_batches WHERE id = ? AND organization_id = ? AND item_id = ?').get(l.batchId, ctx.org, l.itemId),
          'batch_not_found',
          { batch: String(l.batchId) }
        )
      const sys = (await ctx.db
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS b FROM inventory_transactions
           WHERE organization_id = ? AND warehouse_id = ? AND item_id = ? AND txn_date <= ? AND ${l.batchId ? 'batch_id = ?' : '1 = 1'}`
        )
        .get(ctx.org, store.id, l.itemId, c.date, ...(l.batchId ? [l.batchId] : []))) as { b: number }
      const system = round(Number(sys.b), 3)
      const diff = round(l.countedQty - system, 3)
      const lineId = (
        await ctx.db
          .prepare('INSERT INTO stock_count_lines (organization_id, count_id, item_id, batch_id, system_qty, counted_qty) VALUES (?, ?, ?, ?, ?, ?)')
          .run(ctx.org, id, l.itemId, l.batchId, system, l.countedQty)
      ).lastInsertRowid
      if (diff !== 0) {
        await ctx.db
          .prepare(
            `INSERT INTO inventory_transactions (organization_id, item_id, warehouse_id, batch_id, txn_date, type, quantity, reference, notes, source_type, source_id,
               recorded_by, created_at) VALUES (?, ?, ?, ?, ?, 'count', ?, ?, ?, 'stock_count_line', ?, ?, ?)`
          )
          .run(ctx.org, l.itemId, store.id, l.batchId, c.date, diff, `COUNT-${id}`, c.notes?.trim() || 'Stock count', lineId, user.id, now)
      }
      // Later movements must still be covered after the correction.
      await assertNotNegative(ctx, item.id, l.batchId, store.id)
    }
    await audit(ctx, { action: 'stock_count', entity: 'warehouse', entityId: store.id, details: { countId: id, date: c.date, lines: c.lines.length } })
    return id
  })()
}

export async function listCounts(ctx: Ctx, from: string, to: string): Promise<StockCountRow[]> {
  const heads = (await ctx.db
    .prepare(
      `SELECT c.id, c.count_date AS date, w.name AS warehouseName, u.display_name AS countedBy, c.notes
       FROM stock_counts c JOIN warehouses w ON w.id = c.warehouse_id LEFT JOIN users u ON u.id = c.counted_by
       WHERE c.organization_id = ? AND w.farm_id = ? AND c.count_date BETWEEN ? AND ? ORDER BY c.count_date DESC, c.id DESC`
    )
    .all(ctx.org, ctx.farm, from, to)) as Omit<StockCountRow, 'lines'>[]
  const out: StockCountRow[] = []
  for (const h of heads) {
    const lines = (
      (await ctx.db
        .prepare(
          `SELECT i.name AS itemName, i.unit, b.batch_no AS batchNo, l.system_qty AS systemQty, l.counted_qty AS countedQty
           FROM stock_count_lines l JOIN inventory_items i ON i.id = l.item_id LEFT JOIN inventory_batches b ON b.id = l.batch_id WHERE l.count_id = ? ORDER BY i.name`
        )
        .all(h.id)) as Omit<StockCountRow['lines'][number], 'difference'>[]
    ).map((l) => ({ ...l, difference: round(l.countedQty - l.systemQty, 3) }))
    out.push({ ...h, lines })
  }
  return out
}
