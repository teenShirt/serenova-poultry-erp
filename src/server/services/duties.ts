import type { ApiMethod } from '@shared/api'
import { DUTIES, type Duty, type DutyTask, type Role } from '@shared/types'
import { type Ctx, requireAdmin } from '../context'
import { AppError, assert } from '../errors'
import { audit } from './audit'
import { getOverview } from './days'
import { getSettings } from './settings'

/** Which duty each data-changing request needs. Requests not listed only need a signed-in user. */
export const DUTY_FOR_METHOD: Partial<Record<ApiMethod, Duty>> = {
  'days.start': 'start_day',
  'days.confirmMortality': 'flock',
  'eggs.save': 'eggs',
  'eggs.delete': 'eggs',
  'feed.save': 'feed',
  'feed.delete': 'feed',
  'water.save': 'water',
  'water.delete': 'water',
  'flock.add': 'flock',
  'flock.transfer': 'flock',
  'flock.delete': 'flock',
  'medicine.addTreatment': 'medicine',
  'medicine.deleteTreatment': 'medicine',
  'medicine.addHealthEvent': 'medicine',
  'medicine.deleteHealthEvent': 'medicine',
  'inventory.record': 'inventory',
  'parties.saveSupplier': 'purchases',
  'purchases.create': 'purchases',
  'parties.saveCustomer': 'sales',
  'sales.dispatch': 'sales',
  'sales.addPayment': 'sales',
  'reports.preview': 'reports',
  'reports.print': 'reports',
  'backup.create': 'backup'
}

/** Requests that delete a cage-linked record: the record's cage must be one of the user's cages. */
const DELETE_TABLES: Partial<Record<ApiMethod, string>> = {
  'eggs.delete': 'egg_collections',
  'feed.delete': 'feed_records',
  'water.delete': 'water_records',
  'flock.delete': 'flock_movements',
  'medicine.deleteTreatment': 'medicine_treatments',
  'medicine.deleteHealthEvent': 'health_events'
}

export interface Access {
  role: Role
  duties: Duty[]
  cages: number[] | null
}

function parseList<T>(json: string | null): T[] | null {
  if (!json) return null
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as T[]) : null
  } catch {
    return null
  }
}

/** A user's duties and cages. Users from before duties existed (NULL) keep every duty. */
export function accessFromRow(row: { role: Role; duties: string | null; assigned_cages: string | null }): Access {
  if (row.role === 'admin') return { role: 'admin', duties: [...DUTIES], cages: null }
  const duties = parseList<Duty>(row.duties)?.filter((d) => (DUTIES as readonly string[]).includes(d)) ?? [...DUTIES]
  return { role: row.role, duties, cages: parseList<number>(row.assigned_cages) }
}

export async function getAccess(ctx: Pick<Ctx, 'db' | 'org'>, userId: number): Promise<Access | null> {
  const row = (await ctx.db.prepare('SELECT role, duties, assigned_cages FROM users WHERE id = ? AND organization_id = ?').get(userId, ctx.org)) as
    | { role: Role; duties: string | null; assigned_cages: string | null }
    | undefined
  return row ? accessFromRow(row) : null
}

