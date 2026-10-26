import { describe, expect, it } from 'vitest'
import type { ApiMethod } from '@shared/api'
import { createHandlers, dispatch, type PublicCtx } from '../src/server/api'
import type { ServerConfig } from '../src/server/config'
import type { Ctx } from '../src/server/context'
import type { Databases } from '../src/server/databases'
import { startDay } from '../src/server/services/days'
import { listBatches, updateItem } from '../src/server/services/inventory'
import { addTreatment } from '../src/server/services/medicine'
import { activeWithdrawals, feedingStatus, markFed, saveSchedule } from '../src/server/services/schedules'
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

describe('feeding schedules', () => {
  it('shows each planned feeding as on time, late, missed, due or to come', async () => {
    const f = await makeFarm()
    const base = { cageId: null, itemId: f.feedId, plannedKg: 550, notes: null, active: true }
    const s0600 = await saveSchedule(f.admin, { ...base, id: null, atTime: '06:00' })
    const s0630 = await saveSchedule(f.admin, { ...base, id: null, atTime: '06:30' })
    const s0745 = await saveSchedule(f.admin, { ...base, id: null, atTime: '07:45' })
    await saveSchedule(f.admin, { ...base, id: null, atTime: '16:00' })
    await markFed(f.worker, s0600, TODAY, '06:20', null)
    await markFed(f.worker, s0630, TODAY, '07:15', 'Feeder jammed')
    const states = (await feedingStatus(f.admin, TODAY)).map((s) => [s.atTime, s.state])
    expect(states).toEqual([
      ['06:00', 'done'],
      ['06:30', 'late'],
      ['07:45', 'due'],
      ['16:00', 'upcoming']
    ])
    // A past day: anything not recorded was missed.
    expect((await feedingStatus(f.admin, D)).every((s) => s.state === 'missed')).toBe(true)
    await expect(markFed(f.worker, s0600, TODAY, '06:25', null)).rejects.toMatchObject({ code: 'already_done' })
    void s0745
    const call = api(f.db)
    expect(await call(f.worker, 'feeding.saveSchedule', { ...base, id: null, atTime: '09:00' })).toMatchObject({ ok: false, code: 'no_permission' })
    const dash = await call(f.admin, 'analytics.dashboard', { date: D })
    expect(
      dash.ok && (dash.data as { alerts: { code: string; params: Record<string, unknown> }[] }).alerts.find((a) => a.code === 'feeding_missed')
    ).toMatchObject({ params: { count: 4 } })
  })
})

describe('egg withdrawal periods', () => {
  it('holds back the eggs of a treated cage for the medicine’s withdrawal days, and only that cage', async () => {
    const f = await makeFarm()
    await updateItem(f.admin, f.medId, {
      category: 'medicine',
      name: 'Vitamin Mix',
      unit: 'ml',
      lowStockThreshold: 100,
      active: true,
      notes: null,
      eggWithdrawalDays: 3
    })
    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
    const batch = (await listBatches(f.admin, { itemId: f.medId }))[0].id
    await addTreatment(f.worker, {
      date: D,
      cageId: f.cageIds[0],
      itemId: f.medId,
      batchId: batch,
      quantity: 20,
      administeredAt: null,
      reason: 'Vet prescription',
      prescribedBy: 'Dr Perera',
      notes: null
    })
    // Treated on the 9th with 3 days: eggs of the 9th, 10th and 11th are held back; usable from the 12th.
    expect(await activeWithdrawals(f.admin, D)).toEqual([
      { cageId: f.cageIds[0], cageName: 'Cage 01', item: 'Vitamin Mix', treatedOn: D, eggsUsableFrom: '2026-03-12' }
    ])
    expect(await activeWithdrawals(f.admin, '2026-03-11')).toHaveLength(1)
    expect(await activeWithdrawals(f.admin, '2026-03-12')).toEqual([])
    expect(await activeWithdrawals(f.admin, '2026-03-08')).toEqual([])
    const dash = await api(f.db)(f.admin, 'analytics.dashboard', { date: TODAY })
    expect(dash.ok && (dash.data as { alerts: { code: string }[] }).alerts.map((a) => a.code)).toContain('egg_withdrawal')
  })

  it('a medicine without a withdrawal period holds back nothing (the system never assumes one)', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
    const batch = (await listBatches(f.admin, { itemId: f.medId }))[0].id
    await addTreatment(f.worker, {
      date: D,
      cageId: f.cageIds[0],
      itemId: f.medId,
      batchId: batch,
      quantity: 20,
      administeredAt: null,
      reason: 'Vet prescription',
      prescribedBy: null,
      notes: null
    })
    expect(await activeWithdrawals(f.admin, D)).toEqual([])
  })
})
