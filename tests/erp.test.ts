import { describe, expect, it } from 'vitest'
import { AppError } from '../src/server/errors'
import type { Ctx } from '../src/server/context'
import { confirmMortality, startDay } from '../src/server/services/days'
import { saveEggs } from '../src/server/services/eggs'
import { saveFeed } from '../src/server/services/feed'
import { itemBalance } from '../src/server/services/inventory'
import { checkAccess, dutyTasks, setUserDuties } from '../src/server/services/duties'
import { listUsers, login } from '../src/server/services/auth'
import { saveParty } from '../src/server/services/parties'
import { cancelReceipt, createReceipt, listReceipts } from '../src/server/services/purchases'
import { addPayment, adjustEggStore, cancelDispatch, createDispatch, eggStock, listDispatches, outstandingTotal, salesSeries } from '../src/server/services/sales'
import { flowSummary, purchasesSeries } from '../src/server/services/supply'
import { activitySummary, checkDatabase, dbInfo } from '../src/server/services/admin'
import { makeFarm } from './helpers'

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

const egg = (date: string, cageId: number, session: 'morning' | 'evening', good: number, damaged = 0) => ({
  date,
  cageId,
  session,
  collectedAt: '08:00',
  good,
  damaged,
  rejected: 0,
  notes: null
})

const dispatch = (customerId: number, goodQty: number, extra: Partial<Parameters<typeof createDispatch>[1]> = {}) => ({
  date: D2,
  customerId,
  goodQty,
  goodPrice: 45,
  crackedQty: 0,
  crackedPrice: 30,
  amountPaid: 0,
  paymentMethod: 'cash' as const,
  invoiceNo: null,
  vehicle: null,
  driver: null,
  notes: null,
  ...extra
})

describe('duties and cage responsibility', () => {
  it('limits a worker to the duties and cages the administrator assigned', async () => {
    const f = await makeFarm()
    await startDay(f.admin, { date: D1, corrections: [], acknowledgeWarnings: false })
    const [c1, c2] = f.cageIds
    await setUserDuties(f.admin, f.worker.user!.id, ['eggs', 'flock'], [c1])
    const w = f.worker
    // Allowed: eggs for own cage
    expect(await code(() => checkAccess(w, 'eggs.save', { cageId: c1 }))).toBe('no_error')
    // Not their cage
    expect(await code(() => checkAccess(w, 'eggs.save', { cageId: c2 }))).toBe('cage_not_assigned')
    // Not their duty
    expect(await code(() => checkAccess(w, 'feed.save', { cageId: c1 }))).toBe('no_permission')
    expect(await code(() => checkAccess(w, 'sales.dispatch', {}))).toBe('no_permission')
    // Transfers must involve only their cages; confirmations too
    expect(await code(() => checkAccess(w, 'flock.transfer', { fromCageId: c1, toCageId: c2 }))).toBe('cage_not_assigned')
    expect(await code(() => checkAccess(w, 'days.confirmMortality', { cageIds: [c1, c2] }))).toBe('cage_not_assigned')
    // Deleting a record in someone else's cage
    const id = await saveEggs(f.admin, egg(D1, c2, 'morning', 500), null)
    expect(await code(() => checkAccess(w, 'eggs.delete', { id, reason: 'x' }))).toBe('cage_not_assigned')
    // Reading is always allowed; administrators are never limited
    expect(await code(() => checkAccess(w, 'days.overview', { date: D1 }))).toBe('no_error')
    expect(await code(() => checkAccess(f.admin, 'sales.dispatch', {}))).toBe('no_error')
    // The session reflects the assignment at sign-in, and the user list shows it
    expect(await login({ ...f.worker, user: null }, 'worker', 'worker123')).toMatchObject({ duties: ['eggs', 'flock'], cages: [c1] })
    expect((await listUsers(f.admin)).find((u) => u.username === 'worker')).toMatchObject({ duties: ['eggs', 'flock'], cages: [c1] })
  })

  it('users created before duties existed keep every duty; only admins can assign', async () => {
    const f = await makeFarm()
    expect((await listUsers(f.admin)).find((u) => u.username === 'worker')!.duties).toHaveLength(11)
    expect(await code(() => setUserDuties(f.worker, f.worker.user!.id, ['sales'], null))).toBe('admin_only')
  })

  it('builds "my duties today" and ticks off work as it is recorded', async () => {
    const f = await makeFarm()
    const [c1] = f.cageIds
    await setUserDuties(f.admin, f.worker.user!.id, ['start_day', 'eggs', 'feed', 'flock'], [c1])
    let tasks = await dutyTasks(f.worker, D1)
    expect(tasks).toEqual([expect.objectContaining({ key: 'start_day', done: false })])
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    tasks = await dutyTasks(f.worker, D1)
    // start day + 2 egg sessions + feed + deaths for one cage
    expect(tasks.map((t) => t.key)).toEqual(['start_day', `eggs:morning:${c1}`, `eggs:evening:${c1}`, `feed:${c1}`, `deaths:${c1}`])
    await saveEggs(f.worker, egg(D1, c1, 'morning', 500), null)
    await confirmMortality(f.worker, D1, [c1])
    const done = Object.fromEntries((await dutyTasks(f.worker, D1)).map((t) => [t.key, t.done]))
    expect(done).toEqual({ start_day: true, [`eggs:morning:${c1}`]: true, [`eggs:evening:${c1}`]: false, [`feed:${c1}`]: false, [`deaths:${c1}`]: true })
  })
})