async function cageName(ctx: Ctx, id: number) {
  return ((await ctx.db.prepare('SELECT name FROM cages WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as { name: string } | undefined)?.name ?? String(id)
}

async function assertCage(ctx: Ctx, access: Access, cageId: unknown) {
  if (access.cages === null || cageId === null || cageId === undefined) return
  if (!access.cages.includes(Number(cageId))) throw new AppError('cage_not_assigned', { cage: await cageName(ctx, Number(cageId)) })
}

/**
 * Central permission check run for every request before it reaches a service: the user must
 * hold the request's duty, and anything touching a cage must be one of the user's cages.
 */
export async function checkAccess(ctx: Ctx, method: ApiMethod, input: unknown) {
  if (!ctx.user) return
  const access = await getAccess(ctx, ctx.user.id)
  if (!access || access.role === 'admin') return
  const duty = DUTY_FOR_METHOD[method]
  if (duty && !access.duties.includes(duty)) throw new AppError('no_permission')
  if (access.cages === null) return
  const i = (input ?? {}) as Record<string, unknown>
  for (const key of ['cageId', 'fromCageId', 'toCageId']) if (key in i) await assertCage(ctx, access, i[key])
  if (Array.isArray(i.cageIds)) for (const c of i.cageIds) await assertCage(ctx, access, c)
  // A treatment for the whole farm (no cage) needs responsibility for all cages.
  if (method === 'medicine.addTreatment' && (i.cageId === null || i.cageId === undefined)) throw new AppError('cage_not_assigned', { cage: '—' })
  const table = DELETE_TABLES[method]
  if (table && typeof i.id === 'number') {
    const row = (await ctx.db.prepare(`SELECT cage_id FROM ${table} WHERE id = ? AND organization_id = ?`).get(i.id, ctx.org)) as { cage_id: number | null } | undefined
    if (row) await assertCage(ctx, access, row.cage_id)
  }
}

export async function setUserDuties(ctx: Ctx, id: number, duties: Duty[], cages: number[] | null) {
  requireAdmin(ctx)
  await ctx.db.transaction(async () => {
    const row = (await ctx.db.prepare('SELECT username, role, duties, assigned_cages FROM users WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as
      | { username: string; role: Role; duties: string | null; assigned_cages: string | null }
      | undefined
    assert(row, 'not_found')
    const clean = [...new Set(duties)].filter((d) => (DUTIES as readonly string[]).includes(d))
    if (cages !== null) {
      for (const c of cages) assert(await ctx.db.prepare('SELECT 1 AS x FROM cages WHERE id = ? AND organization_id = ?').get(c, ctx.org), 'cage_not_found')
    }
    const before = accessFromRow(row)
    await ctx.db
      .prepare('UPDATE users SET duties = ?, assigned_cages = ? WHERE id = ?')
      .run(JSON.stringify(clean), cages === null ? null : JSON.stringify([...new Set(cages)]), id)
    await audit(ctx, { action: 'set_duties', entity: 'user', entityId: id, details: { username: row.username, before, after: { duties: clean, cages } } })
  })()
}

/**
 * "My duties today": the jobs this user is responsible for on a day, ticked off automatically
 * from what has been recorded (eggs per expected session, feed, water, deaths confirmed).
 */
export async function dutyTasks(ctx: Ctx, date: string): Promise<DutyTask[]> {
  if (!ctx.user) return []
  const access = await getAccess(ctx, ctx.user.id)
  if (!access) return []
  const ov = await getOverview(ctx, date)
  const tasks: DutyTask[] = []
  if (access.duties.includes('start_day')) {
    tasks.push({ key: 'start_day', duty: 'start_day', cageId: null, cageName: null, params: { date }, done: ov.dayId !== null })
  }
  if (ov.dayId === null) return tasks
  const cages = ov.cages.filter((c) => access.cages === null || access.cages.includes(c.cageId))
  const sessions = (await getSettings(ctx)).expectedEggSessions
  for (const c of cages) {
    const base = { cageId: c.cageId, cageName: c.name }
    if (access.duties.includes('eggs')) {
      for (const s of sessions) tasks.push({ ...base, key: `eggs:${s}:${c.cageId}`, duty: 'eggs', params: { session: s }, done: c.eggs.sessions.includes(s) })
    }
    if (access.duties.includes('feed')) tasks.push({ ...base, key: `feed:${c.cageId}`, duty: 'feed', params: {}, done: c.feed.records > 0 })
    if (access.duties.includes('water')) tasks.push({ ...base, key: `water:${c.cageId}`, duty: 'water', params: {}, done: c.water.recorded })
    if (access.duties.includes('flock')) tasks.push({ ...base, key: `deaths:${c.cageId}`, duty: 'flock', params: {}, done: c.mortalityConfirmed })
  }
  return tasks
}
