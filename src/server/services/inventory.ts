import { daysBetween, isIsoDate, todayInTimezone } from '@shared/dates'
import { round } from '@shared/calc'
import type { InventoryBalance, InventoryBatch, InventoryCategory, InventoryItem, InventoryTxn, TxnType } from '@shared/types'
import { type Ctx, requireAdmin, requireUser } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { getSettings } from './settings'

const itemCols = `id, category, name, unit, low_stock_threshold AS lowStockThreshold, active, notes`

function toItem(r: Record<string, unknown>): InventoryItem {
  return { ...(r as unknown as InventoryItem), active: !!r.active }
}

export const INCREASING: TxnType[] = ['opening', 'purchase', 'receipt', 'return']
export const DECREASING: TxnType[] = ['issue', 'usage', 'wastage', 'expired']

type OrgCtx = Pick<Ctx, 'db' | 'org'>

/** The organization's store items. (Stock is held per organization; stores and warehouses come later.) */
export async function listItems(ctx: OrgCtx, category?: InventoryCategory): Promise<InventoryItem[]> {
  const rows = (await ctx.db
    .prepare(`SELECT ${itemCols} FROM inventory_items WHERE organization_id = ? ${category ? 'AND category = ?' : ''} ORDER BY category, name`)
    .all(...(category ? [ctx.org, category] : [ctx.org]))) as Record<string, unknown>[]
  return rows.map(toItem)
}

/** An item of the context's organization; any other id is "not found". */
export async function getItem(ctx: OrgCtx, id: number): Promise<InventoryItem> {
  const r = (await ctx.db.prepare(`SELECT ${itemCols} FROM inventory_items WHERE id = ? AND organization_id = ?`).get(id, ctx.org)) as
    | Record<string, unknown>
    | undefined
  assert(r, 'item_not_found')
  return toItem(r)
}

export interface ItemInput {
  category: InventoryCategory
  name: string
  unit: string
  lowStockThreshold: number | null
  active: boolean
  notes: string | null
}

export async function insertItemRaw(ctx: Ctx, i: ItemInput): Promise<number> {
  const name = i.name.trim()
  assert(name, 'required_field', { field: 'name' })
  assert(i.unit.trim(), 'required_field', { field: 'unit' })
  const dup = await ctx.db.prepare('SELECT 1 AS x FROM inventory_items WHERE organization_id = ? AND category = ? AND name = ?').get(ctx.org, i.category, name)
  assert(!dup, 'item_name_taken')
  const info = await ctx.db
    .prepare(
      `INSERT INTO inventory_items (organization_id, category, name, unit, low_stock_threshold, active, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ctx.org, i.category, name, i.unit.trim(), i.lowStockThreshold, i.active ? 1 : 0, i.notes, ctx.now().toISOString())
  const id = Number(info.lastInsertRowid)
  await audit(ctx, { action: 'create', entity: 'inventory_item', entityId: id, details: i })
  return id
}

export async function createItem(ctx: Ctx, i: ItemInput) {
  requireAdmin(ctx)
  return ctx.db.transaction(async () => insertItemRaw(ctx, i))()
}

export async function updateItem(ctx: Ctx, id: number, i: ItemInput) {
  requireAdmin(ctx)
  await ctx.db.transaction(async () => {
    const before = await getItem(ctx, id)
    assert(before.category === i.category, 'cannot_change_category')
    const dup = await ctx.db
      .prepare('SELECT 1 AS x FROM inventory_items WHERE organization_id = ? AND category = ? AND name = ? AND id <> ?')
      .get(ctx.org, i.category, i.name.trim(), id)
    assert(!dup, 'item_name_taken')
    await ctx.db
      .prepare('UPDATE inventory_items SET name = ?, unit = ?, low_stock_threshold = ?, active = ?, notes = ? WHERE id = ? AND organization_id = ?')
      .run(i.name.trim(), i.unit.trim(), i.lowStockThreshold, i.active ? 1 : 0, i.notes, id, ctx.org)
    await audit(ctx, { action: 'update', entity: 'inventory_item', entityId: id, details: { before, after: i } })
  })()
}

export async function itemBalance(ctx: OrgCtx, itemId: number, asOf?: string): Promise<number> {
  const r = (await ctx.db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS b FROM inventory_transactions WHERE organization_id = ? AND item_id = ? ${asOf ? 'AND txn_date <= ?' : ''}`
    )
    .get(...(asOf ? [ctx.org, itemId, asOf] : [ctx.org, itemId]))) as { b: number }
  return round(r.b, 3)
}

