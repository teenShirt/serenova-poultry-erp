import { describe, expect, it } from 'vitest'
import { closingHens, eggTotals, feedConsumption, feedPerHenGrams, isProductionDrop, mortalityPercent, productionPercent, waterConsumption } from '@shared/calc'
import { addDays, daysBetween, isIsoDate, monthBounds, startOfWeek, todayInTimezone } from '@shared/dates'

describe('flock reconciliation', () => {
  it('closing = opening + additions + transfers in − transfers out − deaths − removals', () => {
    expect(closingHens(1000, { deaths: 3, removals: 2, additions: 10, transfersIn: 5, transfersOut: 20 })).toBe(990)
  })
  it('no movements keeps the balance', () => {
    expect(closingHens(1000, { deaths: 0, removals: 0, additions: 0, transfersIn: 0, transfersOut: 0 })).toBe(1000)
  })
})

describe('egg production %', () => {
  it('uses the average of opening and closing hens by default', () => {
    // 900 eggs / ((1000 + 990) / 2) × 100 = 90.45%
    expect(productionPercent(900, 1000, 990)).toBe(90.45)
  })
  it('supports opening and closing denominators', () => {
    expect(productionPercent(900, 1000, 990, 'opening')).toBe(90)
    expect(productionPercent(900, 1000, 900, 'closing')).toBe(100)
  })
  it('is undefined (null), not zero, with no hens', () => {
    expect(productionPercent(0, 0, 0)).toBeNull()
  })
  it('totals distinguish collected and saleable eggs', () => {
    const t = eggTotals([
      { good: 400, damaged: 5, rejected: 2 },
      { good: 450, damaged: 3, rejected: 0 }
    ])
    expect(t).toEqual({ good: 850, damaged: 8, rejected: 2, collected: 860, saleable: 850 })
  })
})

describe('mortality %', () => {
  it('defaults to deaths / opening hens', () => {
    expect(mortalityPercent(5, 1000, 995)).toBe(0.5)
  })
  it('null with no hens', () => {
    expect(mortalityPercent(0, 0, 0)).toBeNull()
  })
})

describe('feed consumption', () => {
  const base = { openingStock: null, issued: 0, returned: 0, wasted: 0, measuredConsumption: null, closingStock: null }
  it('estimates issued − returned − wasted and flags it as an estimate', () => {
    const r = feedConsumption({ ...base, issued: 120, returned: 5, wasted: 2 })
    expect(r).toMatchObject({ consumption: 113, method: 'estimate', isEstimate: true })
  })
  it('uses the stock balance when the cage stock was counted', () => {
    const r = feedConsumption({ ...base, openingStock: 20, issued: 110, returned: 0, wasted: 1, closingStock: 15 })
    expect(r).toMatchObject({ consumption: 114, method: 'stock_balance', isEstimate: false })
  })
  it('prefers measured consumption', () => {
    const r = feedConsumption({ ...base, issued: 120, measuredConsumption: 111.5 })
    expect(r).toMatchObject({ consumption: 111.5, method: 'measured', isEstimate: false })
  })
  it('never treats "nothing recorded" as zero consumption', () => {
    expect(feedConsumption(base).consumption).toBeNull()
  })
  it('rejects returns greater than issues and impossible stock balances', () => {
    expect(feedConsumption({ ...base, issued: 10, returned: 20 }).error).toBe('returned_exceeds_issued')
    expect(feedConsumption({ ...base, openingStock: 0, issued: 10, closingStock: 50 }).error).toBe('stock_imbalance')
  })
  it('feed per hen in grams', () => {
    expect(feedPerHenGrams(115, 1000)).toBe(115)
    expect(feedPerHenGrams(null, 1000)).toBeNull()
  })
})

describe('water consumption', () => {
  it('meter: closing − opening', () => {
    expect(waterConsumption({ method: 'meter', openingReading: 1200.5, closingReading: 1450, litres: null, meterReset: false }).litres).toBe(249.5)
  })
  it('rejects a closing reading below the opening reading', () => {
    expect(waterConsumption({ method: 'meter', openingReading: 1200, closingReading: 100, litres: null, meterReset: false }).error).toBe(
      'closing_below_opening'
    )
  })
  it('requires manual litres after an authorised meter reset', () => {
    expect(waterConsumption({ method: 'meter', openingReading: 1200, closingReading: 100, litres: null, meterReset: true }).error).toBe(
      'litres_required_after_reset'
    )
    expect(waterConsumption({ method: 'meter', openingReading: 1200, closingReading: 100, litres: 240, meterReset: true }).litres).toBe(240)
  })
  it('manual litres; missing meter reading stays unknown', () => {
    expect(waterConsumption({ method: 'manual', openingReading: null, closingReading: null, litres: 230, meterReset: false }).litres).toBe(230)
    expect(waterConsumption({ method: 'meter', openingReading: 10, closingReading: null, litres: null, meterReset: false }).litres).toBeNull()
  })
})

describe('alerts', () => {
  it('production drop compares against the baseline', () => {
    expect(isProductionDrop(80, 90, 10)).toBe(true) // −11.1%
    expect(isProductionDrop(85, 90, 10)).toBe(false) // −5.6%
    expect(isProductionDrop(null, 90, 10)).toBe(false)
  })
})

describe('date boundaries', () => {
  it('validates real calendar dates', () => {
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
  })
  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3)
  })
  it('uses the farm timezone for "today"', () => {
    // 20:00 UTC on 9 March is already 10 March in Sri Lanka (UTC+5:30)
    const t = new Date('2026-03-09T20:00:00Z')
    expect(todayInTimezone('Asia/Colombo', t)).toBe('2026-03-10')
    expect(todayInTimezone('UTC', t)).toBe('2026-03-09')
  })
  it('week and month bounds', () => {
    expect(startOfWeek('2026-03-15')).toBe('2026-03-09') // Sunday → Monday
    expect(monthBounds('2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
})
