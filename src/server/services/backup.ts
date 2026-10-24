import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { BackupFileCheck, BackupInfo } from '@shared/types'
import type { DB } from '../db/connection'
import { DATA_TABLES, latestSchemaVersion, PLATFORM_TABLES, ensureMainStores } from '../db/migrations'
import { ensureRoles } from './roles'

export const BACKUP_EXT = '.pfmbackup'
const FORMAT = 'poultry-farm-manager-backup'
const NAME_RE = /^PoultryFarm-([a-z0-9-]+-)?\d{8}-\d{6}-(manual|auto|pre_restore|pre_migration)(-\d+)?\.pfmbackup$/
// The desktop edition's application_id ('PFM1'), used to recognise its SQLite backups.
const DESKTOP_APP_ID = 0x50464d31

/**
 * Table contents in a compact form: column names once, then one array of values per row.
 * `organization`: one organization's records only. `database`: every organization (platform backups).
 * Desktop-edition backups are read as an organization backup without organization columns.
 */
export interface BackupData {
  format: typeof FORMAT
  formatVersion: 1
  scope: 'organization' | 'database'
  schemaVersion: number
  createdAt: string
  tables: Record<string, { columns: string[]; rows: unknown[][] }>
}

/** Restoring an organization never touches these: sessions are per browser, and backup history describes files on this server. */
const NOT_RESTORED = new Set(['backup_runs', 'organizations'])

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function logRun(db: DB, orgId: number | null, r: Omit<BackupInfo, 'id'>) {
  await db
    .prepare('INSERT INTO backup_runs (organization_id, kind, path, size_bytes, status, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(orgId, r.kind, r.path, r.sizeBytes, r.status, r.message, r.createdAt)
}

async function tableColumns(db: DB, table: string): Promise<string[]> {
  const rows = (await db
    .prepare('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position')
    .all(table)) as { c: string }[]
  return rows.map((r) => r.c)
}

/**
 * Reads the records inside one transaction, so the copy is a consistent point in time:
 * every organization (`orgId` null), or one organization's records only.
 */
export async function dumpDatabase(db: DB, opts: { orgId?: number | null; now?: Date } = {}): Promise<BackupData> {
  const orgId = opts.orgId ?? null
  return db.transaction(async () => {
    const version = (await db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()) as { v: number }
    const tables: BackupData['tables'] = {}
    // Platform tables (plans, subscriptions, platform accounts) only in whole-database backups.
    for (const t of orgId === null ? [...DATA_TABLES, ...PLATFORM_TABLES] : DATA_TABLES) {
      const columns = await tableColumns(db, t)
      if (columns.length === 0) continue // not created yet (a database from before organizations)
      let where = ''
      if (orgId !== null) where = t === 'organizations' ? 'WHERE id = ?' : 'WHERE organization_id = ?'
      const rows = (await db.prepare(`SELECT * FROM ${t} ${where} ORDER BY 1`).all(...(orgId !== null ? [orgId] : []))) as Record<string, unknown>[]
      tables[t] = { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) }
    }
    return {
      format: FORMAT,
      formatVersion: 1,
      scope: orgId === null ? 'database' : 'organization',
      schemaVersion: version.v,
      createdAt: (opts.now ?? new Date()).toISOString(),
      tables
    } as BackupData
  })()
}

/**
 * Writes a compressed snapshot to the backup folder: one organization's records (`orgId`), or
 * the whole database (`orgId` null, platform backups). The file is written as .partial, read back
 * and verified, and only then renamed and reported as successful.
 */
