import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { BackupFileCheck, BackupInfo } from '@shared/types'
import type { DB } from '../db/connection'
import { DATA_TABLES, latestSchemaVersion } from '../db/migrations'

export const BACKUP_EXT = '.pfmbackup'
const FORMAT = 'poultry-farm-manager-backup'
const NAME_RE = /^PoultryFarm-\d{8}-\d{6}-(manual|auto|pre_restore)(-\d+)?\.pfmbackup$/
// The desktop edition's application_id ('PFM1'), used to recognise its SQLite backups.
const DESKTOP_APP_ID = 0x50464d31

/** Table contents in a compact form: column names once, then one array of values per row. */
export interface BackupData {
  format: typeof FORMAT
  formatVersion: 1
  schemaVersion: number
  createdAt: string
  tables: Record<string, { columns: string[]; rows: unknown[][] }>
}

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function logRun(db: DB, r: Omit<BackupInfo, 'id'>) {
  await db
    .prepare('INSERT INTO backup_runs (kind, path, size_bytes, status, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(r.kind, r.path, r.sizeBytes, r.status, r.message, r.createdAt)
}

/** Reads every farm table inside one transaction, so the copy is a consistent point in time. */
export async function dumpDatabase(db: DB, now = new Date()): Promise<BackupData> {
  return db.transaction(async () => {
    const version = (await db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()) as { v: number }
    const tables: BackupData['tables'] = {}
    for (const t of DATA_TABLES) {
      const rows = (await db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()) as Record<string, unknown>[]
      const columns = await tableColumns(db, t)
      tables[t] = { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) }
    }
    return { format: FORMAT, formatVersion: 1, schemaVersion: version.v, createdAt: now.toISOString(), tables } as BackupData
  })()
}

async function tableColumns(db: DB, table: string): Promise<string[]> {
  const rows = (await db
    .prepare(
      'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position'
    )
    .all(table)) as { c: string }[]
  return rows.map((r) => r.c)
}

/**
 * Writes a compressed snapshot of the farm database to the backup folder. The file is written
 * as .partial, read back and verified, and only then renamed and reported as successful.
 */
export async function createBackup(db: DB, folder: string, kind: 'manual' | 'auto' | 'pre_restore', now = new Date()): Promise<BackupInfo> {
  const createdAt = now.toISOString()
  let file: string | null = null
  try {
    fs.mkdirSync(folder, { recursive: true })
    file = path.join(folder, `PoultryFarm-${stamp(now)}-${kind}${BACKUP_EXT}`)
    let n = 1
    while (fs.existsSync(file)) file = path.join(folder, `PoultryFarm-${stamp(now)}-${kind}-${n++}${BACKUP_EXT}`)
    const tmp = file + '.partial'
    const data = await dumpDatabase(db, now)
    fs.writeFileSync(tmp, gzipSync(JSON.stringify(data)))
    const check = await inspectBackup(tmp)
    if (!check.ok) throw new Error(check.error ?? 'verification failed')
    fs.renameSync(tmp, file)
    const info = { kind, path: file, sizeBytes: fs.statSync(file).size, status: 'ok' as const, message: null, createdAt }
    await logRun(db, info)
    return { id: 0, ...info }
  } catch (e) {
    if (file && fs.existsSync(file + '.partial')) fs.rmSync(file + '.partial', { force: true })
    const info = { kind, path: file, sizeBytes: null, status: 'failed' as const, message: (e as Error).message, createdAt }
    await logRun(db, info)
    return { id: 0, ...info }
  }
}

/** Deletes the oldest automatic backups in the folder beyond the retention count. Manual backups are kept. */
export function applyRetention(folder: string, keep: number): string[] {
  if (!fs.existsSync(folder)) return []
  const autos = fs
    .readdirSync(folder)
    .filter((f) => NAME_RE.test(f) && f.includes('-auto'))
    .sort()
  const remove = autos.slice(0, Math.max(0, autos.length - Math.max(1, keep)))
  for (const f of remove) fs.rmSync(path.join(folder, f), { force: true })
  return remove
}

/**
 * Reads a backup file: either a backup made by this web edition (compressed JSON) or a backup
 * made by the desktop edition (an SQLite database file), which lets existing farm data move over.
 */
export function readBackup(file: string): BackupData {
  const head = Buffer.alloc(16)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, head, 0, 16, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const data = JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8')) as BackupData
    if (data.format !== FORMAT || !data.tables) throw new Error('not_a_farm_backup')
    return data
  }
  if (head.toString('latin1', 0, 15) === 'SQLite format 3') return readDesktopBackup(file)
  throw new Error('not_a_farm_backup')
}

