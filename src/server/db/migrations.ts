import type { DB } from './connection'
import { addTenancy } from './tenancy-migration'
import { ensureRoles } from '../services/roles'

export interface Migration {
  version: number
  name: string
  /** SQL statements, or a function for changes that depend on what is already in the database. */
  up: string | ((db: DB) => Promise<void>)
}

/** Every table is InnoDB (transactions, foreign keys) in utf8mb4 so Sinhala text is stored intact. */
const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci'

/**
 * Forward-only migrations. Never edit a released migration: add a new one.
 *
 * Versions 1–3 create the same tables and columns as the desktop (SQLite) edition's
 * migrations 1–3, so a desktop backup maps onto this schema column for column.
 * Dates are DATE columns; timestamps are ISO-8601 UTC strings, as in the desktop edition.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: /* sql */ `
CREATE TABLE app_settings (
  \`key\` VARCHAR(64) NOT NULL PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at VARCHAR(32) NOT NULL
) ${T};

CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('admin','operator')),
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at VARCHAR(32) NOT NULL,
  last_login_at VARCHAR(32),
  UNIQUE KEY ux_users_username (username)
) ${T};

CREATE TABLE cages (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  initial_hens INT NOT NULL CHECK (initial_hens >= 0),
  capacity INT CHECK (capacity IS NULL OR capacity >= 0),
  has_water_meter TINYINT NOT NULL DEFAULT 1 CHECK (has_water_meter IN (0,1)),
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_cages_code (code)
) ${T};

CREATE TABLE farm_days (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  business_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('in_progress','closed')),
  opened_by INT,
  opened_at VARCHAR(32) NOT NULL,
  closed_by INT,
  closed_at VARCHAR(32),
  manager_comment TEXT,
  amendment_open TINYINT NOT NULL DEFAULT 0 CHECK (amendment_open IN (0,1)),
  UNIQUE KEY ux_farm_days_date (business_date),
  CONSTRAINT fk_farm_days_opened_by FOREIGN KEY (opened_by) REFERENCES users(id),
  CONSTRAINT fk_farm_days_closed_by FOREIGN KEY (closed_by) REFERENCES users(id)
) ${T};

CREATE TABLE cage_days (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  cage_id INT NOT NULL,
  carried_hens INT NOT NULL CHECK (carried_hens >= 0),
  opening_adjustment INT NOT NULL DEFAULT 0,
  opening_adjustment_reason TEXT,
  mortality_confirmed TINYINT NOT NULL DEFAULT 0 CHECK (mortality_confirmed IN (0,1)),
  mortality_confirmed_by INT,
  mortality_confirmed_at VARCHAR(32),
  UNIQUE KEY ux_cage_days (day_id, cage_id),
  KEY ix_cage_days_cage (cage_id),
  CONSTRAINT ck_cage_days_opening CHECK (carried_hens + opening_adjustment >= 0),
  CONSTRAINT fk_cage_days_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_cage_days_cage FOREIGN KEY (cage_id) REFERENCES cages(id),
  CONSTRAINT fk_cage_days_confirmed_by FOREIGN KEY (mortality_confirmed_by) REFERENCES users(id)
) ${T};

CREATE TABLE egg_collections (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  cage_id INT NOT NULL,
  session VARCHAR(16) NOT NULL CHECK (session IN ('morning','midday','evening','extra')),
  collected_at VARCHAR(8),
  good INT NOT NULL CHECK (good >= 0),
  damaged INT NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  rejected INT NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  notes TEXT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_eggs (day_id, cage_id, session),
  KEY ix_eggs_cage (cage_id),
  CONSTRAINT fk_eggs_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_eggs_cage FOREIGN KEY (cage_id) REFERENCES cages(id),
  CONSTRAINT fk_eggs_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

CREATE TABLE flock_movements (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  cage_id INT NOT NULL,
  type VARCHAR(16) NOT NULL CHECK (type IN ('death','removal','addition','transfer_in','transfer_out')),
  quantity INT NOT NULL CHECK (quantity > 0),
  reason TEXT,
  notes TEXT,
  transfer_ref VARCHAR(64),
  counterpart_cage_id INT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  KEY ix_flock_day_cage (day_id, cage_id),
  KEY ix_flock_transfer (transfer_ref),
  CONSTRAINT fk_flock_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_flock_cage FOREIGN KEY (cage_id) REFERENCES cages(id),
  CONSTRAINT fk_flock_counterpart FOREIGN KEY (counterpart_cage_id) REFERENCES cages(id),
  CONSTRAINT fk_flock_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

CREATE TABLE inventory_items (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(16) NOT NULL CHECK (category IN ('feed','medicine','supply')),
  name VARCHAR(255) NOT NULL,
  unit VARCHAR(64) NOT NULL,
  low_stock_threshold DOUBLE CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes TEXT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_items (category, name)
) ${T};

CREATE TABLE inventory_batches (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id INT NOT NULL,
  batch_no VARCHAR(128) NOT NULL,
  expiry_date DATE,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_batches (item_id, batch_no),
  CONSTRAINT fk_batches_item FOREIGN KEY (item_id) REFERENCES inventory_items(id)
) ${T};

CREATE TABLE inventory_transactions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id INT NOT NULL,
  batch_id INT,
  txn_date DATE NOT NULL,
  day_id INT,
  cage_id INT,
  type VARCHAR(16) NOT NULL CHECK (type IN ('opening','purchase','receipt','issue','usage','return','adjustment','wastage','expired')),
  quantity DOUBLE NOT NULL CHECK (quantity <> 0),
  unit_cost DOUBLE,
  supplier VARCHAR(255),
  reference VARCHAR(255),
  notes TEXT,
  source_type VARCHAR(32),
  source_id INT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_inv_source (source_type, source_id, type),
  KEY ix_inv_item (item_id, txn_date),
  KEY ix_inv_day (day_id),
  CONSTRAINT fk_inv_item FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  CONSTRAINT fk_inv_batch FOREIGN KEY (batch_id) REFERENCES inventory_batches(id),
  CONSTRAINT fk_inv_day FOREIGN KEY (day_id) REFERENCES farm_days(id),
  CONSTRAINT fk_inv_cage FOREIGN KEY (cage_id) REFERENCES cages(id),
  CONSTRAINT fk_inv_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

CREATE TABLE feed_records (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  cage_id INT NOT NULL,
  item_id INT NOT NULL,
  batch_no VARCHAR(128),
  opening_stock DOUBLE CHECK (opening_stock IS NULL OR opening_stock >= 0),
  issued DOUBLE NOT NULL DEFAULT 0 CHECK (issued >= 0),
  returned DOUBLE NOT NULL DEFAULT 0 CHECK (returned >= 0),
  wasted DOUBLE NOT NULL DEFAULT 0 CHECK (wasted >= 0),
  measured_consumption DOUBLE CHECK (measured_consumption IS NULL OR measured_consumption >= 0),
  closing_stock DOUBLE CHECK (closing_stock IS NULL OR closing_stock >= 0),
  notes TEXT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_feed (day_id, cage_id, item_id),
  CONSTRAINT fk_feed_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_feed_cage FOREIGN KEY (cage_id) REFERENCES cages(id),
  CONSTRAINT fk_feed_item FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  CONSTRAINT fk_feed_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

CREATE TABLE water_records (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  cage_id INT NOT NULL,
  method VARCHAR(16) NOT NULL CHECK (method IN ('meter','manual')),
  opening_reading DOUBLE,
  closing_reading DOUBLE,
  litres DOUBLE CHECK (litres IS NULL OR litres >= 0),
  meter_reset TINYINT NOT NULL DEFAULT 0 CHECK (meter_reset IN (0,1)),
  correction_reason TEXT,
  notes TEXT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_water (day_id, cage_id),
  CONSTRAINT fk_water_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_water_cage FOREIGN KEY (cage_id) REFERENCES cages(id),
  CONSTRAINT fk_water_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

CREATE TABLE medicine_treatments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  cage_id INT,
  item_id INT NOT NULL,
  batch_id INT,
  quantity DOUBLE NOT NULL CHECK (quantity > 0),
  administered_at VARCHAR(8),
  reason TEXT NOT NULL,
  prescribed_by VARCHAR(255),
  notes TEXT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  KEY ix_treat_day (day_id),
  CONSTRAINT fk_treat_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_treat_cage FOREIGN KEY (cage_id) REFERENCES cages(id),
  CONSTRAINT fk_treat_item FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  CONSTRAINT fk_treat_batch FOREIGN KEY (batch_id) REFERENCES inventory_batches(id),
  CONSTRAINT fk_treat_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

CREATE TABLE health_events (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  cage_id INT,
  event_time VARCHAR(8),
  category VARCHAR(64) NOT NULL,
  severity VARCHAR(8) NOT NULL CHECK (severity IN ('low','medium','high')),
  description TEXT NOT NULL,
  action_taken TEXT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_health_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_health_cage FOREIGN KEY (cage_id) REFERENCES cages(id),
  CONSTRAINT fk_health_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

CREATE TABLE day_confirmations (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  cage_id INT NOT NULL DEFAULT 0,
  check_code VARCHAR(128) NOT NULL,
  reason TEXT NOT NULL,
  confirmed_by INT,
  confirmed_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_confirmations (day_id, cage_id, check_code),
  CONSTRAINT fk_confirm_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_confirm_user FOREIGN KEY (confirmed_by) REFERENCES users(id)
) ${T};

CREATE TABLE day_snapshots (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  kind VARCHAR(8) NOT NULL CHECK (kind IN ('open','close')),
  version INT NOT NULL,
  data LONGTEXT NOT NULL,
  note TEXT,
  created_by INT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_snapshots (day_id, kind, version),
  CONSTRAINT fk_snap_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_snap_user FOREIGN KEY (created_by) REFERENCES users(id)
) ${T};

CREATE TABLE day_amendments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day_id INT NOT NULL,
  reason TEXT NOT NULL,
  opened_by INT,
  opened_at VARCHAR(32) NOT NULL,
  closed_by INT,
  closed_at VARCHAR(32),
  CONSTRAINT fk_amend_day FOREIGN KEY (day_id) REFERENCES farm_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_amend_opened_by FOREIGN KEY (opened_by) REFERENCES users(id),
  CONSTRAINT fk_amend_closed_by FOREIGN KEY (closed_by) REFERENCES users(id)
) ${T};

CREATE TABLE audit_log (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at VARCHAR(32) NOT NULL,
  user_id INT,
  username VARCHAR(64),
  action VARCHAR(64) NOT NULL,
  entity VARCHAR(64) NOT NULL,
  entity_id INT,
  day_id INT,
  reason TEXT,
  details MEDIUMTEXT,
  KEY ix_audit_at (at),
  KEY ix_audit_entity (entity, entity_id)
) ${T};

CREATE TABLE report_runs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  format VARCHAR(8) NOT NULL CHECK (format IN ('pdf','xlsx')),
  file_path VARCHAR(1024) NOT NULL,
  generated_by INT,
  generated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_reports_user FOREIGN KEY (generated_by) REFERENCES users(id)
) ${T};

CREATE TABLE backup_runs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('manual','auto','pre_restore')),
  path VARCHAR(1024),
  size_bytes BIGINT,
  status VARCHAR(8) NOT NULL CHECK (status IN ('ok','failed')),
  message TEXT,
  created_at VARCHAR(32) NOT NULL
) ${T};
`
  },
  {
    version: 2,
    name: 'self sign-up approval and recovery codes',
    up: /* sql */ `
ALTER TABLE users
  ADD COLUMN pending TINYINT NOT NULL DEFAULT 0 CHECK (pending IN (0,1)),
  ADD COLUMN recovery_hash VARCHAR(255),
  ADD COLUMN failed_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN locked_until VARCHAR(32);
`
  },
  {
    version: 3,
    name: 'duties, suppliers, goods received, customers and egg sales',
    up: /* sql */ `
-- Duties: which jobs a user may do (JSON array of duty keys) and which cages they look after
-- (JSON array of cage ids; NULL = all cages). Administrators always have every duty.
ALTER TABLE users ADD COLUMN duties TEXT, ADD COLUMN assigned_cages TEXT;

CREATE TABLE suppliers (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(64),
  address VARCHAR(500),
  notes TEXT,
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_suppliers_name (name)
) ${T};

CREATE TABLE customers (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(64),
  address VARCHAR(500),
  notes TEXT,
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_customers_name (name)
) ${T};

-- A delivery received from a supplier (goods received note). Each line posts one
-- 'purchase' stock transaction (source_type 'grn_line'), so store stock rises once.
CREATE TABLE goods_receipts (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  grn_no VARCHAR(32) NOT NULL,
  receipt_date DATE NOT NULL,
  supplier_id INT,
  invoice_no VARCHAR(255),
  vehicle VARCHAR(255),
  notes TEXT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_grn_no (grn_no),
  KEY ix_grn_date (receipt_date),
  CONSTRAINT fk_grn_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_grn_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

CREATE TABLE goods_receipt_lines (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  receipt_id INT NOT NULL,
  item_id INT NOT NULL,
  batch_id INT,
  quantity DOUBLE NOT NULL CHECK (quantity > 0),
  unit_cost DOUBLE CHECK (unit_cost IS NULL OR unit_cost >= 0),
  CONSTRAINT fk_grn_lines_receipt FOREIGN KEY (receipt_id) REFERENCES goods_receipts(id) ON DELETE CASCADE,
  CONSTRAINT fk_grn_lines_item FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  CONSTRAINT fk_grn_lines_batch FOREIGN KEY (batch_id) REFERENCES inventory_batches(id)
) ${T};

-- Eggs sent out of the egg store to a customer. Good and cracked eggs are priced separately.
CREATE TABLE egg_dispatches (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dispatch_no VARCHAR(32) NOT NULL,
  dispatch_date DATE NOT NULL,
  customer_id INT NOT NULL,
  good_qty INT NOT NULL DEFAULT 0 CHECK (good_qty >= 0),
  good_price DOUBLE NOT NULL DEFAULT 0 CHECK (good_price >= 0),
  cracked_qty INT NOT NULL DEFAULT 0 CHECK (cracked_qty >= 0),
  cracked_price DOUBLE NOT NULL DEFAULT 0 CHECK (cracked_price >= 0),
  amount DOUBLE NOT NULL CHECK (amount >= 0),
  amount_paid DOUBLE NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  invoice_no VARCHAR(255),
  vehicle VARCHAR(255),
  driver VARCHAR(255),
  notes TEXT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_dispatch_no (dispatch_no),
  KEY ix_dispatch_date (dispatch_date),
  KEY ix_dispatch_customer (customer_id),
  CONSTRAINT ck_dispatch_qty CHECK (good_qty + cracked_qty > 0),
  CONSTRAINT fk_dispatch_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_dispatch_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

CREATE TABLE customer_payments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dispatch_id INT NOT NULL,
  payment_date DATE NOT NULL,
  amount DOUBLE NOT NULL CHECK (amount > 0),
  method VARCHAR(16) NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','bank','cheque','other')),
  reference VARCHAR(255),
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_payments_dispatch FOREIGN KEY (dispatch_id) REFERENCES egg_dispatches(id) ON DELETE CASCADE,
  CONSTRAINT fk_payments_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};

-- Egg store corrections: breakage in the store, opening stock, counted differences (signed).
CREATE TABLE egg_store_adjustments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  adj_date DATE NOT NULL,
  grade VARCHAR(8) NOT NULL CHECK (grade IN ('good','cracked')),
  quantity INT NOT NULL CHECK (quantity <> 0),
  reason TEXT NOT NULL,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_eggadj_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ${T};
`
  },
  {
    version: 4,
    name: 'web sign-in sessions',
    up: /* sql */ `
-- Browser sessions. Only a SHA-256 hash of the session cookie is stored. user_id is NULL for a
-- visitor who has not signed in yet (e.g. while looking at the demonstration data).
CREATE TABLE sessions (
  id CHAR(64) NOT NULL PRIMARY KEY,
  user_id INT,
  mode VARCHAR(8) NOT NULL DEFAULT 'farm' CHECK (mode IN ('farm','demo')),
  created_at VARCHAR(32) NOT NULL,
  last_seen_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  user_agent VARCHAR(255),
  ip VARCHAR(64),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expires (expires_at)
) ${T};
`
  },
  {
    version: 5,
    name: 'organizations and farms (multi-tenant), email sign-in',
    up: (db) => addTenancy(db)
  },
  {
    version: 6,
    name: 'organization roles and permissions',
    up: async (db) => {
      await db.exec(`
CREATE TABLE roles (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_admin TINYINT NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  created_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32),
  UNIQUE KEY ux_roles_name (organization_id, name),
  UNIQUE KEY ux_roles_org_id (organization_id, id),
  CONSTRAINT fk_roles_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ${T};

CREATE TABLE role_permissions (
  organization_id INT NOT NULL,
  role_id INT NOT NULL,
  permission VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_id, permission),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (organization_id, role_id) REFERENCES roles(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ${T};

-- What a user may do now comes from their role. The old role and duties columns stay for the
-- conversion of older backups (see ensureRoles); role keeps mirroring whether the role is the administrator one.
ALTER TABLE users ADD COLUMN role_id INT NULL AFTER role,
  ADD CONSTRAINT fk_users_role FOREIGN KEY (organization_id, role_id) REFERENCES roles(organization_id, id);
`)
      const orgs = (await db.prepare('SELECT id FROM organizations').all()) as { id: number }[]
      for (const o of orgs) await ensureRoles(db, o.id)
    }
  },
  {
    version: 7,
    name: 'platform: super admins, plans, subscriptions',
    up: async (db) => {
      await db.exec(`
-- Platform (Serenova) accounts. Separate from every organization's users.
CREATE TABLE platform_users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until VARCHAR(32),
  created_at VARCHAR(32) NOT NULL,
  last_login_at VARCHAR(32),
  UNIQUE KEY ux_platform_users_email (email)
) ${T};

CREATE TABLE plans (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(100) NOT NULL,
  max_users INT NOT NULL CHECK (max_users >= 1),
  max_admins INT NOT NULL CHECK (max_admins >= 1),
  max_roles INT NOT NULL CHECK (max_roles >= 0),
  max_farms INT NOT NULL CHECK (max_farms >= 1),
  max_warehouses INT NOT NULL CHECK (max_warehouses >= 0),
  modules TEXT NOT NULL,
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_plans_code (code)
) ${T};

-- One current subscription per organization. Its state is worked out from the dates on
-- every request (trial → active → grace → expired); data is never deleted on expiry.
CREATE TABLE subscriptions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  plan_id INT NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('trial','active','grace','past_due','suspended','cancelled','expired')),
  starts_on DATE NOT NULL,
  ends_on DATE,
  trial_ends_on DATE,
  grace_days INT NOT NULL DEFAULT 14 CHECK (grace_days >= 0),
  overrides TEXT,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_subscriptions_org (organization_id),
  CONSTRAINT fk_subscriptions_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
) ${T};

-- What platform administrators did (organization changes, plan and subscription changes, sign-ins).
CREATE TABLE platform_audit (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at VARCHAR(32) NOT NULL,
  platform_user_id INT,
  email VARCHAR(255),
  action VARCHAR(64) NOT NULL,
  organization_id INT,
  details MEDIUMTEXT,
  KEY ix_platform_audit_at (at)
) ${T};

ALTER TABLE sessions ADD COLUMN platform_user_id INT NULL AFTER farm_id;
`)
      const at = new Date().toISOString()
      const all = JSON.stringify(['purchasing', 'sales', 'advanced_reports', 'multi_farm', 'exports'])
      await db.query(
        'INSERT INTO plans (code, name, max_users, max_admins, max_roles, max_farms, max_warehouses, modules, created_at) VALUES ?',
        [
          [
            ['starter', 'Starter', 5, 1, 3, 1, 1, '[]', at],
            ['growth', 'Growth', 15, 2, 10, 3, 3, all, at],
            ['enterprise', 'Enterprise', 50, 5, 30, 10, 10, all, at]
          ]
        ]
      )
      // Organizations from before subscriptions keep everything they have: Enterprise, no end date.
      const enterprise = ((await db.prepare("SELECT id FROM plans WHERE code = 'enterprise'").get()) as { id: number }).id
      const today = at.slice(0, 10)
      for (const o of (await db.prepare('SELECT id FROM organizations').all()) as { id: number }[]) {
        await db
          .prepare("INSERT INTO subscriptions (organization_id, plan_id, status, starts_on, updated_at) VALUES (?, ?, 'active', ?, ?)")
          .run(o.id, enterprise, today, at)
      }
    }
  }
]

