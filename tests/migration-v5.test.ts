import { describe, expect, it } from 'vitest'
import { latestSchemaVersion, migrate } from '../src/server/db/migrations'
import { openTestDb } from './helpers'

/**
 * Upgrading an installation that was used by one farm (schema v4) to organizations and farms (v5).
 * Synthetic data only, shaped like a real single-farm installation.
 */
async function singleFarmInstallation() {
  const db = await openTestDb(false)
  await migrate(db, { to: 4 })
  const at = '2026-10-01T02:00:00.000Z'
  await db.exec(`
INSERT INTO app_settings (\`key\`, value, updated_at) VALUES ('farmName', '"Hill Farm"', '${at}'), ('farmLocation', '"Kandy"', '${at}');
INSERT INTO users (id, username, display_name, password_hash, role, active, created_at) VALUES (1, 'admin', 'Admin', 'x', 'admin', 1, '${at}'), (2, 'worker', 'Worker', 'x', 'operator', 1, '${at}');
INSERT INTO cages (id, code, name, initial_hens, created_at) VALUES (1, '01', 'Cage 01', 1000, '${at}'), (2, '02', 'Cage 02', 900, '${at}');
INSERT INTO farm_days (id, business_date, status, opened_by, opened_at) VALUES (1, '2026-10-01', 'in_progress', 2, '${at}');
INSERT INTO cage_days (id, day_id, cage_id, carried_hens) VALUES (1, 1, 1, 1000), (2, 1, 2, 900);
INSERT INTO egg_collections (id, day_id, cage_id, session, good, recorded_by, created_at, updated_at) VALUES (1, 1, 1, 'morning', 850, 2, '${at}', '${at}');
INSERT INTO inventory_items (id, category, name, unit, created_at) VALUES (1, 'feed', 'Layer Mash', 'kg', '${at}');
INSERT INTO inventory_transactions (id, item_id, txn_date, type, quantity, recorded_by, created_at) VALUES (1, 1, '2026-09-30', 'opening', 5000, 1, '${at}');
INSERT INTO suppliers (id, name, created_at) VALUES (1, 'Prima Feed Mill', '${at}');
INSERT INTO goods_receipts (id, grn_no, receipt_date, supplier_id, recorded_by, created_at) VALUES (1, 'GRN-20261001-001', '2026-10-01', 1, 1, '${at}');
INSERT INTO audit_log (at, user_id, username, action, entity) VALUES ('${at}', 1, 'admin', 'login', 'user');
`)
  return db
}

describe('upgrade to organizations and farms (schema v5)', () => {
  it('makes an existing installation organization 1 with one farm, keeping every record', async () => {
    const db = await singleFarmInstallation()
    let backedUpAt: number | null = null
    expect(await migrate(db, { beforeChanges: async (from) => void (backedUpAt = from) })).toEqual({ from: 4, to: latestSchemaVersion() })
    expect(backedUpAt).toBe(4)

    expect(await db.prepare('SELECT id, code, name FROM organizations').all()).toEqual([{ id: 1, code: 'hill-farm', name: 'Hill Farm' }])
    expect(await db.prepare('SELECT id, organization_id, code, name, location FROM farms').all()).toEqual([
      { id: 1, organization_id: 1, code: 'main', name: 'Hill Farm', location: 'Kandy' }
    ])
    for (const t of ['app_settings', 'users', 'cages', 'farm_days', 'cage_days', 'egg_collections', 'inventory_items', 'inventory_transactions', 'suppliers', 'goods_receipts', 'audit_log']) {
      const r = (await db.prepare(`SELECT COUNT(*) AS n, SUM(organization_id = 1) AS mine FROM ${t}`).get()) as { n: number; mine: number }
      expect(r.n, t).toBeGreaterThan(0)
      expect(r.mine, t).toBe(r.n)
    }
    expect(await db.prepare('SELECT farm_id FROM farm_days').all()).toEqual([{ farm_id: 1 }])
    expect(await db.prepare('SELECT DISTINCT farm_id FROM cages').all()).toEqual([{ farm_id: 1 }])
    // Accounts from before email sign-in have no email until one is set.
    expect(await db.prepare('SELECT email FROM users WHERE id = 1').get()).toEqual({ email: null })
  })

  it('lets MySQL reject any record that points at another organization', async () => {
    const db = await singleFarmInstallation()
    await migrate(db)
    await db.exec(`
INSERT INTO organizations (id, code, name, created_at) VALUES (2, 'other', 'Other Org', 'x');
INSERT INTO farms (id, organization_id, code, name, created_at) VALUES (2, 2, 'main', 'Other farm', 'x');
`)
    // Organization 2 tries to record eggs against organization 1's day and cage.
    await expect(
      db.prepare("INSERT INTO egg_collections (organization_id, day_id, cage_id, session, good, created_at, updated_at) VALUES (2, 1, 1, 'evening', 1, 'x', 'x')").run()
    ).rejects.toThrow(/foreign key constraint fails/)
    // ...or to place one of its cages on organization 1's farm.
    await expect(db.prepare("INSERT INTO cages (organization_id, farm_id, code, name, initial_hens, created_at) VALUES (2, 1, '09', 'X', 1, 'x')").run()).rejects.toThrow(
      /foreign key constraint fails/
    )
    // The same date and the same codes are fine in another organization / farm.
    await db.prepare("INSERT INTO farm_days (organization_id, farm_id, business_date, status, opened_at) VALUES (2, 2, '2026-10-01', 'in_progress', 'x')").run()
    await db.prepare("INSERT INTO cages (organization_id, farm_id, code, name, initial_hens, created_at) VALUES (2, 2, '01', 'Cage 01', 10, 'x')").run()
    await db.prepare("INSERT INTO users (organization_id, username, display_name, password_hash, role, created_at) VALUES (2, 'admin', 'A', 'x', 'admin', 'x')").run()
  })

  it('gives existing accounts roles matching what they could do (schema v6)', async () => {
    const db = await singleFarmInstallation()
    await db.exec(`UPDATE users SET duties = '["eggs","flock"]', assigned_cages = '[1]' WHERE id = 2;
INSERT INTO users (id, username, display_name, password_hash, role, active, created_at) VALUES (3, 'helper', 'Helper', 'x', 'operator', 1, 'x');`)
    await migrate(db)
    const users = await db
      .prepare('SELECT u.username, r.name, r.is_admin, u.assigned_cages FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id')
      .all()
    expect(users).toEqual([
      { username: 'admin', name: 'Organization Admin', is_admin: 1, assigned_cages: null },
      { username: 'worker', name: 'Worker (duties)', is_admin: 0, assigned_cages: '[1]' },
      { username: 'helper', name: 'Farm Worker', is_admin: 0, assigned_cages: null }
    ])
    const limited = (await db
      .prepare("SELECT p.permission FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE r.name = 'Worker (duties)' ORDER BY p.permission")
      .all()) as { permission: string }[]
    expect(limited.map((p) => p.permission)).toEqual(['eggs.record', 'flock.record'])
  })

  it('creates an empty schema directly on a new installation', async () => {
    const db = await openTestDb()
    expect(await db.prepare('SELECT COUNT(*) AS n FROM organizations').get()).toEqual({ n: 0 })
  })
})
