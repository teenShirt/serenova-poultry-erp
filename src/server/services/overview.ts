import { round } from '@shared/calc'
import { dateRange } from '@shared/dates'
import type { FarmOverviewRow, MovementPage, OrganizationOverview } from '@shared/overview'
import type { Ctx } from '../context'
import { assert } from '../errors'
import { dailySeries } from './analytics'
import { farmToday, latestDay } from './days'
import { listFlocks, remindersFor } from './flocks'
import { listBatches } from './inventory'
import { getSettings } from './settings'
import { loadCageDayStats } from './stats'
import { storeBalances } from './stores'

/**
 * The organization overview: the same figures for each active farm over a period, and their
 * totals. Definitions are in src/shared/overview.ts; production figures use closed days only.
 */
export async function organizationOverview(ctx: Ctx, from: string, to: string): Promise<OrganizationOverview> {
  const farms = (await ctx.db.prepare("SELECT id, name FROM farms WHERE organization_id = ? AND status = 'active' ORDER BY id").all(ctx.org)) as {
    id: number
    name: string
  }[]
  const settings = await getSettings(ctx)
  const today = await farmToday(ctx)
  const rows: FarmOverviewRow[] = []
  const trend = new Map<string, Record<string, number | null>>(dateRange(from, to).map((d) => [d, {}]))
  const stockAlerts: OrganizationOverview['stockAlerts'] = []
  const expiring: OrganizationOverview['expiring'] = []
  const reminders: OrganizationOverview['reminders'] = []
  let firstOpeningTotal = 0
  let birdDaysAll = 0
  /** Bird-days of the farms that recorded feed: feed per bird is never spread over farms that did not. */
  let birdDaysFed = 0

  for (const farm of farms) {
    const fctx: Ctx = { ...ctx, farm: farm.id }
    const series = await dailySeries(fctx, from, to)
    const closed = series.filter((p) => p.status === 'closed')
    const birdDays = closed.reduce((s, p) => s + (p.opening + p.closing) / 2, 0)
    const eggs = closed.reduce((s, p) => s + p.eggs, 0)
    const deaths = closed.reduce((s, p) => s + p.deaths, 0)
    const feedKg = round(
      closed.reduce((s, p) => s + (p.feedKg ?? 0), 0),
      2
    )
    const firstOpening = closed[0]?.opening ?? 0
    firstOpeningTotal += firstOpening
    birdDaysAll += birdDays
    if (feedKg > 0) birdDaysFed += birdDays
    for (const p of series) trend.get(p.date)![String(farm.id)] = p.status === 'closed' ? p.eggs : null

    // Birds now: the latest day's closing counts (the cages' starting counts before any day).
    let birdsNow = (
      (await ctx.db.prepare('SELECT COALESCE(SUM(initial_hens), 0) AS n FROM cages WHERE farm_id = ? AND active = 1').get(farm.id)) as { n: number }
    ).n
    const latest = await latestDay(fctx)
    if (latest) birdsNow = (await loadCageDayStats(fctx, settings, latest.date, latest.date)).reduce((s, r) => s + r.closing, 0)

    const flocks = await listFlocks(fctx, false)
    const due = (await remindersFor(fctx, flocks, 0)).filter((r) => r.state === 'due' || r.state === 'overdue')
    for (const r of due)
      reminders.push({ farmName: farm.name, flockCode: r.flockCode, title: r.title, atWeek: r.atWeek, state: r.state as 'due' | 'overdue', dueOn: r.dueOn })

    const stock = await storeBalances(fctx)
    const alerted = new Set<number>()
    for (const b of stock) {
      if ((b.isLow || b.needsReorder) && !alerted.has(b.itemId)) {
        alerted.add(b.itemId)
        stockAlerts.push({
          farmName: farm.name,
          warehouseName: b.warehouseName,
          item: b.itemName,
          balance: b.balance,
          unit: b.unit,
          kind: b.isLow ? 'low' : 'reorder'
        })
      }
    }
    const exp = (await listBatches(fctx, { onlyInStock: true, farmId: farm.id })).filter(
      (b) => b.daysToExpiry !== null && b.daysToExpiry <= settings.medicineExpiryWarnDays
    )
    for (const b of exp)
      expiring.push({
        farmName: farm.name,
        item: b.itemName,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate!,
        daysToExpiry: b.daysToExpiry!,
        balance: b.balance,
        unit: b.unit
      })

    const tasks = (await ctx.db
      .prepare(
        `SELECT SUM(due_date BETWEEN ? AND ?) AS due, SUM(due_date < ?) AS overdue FROM tasks
         WHERE organization_id = ? AND farm_id = ? AND status IN ('pending','in_progress')`
      )
      .get(today, today, today, ctx.org, farm.id)) as { due: number | null; overdue: number | null }

    rows.push({
      farmId: farm.id,
      farmName: farm.name,
      closedDays: closed.length,
      openDays: series.filter((p) => p.status === 'in_progress').length,
      birdsNow,
      eggs,
      layingPct: birdDays > 0 ? round((eggs / birdDays) * 100, 1) : null,
      deaths,
      culls: closed.reduce((s, p) => s + p.removals, 0),
      mortalityPct: firstOpening > 0 ? round((deaths / firstOpening) * 100, 2) : null,
      feedKg,
      waterLitres: round(
        closed.reduce((s, p) => s + (p.waterLitres ?? 0), 0),
        1
      ),
      feedPerBirdG: birdDays > 0 && feedKg > 0 ? round((feedKg * 1000) / birdDays, 1) : null,
      activeFlocks: flocks.length,
      tasksDue: Number(tasks.due ?? 0),
      tasksOverdue: Number(tasks.overdue ?? 0),
      remindersDue: due.length,
      lowStockItems: alerted.size,
      expiringBatches: exp.length
    })
  }

  // Totals: sums, and rates worked out again from the summed parts (never an average of percentages).
  const sum = (k: keyof FarmOverviewRow) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)
  const feedAll = sum('feedKg')
  const deathsAll = sum('deaths')
  const totals = {
    closedDays: sum('closedDays'),
    openDays: sum('openDays'),
    birdsNow: sum('birdsNow'),
    eggs: sum('eggs'),
    layingPct: birdDaysAll > 0 ? round((sum('eggs') / birdDaysAll) * 100, 1) : null,
    deaths: deathsAll,
    culls: sum('culls'),
    mortalityPct: firstOpeningTotal > 0 ? round((deathsAll / firstOpeningTotal) * 100, 2) : null,
    feedKg: round(feedAll, 2),
    waterLitres: round(sum('waterLitres'), 1),
    feedPerBirdG: birdDaysFed > 0 && feedAll > 0 ? round((feedAll * 1000) / birdDaysFed, 1) : null,
    activeFlocks: sum('activeFlocks'),
    tasksDue: sum('tasksDue'),
    tasksOverdue: sum('tasksOverdue'),
    remindersDue: sum('remindersDue'),
    lowStockItems: sum('lowStockItems'),
    expiringBatches: sum('expiringBatches')
  }

  const recentReceipts = (await ctx.db
    .prepare(
      `SELECT g.grn_no AS grnNo, g.receipt_date AS date, s.name AS supplier, w.name AS store, g.status,
         COALESCE((SELECT SUM((l.quantity - l.rejected_qty - l.damaged_qty) * COALESCE(l.unit_cost, 0)) FROM goods_receipt_lines l WHERE l.receipt_id = g.id), 0) AS total
       FROM goods_receipts g JOIN warehouses w ON w.id = g.warehouse_id LEFT JOIN suppliers s ON s.id = g.supplier_id
       WHERE g.organization_id = ? ORDER BY g.receipt_date DESC, g.id DESC LIMIT 8`
    )
    .all(ctx.org)) as OrganizationOverview['recentReceipts']
  const recentMovements = (await ctx.db
    .prepare(
      `SELECT t.txn_date AS date, w.name AS store, i.name AS item, t.type, t.quantity, i.unit, u.display_name AS \`by\`
       FROM inventory_transactions t JOIN warehouses w ON w.id = t.warehouse_id JOIN inventory_items i ON i.id = t.item_id
       LEFT JOIN users u ON u.id = t.recorded_by WHERE t.organization_id = ? ORDER BY t.id DESC LIMIT 12`
    )
    .all(ctx.org)) as OrganizationOverview['recentMovements']

  return {
    from,
    to,
    farms: rows,
    totals,
    trend: [...trend.entries()].map(([date, v]) => ({ date, ...v })),
    stockAlerts,
    expiring: expiring.sort((a, b) => a.daysToExpiry - b.daysToExpiry),
    reminders,
    recentReceipts: recentReceipts.map((r) => ({ ...r, total: round(Number(r.total), 2) })),
    recentMovements
  }
}

