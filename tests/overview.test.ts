import { describe, expect, it } from 'vitest'
import { buildCsv, csvCell } from '../src/server/reports/csv'
import { closeDay, confirmIssue, confirmMortality, getOverview, isBlocking, startDay } from '../src/server/services/days'
import { saveEggs } from '../src/server/services/eggs'
import { addMovement } from '../src/server/services/flock'
import { saveFarm } from '../src/server/services/flocks'
import { recordTxn } from '../src/server/services/inventory'
import { movementsPage, organizationOverview } from '../src/server/services/overview'
import { makeFarm } from './helpers'

const D = '2026-03-09'
const TODAY = '2026-03-10'

/** A closed day (6,060 eggs, 10 deaths and 5 culled from 10,000 hens) and an open day after it. */
async function farmWithDays() {
  const f = await makeFarm()
  f.setNow(new Date('2026-03-10T10:00:00Z'))
  await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: false })
  for (const c of f.cageIds)
    await saveEggs(f.worker, { date: D, cageId: c, session: 'morning', collectedAt: '08:00', good: 600, damaged: 5, rejected: 1, notes: null }, null)
  await addMovement(f.worker, { date: D, cageId: f.cageIds[0], type: 'death', quantity: 10, reason: null, notes: null })
  await addMovement(f.worker, { date: D, cageId: f.cageIds[1], type: 'removal', quantity: 5, reason: 'Culled', notes: null })
  await confirmMortality(f.worker, D, f.cageIds)
  for (const i of (await getOverview(f.admin, D)).issues.filter(isBlocking)) await confirmIssue(f.admin, D, i.cageId, i.key, 'Evening collection not recorded')
  await closeDay(f.admin, D, 'Reviewed')
  // Today is open: its eggs must not count anywhere yet.
  await startDay(f.worker, { date: TODAY, corrections: [], acknowledgeWarnings: true })
  await saveEggs(
    f.worker,
    { date: TODAY, cageId: f.cageIds[0], session: 'morning', collectedAt: '08:00', good: 999, damaged: 0, rejected: 0, notes: null },
    null
  )
  return f
}

describe('organization overview', () => {
  it('compares farms on closed days only, with rates worked out from their parts', async () => {
    const f = await farmWithDays()
    const north = await saveFarm(f.admin, { id: null, name: 'North Farm', location: null })
    const o = await organizationOverview(f.admin, D, TODAY)
    expect(o.farms.map((r) => r.farmName)).toEqual(['Test Farm', 'North Farm'])
    const [main] = o.farms
    // Bird-days 9,992.5 = (10,000 + 9,985) ÷ 2; laying 6,060 ÷ 9,992.5 × 100 = 60.6%; mortality 10 ÷ 10,000 = 0.1%.
    expect(main).toMatchObject({
      closedDays: 1,
      openDays: 1,
      birdsNow: 9985,
      eggs: 6060,
      layingPct: 60.6,
      deaths: 10,
      culls: 5,
      mortalityPct: 0.1,
      feedPerBirdG: null
    })
    expect(o.farms[1]).toMatchObject({ farmId: north, closedDays: 0, birdsNow: 0, eggs: 0, layingPct: null, mortalityPct: null })
    expect(o.totals).toMatchObject({ eggs: 6060, layingPct: 60.6, mortalityPct: 0.1, birdsNow: 9985 })
    expect(o.trend).toEqual([
      { date: D, [String(f.farm)]: 6060, [String(north)]: null },
      { date: TODAY, [String(f.farm)]: null, [String(north)]: null }
    ])
  })

  it('stock alerts and expiring batches per farm', async () => {
    const f = await makeFarm()
    await recordTxn(f.admin, {
      itemId: f.feedId,
      type: 'issue',
      quantity: 4600,
      date: D,
      batchNo: null,
      expiryDate: null,
      unitCost: null,
      supplier: null,
      reference: null,
      notes: null,
      cageId: null
    })
    const o = await organizationOverview(f.admin, D, TODAY)
    expect(o.stockAlerts).toEqual([{ farmName: 'Test Farm', warehouseName: 'Main Store', item: 'Layer Mash', balance: 400, unit: 'kg', kind: 'low' }])
    expect(o.farms[0].lowStockItems).toBe(1)
    expect(o.recentMovements[0]).toMatchObject({ item: 'Layer Mash', type: 'issue', quantity: -4600 })
  })
})

describe('stock movement history', () => {
  it('pages through movements newest first, with filters', async () => {
    const f = await makeFarm()
    for (let i = 1; i <= 12; i++) {
      await recordTxn(f.admin, {
        itemId: f.feedId,
        type: 'purchase',
        quantity: i,
        date: D,
        batchNo: null,
        expiryDate: null,
        unitCost: null,
        supplier: null,
        reference: `INV-${i}`,
        notes: null,
        cageId: null
      })
    }
    const p1 = await movementsPage(f.admin, { from: '2026-02-01', to: TODAY, page: 1, pageSize: 10 })
    expect(p1).toMatchObject({ total: 14, page: 1, pageSize: 10 })
    expect(p1.rows[0]).toMatchObject({ reference: 'INV-12', type: 'purchase', quantity: 12, store: 'Main Store' })
    const p2 = await movementsPage(f.admin, { from: '2026-02-01', to: TODAY, page: 2, pageSize: 10 })
    expect(p2.rows.map((r) => r.type)).toEqual(['purchase', 'purchase', 'opening', 'opening'])
    expect((await movementsPage(f.admin, { from: '2026-02-01', to: TODAY, page: 1, type: 'opening', itemId: f.medId })).total).toBe(1)
  })
})

describe('CSV exports', () => {
  it('quotes text and never lets a cell run as a spreadsheet formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"')
    expect(csvCell('+94 77')).toBe("'+94 77")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('Mill, Kandy')).toBe('"Mill, Kandy"')
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(null)).toBe('')
  })

  it('exports the daily production of the farm, in the organization’s language, readable by Excel', async () => {
    const f = await farmWithDays()
    const { name, csv } = await buildCsv(f.admin, 'production', D, TODAY, {})
    expect(name).toBe('production-2026-03-09-2026-03-10')
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.trim().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/^2026-03-09,Closed,10000,9985,6060,6000,50,10,/)
  })
})
