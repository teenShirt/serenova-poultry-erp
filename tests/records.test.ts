import { describe, expect, it } from 'vitest'
import type { ApiMethod } from '@shared/api'
import { translate } from '@shared/i18n'
import { createHandlers, dispatch, type PublicCtx } from '../src/server/api'
import type { ServerConfig } from '../src/server/config'
import type { Ctx } from '../src/server/context'
import type { Databases } from '../src/server/databases'
import { createUser } from '../src/server/services/auth'
import { getOverview, startDay } from '../src/server/services/days'
import { dutyTasks } from '../src/server/services/duties'
import { itemBalance, listBatches, recordTxn } from '../src/server/services/inventory'
import { addTreatment, dueSchedules, listSchedules, saveSchedule } from '../src/server/services/medicine'
import { RestoreTokens } from '../src/server/uploads'
import { makeFarm } from './helpers'

const D = '2026-03-09'
const TODAY = '2026-03-10' // the test clock is 08:00 in Colombo

function api(db: Ctx['db']) {
  const dbs = { demoAvailable: false, location: () => 'test', with: <T>(_m: string, fn: (d: typeof db) => Promise<T>) => fn(db) } as unknown as Databases
  const handlers = createHandlers({
    cfg: { setupKey: null, backupDir: 'unused', environment: 'development' } as unknown as ServerConfig,
    dbs,
    restoreTokens: new RestoreTokens()
  })
  return (ctx: Ctx, method: ApiMethod, input?: unknown) => dispatch(handlers, method, input, { ...ctx, mode: 'farm', session: {} } as PublicCtx)
}

const feed = (cageId: number, itemId: number, issued: number, expectedId: number | null) => ({
  expectedId,
  date: D,
  cageId,
  itemId,
  batchNo: null,
  openingStock: null,
  issued,
  returned: 0,
  wasted: 0,
  measuredConsumption: null,
  closingStock: null,
  notes: null
})

const purchase = (itemId: number, quantity: number) => ({
  itemId,
  type: 'purchase' as const,
  quantity,
  date: D,
  batchNo: null,
  expiryDate: null,
  unitCost: 100,
  supplier: null,
  reference: null,
  notes: null,
  cageId: null
})

describe('changing and deleting saved records', () => {
  it('everyone records; only "edit and delete records" changes or deletes a saved record', async () => {
    const f = await makeFarm()
    const call = api(f.db)
    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
    const saved = await call(f.worker, 'feed.save', feed(f.cageIds[0], f.feedId, 110, null))
    expect(saved).toMatchObject({ ok: true })
    const id = (saved as { data: number }).data
    expect(await call(f.worker, 'feed.save', feed(f.cageIds[0], f.feedId, 100, id))).toMatchObject({ ok: false, code: 'no_permission' })
    expect(await call(f.worker, 'feed.delete', { id, reason: 'Wrong cage' })).toMatchObject({ ok: false, code: 'no_permission' })
    const eggs = { expectedId: null, date: D, cageId: f.cageIds[0], session: 'morning', collectedAt: '07:00', good: 800, damaged: 5, rejected: 0, notes: null }
    const egg = (await call(f.worker, 'eggs.save', eggs)) as { ok: true; data: number }
    expect(egg.ok).toBe(true)
    expect(await call(f.worker, 'eggs.save', { ...eggs, expectedId: egg.data, good: 810 })).toMatchObject({ ok: false, code: 'no_permission' })
    expect(await call(f.worker, 'eggs.delete', { id: egg.data, reason: 'Counted twice' })).toMatchObject({ ok: false, code: 'no_permission' })

    // The administrator holds every permission.
    expect(await call(f.admin, 'feed.save', feed(f.cageIds[0], f.feedId, 100, id))).toMatchObject({ ok: true })
    expect(await call(f.admin, 'eggs.save', { ...eggs, expectedId: egg.data, good: 810 })).toMatchObject({ ok: true })

    // ...and can give the permission to a role.
    const role = (await call(f.admin, 'roles.save', { id: null, name: 'Supervisor', description: null, permissions: ['feed.record', 'records.edit'] })) as {
      data: number
    }
    await createUser(f.admin, { email: 'super@test.farm', displayName: 'Supervisor', password: 'super123', roleId: role.data })
    const supervisor = await f.signIn('super@test.farm', 'super123')
    expect(await call(supervisor, 'feed.delete', { id, reason: 'Wrong cage' })).toMatchObject({ ok: true })
  })
})

