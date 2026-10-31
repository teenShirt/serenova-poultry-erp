import type { ApiMethod } from '@shared/api'
import { PERMISSION_FOR_METHOD } from '@shared/permissions'
import type { DutyTask } from '@shared/types'
import type { Ctx } from '../context'
import { AppError, assert } from '../errors'
import { audit } from './audit'
import { getOverview } from './days'
import { assertCanManageUser, dutiesOf } from './roles'
import { getSettings } from './settings'

/** Requests that delete a cage-linked record: the record's cage must be one of the user's cages. */
const DELETE_TABLES: Partial<Record<ApiMethod, string>> = {
  'eggs.delete': 'egg_collections',
  'feed.delete': 'feed_records',
  'water.delete': 'water_records',
  'flock.delete': 'flock_movements',
  'medicine.deleteTreatment': 'medicine_treatments',
  'medicine.deleteHealthEvent': 'health_events'
}

/** Requests that add a record, or change a saved one when `expectedId` names it: changing needs 'records.edit'. */
const SAVE_METHODS = new Set<ApiMethod>(['eggs.save', 'feed.save', 'water.save'])

/** The cages stored for a user (JSON array of cage ids); null = all cages. */
export function parseCages(json: string | null): number[] | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.map(Number) : null
  } catch {
    return null
  }
}

async function cageName(ctx: Ctx, id: number) {
  return (
    ((await ctx.db.prepare('SELECT name FROM cages WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as { name: string } | undefined)?.name ?? String(id)
  )
}

async function assertCage(ctx: Ctx, cages: number[] | null, cageId: unknown) {
  if (cages === null || cageId === null || cageId === undefined) return
  if (!cages.includes(Number(cageId))) throw new AppError('cage_not_assigned', { cage: await cageName(ctx, Number(cageId)) })
}

/**
 * Central permission check run for every request before it reaches a service: the user's role
 * must allow the request, and anything touching a cage must be one of the user's cages.
 * (Administrators hold every permission and look after every cage.)
 */
export async function checkAccess(ctx: Ctx, method: ApiMethod, input: unknown) {
  if (!ctx.user) return
  const need = PERMISSION_FOR_METHOD[method]
  if (need && !ctx.user.permissions.includes(need)) throw new AppError('no_permission')
  const i = (input ?? {}) as Record<string, unknown>
  if (SAVE_METHODS.has(method) && i.expectedId != null && !ctx.user.permissions.includes('records.edit')) throw new AppError('no_permission')
  if (ctx.user.role === 'admin') return
  const cages = ctx.user.cages ?? null
  if (cages === null) return
  for (const key of ['cageId', 'fromCageId', 'toCageId']) if (key in i) await assertCage(ctx, cages, i[key])
  if (Array.isArray(i.cageIds)) for (const c of i.cageIds) await assertCage(ctx, cages, c)
  // A treatment for the whole farm (no cage) needs responsibility for all cages.
  if (method === 'medicine.addTreatment' && (i.cageId === null || i.cageId === undefined)) throw new AppError('cage_not_assigned', { cage: '—' })
  const table = DELETE_TABLES[method]
  if (table && typeof i.id === 'number') {
    const row = (await ctx.db.prepare(`SELECT cage_id FROM ${table} WHERE id = ? AND organization_id = ?`).get(i.id, ctx.org)) as
      | { cage_id: number | null }
      | undefined
    if (row) await assertCage(ctx, cages, row.cage_id)
  }
}

/** The cages a user looks after (null = all). What they may do comes from their role. */
export async function setUserCages(ctx: Ctx, id: number, cages: number[] | null) {
  await ctx.db.transaction(async () => {
    await assertCanManageUser(ctx, id)
    const row = (await ctx.db.prepare('SELECT username, assigned_cages FROM users WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as
      | { username: string; assigned_cages: string | null }
      | undefined
    assert(row, 'not_found')
    if (cages !== null) {
      for (const c of cages) assert(await ctx.db.prepare('SELECT 1 AS x FROM cages WHERE id = ? AND organization_id = ?').get(c, ctx.org), 'cage_not_found')
    }
    const next = cages === null ? null : [...new Set(cages)]
    await ctx.db.prepare('UPDATE users SET assigned_cages = ? WHERE id = ?').run(next === null ? null : JSON.stringify(next), id)
    await audit(ctx, {
      action: 'set_cages',
      entity: 'user',
      entityId: id,
      details: { username: row.username, before: parseCages(row.assigned_cages), after: next }
    })
  })()
}

/**
 * "My duties today": the jobs this user is responsible for on a day, ticked off automatically
 * from what has been recorded (eggs per expected session, feed, water, deaths confirmed).
 */
export async function dutyTasks(ctx: Ctx, date: string): Promise<DutyTask[]> {
  if (!ctx.user) return []
  const duties = dutiesOf(ctx.user.permissions)
  const mine = ctx.user.role === 'admin' ? null : (ctx.user.cages ?? null)
  const ov = await getOverview(ctx, date)
  const tasks: DutyTask[] = []
  if (duties.includes('start_day')) {
    tasks.push({ key: 'start_day', duty: 'start_day', cageId: null, cageName: null, params: { date }, done: ov.dayId !== null })
  }
  if (ov.dayId === null) return tasks
  const cages = ov.cages.filter((c) => mine === null || mine.includes(c.cageId))
  const { expectedEggSessions: sessions, waterTracking } = await getSettings(ctx)
  for (const c of cages) {
    const base = { cageId: c.cageId, cageName: c.name }
    if (duties.includes('eggs')) {
      for (const s of sessions) tasks.push({ ...base, key: `eggs:${s}:${c.cageId}`, duty: 'eggs', params: { session: s }, done: c.eggs.sessions.includes(s) })
    }
    if (duties.includes('feed')) tasks.push({ ...base, key: `feed:${c.cageId}`, duty: 'feed', params: {}, done: c.feed.records > 0 })
    if (waterTracking && duties.includes('water')) tasks.push({ ...base, key: `water:${c.cageId}`, duty: 'water', params: {}, done: c.water.recorded })
    if (duties.includes('flock')) tasks.push({ ...base, key: `deaths:${c.cageId}`, duty: 'flock', params: {}, done: c.mortalityConfirmed })
  }
  return tasks
}
