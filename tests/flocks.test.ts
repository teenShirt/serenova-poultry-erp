import { describe, expect, it } from 'vitest'
import type { ApiMethod } from '@shared/api'
import { DEFAULT_STAGES, flockAge, hatchDateFromArrival, stageFor } from '@shared/flocks'
import { createHandlers, dispatch, type PublicCtx } from '../src/server/api'
import type { ServerConfig } from '../src/server/config'
import type { Ctx } from '../src/server/context'
import type { Databases } from '../src/server/databases'
import { DATA_TABLES } from '../src/server/db/migrations'
import { startDay } from '../src/server/services/days'
import { saveEggs } from '../src/server/services/eggs'
import { saveFeed } from '../src/server/services/feed'
import { addMovement } from '../src/server/services/flock'
import { closeFlock, endPlacement, flockSeries, getFlock, listFlocks, placeFlock, saveFlock, saveReminder } from '../src/server/services/flocks'
import { RestoreTokens } from '../src/server/uploads'
import { makeFarm } from './helpers'

const D = '2026-03-09'
const TODAY = '2026-03-10'

/** The real API, returning the session change too (for switching farms). */
function api(db: Ctx['db']) {
  const dbs = { demoAvailable: false, location: () => 'test', with: <T>(_m: string, fn: (d: typeof db) => Promise<T>) => fn(db) } as unknown as Databases
  const handlers = createHandlers({ cfg: { setupKey: null, backupDir: 'unused' } as unknown as ServerConfig, dbs, restoreTokens: new RestoreTokens() })
  return async (ctx: Ctx, method: ApiMethod, input?: unknown) => {
    const pc: PublicCtx = { ...ctx, mode: 'farm', session: {} }
    const res = await dispatch(handlers, method, input, pc)
    return Object.assign(res, { session: pc.session })
  }
}

const flock = (over: Record<string, unknown> = {}) => ({
  id: null,
  code: 'B1',
  breed: 'Hy-Line Brown',
  source: 'purchased' as const,
  hatchDate: null,
  arrivalDate: '2026-03-01',
  ageOnArrivalDays: 126,
  initialCount: 2000,
  notes: null,
  ...over
})

describe('flock age', () => {
  it('counts days from the hatch date (day 0) and completed weeks', () => {
    expect(flockAge('2026-01-01', '2026-01-01')).toEqual({ days: 0, weeks: 0, dayOfWeek: 0 })
    expect(flockAge('2026-01-01', '2026-01-07')).toEqual({ days: 6, weeks: 0, dayOfWeek: 6 })
    expect(flockAge('2026-01-01', '2026-01-08')).toEqual({ days: 7, weeks: 1, dayOfWeek: 0 })
    expect(flockAge('2025-12-31', '2026-03-01')).toMatchObject({ days: 60, weeks: 8 })
    expect(hatchDateFromArrival('2026-03-01', 126)).toBe('2025-10-26')
  })
  it('finds the production stage by age', () => {
    expect(stageFor(DEFAULT_STAGES, 0)?.name).toBe('brooding')
    expect(stageFor(DEFAULT_STAGES, 6)?.name).toBe('growing')
    expect(stageFor(DEFAULT_STAGES, 17)?.name).toBe('pre_lay')
    expect(stageFor(DEFAULT_STAGES, 80)?.name).toBe('laying')
    expect(stageFor([{ name: 'late', fromWeek: 10 }], 3)).toBeNull()
  })
})

