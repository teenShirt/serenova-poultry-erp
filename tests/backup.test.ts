import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../src/server/errors'
import { currentSchemaVersion, DATA_TABLES, latestSchemaVersion, migrate } from '../src/server/db/migrations'
import { applyRetention, createBackup, dumpDatabase, inspectBackup, restoreData } from '../src/server/services/backup'
import { getOverview, startDay } from '../src/server/services/days'
import { addMovement } from '../src/server/services/flock'
import { itemBalance, recordTxn } from '../src/server/services/inventory'
import { seedDemo } from '../src/server/services/demo'
import { anotherSession, makeFarm, NOW, openTestDb } from './helpers'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-test-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('creates the schema once and is idempotent', async () => {
    const db = await openTestDb()
    expect(await currentSchemaVersion(db)).toBe(latestSchemaVersion())
    expect(await migrate(db)).toEqual({ from: latestSchemaVersion(), to: latestSchemaVersion() })
  })

  it('keeps existing records when migrated again (upgrade path)', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    await migrate(f.db)
    expect(((await f.db.prepare('SELECT COUNT(*) n FROM farm_days').get()) as { n: number }).n).toBe(1)
    expect(((await f.db.prepare('SELECT COUNT(*) n FROM cages').get()) as { n: number }).n).toBe(10)
  })

  it('refuses a database from a newer version', async () => {
    const db = await openTestDb()
    await db.prepare("INSERT INTO schema_migrations VALUES (999, 'future', 'x')").run()
    await expect(migrate(db)).rejects.toThrow(/DATABASE_TOO_NEW/)
  })
})

describe('backup and restore', () => {
  it('backs up a consistent copy, verifies it, and restores it', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    await addMovement(f.worker, { date: '2026-03-09', cageId: f.cageIds[0], type: 'death', quantity: 7, reason: null, notes: null })
    const b = await createBackup(f.db, path.join(dir, 'backups'), 'manual')
    expect(b.status).toBe('ok')
    const check = await inspectBackup(b.path!)
    expect(check).toMatchObject({ ok: true, farmName: 'Test Farm', lastDate: '2026-03-09', dayCount: 1 })

    // Change live data after the backup, then restore.
    await addMovement(f.worker, { date: '2026-03-09', cageId: f.cageIds[0], type: 'death', quantity: 100, reason: null, notes: null })
    await f.db.prepare("INSERT INTO sessions (id, user_id, mode, created_at, last_seen_at, expires_at) VALUES (REPEAT('a', 64), 1, 'farm', 'x', 'x', 'x')").run()
    await restoreData(f.db, check.data!)
    expect((await getOverview(f.admin, '2026-03-09')).cages[0].closing).toBe(993)
    // Everyone is signed out: the restored data has its own users.
    expect(((await f.db.prepare('SELECT COUNT(*) n FROM sessions').get()) as { n: number }).n).toBe(0)
    // New records continue after the restored ones.
    await addMovement(f.worker, { date: '2026-03-09', cageId: f.cageIds[1], type: 'death', quantity: 1, reason: null, notes: null })
  })

  it('restores into an empty database with every table and value intact', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    const before = await dumpDatabase(f.db)
    const fresh = await openTestDb()
    await restoreData(fresh, before)
    const after = await dumpDatabase(fresh)
    for (const t of DATA_TABLES) expect(after.tables[t], t).toEqual(before.tables[t])
  })

  it('imports a backup made by the desktop (SQLite) edition', async () => {
    // A desktop backup is an SQLite file with the same tables and columns, marked with application_id 'PFM1'.
    const f = await makeFarm()
    await startDay(f.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    await addMovement(f.worker, { date: '2026-03-09', cageId: f.cageIds[0], type: 'death', quantity: 7, reason: null, notes: null })
    const data = await dumpDatabase(f.db)
    const file = path.join(dir, 'PoultryFarm-20260310-080000-manual.pfmbackup')
    const s = new Database(file)
    s.pragma('application_id = 0x50464d31')
    s.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)')
    s.prepare("INSERT INTO schema_migrations VALUES (3, 'desktop', 'x')").run()
    for (const t of DATA_TABLES) {
      const { columns, rows } = data.tables[t]
      s.exec(`CREATE TABLE ${t} (${columns.map((c) => `"${c}"`).join(', ')})`)
      const ins = s.prepare(`INSERT INTO ${t} VALUES (${columns.map(() => '?').join(', ')})`)
      for (const r of rows) ins.run(...r)
    }
    s.close()

    const check = await inspectBackup(file)
    expect(check).toMatchObject({ ok: true, schemaVersion: 3, farmName: 'Test Farm', lastDate: '2026-03-09', dayCount: 1 })
    const fresh = await openTestDb()
    await restoreData(fresh, check.data!)
    expect((await getOverview({ db: fresh, user: null, now: () => NOW }, '2026-03-09')).cages[0].closing).toBe(993)
  })

  it('rejects files that are not intact farm backups', async () => {
    const junk = path.join(dir, 'junk.pfmbackup')
    fs.writeFileSync(junk, 'not a database')
    expect((await inspectBackup(junk)).ok).toBe(false)
    const other = path.join(dir, 'other.db')
    const o = new Database(other)
    o.exec('CREATE TABLE t (x)')
    o.close()
    expect(await inspectBackup(other)).toMatchObject({ ok: false, error: 'not_a_farm_backup' })
  })

  it('retention removes only the oldest automatic backups', () => {
    const names = [
      'PoultryFarm-20260101-010000-auto.pfmbackup',
      'PoultryFarm-20260102-010000-auto.pfmbackup',
      'PoultryFarm-20260103-010000-auto.pfmbackup',
      'PoultryFarm-20260101-090000-manual.pfmbackup',
      'my-notes.txt'
    ]
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x')
    expect(applyRetention(dir, 2)).toEqual(['PoultryFarm-20260101-010000-auto.pfmbackup'])
    expect(fs.readdirSync(dir).sort()).toEqual(names.slice(1).sort())
  })
})