describe('goods received from suppliers', () => {
  it('adds stock exactly once per line, numbers receipts, and can be cancelled', async () => {
    const f = await makeFarm()
    const mill = await saveParty(f.worker, 'supplier', { id: null, name: 'Prima Feed Mill', phone: '0771234567', address: null, notes: null, active: true })
    expect(await code(() => saveParty(f.worker, 'supplier', { id: null, name: 'prima feed mill', phone: null, address: null, notes: null, active: true }))).toBe('name_taken')
    const r1 = await createReceipt(f.worker, {
      date: D1,
      supplierId: mill,
      invoiceNo: 'INV-77',
      vehicle: 'WP LB-1234',
      notes: null,
      lines: [
        { itemId: f.feedId, quantity: 2000, unitCost: 160, batchNo: null, expiryDate: null },
        { itemId: f.medId, quantity: 500, unitCost: 2, batchNo: 'VM-02', expiryDate: '2027-01-31' }
      ]
    })
    const r2 = await createReceipt(f.worker, { date: D1, supplierId: mill, invoiceNo: null, vehicle: null, notes: null, lines: [{ itemId: f.feedId, quantity: 100, unitCost: null, batchNo: null, expiryDate: null }] })
    expect(r1.grnNo).toBe('GRN-20260309-001')
    expect(r2.grnNo).toBe('GRN-20260309-002')
    expect(await itemBalance(f.worker, f.feedId)).toBe(5000 + 2000 + 100)
    const list = await listReceipts(f.worker, D1, D1)
    expect(list.find((r) => r.grnNo === r1.grnNo)).toMatchObject({ supplierName: 'Prima Feed Mill', totalCost: 2000 * 160 + 500 * 2 })
    expect(await code(() => createReceipt(f.worker, { date: D1, supplierId: null, invoiceNo: null, vehicle: null, notes: null, lines: [{ itemId: f.medId, quantity: 5, unitCost: null, batchNo: null, expiryDate: null }] }))).toBe('batch_required')
    expect(await code(() => cancelReceipt(f.worker, r2.id, 'typo'))).toBe('admin_only')
    await cancelReceipt(f.admin, r2.id, 'Entered twice')
    expect(await itemBalance(f.worker, f.feedId)).toBe(7000)
  })

  it('cannot cancel a delivery whose stock has already been used', async () => {
    const f = await makeFarm()
    const r = await createReceipt(f.worker, { date: D1, supplierId: null, invoiceNo: null, vehicle: null, notes: null, lines: [{ itemId: f.feedId, quantity: 1000, unitCost: null, batchNo: null, expiryDate: null }] })
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    await saveFeed(f.worker, { date: D1, cageId: f.cageIds[0], itemId: f.feedId, batchNo: null, openingStock: null, issued: 5500, returned: 0, wasted: 0, measuredConsumption: null, closingStock: null, notes: null }, null)
    expect(await code(() => cancelReceipt(f.admin, r.id, 'mistake'))).toBe('insufficient_stock')
  })
})