/** Platform tables: only in whole-database backups, never in (or restored from) an organization's backup. */
export const PLATFORM_TABLES = ['platform_users', 'plans', 'subscriptions', 'platform_audit'] as const

/** Tables holding farm data, parents before children (the order used by backup and restore). */
export const DATA_TABLES = [
  'organizations',
  'farms',
  'app_settings',
  'roles',
  'role_permissions',
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
] as const

export async function currentSchemaVersion(db: DB): Promise<number> {
  const exists = await db
    .prepare("SELECT 1 AS x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'")
    .get()
  if (!exists) return 0
  const row = (await db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()) as { v: number | null }
  return row.v ?? 0
}

export function latestSchemaVersion(): number {
  return migrations[migrations.length - 1].version
}

/**
 * Applies pending migrations. Refuses to work with a database created by a newer version.
 * A named lock stops two server processes from migrating the same database at once.
 * (MySQL commits table changes immediately, so each migration is recorded right after it runs.)
 */
export async function migrate(
  db: DB,
  opts: { beforeChanges?: (from: number) => Promise<void>; /** tests only: stop at this version */ to?: number } = {}
): Promise<{ from: number; to: number }> {
  const lock = `pfm_migrate:${db.name}`
  const [got] = (await db.query('SELECT GET_LOCK(?, 60) AS got', [lock])) as { got: number }[]
  if (got?.got !== 1) throw new Error('Could not lock the database for migration')
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at VARCHAR(32) NOT NULL) ${T}`)
    const from = await currentSchemaVersion(db)
    if (from > latestSchemaVersion()) {
      throw new Error(
        `DATABASE_TOO_NEW: database schema v${from} is newer than this application (v${latestSchemaVersion()}). Please install the latest version.`
      )
    }
    // E.g. a safety backup, when the database already holds records and is about to be changed.
    const target = opts.to ?? latestSchemaVersion()
    if (from > 0 && from < target) await opts.beforeChanges?.(from)
    for (const m of migrations) {
      if (m.version <= from || m.version > target) continue
      if (typeof m.up === 'string') await db.exec(m.up)
      else await m.up(db)
      await db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString())
    }
    return { from, to: Math.max(from, target) }
  } finally {
    await db.query('SELECT RELEASE_LOCK(?)', [lock])
  }
}
