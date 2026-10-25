import { describe, expect, it } from 'vitest'
import { PERMISSION_FOR_METHOD } from '@shared/permissions'
import type { ApiMethod } from '@shared/api'
import { createHandlers, dispatch, type PublicCtx } from '../src/server/api'
import type { ServerConfig } from '../src/server/config'
import type { Ctx } from '../src/server/context'
import type { Databases } from '../src/server/databases'
import { latestSchemaVersion, migrate } from '../src/server/db/migrations'
import { createUser, login } from '../src/server/services/auth'
import { dailySeries } from '../src/server/services/analytics'
import { closeDay, confirmIssue, confirmMortality, getOverview, isBlocking, startDay } from '../src/server/services/days'
import { checkAccess } from '../src/server/services/duties'
import { saveEggs } from '../src/server/services/eggs'
import { saveFeed } from '../src/server/services/feed'
import { addMovement } from '../src/server/services/flock'
import { itemBalance, mainStore } from '../src/server/services/inventory'
import { organizationOverview } from '../src/server/services/overview'
import { createPlatformUser, loadPlatformUser, platformCreateOrganization } from '../src/server/services/platform'
import { saveRole } from '../src/server/services/roles'
import { countStock, saveWarehouse, storeBalances, transferStock } from '../src/server/services/stores'
import { RestoreTokens } from '../src/server/uploads'
import { makeFarm, openTestDb } from './helpers'

const D = '2026-03-09'
const TODAY = '2026-03-10'

function api(db: Ctx['db']) {
  const dbs = { demoAvailable: false, location: () => 'test', with: <T>(_m: string, fn: (d: typeof db) => Promise<T>) => fn(db) } as unknown as Databases
  const handlers = createHandlers({
    cfg: { setupKey: null, backupDir: 'unused', environment: 'development' } as unknown as ServerConfig,
    dbs,
    restoreTokens: new RestoreTokens()
  })
  return (ctx: Ctx, method: ApiMethod, input?: unknown) => dispatch(handlers, method, input, { ...ctx, mode: 'farm', session: {} } as PublicCtx)
}

describe('acceptance: permissions are enforced for every protected request (criteria 9, 18)', () => {
  it('a member whose role allows nothing is refused every request that needs a permission', async () => {
    const f = await makeFarm()
    const roleId = await saveRole(f.admin, { id: null, name: 'Visitor', description: null, permissions: [] })
    await createUser(f.admin, { email: 'visitor@test.farm', displayName: 'Visitor', password: 'visitor123', roleId })
    const visitor = await f.signIn('visitor@test.farm', 'visitor123')
    const methods = Object.keys(PERMISSION_FOR_METHOD) as ApiMethod[]
    expect(methods.length).toBeGreaterThan(60)
    for (const m of methods) {
      await expect(checkAccess(visitor, m, {}), m).rejects.toMatchObject({ code: 'no_permission' })
    }
    // Through the API as the web server runs it (valid input, so only the permission stops it).
    const call = api(f.db)
    expect(await call(visitor, 'users.list')).toMatchObject({ ok: false, code: 'no_permission' })
    expect(await call(visitor, 'settings.save', { currency: 'X' })).toMatchObject({ ok: false, code: 'no_permission' })
    expect(await call(visitor, 'backup.create')).toMatchObject({ ok: false, code: 'no_permission' })
    expect(
      await call(visitor, 'eggs.save', {
        expectedId: null,
        date: D,
        cageId: f.cageIds[0],
        session: 'morning',
        collectedAt: null,
        good: 1,
        damaged: 0,
        rejected: 0,
        notes: null
      })
    ).toMatchObject({
      ok: false,
      code: 'no_permission'
    })
    // Reading the farm's records stays open to every member.
    expect(await call(visitor, 'cages.list', {})).toMatchObject({ ok: true })
  })
})