export async function batchBalance(ctx: OrgCtx, batchId: number): Promise<number> {
  const r = (await ctx.db
    .prepare('SELECT COALESCE(SUM(quantity), 0) AS b FROM inventory_transactions WHERE organization_id = ? AND batch_id = ?')
    .get(ctx.org, batchId)) as { b: number }
  return round(r.b, 3)
}

/** Balances per item, optionally as of the end of a business date. */
export async function balances(ctx: OrgCtx, category?: InventoryCategory, asOf?: string): Promise<InventoryBalance[]> {
  const args: unknown[] = []
  if (asOf) args.push(asOf)
  args.push(ctx.org)
  if (category) args.push(category)
  const rows = (await ctx.db
    .prepare(
      `SELECT i.id, i.category, i.name, i.unit, i.low_stock_threshold AS lowStockThreshold, i.active, i.notes,
         COALESCE((SELECT SUM(t.quantity) FROM inventory_transactions t WHERE t.item_id = i.id
           ${asOf ? 'AND t.txn_date <= ?' : ''}), 0) AS balance
       FROM inventory_items i WHERE i.organization_id = ? ${category ? 'AND i.category = ?' : ''}
       ORDER BY i.category, i.name`
    )
    .all(...args)) as Record<string, unknown>[]
  return rows.map((r) => {
    const item = toItem(r)
    const balance = round(Number(r.balance), 3)
    return { ...item, balance, isLow: item.lowStockThreshold !== null && balance <= item.lowStockThreshold }
  })
}

export async function listBatches(ctx: OrgCtx, opts: { itemId?: number; onlyInStock?: boolean } = {}): Promise<InventoryBatch[]> {
  const today = todayInTimezone((await getSettings(ctx)).timezone)
  const rows = (await ctx.db
    .prepare(
      `SELECT b.id, b.item_id AS itemId, i.name AS itemName, i.unit, b.batch_no AS batchNo, b.expiry_date AS expiryDate,
         COALESCE((SELECT SUM(t.quantity) FROM inventory_transactions t WHERE t.batch_id = b.id), 0) AS balance
       FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id
       WHERE b.organization_id = ? ${opts.itemId ? 'AND b.item_id = ?' : ''}
       ORDER BY b.expiry_date IS NULL, b.expiry_date, b.batch_no`
    )
    .all(...(opts.itemId ? [ctx.org, opts.itemId] : [ctx.org]))) as (InventoryBatch & { balance: number })[]
  return rows
    .map((r) => ({
      ...r,
      balance: round(r.balance, 3),
      daysToExpiry: r.expiryDate ? daysBetween(today, r.expiryDate) : null
    }))
    .filter((r) => !opts.onlyInStock || r.balance > 0)
}

