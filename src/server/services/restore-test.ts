import fs from 'node:fs'
import path from 'node:path'
import type { ServerConfig } from '../config'
import { createPool, withDb, type DB } from '../db/connection'
import { currentSchemaVersion, latestSchemaVersion, migrate } from '../db/migrations'
import { foreignKeyProblems, readBackup, restoreDatabase } from './backup'

export interface RestoreTestResult {
  status: 'ok' | 'failed'
  backupFile: string
  targetDatabase: string
  durationMs: number
  tablesChecked: number
  rowsChecked: number
  problems: string[]
}

/** The scratch database must be separate, and named as one (so a mistyped setting can never point at real data). */
export function assertRestoreTarget(cfg: ServerConfig): string {
  const target = cfg.restoreTestDatabase
  if (!target) throw new Error('RESTORE_TEST_DB_NAME is not set: create an empty database for restore tests and name it there')
  if (target === cfg.db.database || target === cfg.demoDatabase)
    throw new Error('RESTORE_TEST_DB_NAME must be a separate database, not the farm or demonstration database')
  if (!/restore/i.test(target)) throw new Error('RESTORE_TEST_DB_NAME must contain "restore" (for example poultry_restore_test)')
  return target
}

/** The newest verified whole-database backup that is still in the backup folder. */
export async function latestWholeBackup(db: DB, backupDir: string): Promise<string | null> {
  const rows = (await db
    .prepare("SELECT path FROM backup_runs WHERE organization_id IS NULL AND status = 'ok' AND path IS NOT NULL ORDER BY id DESC LIMIT 20")
    .all()) as { path: string }[]
  for (const r of rows) {
    const p = path.resolve(r.path)
    if (path.dirname(p) === path.resolve(backupDir) && fs.existsSync(p)) return p
  }
  return null
}

/**
 * Proves a whole-database backup can be restored: in the separate restore-test database, the
 * tables are built at the backup's schema version, the backup is restored, every table's row count
 * is compared with the backup, the database is upgraded to the current version (as a real recovery
 * would be) and every link between records is checked. The farm database is only read (to find the
 * backup) and the result is recorded in it.
 */
export async function runRestoreTest(farmDb: DB, cfg: ServerConfig, file?: string): Promise<RestoreTestResult> {
  const started = Date.now()
  const target = assertRestoreTarget(cfg)
  const backupFile = file ? path.resolve(file) : await latestWholeBackup(farmDb, cfg.backupDir)
  const result: RestoreTestResult = {
    status: 'failed',
    backupFile: backupFile ?? '(none)',
    targetDatabase: target,
    durationMs: 0,
    tablesChecked: 0,
    rowsChecked: 0,
    problems: []
  }
  let createdAt: string | null = null
  try {
    if (!backupFile) throw new Error('no whole-database backup found in the backup folder')
    const data = readBackup(backupFile)
    if (data.scope !== 'database') throw new Error('not a whole-database backup')
    createdAt = data.createdAt
    if (data.schemaVersion > latestSchemaVersion()) throw new Error(`backup schema v${data.schemaVersion} is newer than this application`)
    const pool = createPool({ ...cfg.db, database: target, connectionLimit: 2 })
    try {
      await withDb(pool, target, async (db) => {
        // Start from an empty scratch database every time.
        const tables = (await db
          .prepare("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")
          .all()) as { t: string }[]
        await db.query('SET FOREIGN_KEY_CHECKS = 0')
        for (const { t } of tables) await db.query(`DROP TABLE \`${t}\``)
        await db.query('SET FOREIGN_KEY_CHECKS = 1')
        await migrate(db, { to: data.schemaVersion })
        await restoreDatabase(db, data)
        for (const [table, src] of Object.entries(data.tables)) {
          const n = ((await db.prepare(`SELECT COUNT(*) AS n FROM \`${table}\``).get()) as { n: number }).n
          result.tablesChecked++
          result.rowsChecked += n
          if (n !== src.rows.length) result.problems.push(`${table}: ${n} rows restored, ${src.rows.length} in the backup`)
        }
        await migrate(db)
        if ((await currentSchemaVersion(db)) !== latestSchemaVersion())
          result.problems.push('the restored database could not be upgraded to the current version')
        result.problems.push(...(await foreignKeyProblems(db)))
      })
    } finally {
      await pool.end()
    }
    result.status = result.problems.length ? 'failed' : 'ok'
  } catch (e) {
    result.problems.push((e as Error).message)
  }
  result.durationMs = Date.now() - started
  await farmDb
    .prepare(
      `INSERT INTO restore_tests (at, backup_file, backup_created_at, target_database, status, duration_ms, tables_checked, rows_checked, problems)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      new Date().toISOString(),
      result.backupFile.slice(0, 500),
      createdAt,
      target,
      result.status,
      result.durationMs,
      result.tablesChecked,
      result.rowsChecked,
      result.problems.length ? result.problems.join('\n').slice(0, 4000) : null
    )
  return result
}

/** Exported for the scheduler: whether the last restore test is older than the given number of days. */
export async function restoreTestDue(db: DB, days: number): Promise<boolean> {
  const last = (await db.prepare('SELECT at FROM restore_tests ORDER BY id DESC LIMIT 1').get()) as { at: string } | undefined
  return !last || Date.now() - Date.parse(last.at) > days * 86400_000
}