export async function createBackup(
  db: DB,
  folder: string,
  kind: 'manual' | 'auto' | 'pre_restore' | 'pre_migration',
  opts: { orgId?: number | null; now?: Date; log?: boolean } = {}
): Promise<BackupInfo> {
  const now = opts.now ?? new Date()
  const orgId = opts.orgId ?? null
  const createdAt = now.toISOString()
  let file: string | null = null
  const log = opts.log ?? true
  try {
    fs.mkdirSync(folder, { recursive: true })
    const code = orgId === null ? 'all' : ((await db.prepare('SELECT code FROM organizations WHERE id = ?').get(orgId)) as { code: string }).code
    const base = `PoultryFarm-${code}-${stamp(now)}-${kind}`
    file = path.join(folder, `${base}${BACKUP_EXT}`)
    let n = 1
    while (fs.existsSync(file)) file = path.join(folder, `${base}-${n++}${BACKUP_EXT}`)
    const tmp = file + '.partial'
    const data = await dumpDatabase(db, { orgId, now })
    fs.writeFileSync(tmp, gzipSync(JSON.stringify(data)))
    const check = await inspectBackup(tmp)
    if (!check.ok) throw new Error(check.error ?? 'verification failed')
    fs.renameSync(tmp, file)
    const info = { kind, path: file, sizeBytes: fs.statSync(file).size, status: 'ok' as const, message: null, createdAt }
    if (log) await logRun(db, orgId, info)
    return { id: 0, ...info }
  } catch (e) {
    if (file && fs.existsSync(file + '.partial')) fs.rmSync(file + '.partial', { force: true })
    const info = { kind, path: file, sizeBytes: null, status: 'failed' as const, message: (e as Error).message, createdAt }
    if (log) await logRun(db, orgId, info).catch(() => undefined)
    return { id: 0, ...info }
  }
}

/** Deletes the oldest automatic backups of each organization (or of the whole database) beyond the retention count. Manual backups are kept. */
export function applyRetention(folder: string, keep: number, code?: string): string[] {
  if (!fs.existsSync(folder)) return []
  const autos = fs
    .readdirSync(folder)
    .filter((f) => NAME_RE.test(f) && f.includes('-auto') && (code === undefined || f.startsWith(`PoultryFarm-${code}-2`)))
    .sort((a, b) => a.replace(/^PoultryFarm-([a-z0-9-]+-)?/, '').localeCompare(b.replace(/^PoultryFarm-([a-z0-9-]+-)?/, '')))
  const remove = autos.slice(0, Math.max(0, autos.length - Math.max(1, keep)))
  for (const f of remove) fs.rmSync(path.join(folder, f), { force: true })
  return remove
}