describe('acceptance: dashboard totals reconcile with the source records (criterion 15)', () => {
  it('eggs, deaths, feed and stock on the dashboards equal the sums of the stored records', async () => {
    const f = await makeFarm()
    f.setNow(new Date('2026-03-10T10:00:00Z'))
    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: false })
    for (const [i, c] of f.cageIds.entries()) {
      await saveEggs(
        f.worker,
        { date: D, cageId: c, session: 'morning', collectedAt: '08:00', good: 500 + i * 7, damaged: i % 3, rejected: i % 2, notes: null },
        null
      )
      await saveFeed(
        f.worker,
        {
          date: D,
          cageId: c,
          itemId: f.feedId,
          batchNo: null,
          openingStock: null,
          issued: 110 + i,
          returned: i % 2,
          wasted: 0.5,
          measuredConsumption: null,
          closingStock: null,
          notes: null
        },
        null
      )
    }
    await addMovement(f.worker, { date: D, cageId: f.cageIds[2], type: 'death', quantity: 4, reason: null, notes: null })
    await addMovement(f.worker, { date: D, cageId: f.cageIds[5], type: 'death', quantity: 2, reason: null, notes: null })
    await confirmMortality(f.worker, D, f.cageIds)
    for (const i of (await getOverview(f.admin, D)).issues.filter(isBlocking)) await confirmIssue(f.admin, D, i.cageId, i.key, 'Single collection on this day')
    await closeDay(f.admin, D, 'Reviewed')

    const q = async (sql: string) => Number(((await f.db.prepare(sql).get(f.org)) as { v: number }).v)
    const eggs = await q('SELECT SUM(good + damaged + rejected) AS v FROM egg_collections WHERE organization_id = ?')
    const deaths = await q("SELECT SUM(quantity) AS v FROM flock_movements WHERE organization_id = ? AND type = 'death'")
    const feed = await q('SELECT SUM(issued - returned - wasted) AS v FROM feed_records WHERE organization_id = ?')
    const stock = Number(
      (
        (await f.db.prepare('SELECT SUM(quantity) AS v FROM inventory_transactions WHERE organization_id = ? AND item_id = ?').get(f.org, f.feedId)) as {
          v: number
        }
      ).v
    )

    const o = await organizationOverview(f.admin, D, D)
    expect(o.totals).toMatchObject({ eggs, deaths, birdsNow: 10000 - deaths })
    expect(o.totals.feedKg).toBeCloseTo(feed, 3)
    const [series] = await dailySeries(f.admin, D, D)
    expect(series).toMatchObject({ eggs, deaths })
    expect(series.feedKg).toBeCloseTo(feed, 3)
    const day = await getOverview(f.admin, D)
    expect(day.totals.eggs.collected).toBe(eggs)
    const feedRow = (await storeBalances(f.admin)).find((b) => b.itemId === f.feedId)!
    expect(feedRow.balance).toBeCloseTo(stock, 3)
    expect(await itemBalance(f.admin, f.feedId)).toBeCloseTo(stock, 3)
  })
})

describe('acceptance: transfers and adjustments are auditable (criterion 14)', () => {
  it('every transfer and stock count is in the activity history with who did it, and stock equals its movements', async () => {
    const f = await makeFarm()
    const main = await mainStore(f.admin)
    const cold = await saveWarehouse(f.admin, { id: null, code: 'COLD', name: 'Cold room', active: true, notes: null })
    const ref = await transferStock(f.admin, {
      date: D,
      fromWarehouseId: main,
      toWarehouseId: cold,
      notes: 'Vaccines to the fridge',
      lines: [{ itemId: f.medId, batchNo: 'VM-01', quantity: 250 }]
    })
    await countStock(f.admin, { warehouseId: main, date: TODAY, notes: 'Weekly count', lines: [{ itemId: f.feedId, batchId: null, countedQty: 4990 }] })
    const rows = (await f.db
      .prepare("SELECT action, username, details FROM audit_log WHERE organization_id = ? AND action IN ('stock_transfer', 'stock_count') ORDER BY id")
      .all(f.org)) as {
      action: string
      username: string
      details: string
    }[]
    expect(rows.map((r) => [r.action, r.username])).toEqual([
      ['stock_transfer', 'admin'],
      ['stock_count', 'admin']
    ])
    expect(rows[0].details).toContain(ref)
    const moves = (await f.db
      .prepare("SELECT type, quantity, recorded_by FROM inventory_transactions WHERE transfer_ref = ? OR source_type = 'stock_count_line' ORDER BY id")
      .all(ref)) as {
      type: string
      quantity: number
      recorded_by: number
    }[]
    expect(moves.map((m) => [m.type, m.quantity])).toEqual([
      ['transfer_out', -250],
      ['transfer_in', 250],
      ['count', -10]
    ])
    expect(moves.every((m) => m.recorded_by === f.admin.user!.id)).toBe(true)
  })
})

