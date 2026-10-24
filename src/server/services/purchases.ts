import { round } from '@shared/calc'
import { isIsoDate } from '@shared/dates'
import type { PurchaseOrder, PurchaseOrderInput, PurchaseOrderLine, ReceiptLineInput } from '@shared/stores'
import type { GoodsReceipt, GoodsReceiptLine } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { AppError, assert } from '../errors'
import { audit } from './audit'
import { farmToday } from './days'
import { assertDateWritable, assertNotNegative, getItem, getOrCreateBatch, getStore, mainStore } from './inventory'
import { hasPermission, requirePermission } from './roles'
import { getSettings } from './settings'

export interface ReceiptInput {
  date: string
  supplierId: number | null
  invoiceNo: string | null
  vehicle: string | null
  notes: string | null
  /** A store of the farm being worked on (default: the purchase order's store, else the farm's main store) */
  warehouseId?: number | null
  poId?: number | null
  deliveryNote?: string | null
  /** Sent by the browser once per form: sending the same receipt twice records it once */
  clientRef?: string | null
  lines: (Partial<ReceiptLineInput> & { itemId: number; quantity: number; unitCost: number | null; batchNo: string | null; expiryDate: string | null })[]
}

/** The organization's next document number for a date, e.g. GRN-20261016-002. */
export async function nextNumber(ctx: Pick<Ctx, 'db' | 'org'>, prefix: string, table: string, column: string, date: string) {
  const stem = `${prefix}-${date.replace(/-/g, '')}-`
  const row = (await ctx.db
    .prepare(`SELECT ${column} AS no FROM ${table} WHERE organization_id = ? AND ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`)
    .get(ctx.org, stem + '%')) as { no: string } | undefined
  const n = row ? Number(row.no.slice(stem.length)) + 1 : 1
  return stem + String(n).padStart(3, '0')
}

// ---------------------------------------------------------------- purchase orders

/** Quantity accepted into stock against each line of a purchase order (posted receipts only). */
async function receivedByPoLine(ctx: Pick<Ctx, 'db' | 'org'>, poId: number): Promise<Map<number, number>> {
  const rows = (await ctx.db
    .prepare(
      `SELECT l.po_line_id AS id, SUM(l.quantity - l.rejected_qty - l.damaged_qty) AS q
       FROM goods_receipt_lines l JOIN goods_receipts g ON g.id = l.receipt_id
       WHERE g.organization_id = ? AND g.po_id = ? AND g.status = 'posted' AND l.po_line_id IS NOT NULL GROUP BY l.po_line_id`
    )
    .all(ctx.org, poId)) as { id: number; q: number }[]
  return new Map(rows.map((r) => [r.id, round(Number(r.q), 3)]))
}

export async function listOrders(ctx: Ctx, f: { openOnly?: boolean } = {}): Promise<PurchaseOrder[]> {
  const heads = (await ctx.db
    .prepare(
      `SELECT p.id, p.po_no AS poNo, p.order_date AS orderDate, p.expected_date AS expectedDate, p.supplier_id AS supplierId, s.name AS supplierName,
         p.warehouse_id AS warehouseId, w.name AS warehouseName, p.status, p.notes, u.display_name AS createdBy, p.created_at AS createdAt
       FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id JOIN warehouses w ON w.id = p.warehouse_id
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.organization_id = ? ${f.openOnly ? "AND p.status = 'open'" : ''} ORDER BY p.order_date DESC, p.id DESC LIMIT 300`
    )
    .all(ctx.org)) as (Omit<PurchaseOrder, 'lines' | 'total' | 'status'> & { status: 'open' | 'closed' | 'cancelled' })[]
  const out: PurchaseOrder[] = []
  for (const h of heads) {
    const received = await receivedByPoLine(ctx, h.id)
    const lines = (
      (await ctx.db
        .prepare(
          `SELECT l.id, l.item_id AS itemId, i.name AS itemName, i.unit, l.quantity, l.unit_cost AS unitCost
           FROM purchase_order_lines l JOIN inventory_items i ON i.id = l.item_id WHERE l.po_id = ? ORDER BY l.id`
        )
        .all(h.id)) as Omit<PurchaseOrderLine, 'received'>[]
    ).map((l) => ({ ...l, received: received.get(l.id) ?? 0 }))
    const all = lines.every((l) => l.received >= l.quantity - 1e-9)
    const any = lines.some((l) => l.received > 0)
    const status: PurchaseOrder['status'] = h.status !== 'open' ? h.status : all ? 'received' : any ? 'partial' : 'open'
    out.push({ ...h, status, lines, total: round(lines.reduce((s, l) => s + l.quantity * (l.unitCost ?? 0), 0), 2) })
  }
  return f.openOnly ? out.filter((o) => o.status === 'open' || o.status === 'partial') : out
}

