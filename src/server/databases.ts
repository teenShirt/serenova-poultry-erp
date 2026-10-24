import mysql from 'mysql2/promise'
import type { Pool } from 'mysql2/promise'
import type { ServerConfig } from './config'
import { createPool, DB, withDb } from './db/connection'
import { migrate } from './db/migrations'
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
    await dbs.with('farm', (db) => migrate(db))
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
