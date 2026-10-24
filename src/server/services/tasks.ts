import { addDays, isIsoDate } from '@shared/dates'
import type { Recurrence, TaskEvent, TaskInput, TaskReportRow, TaskRow, TaskStatus } from '@shared/stores'
import { type Ctx, requireUser } from '../context'
import { AppError, assert } from '../errors'
import { audit } from './audit'
import { farmToday } from './days'
import { hasPermission, requirePermission } from './roles'

/**
 * Tasks: one-time, or recurring (a series from which one task per occurrence is made, a week ahead).
 * A task is assigned to a person or to a team (everyone with a role). Those assignees, and task
 * managers, may start and complete it; only managers create, change, cancel and verify tasks.
 * Every change is recorded in the task's history.
 */

/** How far ahead recurring tasks are made, and how far back missed occurrences are filled in. */
const AHEAD_DAYS = 7
const BACK_DAYS = 31

function occurrences(recurrence: Exclude<Recurrence, 'none'>, start: string, from: string, to: string): string[] {
  const out: string[] = []
  if (recurrence === 'daily') {
    for (let d = start > from ? start : from; d <= to; d = addDays(d, 1)) out.push(d)
  } else if (recurrence === 'weekly') {
    for (let d = start; d <= to; d = addDays(d, 7)) if (d >= from) out.push(d)
  } else {
    // Monthly on the start date's day; in shorter months, on the last day.
    const [y, m, day] = start.split('-').map(Number)
    for (let i = 0; ; i++) {
      const month = new Date(Date.UTC(y, m - 1 + i, 1))
      const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate()
      const d = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10)
      if (d > to) break
      if (d >= from) out.push(d)
    }
  }
  return out
}

