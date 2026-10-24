import { randomBytes } from 'node:crypto'
import mysql from 'mysql2/promise'
import type { Pool } from 'mysql2/promise'
import { afterAll, inject } from 'vitest'
import { createPool, DB } from '../src/server/db/connection'
import { migrate } from '../src/server/db/migrations'
import type { AnonCtx, Ctx } from '../src/server/context'
import { createOrganization, type SetupInput } from '../src/server/services/setup'
import { createUser, login } from '../src/server/services/auth'

/** Fixed clock: 2026-03-10 08:00 Asia/Colombo. Test data is created per test, never shipped. */
export const NOW = new Date('2026-03-10T02:30:00Z')

export function setupInput(overrides: Partial<SetupInput> = {}): SetupInput {
  return {
    farmName: 'Test Farm',
    farmLocation: 'Kurunegala',
    timezone: 'Asia/Colombo',
    language: 'en',
    startDate: '2026-03-01',
    cages: Array.from({ length: 10 }, (_, i) => ({
      code: `C${String(i + 1).padStart(2, '0')}`,
      name: `Cage ${String(i + 1).padStart(2, '0')}`,
      initialHens: 1000,
      hasWaterMeter: true
    })),
    admin: { email: 'admin@test.farm', displayName: 'Admin', password: 'secret123' },
    inventory: [
      { category: 'feed', name: 'Layer Mash', unit: 'kg', lowStockThreshold: 500, openingBalance: 5000, batchNo: null, expiryDate: null },
      { category: 'medicine', name: 'Vitamin Mix', unit: 'ml', lowStockThreshold: 100, openingBalance: 1000, batchNo: 'VM-01', expiryDate: '2026-12-31' }
    ],
    ...overrides
  }
}

const created: { name: string; pool: Pool; dbs: DB[] }[] = []

export function testServer() {
  return inject('mysql')
}

/**
 * The final schema, captured once per test file: a template database is migrated step by step
 * (as a real installation is), and its CREATE TABLE statements are replayed into each test
 * database, with the reference data the migrations seed (the plans). Much faster than running
 * every migration for every test.
 */
const SEEDED = ['plans']
let schema: Promise<{ tables: string[]; versions: unknown[][]; seeds: { table: string; rows: Record<string, unknown>[] }[] }> | null = null
function finalSchema() {
  schema ??= (async () => {
    const server = testServer()
    const name = `pfm_tpl_${randomBytes(6).toString('hex')}`
    const admin = await mysql.createConnection({ ...server })
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci`)
    const pool = createPool({ ...server, database: name, connectionLimit: 1 })
    try {
      const db = await DB.connect(pool, name)
      await migrate(db)
      const names = (await db.prepare("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'").all()) as { t: string }[]
      const tables: string[] = []
      for (const { t } of names) tables.push(((await db.query(`SHOW CREATE TABLE \`${t}\``)) as Record<string, string>[])[0]['Create Table'])
      const versions = ((await db.prepare('SELECT version, name, applied_at FROM schema_migrations').all()) as { version: number; name: string; applied_at: string }[]).map((r) => [r.version, r.name, r.applied_at])
      const seeds: { table: string; rows: Record<string, unknown>[] }[] = []
      for (const table of SEEDED) seeds.push({ table, rows: (await db.prepare(`SELECT * FROM \`${table}\` ORDER BY id`).all()) as Record<string, unknown>[] })
      db.release()
      return { tables, versions, seeds }
    } finally {
      await pool.end()
      await admin.query(`DROP DATABASE IF EXISTS ${name}`)
      await admin.end()
    }
  })()
  return schema
}