export async function createOrder(ctx: Ctx, o: PurchaseOrderInput): Promise<{ id: number; poNo: string }> {
  const user = requireUser(ctx)
  requirePermission(ctx, 'purchases.record')
  assert(isIsoDate(o.orderDate) && (!o.expectedDate || (isIsoDate(o.expectedDate) && o.expectedDate >= o.orderDate)), 'invalid_date')
  assert(o.lines.length > 0 && o.lines.length <= 50, 'receipt_needs_lines')
  return ctx.db.transaction(async () => {
    assert(await ctx.db.prepare('SELECT 1 AS x FROM suppliers WHERE id = ? AND organization_id = ?').get(o.supplierId, ctx.org), 'not_found')
    await getStore(ctx, o.warehouseId, { ofFarm: false, active: true })
    const poNo = await nextNumber(ctx, 'PO', 'purchase_orders', 'po_no', o.orderDate)
    const id = (
      await ctx.db
        .prepare(
          'INSERT INTO purchase_orders (organization_id, po_no, order_date, expected_date, supplier_id, warehouse_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(ctx.org, poNo, o.orderDate, o.expectedDate, o.supplierId, o.warehouseId, o.notes?.trim() || null, user.id, ctx.now().toISOString())
    ).lastInsertRowid
    for (const l of o.lines) {
      assert(l.quantity > 0, 'quantity_positive')
      await getItem(ctx, l.itemId)
      await ctx.db.prepare('INSERT INTO purchase_order_lines (organization_id, po_id, item_id, quantity, unit_cost) VALUES (?, ?, ?, ?, ?)').run(ctx.org, id, l.itemId, l.quantity, l.unitCost)
    }
    await audit(ctx, { action: 'create', entity: 'purchase_order', entityId: id, details: { poNo, ...o } })
    return { id, poNo }
  })()
}

/** Closes a purchase order (nothing more is expected) or cancels one nothing was received against. */
export async function closeOrder(ctx: Ctx, id: number, status: 'closed' | 'cancelled', reason: string) {
  requirePermission(ctx, 'purchases.record')
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const po = (await ctx.db.prepare('SELECT status FROM purchase_orders WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as { status: string } | undefined
    assert(po, 'not_found')
    assert(po.status === 'open', 'order_not_open')
    if (status === 'cancelled') {
      const any = await ctx.db.prepare("SELECT 1 AS x FROM goods_receipts WHERE po_id = ? AND status IN ('posted','submitted')").get(id)
      assert(!any, 'order_has_receipts')
    }
    await ctx.db
      .prepare('UPDATE purchase_orders SET status = ?, closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?')
      .run(status, ctx.user!.id, ctx.now().toISOString(), reason.trim(), id)
    await audit(ctx, { action: status === 'closed' ? 'close' : 'cancel', entity: 'purchase_order', entityId: id, reason: reason.trim() })
  })()
}

// ---------------------------------------------------------------- goods received notes

/**
 * Records a delivery from a supplier (goods received note). Rejected and damaged quantities are
 * recorded but not taken into stock. When the organization requires approval, the note waits as
 * "submitted" and stock is posted when it is approved; otherwise it is posted at once.
 */
export async function createReceipt(ctx: Ctx, r: ReceiptInput): Promise<{ id: number; grnNo: string; status: 'submitted' | 'posted' }> {
  const user = requireUser(ctx)
  assert(isIsoDate(r.date), 'invalid_date')
  assert(r.date <= (await farmToday(ctx)), 'future_date')
  assert(r.lines.length > 0 && r.lines.length <= 50, 'receipt_needs_lines')
  return ctx.db.transaction(async () => {
    // The same form sent twice (double click, retry after a lost reply) is recorded once.
    const clientRef = r.clientRef?.trim() || null
    if (clientRef) {
      const dup = (await ctx.db.prepare('SELECT id, grn_no AS grnNo, status FROM goods_receipts WHERE organization_id = ? AND client_ref = ?').get(ctx.org, clientRef)) as
        | { id: number; grnNo: string; status: 'submitted' | 'posted' }
        | undefined
      if (dup) return dup
    }
    await assertDateWritable(ctx, r.date)
    let supplierId = r.supplierId
    let warehouseId = r.warehouseId ?? null
    let poLines = new Map<number, { item_id: number; quantity: number }>()
    if (r.poId) {
      const po = (await ctx.db.prepare('SELECT supplier_id, warehouse_id, status FROM purchase_orders WHERE id = ? AND organization_id = ?').get(r.poId, ctx.org)) as
        | { supplier_id: number; warehouse_id: number; status: string }
        | undefined
      assert(po, 'not_found')
      assert(po.status === 'open', 'order_not_open')
      assert(!supplierId || supplierId === po.supplier_id, 'supplier_mismatch')
      supplierId = po.supplier_id
      warehouseId ??= po.warehouse_id
      poLines = new Map(
        ((await ctx.db.prepare('SELECT id, item_id, quantity FROM purchase_order_lines WHERE po_id = ?').all(r.poId)) as { id: number; item_id: number; quantity: number }[]).map((l) => [
          l.id,
          l
        ])
      )
    }
    if (supplierId) assert(await ctx.db.prepare('SELECT 1 AS x FROM suppliers WHERE id = ? AND organization_id = ?').get(supplierId, ctx.org), 'not_found')
    const store = warehouseId ? (await getStore(ctx, warehouseId)).id : await mainStore(ctx)
    const approval = (await getSettings(ctx)).grnApprovalRequired
    const status: 'submitted' | 'posted' = approval ? 'submitted' : 'posted'
    const grnNo = await nextNumber(ctx, 'GRN', 'goods_receipts', 'grn_no', r.date)
    const now = ctx.now().toISOString()
    const id = Number(
      (await ctx.db
        .prepare(
          `INSERT INTO goods_receipts (organization_id, grn_no, receipt_date, supplier_id, warehouse_id, po_id, invoice_no, delivery_note, vehicle, notes,
             status, client_ref, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.org, grnNo, r.date, supplierId, store, r.poId ?? null, r.invoiceNo?.trim() || null, r.deliveryNote?.trim() || null, r.vehicle?.trim() || null, r.notes?.trim() || null, status, clientRef, user.id, now)).lastInsertRowid
    )
    const received = r.poId ? await receivedByPoLine(ctx, r.poId) : new Map<number, number>()
    for (const l of r.lines) {
      const rejected = l.rejectedQty ?? 0
      const damaged = l.damagedQty ?? 0
      assert(l.quantity > 0 && Number.isFinite(l.quantity) && rejected >= 0 && damaged >= 0, 'quantity_positive')
      assert(rejected + damaged <= l.quantity + 1e-9, 'rejected_exceeds_delivered')
      if (rejected + damaged > 0) assert((l.rejectReason?.trim().length ?? 0) >= 3, 'reason_required')
      const item = await getItem(ctx, l.itemId)
      if (item.category === 'medicine') assert(l.batchNo && l.batchNo.trim(), 'batch_required')
      let ordered: number | null = null
      if (l.poLineId) {
        const pl = poLines.get(l.poLineId)
        assert(pl && pl.item_id === l.itemId, 'not_found')
        ordered = pl.quantity
        // A delivery may not take more than what is still outstanding on the order.
        const accepted = l.quantity - rejected - damaged
        const outstanding = pl.quantity - (received.get(l.poLineId) ?? 0)
        if (accepted > outstanding + 1e-9) throw new AppError('over_receipt', { item: item.name, outstanding: round(outstanding, 3), unit: item.unit })
        received.set(l.poLineId, (received.get(l.poLineId) ?? 0) + accepted)
      } else {
        assert(!r.poId || poLines.size === 0, 'po_line_required')
      }
      const batchId = l.batchNo && l.batchNo.trim() ? await getOrCreateBatch(ctx, l.itemId, l.batchNo, l.expiryDate) : null
      await ctx.db
        .prepare(
          `INSERT INTO goods_receipt_lines (organization_id, receipt_id, po_line_id, item_id, batch_id, quantity, unit_cost, ordered_qty, rejected_qty, damaged_qty, reject_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.org, id, l.poLineId ?? null, l.itemId, batchId, l.quantity, l.unitCost, ordered, rejected, damaged, l.rejectReason?.trim() || null)
    }
    await audit(ctx, { action: 'goods_received', entity: 'goods_receipt', entityId: id, details: { grnNo, status, ...r } })
    if (status === 'posted') await postReceipt(ctx, id)
    return { id, grnNo, status }
  })()
}

/** Posts a receipt's accepted quantities to stock, exactly once (the source link is unique per line). */
async function postReceipt(ctx: Ctx, id: number) {
  const g = (await ctx.db
    .prepare('SELECT g.grn_no, g.receipt_date, g.warehouse_id, s.name AS supplier FROM goods_receipts g LEFT JOIN suppliers s ON s.id = g.supplier_id WHERE g.id = ?')
    .get(id)) as { grn_no: string; receipt_date: string; warehouse_id: number; supplier: string | null }
  const day = (await ctx.db
    .prepare('SELECT d.id FROM farm_days d JOIN warehouses w ON w.farm_id = d.farm_id WHERE w.id = ? AND d.business_date = ?')
    .get(g.warehouse_id, g.receipt_date)) as { id: number } | undefined
  const lines = (await ctx.db
    .prepare('SELECT id, item_id, batch_id, quantity - rejected_qty - damaged_qty AS accepted, unit_cost FROM goods_receipt_lines WHERE receipt_id = ?')
    .all(id)) as { id: number; item_id: number; batch_id: number | null; accepted: number; unit_cost: number | null }[]
  for (const l of lines) {
    if (Number(l.accepted) <= 0) continue
    await ctx.db
      .prepare(
        `INSERT INTO inventory_transactions (organization_id, item_id, warehouse_id, batch_id, txn_date, day_id, type, quantity, unit_cost, supplier, reference,
           source_type, source_id, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'purchase', ?, ?, ?, ?, 'grn_line', ?, ?, ?)`
      )
      .run(ctx.org, l.item_id, g.warehouse_id, l.batch_id, g.receipt_date, day?.id ?? null, round(Number(l.accepted), 3), l.unit_cost, g.supplier, g.grn_no, l.id, ctx.user?.id ?? null, ctx.now().toISOString())
  }
}

/** Approves a submitted receipt and posts its stock. Someone other than who recorded it approves (administrators excepted). */
export async function approveReceipt(ctx: Ctx, id: number) {
  const user = requireUser(ctx)
  requirePermission(ctx, 'purchases.approve')
  await ctx.db.transaction(async () => {
    const g = (await ctx.db.prepare('SELECT status, recorded_by, receipt_date FROM goods_receipts WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as
      | { status: string; recorded_by: number | null; receipt_date: string }
      | undefined
    assert(g, 'not_found')
    assert(g.recorded_by !== user.id || hasPermission(user, 'roles.manage'), 'cannot_approve_own')
    // Only one approval can ever post the stock.
    const r = await ctx.db
      .prepare("UPDATE goods_receipts SET status = 'posted', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'submitted'")
      .run(user.id, ctx.now().toISOString(), id)
    assert(r.changes === 1, 'receipt_not_submitted')
    await postReceipt(ctx, id)
    await audit(ctx, { action: 'approve_receipt', entity: 'goods_receipt', entityId: id })
  })()
}

export async function rejectReceipt(ctx: Ctx, id: number, reason: string) {
  const user = requireUser(ctx)
  requirePermission(ctx, 'purchases.approve')
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const r = await ctx.db
      .prepare("UPDATE goods_receipts SET status = 'rejected', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ? AND organization_id = ? AND status = 'submitted'")
      .run(user.id, ctx.now().toISOString(), reason.trim(), id, ctx.org)
    if (r.changes !== 1) {
      assert(await ctx.db.prepare('SELECT 1 AS x FROM goods_receipts WHERE id = ? AND organization_id = ?').get(id, ctx.org), 'not_found')
      throw new AppError('receipt_not_submitted')
    }
    await audit(ctx, { action: 'reject_receipt', entity: 'goods_receipt', entityId: id, reason: reason.trim() })
  })()
}

/**
 * Cancels a receipt entered by mistake (with a reason). Its stock is taken out again by reversing
 * movements; the receipt and its original movements stay in the history.
 */
export async function cancelReceipt(ctx: Ctx, id: number, reason: string) {
  const user = requireUser(ctx)
  requirePermission(ctx, 'purchases.cancel')
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const g = (await ctx.db.prepare('SELECT * FROM goods_receipts WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as
      | { receipt_date: string; grn_no: string; status: string; warehouse_id: number }
      | undefined
    assert(g, 'not_found')
    assert(g.status === 'posted' || g.status === 'submitted', 'receipt_cancelled')
    const today = await farmToday(ctx)
    const posted = (await ctx.db
      .prepare(
        `SELECT t.item_id, t.batch_id, t.quantity, t.source_id FROM inventory_transactions t JOIN goods_receipt_lines l ON l.id = t.source_id
         WHERE t.organization_id = ? AND t.source_type = 'grn_line' AND t.type = 'purchase' AND l.receipt_id = ?`
      )
      .all(ctx.org, id)) as { item_id: number; batch_id: number | null; quantity: number; source_id: number }[]
    for (const p of posted) {
      await ctx.db
        .prepare(
          `INSERT INTO inventory_transactions (organization_id, item_id, warehouse_id, batch_id, txn_date, type, quantity, reference, notes, source_type, source_id,
             recorded_by, created_at) VALUES (?, ?, ?, ?, ?, 'reversal', ?, ?, ?, 'grn_line', ?, ?, ?)`
        )
        .run(ctx.org, p.item_id, g.warehouse_id, p.batch_id, today, -Number(p.quantity), g.grn_no, `Cancelled: ${reason.trim()}`, p.source_id, user.id, ctx.now().toISOString())
    }
    await ctx.db
      .prepare("UPDATE goods_receipts SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?")
      .run(user.id, ctx.now().toISOString(), reason.trim(), id)
    // Stock already used cannot be "un-received".
    for (const p of posted) await assertNotNegative(ctx, p.item_id, p.batch_id, g.warehouse_id)
    await audit(ctx, { action: 'cancel_receipt', entity: 'goods_receipt', entityId: id, reason, details: { grnNo: g.grn_no, wasStatus: g.status } })
  })()
}

export async function listReceipts(ctx: Pick<Ctx, 'db' | 'org'>, from: string, to: string): Promise<GoodsReceipt[]> {
  const heads = (await ctx.db
    .prepare(
      `SELECT g.id, g.grn_no AS grnNo, g.receipt_date AS date, g.supplier_id AS supplierId, s.name AS supplierName,
         g.invoice_no AS invoiceNo, g.delivery_note AS deliveryNote, g.vehicle, g.notes, u.display_name AS recordedBy, g.created_at AS createdAt,
         g.status, g.warehouse_id AS warehouseId, w.name AS warehouseName, g.po_id AS poId, p.po_no AS poNo,
         a.display_name AS approvedBy, g.approved_at AS approvedAt, c.display_name AS cancelledBy, g.cancel_reason AS cancelReason
       FROM goods_receipts g LEFT JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN users u ON u.id = g.recorded_by
       JOIN warehouses w ON w.id = g.warehouse_id LEFT JOIN purchase_orders p ON p.id = g.po_id
       LEFT JOIN users a ON a.id = g.approved_by LEFT JOIN users c ON c.id = g.cancelled_by
       WHERE g.organization_id = ? AND g.receipt_date BETWEEN ? AND ? ORDER BY g.receipt_date DESC, g.id DESC`
    )
    .all(ctx.org, from, to)) as Omit<GoodsReceipt, 'lines' | 'totalCost'>[]
  const lineStmt = ctx.db.prepare(
    `SELECT l.item_id AS itemId, i.name AS itemName, i.category, i.unit, b.batch_no AS batchNo, b.expiry_date AS expiryDate,
       l.quantity, l.unit_cost AS unitCost, l.ordered_qty AS orderedQty, l.rejected_qty AS rejectedQty, l.damaged_qty AS damagedQty, l.reject_reason AS rejectReason
     FROM goods_receipt_lines l JOIN inventory_items i ON i.id = l.item_id LEFT JOIN inventory_batches b ON b.id = l.batch_id
     WHERE l.receipt_id = ? ORDER BY l.id`
  )
  const out: GoodsReceipt[] = []
  for (const h of heads) {
    const lines = (await lineStmt.all(h.id)) as GoodsReceiptLine[]
    out.push({ ...h, lines, totalCost: round(lines.reduce((s, l) => s + (l.quantity - l.rejectedQty - l.damagedQty) * (l.unitCost ?? 0), 0), 2) })
  }
  return out
}
