import mysql from 'mysql2/promise'
import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise'
import type { PoolConnection as CorePoolConnection } from 'mysql2'

const SESSION_SETUP =
  "SET SESSION sql_mode = 'STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', " +
  "time_zone = '+00:00', NAMES utf8mb4 COLLATE utf8mb4_0900_as_ci"

export interface DbConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  connectionLimit?: number
}

export interface RunResult {
  lastInsertRowid: number
  changes: number
}

export interface Statement {
  get(...params: unknown[]): Promise<unknown>
  all(...params: unknown[]): Promise<unknown[]>
  run(...params: unknown[]): Promise<RunResult>
}

/**
 * Creates a connection pool for one farm database. Every connection uses strict SQL, UTC and
 * utf8mb4 (Sinhala text), returns DATE columns as 'YYYY-MM-DD' strings and sums as numbers,
 * so query results look exactly like the values the services work with.
 */
export function createPool(cfg: DbConfig): Pool {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: cfg.connectionLimit ?? 10,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    // UPDATE reports rows matched (not only rows whose values changed), like SQLite's changes().
    flags: ['FOUND_ROWS']
  })
  // Runs on each new connection before any other query is sent on it (mysql2 queues commands in order).
  // mysql2 passes the underlying callback-style connection to this event, despite the promise typings.
  pool.on('connection', (conn) => {
    ;(conn as unknown as CorePoolConnection).query(SESSION_SETUP, (err) => {
      if (err) console.error('Could not configure a database connection:', err)
    })
  })
  return pool
}

const normalize = (params: unknown[]) => params.map((p) => (p === undefined ? null : p))

/**
 * One database session (a single pooled connection). The API is shaped like better-sqlite3
 * (`prepare(sql).get/all/run`, `transaction(fn)`), but every call is async.
 *
 * Transactions nest: the outermost one is a real transaction, inner ones are savepoints, so a
 * service that runs inside another service's transaction still rolls back as a unit.
 */
export class DB {
  private depth = 0
  private savepoint = 0

  constructor(
    private readonly conn: PoolConnection,
    readonly name: string
  ) {}

  /** Borrows a connection from the pool. Call release() when done (see withDb). */
  static async connect(pool: Pool, name: string): Promise<DB> {
    return new DB(await pool.getConnection(), name)
  }

  release() {
    this.conn.release()
  }

  get inTransaction() {
    return this.depth > 0
  }

  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    const [rows] = await this.conn.query(sql, normalize(params))
    return rows
  }

  prepare(sql: string): Statement {
    return {
      get: async (...params) => {
        const rows = (await this.query(sql, params)) as unknown[]
        return rows[0]
      },
      all: async (...params) => (await this.query(sql, params)) as unknown[],
      run: async (...params) => {
        const r = (await this.query(sql, params)) as ResultSetHeader
        return { lastInsertRowid: Number(r.insertId), changes: r.affectedRows }
      }
    }
  }

  /** Runs one or more statements separated by `;` at the end of a line (used by migrations). */
  async exec(sql: string) {
    for (const stmt of splitStatements(sql)) await this.conn.query(stmt)
  }

  /** Wraps `fn` in a transaction (or a savepoint when already inside one). Returns a callable, like better-sqlite3. */
  transaction<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
    return async (...args: A) => {
      if (this.depth === 0) {
        await this.conn.query('START TRANSACTION')
        this.depth++
        try {
          const result = await fn(...args)
          await this.conn.query('COMMIT')
          return result
        } catch (e) {
          await this.conn.query('ROLLBACK').catch(() => undefined)
          throw e
        } finally {
          this.depth--
        }
      }
      const sp = `sp_${++this.savepoint}`
      await this.conn.query(`SAVEPOINT ${sp}`)
      this.depth++
      try {
        const result = await fn(...args)
        await this.conn.query(`RELEASE SAVEPOINT ${sp}`)
        return result
      } catch (e) {
        await this.conn.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined)
        throw e
      } finally {
        this.depth--
      }
    }
  }

  /**
   * Serializes data changes across all requests (and server processes) for this database.
   * The desktop app relied on SQLite running one write at a time; holding this named lock
   * keeps checks like "stock never goes negative" free of races between concurrent requests.
   */
  async withWriteLock<T>(fn: () => Promise<T>, timeoutSeconds = 30): Promise<T> {
    const lockName = `pfm_write:${this.name}`
    const [rows] = await this.conn.query('SELECT GET_LOCK(?, ?) AS got', [lockName, timeoutSeconds])
    if ((rows as { got: number | null }[])[0]?.got !== 1) throw new Error('DATABASE_BUSY')
    try {
      return await fn()
    } finally {
      await this.conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined)
    }
  }
}

/** Borrows a connection for the duration of `fn`. */
export async function withDb<T>(pool: Pool, name: string, fn: (db: DB) => Promise<T>): Promise<T> {
  const db = await DB.connect(pool, name)
  try {
    return await fn(db)
  } finally {
    db.release()
  }
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
}
