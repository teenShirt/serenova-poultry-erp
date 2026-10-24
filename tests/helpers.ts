import { randomBytes } from 'node:crypto'
import mysql from 'mysql2/promise'
import type { Pool } from 'mysql2/promise'
import { afterAll, inject } from 'vitest'
import { createPool, DB } from '../src/server/db/connection'
import { migrate } from '../src/server/db/migrations'
import type { Ctx } from '../src/server/context'
import { completeSetup, type SetupInput } from '../src/server/services/setup'
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
    admin: { username: 'admin', displayName: 'Admin', password: 'secret123' },
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

/** A new, empty database on the test server (not yet migrated unless `migrated`). */
export async function openTestDb(migrated = true): Promise<DB> {
  const server = testServer()
  const name = `pfm_test_${randomBytes(6).toString('hex')}`
  const admin = await mysql.createConnection({ ...server })
  await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci`)
  await admin.end()
  const pool = createPool({ ...server, database: name, connectionLimit: 4 })
  const db = await DB.connect(pool, name)
  created.push({ name, pool, dbs: [db] })
  if (migrated) await migrate(db)
  return db
}

/** A second session (connection) on the same test database, e.g. to simulate another request. */
export async function anotherSession(db: DB): Promise<DB> {
  const entry = created.find((c) => c.name === db.name)!
  const other = await DB.connect(entry.pool, db.name)
  entry.dbs.push(other)
  return other
}

afterAll(async () => {
  const server = testServer()
  const admin = await mysql.createConnection({ ...server })
  for (const c of created.splice(0)) {
    for (const d of c.dbs) d.release()
    await c.pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${c.name}`)
  }
  await admin.end()
})

export async function makeFarm() {
  const db = await openTestDb()
  let now = NOW
  const base: Ctx = { db, user: null, now: () => now }
  await completeSetup(base, setupInput())
  const admin = await login(base, 'admin', 'secret123')
  const adminCtx: Ctx = { db, user: admin, now: () => now }
  await createUser(adminCtx, { username: 'worker', displayName: 'Worker', password: 'worker123', role: 'operator' })
  const worker = await login(base, 'worker', 'worker123')
  const workerCtx: Ctx = { db, user: worker, now: () => now }
  const cageIds = ((await db.prepare('SELECT id FROM cages ORDER BY sort_order').all()) as { id: number }[]).map((r) => r.id)
  const feedId = ((await db.prepare("SELECT id FROM inventory_items WHERE category='feed'").get()) as { id: number }).id
  const medId = ((await db.prepare("SELECT id FROM inventory_items WHERE category='medicine'").get()) as { id: number }).id
  return {
    db,
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