/** Makes the tasks of active recurring series up to a week ahead (each occurrence once). */
export async function generateOccurrences(ctx: Ctx) {
  const today = await farmToday(ctx)
  const series = (await ctx.db
    .prepare('SELECT * FROM task_series WHERE organization_id = ? AND active = 1')
    .all(ctx.org)) as {
    id: number
    farm_id: number | null
    house_id: number | null
    title: string
    category: string
    priority: string
    instructions: string | null
    completion_criteria: string | null
    assignee_user_id: number | null
    assignee_role_id: number | null
    recurrence: Exclude<Recurrence, 'none'>
    start_date: string
    until_date: string | null
    created_by: number | null
  }[]
  for (const s of series) {
    const to = s.until_date && s.until_date < addDays(today, AHEAD_DAYS) ? s.until_date : addDays(today, AHEAD_DAYS)
    for (const d of occurrences(s.recurrence, s.start_date, addDays(today, -BACK_DAYS), to)) {
      const r = await ctx.db
        .prepare(
          `INSERT IGNORE INTO tasks (organization_id, series_id, farm_id, house_id, title, category, priority, instructions, completion_criteria,
             assignee_user_id, assignee_role_id, start_date, due_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.org, s.id, s.farm_id, s.house_id, s.title, s.category, s.priority, s.instructions, s.completion_criteria, s.assignee_user_id, s.assignee_role_id, d, d, s.created_by, ctx.now().toISOString())
      if (r.changes === 1) {
        await ctx.db.prepare("INSERT INTO task_events (organization_id, task_id, at, user_id, action) VALUES (?, ?, ?, NULL, 'created')").run(ctx.org, r.lastInsertRowid, ctx.now().toISOString())
      }
    }
  }
}

const taskSelect = `SELECT t.id, t.series_id AS seriesId, COALESCE(s.recurrence, 'none') AS recurrence, t.title, t.category, t.priority, t.instructions,
    t.completion_criteria AS completionCriteria, t.farm_id AS farmId, f.name AS farmName, t.house_id AS houseId, h.name AS houseName,
    t.assignee_user_id AS assigneeUserId, au.display_name AS assigneeName, t.assignee_role_id AS assigneeRoleId, r.name AS assigneeRoleName,
    t.start_date AS startDate, t.due_date AS dueDate, t.status, cu.display_name AS createdBy, du.display_name AS completedBy, t.completed_at AS completedAt,
    vu.display_name AS verifiedBy, t.verified_at AS verifiedAt
  FROM tasks t LEFT JOIN task_series s ON s.id = t.series_id LEFT JOIN farms f ON f.id = t.farm_id LEFT JOIN houses h ON h.id = t.house_id
  LEFT JOIN users au ON au.id = t.assignee_user_id LEFT JOIN roles r ON r.id = t.assignee_role_id
  LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN users du ON du.id = t.completed_by LEFT JOIN users vu ON vu.id = t.verified_by`

type TaskDb = Omit<TaskRow, 'overdue' | 'mine'>

function isAssignee(ctx: Ctx, t: { assigneeUserId: number | null; assigneeRoleId: number | null }) {
  const u = ctx.user!
  return t.assigneeUserId === u.id || (t.assigneeUserId === null && t.assigneeRoleId !== null && t.assigneeRoleId === u.roleId)
}

function toRow(ctx: Ctx, t: TaskDb, today: string): TaskRow {
  const open = t.status === 'pending' || t.status === 'in_progress'
  return { ...t, overdue: open && t.dueDate < today, mine: isAssignee(ctx, t) }
}

/**
 * Tasks of the farm being worked on (and organization-wide ones) due in the period, plus older ones
 * still open. Task managers see all of them; everyone else sees those assigned to them or their team.
 */
export async function listTasks(ctx: Ctx, f: { from: string; to: string; mineOnly?: boolean }): Promise<TaskRow[]> {
  const user = requireUser(ctx)
  await generateOccurrences(ctx)
  const today = await farmToday(ctx)
  const all = hasPermission(user, 'tasks.manage') && !f.mineOnly
  const rows = (await ctx.db
    .prepare(
      `${taskSelect} WHERE t.organization_id = ? AND (t.farm_id IS NULL OR t.farm_id = ?)
         AND (t.due_date BETWEEN ? AND ? OR (t.due_date < ? AND t.status IN ('pending','in_progress')))
         ${all ? '' : 'AND (t.assignee_user_id = ? OR (t.assignee_user_id IS NULL AND t.assignee_role_id = ?))'}
       ORDER BY t.due_date, FIELD(t.priority, 'urgent', 'high', 'normal', 'low'), t.id LIMIT 1000`
    )
    .all(ctx.org, ctx.farm, f.from, f.to, f.from, ...(all ? [] : [user.id, user.roleId ?? -1]))) as TaskDb[]
  return rows.map((r) => toRow(ctx, r, today))
}

async function getTaskRow(ctx: Ctx, id: number): Promise<TaskDb> {
  const r = (await ctx.db.prepare(`${taskSelect} WHERE t.id = ? AND t.organization_id = ?`).get(id, ctx.org)) as TaskDb | undefined
  assert(r && (r.farmId === null || r.farmId === ctx.farm), 'task_not_found')
  // Someone who neither manages tasks nor is assigned this one cannot see it.
  assert(hasPermission(ctx.user, 'tasks.manage') || isAssignee(ctx, r), 'task_not_found')
  return r
}

export async function getTask(ctx: Ctx, id: number): Promise<TaskRow & { events: TaskEvent[] }> {
  requireUser(ctx)
  const t = await getTaskRow(ctx, id)
  const events = (await ctx.db
    .prepare(
      `SELECT e.at, u.display_name AS user, e.action, e.note FROM task_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.task_id = ? AND e.organization_id = ? ORDER BY e.id`
    )
    .all(id, ctx.org)) as TaskEvent[]
  return { ...toRow(ctx, t, await farmToday(ctx)), events }
}

async function event(ctx: Ctx, taskId: number, action: string, note: string | null = null) {
  await ctx.db
    .prepare('INSERT INTO task_events (organization_id, task_id, at, user_id, action, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ctx.org, taskId, ctx.now().toISOString(), ctx.user?.id ?? null, action, note?.trim() || null)
}

async function checkPlaces(ctx: Ctx, t: TaskInput) {
  if (t.farmId) assert(await ctx.db.prepare('SELECT 1 AS x FROM farms WHERE id = ? AND organization_id = ?').get(t.farmId, ctx.org), 'farm_not_found')
  if (t.houseId) {
    const h = (await ctx.db.prepare('SELECT farm_id FROM houses WHERE id = ? AND organization_id = ?').get(t.houseId, ctx.org)) as { farm_id: number } | undefined
    assert(h && (!t.farmId || h.farm_id === t.farmId), 'house_not_found')
  }
  if (t.assigneeUserId) {
    assert(await ctx.db.prepare('SELECT 1 AS x FROM users WHERE id = ? AND organization_id = ? AND active = 1 AND pending = 0').get(t.assigneeUserId, ctx.org), 'not_found')
  }
  if (t.assigneeRoleId) assert(await ctx.db.prepare('SELECT 1 AS x FROM roles WHERE id = ? AND organization_id = ? AND archived_at IS NULL').get(t.assigneeRoleId, ctx.org), 'role_not_found')
}

/** Creates a task (or a recurring series) or changes one. Changing a recurring task changes its series and its open tasks from today on. */
export async function saveTask(ctx: Ctx, t: TaskInput): Promise<number> {
  requirePermission(ctx, 'tasks.manage')
  const title = t.title.trim()
  assert(title.length >= 2, 'required_field', { field: 'title' })
  assert(isIsoDate(t.startDate) && isIsoDate(t.dueDate) && t.dueDate >= t.startDate, 'invalid_date')
  assert(!t.untilDate || (isIsoDate(t.untilDate) && t.untilDate >= t.startDate), 'invalid_date')
  return ctx.db.transaction(async () => {
    await checkPlaces(ctx, t)
    const vals = [t.farmId, t.houseId, title, t.category, t.priority, t.instructions?.trim() || null, t.completionCriteria?.trim() || null, t.assigneeUserId, t.assigneeRoleId]
    const today = await farmToday(ctx)
    if (t.id) {
      const before = await getTaskRow(ctx, t.id)
      if (before.seriesId) {
        await ctx.db
          .prepare(
            `UPDATE task_series SET farm_id = ?, house_id = ?, title = ?, category = ?, priority = ?, instructions = ?, completion_criteria = ?,
               assignee_user_id = ?, assignee_role_id = ?, until_date = ? WHERE id = ?`
          )
          .run(...vals, t.untilDate, before.seriesId)
        await ctx.db
          .prepare(
            `UPDATE tasks SET farm_id = ?, house_id = ?, title = ?, category = ?, priority = ?, instructions = ?, completion_criteria = ?,
               assignee_user_id = ?, assignee_role_id = ? WHERE series_id = ? AND due_date >= ? AND status IN ('pending','in_progress')`
          )
          .run(...vals, before.seriesId, today)
        // Occurrences after a new end date are cancelled (kept in the history).
        if (t.untilDate) {
          await ctx.db
            .prepare("UPDATE tasks SET status = 'cancelled' WHERE series_id = ? AND due_date > ? AND status = 'pending'")
            .run(before.seriesId, t.untilDate)
        }
      } else {
        assert(before.status === 'pending' || before.status === 'in_progress', 'task_closed')
        await ctx.db
          .prepare(
            `UPDATE tasks SET farm_id = ?, house_id = ?, title = ?, category = ?, priority = ?, instructions = ?, completion_criteria = ?,
               assignee_user_id = ?, assignee_role_id = ?, start_date = ?, due_date = ? WHERE id = ?`
          )
          .run(...vals, t.startDate, t.dueDate, t.id)
      }
      const reassigned = before.assigneeUserId !== t.assigneeUserId || before.assigneeRoleId !== t.assigneeRoleId
      await event(ctx, t.id, reassigned ? 'assigned' : 'updated')
      await audit(ctx, { action: 'update', entity: 'task', entityId: t.id, details: { before, after: t } })
      return t.id
    }
    if (t.recurrence !== 'none') {
      const sid = (
        await ctx.db
          .prepare(
            `INSERT INTO task_series (organization_id, farm_id, house_id, title, category, priority, instructions, completion_criteria, assignee_user_id,
               assignee_role_id, recurrence, start_date, until_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(ctx.org, ...vals, t.recurrence, t.startDate, t.untilDate, ctx.user!.id, ctx.now().toISOString())
      ).lastInsertRowid
      await audit(ctx, { action: 'create', entity: 'task_series', entityId: sid, details: t })
      await generateOccurrences(ctx)
      const first = (await ctx.db.prepare('SELECT id FROM tasks WHERE series_id = ? ORDER BY due_date LIMIT 1').get(sid)) as { id: number } | undefined
      return first?.id ?? 0
    }
    const id = (
      await ctx.db
        .prepare(
          `INSERT INTO tasks (organization_id, farm_id, house_id, title, category, priority, instructions, completion_criteria, assignee_user_id,
             assignee_role_id, start_date, due_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.org, ...vals, t.startDate, t.dueDate, ctx.user!.id, ctx.now().toISOString())
    ).lastInsertRowid
    await event(ctx, id, 'created')
    await audit(ctx, { action: 'create', entity: 'task', entityId: id, details: t })
    return id
  })()
}

export type TaskAction = 'start' | 'complete' | 'verify' | 'cancel' | 'comment' | 'stop_series'

/**
 * Moves a task on: start / complete (its assignees or a manager), verify a completed task, cancel
 * (managers, with a reason), comment (anyone who can see it), or stop a recurring series.
 */
export async function taskAction(ctx: Ctx, id: number, action: TaskAction, note: string | null) {
  const user = requireUser(ctx)
  const manager = hasPermission(user, 'tasks.manage')
  await ctx.db.transaction(async () => {
    const t = await getTaskRow(ctx, id)
    const now = ctx.now().toISOString()
    const set = async (status: TaskStatus, extra = '', args: unknown[] = []) => {
      await ctx.db.prepare(`UPDATE tasks SET status = ?${extra} WHERE id = ?`).run(status, ...args, id)
    }
    switch (action) {
      case 'start':
        assert(manager || isAssignee(ctx, t), 'no_permission')
        assert(t.status === 'pending', 'task_closed')
        await set('in_progress')
        break
      case 'complete':
        assert(manager || isAssignee(ctx, t), 'no_permission')
        assert(t.status === 'pending' || t.status === 'in_progress', 'task_closed')
        assert(!t.completionCriteria || (note?.trim().length ?? 0) >= 3, 'completion_note_required')
        await set('completed', ', completed_by = ?, completed_at = ?', [user.id, now])
        break
      case 'verify':
        assert(manager, 'no_permission')
        assert(t.status === 'completed', 'task_not_completed')
        await set('verified', ', verified_by = ?, verified_at = ?', [user.id, now])
        break
      case 'cancel':
        assert(manager, 'no_permission')
        assert(t.status === 'pending' || t.status === 'in_progress', 'task_closed')
        assert((note?.trim().length ?? 0) >= 3, 'reason_required')
        await set('cancelled')
        break
      case 'stop_series':
        assert(manager, 'no_permission')
        assert(t.seriesId, 'not_found')
        await ctx.db.prepare('UPDATE task_series SET active = 0 WHERE id = ?').run(t.seriesId)
        await ctx.db
          .prepare("UPDATE tasks SET status = 'cancelled' WHERE series_id = ? AND status = 'pending' AND due_date > ?")
          .run(t.seriesId, await farmToday(ctx))
        break
      case 'comment':
        assert((note?.trim().length ?? 0) >= 1, 'required_field', { field: 'note' })
        break
      default:
        throw new AppError('invalid_input', { field: 'action' })
    }
    await event(ctx, id, action === 'start' ? 'started' : action === 'complete' ? 'completed' : action === 'verify' ? 'verified' : action === 'cancel' ? 'cancelled' : action, note)
    if (action !== 'comment') await audit(ctx, { action: `task_${action}`, entity: 'task', entityId: id, reason: note })
  })()
}

/** Completion per week (or month): on time, late, verified, still open, overdue and cancelled. */
export async function taskReport(ctx: Ctx, from: string, to: string, by: 'week' | 'month'): Promise<TaskReportRow[]> {
  requirePermission(ctx, 'tasks.manage')
  const today = await farmToday(ctx)
  const rows = (await ctx.db
    .prepare(
      `SELECT due_date AS due, status, completed_at AS completedAt FROM tasks
       WHERE organization_id = ? AND (farm_id IS NULL OR farm_id = ?) AND due_date BETWEEN ? AND ?`
    )
    .all(ctx.org, ctx.farm, from, to)) as { due: string; status: TaskStatus; completedAt: string | null }[]
  const periodOf = (d: string) => {
    if (by === 'month') return d.slice(0, 8) + '01'
    const day = new Date(d + 'T00:00:00Z').getUTCDay()
    return addDays(d, -((day + 6) % 7))
  }
  const out = new Map<string, TaskReportRow>()
  for (const r of rows) {
    const p = periodOf(r.due)
    const row = out.get(p) ?? { period: p, total: 0, completedOnTime: 0, completedLate: 0, verified: 0, open: 0, overdue: 0, cancelled: 0 }
    row.total++
    if (r.status === 'completed' || r.status === 'verified') {
      if (r.completedAt && r.completedAt.slice(0, 10) <= r.due) row.completedOnTime++
      else row.completedLate++
      if (r.status === 'verified') row.verified++
    } else if (r.status === 'cancelled') row.cancelled++
    else if (r.due < today) row.overdue++
    else row.open++
    out.set(p, row)
  }
  return [...out.values()].sort((a, b) => a.period.localeCompare(b.period))
}

/** Open tasks of the signed-in user (or their team) that are past due, for the dashboard. */
export async function myOverdueCount(ctx: Ctx): Promise<number> {
  const user = ctx.user
  if (!user) return 0
  const r = (await ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE organization_id = ? AND (farm_id IS NULL OR farm_id = ?) AND status IN ('pending','in_progress')
         AND due_date < ? AND (assignee_user_id = ? OR (assignee_user_id IS NULL AND assignee_role_id = ?))`
    )
    .get(ctx.org, ctx.farm, await farmToday(ctx), user.id, user.roleId ?? -1)) as { n: number }
  return r.n
}

export async function assignees(ctx: Ctx) {
  return {
    users: (await ctx.db
      .prepare('SELECT id, display_name AS name FROM users WHERE organization_id = ? AND active = 1 AND pending = 0 ORDER BY display_name')
      .all(ctx.org)) as { id: number; name: string }[],
    roles: (await ctx.db.prepare('SELECT id, name FROM roles WHERE organization_id = ? AND archived_at IS NULL ORDER BY name').all(ctx.org)) as { id: number; name: string }[]
  }
}
