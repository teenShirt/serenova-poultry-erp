import { describe, expect, it } from 'vitest'
import { API_KIND, type ApiMethod } from '@shared/api'
import { createHandlers, dispatch, loadSessionUser, type PublicCtx } from '../src/server/api'
import type { ServerConfig } from '../src/server/config'
import type { Ctx } from '../src/server/context'
import type { Databases } from '../src/server/databases'
import { dumpDatabase } from '../src/server/services/backup'
import { startDay } from '../src/server/services/days'
import { saveEggs } from '../src/server/services/eggs'
import { saveFeed } from '../src/server/services/feed'
import { addMovement } from '../src/server/services/flock'
import { saveWater } from '../src/server/services/water'
import { addHealthEvent, addTreatment } from '../src/server/services/medicine'
import { listBatches } from '../src/server/services/inventory'
import { saveParty } from '../src/server/services/parties'
import { createReceipt } from '../src/server/services/purchases'
import { adjustEggStore, createDispatch } from '../src/server/services/sales'
import { updateUser } from '../src/server/services/auth'
import { placeFlock, saveFlock, saveHouse, saveReminder } from '../src/server/services/flocks'
import { mainStore } from '../src/server/services/inventory'
import { createOrder } from '../src/server/services/purchases'
import { countStock, saveWarehouse } from '../src/server/services/stores'
import { saveTask } from '../src/server/services/tasks'
import { RestoreTokens } from '../src/server/uploads'
import { makeFarm, NOW } from './helpers'

const D = '2026-03-09'

/** The real API handlers, as the web server runs them (without the demonstration database). */
function api(db: Ctx['db']) {
  const dbs = { demoAvailable: false, location: () => 'test', with: <T>(_m: string, fn: (d: typeof db) => Promise<T>) => fn(db) } as unknown as Databases
  const cfg = { setupKey: null, backupDir: 'unused' } as unknown as ServerConfig
  const handlers = createHandlers({ cfg, dbs, restoreTokens: new RestoreTokens() })
  return (ctx: Ctx, method: ApiMethod, input: unknown) => {
    const pc: PublicCtx = { ...ctx, mode: 'farm', session: {} }
    return dispatch(handlers, method, input, pc)
  }
}

