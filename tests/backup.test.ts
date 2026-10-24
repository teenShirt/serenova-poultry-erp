import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../src/server/errors'
import type { Ctx } from '../src/server/context'
import type { DB } from '../src/server/db/connection'
import { currentSchemaVersion, DATA_TABLES, latestSchemaVersion, migrate } from '../src/server/db/migrations'
import { applyRetention, createBackup, dumpDatabase, inspectBackup, restoreDatabase, restoreOrganization } from '../src/server/services/backup'
import { login } from '../src/server/services/auth'
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

/** A signed-in context for an organization after its records were restored (ids change on restore). */
async function signedIn(db: DB, email: string, password: string): Promise<Ctx> {
  const s = await login({ db, now: () => NOW }, email, password)
  return { db, now: () => NOW, org: s.org, farm: s.farm, user: s.user }
}

const counts = async (db: DB, orgId: number) => {
  const out: Record<string, number> = {}
  for (const t of DATA_TABLES) {
    if (t === 'organizations') continue
    out[t] = ((await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE organization_id = ?`).get(orgId)) as { n: number }).n
  }
  return out
}

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

describe('organization backup and restore', () => {
  it('backs up one organization, verifies it, and restores it', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    await addMovement(f.worker, { date: '2026-03-09', cageId: f.cageIds[0], type: 'death', quantity: 7, reason: null, notes: null })
    const b = await createBackup(f.db, dir, 'manual', { orgId: f.org })
    expect(b.status).toBe('ok')
    expect(path.basename(b.path!)).toMatch(/^PoultryFarm-test-farm-\d{8}-\d{6}-manual\.pfmbackup$/)
    const check = await inspectBackup(b.path!)
    expect(check).toMatchObject({ ok: true, farmName: 'Test Farm', lastDate: '2026-03-09', dayCount: 1 })
    expect(check.data!.scope).toBe('organization')

    // Change the data after the backup, then restore.
    await addMovement(f.worker, { date: '2026-03-09', cageId: f.cageIds[0], type: 'death', quantity: 100, reason: null, notes: null })
    await f.db
      .prepare(
        "INSERT INTO sessions (id, user_id, organization_id, mode, created_at, last_seen_at, expires_at) VALUES (REPEAT('a', 64), 1, ?, 'farm', 'x', 'x', 'x')"
      )
      .run(f.org)
    await restoreOrganization(f.db, f.org, check.data!)
    const admin = await signedIn(f.db, 'admin@test.farm', 'secret123')
    expect((await getOverview(admin, '2026-03-09')).cages[0].closing).toBe(993)
    // Everyone in the organization signs in again: the restored data has its own accounts.
    expect(((await f.db.prepare('SELECT COUNT(*) n FROM sessions WHERE organization_id = ?').get(f.org)) as { n: number }).n).toBe(0)
    // New records continue normally after the restored ones.
    const worker = await signedIn(f.db, 'worker@test.farm', 'worker123')
    const cage = (await getOverview(worker, '2026-03-09')).cages[1].cageId
    await addMovement(worker, { date: '2026-03-09', cageId: cage, type: 'death', quantity: 1, reason: null, notes: null })
  })

  it("restoring one organization never changes another organization's records", async () => {
    const a = await makeFarm()
    const b = await makeFarm({ db: a.db, name: 'Other Farm', domain: 'other.farm' })
    await startDay(a.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    await startDay(b.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    await addMovement(b.worker, { date: '2026-03-09', cageId: b.cageIds[0], type: 'death', quantity: 3, reason: null, notes: null })
    const backupOfA = await dumpDatabase(a.db, { orgId: a.org })
    const before = { b: await counts(a.db, b.org), dump: await dumpDatabase(a.db, { orgId: b.org }) }

    await addMovement(a.worker, { date: '2026-03-09', cageId: a.cageIds[0], type: 'death', quantity: 50, reason: null, notes: null })
    await restoreOrganization(a.db, a.org, backupOfA)

    expect(await counts(a.db, b.org)).toEqual(before.b)
    expect((await dumpDatabase(a.db, { orgId: b.org })).tables).toEqual(before.dump.tables)
    expect((await getOverview(b.worker, '2026-03-09')).cages[0].closing).toBe(997)
    // Every record of A now points only at A's records (new ids, references moved with them).
    const restored = await signedIn(a.db, 'admin@test.farm', 'secret123')
    expect((await getOverview(restored, '2026-03-09')).cages[0].closing).toBe(1000)
  })

  it('whole-database backups restore every table and value intact (platform use)', async () => {
    const f = await makeFarm()
    await makeFarm({ db: f.db, name: 'Other Farm', domain: 'other.farm' })
    await startDay(f.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    const before = await dumpDatabase(f.db)
    expect(before.scope).toBe('database')
    const fresh = await openTestDb()
    await restoreDatabase(fresh, before)
    const after = await dumpDatabase(fresh)
    for (const t of DATA_TABLES) expect(after.tables[t], t).toEqual(before.tables[t])
    // An organization backup cannot be used as a whole-database backup, or the other way round.
    await expect(restoreDatabase(fresh, await dumpDatabase(f.db, { orgId: f.org }))).rejects.toThrow('not_a_database_backup')
    await expect(restoreOrganization(fresh, f.org, before)).rejects.toThrow('not_an_organization_backup')
  })

  it('imports a backup made by the desktop (SQLite) edition into an organization, with email addresses', async () => {
    // A desktop backup is an SQLite file with the same tables and columns as before organizations
    // existed (no organization or farm columns, no email), marked with application_id 'PFM1'.
    const src = await makeFarm({ name: 'Madawala Test' })
    await startDay(src.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    await addMovement(src.worker, { date: '2026-03-09', cageId: src.cageIds[0], type: 'death', quantity: 7, reason: null, notes: null })
    const data = await dumpDatabase(src.db, { orgId: src.org })
    const file = path.join(dir, 'PoultryFarm-20260310-080000-manual.pfmbackup')
    const s = new Database(file)
    s.pragma('application_id = 0x50464d31')
    s.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)')
    s.prepare("INSERT INTO schema_migrations VALUES (3, 'desktop', 'x')").run()
    // Only the desktop edition's tables and columns (organizations, farms, roles, flocks, stores and tasks came later).
    const later = [
      'organizations',
      'farms',
      'roles',
      'role_permissions',
      'houses',
      'flocks',
      'flock_placements',
      'flock_reminders',
      'flock_reminder_done',
      'warehouses',
      'purchase_orders',
      'purchase_order_lines',
      'stock_counts',
      'stock_count_lines',
      'task_series',
      'tasks',
      'task_events'
    ]
    const laterColumns = [
      'organization_id',
      'farm_id',
      'email',
      'role_id',
      'house_id',
      'warehouse_id',
      'counterpart_warehouse_id',
      'transfer_ref',
      'po_id',
      'po_line_id',
      'status',
      'client_ref',
      'approved_by',
      'approved_at',
      'cancelled_by',
      'cancelled_at',
      'cancel_reason',
      'delivery_note',
      'ordered_qty',
      'rejected_qty',
      'damaged_qty',
      'reject_reason',
      'sku',
      'reorder_level',
      'default_supplier_id'
    ]
    for (const t of DATA_TABLES) {
      if (later.includes(t)) continue
      const { columns, rows } = data.tables[t]
      const keep = columns.map((c, i) => [c, i] as const).filter(([c]) => !laterColumns.includes(c) || (c === 'status' && t !== 'goods_receipts'))
      s.exec(`CREATE TABLE ${t} (${keep.map(([c]) => `"${c}"`).join(', ')})`)
      const ins = s.prepare(`INSERT INTO ${t} VALUES (${keep.map(() => '?').join(', ')})`)
      for (const r of rows) ins.run(...keep.map(([, i]) => r[i]))
    }
    s.close()

    const check = await inspectBackup(file)
    expect(check).toMatchObject({ ok: true, schemaVersion: 3, farmName: 'Madawala Test', lastDate: '2026-03-09', dayCount: 1 })
    const target = await makeFarm({ name: 'Imported', domain: 'imported.farm' })
    await restoreOrganization(target.db, target.org, check.data!, { emails: { admin: 'owner@madawala.lk', worker: 'staff@madawala.lk' } })
    // The desktop accounts sign in with their old passwords and their new email addresses.
    const owner = await signedIn(target.db, 'owner@madawala.lk', 'secret123')
    expect(owner.org).toBe(target.org)
    expect((await getOverview(owner, '2026-03-09')).cages[0].closing).toBe(993)
    expect((await signedIn(target.db, 'staff@madawala.lk', 'worker123')).user!.username).toBe('worker')
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

  it('retention removes only the oldest automatic backups, per organization', () => {
    const names = [
      'PoultryFarm-hill-20260101-010000-auto.pfmbackup',
      'PoultryFarm-hill-20260102-010000-auto.pfmbackup',
      'PoultryFarm-hill-20260103-010000-auto.pfmbackup',
      'PoultryFarm-hill-20260101-090000-manual.pfmbackup',
      'PoultryFarm-vale-20260101-010000-auto.pfmbackup',
      'my-notes.txt'
    ]
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x')
    expect(applyRetention(dir, 2, 'hill')).toEqual(['PoultryFarm-hill-20260101-010000-auto.pfmbackup'])
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
        recordTxn(ctx, {
          itemId: f.feedId,
          type: 'issue',
          quantity: 3000,
          date: '2026-03-09',
          batchNo: null,
          expiryDate: null,
          unitCost: null,
          supplier: null,
          reference: null,
          notes: null,
          cageId: null
        })
      )
    const results = await Promise.allSettled([take(f.admin), take(other)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((failed.reason as AppError).code).toBe('insufficient_stock')
    expect(await itemBalance(f.admin, f.feedId)).toBe(2000)
  })
})

describe('demo data', () => {
  it('generates a consistent sample organization', async () => {
    const db = await openTestDb()
    await seedDemo(db, new Date('2026-03-10T05:00:00Z'), 20)
    const days = (await db.prepare('SELECT status, COUNT(*) n FROM farm_days GROUP BY status ORDER BY status').all()) as { status: string; n: number }[]
    expect(days).toEqual([
      { status: 'closed', n: 20 },
      { status: 'in_progress', n: 1 }
    ])
    const neg = await db.prepare('SELECT item_id, SUM(quantity) b FROM inventory_transactions GROUP BY item_id HAVING b < 0').all()
    expect(neg).toEqual([])
    const demo = await login({ db, now: () => new Date('2026-03-10T05:00:00Z') }, 'demo@example.com', 'demo123')
    const ov = await getOverview({ db, now: () => new Date('2026-03-10T05:00:00Z'), org: demo.org, farm: demo.farm, user: demo.user }, '2026-03-09')
    expect(ov.status).toBe('closed')
    expect(ov.totals.productionPct).toBeGreaterThan(70)
  })
})
