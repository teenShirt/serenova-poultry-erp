import { describe, expect, it } from 'vitest'
import { AppError } from '../src/server/errors'
import {
  closeDay,
  confirmIssue,
  confirmMortality,
  correctOpening,
  finishAmendment,
  getOverview,
  previewStartDay,
  startAmendment,
  startDay
} from '../src/server/services/days'
import { deleteEggs, saveEggs } from '../src/server/services/eggs'
import { addMovement, deleteMovement, transferHens } from '../src/server/services/flock'
import { saveFeed } from '../src/server/services/feed'
import { saveWater } from '../src/server/services/water'
import { addTreatment } from '../src/server/services/medicine'
import { balances, itemBalance, listBatches, recordTxn } from '../src/server/services/inventory'
import { dailySeries, cageComparison } from '../src/server/services/analytics'
import { makeFarm } from './helpers'
import type { Ctx } from '../src/server/context'

const D1 = '2026-03-09'
const D2 = '2026-03-10'

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof AppError) return e.code
    throw e
  }
  return 'no_error'
}

const egg = (date: string, cageId: number, session: 'morning' | 'evening', good: number, damaged = 0, rejected = 0) => ({
  date,
  cageId,
  session,
  collectedAt: session === 'morning' ? '08:00' : '16:30',
  good,
  damaged,
  rejected,
  notes: null
})

const feed = (date: string, cageId: number, itemId: number, issued: number, extra: Record<string, number | null> = {}) => ({
  date,
  cageId,
  itemId,
  batchNo: null,
  openingStock: null,
  issued,
  returned: 0,
  wasted: 0,
  measuredConsumption: null,
  closingStock: null,
  notes: null,
  ...extra
})

const water = (date: string, cageId: number, opening: number, closing: number) => ({
  date,
  cageId,
  method: 'meter' as const,
  openingReading: opening,
  closingReading: closing,
  litres: null,
  meterReset: false,
  correctionReason: null,
  notes: null
})

/** Fills every check for every cage so the day can close. */
async function completeDay(ctx: Ctx, date: string, cageIds: number[], feedId: number, meterBase = 0) {
  for (const c of cageIds) {
    await saveEggs(ctx, egg(date, c, 'morning', 500, 4, 1), null)
    await saveEggs(ctx, egg(date, c, 'evening', 420, 3, 0), null)
    await saveFeed(ctx, feed(date, c, feedId, 115), null)
    await saveWater(ctx, water(date, c, meterBase, meterBase + 230), null)
  }
  await confirmMortality(ctx, date, cageIds)
}

describe('starting a day', () => {
  it('carries the initial flock into the first day and prevents duplicates', async () => {
    const f = await makeFarm()
    const p = await previewStartDay(f.worker, D1)
    expect(p.cages).toHaveLength(10)
    expect(p.cages.every((c) => c.carried === 1000)).toBe(true)
    expect(p.inventory.find((i) => i.name === 'Layer Mash')?.balance).toBe(5000)
    const ov = await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    expect(ov.status).toBe('in_progress')
    expect(ov.totals.opening).toBe(10000)
    expect(await code(() => startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: true }))).toBe('day_already_started')
    expect(((await f.db.prepare('SELECT COUNT(*) n FROM farm_days').get()) as { n: number }).n).toBe(1)
  })

  it('refuses future dates and needs acknowledgement when the previous day is still open', async () => {
    const f = await makeFarm()
    expect(await code(() => startDay(f.worker, { date: '2026-03-11', corrections: [], acknowledgeWarnings: true }))).toBe('future_date')
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    expect((await previewStartDay(f.worker, D2)).warnings).toContain('previous_not_closed')
    expect(await code(() => startDay(f.worker, { date: D2, corrections: [], acknowledgeWarnings: false }))).toBe('warnings_not_acknowledged')
    expect((await startDay(f.worker, { date: D2, corrections: [], acknowledgeWarnings: true })).status).toBe('in_progress')
  })

  it('opening corrections need an admin and a reason, and are audited', async () => {
    const f = await makeFarm()
    const c = f.cageIds[0]
    expect(await code(() => startDay(f.worker, { date: D1, corrections: [{ cageId: c, opening: 990, reason: 'recount' }], acknowledgeWarnings: false }))).toBe(
      'admin_only'
    )
    expect(await code(() => startDay(f.admin, { date: D1, corrections: [{ cageId: c, opening: 990, reason: '' }], acknowledgeWarnings: false }))).toBe(
      'reason_required'
    )
    const ov = await startDay(f.admin, { date: D1, corrections: [{ cageId: c, opening: 990, reason: 'Physical recount' }], acknowledgeWarnings: false })
    expect(ov.cages[0]).toMatchObject({ carried: 1000, adjustment: -10, opening: 990 })
    const a = (await f.db.prepare("SELECT reason FROM audit_log WHERE action='correct_opening'").get()) as { reason: string }
    expect(a.reason).toBe('Physical recount')
  })
})