/** A new, empty database on the test server, with the current schema (or none, unless `migrated`). */
export async function openTestDb(migrated = true): Promise<DB> {
  const server = testServer()
  const name = `pfm_test_${randomBytes(6).toString('hex')}`
  const admin = await mysql.createConnection({ ...server })
  await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci`)
  await admin.end()
  const pool = createPool({ ...server, database: name, connectionLimit: 4 })
  const db = await DB.connect(pool, name)
  created.push({ name, pool, dbs: [db] })
  if (migrated) {
    const { tables, versions, seeds } = await finalSchema()
    await db.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const ddl of tables) await db.query(ddl)
    await db.query('SET FOREIGN_KEY_CHECKS = 1')
    await db.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ?', [versions])
    for (const { table, rows } of seeds) {
      if (!rows.length) continue
      const cols = Object.keys(rows[0]!)
      await db.query(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES ?`, [rows.map((r) => cols.map((c) => r[c]))])
    }
  }
  return db
}

/** A second session (connection) on the same test database, e.g. to simulate another request. */
export async function anotherSession(db: DB): Promise<DB> {
  const entry = created.find((c) => c.name === db.name)!
  const other = await DB.connect(entry.pool, db.name)
  entry.dbs.push(other)
  return other
}

// Connections are closed after each test file. The test databases themselves are removed with
// the whole server at the end of the run (see global-setup.ts): dropping them one by one is slow.
afterAll(async () => {
  for (const c of created.splice(0)) {
    for (const d of c.dbs) d.release()
    await c.pool.end()
  }
})

/**
 * A farm organization with an administrator (admin@<domain>) and a data-entry worker
 * (worker@<domain>). Pass `db` to add another organization to the same database. It is on the
 * Enterprise plan unless `plan` says otherwise (the subscription tests use the smaller plans).
 */
export async function makeFarm(opts: { db?: DB; name?: string; domain?: string; plan?: string; trialDays?: number } = {}) {
  const db = opts.db ?? (await openTestDb())
  const domain = opts.domain ?? 'test.farm'
  let now = NOW
  const anon: AnonCtx = { db, now: () => now }
  const org = await createOrganization(anon, setupInput({ farmName: opts.name ?? 'Test Farm', admin: { email: `admin@${domain}`, displayName: 'Admin', password: 'secret123' } }), {
    planCode: opts.plan ?? 'enterprise',
    trialDays: opts.trialDays ?? 0
  })
  const scope = { db, org: org.organizationId, farm: org.farmId, now: () => now }
  const adminCtx: Ctx = { ...scope, user: (await login(anon, `admin@${domain}`, 'secret123')).user }
  const roleId = async (where: string) => ((await db.prepare(`SELECT id FROM roles WHERE organization_id = ? AND ${where}`).get(org.organizationId)) as { id: number }).id
  const roles = { admin: await roleId('is_admin = 1'), worker: await roleId("name = 'Farm Worker'") }
  await createUser(adminCtx, { email: `worker@${domain}`, displayName: 'Worker', password: 'worker123', roleId: roles.worker })
  const workerCtx: Ctx = { ...scope, user: (await login(anon, `worker@${domain}`, 'worker123')).user }
  const cageIds = ((await db.prepare('SELECT id FROM cages WHERE farm_id = ? ORDER BY sort_order').all(org.farmId)) as { id: number }[]).map((r) => r.id)
  const feedId = ((await db.prepare("SELECT id FROM inventory_items WHERE organization_id = ? AND category='feed'").get(org.organizationId)) as { id: number }).id
  const medId = ((await db.prepare("SELECT id FROM inventory_items WHERE organization_id = ? AND category='medicine'").get(org.organizationId)) as { id: number }).id
  return {
    db,
    anon,
    org: org.organizationId,
    farm: org.farmId,
    orgCode: org.organizationCode,
    domain,
    roles,
    /** Signs a user in again (after their role or cages changed): the server reloads them on every request. */
    signIn: async (email: string, password: string): Promise<Ctx> => ({ ...scope, user: (await login(anon, email, password)).user }),
    admin: adminCtx,
    worker: workerCtx,
    cageIds,
    feedId,
    medId,
    setNow: (d: Date) => {
      now = d
    }
  }
}

export type Farm = Awaited<ReturnType<typeof makeFarm>>