/**
 * Reads a backup file: a backup made by this web edition (compressed JSON) or a backup made by
 * the desktop edition (an SQLite database file), which lets existing farm data move over.
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
    data.scope ??= 'database' // backups from before organizations held the whole (single-farm) database
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
    return { format: FORMAT, formatVersion: 1, scope: 'organization', schemaVersion: version, createdAt: fs.statSync(file).mtime.toISOString(), tables }
  } finally {
    sdb.close()
  }
}

/** True for a backup made by the desktop edition (its accounts have no email address yet). */
export function isDesktopBackup(data: BackupData) {
  return data.schemaVersion < 5
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
    for (const t of ['users', 'farm_days', 'app_settings']) {
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

interface Link {
  table: string
  column: string
  parent: string
}

/** The links between records (organization-aware foreign keys), excluding the organization column itself. */
/** Links between records; with `orgOnly`, those between an organization's own tables (not the platform's plans and subscriptions). */
async function links(db: DB, orgOnly = false): Promise<Link[]> {
  const all = (await db
    .prepare(
      `SELECT table_name AS \`table\`, column_name AS \`column\`, referenced_table_name AS parent FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL AND column_name <> 'organization_id'`
    )
    .all()) as Link[]
  const scoped = new Set<string>(DATA_TABLES)
  return orgOnly ? all.filter((l) => scoped.has(l.table) && scoped.has(l.parent)) : all
}

/**
 * Lists links between records that point at a missing record (the MySQL equivalent of SQLite's
 * foreign_key_check), optionally for one organization. Normally empty: MySQL enforces the links.
 */
export async function foreignKeyProblems(db: DB, orgId?: number): Promise<string[]> {
  const problems: string[] = []
  for (const fk of await links(db, orgId !== undefined)) {
    const org = orgId !== undefined ? 'AND x.organization_id = ?' : ''
    const r = (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${fk.table} x LEFT JOIN ${fk.parent} p ON p.id = x.${fk.column} WHERE x.${fk.column} IS NOT NULL AND p.id IS NULL ${org}`
      )
      .get(...(orgId !== undefined ? [orgId] : []))) as { n: number }
    if (r.n > 0) problems.push(`${fk.table}.${fk.column}: ${r.n} broken link(s)`)
  }
  return problems
}

/**
 * Replaces the WHOLE database with a database backup, in one transaction: if anything fails,
 * nothing is changed. Platform use only (command line); never reachable from an organization.
 */
export async function restoreDatabase(db: DB, data: BackupData) {
  if (data.scope !== 'database') throw new Error('not_a_database_backup')
  await db.transaction(async () => {
    await db.query('SET FOREIGN_KEY_CHECKS = 0')
    try {
      const all = [...DATA_TABLES, ...PLATFORM_TABLES]
      for (const t of [...all].reverse()) await db.query(`DELETE FROM ${t}`)
      for (const t of all) await insertRows(db, t, data.tables[t], (_c, v) => v)
      await db.query('DELETE FROM sessions')
    } finally {
      await db.query('SET FOREIGN_KEY_CHECKS = 1')
    }
    for (const o of (await db.prepare('SELECT id FROM organizations').all()) as { id: number }[]) await ensureRoles(db, o.id)
    const problems = await foreignKeyProblems(db)
    if (problems.length) throw new Error('foreign_key_errors: ' + problems.slice(0, 3).join('; '))
  })()
}

async function insertRows(
  db: DB,
  table: string,
  src: { columns: string[]; rows: unknown[][] } | undefined,
  value: (column: string, v: unknown, row: unknown[], cols: string[]) => unknown,
  extra: Record<string, unknown> = {}
) {
  if (!src || src.rows.length === 0) return
  const target = new Set(await tableColumns(db, table))
  const keep = src.columns.map((c, i) => [c, i] as const).filter(([c]) => target.has(c) && !(c in extra))
  const extraCols = Object.keys(extra).filter((c) => target.has(c))
  const cols = [...keep.map(([c]) => c), ...extraCols].map((c) => '`' + c + '`').join(', ')
  for (let i = 0; i < src.rows.length; i += 500) {
    const chunk = src.rows.slice(i, i + 500).map((r) => [...keep.map(([c, j]) => value(c, r[j], r, src.columns)), ...extraCols.map((c) => extra[c])])
    await db.query(`INSERT INTO ${table} (${cols}) VALUES ?`, [chunk])
  }
}

/** Which table an audit entry's entity_id refers to. */
const AUDIT_ENTITY: Record<string, string> = {
  user: 'users',
  cage: 'cages',
  cage_day: 'cages',
  farm_day: 'farm_days',
  egg_collection: 'egg_collections',
  egg_dispatch: 'egg_dispatches',
  egg_store: 'egg_store_adjustments',
  feed_record: 'feed_records',
  flock_movement: 'flock_movements',
  goods_receipt: 'goods_receipts',
  health_event: 'health_events',
  inventory_item: 'inventory_items',
  inventory_transaction: 'inventory_transactions',
  treatment: 'medicine_treatments',
  water_record: 'water_records',
  supplier: 'suppliers',
  customer: 'customers',
  farm: 'farms',
  house: 'houses',
  flock: 'flocks',
  flock_reminder: 'flock_reminders',
  warehouse: 'warehouses',
  purchase_order: 'purchase_orders',
  task: 'tasks',
  task_series: 'task_series'
}

/** Which table a stock transaction's source_id refers to. */
const TXN_SOURCE: Record<string, string> = {
  feed_record: 'feed_records',
  treatment: 'medicine_treatments',
  grn_line: 'goods_receipt_lines',
  stock_count_line: 'stock_count_lines'
}

export interface RestoreOptions {
  /** Email addresses for accounts that have none (desktop backups), by username. */
  emails?: Record<string, string>
}

/**
 * Replaces ONE organization's records with an organization backup (from this web edition, or a
 * desktop-edition backup), in one transaction: if anything fails, nothing is changed. Other
 * organizations' records are never touched.
 *
 * Records get new ids (every id shifted past the highest id in use), and every reference is
 * shifted with them: links between records, the record an audit entry or stock transaction
 * refers to, and the cages a user is assigned to. So a backup can never collide with, or point
 * at, another organization's records.
 */
export async function restoreOrganization(db: DB, orgId: number, data: BackupData, opts: RestoreOptions = {}) {
  if (data.scope !== 'organization') throw new Error('not_an_organization_backup')
  await db.transaction(async () => {
    const tables = DATA_TABLES.filter((t) => !NOT_RESTORED.has(t))
    const hasFarms = !!data.tables['farms']?.rows.length
    await db.query('SET FOREIGN_KEY_CHECKS = 0')
    try {
      // Remove the organization's current records (its farms only if the backup brings its own).
      for (const t of [...tables].reverse()) {
        if (t === 'farms' && !hasFarms) continue
        await db.query(`DELETE FROM ${t} WHERE organization_id = ?`, [orgId])
      }
      // New ids: each table's ids are shifted past the highest id now in use.
      const shift = new Map<string, number>()
      for (const t of tables) {
        const src = data.tables[t]
        if (!src?.rows.length) continue
        const i = src.columns.indexOf('id')
        if (i < 0) continue
        const minOld = src.rows.reduce((m, r) => Math.min(m, Number(r[i])), Infinity)
        const max = ((await db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`).get()) as { m: number }).m
        shift.set(t, max + 1 - minOld)
      }
      const moved = (table: string, v: unknown) => (v === null || v === undefined ? null : Number(v) + (shift.get(table) ?? 0))
      const parentOf = new Map((await links(db, true)).map((l) => [`${l.table}.${l.column}`, l.parent]))
      // Desktop backups have no farms: their cages and days go to the organization's first farm.
      const farm = hasFarms
        ? null
        : (
            (await db.prepare("SELECT id FROM farms WHERE organization_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(orgId)) as
              | { id: number }
              | undefined
          )?.id
      if (!hasFarms && !farm) throw new Error('no_farm')

      // Backups from before stores existed: each farm gets its main store, and the stock goes to the first farm's.
      const hasStores = !!data.tables['warehouses']?.rows.length
      let firstStore: number | null = null
      for (const t of tables) {
        const src = data.tables[t]
        if (t === 'warehouses' && !hasStores) {
          await ensureMainStores(db, orgId)
          firstStore = (
            (await db
              .prepare('SELECT w.id FROM warehouses w JOIN farms f ON f.id = w.farm_id WHERE w.organization_id = ? AND w.is_main = 1 ORDER BY f.id LIMIT 1')
              .get(orgId)) as { id: number }
          ).id
        }
        if (!src?.rows.length) continue
        const extra: Record<string, unknown> = { organization_id: orgId }
        if (!hasFarms && (t === 'cages' || t === 'farm_days')) extra.farm_id = farm
        if ((t === 'inventory_transactions' || t === 'goods_receipts') && !src.columns.includes('warehouse_id')) extra.warehouse_id = firstStore
        await insertRows(
          db,
          t,
          src,
          (c, v, row, cols) => {
            if (c === 'id') return moved(t, v)
            if (c === 'farm_id') return moved('farms', v)
            const parent = parentOf.get(`${t}.${c}`)
            if (parent) return moved(parent, v)
            if (t === 'inventory_transactions' && c === 'source_id') {
              const target = TXN_SOURCE[String(row[cols.indexOf('source_type')])]
              return target ? moved(target, v) : v
            }
            if (t === 'audit_log' && c === 'entity_id') {
              const target = AUDIT_ENTITY[String(row[cols.indexOf('entity')])]
              return target ? moved(target, v) : v
            }
            if (t === 'audit_log' && c === 'user_id') return moved('users', v)
            if (t === 'audit_log' && c === 'day_id') return moved('farm_days', v)
            if (t === 'day_confirmations' && c === 'cage_id') return Number(v) === 0 ? 0 : moved('cages', v)
            if (t === 'users' && c === 'assigned_cages' && typeof v === 'string') {
              try {
                return JSON.stringify((JSON.parse(v) as number[]).map((id) => moved('cages', id)))
              } catch {
                return v
              }
            }
            if (t === 'users' && c === 'email') {
              const username = String(row[cols.indexOf('username')])
              return (v as string | null) ?? opts.emails?.[username]?.trim().toLowerCase() ?? null
            }
            return v
          },
          extra
        )
        // Accounts from the desktop edition get their email address from `emails`.
        if (t === 'users' && !src.columns.includes('email') && opts.emails) {
          for (const [username, email] of Object.entries(opts.emails)) {
            await db.query('UPDATE users SET email = ? WHERE organization_id = ? AND username = ?', [email.trim().toLowerCase(), orgId, username])
          }
        }
      }
      // Everyone in the organization signs in again: the restored data has its own accounts.
      await db.query('DELETE FROM sessions WHERE organization_id = ?', [orgId])
    } finally {
      await db.query('SET FOREIGN_KEY_CHECKS = 1')
    }
    // Backups from before roles existed: give every account the role matching what it could do.
    await ensureRoles(db, orgId)
    const problems = await foreignKeyProblems(db, orgId)
    if (problems.length) throw new Error('foreign_key_errors: ' + problems.slice(0, 3).join('; '))
    // Every link must stay inside the organization (MySQL does not re-check links added while checks were off).
    for (const fk of await links(db, true)) {
      const r = (await db
        .prepare(`SELECT COUNT(*) AS n FROM ${fk.table} x JOIN ${fk.parent} p ON p.id = x.${fk.column} WHERE x.organization_id = ? AND p.organization_id <> ?`)
        .get(orgId, orgId)) as { n: number }
      if (r.n > 0) throw new Error(`foreign_key_errors: ${fk.table}.${fk.column} points at another organization`)
    }
  })()
}