describe('flocks', () => {
  it("follows a flock through its cages: its hens, eggs and deaths are those cages' records while it is there", async () => {
    const f = await makeFarm()
    const [c1, c2, c3] = f.cageIds
    const id = await saveFlock(f.admin, flock())
    await placeFlock(f.admin, id, [c1, c2], D)
    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
    await saveEggs(f.worker, { date: D, cageId: c1, session: 'morning', collectedAt: '08:00', good: 800, damaged: 4, rejected: 0, notes: null }, null)
    await saveEggs(f.worker, { date: D, cageId: c3, session: 'morning', collectedAt: '08:00', good: 700, damaged: 0, rejected: 0, notes: null }, null)
    await addMovement(f.worker, { date: D, cageId: c2, type: 'death', quantity: 3, reason: null, notes: null })
    await addMovement(f.worker, { date: D, cageId: c3, type: 'death', quantity: 5, reason: null, notes: null })

    const [s] = await flockSeries(f.admin, id, D, D)
    expect(s).toMatchObject({ date: D, opening: 2000, closing: 1997, eggs: 804, deaths: 3, ageDays: 134, ageWeeks: 19 })
    const [summary] = await listFlocks(f.admin)
    expect(summary).toMatchObject({
      code: 'B1',
      hatchDate: '2025-10-26',
      hatchDateEstimated: true,
      currentHens: 1997,
      deaths: 3,
      stage: 'laying',
      age: { days: 135, weeks: 19 }
    })
    expect(summary.cages.map((c) => c.cageId)).toEqual([c1, c2])

    // A cage holds one flock at a time.
    const other = await saveFlock(f.admin, flock({ code: 'B2' }))
    await expect(placeFlock(f.admin, other, [c1], TODAY)).rejects.toMatchObject({ code: 'cage_has_flock' })
    await endPlacement(f.admin, id, c2, D)
    await expect(placeFlock(f.admin, other, [c2], D)).rejects.toMatchObject({ code: 'cage_has_flock' })
    await placeFlock(f.admin, other, [c2], TODAY)
    expect((await getFlock(f.admin, id)).cages.map((c) => c.cageId)).toEqual([c1])
    // Deaths stay with the flock that was in the cage on that day.
    expect((await listFlocks(f.admin)).find((x) => x.id === other)!.deaths).toBe(0)

    await expect(saveFlock(f.admin, flock({ code: 'B1' }))).rejects.toMatchObject({ code: 'flock_code_taken' })
    await expect(saveFlock(f.admin, flock({ code: 'B3', hatchDate: '2026-03-05' }))).rejects.toMatchObject({ code: 'hatch_after_arrival' })
    await expect(saveFlock(f.admin, flock({ code: 'B3', ageOnArrivalDays: null }))).rejects.toMatchObject({ code: 'hatch_or_age_required' })

    await closeFlock(f.admin, id, TODAY, 'Sold to processor')
    const closed = await getFlock(f.admin, id)
    expect(closed).toMatchObject({ status: 'closed', closedOn: TODAY, currentHens: 0, cages: [] })
    expect(closed.placements.every((p) => p.toDate !== null)).toBe(true)
  })

  it('age reminders: due in their week of age, overdue after; none for ages before the flock arrived', async () => {
    const f = await makeFarm()
    const call = api(f.db)
    // Hatched 1 Jan, arrived at 9 days old: 68 days = 9 weeks old on 10 March.
    const id = await saveFlock(f.admin, flock({ hatchDate: '2026-01-01', arrivalDate: '2026-01-10', ageOnArrivalDays: null }))
    const r = async (atWeek: number, title: string) =>
      saveReminder(f.admin, { id: null, atWeek, title, instructions: 'As prescribed by the farm veterinarian', active: true })
    await r(0, 'Before arrival')
    const overdue = await r(8, 'Week 8 check')
    await r(9, 'Week 9 check')
    await r(10, 'Week 10 check')
    await r(20, 'Far away')

    const due = await call(f.worker, 'flocks.dueReminders')
    expect(due.ok && (due.data as { title: string; state: string }[]).map((x) => [x.title, x.state])).toEqual([
      ['Week 8 check', 'overdue'],
      ['Week 9 check', 'due'],
      ['Week 10 check', 'upcoming']
    ])
    const dash = await call(f.admin, 'analytics.dashboard', { date: TODAY })
    expect(dash.ok && (dash.data as { alerts: { code: string }[] }).alerts.map((a) => a.code)).toEqual(
      expect.arrayContaining(['flock_reminder_due', 'flock_reminder_overdue'])
    )

    expect(await call(f.worker, 'flocks.markReminder', { flockId: id, reminderId: overdue, outcome: 'skipped', note: null })).toMatchObject({
      ok: false,
      code: 'reason_required'
    })
    expect(await call(f.worker, 'flocks.markReminder', { flockId: id, reminderId: overdue, outcome: 'done', note: null })).toMatchObject({ ok: true })
    expect(await call(f.worker, 'flocks.markReminder', { flockId: id, reminderId: overdue, outcome: 'done', note: null })).toMatchObject({
      ok: false,
      code: 'already_done'
    })
    const detail = await getFlock(f.admin, id)
    expect(detail.reminders.find((x) => x.reminderId === overdue)).toMatchObject({ state: 'done', doneBy: 'Worker' })
    // Writing the programme itself needs flock management.
    expect(await call(f.worker, 'flocks.saveReminder', { id: null, atWeek: 1, title: 'Mine', instructions: null, active: true })).toMatchObject({
      ok: false,
      code: 'no_permission'
    })
  })

  it('farms: within the plan, switch between them; each has its own cages and flocks', async () => {
    const starter = await makeFarm({ plan: 'starter' })
    expect(await api(starter.db)(starter.admin, 'farms.save', { id: null, name: 'Second', location: null })).toMatchObject({
      ok: false,
      code: 'farm_limit_reached',
      params: { limit: 1 }
    })

    const f = await makeFarm()
    const call = api(f.db)
    const flockId = await saveFlock(f.admin, flock())
    const north = await call(f.admin, 'farms.save', { id: null, name: 'North Farm', location: 'Kurunegala' })
    expect(north.ok).toBe(true)
    const northId = north.ok ? (north.data as number) : 0
    const sw = await call(f.worker, 'farms.switch', { id: northId })
    expect(sw).toMatchObject({ ok: true, session: { farmId: northId } })

    const inNorth: Ctx = { ...f.admin, farm: northId }
    expect(await call(inNorth, 'cages.list', {})).toMatchObject({ ok: true, data: [] })
    expect(await call(inNorth, 'flocks.list', {})).toMatchObject({ ok: true, data: [] })
    expect(await call(inNorth, 'flocks.get', { id: flockId })).toMatchObject({ ok: false, code: 'flock_not_found' })
    expect(await call(inNorth, 'flocks.place', { id: flockId, cageIds: [f.cageIds[0]], fromDate: TODAY })).toMatchObject({ ok: false, code: 'flock_not_found' })

    expect(await call(f.admin, 'farms.setStatus', { id: f.farm, status: 'archived', reason: 'Closing it' })).toMatchObject({ ok: false, code: 'farm_in_use' })
    expect(await call(f.admin, 'farms.setStatus', { id: northId, status: 'archived', reason: 'Not used' })).toMatchObject({ ok: true })
    expect(await call(f.worker, 'farms.switch', { id: northId })).toMatchObject({ ok: false, code: 'farm_not_found' })
    expect(await call(f.worker, 'farms.save', { id: null, name: 'Mine', location: null })).toMatchObject({ ok: false, code: 'no_permission' })
  })

  it('houses group the cages of a farm', async () => {
    const f = await makeFarm()
    const call = api(f.db)
    const h = await call(f.admin, 'houses.save', { id: null, code: 'H1', name: 'Shed 1', active: true, sortOrder: 1, notes: null })
    const houseId = h.ok ? (h.data as number) : 0
    const cages = await call(f.admin, 'cages.list', {})
    const c = (
      (cages.ok ? cages.data : []) as {
        id: number
        code: string
        name: string
        initialHens: number
        capacity: number | null
        hasWaterMeter: boolean
        active: boolean
        sortOrder: number
        notes: string | null
      }[]
    )[0]
    const { id: cageId, ...cage } = c
    expect(await call(f.admin, 'cages.update', { id: cageId, cage: { ...cage, houseId }, reason: null })).toMatchObject({ ok: true })
    expect(await call(f.admin, 'houses.list')).toMatchObject({ ok: true, data: [{ code: 'H1', cages: 1 }] })
    // Leaving the house out keeps it.
    expect(await call(f.admin, 'cages.update', { id: cageId, cage: { ...cage, houseId: undefined, name: 'Renamed' }, reason: null })).toMatchObject({
      ok: true
    })
    expect(await call(f.admin, 'cages.list', {})).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ id: cageId, houseId, name: 'Renamed' })])
    })
  })
})

describe('exact decimals', () => {
  it('stores no quantity or amount as floating point', async () => {
    const f = await makeFarm()
    const rows = (await f.db
      .prepare(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND data_type IN ('double', 'float')`)
      .all()) as { t: string; c: string }[]
    expect(rows.filter((r) => (DATA_TABLES as readonly string[]).includes(r.t))).toEqual([])
    await startDay(f.worker, { date: D, corrections: [], acknowledgeWarnings: true })
    const feed = await saveFeed(
      f.worker,
      {
        date: D,
        cageId: f.cageIds[0],
        itemId: f.feedId,
        batchNo: null,
        openingStock: null,
        issued: 0.1,
        returned: 0,
        wasted: 0,
        measuredConsumption: null,
        closingStock: null,
        notes: null
      },
      null
    )
    // With floating point, 0.1 + 0.2 would be 0.30000000000000004.
    const sum = (await f.db.prepare('SELECT SUM(issued) + 0.2 AS s FROM feed_records WHERE id = ?').get(feed)) as { s: number }
    expect(sum.s).toBe(0.3)
  })
})
