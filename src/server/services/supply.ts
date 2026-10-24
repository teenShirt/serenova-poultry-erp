import { round } from '@shared/calc'
import { addDays, dateRange } from '@shared/dates'
import type { FlowSummary, PurchasesDay } from '@shared/types'
import type { Ctx } from '../context'
import { dailySeries } from './analytics'
import { eggStock, outstandingTotal } from './sales'

async function feedBalance(ctx: Pick<Ctx, 'db' | 'org'>, asOf: string): Promise<number> {
  const r = (await ctx.db
    .prepare(
      `SELECT COALESCE(SUM(t.quantity), 0) AS b FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id
       WHERE t.organization_id = ? AND i.category = 'feed' AND t.txn_date <= ?`
    )
    .get(ctx.org, asOf)) as { b: number }
  return round(r.b, 2)
}

/** Feed coming in from suppliers, going out to the cages, and the store balance — day by day. */
export async function purchasesSeries(ctx: Pick<Ctx, 'db' | 'org'>, from: string, to: string): Promise<PurchasesDay[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT t.txn_date AS date,
         SUM(CASE WHEN i.category = 'feed' AND t.type IN ('purchase','receipt') THEN t.quantity ELSE 0 END) AS feedIn,
         SUM(CASE WHEN t.type IN ('purchase','receipt') THEN t.quantity * COALESCE(t.unit_cost, 0) ELSE 0 END) AS cost,
         SUM(CASE WHEN i.category = 'feed' AND t.type IN ('issue','return') THEN -t.quantity ELSE 0 END) AS feedOut,
         SUM(CASE WHEN i.category = 'feed' THEN t.quantity ELSE 0 END) AS feedNet
       FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id
       WHERE t.organization_id = ? AND t.txn_date BETWEEN ? AND ? GROUP BY t.txn_date`
    )
    .all(ctx.org, from, to)) as { date: string; feedIn: number; cost: number; feedOut: number; feedNet: number }[]
  const byDate = new Map(rows.map((r) => [r.date, r]))
  let stock = await feedBalance(ctx, addDays(from, -1))
  return dateRange(from, to).map((date) => {
    const r = byDate.get(date)
    stock = round(stock + (r?.feedNet ?? 0), 2)
    return { date, feedKg: round(r?.feedIn ?? 0, 2), cost: round(r?.cost ?? 0, 2), feedIssuedKg: round(r?.feedOut ?? 0, 2), feedStockKg: stock }
  })
}

/**
 * The whole farm chain for a period: feed received → store → issued to cages → eaten,
 * hens, eggs collected → egg store → dispatched to customers → money.
 */
export async function flowSummary(ctx: Ctx, from: string, to: string): Promise<FlowSummary> {
  const p = await purchasesSeries(ctx, from, to)
  const series = await dailySeries(ctx, from, to)
  const recorded = series.filter((s) => s.status !== 'not_started')
  const consumed = recorded.map((s) => s.feedKg).filter((x): x is number => x !== null)
  const openGood = await eggStock(ctx, addDays(from, -1))
  const closeGood = await eggStock(ctx, to)
  const disp = (await ctx.db
    .prepare(
      'SELECT COALESCE(SUM(good_qty), 0) AS good, COALESCE(SUM(cracked_qty), 0) AS cracked, COALESCE(SUM(amount), 0) AS amount FROM egg_dispatches WHERE organization_id = ? AND dispatch_date BETWEEN ? AND ?'
    )
    .get(ctx.org, from, to)) as { good: number; cracked: number; amount: number }
  const paid = (await ctx.db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS a FROM customer_payments WHERE organization_id = ? AND payment_date BETWEEN ? AND ?')
    .get(ctx.org, from, to)) as { a: number }
  const topCustomers = (await ctx.db
    .prepare(
      `SELECT c.name, SUM(d.good_qty + d.cracked_qty) AS eggs, SUM(d.amount) AS amount FROM egg_dispatches d JOIN customers c ON c.id = d.customer_id
       WHERE d.organization_id = ? AND d.dispatch_date BETWEEN ? AND ? GROUP BY c.id ORDER BY amount DESC LIMIT 5`
    )
    .all(ctx.org, from, to)) as FlowSummary['topCustomers']
  const topSuppliers = (await ctx.db
    .prepare(
      `SELECT COALESCE(s.name, '—') AS name, SUM(l.quantity) AS quantity, SUM(l.quantity * COALESCE(l.unit_cost, 0)) AS cost
       FROM goods_receipt_lines l JOIN goods_receipts g ON g.id = l.receipt_id LEFT JOIN suppliers s ON s.id = g.supplier_id
       WHERE g.organization_id = ? AND g.receipt_date BETWEEN ? AND ? GROUP BY g.supplier_id, s.name ORDER BY cost DESC LIMIT 5`
    )
    .all(ctx.org, from, to)) as FlowSummary['topSuppliers']
  const sum = (f: (s: (typeof recorded)[number]) => number) => recorded.reduce((a, s) => a + f(s), 0)
  return {
    from,
    to,
    feed: {
      openingKg: await feedBalance(ctx, addDays(from, -1)),
      receivedKg: round(
        p.reduce((a, d) => a + d.feedKg, 0),
        2
      ),
      issuedKg: round(
        p.reduce((a, d) => a + d.feedIssuedKg, 0),
        2
      ),
      consumedKg: consumed.length
        ? round(
            consumed.reduce((a, b) => a + b, 0),
            2
          )
        : null,
      closingKg: await feedBalance(ctx, to),
      purchaseCost: round(
        p.reduce((a, d) => a + d.cost, 0),
        2
      )
    },
    eggs: {
      collected: sum((s) => s.eggs),
      good: sum((s) => s.good),
      cracked: sum((s) => s.damaged),
      rejected: sum((s) => s.rejected),
      dispatchedGood: disp.good,
      dispatchedCracked: disp.cracked,
      openingGood: openGood.good,
      closingGood: closeGood.good,
      openingCracked: openGood.cracked,
      closingCracked: closeGood.cracked
    },
    money: {
      sales: round(disp.amount, 2),
      received: round(paid.a, 2),
      outstanding: await outstandingTotal(ctx),
      purchases: round(
        p.reduce((a, d) => a + d.cost, 0),
        2
      )
    },
    hens: {
      opening: recorded.length ? recorded[0].opening : null,
      closing: recorded.length ? recorded[recorded.length - 1].closing : null,
      deaths: sum((s) => s.deaths)
    },
    topCustomers: topCustomers.map((c) => ({ ...c, amount: round(c.amount, 2) })),
    topSuppliers: topSuppliers.map((s) => ({ ...s, quantity: round(s.quantity, 2), cost: round(s.cost, 2) }))
  }
}