export async function listBackupRuns(db: DB, orgId: number | null, limit = 50): Promise<BackupInfo[]> {
  return (await db
    .prepare(
      `SELECT id, kind, path, size_bytes AS sizeBytes, status, message, created_at AS createdAt
       FROM backup_runs WHERE organization_id <=> ? ORDER BY id DESC LIMIT ?`
    )
    .all(orgId, limit)) as BackupInfo[]
}

export async function lastBackup(db: DB, orgId: number | null, kind?: 'auto' | 'manual') {
  return (await db
    .prepare(
      `SELECT status, message, created_at AS createdAt FROM backup_runs WHERE organization_id <=> ? ${kind ? 'AND kind = ?' : ''} ORDER BY id DESC LIMIT 1`
    )
    .get(...(kind ? [orgId, kind] : [orgId]))) as { status: 'ok' | 'failed'; message: string | null; createdAt: string } | undefined
}

export async function lastSuccessfulBackup(db: DB, orgId: number | null, kind: 'auto' | 'manual') {
  return (await db
    .prepare("SELECT created_at AS createdAt FROM backup_runs WHERE organization_id <=> ? AND kind = ? AND status = 'ok' ORDER BY id DESC LIMIT 1")
    .get(orgId, kind)) as { createdAt: string } | undefined
}
