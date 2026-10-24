import {
  averageHens,
  closingHens,
  emptyMovements,
  feedConsumption,
  mortalityPercent,
  productionPercent,
  round
} from '@shared/calc'
import type { CageDaySummary, DayStatus, EggSession, FarmSettings, MovementTotals } from '@shared/types'
import type { Ctx } from '../context'

/**
 * One row per (day, cage) computed from the stored records. This is the single source
 * of truth for every figure shown on the dashboard, close review, analytics and reports.
 */
export interface CageDayStat extends CageDaySummary {
  date: string
  dayId: number
  dayStatus: 'in_progress' | 'closed'
}

const movementKey: Record<string, keyof MovementTotals> = {
  death: 'deaths',
  removal: 'removals',
  addition: 'additions',
  transfer_in: 'transfersIn',
  transfer_out: 'transfersOut'
}

export async function loadCageDayStats(
  ctx: Pick<Ctx, 'db' | 'org' | 'farm'>,
  settings: Pick<FarmSettings, 'productionDenominator' | 'mortalityDenominator'>,
  from: string,
  to: string,
  cageId?: number | null
): Promise<CageDayStat[]> {
  const cageFilter = cageId ? 'AND cd.cage_id = ?' : ''
  const db = ctx.db
  const params = cageId ? [ctx.org, ctx.farm, from, to, cageId] : [ctx.org, ctx.farm, from, to]

  const base = (await db
    .prepare(
      `SELECT d.id AS dayId, d.business_date AS date, d.status, cd.cage_id AS cageId, c.code, c.name,
              cd.carried_hens AS carried, cd.opening_adjustment AS adjustment,
              cd.opening_adjustment_reason AS adjustmentReason, cd.mortality_confirmed AS mortalityConfirmed
       FROM farm_days d
       JOIN cage_days cd ON cd.day_id = d.id
       JOIN cages c ON c.id = cd.cage_id
       WHERE d.organization_id = ? AND d.farm_id = ? AND d.business_date BETWEEN ? AND ? ${cageFilter}
       ORDER BY d.business_date, c.sort_order, c.code`
    )
    .all(...params)) as {
    dayId: number
    date: string
    status: 'in_progress' | 'closed'
    cageId: number
    code: string
    name: string
    carried: number
    adjustment: number
    adjustmentReason: string | null
    mortalityConfirmed: number
  }[]
  if (base.length === 0) return []

  const key = (dayId: number, cageId: number) => `${dayId}:${cageId}`
  const rangeJoin = `JOIN farm_days d ON d.id = x.day_id WHERE d.organization_id = ? AND d.farm_id = ? AND d.business_date BETWEEN ? AND ? ${
    cageId ? 'AND x.cage_id = ?' : ''
  }`

  const moves = new Map<string, MovementTotals>()
  for (const m of (await db
    .prepare(`SELECT x.day_id, x.cage_id, x.type, SUM(x.quantity) AS q FROM flock_movements x ${rangeJoin}
              GROUP BY x.day_id, x.cage_id, x.type`)
    .all(...params)) as { day_id: number; cage_id: number; type: string; q: number }[]) {
    const k = key(m.day_id, m.cage_id)
    const t = moves.get(k) ?? emptyMovements()
    t[movementKey[m.type]] += m.q
    moves.set(k, t)
  }

  const eggs = new Map<string, { good: number; damaged: number; rejected: number; sessions: EggSession[] }>()
  for (const e of (await db
    .prepare(`SELECT x.day_id, x.cage_id, x.session, x.good, x.damaged, x.rejected FROM egg_collections x ${rangeJoin}`)
    .all(...params)) as { day_id: number; cage_id: number; session: EggSession; good: number; damaged: number; rejected: number }[]) {
    const k = key(e.day_id, e.cage_id)
    const t = eggs.get(k) ?? { good: 0, damaged: 0, rejected: 0, sessions: [] }
    t.good += e.good
    t.damaged += e.damaged
    t.rejected += e.rejected
    t.sessions.push(e.session)
    eggs.set(k, t)
  }

  const feed = new Map<string, CageDaySummary['feed']>()
  for (const f of (await db
    .prepare(
      `SELECT x.day_id, x.cage_id, x.opening_stock, x.issued, x.returned, x.wasted, x.measured_consumption,
              x.closing_stock FROM feed_records x ${rangeJoin}`
    )
    .all(...params)) as {
    day_id: number
    cage_id: number
    opening_stock: number | null
    issued: number
    returned: number
    wasted: number
    measured_consumption: number | null
    closing_stock: number | null
  }[]) {
    const k = key(f.day_id, f.cage_id)
    const t = feed.get(k) ?? { consumption: null, isEstimate: false, issued: 0, wasted: 0, records: 0, hasError: false }
    const r = feedConsumption({
      openingStock: f.opening_stock,
      issued: f.issued,
      returned: f.returned,
      wasted: f.wasted,
      measuredConsumption: f.measured_consumption,
      closingStock: f.closing_stock
    })
    t.records++
    t.issued = round(t.issued + f.issued - f.returned, 3)
    t.wasted = round(t.wasted + f.wasted, 3)
    if (r.consumption !== null) t.consumption = round((t.consumption ?? 0) + r.consumption, 3)
    if (r.isEstimate) t.isEstimate = true
    if (r.error) t.hasError = true
    feed.set(k, t)
  }

  const water = new Map<string, number | null>()
  for (const w of (await db
    .prepare(`SELECT x.day_id, x.cage_id, x.litres FROM water_records x ${rangeJoin}`)
    .all(...params)) as { day_id: number; cage_id: number; litres: number | null }[]) {
    water.set(key(w.day_id, w.cage_id), w.litres)
  }

  const meds = new Map<string, number>()
  for (const t of (await db
    .prepare(`SELECT x.day_id, x.cage_id, COUNT(*) AS n FROM medicine_treatments x ${rangeJoin} GROUP BY x.day_id, x.cage_id`)
    .all(...params)) as { day_id: number; cage_id: number | null; n: number }[]) {
    if (t.cage_id !== null) meds.set(key(t.day_id, t.cage_id), t.n)
  }

  return base.map((b) => {
    const k = key(b.dayId, b.cageId)
    const m = moves.get(k) ?? emptyMovements()
    const opening = b.carried + b.adjustment
    const closing = closingHens(opening, m)
    const e = eggs.get(k) ?? { good: 0, damaged: 0, rejected: 0, sessions: [] }
    const collected = e.good + e.damaged + e.rejected
    return {
      date: b.date,
      dayId: b.dayId,
      dayStatus: b.status,
      cageId: b.cageId,
      code: b.code,
      name: b.name,
      carried: b.carried,
      adjustment: b.adjustment,
      adjustmentReason: b.adjustmentReason,
      opening,
      movements: m,
      closing,
      avgHens: averageHens(opening, closing),
      eggs: { ...e, collected, saleable: e.good },
      productionPct: productionPercent(collected, opening, closing, settings.productionDenominator),
      feed: feed.get(k) ?? { consumption: null, isEstimate: false, issued: 0, wasted: 0, records: 0, hasError: false },
      water: { litres: water.has(k) ? (water.get(k) ?? null) : null, recorded: water.has(k) },
      medicineUses: meds.get(k) ?? 0,
      mortalityPct: mortalityPercent(m.deaths, opening, closing, settings.mortalityDenominator),
      mortalityConfirmed: !!b.mortalityConfirmed
    }
  })
}

