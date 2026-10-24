import { describe, expect, it } from 'vitest'
import type { ApiMethod } from '@shared/api'
import { createHandlers, dispatch, type PublicCtx } from '../src/server/api'
import type { ServerConfig } from '../src/server/config'
import type { Ctx } from '../src/server/context'
import type { Databases } from '../src/server/databases'
import { startDay } from '../src/server/services/days'
import { saveFeed } from '../src/server/services/feed'
import { itemBalance, mainStore, recordTxn } from '../src/server/services/inventory'
import { saveParty } from '../src/server/services/parties'
import { approveReceipt, cancelReceipt, createOrder, createReceipt, listOrders, listReceipts } from '../src/server/services/purchases'
import { saveSettings } from '../src/server/services/settings'
import { countStock, saveWarehouse, storeBalances, transferStock } from '../src/server/services/stores'
import { listTasks, saveTask, taskAction, taskReport } from '../src/server/services/tasks'
import { RestoreTokens } from '../src/server/uploads'
import { makeFarm } from './helpers'

const D = '2026-03-09'
const TODAY = '2026-03-10'

function api(db: Ctx['db']) {
  const dbs = { demoAvailable: false, location: () => 'test', with: <T>(_m: string, fn: (d: typeof db) => Promise<T>) => fn(db) } as unknown as Databases
  const handlers = createHandlers({ cfg: { setupKey: null, backupDir: 'unused' } as unknown as ServerConfig, dbs, restoreTokens: new RestoreTokens() })
  return (ctx: Ctx, method: ApiMethod, input?: unknown) => dispatch(handlers, method, input, { ...ctx, mode: 'farm', session: {} } as PublicCtx)
}

const store = (f: { admin: Ctx }) => mainStore(f.admin)

describe('stores', () => {
  it('holds stock per store: transfers move it as a matched pair, never below zero', async () => {
    const f = await makeFarm()
    const main = await store(f)
    const cold = await saveWarehouse(f.admin, { id: null, code: 'COLD', name: 'Cold room', active: true, notes: null })
    expect(await itemBalance(f.admin, f.medId, undefined, { warehouseId: main })).toBe(1000)

    const ref = await transferStock(f.admin, {
      date: D,
      fromWarehouseId: main,
      toWarehouseId: cold,
      notes: null,
      lines: [{ itemId: f.medId, batchNo: 'VM-01', quantity: 400 }]
    })
    expect(ref).toBe('TRF-20260309-001')
    expect(await itemBalance(f.admin, f.medId, undefined, { warehouseId: main })).toBe(600)
    expect(await itemBalance(f.admin, f.medId, undefined, { warehouseId: cold })).toBe(400)
    expect(await itemBalance(f.admin, f.medId)).toBe(1000)
    await expect(
      transferStock(f.admin, { date: D, fromWarehouseId: cold, toWarehouseId: main, notes: null, lines: [{ itemId: f.medId, batchNo: null, quantity: 401 }] })
    ).rejects.toMatchObject({
      code: 'insufficient_stock'
    })
    // Issues from one store cannot use another store's stock.
    await expect(
      recordTxn(f.admin, {
        itemId: f.medId,
        type: 'issue',
        quantity: 700,
        date: D,
        batchNo: null,
        expiryDate: null,
        unitCost: null,
        supplier: null,
        reference: null,
        notes: null,
        cageId: null
      })
    ).rejects.toMatchObject({ code: 'insufficient_stock' })
    // Daily feed records draw from the farm's main store.
    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
    await saveFeed(
      f.worker,
      {
        date: D,
        cageId: f.cageIds[0],
        itemId: f.feedId,
        batchNo: null,
        openingStock: null,
        issued: 120,
        returned: 0,
        wasted: 0,
        measuredConsumption: null,
        closingStock: null,
        notes: null
      },
      null
    )
    expect(await itemBalance(f.admin, f.feedId, undefined, { warehouseId: main })).toBe(4880)

    // A store with stock cannot be closed; the main store never.
    await expect(saveWarehouse(f.admin, { id: cold, code: 'COLD', name: 'Cold room', active: false, notes: null })).rejects.toMatchObject({
      code: 'store_has_stock'
    })
    await expect(saveWarehouse(f.admin, { id: main, code: 'MAIN', name: 'Main', active: false, notes: null })).rejects.toMatchObject({
      code: 'main_store_required'
    })
  })

  it('a stock count posts the difference as a correction, keeping the history', async () => {
    const f = await makeFarm()
    const main = await store(f)
    await countStock(f.admin, { warehouseId: main, date: TODAY, notes: 'Monthly count', lines: [{ itemId: f.feedId, batchId: null, countedQty: 4950.5 }] })
    expect(await itemBalance(f.admin, f.feedId)).toBe(4950.5)
    const txns = (await f.db.prepare('SELECT type, quantity FROM inventory_transactions WHERE item_id = ? ORDER BY id').all(f.feedId)) as {
      type: string
      quantity: number
    }[]
    expect(txns).toEqual([
      { type: 'opening', quantity: 5000 },
      { type: 'count', quantity: -49.5 }
    ])
    expect(
      await api(f.db)(f.worker, 'stores.count', { warehouseId: main, date: TODAY, notes: null, lines: [{ itemId: f.feedId, batchId: null, countedQty: 1 }] })
    ).toMatchObject({
      ok: false,
      code: 'no_permission'
    })
  })

  it('values stock at the average purchase cost and keeps to the plan’s store limit', async () => {
    const f = await makeFarm({ plan: 'growth' })
    const main = await store(f)
    await recordTxn(f.admin, {
      itemId: f.feedId,
      type: 'purchase',
      quantity: 1000,
      date: D,
      batchNo: null,
      expiryDate: null,
      unitCost: 100,
      supplier: null,
      reference: null,
      notes: null,
      cageId: null
    })
    await recordTxn(f.admin, {
      itemId: f.feedId,
      type: 'purchase',
      quantity: 1000,
      date: D,
      batchNo: null,
      expiryDate: null,
      unitCost: 120,
      supplier: null,
      reference: null,
      notes: null,
      cageId: null
    })
    const feed = (await storeBalances(f.admin, { warehouseId: main })).find((b) => b.itemId === f.feedId)!
    expect(feed).toMatchObject({ balance: 7000, avgCost: 110, value: 770000 })
    await saveWarehouse(f.admin, { id: null, code: 'S2', name: 'Second', active: true, notes: null })
    await saveWarehouse(f.admin, { id: null, code: 'S3', name: 'Third', active: true, notes: null })
    await expect(saveWarehouse(f.admin, { id: null, code: 'S4', name: 'Fourth', active: true, notes: null })).rejects.toMatchObject({
      code: 'store_limit_reached',
      params: { limit: 3 }
    })
  })
})