/** Organization A with one of every kind of record, and organization B in the same database. */
async function twoOrganizations() {
  const a = await makeFarm({ name: 'Farm A', domain: 'a.farm' })
  const b = await makeFarm({ db: a.db, name: 'Farm B', domain: 'b.farm' })
  for (const f of [a, b]) await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
  const cage = a.cageIds[0]
  const egg = await saveEggs(a.worker, { date: D, cageId: cage, session: 'morning', collectedAt: '08:00', good: 800, damaged: 5, rejected: 0, notes: null }, null)
  const feed = await saveFeed(a.worker, { date: D, cageId: cage, itemId: a.feedId, batchNo: null, openingStock: null, issued: 100, returned: 0, wasted: 0, measuredConsumption: null, closingStock: null, notes: null }, null)
  const water = await saveWater(a.worker, { date: D, cageId: cage, method: 'meter', openingReading: 100, closingReading: 300, litres: null, meterReset: false, correctionReason: null, notes: null }, null)
  const move = await addMovement(a.worker, { date: D, cageId: cage, type: 'death', quantity: 2, reason: null, notes: null })
  const batch = (await listBatches(a.admin, { itemId: a.medId }))[0].id
  const treatment = await addTreatment(a.worker, { date: D, cageId: cage, itemId: a.medId, batchId: batch, quantity: 10, administeredAt: null, reason: 'Vet instruction', prescribedBy: null, notes: null })
  const health = await addHealthEvent(a.worker, { date: D, cageId: cage, eventTime: null, category: 'observation', severity: 'low', description: 'Quiet birds', actionTaken: null })
  const supplier = await saveParty(a.admin, 'supplier', { id: null, name: 'A Mill', phone: null, address: null, notes: null, active: true })
  const customer = await saveParty(a.admin, 'customer', { id: null, name: 'A Buyer', phone: null, address: null, notes: null, active: true })
  const grn = await createReceipt(a.admin, { date: D, supplierId: supplier, invoiceNo: null, vehicle: null, notes: null, lines: [{ itemId: a.feedId, quantity: 50, unitCost: 100, batchNo: null, expiryDate: null }] })
  const dispatch = await createDispatch(a.admin, { date: D, customerId: customer, goodQty: 300, goodPrice: 40, crackedQty: 0, crackedPrice: 0, amountPaid: 0, paymentMethod: 'cash', invoiceNo: null, vehicle: null, driver: null, notes: null })
  await adjustEggStore(a.admin, { date: D, grade: 'good', quantity: -1, reason: 'Broken in store' })
  const flockInput = { id: null, code: 'A-Flock', breed: 'Shaver', source: 'purchased' as const, hatchDate: '2025-10-01', arrivalDate: '2026-03-01', ageOnArrivalDays: null, initialCount: 1000, notes: null }
  const house = await saveHouse(a.admin, { id: null, code: 'AH', name: 'A House', active: true, sortOrder: 1, notes: null })
  const flk = await saveFlock(a.admin, flockInput)
  await placeFlock(a.admin, flk, [cage], '2026-03-01')
  const bFlock = await saveFlock(b.admin, { ...flockInput, code: 'B-Flock' })
  const reminder = await saveReminder(a.admin, { id: null, atWeek: 22, title: 'A reminder', instructions: null, active: true })
  const aMain = await mainStore(a.admin)
  const bMain = await mainStore(b.admin)
  const aStore = await saveWarehouse(a.admin, { id: null, code: 'ACOLD', name: 'A Cold Room', active: true, notes: null })
  const po = await createOrder(a.admin, { orderDate: D, expectedDate: null, supplierId: supplier, warehouseId: aMain, notes: null, lines: [{ itemId: a.feedId, quantity: 10, unitCost: 1 }] })
  await countStock(a.admin, { warehouseId: aMain, date: D, notes: 'A count', lines: [{ itemId: a.feedId, batchId: null, countedQty: 4900 }] })
  const taskBase = { category: 'cleaning' as const, priority: 'normal' as const, instructions: null, completionCriteria: null, houseId: null, startDate: D, dueDate: D, recurrence: 'none' as const, untilDate: null }
  const task = await saveTask(a.admin, { ...taskBase, id: null, title: 'A task', farmId: a.farm, assigneeUserId: a.worker.user!.id, assigneeRoleId: null })
  const ids = {
    cage, egg, feed, water, move, batch, treatment, health, supplier, customer, grn: grn.id, dispatch: dispatch.id, admin: a.admin.user!.id, worker: a.worker.user!.id,
    house, flock: flk, bFlock, reminder, flockInput, aMain, bMain, aStore, po: po.id, task, taskBase
  }
  return { a, b, ids }
}

const cage = { code: 'X', name: 'X', initialHens: 1, capacity: null, hasWaterMeter: false, active: true, sortOrder: 1, notes: null }

