import { feedPerHenGrams, mortalityPercent, round } from '@shared/calc'
import { addDays, dateRange } from '@shared/dates'
import type { Alert, CageComparisonRow, DailySeriesPoint, DashboardData } from '@shared/types'
import type { Ctx } from '../context'
import { getOverview } from './days'
import { balances, listBatches } from './inventory'
import { getSettings } from './settings'
import { groupByDay, loadCageDayStats, sumCages } from './stats'

/** One point per calendar date in the range; dates without a farm day carry nulls (gaps, not zeros). */
export async function dailySeries(ctx: Ctx, from: string, to: string, cageId?: number | null): Promise<DailySeriesPoint[]> {
  const settings = await getSettings(ctx)
  const byDay = groupByDay(await loadCageDayStats(ctx.db, settings, from, to, cageId))
  let cumulative = 0
  return dateRange(from, to).map((date) => {
    const rows = byDay.get(date)
    if (!rows) {
      return {
        date,
        status: 'not_started',
        opening: 0,
        closing: 0,
        eggs: 0,
        good: 0,
        damaged: 0,
        rejected: 0,
        productionPct: null,
        feedKg: null,
        waterLitres: null,
        deaths: 0,
        cumulativeDeaths: cumulative,
        mortalityPct: null,
        feedPerHenG: null
      }
    }
    const t = sumCages(rows, settings)
    cumulative += t.movements.deaths
    return {
      date,
      status: rows[0].dayStatus,
      opening: t.opening,
      closing: t.closing,
      eggs: t.eggs.collected,
      good: t.eggs.good,
      damaged: t.eggs.damaged,
      rejected: t.eggs.rejected,
      productionPct: t.productionPct,
      feedKg: t.feedKg,
      waterLitres: t.waterLitres,
      deaths: t.movements.deaths,
      cumulativeDeaths: cumulative,
      mortalityPct: t.mortalityPct,
      feedPerHenG: feedPerHenGrams(t.feedKg, t.avgHens)
    }
  })
}

export async function cageComparison(ctx: Ctx, from: string, to: string): Promise<CageComparisonRow[]> {
  const settings = await getSettings(ctx)
  const rows = await loadCageDayStats(ctx.db, settings, from, to)
  const map = new Map<number, CageComparisonRow & { prodSum: number; prodN: number; firstOpening: number | null }>()
  for (const r of rows) {
    const m = map.get(r.cageId) ?? {
      cageId: r.cageId,
      code: r.code,
      name: r.name,
      eggs: 0,
      good: 0,
      damaged: 0,
      rejected: 0,
      avgProductionPct: null,
      feedKg: null,
      waterLitres: null,
      deaths: 0,
      closingHens: null,
      mortalityPct: null,
      prodSum: 0,
      prodN: 0,
      firstOpening: null
    }
    m.eggs += r.eggs.collected
    m.good += r.eggs.good
    m.damaged += r.eggs.damaged
    m.rejected += r.eggs.rejected
    if (r.productionPct !== null) {
      m.prodSum += r.productionPct
      m.prodN++
    }
    if (r.feed.consumption !== null) m.feedKg = round((m.feedKg ?? 0) + r.feed.consumption, 3)
    if (r.water.litres !== null) m.waterLitres = round((m.waterLitres ?? 0) + r.water.litres, 2)
    m.deaths += r.movements.deaths
    m.closingHens = r.closing // rows are date-ordered, so the last one wins
    if (m.firstOpening === null) m.firstOpening = r.opening
    map.set(r.cageId, m)
  }
  return [...map.values()].map(({ prodSum, prodN, firstOpening, ...m }) => ({
    ...m,
    avgProductionPct: prodN ? round(prodSum / prodN, 2) : null,
    // Cumulative mortality over the period: deaths / hens at the start of the period
    mortalityPct: firstOpening ? mortalityPercent(m.deaths, firstOpening, firstOpening, 'opening') : null
  }))
}

export async function dashboard(ctx: Ctx, date: string, isDemo: boolean, backupWarning: string | null): Promise<DashboardData> {
  const settings = await getSettings(ctx)
  const today = await getOverview(ctx, date)
  const inv = await balances(ctx)
  const lowStock = inv.filter((b) => b.active && b.isLow)
  const expiring = (await listBatches(ctx, { onlyInStock: true })).filter(
    (b) => b.daysToExpiry !== null && b.daysToExpiry <= settings.medicineExpiryWarnDays
  )
  const alerts: Alert[] = []
  if (today.status === 'not_started') alerts.push({ code: 'day_not_started', severity: 'warning', params: { date } })
  if (today.previousDay && today.previousDay.status !== 'closed') {
    alerts.push({ code: 'previous_day_open', severity: 'warning', params: { date: today.previousDay.date } })
  }
  for (const i of today.issues) {
    if (['high_mortality', 'production_drop', 'water_change', 'negative_stock', 'feed_inconsistent', 'transfer_mismatch'].includes(i.code)) {
      const cage = today.cages.find((c) => c.cageId === i.cageId)
      alerts.push({ code: i.code, severity: i.severity, params: { ...i.params, cage: cage?.name ?? '' } })
    }
  }
  for (const b of lowStock) alerts.push({ code: 'low_stock', severity: 'warning', params: { item: b.name, balance: b.balance, unit: b.unit } })
  for (const b of inv.filter((x) => x.balance < 0)) {
    alerts.push({ code: 'negative_stock', severity: 'error', params: { item: b.name, balance: b.balance, unit: b.unit } })
  }
  for (const b of expiring) {
    alerts.push({
      code: (b.daysToExpiry ?? 0) < 0 ? 'medicine_expired' : 'medicine_expiring',
      severity: (b.daysToExpiry ?? 0) < 0 ? 'error' : 'warning',
      params: { item: b.itemName, batch: b.batchNo, date: b.expiryDate ?? '', days: b.daysToExpiry ?? 0 }
    })
  }
  if (backupWarning) alerts.push({ code: 'backup_failed', severity: 'error', params: { message: backupWarning } })
  return {
    date,
    today,
    inventory: {
      feedKg: round(inv.filter((b) => b.category === 'feed').reduce((s, b) => s + b.balance, 0), 2),
      medicineItems: inv.filter((b) => b.category === 'medicine' && b.balance > 0).length,
      lowStock,
      expiring
    },
    alerts,
    isDemo
  }
}

export function defaultRange(date: string, days: number) {
  return { from: addDays(date, -(days - 1)), to: date }
}