describe('egg collection', () => {
  it('one record per cage and session; saving again must be an explicit edit', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    const c = f.cageIds[0]
    const id = await saveEggs(f.worker, egg(D1, c, 'morning', 500, 5, 2), null)
    expect(await code(() => saveEggs(f.worker, egg(D1, c, 'morning', 500), null))).toBe('egg_session_exists')
    await saveEggs(f.worker, egg(D1, c, 'morning', 510, 5, 2), id)
    await saveEggs(f.worker, egg(D1, c, 'evening', 400, 3, 0), null)
    const ov = await getOverview(f.worker, D1)
    expect(ov.cages[0].eggs).toMatchObject({ good: 910, damaged: 8, rejected: 2, collected: 920, saleable: 910 })
    expect(ov.cages[0].productionPct).toBe(92)
    expect(await code(() => deleteEggs(f.worker, id, ''))).toBe('reason_required')
    await deleteEggs(f.worker, id, 'entered twice')
    expect((await getOverview(f.worker, D1)).cages[0].eggs.collected).toBe(403)
  })
})

describe('flock balance', () => {
  it('reconciles deaths, removals, additions and transfers, keeping the farm total', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    const [a, b] = f.cageIds
    await addMovement(f.worker, { date: D1, cageId: a, type: 'death', quantity: 3, reason: null, notes: null })
    await addMovement(f.worker, { date: D1, cageId: a, type: 'removal', quantity: 2, reason: 'Culled', notes: null })
    await addMovement(f.worker, { date: D1, cageId: b, type: 'addition', quantity: 10, reason: 'New pullets', notes: null })
    await transferHens(f.worker, { date: D1, fromCageId: a, toCageId: b, quantity: 50, reason: 'Rebalance', notes: null })
    const ov = await getOverview(f.worker, D1)
    expect(ov.cages[0].closing).toBe(1000 - 3 - 2 - 50)
    expect(ov.cages[1].closing).toBe(1000 + 10 + 50)
    expect(ov.totals.closing).toBe(10000 - 3 - 2 + 10) // transfer does not change the farm total
    expect(ov.totals.movements.transfersIn).toBe(ov.totals.movements.transfersOut)
    expect(ov.cages[0].mortalityPct).toBe(0.3)
  })

  it('never allows negative hens, and removals need a reason', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    const [a, b] = f.cageIds
    expect(await code(() => addMovement(f.worker, { date: D1, cageId: a, type: 'death', quantity: 1001, reason: null, notes: null }))).toBe('negative_hens')
    expect(await code(() => transferHens(f.worker, { date: D1, fromCageId: a, toCageId: b, quantity: 1001, reason: null, notes: null }))).toBe('negative_hens')
    expect(await code(() => addMovement(f.worker, { date: D1, cageId: a, type: 'removal', quantity: 1, reason: null, notes: null }))).toBe('reason_required')
    expect((await getOverview(f.worker, D1)).totals.closing).toBe(10000)
  })

  it('deleting one side of a transfer removes both sides', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    const [a, b] = f.cageIds
    await transferHens(f.worker, { date: D1, fromCageId: a, toCageId: b, quantity: 20, reason: null, notes: null })
    const row = (await f.db.prepare("SELECT id FROM flock_movements WHERE type='transfer_in'").get()) as { id: number }
    await deleteMovement(f.worker, row.id, 'wrong cage')
    expect(((await f.db.prepare('SELECT COUNT(*) n FROM flock_movements').get()) as { n: number }).n).toBe(0)
  })

  it('carries closing hens forward to the next day', async () => {
    const f = await makeFarm()
    f.setNow(new Date('2026-03-10T10:00:00Z'))
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    await addMovement(f.worker, { date: D1, cageId: f.cageIds[0], type: 'death', quantity: 4, reason: null, notes: null })
    await completeDay(f.worker, D1, f.cageIds, f.feedId)
    // 4 deaths in 1000 hens (0.4%) exceeds the default 0.1% alert: the manager must acknowledge it.
    expect(await code(() => closeDay(f.admin, D1, null))).toBe('day_has_open_issues')
    await confirmIssue(f.admin, D1, f.cageIds[0], 'high_mortality', 'Heat stress, vet informed')
    await closeDay(f.admin, D1, null)
    const ov = await startDay(f.worker, { date: D2, corrections: [], acknowledgeWarnings: false })
    expect(ov.cages[0].opening).toBe(996)
    expect(ov.totals.opening).toBe(9996)
  })
})