describe('simultaneous requests', () => {
  it('data changes run one at a time, so two requests cannot both spend the same stock', async () => {
    const f = await makeFarm()
    const other = { ...f.admin, db: await anotherSession(f.db) }
    // 5000 kg in store; each request takes 3000 kg. Only one may succeed.
    const take = (ctx: typeof f.admin) =>
      ctx.db.withWriteLock(() =>
        recordTxn(ctx, { itemId: f.feedId, type: 'issue', quantity: 3000, date: '2026-03-09', batchNo: null, expiryDate: null, unitCost: null, supplier: null, reference: null, notes: null, cageId: null })
      )
    const results = await Promise.allSettled([take(f.admin), take(other)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((failed.reason as AppError).code).toBe('insufficient_stock')
    expect(await itemBalance(f.admin, f.feedId)).toBe(2000)
  })
})

describe('demo data', () => {
  it('generates a consistent sample database', async () => {
    const db = await openTestDb()
    await seedDemo(db, new Date('2026-03-10T05:00:00Z'), 20)
    const days = (await db.prepare('SELECT status, COUNT(*) n FROM farm_days GROUP BY status ORDER BY status').all()) as { status: string; n: number }[]
    expect(days).toEqual([
      { status: 'closed', n: 20 },
      { status: 'in_progress', n: 1 }
    ])
    const neg = await db.prepare('SELECT item_id, SUM(quantity) b FROM inventory_transactions GROUP BY item_id HAVING b < 0').all()
    expect(neg).toEqual([])
    const ov = await getOverview({ db, user: null, now: () => new Date('2026-03-10T05:00:00Z') }, '2026-03-09')
    expect(ov.status).toBe('closed')
    expect(ov.totals.productionPct).toBeGreaterThan(70)
  })
})