export interface FarmDayStat {
  date: string
  dayId: number
  status: DayStatus
  opening: number
  closing: number
  avgHens: number
  movements: MovementTotals
  good: number
  damaged: number
  rejected: number
  collected: number
  productionPct: number | null
  feedKg: number | null
  feedIsEstimate: boolean
  waterLitres: number | null
  medicineUses: number
  mortalityPct: number | null
}

/** Sums cage rows into farm totals. Unknown (null) cage values stay unknown unless at least one cage reported. */
export function sumCages(
  rows: CageDaySummary[],
  settings: Pick<FarmSettings, 'productionDenominator' | 'mortalityDenominator'>
) {
  const movements = emptyMovements()
  let opening = 0
  let closing = 0
  let good = 0
  let damaged = 0
  let rejected = 0
  let feedKg: number | null = null
  let feedIsEstimate = false
  let waterLitres: number | null = null
  let medicineUses = 0
  for (const r of rows) {
    opening += r.opening
    closing += r.closing
    for (const k of Object.keys(movements) as (keyof MovementTotals)[]) movements[k] += r.movements[k]
    good += r.eggs.good
    damaged += r.eggs.damaged
    rejected += r.eggs.rejected
    if (r.feed.consumption !== null) feedKg = round((feedKg ?? 0) + r.feed.consumption, 3)
    if (r.feed.isEstimate) feedIsEstimate = true
    if (r.water.litres !== null) waterLitres = round((waterLitres ?? 0) + r.water.litres, 2)
    medicineUses += r.medicineUses
  }
  const collected = good + damaged + rejected
  return {
    opening,
    closing,
    avgHens: averageHens(opening, closing),
    movements,
    eggs: { good, damaged, rejected, collected, saleable: good },
    productionPct: productionPercent(collected, opening, closing, settings.productionDenominator),
    feedKg,
    feedIsEstimate,
    waterLitres,
    medicineUses,
    mortalityPct: mortalityPercent(movements.deaths, opening, closing, settings.mortalityDenominator)
  }
}

export function groupByDay(rows: CageDayStat[]): Map<string, CageDayStat[]> {
  const m = new Map<string, CageDayStat[]>()
  for (const r of rows) {
    const list = m.get(r.date) ?? []
    list.push(r)
    m.set(r.date, list)
  }
  return m
}
