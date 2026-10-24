import { round } from '@shared/calc'
import { addDays, dateRange, isIsoDate } from '@shared/dates'
import type { EggDispatch, EggStock, EggStoreAdjustment, SalesDay } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { AppError, assert } from '../errors'
import { audit } from './audit'
import { farmToday } from './days'
import { assertDateWritable } from './inventory'
import { nextNumber } from './purchases'
import { requirePermission } from './roles'

/**
 * Egg store stock is never typed in. It is always:
 *   good eggs collected − good eggs dispatched + adjustments (and the same for cracked eggs)
 * Collections count from the moment they are recorded; rejected eggs never enter the store.
 * The store belongs to the organization: it receives the eggs of all its farms.
 */
export async function eggStock(ctx: Pick<Ctx, 'db' | 'org'>, asOf?: string): Promise<EggStock> {
  const date = asOf ?? '9999-12-31'
  const c = (await ctx.db
    .prepare(
      `SELECT COALESCE(SUM(e.good), 0) AS good, COALESCE(SUM(e.damaged), 0) AS cracked
       FROM egg_collections e JOIN farm_days d ON d.id = e.day_id WHERE e.organization_id = ? AND d.business_date <= ?`
    )
    .get(ctx.org, date)) as EggStock
  const s = (await ctx.db
    .prepare('SELECT COALESCE(SUM(good_qty), 0) AS good, COALESCE(SUM(cracked_qty), 0) AS cracked FROM egg_dispatches WHERE organization_id = ? AND dispatch_date <= ?')
    .get(ctx.org, date)) as EggStock
  const a = (await ctx.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN grade = 'good' THEN quantity END), 0) AS good,
              COALESCE(SUM(CASE WHEN grade = 'cracked' THEN quantity END), 0) AS cracked
       FROM egg_store_adjustments WHERE organization_id = ? AND adj_date <= ?`
    )
    .get(ctx.org, date)) as EggStock
  return { good: c.good - s.good + a.good, cracked: c.cracked - s.cracked + a.cracked }
}

/** Stock must not go below zero on the given date or on any later date (back-dated entries). */
async function assertEggStock(ctx: Ctx, date: string) {
  for (const d of [date, '9999-12-31']) {
    const s = await eggStock(ctx, d)
    if (s.good < 0) throw new AppError('not_enough_eggs', { grade: 'good', stock: s.good })
    if (s.cracked < 0) throw new AppError('not_enough_eggs', { grade: 'cracked', stock: s.cracked })
  }
}

export interface DispatchInput {
  date: string
  customerId: number
  goodQty: number
  goodPrice: number
  crackedQty: number
  crackedPrice: number
  amountPaid: number
  paymentMethod: 'cash' | 'bank' | 'cheque' | 'other'
  invoiceNo: string | null
  vehicle: string | null
  driver: string | null
  notes: string | null
}

/** Sends eggs out of the store to a customer; an amount paid on the spot is recorded as a payment. */
export async function createDispatch(ctx: Ctx, d: DispatchInput): Promise<{ id: number; dispatchNo: string }> {
  const user = requireUser(ctx)
  assert(isIsoDate(d.date), 'invalid_date')
  assert(d.date <= await farmToday(ctx), 'future_date')
  for (const q of [d.goodQty, d.crackedQty]) assert(Number.isInteger(q) && q >= 0, 'invalid_count')
  assert(d.goodQty + d.crackedQty > 0, 'quantity_required')
  const amount = round(d.goodQty * d.goodPrice + d.crackedQty * d.crackedPrice, 2)
  assert(d.amountPaid >= 0 && d.amountPaid <= amount + 0.005, 'payment_exceeds_balance')
  return ctx.db.transaction(async () => {
    await assertDateWritable(ctx, d.date)
    assert(await ctx.db.prepare('SELECT 1 AS x FROM customers WHERE id = ? AND organization_id = ?').get(d.customerId, ctx.org), 'not_found')
    const dispatchNo = await nextNumber(ctx, 'DSP', 'egg_dispatches', 'dispatch_no', d.date)
    const now = ctx.now().toISOString()
    const id = Number(
      (await ctx.db
        .prepare(
          `INSERT INTO egg_dispatches (organization_id, dispatch_no, dispatch_date, customer_id, good_qty, good_price, cracked_qty, cracked_price, amount,
             amount_paid, invoice_no, vehicle, driver, notes, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.org, dispatchNo, d.date, d.customerId, d.goodQty, d.goodPrice, d.crackedQty, d.crackedPrice, amount, 0, d.invoiceNo?.trim() || null, d.vehicle?.trim() || null, d.driver?.trim() || null, d.notes?.trim() || null, user.id, now))
        .lastInsertRowid
    )
    await assertEggStock(ctx, d.date)
    if (d.amountPaid > 0) await insertPayment(ctx, id, d.date, d.amountPaid, d.paymentMethod, null)
    await audit(ctx, { action: 'egg_dispatch', entity: 'egg_dispatch', entityId: id, details: { dispatchNo, ...d, amount } })
    return { id, dispatchNo }
  })()
}

