import { round } from '@shared/calc'
import { isIsoDate } from '@shared/dates'
import type { GoodsReceipt, GoodsReceiptLine } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { farmToday } from './days'
import { assertDateWritable, assertNotNegative, getItem, getOrCreateBatch } from './inventory'
import { requirePermission } from './roles'

export interface ReceiptInput {
  date: string
  supplierId: number | null
  invoiceNo: string | null
  vehicle: string | null
  notes: string | null
  lines: { itemId: number; quantity: number; unitCost: number | null; batchNo: string | null; expiryDate: string | null }[]
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

/**
 * Records a delivery from a supplier (goods received note). Every line adds stock through one
 * 'purchase' transaction linked to the line, so the store balance rises exactly once.
 */
export async function createReceipt(ctx: Ctx, r: ReceiptInput): Promise<{ id: number; grnNo: string }> {
  const user = requireUser(ctx)
  assert(isIsoDate(r.date), 'invalid_date')
  assert(r.date <= await farmToday(ctx), 'future_date')
  assert(r.lines.length > 0 && r.lines.length <= 50, 'receipt_needs_lines')
  return ctx.db.transaction(async () => {
    await assertDateWritable(ctx, r.date)
    if (r.supplierId) assert(await ctx.db.prepare('SELECT 1 AS x FROM suppliers WHERE id = ? AND organization_id = ?').get(r.supplierId, ctx.org), 'not_found')
    const grnNo = await nextNumber(ctx, 'GRN', 'goods_receipts', 'grn_no', r.date)
    const now = ctx.now().toISOString()
    const id = Number(
      (await ctx.db
        .prepare(
          'INSERT INTO goods_receipts (organization_id, grn_no, receipt_date, supplier_id, invoice_no, vehicle, notes, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(ctx.org, grnNo, r.date, r.supplierId, r.invoiceNo?.trim() || null, r.vehicle?.trim() || null, r.notes?.trim() || null, user.id, now)).lastInsertRowid
    )
    const day = (await ctx.db
      .prepare('SELECT id FROM farm_days WHERE organization_id = ? AND farm_id = ? AND business_date = ?')
      .get(ctx.org, ctx.farm, r.date)) as { id: number } | undefined
    const dayId = day?.id ?? null
    const supplier = r.supplierId
      ? ((await ctx.db.prepare('SELECT name FROM suppliers WHERE id = ? AND organization_id = ?').get(r.supplierId, ctx.org)) as { name: string }).name
      : null
    for (const l of r.lines) {
      assert(l.quantity > 0 && Number.isFinite(l.quantity), 'quantity_positive')
      const item = await getItem(ctx, l.itemId)
      if (item.category === 'medicine') assert(l.batchNo && l.batchNo.trim(), 'batch_required')
      const batchId = l.batchNo && l.batchNo.trim() ? await getOrCreateBatch(ctx, l.itemId, l.batchNo, l.expiryDate) : null
      const lineId = Number(
        (await ctx.db
          .prepare('INSERT INTO goods_receipt_lines (organization_id, receipt_id, item_id, batch_id, quantity, unit_cost) VALUES (?, ?, ?, ?, ?, ?)')
          .run(ctx.org, id, l.itemId, batchId, l.quantity, l.unitCost)).lastInsertRowid
      )
      await ctx.db
        .prepare(
          `INSERT INTO inventory_transactions (organization_id, item_id, batch_id, txn_date, day_id, type, quantity, unit_cost, supplier, reference,
             source_type, source_id, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, 'purchase', ?, ?, ?, ?, 'grn_line', ?, ?, ?)`
        )
        .run(ctx.org, l.itemId, batchId, r.date, dayId, round(l.quantity, 3), l.unitCost, supplier, grnNo, lineId, user.id, now)
    }
    await audit(ctx, { action: 'goods_received', entity: 'goods_receipt', entityId: id, dayId, details: { grnNo, ...r } })
    return { id, grnNo }
  })()
}

/** Cancels a receipt entered by mistake (administrator, with a reason): its stock is removed again. */
export async function cancelReceipt(ctx: Ctx, id: number, reason: string) {
  requirePermission(ctx, 'purchases.cancel')
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const r = (await ctx.db.prepare('SELECT * FROM goods_receipts WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as { receipt_date: string; grn_no: string } | undefined
    assert(r, 'not_found')
    await assertDateWritable(ctx, r.receipt_date)
    const lines = (await ctx.db.prepare('SELECT id, item_id, batch_id FROM goods_receipt_lines WHERE receipt_id = ?').all(id)) as { id: number; item_id: number; batch_id: number | null }[]
    for (const l of lines) {
      await ctx.db.prepare("DELETE FROM inventory_transactions WHERE organization_id = ? AND source_type = 'grn_line' AND source_id = ?").run(ctx.org, l.id)
    }
    await ctx.db.prepare('DELETE FROM goods_receipts WHERE id = ?').run(id)
    // Stock already used cannot be "un-received".
    for (const l of lines) await assertNotNegative(ctx, l.item_id, l.batch_id)
    await audit(ctx, { action: 'cancel_receipt', entity: 'goods_receipt', entityId: id, reason, details: r })
  })()
}

export async function listReceipts(ctx: Pick<Ctx, 'db' | 'org'>, from: string, to: string): Promise<GoodsReceipt[]> {
  const heads = (await ctx.db
    .prepare(
      `SELECT g.id, g.grn_no AS grnNo, g.receipt_date AS date, g.supplier_id AS supplierId, s.name AS supplierName,
         g.invoice_no AS invoiceNo, g.vehicle, g.notes, u.display_name AS recordedBy, g.created_at AS createdAt
       FROM goods_receipts g LEFT JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN users u ON u.id = g.recorded_by
       WHERE g.organization_id = ? AND g.receipt_date BETWEEN ? AND ? ORDER BY g.receipt_date DESC, g.id DESC`
    )
    .all(ctx.org, from, to)) as Omit<GoodsReceipt, 'lines' | 'totalCost'>[]
  const lineStmt = ctx.db.prepare(
    `SELECT l.item_id AS itemId, i.name AS itemName, i.category, i.unit, b.batch_no AS batchNo, b.expiry_date AS expiryDate,
       l.quantity, l.unit_cost AS unitCost
     FROM goods_receipt_lines l JOIN inventory_items i ON i.id = l.item_id LEFT JOIN inventory_batches b ON b.id = l.batch_id
     WHERE l.receipt_id = ? ORDER BY l.id`
  )
  const out: GoodsReceipt[] = []
  for (const h of heads) {
    const lines = (await lineStmt.all(h.id)) as GoodsReceiptLine[]
    out.push({ ...h, lines, totalCost: round(lines.reduce((s, l) => s + l.quantity * (l.unitCost ?? 0), 0), 2) })
  }
  return out
}