describe('feed and inventory', () => {
  it('posts exactly one stock deduction per feed record, even when re-saved', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    const c = f.cageIds[0]
    const id = await saveFeed(f.worker, feed(D1, c, f.feedId, 120), null)
    expect(await itemBalance(f.worker, f.feedId)).toBe(4880)
    await saveFeed(f.worker, feed(D1, c, f.feedId, 120, { returned: 5, wasted: 2 }), id)
    expect(await itemBalance(f.worker, f.feedId)).toBe(4885)
    const ov = await getOverview(f.worker, D1)
    expect(ov.cages[0].feed).toMatchObject({ consumption: 113, isEstimate: true })
    expect(await code(() => saveFeed(f.worker, feed(D1, c, f.feedId, 10), null))).toBe('feed_record_exists')
    const n = (await f.db.prepare("SELECT COUNT(*) n FROM inventory_transactions WHERE source_type='feed_record'").get()) as { n: number }
    expect(n.n).toBe(2) // one issue + one return
  })

  it('does not let stock go below zero', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    expect(await code(() => saveFeed(f.worker, feed(D1, f.cageIds[0], f.feedId, 6000), null))).toBe('insufficient_stock')
    expect(await itemBalance(f.worker, f.feedId)).toBe(5000)
  })

  it('records purchases, and low stock is flagged', async () => {
    const f = await makeFarm()
    await recordTxn(f.worker, { itemId: f.feedId, type: 'purchase', quantity: 1000, date: D1, batchNo: null, expiryDate: null, unitCost: 150, supplier: 'Mill', reference: 'INV-1', notes: null, cageId: null })
    expect(await itemBalance(f.worker, f.feedId)).toBe(6000)
    expect(await code(() => recordTxn(f.worker, { itemId: f.feedId, type: 'adjustment', quantity: -5700, date: D1, batchNo: null, expiryDate: null, unitCost: null, supplier: null, reference: null, notes: 'stock count', cageId: null }))).toBe('admin_only')
    await recordTxn(f.admin, { itemId: f.feedId, type: 'adjustment', quantity: -5700, date: D1, batchNo: null, expiryDate: null, unitCost: null, supplier: null, reference: null, notes: 'stock count', cageId: null })
    expect((await balances(f.worker, 'feed'))[0]).toMatchObject({ balance: 300, isLow: true })
  })
})

describe('water', () => {
  it('validates meter readings', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    const c = f.cageIds[0]
    expect(await code(() => saveWater(f.worker, water(D1, c, 1500, 1200), null))).toBe('meter_closing_below_opening')
    const reset = { ...water(D1, c, 1500, 20), meterReset: true, correctionReason: 'Meter replaced', litres: 240 }
    expect(await code(() => saveWater(f.worker, reset, null))).toBe('admin_only')
    await saveWater(f.admin, reset, null)
    expect((await getOverview(f.worker, D1)).cages[0].water.litres).toBe(240)
  })
})

describe('medicine', () => {
  it('deducts usage from the batch and refuses overdraw', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    const batch = (await listBatches(f.worker, { itemId: f.medId }))[0]
    await addTreatment(f.worker, { date: D1, cageId: f.cageIds[0], itemId: f.medId, batchId: batch.id, quantity: 250, administeredAt: '09:00', reason: 'Vet instruction', prescribedBy: 'Dr. Perera', notes: null })
    expect((await listBatches(f.worker, { itemId: f.medId }))[0].balance).toBe(750)
    expect(await code(() => addTreatment(f.worker, { date: D1, cageId: f.cageIds[0], itemId: f.medId, batchId: batch.id, quantity: 800, administeredAt: null, reason: 'Vet instruction', prescribedBy: null, notes: null }))).toBe('insufficient_stock')
    expect((await getOverview(f.worker, D1)).cages[0].medicineUses).toBe(1)
  })
})