describe('correcting stock movements entered by hand', () => {
  it('the administrator corrects or deletes them; stock never goes below zero; linked movements are changed at their source', async () => {
    const f = await makeFarm()
    const call = api(f.db)
    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
    const start = await itemBalance(f.admin, f.feedId)
    const id = await recordTxn(f.worker, purchase(f.feedId, 200))
    const fix = { id, quantity: 150, unitCost: 100, supplier: 'Mill', reference: 'INV-7', notes: null, reason: 'Invoice says 150 kg' }
    expect(await call(f.worker, 'inventory.updateTxn', fix)).toMatchObject({ ok: false, code: 'no_permission' })
    expect(await call(f.worker, 'inventory.deleteTxn', { id, reason: 'Entered twice' })).toMatchObject({ ok: false, code: 'no_permission' })
    expect(await call(f.admin, 'inventory.updateTxn', fix)).toMatchObject({ ok: true })
    expect(await itemBalance(f.admin, f.feedId)).toBe(start + 150)

    // A delivery whose stock has been used cannot be deleted.
    await recordTxn(f.worker, { ...purchase(f.feedId, start + 150), type: 'issue', unitCost: null })
    expect(await call(f.admin, 'inventory.deleteTxn', { id, reason: 'Entered twice' })).toMatchObject({ ok: false, code: 'insufficient_stock' })

    // The feed issued on a feed record is changed on the feed record, not here.
    await call(f.worker, 'inventory.record', purchase(f.feedId, 500))
    await call(f.worker, 'feed.save', feed(f.cageIds[0], f.feedId, 110, null))
    const linked = (await f.db.prepare("SELECT id FROM inventory_transactions WHERE source_type = 'feed_record'").get()) as { id: number }
    expect(await call(f.admin, 'inventory.deleteTxn', { id: linked.id, reason: 'Not needed' })).toMatchObject({ ok: false, code: 'txn_not_manual' })
  })
})

describe('medicine plans', () => {
  it('administrators plan medicines; reminders come due; a matching treatment moves the plan on', async () => {
    const f = await makeFarm()
    const call = api(f.db)
    const repeat = { id: null, cageId: f.cageIds[0], itemId: f.medId, dose: 20, dueDate: D, repeatDays: 7, notes: 'Vitamins', active: true }
    expect(await call(f.worker, 'medicine.saveSchedule', repeat)).toMatchObject({ ok: false, code: 'no_permission' })
    const weekly = await saveSchedule(f.admin, repeat)
    const once = await saveSchedule(f.admin, { ...repeat, cageId: null, dueDate: '2026-03-12', repeatDays: null, notes: null })
    await saveSchedule(f.admin, { ...repeat, dueDate: '2026-03-20' }) // too far ahead to remind yet

    expect((await dueSchedules(f.admin, TODAY)).map((m) => [m.id, m.state, m.daysLeft])).toEqual([
      [weekly, 'overdue', -1],
      [once, 'upcoming', 2]
    ])
    const dash = await call(f.worker, 'analytics.dashboard', { date: TODAY })
    expect(dash.ok && (dash.data as { alerts: { code: string; params: unknown }[] }).alerts.find((a) => a.code === 'medicine_overdue')).toMatchObject({
      params: { cage: 'Cage 01', item: 'Vitamin Mix', date: D }
    })

    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
    const batchId = (await listBatches(f.admin, { itemId: f.medId }))[0].id
    const treat = { date: D, itemId: f.medId, batchId, quantity: 20, administeredAt: null, reason: 'Planned vitamins', prescribedBy: null, notes: null }
    // Another cage's treatment leaves the plan as it is.
    await addTreatment(f.worker, { ...treat, cageId: f.cageIds[1] })
    expect((await listSchedules(f.admin)).find((s) => s.id === weekly)).toMatchObject({ dueDate: D, lastDoneOn: null })
    await addTreatment(f.worker, { ...treat, cageId: f.cageIds[0] })
    await addTreatment(f.worker, { ...treat, cageId: null }) // the whole farm, 3 days early: still counts
    const plans = await listSchedules(f.admin)
    expect(plans.find((s) => s.id === weekly)).toMatchObject({ dueDate: '2026-03-16', lastDoneOn: D, active: true })
    expect(plans.find((s) => s.id === once)).toMatchObject({ lastDoneOn: D, active: false })
    expect(await dueSchedules(f.admin, TODAY)).toEqual([])
  })
})

describe('water tracking switched off', () => {
  it('leaves water out of the day checks, duties and reports', async () => {
    const f = await makeFarm()
    const call = api(f.db)
    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
    const waterIssues = async () => (await getOverview(f.admin, D)).issues.filter((i) => i.code.includes('water'))
    const report = async () => ((await call(f.admin, 'reports.preview', { kind: 'day_close', date: D })) as { data: { html: string } }).data.html
    expect(await waterIssues()).not.toEqual([])
    expect((await dutyTasks(f.worker, D)).some((d) => d.duty === 'water')).toBe(true)
    expect(await report()).toContain(translate('en', 'rep.totalWater'))

    expect(await call(f.admin, 'settings.save', { waterTracking: false })).toMatchObject({ ok: true })
    expect(await waterIssues()).toEqual([])
    expect((await dutyTasks(f.worker, D)).some((d) => d.duty === 'water')).toBe(false)
    const html = await report()
    expect(html).not.toContain(translate('en', 'rep.totalWater'))
    expect(html).not.toContain(`>${translate('en', 'col.water')}<`)
  })
})