/** Stock movements in the farm's stores (or one store), newest first, a page at a time. */
export async function movementsPage(
  ctx: Ctx,
  f: { from: string; to: string; warehouseId?: number | null; itemId?: number | null; type?: string | null; page: number; pageSize?: number }
): Promise<MovementPage> {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 10), 500)
  assert(f.page >= 1, 'invalid_input', { field: 'page' })
  const where = ['t.organization_id = ?', 'w.farm_id = ?', 't.txn_date BETWEEN ? AND ?']
  const args: unknown[] = [ctx.org, ctx.farm, f.from, f.to]
  if (f.warehouseId) {
    where.push('t.warehouse_id = ?')
    args.push(f.warehouseId)
  }
  if (f.itemId) {
    where.push('t.item_id = ?')
    args.push(f.itemId)
  }
  if (f.type) {
    where.push('t.type = ?')
    args.push(f.type)
  }
  const sqlWhere = where.join(' AND ')
  const total = (
    (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM inventory_transactions t JOIN warehouses w ON w.id = t.warehouse_id WHERE ${sqlWhere}`).get(...args)) as {
      n: number
    }
  ).n
  const rows = (await ctx.db
    .prepare(
      `SELECT t.id, t.txn_date AS date, w.name AS store, cw.name AS counterpart, i.name AS item, b.batch_no AS batchNo, t.type, t.quantity, i.unit,
         t.reference, t.notes, u.display_name AS \`by\`
       FROM inventory_transactions t JOIN warehouses w ON w.id = t.warehouse_id LEFT JOIN warehouses cw ON cw.id = t.counterpart_warehouse_id
       JOIN inventory_items i ON i.id = t.item_id LEFT JOIN inventory_batches b ON b.id = t.batch_id LEFT JOIN users u ON u.id = t.recorded_by
       WHERE ${sqlWhere} ORDER BY t.txn_date DESC, t.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, (f.page - 1) * pageSize)) as MovementPage['rows']
  return { rows, total, page: f.page, pageSize }
}