describe('tenant isolation (through the API, as the web server runs it)', () => {
  it("rejects every attempt by another organization's administrator to change A's records", async () => {
    const { a, b, ids } = await twoOrganizations()
    const call = api(a.db)
    const before = await dumpDatabase(a.db, { orgId: a.org })

    // Every input below names one of organization A's records; B's administrator sends them all.
    const attacks: [ApiMethod, unknown][] = [
      ['users.update', { id: ids.admin, email: 'x@b.farm', displayName: 'Taken over', roleId: b.roles.worker, active: false }],
      ['users.update', { id: b.worker.user!.id, email: 'worker@b.farm', displayName: 'W', roleId: a.roles.admin, active: true }],
      ['users.create', { email: 'spy@b.farm', displayName: 'Spy', password: 'secret123', roleId: a.roles.admin }],
      ['roles.save', { id: a.roles.worker, name: 'Taken over', description: null, permissions: [] }],
      ['roles.archive', { id: a.roles.worker }],
      ['users.resetPassword', { id: ids.admin, password: 'hacked123' }],
      ['users.approve', { id: ids.worker, roleId: b.roles.admin }],
      ['users.reject', { id: ids.worker }],
      ['users.newRecoveryCode', { id: ids.admin }],
      ['users.setCages', { id: ids.worker, cages: null }],
      ['users.setCages', { id: b.worker.user!.id, cages: [ids.cage] }],
      ['cages.update', { id: ids.cage, cage, reason: null }],
      ['days.correctOpening', { date: D, cageId: ids.cage, opening: 1, reason: 'Taken over' }],
      ['days.confirmMortality', { date: D, cageIds: [ids.cage] }],
      ['days.confirmIssue', { date: D, cageId: ids.cage, key: 'missing_feed', reason: 'Taken over' }],
      ['eggs.save', { expectedId: null, date: D, cageId: ids.cage, session: 'evening', collectedAt: null, good: 1, damaged: 0, rejected: 0, notes: null }],
      ['eggs.save', { expectedId: ids.egg, date: D, cageId: ids.cage, session: 'morning', collectedAt: null, good: 1, damaged: 0, rejected: 0, notes: null }],
      ['eggs.delete', { id: ids.egg, reason: 'Taken over' }],
      ['flock.add', { date: D, cageId: ids.cage, type: 'death', quantity: 1, reason: null, notes: null }],
      ['flock.transfer', { date: D, fromCageId: b.cageIds[0], toCageId: ids.cage, quantity: 1, reason: null, notes: null }],
      ['flock.transfer', { date: D, fromCageId: ids.cage, toCageId: b.cageIds[0], quantity: 1, reason: null, notes: null }],
      ['flock.delete', { id: ids.move, reason: 'Taken over' }],
      ['feed.save', { expectedId: null, date: D, cageId: ids.cage, itemId: b.feedId, batchNo: null, openingStock: null, issued: 1, returned: 0, wasted: 0, measuredConsumption: null, closingStock: null, notes: null }],
      ['feed.save', { expectedId: null, date: D, cageId: b.cageIds[0], itemId: a.feedId, batchNo: null, openingStock: null, issued: 1, returned: 0, wasted: 0, measuredConsumption: null, closingStock: null, notes: null }],
      ['feed.delete', { id: ids.feed, reason: 'Taken over' }],
      ['water.save', { expectedId: null, date: D, cageId: ids.cage, method: 'manual', openingReading: null, closingReading: null, litres: 1, meterReset: false, correctionReason: null, notes: null }],
      ['water.delete', { id: ids.water, reason: 'Taken over' }],
      ['medicine.addTreatment', { date: D, cageId: b.cageIds[0], itemId: a.medId, batchId: ids.batch, quantity: 1, administeredAt: null, reason: 'Taken over', prescribedBy: null, notes: null }],
      ['medicine.addTreatment', { date: D, cageId: ids.cage, itemId: b.medId, batchId: null, quantity: 1, administeredAt: null, reason: 'Taken over', prescribedBy: null, notes: null }],
      ['medicine.deleteTreatment', { id: ids.treatment, reason: 'Taken over' }],
      ['medicine.addHealthEvent', { date: D, cageId: ids.cage, eventTime: null, category: 'x', severity: 'low', description: 'Taken over', actionTaken: null }],
      ['medicine.deleteHealthEvent', { id: ids.health, reason: 'Taken over' }],
      ['inventory.updateItem', { id: a.feedId, item: { category: 'feed', name: 'Taken over', unit: 'kg', lowStockThreshold: null, active: false, notes: null } }],
      ['inventory.record', { itemId: a.feedId, type: 'issue', quantity: 1, date: D, batchNo: null, expiryDate: null, unitCost: null, supplier: null, reference: null, notes: null, cageId: null }],
      ['inventory.record', { itemId: b.feedId, type: 'issue', quantity: 1, date: D, batchNo: null, expiryDate: null, unitCost: null, supplier: null, reference: null, notes: null, cageId: ids.cage }],
      ['parties.saveSupplier', { id: ids.supplier, name: 'Taken over', phone: null, address: null, notes: null, active: false }],
      ['parties.saveCustomer', { id: ids.customer, name: 'Taken over', phone: null, address: null, notes: null, active: false }],
      ['purchases.create', { date: D, supplierId: ids.supplier, invoiceNo: null, vehicle: null, notes: null, lines: [{ itemId: b.feedId, quantity: 1, unitCost: null, batchNo: null, expiryDate: null }] }],
      ['purchases.create', { date: D, supplierId: null, invoiceNo: null, vehicle: null, notes: null, lines: [{ itemId: a.feedId, quantity: 1, unitCost: null, batchNo: null, expiryDate: null }] }],
      ['purchases.cancel', { id: ids.grn, reason: 'Taken over' }],
      ['sales.dispatch', { date: D, customerId: ids.customer, goodQty: 1, goodPrice: 1, crackedQty: 0, crackedPrice: 0, amountPaid: 0, paymentMethod: 'cash', invoiceNo: null, vehicle: null, driver: null, notes: null }],
      ['sales.addPayment', { dispatchId: ids.dispatch, date: D, amount: 1, method: 'cash', reference: null }],
      ['sales.cancel', { id: ids.dispatch, reason: 'Taken over' }],
      ['houses.save', { id: ids.house, code: 'X', name: 'Taken over', active: false, sortOrder: 1, notes: null }],
      ['cages.update', { id: b.cageIds[0], cage: { ...cage, code: 'BX', initialHens: 1000, houseId: ids.house }, reason: null }],
      ['farms.save', { id: a.farm, name: 'Taken over', location: null }],
      ['farms.setStatus', { id: a.farm, status: 'archived', reason: 'Taken over' }],
      ['farms.switch', { id: a.farm }],
      ['flocks.get', { id: ids.flock }],
      ['flocks.save', { ...ids.flockInput, id: ids.flock, code: 'Taken over' }],
      ['flocks.place', { id: ids.flock, cageIds: [b.cageIds[1]], fromDate: D }],
      ['flocks.place', { id: ids.bFlock, cageIds: [ids.cage], fromDate: D }],
      ['flocks.endPlacement', { id: ids.flock, cageId: ids.cage, toDate: D }],
      ['flocks.close', { id: ids.flock, date: D, reason: 'Taken over' }],
      ['flocks.series', { id: ids.flock, from: D, to: D }],
      ['flocks.saveReminder', { id: ids.reminder, atWeek: 1, title: 'Taken over', instructions: null, active: false }],
      ['flocks.markReminder', { flockId: ids.flock, reminderId: ids.reminder, outcome: 'done', note: null }],
      ['flocks.markReminder', { flockId: ids.bFlock, reminderId: ids.reminder, outcome: 'done', note: null }],
      ['stores.save', { id: ids.aStore, code: 'X', name: 'Taken over', active: false, notes: null }],
      ['stores.balances', { warehouseId: ids.aMain }],
      ['stores.transfer', { date: D, fromWarehouseId: ids.aMain, toWarehouseId: ids.bMain, notes: null, lines: [{ itemId: b.feedId, batchNo: null, quantity: 1 }] }],
      ['stores.transfer', { date: D, fromWarehouseId: ids.bMain, toWarehouseId: ids.aStore, notes: null, lines: [{ itemId: b.feedId, batchNo: null, quantity: 1 }] }],
      ['stores.count', { warehouseId: ids.aMain, date: D, notes: null, lines: [{ itemId: b.feedId, batchId: null, countedQty: 1 }] }],
      ['inventory.record', { itemId: b.feedId, type: 'issue', quantity: 1, date: D, batchNo: null, expiryDate: null, unitCost: null, supplier: null, reference: null, notes: null, cageId: null, warehouseId: ids.aMain }],
      ['purchases.createOrder', { orderDate: D, expectedDate: null, supplierId: ids.supplier, warehouseId: ids.bMain, notes: null, lines: [{ itemId: b.feedId, quantity: 1, unitCost: null }] }],
      ['purchases.createOrder', { orderDate: D, expectedDate: null, supplierId: ids.supplier, warehouseId: ids.aMain, notes: null, lines: [{ itemId: b.feedId, quantity: 1, unitCost: null }] }],
      ['purchases.closeOrder', { id: ids.po, status: 'cancelled', reason: 'Taken over' }],
      ['purchases.create', { date: D, supplierId: null, invoiceNo: null, vehicle: null, notes: null, poId: ids.po, lines: [{ itemId: b.feedId, quantity: 1, unitCost: null, batchNo: null, expiryDate: null }] }],
      ['purchases.create', { date: D, supplierId: null, invoiceNo: null, vehicle: null, notes: null, warehouseId: ids.aMain, lines: [{ itemId: b.feedId, quantity: 1, unitCost: null, batchNo: null, expiryDate: null }] }],
      ['purchases.approve', { id: ids.grn }],
      ['purchases.reject', { id: ids.grn, reason: 'Taken over' }],
      ['tasks.get', { id: ids.task }],
      ['tasks.action', { id: ids.task, action: 'cancel', note: 'Taken over' }],
      ['tasks.save', { ...ids.taskBase, id: ids.task, title: 'Taken over', farmId: null, assigneeUserId: null, assigneeRoleId: null }],
      ['tasks.save', { ...ids.taskBase, id: null, title: 'Spy', farmId: null, assigneeUserId: ids.worker, assigneeRoleId: null }],
      ['tasks.save', { ...ids.taskBase, id: null, title: 'Spy', farmId: a.farm, assigneeUserId: null, assigneeRoleId: null }],
      ['tasks.save', { ...ids.taskBase, id: null, title: 'Spy', farmId: null, houseId: ids.house, assigneeUserId: null, assigneeRoleId: null }],
      ['tasks.save', { ...ids.taskBase, id: null, title: 'Spy', farmId: null, assigneeUserId: null, assigneeRoleId: a.roles.worker }]
    ]
    for (const [method, input] of attacks) {
      const r = await call(b.admin, method, input)
      // Refused because the record is not B's (not for some unrelated reason such as invalid input).
      expect(r.ok ? 'accepted' : r.code, `${method} ${JSON.stringify(input)}`).toMatch(/^(not_found|cage_not_found|cage_not_in_day|item_not_found|issue_not_confirmable|role_not_found|house_not_found|farm_not_found|flock_not_found|store_not_found|task_not_found)$/)
    }
    // Organization A's records are exactly as they were.
    const after = await dumpDatabase(a.db, { orgId: a.org })
    for (const t of Object.keys(before.tables)) expect(after.tables[t], t).toEqual(before.tables[t])
  })

  it("never shows another organization's records, whatever ids are asked for", async () => {
    const { a, b, ids } = await twoOrganizations()
    const call = api(a.db)
    const data = async (method: ApiMethod, input: unknown) => {
      const r = await call(b.admin, method, input)
      if (!r.ok) throw new Error(`${method}: ${r.code}`)
      return r.data as never
    }
    const json = async (method: ApiMethod, input: unknown) => JSON.stringify(await data(method, input))
    const range = { from: '2026-03-01', to: '2026-03-10' }
    for (const [method, input] of [
      ['users.list', undefined],
      ['cages.list', {}],
      ['inventory.items', {}],
      ['inventory.balances', {}],
      ['parties.list', { kind: 'supplier' }],
      ['parties.list', { kind: 'customer' }],
      ['purchases.list', range],
      ['sales.list', range],
      ['audit.list', {}],
      ['reports.recent', undefined],
      ['farms.list', undefined],
      ['houses.list', undefined],
      ['flocks.list', {}],
      ['flocks.reminders', undefined],
      ['flocks.dueReminders', undefined],
      ['stores.list', {}],
      ['stores.balances', {}],
      ['stores.counts', range],
      ['purchases.orders', {}],
      ['tasks.list', range],
      ['tasks.assignees', undefined],
      ['inventory.txns', {}],
      ['stores.movements', { ...range, page: 1 }],
      ['stores.movements', { ...range, page: 1, warehouseId: ids.aMain, itemId: a.feedId }],
      ['overview.organization', range]
    ] as [ApiMethod, unknown][]) {
      const text = await json(method, input)
      for (const secret of ['a.farm', 'A Mill', 'A Buyer', 'Farm A', 'A-Flock', 'A House', 'A reminder', 'A Cold Room', 'A task', 'A count']) expect(text, `${method} shows ${secret}`).not.toContain(secret)
    }
    // Asking for A's records by id gives nothing.
    expect(await data('eggs.list', { date: D, cageId: ids.cage })).toEqual([])
    expect(await data('feed.list', { date: D, cageId: ids.cage })).toEqual([])
    expect(await data('flock.list', { date: D, cageId: ids.cage })).toEqual([])
    expect(await data('flock.listRange', { ...range, cageId: ids.cage })).toEqual([])
    expect(await data('medicine.treatments', { ...range, cageId: ids.cage })).toEqual([])
    expect(await data('medicine.healthEvents', { ...range, cageId: ids.cage })).toEqual([])
    expect(await data('inventory.batches', { itemId: a.medId })).toEqual([])
    expect(await data('inventory.txns', { itemId: a.feedId })).toEqual([])
    expect(await data('feed.suggestOpening', { date: '2026-03-10', cageId: ids.cage, itemId: a.feedId })).toBeNull()
    expect(await data('water.suggestOpening', { date: '2026-03-10', cageId: ids.cage })).toBeNull()
    expect(await data('sales.stock', undefined)).toMatchObject({ good: 0, cracked: 0, outstanding: 0 })
    const series = (await data('analytics.series', { ...range, cageId: ids.cage })) as { eggs: number }[]
    expect(series.reduce((s, p) => s + p.eggs, 0)).toBe(0)
    // B's own day shows only B's (empty) records; A's eggs are not counted anywhere for B.
    const ov = (await data('days.overview', { date: D })) as { totals: { eggs: { collected: number } }; cages: { cageId: number }[] }
    expect(ov.totals.eggs.collected).toBe(0)
    expect(ov.cages.map((c) => c.cageId).sort()).toEqual([...b.cageIds].sort())
    const preview = (await data('reports.preview', { kind: 'day_open', date: D })) as { html: string }
    expect(preview.html).toContain('Farm B')
    expect(preview.html).not.toContain('Farm A')
    const info = (await data('admin.dbInfo', undefined)) as { tables: { name: string; rows: number }[] }
    expect(info.tables.find((t) => t.name === 'egg_collections')!.rows).toBe(0)
  })

  it('a session only works for its own organization, and stops working when the account is disabled', async () => {
    const { a, b } = await twoOrganizations()
    // A session that claims A's user belongs to organization B (a tampered session) has no user.
    expect(await loadSessionUser(a.admin, a.admin.user!.id, b.org)).toBeNull()
    expect(await loadSessionUser(a.admin, a.worker.user!.id, a.org)).toMatchObject({ email: 'worker@a.farm' })
    await updateUser(a.admin, { id: a.worker.user!.id, email: 'worker@a.farm', displayName: 'Worker', roleId: a.roles.worker, active: false })
    expect(await loadSessionUser(a.admin, a.worker.user!.id, a.org)).toBeNull()
    // Signed out: nothing but the public requests works.
    const r = await api(a.db)({ ...a.worker, user: null }, 'eggs.list', { date: D })
    expect(r).toMatchObject({ ok: false, code: 'not_logged_in' })
    void NOW
  })

  it('every API method has been considered for tenant isolation', () => {
    // Methods whose input names no record (they work on the signed-in organization and farm only),
    // and methods covered by the attack and visibility tests above.
    const noRecordIds: ApiMethod[] = [
      'app.status', 'app.setLanguage', 'setup.complete', 'demo.enter', 'demo.exit', 'demo.reset', 'auth.login', 'auth.logout',
      'auth.changePassword', 'auth.signup', 'auth.resetWithCode', 'auth.newRecoveryCode', 'roles.list', 'settings.get', 'settings.save',
      'cages.create', 'days.preview', 'days.start', 'days.list', 'days.latest', 'days.revokeConfirmation',
      'days.saveComment', 'days.close', 'days.startAmendment', 'days.finishAmendment', 'days.amendments', 'water.list',
      'inventory.createItem', 'analytics.dashboard', 'analytics.comparison', 'reports.print', 'duties.mine', 'purchases.series',
      'sales.adjust', 'sales.adjustments', 'sales.series', 'supply.flow', 'admin.checkDb', 'admin.optimize', 'admin.activity',
      'backup.list', 'backup.create', 'backup.restore', 'tasks.report'
    ]
    const covered: ApiMethod[] = [
      'users.list', 'users.update', 'users.resetPassword', 'users.approve', 'users.reject', 'users.newRecoveryCode', 'users.setCages', 'users.create', 'roles.save', 'roles.archive',
      'cages.list', 'cages.update', 'days.overview', 'days.correctOpening', 'days.confirmMortality', 'days.confirmIssue', 'eggs.list', 'eggs.save', 'eggs.delete',
      'flock.list', 'flock.listRange', 'flock.add', 'flock.transfer', 'flock.delete', 'feed.list', 'feed.suggestOpening', 'feed.save',
      'feed.delete', 'water.suggestOpening', 'water.save', 'water.delete', 'medicine.treatments', 'medicine.addTreatment',
      'medicine.deleteTreatment', 'medicine.healthEvents', 'medicine.addHealthEvent', 'medicine.deleteHealthEvent', 'inventory.items',
      'inventory.updateItem', 'inventory.balances', 'inventory.batches', 'inventory.txns', 'inventory.record', 'analytics.series',
      'audit.list', 'reports.preview', 'reports.recent', 'parties.list', 'parties.saveSupplier', 'parties.saveCustomer',
      'purchases.list', 'purchases.create', 'purchases.cancel', 'sales.stock', 'sales.list', 'sales.dispatch', 'sales.addPayment',
      'sales.cancel', 'admin.dbInfo', 'farms.list', 'farms.save', 'farms.setStatus', 'farms.switch', 'houses.list', 'houses.save', 'flocks.list', 'flocks.get',
      'flocks.save', 'flocks.place', 'flocks.endPlacement', 'flocks.close', 'flocks.series', 'flocks.reminders', 'flocks.saveReminder', 'flocks.dueReminders',
      'flocks.markReminder', 'stores.list', 'stores.save', 'stores.balances', 'stores.transfer', 'stores.count', 'stores.counts', 'purchases.orders',
      'purchases.createOrder', 'purchases.closeOrder', 'purchases.approve', 'purchases.reject', 'tasks.list', 'tasks.get', 'tasks.save', 'tasks.action',
      'tasks.assignees', 'stores.movements', 'overview.organization'
    ]
    // The console's platform.* requests are only for platform administrators (tests/subscriptions.test.ts).
    const all = (Object.keys(API_KIND) as ApiMethod[]).filter((m) => !m.startsWith('platform.'))
    expect(all.filter((m) => !noRecordIds.includes(m) && !covered.includes(m))).toEqual([])
  })
})