describe('egg store and sales', () => {
  async function farmWithEggs() {
    const f = await makeFarm()
    f.setNow(new Date('2026-03-10T10:00:00Z'))
    await startDay(f.worker, { date: D1, corrections: [], acknowledgeWarnings: false })
    await saveEggs(f.worker, egg(D1, f.cageIds[0], 'morning', 900, 20), null)
    await saveEggs(f.worker, egg(D1, f.cageIds[1], 'morning', 800, 10), null)
    const shop = await saveParty(f.worker, 'customer', { id: null, name: 'Kurunegala Egg Centre', phone: null, address: null, notes: null, active: true })
    return { f, shop }
  }

  it('stock = eggs collected − dispatched + adjustments, never below zero', async () => {
    const { f, shop } = await farmWithEggs()
    expect(await eggStock(f.worker)).toEqual({ good: 1700, cracked: 30 })
    const d = await createDispatch(f.worker, dispatch(shop, 1200, { crackedQty: 30, amountPaid: 20000 }))
    expect(d.dispatchNo).toBe('DSP-20260310-001')
    expect(await eggStock(f.worker)).toEqual({ good: 500, cracked: 0 })
    expect(await code(() => createDispatch(f.worker, dispatch(shop, 501)))).toBe('not_enough_eggs')
    // A dispatch back-dated before the eggs were collected is refused.
    expect(await code(() => createDispatch(f.worker, { ...dispatch(shop, 10), date: '2026-03-08' }))).toBe('not_enough_eggs')
    expect(await code(() => adjustEggStore(f.worker, { date: D2, grade: 'good', quantity: -12, reason: 'Broken tray' }))).toBe('admin_only')
    await adjustEggStore(f.admin, { date: D2, grade: 'good', quantity: -12, reason: 'Broken tray in store' })
    expect((await eggStock(f.worker)).good).toBe(488)
  })

  it('tracks amounts, payments and the balance owed', async () => {
    const { f, shop } = await farmWithEggs()
    const { id } = await createDispatch(f.worker, dispatch(shop, 1000, { crackedQty: 30, amountPaid: 10000 }))
    // 1000 × 45 + 30 × 30 = 45,900
    let row = (await listDispatches(f.worker, { from: D2, to: D2 }))[0]
    expect(row).toMatchObject({ amount: 45900, amountPaid: 10000, balance: 35900, paymentStatus: 'partial' })
    expect(await code(() => addPayment(f.worker, { dispatchId: id, date: D2, amount: 40000, method: 'cash', reference: null }))).toBe('payment_exceeds_balance')
    await addPayment(f.worker, { dispatchId: id, date: D2, amount: 35900, method: 'bank', reference: 'TT-55' })
    row = (await listDispatches(f.worker, { from: D2, to: D2 }))[0]
    expect(row).toMatchObject({ balance: 0, paymentStatus: 'paid' })
    expect(await outstandingTotal(f.worker)).toBe(0)
    expect(await listDispatches(f.worker, { from: D2, to: D2, unpaidOnly: true })).toHaveLength(0)
    await cancelDispatch(f.admin, id, 'Customer returned the load')
    expect(await eggStock(f.worker)).toEqual({ good: 1700, cracked: 30 })
  })

  it('daily series and the whole-farm flow agree with the records', async () => {
    const { f, shop } = await farmWithEggs()
    await createReceipt(f.worker, { date: D2, supplierId: null, invoiceNo: null, vehicle: null, notes: null, lines: [{ itemId: f.feedId, quantity: 1000, unitCost: 150, batchNo: null, expiryDate: null }] })
    await saveFeed(f.worker, { date: D1, cageId: f.cageIds[0], itemId: f.feedId, batchNo: null, openingStock: null, issued: 115, returned: 0, wasted: 0, measuredConsumption: null, closingStock: null, notes: null }, null)
    await createDispatch(f.worker, dispatch(shop, 1000, { amountPaid: 45000 }))
    const s = await salesSeries(f.worker, D1, D2)
    expect(s[0]).toMatchObject({ collectedGood: 1700, dispatchedGood: 0, stockGood: 1700, stockCracked: 30 })
    expect(s[1]).toMatchObject({ dispatchedGood: 1000, revenue: 45000, received: 45000, stockGood: 700 })
    const p = await purchasesSeries(f.worker, D1, D2)
    expect(p[0]).toMatchObject({ feedIssuedKg: 115, feedStockKg: 4885 })
    expect(p[1]).toMatchObject({ feedKg: 1000, cost: 150000, feedStockKg: 5885 })
    const flow = await flowSummary(f.worker, D1, D2)
    expect(flow.feed).toMatchObject({ openingKg: 5000, receivedKg: 1000, issuedKg: 115, closingKg: 5885, purchaseCost: 150000 })
    expect(flow.eggs).toMatchObject({ collected: 1730, good: 1700, cracked: 30, dispatchedGood: 1000, openingGood: 0, closingGood: 700 })
    expect(flow.money).toMatchObject({ sales: 45000, received: 45000, outstanding: 0 })
    expect(flow.topCustomers[0]).toMatchObject({ name: 'Kurunegala Egg Centre', eggs: 1000 })
  })
})

describe('admin portal: database monitoring', () => {
  it('reports database health, runs integrity checks and summarises activity', async () => {
    const f = await makeFarm()
    const ctx: Ctx = f.admin
    expect(await code(() => dbInfo(f.worker, ':memory:'))).toBe('admin_only')
    const info = await dbInfo(ctx, ':memory:')
    expect(info.schemaVersion).toBeGreaterThanOrEqual(3)
    expect(info.tables.find((t) => t.name === 'cages')!.rows).toBe(10)
    expect(info.lastCheck).toBeNull()
    expect(await checkDatabase(ctx)).toEqual({ ok: true, message: 'ok' })
    expect((await dbInfo(ctx, ':memory:')).lastCheck).toMatchObject({ ok: true })
    const act = await activitySummary(ctx, '2026-03-10', '2026-03-10')
    expect(act.byDay[0].logins).toBeGreaterThanOrEqual(2)
    expect(act.byUser.find((u) => u.username === 'admin')!.changes).toBeGreaterThan(0)
  })
})