describe('purchase orders and goods received notes', () => {
  async function setup() {
    const f = await makeFarm()
    const supplier = await saveParty(f.admin, 'supplier', { id: null, name: 'Mill', phone: null, address: null, notes: null, active: true })
    const main = await store(f)
    const po = await createOrder(f.admin, {
      orderDate: D,
      expectedDate: TODAY,
      supplierId: supplier,
      warehouseId: main,
      notes: null,
      lines: [{ itemId: f.feedId, quantity: 1000, unitCost: 150 }]
    })
    const [order] = await listOrders(f.admin)
    return { f, supplier, main, po, line: order.lines[0].id }
  }

  it('receives against an order in parts, records rejects, refuses more than ordered', async () => {
    const { f, po, line } = await setup()
    const base = { date: TODAY, supplierId: null, invoiceNo: 'INV-1', vehicle: null, notes: null, poId: po.id }
    const r1 = await createReceipt(f.admin, {
      ...base,
      lines: [
        {
          itemId: f.feedId,
          poLineId: line,
          quantity: 650,
          rejectedQty: 40,
          damagedQty: 10,
          rejectReason: 'Wet bags',
          unitCost: 150,
          batchNo: null,
          expiryDate: null
        }
      ]
    })
    expect(r1.status).toBe('posted')
    expect(await itemBalance(f.admin, f.feedId)).toBe(5600)
    expect((await listOrders(f.admin))[0]).toMatchObject({ status: 'partial', lines: [{ received: 600 }] })
    await expect(
      createReceipt(f.admin, { ...base, lines: [{ itemId: f.feedId, poLineId: line, quantity: 401, unitCost: 150, batchNo: null, expiryDate: null }] })
    ).rejects.toMatchObject({ code: 'over_receipt', params: { outstanding: 400 } })
    await expect(
      createReceipt(f.admin, {
        ...base,
        lines: [{ itemId: f.feedId, poLineId: line, quantity: 10, rejectedQty: 5, unitCost: 150, batchNo: null, expiryDate: null }]
      })
    ).rejects.toMatchObject({ code: 'reason_required' })
    await createReceipt(f.admin, { ...base, lines: [{ itemId: f.feedId, poLineId: line, quantity: 400, unitCost: 150, batchNo: null, expiryDate: null }] })
    expect((await listOrders(f.admin))[0].status).toBe('received')
    const [last] = await listReceipts(f.admin, TODAY, TODAY)
    expect(last).toMatchObject({ poNo: po.poNo, supplierName: 'Mill', lines: [{ orderedQty: 1000 }] })
  })

  it('the same form sent twice is recorded once', async () => {
    const { f } = await setup()
    const r = {
      date: TODAY,
      supplierId: null,
      invoiceNo: null,
      vehicle: null,
      notes: null,
      clientRef: 'form-123',
      lines: [{ itemId: f.feedId, quantity: 100, unitCost: null, batchNo: null, expiryDate: null }]
    }
    const a = await createReceipt(f.admin, r)
    const b = await createReceipt(f.admin, r)
    expect(b).toEqual(a)
    expect(await itemBalance(f.admin, f.feedId)).toBe(5100)
  })

  it('with approval required, stock is posted once on approval by someone else', async () => {
    const { f } = await setup()
    await saveSettings(f.admin, { grnApprovalRequired: true })
    const call = api(f.db)
    const r = await createReceipt(f.admin, {
      date: TODAY,
      supplierId: null,
      invoiceNo: null,
      vehicle: null,
      notes: null,
      lines: [{ itemId: f.feedId, quantity: 100, unitCost: null, batchNo: null, expiryDate: null }]
    })
    expect(r.status).toBe('submitted')
    expect(await itemBalance(f.admin, f.feedId)).toBe(5000)
    // The worker may not approve; the administrator may (even their own note).
    expect(await call(f.worker, 'purchases.approve', { id: r.id })).toMatchObject({ ok: false, code: 'no_permission' })
    await approveReceipt(f.admin, r.id)
    await expect(approveReceipt(f.admin, r.id)).rejects.toMatchObject({ code: 'receipt_not_submitted' })
    expect(await itemBalance(f.admin, f.feedId)).toBe(5100)
  })

  it('cancelling a receipt reverses its stock and keeps it in the history', async () => {
    const { f } = await setup()
    const r = await createReceipt(f.admin, {
      date: TODAY,
      supplierId: null,
      invoiceNo: null,
      vehicle: null,
      notes: null,
      lines: [{ itemId: f.feedId, quantity: 100, unitCost: 140, batchNo: null, expiryDate: null }]
    })
    await cancelReceipt(f.admin, r.id, 'Entered twice')
    expect(await itemBalance(f.admin, f.feedId)).toBe(5000)
    const [g] = await listReceipts(f.admin, TODAY, TODAY)
    expect(g).toMatchObject({ id: r.id, status: 'cancelled', cancelReason: 'Entered twice' })
    const types = (await f.db.prepare("SELECT type, quantity FROM inventory_transactions WHERE source_type = 'grn_line' ORDER BY id").all()) as {
      type: string
      quantity: number
    }[]
    expect(types).toEqual([
      { type: 'purchase', quantity: 100 },
      { type: 'reversal', quantity: -100 }
    ])
    await expect(cancelReceipt(f.admin, r.id, 'Again')).rejects.toMatchObject({ code: 'receipt_cancelled' })
  })
})

