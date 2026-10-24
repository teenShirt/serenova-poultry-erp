import type { DB } from './connection'

const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci'

/** Tables owned by an organization (before this migration, everything belonged to the one farm). */
const OWNED = [
  'app_settings',
  'users',
  'cages',
  'farm_days',
  'cage_days',
  'egg_collections',
  'flock_movements',
  'inventory_items',
  'inventory_batches',
  'inventory_transactions',
  'feed_records',
  'water_records',
  'medicine_treatments',
  'health_events',
  'day_confirmations',
  'day_snapshots',
  'day_amendments',
  'audit_log',
  'report_runs',
  'backup_runs',
  'suppliers',
  'customers',
  'goods_receipts',
  'goods_receipt_lines',
  'egg_dispatches',
  'customer_payments',
  'egg_store_adjustments'
]

/** May be empty: platform events (audit) and whole-database backups belong to no organization. */
const NULLABLE_OWNER = new Set(['audit_log', 'backup_runs'])

/** Unique keys that were global and become per organization (or per farm). */
const REKEY: { table: string; drop: string; add: string }[] = [
  { table: 'users', drop: 'ux_users_username', add: 'UNIQUE KEY ux_users_username (organization_id, username)' },
  { table: 'cages', drop: 'ux_cages_code', add: 'UNIQUE KEY ux_cages_code (farm_id, code)' },
  { table: 'farm_days', drop: 'ux_farm_days_date', add: 'UNIQUE KEY ux_farm_days_date (farm_id, business_date)' },
  { table: 'inventory_items', drop: 'ux_items', add: 'UNIQUE KEY ux_items (organization_id, category, name)' },
  { table: 'suppliers', drop: 'ux_suppliers_name', add: 'UNIQUE KEY ux_suppliers_name (organization_id, name)' },
  { table: 'customers', drop: 'ux_customers_name', add: 'UNIQUE KEY ux_customers_name (organization_id, name)' },
  { table: 'goods_receipts', drop: 'ux_grn_no', add: 'UNIQUE KEY ux_grn_no (organization_id, grn_no)' },
  { table: 'egg_dispatches', drop: 'ux_dispatch_no', add: 'UNIQUE KEY ux_dispatch_no (organization_id, dispatch_no)' }
]

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'farm'
  )
}

/**
 * Migration 5: organizations and farms.
 *
 * Every business table gets organization_id, and the day cycle and cages get farm_id. Existing
 * records (an installation that was used by one farm) become organization 1 / farm 1.
 *
 * Every link between records becomes a composite foreign key (organization_id, x) → (organization_id, id),
 * so MySQL itself rejects a record that points at another organization's data, whatever a query does.
 */
