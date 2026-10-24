import { addDays, dateRange } from '@shared/dates'
import type { ActivitySummary, DbInfo } from '@shared/types'
import { type Ctx, requireAdmin } from '../context'
import { currentSchemaVersion, DATA_TABLES } from '../db/migrations'
import { audit } from './audit'
import { foreignKeyProblems } from './backup'

/** Tables holding an organization's records (organizations and farms are counted separately). */
const ORG_TABLES = DATA_TABLES.filter((t) => t !== 'organizations' && t !== 'farms')

/**
 * The health of the organization's data: its record counts, approximate size, last backup and
 * last integrity check. Only this organization's records are counted.
 */
export async function dbInfo(ctx: Ctx, location: string): Promise<DbInfo> {
  requireAdmin(ctx)
  const last = (await ctx.db
    .prepare('SELECT status, created_at AS createdAt, path FROM backup_runs WHERE organization_id = ? ORDER BY id DESC LIMIT 1')
    .get(ctx.org)) as DbInfo['lastBackup'] | undefined
  const since = new Date(ctx.now().getTime() - 30 * 86400000).toISOString()
  const okCount = (await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM backup_runs WHERE organization_id = ? AND status = 'ok' AND created_at >= ?")
    .get(ctx.org, since)) as { n: number }
  const check = (await ctx.db
    .prepare("SELECT at, details FROM audit_log WHERE organization_id = ? AND action = 'database_check' ORDER BY id DESC LIMIT 1")
    .get(ctx.org)) as { at: string; details: string } | undefined
  let lastCheck: DbInfo['lastCheck'] = null
  if (check) {
    try {
      const d = JSON.parse(check.details) as { ok: boolean; message: string }
      lastCheck = { at: check.at, ok: d.ok, message: d.message }
    } catch {
      /* ignore an unreadable entry */
    }
  }
  // Approximate size of this organization's records: its rows × each table's average row size.
  const avg = new Map(
    (
      (await ctx.db
        .prepare('SELECT table_name AS t, COALESCE(avg_row_length, 0) AS a FROM information_schema.tables WHERE table_schema = DATABASE()')
        .all()) as { t: string; a: number }[]
    ).map((r) => [r.t, Number(r.a)])
  )
  const version = (await ctx.db.prepare('SELECT VERSION() AS v').get()) as { v: string }
  const tables: DbInfo['tables'] = []
  let sizeBytes = 0
  for (const name of ORG_TABLES) {
    const rows = ((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE organization_id = ?`).get(ctx.org)) as { n: number }).n
    tables.push({ name, rows })
    sizeBytes += rows * (avg.get(name) ?? 0)
  }
  return {
    file: location,
    sizeBytes,
    schemaVersion: await currentSchemaVersion(ctx.db),
    serverVersion: `MySQL ${version.v}`,
    tables,
    lastBackup: last ?? null,
    backupsOk30d: okCount.n,
    lastCheck
  }
}

/** Checks the organization's tables with MySQL's CHECK TABLE and every link between its records, and records the result. */
export async function checkDatabase(ctx: Ctx): Promise<{ ok: boolean; message: string }> {
  requireAdmin(ctx)
  const rows = (await ctx.db.query(`CHECK TABLE ${ORG_TABLES.join(', ')}`)) as { Table: string; Msg_type: string; Msg_text: string }[]
  const problems = rows.filter((r) => r.Msg_type === 'error' || (r.Msg_type === 'status' && r.Msg_text !== 'OK')).map((r) => `${r.Table}: ${r.Msg_text}`)
  problems.push(...(await foreignKeyProblems(ctx.db, ctx.org)))
  const result = { ok: problems.length === 0, message: problems.length ? problems.slice(0, 5).join('; ') : 'ok' }
  await audit(ctx, { action: 'database_check', entity: 'database', details: result })
  return result
}

/** Refreshes MySQL's index statistics so queries keep choosing good plans as the data grows. */
export async function optimizeDatabase(ctx: Ctx) {
  requireAdmin(ctx)
  await ctx.db.query(`ANALYZE TABLE ${ORG_TABLES.join(', ')}`)
  await audit(ctx, { action: 'database_optimize', entity: 'database' })
}

/** Who has been changing what in the organization: changes and sign-ins per day, per user and per action. */
export async function activitySummary(ctx: Ctx, from: string, to: string): Promise<ActivitySummary> {
  requireAdmin(ctx)
  const range = [ctx.org, from, addDays(to, 1)]
  const rows = (await ctx.db
    .prepare(
      `SELECT SUBSTR(at, 1, 10) AS date,
         SUM(CASE WHEN action NOT IN ('login','login_failed','logout') THEN 1 ELSE 0 END) AS changes,
         SUM(CASE WHEN action = 'login' THEN 1 ELSE 0 END) AS logins,
         SUM(CASE WHEN action = 'login_failed' THEN 1 ELSE 0 END) AS failedLogins
       FROM audit_log WHERE organization_id = ? AND at >= ? AND at < ? GROUP BY SUBSTR(at, 1, 10)`
    )
    .all(...range)) as ActivitySummary['byDay']
  const byDate = new Map(rows.map((r) => [r.date, r]))
  return {
    byDay: dateRange(from, to).map((date) => byDate.get(date) ?? { date, changes: 0, logins: 0, failedLogins: 0 }),
    byUser: (await ctx.db
      .prepare(
        `SELECT COALESCE(username, '—') AS username, COUNT(*) AS changes, MAX(at) AS lastAt FROM audit_log
         WHERE organization_id = ? AND at >= ? AND at < ? AND action NOT IN ('login','login_failed','logout') GROUP BY username ORDER BY changes DESC`
      )
      .all(...range)) as ActivitySummary['byUser'],
    byAction: (await ctx.db
      .prepare(`SELECT action, COUNT(*) AS count FROM audit_log WHERE organization_id = ? AND at >= ? AND at < ? GROUP BY action ORDER BY count DESC LIMIT 12`)
      .all(...range)) as ActivitySummary['byAction']
  }
}