describe('acceptance: existing data stays intact through every upgrade (criterion 2)', () => {
  it('an installation from before organizations keeps its stock and deliveries, now in its main store', async () => {
    const db = await openTestDb(false)
    await migrate(db, { to: 4 })
    const at = '2026-10-01T02:00:00.000Z'
    await db.exec(`
INSERT INTO app_settings (\`key\`, value, updated_at) VALUES ('farmName', '"Hill Farm"', '${at}');
INSERT INTO users (id, username, display_name, password_hash, role, active, created_at) VALUES (1, 'admin', 'Admin', 'x', 'admin', 1, '${at}');
INSERT INTO inventory_items (id, category, name, unit, created_at) VALUES (1, 'feed', 'Layer Mash', 'kg', '${at}');
INSERT INTO inventory_transactions (id, item_id, txn_date, type, quantity, recorded_by, created_at) VALUES (1, 1, '2026-09-30', 'opening', 5000.25, 1, '${at}');
INSERT INTO suppliers (id, name, created_at) VALUES (1, 'Prima Feed Mill', '${at}');
INSERT INTO goods_receipts (id, grn_no, receipt_date, supplier_id, recorded_by, created_at) VALUES (1, 'GRN-20261001-001', '2026-10-01', 1, 1, '${at}');
INSERT INTO goods_receipt_lines (id, receipt_id, item_id, quantity, unit_cost) VALUES (1, 1, 1, 1000, 152.5);
INSERT INTO inventory_transactions (id, item_id, txn_date, type, quantity, unit_cost, source_type, source_id, recorded_by, created_at) VALUES (2, 1, '2026-10-01', 'purchase', 1000, 152.5, 'grn_line', 1, 1, '${at}');
`)
    expect((await migrate(db)).to).toBe(latestSchemaVersion())
    const store = (await db.prepare('SELECT id, name, is_main FROM warehouses').all()) as { id: number; name: string; is_main: number }[]
    expect(store).toEqual([{ id: expect.any(Number), name: 'Main Store', is_main: 1 }])
    expect(await db.prepare('SELECT warehouse_id AS w, quantity FROM inventory_transactions ORDER BY id').all()).toEqual([
      { w: store[0].id, quantity: 5000.25 },
      { w: store[0].id, quantity: 1000 }
    ])
    expect(await db.prepare('SELECT status, warehouse_id AS w FROM goods_receipts').get()).toEqual({ status: 'posted', w: store[0].id })
    expect(await db.prepare('SELECT unit_cost AS c, rejected_qty AS r FROM goods_receipt_lines').get()).toEqual({ c: 152.5, r: 0 })
  })
})

describe('acceptance: a new organization can be created and onboarded (criterion 3)', () => {
  it('from the console to the administrator signing in, adding a cage and starting the first day', async () => {
    const f = await makeFarm()
    const ops = await createPlatformUser(f.db, { email: 'ops@serenova.test', displayName: 'Ops', password: 'platform-secret-1' })
    const starter = ((await f.db.prepare("SELECT id FROM plans WHERE code = 'starter'").get()) as { id: number }).id
    const created = await platformCreateOrganization(f.anon, (await loadPlatformUser(f.db, ops))!, {
      name: 'Kandy Layers',
      location: 'Kandy',
      timezone: 'Asia/Colombo',
      language: 'si',
      adminEmail: 'owner@kandy.test',
      adminName: 'Owner',
      adminPassword: 'secret123',
      planId: starter,
      trialDays: 30
    })
    const signedIn = await login(f.anon, 'owner@kandy.test', 'secret123')
    expect(signedIn.org).toBe(created.id)
    const owner: Ctx = { db: f.db, org: signedIn.org, farm: signedIn.farm, user: signedIn.user, now: f.anon.now }
    const call = api(f.db)
    expect(
      await call(owner, 'cages.create', {
        code: 'K1',
        name: 'Shed 1',
        initialHens: 1200,
        capacity: null,
        hasWaterMeter: false,
        active: true,
        sortOrder: 1,
        notes: null
      })
    ).toMatchObject({ ok: true })
    expect(await call(owner, 'days.start', { date: TODAY, corrections: [], acknowledgeWarnings: true })).toMatchObject({ ok: true })
    const status = await call(owner, 'app.status')
    expect(status.ok && status.data).toMatchObject({
      organization: { name: 'Kandy Layers' },
      subscription: { planCode: 'starter', effective: 'trial' },
      settings: { language: 'si' }
    })
    expect(await mainStore(owner)).toBeGreaterThan(0)
    // The first organization is not affected.
    expect((await organizationOverview(f.admin, D, TODAY)).farms.map((r) => r.farmName)).toEqual(['Test Farm'])
  })
})