export async function addTenancy(db: DB) {
  const now = new Date().toISOString()
  await db.exec(`
CREATE TABLE organizations (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32),
  UNIQUE KEY ux_org_code (code)
) ${T};

CREATE TABLE farms (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(255) NOT NULL,
  location VARCHAR(500),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_farms_code (organization_id, code),
  UNIQUE KEY ux_farms_org_id (organization_id, id),
  CONSTRAINT fk_farms_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ${T};
`)

  // An installation already in use becomes the first organization with one farm.
  let orgId: number | null = null
  let farmId: number | null = null
  const used = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()) as { n: number }
  if (used.n > 0) {
    const s = (await db.prepare("SELECT value FROM app_settings WHERE `key` = 'farmName'").get()) as { value: string } | undefined
    const name = s ? (JSON.parse(s.value) as string) : 'My Poultry Farm'
    const loc = (await db.prepare("SELECT value FROM app_settings WHERE `key` = 'farmLocation'").get()) as { value: string } | undefined
    orgId = (await db.prepare('INSERT INTO organizations (code, name, created_at) VALUES (?, ?, ?)').run(slug(name), name, now)).lastInsertRowid
    farmId = (
      await db
        .prepare('INSERT INTO farms (organization_id, code, name, location, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(orgId, 'main', name, loc ? (JSON.parse(loc.value) as string) || null : null, now)
    ).lastInsertRowid
  }

  // The existing links between records, to be rebuilt as organization-aware links.
  const fks = (await db
    .prepare(
      `SELECT k.constraint_name AS name, k.table_name AS t, k.column_name AS c, k.referenced_table_name AS p, r.delete_rule AS rule
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL AND k.table_name <> 'farms'`
    )
    .all()) as { name: string; t: string; c: string; p: string; rule: string }[]
  for (const fk of fks) await db.query(`ALTER TABLE ${fk.t} DROP FOREIGN KEY ${fk.name}`)
  // MySQL keeps the index it created for each foreign key, under the key's name; the new
  // organization-aware keys bring their own, so these would only clash.
  const leftover = (await db
    .prepare('SELECT DISTINCT table_name AS t, index_name AS i FROM information_schema.statistics WHERE table_schema = DATABASE()')
    .all()) as { t: string; i: string }[]
  const fkNames = new Set(fks.map((f) => `${f.t}.${f.name}`))
  for (const ix of leftover) if (fkNames.has(`${ix.t}.${ix.i}`)) await db.query(`ALTER TABLE ${ix.t} DROP INDEX ${ix.i}`)

  for (const t of OWNED) {
    await db.query(`ALTER TABLE ${t} ADD COLUMN organization_id INT NULL ${t === 'app_settings' ? 'FIRST' : 'AFTER id'}`)
    if (orgId) await db.query(`UPDATE ${t} SET organization_id = ?`, [orgId])
    if (!NULLABLE_OWNER.has(t)) await db.query(`ALTER TABLE ${t} MODIFY organization_id INT NOT NULL`)
  }
  for (const t of ['cages', 'farm_days']) {
    await db.query(`ALTER TABLE ${t} ADD COLUMN farm_id INT NULL AFTER organization_id`)
    if (farmId) await db.query(`UPDATE ${t} SET farm_id = ?`, [farmId])
    await db.query(`ALTER TABLE ${t} MODIFY farm_id INT NOT NULL`)
  }

  await db.query('ALTER TABLE app_settings DROP PRIMARY KEY, ADD PRIMARY KEY (organization_id, `key`)')
  for (const r of REKEY) await db.query(`ALTER TABLE ${r.table} DROP INDEX ${r.drop}, ADD ${r.add}`)
  // Sign-in by email address, unique across the whole platform. Accounts from before this version
  // have none until one is set (they cannot sign in until then).
  await db.query('ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL AFTER username, ADD UNIQUE KEY ux_users_email (email)')

  for (const t of OWNED) {
    if (t === 'app_settings') continue
    await db.query(`ALTER TABLE ${t} ADD UNIQUE KEY ux_${t}_org_id (organization_id, id)`)
  }
  for (const t of OWNED) await db.query(`ALTER TABLE ${t} ADD CONSTRAINT fk_${t}_org FOREIGN KEY (organization_id) REFERENCES organizations(id)`)
  for (const t of ['cages', 'farm_days']) {
    await db.query(`ALTER TABLE ${t} ADD CONSTRAINT fk_${t}_farm FOREIGN KEY (organization_id, farm_id) REFERENCES farms(organization_id, id)`)
  }
  for (const fk of fks) {
    const onDelete = fk.rule === 'CASCADE' ? ' ON DELETE CASCADE' : ''
    await db.query(`ALTER TABLE ${fk.t} ADD CONSTRAINT ${fk.name} FOREIGN KEY (organization_id, ${fk.c}) REFERENCES ${fk.p}(organization_id, id)${onDelete}`)
  }

  // Backups made just before a database change, and the farm a session is working on.
  const check = (await db
    .prepare(
      `SELECT c.constraint_name AS name FROM information_schema.check_constraints c
       JOIN information_schema.table_constraints t ON t.constraint_schema = c.constraint_schema AND t.constraint_name = c.constraint_name
       WHERE t.table_schema = DATABASE() AND t.table_name = 'backup_runs' AND c.check_clause LIKE '%pre_restore%'`
    )
    .get()) as { name: string } | undefined
  if (check) await db.query(`ALTER TABLE backup_runs DROP CHECK \`${check.name}\``)
  await db.query("ALTER TABLE backup_runs ADD CONSTRAINT ck_backup_kind CHECK (kind IN ('manual','auto','pre_restore','pre_migration'))")
  await db.query('ALTER TABLE sessions ADD COLUMN organization_id INT NULL AFTER user_id, ADD COLUMN farm_id INT NULL AFTER organization_id')
}