describe('closing and amending', () => {
  it('blocks closing with missing data, allows explicit confirmation with a reason', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    const ov = await getOverview(f.admin, D1)
    expect(ov.status).toBe('in_progress')
    const codes = new Set(ov.issues.map((i) => i.code))
    for (const c of ['missing_eggs', 'missing_feed', 'missing_water', 'mortality_unconfirmed']) expect(codes.has(c)).toBe(true)
    expect(await code(() => closeDay(f.admin, D1, null))).toBe('day_has_open_issues')
    expect(await code(() => closeDay(f.worker, D1, null))).toBe('admin_only')

    await completeDay(f.worker, D1, f.cageIds.slice(1), f.feedId)
    await confirmMortality(f.worker, D1, [f.cageIds[0]])
    const c0 = f.cageIds[0]
    expect(await code(() => confirmIssue(f.admin, D1, c0, 'missing_feed', ''))).toBe('reason_required')
    expect(await code(() => confirmIssue(f.admin, D1, c0, 'mortality_unconfirmed', 'x reason'))).toBe('issue_not_confirmable')
    for (const k of ['missing_eggs', 'missing_feed', 'missing_water']) await confirmIssue(f.admin, D1, c0, k, 'Cage empty for cleaning')
    expect((await getOverview(f.admin, D1)).status).toBe('ready_to_close')
    const closed = await closeDay(f.admin, D1, 'All good')
    expect(closed.status).toBe('closed')
    // Missing figures stay unknown, they are never invented as zero.
    expect(closed.cages[0].water.litres).toBeNull()
    expect(closed.cages[0].feed.consumption).toBeNull()
    const snap = (await f.db.prepare("SELECT COUNT(*) n FROM day_snapshots WHERE kind='close'").get()) as { n: number }
    expect(snap.n).toBe(1)
  })

  it('protects closed days and recalculates later days after an amendment', async () => {
    const f = await makeFarm()
    f.setNow(new Date('2026-03-10T10:00:00Z'))
    const [a] = f.cageIds
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    await completeDay(f.worker, D1, f.cageIds, f.feedId)
    await closeDay(f.admin, D1, null)
    await startDay(f.worker, { date: D2, corrections: [], acknowledgeWarnings: false })
    await completeDay(f.worker, D2, f.cageIds, f.feedId, 230)
    await closeDay(f.admin, D2, null)

    expect(await code(() => addMovement(f.worker, { date: D1, cageId: a, type: 'death', quantity: 5, reason: null, notes: null }))).toBe('day_closed')
    expect(await code(() => startAmendment(f.worker, D1, 'Late death report'))).toBe('admin_only')
    await startAmendment(f.admin, D1, 'Late death report from night shift')
    expect(await code(() => addMovement(f.worker, { date: D1, cageId: a, type: 'death', quantity: 5, reason: null, notes: null }))).toBe('admin_only')
    await addMovement(f.admin, { date: D1, cageId: a, type: 'death', quantity: 5, reason: null, notes: null })
    await confirmIssue(f.admin, D1, a, 'high_mortality', 'Reported late by night shift')
    await finishAmendment(f.admin, D1, null)

    const d2 = await getOverview(f.admin, D2)
    expect(d2.cages[0].opening).toBe(995)
    expect(d2.totals.closing).toBe(9995)
    const v = (await f.db.prepare("SELECT MAX(version) v FROM day_snapshots s JOIN farm_days d ON d.id=s.day_id WHERE d.business_date=? AND kind='close'").get(D2)) as { v: number }
    expect(v.v).toBe(2) // later closed day re-snapshotted
    const amend = (await f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action IN ('start_amendment','finish_amendment')").get()) as { n: number }
    expect(amend.n).toBe(2)
  })

  it('opening correction cascades to later days', async () => {
    const f = await makeFarm()
    f.setNow(new Date('2026-03-10T10:00:00Z'))
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    await startDay(f.worker, { date: D2, corrections: [], acknowledgeWarnings: true })
    await correctOpening(f.admin, D1, f.cageIds[0], 980, 'Recount')
    expect((await getOverview(f.admin, D2)).cages[0].opening).toBe(980)
  })
})

describe('analytics', () => {
  it('builds daily series with gaps for missing days and a cage comparison', async () => {
    const f = await makeFarm()
    f.setNow(new Date('2026-03-10T10:00:00Z'))
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    await completeDay(f.worker, D1, f.cageIds, f.feedId)
    await addMovement(f.worker, { date: D1, cageId: f.cageIds[2], type: 'death', quantity: 2, reason: null, notes: null })
    const s = await dailySeries(f.worker, '2026-03-08', D2)
    expect(s).toHaveLength(3)
    expect(s[0].productionPct).toBeNull()
    expect(s[1]).toMatchObject({ eggs: 9280, deaths: 2, cumulativeDeaths: 2, feedKg: 1150, waterLitres: 2300 })
    const cmp = await cageComparison(f.worker, D1, D1)
    expect(cmp).toHaveLength(10)
    expect(cmp[2]).toMatchObject({ deaths: 2, closingHens: 998 })
  })
})