export async function getOrCreateBatch(ctx: Ctx, itemId: number, batchNo: string, expiryDate: string | null): Promise<number> {
  const no = batchNo.trim()
  const existing = (await ctx.db
    .prepare('SELECT id, expiry_date FROM inventory_batches WHERE organization_id = ? AND item_id = ? AND batch_no = ?')
    .get(ctx.org, itemId, no)) as { id: number; expiry_date: string | null } | undefined
  if (existing) {
    if (expiryDate && existing.expiry_date !== expiryDate) {
      assert(!existing.expiry_date, 'batch_expiry_mismatch', { batch: no, expiry: existing.expiry_date ?? '' })
      await ctx.db.prepare('UPDATE inventory_batches SET expiry_date = ? WHERE id = ?').run(expiryDate, existing.id)
    }
    return existing.id
  }
  const info = await ctx.db
    .prepare('INSERT INTO inventory_batches (organization_id, item_id, batch_no, expiry_date, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.org, itemId, no, expiryDate, ctx.now().toISOString())
  return Number(info.lastInsertRowid)
}

/** The context farm's day for a date, if it has been started. */
async function dayIdFor(ctx: Pick<Ctx, 'db' | 'org' | 'farm'>, date: string): Promise<number | null> {
  const r = (await ctx.db
    .prepare('SELECT id FROM farm_days WHERE organization_id = ? AND farm_id = ? AND business_date = ?')
    .get(ctx.org, ctx.farm, date)) as { id: number } | undefined
  return r?.id ?? null
}

/** Manual stock transactions may not be back-dated into a closed day unless it is being amended. */
export async function assertDateWritable(ctx: Ctx, date: string) {
  const d = (await ctx.db
    .prepare('SELECT status, amendment_open FROM farm_days WHERE organization_id = ? AND farm_id = ? AND business_date = ?')
    .get(ctx.org, ctx.farm, date)) as { status: string; amendment_open: number } | undefined
  if (d && d.status === 'closed') {
    assert(d.amendment_open, 'day_closed', { date })
    requireAdmin(ctx)
  }
}

export async function assertNotNegative(ctx: OrgCtx, itemId: number, batchId: number | null) {
  const item = await getItem(ctx, itemId)
  const bal = await itemBalance(ctx, itemId)
  assert(bal >= -1e-9, 'insufficient_stock', { item: item.name, balance: round(bal, 3), unit: item.unit })
  if (batchId) {
    const bb = await batchBalance(ctx, batchId)
    assert(bb >= -1e-9, 'insufficient_batch_stock', { item: item.name, balance: round(bb, 3), unit: item.unit })
  }
}

/** A cage of the context's farm (or none). */
async function assertOwnCage(ctx: Ctx, cageId: number | null) {
  if (cageId === null) return
  const c = await ctx.db.prepare('SELECT 1 AS x FROM cages WHERE id = ? AND organization_id = ? AND farm_id = ?').get(cageId, ctx.org, ctx.farm)
  assert(c, 'cage_not_found')
}

export interface TxnInput {
  itemId: number
  type: TxnType
  /** Positive magnitude, except for 'adjustment' where the sign is the direction. */
  quantity: number
  date: string
  batchNo: string | null
  expiryDate: string | null
  unitCost: number | null
  supplier: string | null
  reference: string | null
  notes: string | null
  cageId: number | null
}

/** Records a manual stock movement. Balances are never stored: they are always the sum of transactions. */
export async function recordTxn(ctx: Ctx, t: TxnInput): Promise<number> {
  requireUser(ctx)
  assert(isIsoDate(t.date), 'invalid_date')
  assert(t.quantity !== 0 && Number.isFinite(t.quantity), 'quantity_required')
  if (t.type === 'adjustment' || t.type === 'opening') {
    requireAdmin(ctx)
    assert(t.notes && t.notes.trim().length >= 3, 'reason_required')
  } else {
    assert(t.quantity > 0, 'quantity_positive')
  }
  return ctx.db.transaction(async () => {
    await assertDateWritable(ctx, t.date)
    const item = await getItem(ctx, t.itemId)
    await assertOwnCage(ctx, t.cageId)
    if (item.category === 'medicine' && (t.type === 'purchase' || t.type === 'receipt')) {
      assert(t.batchNo && t.batchNo.trim(), 'batch_required')
    }
    const batchId = t.batchNo && t.batchNo.trim() ? await getOrCreateBatch(ctx, t.itemId, t.batchNo, t.expiryDate) : null
    const signed = DECREASING.includes(t.type) ? -Math.abs(t.quantity) : t.type === 'adjustment' ? t.quantity : Math.abs(t.quantity)
    const dayId = await dayIdFor(ctx, t.date)
    const info = await ctx.db
      .prepare(
        `INSERT INTO inventory_transactions (organization_id, item_id, batch_id, txn_date, day_id, cage_id, type, quantity, unit_cost,
           supplier, reference, notes, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(ctx.org, t.itemId, batchId, t.date, dayId, t.cageId, t.type, signed, t.unitCost, t.supplier, t.reference, t.notes, ctx.user!.id, ctx.now().toISOString())
    if (signed < 0) await assertNotNegative(ctx, t.itemId, batchId)
    const id = Number(info.lastInsertRowid)
    await audit(ctx, {
      action: 'stock_' + t.type,
      entity: 'inventory_transaction',
      entityId: id,
      dayId,
      reason: t.type === 'adjustment' ? t.notes : null,
      details: { item: item.name, quantity: signed, unit: item.unit, batch: t.batchNo }
    })
    return id
  })()
}

/**
 * Keeps exactly one stock transaction for a source record (e.g. the feed issued on a feed record).
 * The UNIQUE(source_type, source_id, type) constraint makes double deduction impossible.
 */
export async function syncLinkedTxn(
  ctx: Ctx,
  link: {
    sourceType: string
    sourceId: number
    type: TxnType
    itemId: number
    batchId: number | null
    signedQuantity: number
    date: string
    dayId: number
    cageId: number | null
  }
) {
  const existing = (await ctx.db
    .prepare('SELECT id, quantity, item_id, batch_id FROM inventory_transactions WHERE organization_id = ? AND source_type = ? AND source_id = ? AND type = ?')
    .get(ctx.org, link.sourceType, link.sourceId, link.type)) as { id: number; quantity: number; item_id: number; batch_id: number | null } | undefined
  const qty = round(link.signedQuantity, 3)
  if (qty === 0) {
    if (existing) await ctx.db.prepare('DELETE FROM inventory_transactions WHERE id = ?').run(existing.id)
  } else if (existing) {
    await ctx.db
      .prepare('UPDATE inventory_transactions SET quantity = ?, item_id = ?, batch_id = ?, cage_id = ? WHERE id = ?')
      .run(qty, link.itemId, link.batchId, link.cageId, existing.id)
  } else {
    await ctx.db
      .prepare(
        `INSERT INTO inventory_transactions (organization_id, item_id, batch_id, txn_date, day_id, cage_id, type, quantity, source_type,
           source_id, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(ctx.org, link.itemId, link.batchId, link.date, link.dayId, link.cageId, link.type, qty, link.sourceType, link.sourceId, ctx.user?.id ?? null, ctx.now().toISOString())
  }
  if (qty < 0 || (existing && existing.quantity > 0)) await assertNotNegative(ctx, link.itemId, link.batchId)
  if (existing && existing.item_id !== link.itemId) await assertNotNegative(ctx, existing.item_id, existing.batch_id)
}

export async function listTxns(ctx: OrgCtx, f: { itemId?: number; category?: InventoryCategory; from?: string; to?: string; limit?: number }): Promise<InventoryTxn[]> {
  const where: string[] = ['t.organization_id = ?']
  const args: unknown[] = [ctx.org]
  if (f.itemId) {
    where.push('t.item_id = ?')
    args.push(f.itemId)
  }
  if (f.category) {
    where.push('i.category = ?')
    args.push(f.category)
  }
  if (f.from) {
    where.push('t.txn_date >= ?')
    args.push(f.from)
  }
  if (f.to) {
    where.push('t.txn_date <= ?')
    args.push(f.to)
  }
  args.push(Math.min(f.limit ?? 500, 5000))
  return (await ctx.db
    .prepare(
      `SELECT t.id, t.item_id AS itemId, i.name AS itemName, i.unit, b.batch_no AS batchNo, t.txn_date AS txnDate,
         c.name AS cageName, t.type, t.quantity, t.unit_cost AS unitCost, t.supplier, t.reference, t.notes,
         t.source_type AS sourceType, u.display_name AS recordedBy, t.created_at AS createdAt
       FROM inventory_transactions t
       JOIN inventory_items i ON i.id = t.item_id
       LEFT JOIN inventory_batches b ON b.id = t.batch_id
       LEFT JOIN cages c ON c.id = t.cage_id
       LEFT JOIN users u ON u.id = t.recorded_by
       WHERE ${where.join(' AND ')}
       ORDER BY t.txn_date DESC, t.id DESC LIMIT ?`
    )
    .all(...args)) as InventoryTxn[]
}