describe('tasks', () => {
  it('assigned people and teams work their tasks; managers create, verify and cancel', async () => {
    const f = await makeFarm()
    const call = api(f.db)
    const base = {
      id: null,
      category: 'cleaning' as const,
      priority: 'normal' as const,
      instructions: 'Wash the drinkers',
      completionCriteria: null,
      farmId: f.farm,
      houseId: null,
      startDate: TODAY,
      dueDate: TODAY,
      recurrence: 'none' as const,
      untilDate: null
    }
    const mine = await saveTask(f.admin, { ...base, title: 'Clean drinkers', assigneeUserId: f.worker.user!.id, assigneeRoleId: null })
    const team = await saveTask(f.admin, {
      ...base,
      title: 'Team job',
      assigneeUserId: null,
      assigneeRoleId: f.roles.worker,
      completionCriteria: 'All drinkers clean'
    })
    const other = await saveTask(f.admin, { ...base, title: 'Admin only', assigneeUserId: f.admin.user!.id, assigneeRoleId: null })

    const seen = (await listTasks(f.worker, { from: TODAY, to: TODAY })).map((t) => t.title)
    expect(seen.sort()).toEqual(['Clean drinkers', 'Team job'])
    expect(await call(f.worker, 'tasks.get', { id: other })).toMatchObject({ ok: false, code: 'task_not_found' })
    expect(await call(f.worker, 'tasks.action', { id: other, action: 'complete', note: null })).toMatchObject({ ok: false, code: 'task_not_found' })
    expect(await call(f.worker, 'tasks.save', { ...base, title: 'Mine', assigneeUserId: null, assigneeRoleId: null })).toMatchObject({
      ok: false,
      code: 'no_permission'
    })

    await taskAction(f.worker, mine, 'start', null)
    await taskAction(f.worker, mine, 'complete', null)
    await expect(taskAction(f.worker, team, 'complete', null)).rejects.toMatchObject({ code: 'completion_note_required' })
    await taskAction(f.worker, team, 'complete', 'Checked all 10 cages')
    await expect(taskAction(f.worker, mine, 'verify', null)).rejects.toMatchObject({ code: 'no_permission' })
    await taskAction(f.admin, mine, 'verify', null)
    await expect(taskAction(f.admin, other, 'cancel', null)).rejects.toMatchObject({ code: 'reason_required' })
    await taskAction(f.admin, other, 'cancel', 'Not needed')

    const detail = await call(f.admin, 'tasks.get', { id: mine })
    expect(detail.ok && (detail.data as { events: { action: string; user: string | null }[] }).events.map((e) => [e.action, e.user])).toEqual([
      ['created', 'Admin'],
      ['started', 'Worker'],
      ['completed', 'Worker'],
      ['verified', 'Admin']
    ])
    expect(await taskReport(f.admin, TODAY, TODAY, 'week')).toEqual([
      { period: '2026-03-09', total: 3, completedOnTime: 2, completedLate: 0, verified: 1, open: 0, overdue: 0, cancelled: 1 }
    ])
  })

  it('recurring tasks make one task per occurrence (once), a week ahead; overdue ones show on the dashboard', async () => {
    const f = await makeFarm()
    // Created on 2 March (a Monday), weekly.
    const first = await saveTask(f.admin, {
      id: null,
      title: 'Check water lines',
      category: 'water_system',
      priority: 'high',
      instructions: null,
      completionCriteria: null,
      farmId: f.farm,
      houseId: null,
      assigneeUserId: f.worker.user!.id,
      assigneeRoleId: null,
      startDate: '2026-03-02',
      dueDate: '2026-03-02',
      recurrence: 'weekly',
      untilDate: null
    })
    expect(first).toBeGreaterThan(0)
    await listTasks(f.admin, { from: TODAY, to: TODAY })
    await listTasks(f.admin, { from: TODAY, to: TODAY })
    const dates = ((await f.db.prepare('SELECT due_date AS d FROM tasks WHERE organization_id = ? ORDER BY due_date').all(f.org)) as { d: string }[]).map(
      (r) => r.d
    )
    expect(dates).toEqual(['2026-03-02', '2026-03-09', '2026-03-16'])
    const dash = await api(f.db)(f.worker, 'analytics.dashboard', { date: TODAY })
    expect(
      dash.ok && (dash.data as { alerts: { code: string; params: Record<string, unknown> }[] }).alerts.find((a) => a.code === 'tasks_overdue')
    ).toMatchObject({ params: { count: 2 } })
    // Monthly on the 31st falls on the last day of shorter months.
    await saveTask(f.admin, {
      id: null,
      title: 'Month end count',
      category: 'stock_count',
      priority: 'normal',
      instructions: null,
      completionCriteria: null,
      farmId: null,
      houseId: null,
      assigneeUserId: null,
      assigneeRoleId: f.roles.admin,
      startDate: '2026-01-31',
      dueDate: '2026-01-31',
      recurrence: 'monthly',
      untilDate: null
    })
    const month = ((await f.db.prepare("SELECT due_date AS d FROM tasks WHERE title = 'Month end count' ORDER BY due_date").all()) as { d: string }[]).map(
      (r) => r.d
    )
    expect(month).toEqual(['2026-02-28'])
  })
})
