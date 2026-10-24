/**
 * Pure farm calculations. No I/O. Every figure the app displays is derived
 * from these functions so the rules are defined (and tested) in one place.
 *
 * Unknown values are represented as `null` and propagate as `null`;
 * they are never silently replaced with zero.
 */

export type ProductionDenominator = 'average' | 'opening' | 'closing'
export type MortalityDenominator = 'opening' | 'average'

export interface FlockMovementTotals {
  deaths: number
  removals: number
  additions: number
  transfersIn: number
  transfersOut: number
}

export const emptyMovements = (): FlockMovementTotals => ({
  deaths: 0,
  removals: 0,
  additions: 0,
  transfersIn: 0,
  transfersOut: 0
})

/** Closing hens = Opening + Additions + Transfers in − Transfers out − Deaths − Other removals */
export function closingHens(opening: number, m: FlockMovementTotals): number {
  return opening + m.additions + m.transfersIn - m.transfersOut - m.deaths - m.removals
}

/** Average live hens for the day: (opening + closing) / 2 */
export function averageHens(opening: number, closing: number): number {
  return (opening + closing) / 2
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round((value + Number.EPSILON) * f) / f
}

export function henDenominator(method: ProductionDenominator | MortalityDenominator, opening: number, closing: number): number {
  if (method === 'opening') return opening
  if (method === 'closing') return closing
  return averageHens(opening, closing)
}

/**
 * Egg production % = total eggs collected / hens (per configured denominator) × 100.
 * Default denominator is the average of opening and closing live hens.
 * Returns null when there are no hens (production is undefined, not zero).
 */
export function productionPercent(totalEggs: number, opening: number, closing: number, method: ProductionDenominator = 'average'): number | null {
  const d = henDenominator(method, opening, closing)
  if (!(d > 0)) return null
  return round((totalEggs / d) * 100, 2)
}

/** Mortality % = deaths / hens (default: opening hens) × 100. */
export function mortalityPercent(deaths: number, opening: number, closing: number, method: MortalityDenominator = 'opening'): number | null {
  const d = henDenominator(method, opening, closing)
  if (!(d > 0)) return null
  return round((deaths / d) * 100, 3)
}

export interface EggCounts {
  good: number
  damaged: number
  rejected: number
}

export function eggTotals(rows: EggCounts[]) {
  const good = rows.reduce((s, r) => s + r.good, 0)
  const damaged = rows.reduce((s, r) => s + r.damaged, 0)
  const rejected = rows.reduce((s, r) => s + r.rejected, 0)
  return { good, damaged, rejected, collected: good + damaged + rejected, saleable: good }
}

export type FeedMethod = 'measured' | 'stock_balance' | 'estimate'

export interface FeedInput {
  openingStock: number | null
  issued: number
  returned: number
  wasted: number
  measuredConsumption: number | null
  closingStock: number | null
}

export interface FeedResult {
  consumption: number | null
  method: FeedMethod | null
  isEstimate: boolean
  error: string | null
}

/**
 * Feed consumption, using the best information available:
 *  1. measured   – the farm weighed actual consumption: used as-is.
 *  2. stock_balance – opening + issued − returned − wasted − closing (cage stock counted).
 *  3. estimate   – issued − returned − wasted (no closing count; shown as an estimate).
 * Wastage is always excluded from consumption because spilled feed was not eaten.
 */
export function feedConsumption(f: FeedInput): FeedResult {
  if (f.issued < 0 || f.returned < 0 || f.wasted < 0) {
    return { consumption: null, method: null, isEstimate: false, error: 'negative_quantity' }
  }
  if (f.measuredConsumption !== null) {
    if (f.measuredConsumption < 0) {
      return { consumption: null, method: null, isEstimate: false, error: 'negative_quantity' }
    }
    return { consumption: round(f.measuredConsumption, 3), method: 'measured', isEstimate: false, error: null }
  }
  if (f.openingStock !== null && f.closingStock !== null) {
    const c = f.openingStock + f.issued - f.returned - f.wasted - f.closingStock
    if (c < -1e-9) return { consumption: null, method: 'stock_balance', isEstimate: false, error: 'stock_imbalance' }
    return { consumption: round(c, 3), method: 'stock_balance', isEstimate: false, error: null }
  }
  if (f.issued === 0 && f.returned === 0 && f.wasted === 0) {
    return { consumption: null, method: null, isEstimate: false, error: null }
  }
  const c = f.issued - f.returned - f.wasted
  if (c < -1e-9) return { consumption: null, method: 'estimate', isEstimate: true, error: 'returned_exceeds_issued' }
  return { consumption: round(c, 3), method: 'estimate', isEstimate: true, error: null }
}

/** Closing stock at the cage when it was not counted: opening + issued − returned − wasted − consumption. */
export function expectedClosingFeed(f: FeedInput, consumption: number | null): number | null {
  if (f.openingStock === null || consumption === null) return null
  return round(f.openingStock + f.issued - f.returned - f.wasted - consumption, 3)
}

/** Grams of feed per hen per day. */
export function feedPerHenGrams(consumptionKg: number | null, avgHens: number): number | null {
  if (consumptionKg === null || !(avgHens > 0)) return null
  return round((consumptionKg * 1000) / avgHens, 1)
}

export interface WaterInput {
  method: 'meter' | 'manual'
  openingReading: number | null
  closingReading: number | null
  litres: number | null
  meterReset: boolean
}

export interface WaterResult {
  litres: number | null
  error: string | null
}

/**
 * Meter: litres = closing − opening. A closing reading below the opening reading is
 * rejected unless an authorised meter reset/replacement is recorded, in which case the
 * litres must be entered manually.
 */
export function waterConsumption(w: WaterInput): WaterResult {
  if (w.method === 'manual' || w.meterReset) {
    if (w.litres === null) return { litres: null, error: w.meterReset ? 'litres_required_after_reset' : null }
    if (w.litres < 0) return { litres: null, error: 'negative_quantity' }
    return { litres: round(w.litres, 2), error: null }
  }
  if (w.openingReading === null || w.closingReading === null) return { litres: null, error: null }
  if (w.closingReading < w.openingReading) return { litres: null, error: 'closing_below_opening' }
  return { litres: round(w.closingReading - w.openingReading, 2), error: null }
}

/** Relative change (%) of value against baseline; null when the baseline is unknown or zero. */
export function percentChange(value: number | null, baseline: number | null): number | null {
  if (value === null || baseline === null || baseline === 0) return null
  return round(((value - baseline) / baseline) * 100, 1)
}

export function mean(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x))
  if (v.length === 0) return null
  return v.reduce((s, x) => s + x, 0) / v.length
}

/** Production drop alert: today's production is more than `thresholdPct` (relative) below the baseline. */
export function isProductionDrop(today: number | null, baseline: number | null, thresholdPct: number): boolean {
  const ch = percentChange(today, baseline)
  return ch !== null && ch <= -Math.abs(thresholdPct)
}