function readDesktopBackup(file: string): BackupData {
  let Database: typeof import('better-sqlite3')
  try {
    Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
  } catch {
    throw new Error('sqlite_support_missing: install the better-sqlite3 package to import desktop backups')
  }
  const sdb = new Database(file, { readonly: true, fileMustExist: true })
  try {
    if (sdb.pragma('application_id', { simple: true }) !== DESKTOP_APP_ID) throw new Error('not_a_farm_backup')
    const integrity = sdb.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') throw new Error('integrity_failed: ' + integrity)
    if ((sdb.pragma('foreign_key_check') as unknown[]).length > 0) throw new Error('foreign_key_errors')
    const version = (sdb.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v
    const existing = new Set((sdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name))
    const tables: BackupData['tables'] = {}
    for (const t of DATA_TABLES) {
      if (!existing.has(t)) continue
      const stmt = sdb.prepare(`SELECT * FROM ${t} ORDER BY rowid`)
      const columns = stmt.columns().map((c) => c.name)
      tables[t] = { columns, rows: stmt.raw().all() as unknown[][] }
    }
    return { format: FORMAT, formatVersion: 1, schemaVersion: version, createdAt: fs.statSync(file).mtime.toISOString(), tables }
  } finally {
    sdb.close()
  }
}

/** Checks that a file is an intact, restorable farm backup and summarises what it contains. */
export async function inspectBackup(file: string, displayName = file): Promise<BackupFileCheck & { data?: BackupData }> {
  const result: BackupFileCheck & { data?: BackupData } = {
    path: displayName,
    ok: false,
    schemaVersion: 0,
    farmName: null,
    lastDate: null,
    dayCount: 0,
    error: null
  }
  try {
    const data = readBackup(file)
    result.schemaVersion = data.schemaVersion
    if (data.schemaVersion > latestSchemaVersion()) throw new Error('backup_too_new')
    for (const t of ['users', 'cages', 'farm_days', 'app_settings']) {
      if (!data.tables[t]) throw new Error('not_a_farm_backup')
    }
    const settings = data.tables['app_settings']
    const k = settings.columns.indexOf('key')
    const v = settings.columns.indexOf('value')
    const farm = settings.rows.find((r) => r[k] === 'farmName')
    result.farmName = farm ? (JSON.parse(String(farm[v])) as string) : null
    const days = data.tables['farm_days']
    const d = days.columns.indexOf('business_date')
    result.dayCount = days.rows.length
    result.lastDate = days.rows.reduce<string | null>((m, r) => (m === null || String(r[d]) > m ? String(r[d]) : m), null)
    result.ok = true
    result.data = data
  } catch (e) {
    result.error = (e as Error).message
  }
  return result
}

/**
 * Lists links between records that point at a missing record (the MySQL equivalent of SQLite's
 * foreign_key_check). Normally empty: MySQL enforces these links on every write.
 */
export async function foreignKeyProblems(db: DB): Promise<string[]> {
  const fks = (await db
    .prepare(
      `SELECT table_name AS t, column_name AS c, referenced_table_name AS rt, referenced_column_name AS rc
       FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`
    )
    .all()) as { t: string; c: string; rt: string; rc: string }[]
  const problems: string[] = []
  for (const fk of fks) {
    const r = (await db
      .prepare(`SELECT COUNT(*) AS n FROM ${fk.t} x LEFT JOIN ${fk.rt} p ON p.${fk.rc} = x.${fk.c} WHERE x.${fk.c} IS NOT NULL AND p.${fk.rc} IS NULL`)
      .get()) as { n: number }
    if (r.n > 0) problems.push(`${fk.t}.${fk.c}: ${r.n} broken link(s)`)
  }
  return problems
}

/**
 * Replaces all farm data with the contents of a backup, in one transaction: if anything fails
 * (a value MySQL rejects, a broken link), nothing is changed. Columns the backup does not have
 * (an older version) get their defaults. Everyone is signed out afterwards.
 */
export async function restoreData(db: DB, data: BackupData) {
  await db.transaction(async () => {
    await db.query('SET FOREIGN_KEY_CHECKS = 0')
    try {
      for (const t of [...DATA_TABLES].reverse()) await db.query(`DELETE FROM ${t}`)
      for (const t of DATA_TABLES) {
        const src = data.tables[t]
        if (!src || src.rows.length === 0) continue
        const target = new Set(await tableColumns(db, t))
        const keep = src.columns.map((c, i) => [c, i] as const).filter(([c]) => target.has(c))
        const cols = keep.map(([c]) => '`' + c + '`').join(', ')
        for (let i = 0; i < src.rows.length; i += 500) {
          const chunk = src.rows.slice(i, i + 500).map((r) => keep.map(([, j]) => r[j]))
          await db.query(`INSERT INTO ${t} (${cols}) VALUES ?`, [chunk])
        }
      }
      await db.query('DELETE FROM sessions')
    } finally {
      await db.query('SET FOREIGN_KEY_CHECKS = 1')
    }
    const problems = await foreignKeyProblems(db)
    if (problems.length) throw new Error('foreign_key_errors: ' + problems.slice(0, 3).join('; '))
  })()
}

export async function listBackupRuns(db: DB, limit = 50): Promise<BackupInfo[]> {
  return (await db
    .prepare(
      `SELECT id, kind, path, size_bytes AS sizeBytes, status, message, created_at AS createdAt
       FROM backup_runs ORDER BY id DESC LIMIT ?`
    )
    .all(limit)) as BackupInfo[]
}

export async function lastBackup(db: DB, kind?: 'auto' | 'manual') {
  return (await db
    .prepare(`SELECT status, message, created_at AS createdAt FROM backup_runs ${kind ? 'WHERE kind = ?' : ''} ORDER BY id DESC LIMIT 1`)
    .get(...(kind ? [kind] : []))) as { status: 'ok' | 'failed'; message: string | null; createdAt: string } | undefined
}

export async function lastSuccessfulBackup(db: DB, kind: 'auto' | 'manual') {
  return (await db
    .prepare("SELECT created_at AS createdAt FROM backup_runs WHERE kind = ? AND status = 'ok' ORDER BY id DESC LIMIT 1")
    .get(kind)) as { createdAt: string } | undefined
}