async function insertPayment(ctx: Ctx, dispatchId: number, date: string, amount: number, method: string, reference: string | null) {
  await ctx.db
    .prepare('INSERT INTO customer_payments (organization_id, dispatch_id, payment_date, amount, method, reference, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.org, dispatchId, date, round(amount, 2), method, reference, ctx.user?.id ?? null, ctx.now().toISOString())
  await ctx.db.prepare('UPDATE egg_dispatches SET amount_paid = (SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE dispatch_id = ?) WHERE id = ?').run(dispatchId, dispatchId)
}

export async function addPayment(ctx: Ctx, p: { dispatchId: number; date: string; amount: number; method: 'cash' | 'bank' | 'cheque' | 'other'; reference: string | null }) {
  requireUser(ctx)
  assert(isIsoDate(p.date) && p.date <= await farmToday(ctx), 'invalid_date')
  assert(p.amount > 0, 'quantity_positive')
  await ctx.db.transaction(async () => {
    const d = (await ctx.db.prepare('SELECT amount, amount_paid, dispatch_no FROM egg_dispatches WHERE id = ? AND organization_id = ?').get(p.dispatchId, ctx.org)) as
      | { amount: number; amount_paid: number; dispatch_no: string }
      | undefined
    assert(d, 'not_found')
    assert(p.amount <= d.amount - d.amount_paid + 0.005, 'payment_exceeds_balance')
    await insertPayment(ctx, p.dispatchId, p.date, p.amount, p.method, p.reference?.trim() || null)
    await audit(ctx, { action: 'customer_payment', entity: 'egg_dispatch', entityId: p.dispatchId, details: { dispatchNo: d.dispatch_no, ...p } })
  })()
}

/** Cancels a dispatch entered by mistake (administrator, with a reason); the eggs return to the store. */
export async function cancelDispatch(ctx: Ctx, id: number, reason: string) {
  requirePermission(ctx, 'sales.cancel')
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const d = (await ctx.db.prepare('SELECT * FROM egg_dispatches WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as { dispatch_date: string } | undefined
    assert(d, 'not_found')
    await assertDateWritable(ctx, d.dispatch_date)
    await ctx.db.prepare('DELETE FROM egg_dispatches WHERE id = ?').run(id)
    await audit(ctx, { action: 'cancel_dispatch', entity: 'egg_dispatch', entityId: id, reason, details: d })
  })()
}

/** Breakage in the store, opening stock or a counted difference (administrator; signed quantity). */
export async function adjustEggStore(ctx: Ctx, a: { date: string; grade: 'good' | 'cracked'; quantity: number; reason: string }) {
  requirePermission(ctx, 'sales.adjust_store')
  assert(isIsoDate(a.date) && a.date <= await farmToday(ctx), 'invalid_date')
  assert(Number.isInteger(a.quantity) && a.quantity !== 0, 'quantity_required')
  assert(a.reason.trim().length >= 3, 'reason_required')
  return ctx.db.transaction(async () => {
    await assertDateWritable(ctx, a.date)
    const id = Number(
      (await ctx.db
        .prepare('INSERT INTO egg_store_adjustments (organization_id, adj_date, grade, quantity, reason, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.org, a.date, a.grade, a.quantity, a.reason.trim(), ctx.user!.id, ctx.now().toISOString())).lastInsertRowid
    )
    await assertEggStock(ctx, a.date)
    await audit(ctx, { action: 'egg_store_adjustment', entity: 'egg_store', entityId: id, reason: a.reason, details: a })
    return id
  })()
}

const dispatchCols = `d.id, d.dispatch_no AS dispatchNo, d.dispatch_date AS date, d.customer_id AS customerId, c.name AS customerName,
  d.good_qty AS goodQty, d.good_price AS goodPrice, d.cracked_qty AS crackedQty, d.cracked_price AS crackedPrice,
  d.amount, d.amount_paid AS amountPaid, d.invoice_no AS invoiceNo, d.vehicle, d.driver, d.notes, u.display_name AS recordedBy`

function toDispatch(r: Omit<EggDispatch, 'balance' | 'paymentStatus'>): EggDispatch {
  const balance = round(r.amount - r.amountPaid, 2)
  return { ...r, balance, paymentStatus: balance <= 0.004 ? 'paid' : r.amountPaid > 0 ? 'partial' : 'unpaid' }
}

export async function listDispatches(ctx: Pick<Ctx, 'db' | 'org'>, f: { from: string; to: string; customerId?: number | null; unpaidOnly?: boolean }): Promise<EggDispatch[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT ${dispatchCols} FROM egg_dispatches d JOIN customers c ON c.id = d.customer_id LEFT JOIN users u ON u.id = d.recorded_by
       WHERE d.organization_id = ? AND d.dispatch_date BETWEEN ? AND ? ${f.customerId ? 'AND d.customer_id = ?' : ''} ${f.unpaidOnly ? 'AND d.amount_paid < d.amount - 0.004' : ''}
       ORDER BY d.dispatch_date DESC, d.id DESC`
    )
    .all(...(f.customerId ? [ctx.org, f.from, f.to, f.customerId] : [ctx.org, f.from, f.to]))) as Omit<EggDispatch, 'balance' | 'paymentStatus'>[]
  return rows.map(toDispatch)
}

export async function listEggAdjustments(ctx: Pick<Ctx, 'db' | 'org'>, from: string, to: string): Promise<EggStoreAdjustment[]> {
  return (await ctx.db
    .prepare(
      `SELECT a.id, a.adj_date AS date, a.grade, a.quantity, a.reason, u.display_name AS recordedBy
       FROM egg_store_adjustments a LEFT JOIN users u ON u.id = a.recorded_by
       WHERE a.organization_id = ? AND a.adj_date BETWEEN ? AND ? ORDER BY a.adj_date DESC, a.id DESC`
    )
    .all(ctx.org, from, to)) as EggStoreAdjustment[]
}

export async function outstandingTotal(ctx: Pick<Ctx, 'db' | 'org'>): Promise<number> {
  const r = (await ctx.db.prepare('SELECT COALESCE(SUM(amount - amount_paid), 0) AS o FROM egg_dispatches WHERE organization_id = ?').get(ctx.org)) as { o: number }
  return round(r.o, 2)
}

/** Day-by-day egg store movement: collected in, dispatched out, money and closing stock. */
export async function salesSeries(ctx: Pick<Ctx, 'db' | 'org'>, from: string, to: string): Promise<SalesDay[]> {
  const coll = new Map(
    (
      (await ctx.db
        .prepare(
          `SELECT d.business_date AS date, SUM(e.good) AS good, SUM(e.damaged) AS cracked FROM egg_collections e
           JOIN farm_days d ON d.id = e.day_id WHERE e.organization_id = ? AND d.business_date BETWEEN ? AND ? GROUP BY d.business_date`
        )
        .all(ctx.org, from, to)) as { date: string; good: number; cracked: number }[]
    ).map((r) => [r.date, r])
  )
  const disp = new Map(
    (
      (await ctx.db
        .prepare(
          `SELECT dispatch_date AS date, SUM(good_qty) AS good, SUM(cracked_qty) AS cracked, SUM(amount) AS revenue
           FROM egg_dispatches WHERE organization_id = ? AND dispatch_date BETWEEN ? AND ? GROUP BY dispatch_date`
        )
        .all(ctx.org, from, to)) as { date: string; good: number; cracked: number; revenue: number }[]
    ).map((r) => [r.date, r])
  )
  const paid = new Map(
    (
      (await ctx.db
        .prepare(
          'SELECT payment_date AS date, SUM(amount) AS amount FROM customer_payments WHERE organization_id = ? AND payment_date BETWEEN ? AND ? GROUP BY payment_date'
        )
        .all(ctx.org, from, to)) as { date: string; amount: number }[]
    ).map((r) => [r.date, r.amount])
  )
  const adj = new Map(
    (
      (await ctx.db
        .prepare(
          `SELECT adj_date AS date, SUM(CASE WHEN grade='good' THEN quantity ELSE 0 END) AS good,
             SUM(CASE WHEN grade='cracked' THEN quantity ELSE 0 END) AS cracked FROM egg_store_adjustments
           WHERE organization_id = ? AND adj_date BETWEEN ? AND ? GROUP BY adj_date`
        )
        .all(ctx.org, from, to)) as { date: string; good: number; cracked: number }[]
    ).map((r) => [r.date, r])
  )
  const stock = await eggStock(ctx, addDays(from, -1))
  return dateRange(from, to).map((date) => {
    const c = coll.get(date)
    const d = disp.get(date)
    const a = adj.get(date)
    stock.good += (c?.good ?? 0) - (d?.good ?? 0) + (a?.good ?? 0)
    stock.cracked += (c?.cracked ?? 0) - (d?.cracked ?? 0) + (a?.cracked ?? 0)
    return {
      date,
      collectedGood: c?.good ?? 0,
      collectedCracked: c?.cracked ?? 0,
      dispatchedGood: d?.good ?? 0,
      dispatchedCracked: d?.cracked ?? 0,
      revenue: round(d?.revenue ?? 0, 2),
      received: round(paid.get(date) ?? 0, 2),
      stockGood: stock.good,
      stockCracked: stock.cracked
    }
  })
}
