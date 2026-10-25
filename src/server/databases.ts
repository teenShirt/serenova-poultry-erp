import mysql from 'mysql2/promise'
import type { Pool } from 'mysql2/promise'
import type { ServerConfig } from './config'
import { createPool, DB, withDb } from './db/connection'
import { configureBackupEncryption, createBackup } from './services/backup'
import { currentSchemaVersion, migrate } from './db/migrations'
import os from 'node:os'
import { APP_VERSION } from './version'
import { seedDemo } from './services/demo'

export type Mode = 'farm' | 'demo'

/**
 * The farm database and the separate demonstration database. Demonstration data never lives in
 * the farm database, so resetting it cannot touch genuine records.
 */
export class Databases {
  private constructor(
    readonly cfg: ServerConfig,
    private readonly farmPool: Pool,
    private readonly demoPool: Pool | null
  ) {}

  /** Creates the databases if needed (and allowed), then brings their tables up to date. */
  static async open(cfg: ServerConfig): Promise<Databases> {
    configureBackupEncryption(cfg.backupKey)
    await ensureDatabase(cfg, cfg.db.database, true)
    let demoOk = false
    if (cfg.demoDatabase) {
      try {
        await ensureDatabase(cfg, cfg.demoDatabase, false)
        demoOk = true
      } catch (e) {
        console.warn(`Demonstration data is unavailable: database ${cfg.demoDatabase} could not be created (${(e as Error).message}).`)
      }
    }
    const farmPool = createPool(cfg.db)
    const demoPool = demoOk && cfg.demoDatabase ? createPool({ ...cfg.db, database: cfg.demoDatabase, connectionLimit: 3 }) : null
    const dbs = new Databases(cfg, farmPool, demoPool)
    // Before an existing database is changed, a full backup of it is written to the backup folder.
    const safetyBackup = (db: DB) => async (from: number) => {
      const b = await createBackup(db, cfg.backupDir, 'pre_migration', { orgId: null, log: false })
      if (b.status !== 'ok') throw new Error(`Could not back up the database before upgrading it (schema v${from}): ${b.message}`)
      console.log(`Backed up ${db.name} (schema v${from}) before upgrading it: ${b.path}`)
    }
    await dbs.with('farm', async (db) => {
      try {
        const m = await migrate(db, { beforeChanges: safetyBackup(db) })
        await recordDeployment(db, cfg, { from: m.from, to: m.to, error: null })
      } catch (e) {
        // Recorded when the database can still take it (for the platform console), then the start fails.
        await recordDeployment(db, cfg, { from: await currentSchemaVersion(db).catch(() => 0), to: 0, error: (e as Error).message }).catch(() => undefined)
        throw e
      }
    })
    if (demoPool) await dbs.with('demo', (db) => migrate(db))
    return dbs
  }

  get demoAvailable() {
    return this.demoPool !== null
  }

  name(mode: Mode): string {
    return mode === 'demo' ? this.cfg.demoDatabase! : this.cfg.db.database
  }

  /** Human-readable location of a database, e.g. "localhost:3306 / poultry_farm". */
  location(mode: Mode) {
    return `${this.cfg.db.host}:${this.cfg.db.port} / ${this.name(mode)}`
  }

  pool(mode: Mode): Pool {
    if (mode === 'demo') {
      if (!this.demoPool) throw new Error('DEMO_UNAVAILABLE')
      return this.demoPool
    }
    return this.farmPool
  }

  with<T>(mode: Mode, fn: (db: DB) => Promise<T>): Promise<T> {
    return withDb(this.pool(mode), this.name(mode), fn)
  }

  /** Deletes every table of the demonstration database and fills it with fresh sample data. */
  async resetDemo() {
    await this.with('demo', async (db) => {
      const tables = (await db
        .prepare("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")
        .all()) as { t: string }[]
      await db.query('SET FOREIGN_KEY_CHECKS = 0')
      try {
        for (const { t } of tables) await db.query(`DROP TABLE IF EXISTS \`${t}\``)
      } finally {
        await db.query('SET FOREIGN_KEY_CHECKS = 1')
      }
      await migrate(db)
      await seedDemo(db)
    })
  }

  async close() {
    await this.farmPool.end()
    await this.demoPool?.end()
  }
}

/** CREATE DATABASE IF NOT EXISTS, tolerating a server account that may use but not create databases. */
async function ensureDatabase(cfg: ServerConfig, name: string, required: boolean) {
  const conn = await mysql.createConnection({ host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password })
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci`)
  } catch (e) {
    const [rows] = await conn.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = ?', [name])
    if ((rows as unknown[]).length === 0) {
      if (required) throw new Error(`Database ${name} does not exist and could not be created: ${(e as Error).message}`)
      throw e
    }
  } finally {
    await conn.end()
  }
}

/**
 * Records the release this server started with (version, commit, environment, database upgrade).
 * A restart of the same release only updates its last start.
 */
async function recordDeployment(db: DB, cfg: ServerConfig, r: { from: number; to: number; error: string | null }) {
  const now = new Date().toISOString()
  const last = (await db.prepare('SELECT id, version, release_sha, environment, status FROM deployments ORDER BY id DESC LIMIT 1').get()) as
    | { id: number; version: string; release_sha: string | null; environment: string; status: string }
    | undefined
  if (
    !r.error &&
    last &&
    last.status === 'ok' &&
    last.version === APP_VERSION &&
    last.release_sha === cfg.releaseSha &&
    last.environment === cfg.environment &&
    r.from === r.to
  ) {
    await db.prepare('UPDATE deployments SET last_started_at = ?, restarts = restarts + 1 WHERE id = ?').run(now, last.id)
    return
  }
  await db
    .prepare(
      `INSERT INTO deployments (version, release_sha, environment, host, schema_from, schema_to, status, error, started_at, last_started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      APP_VERSION,
      cfg.releaseSha,
      cfg.environment,
      os.hostname().slice(0, 255),
      r.from,
      r.to,
      r.error ? 'failed' : 'ok',
      r.error?.slice(0, 4000) ?? null,
      now,
      now
    )
}
