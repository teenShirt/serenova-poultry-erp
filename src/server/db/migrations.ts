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
      await db.query('INSERT INTO plans (code, name, max_users, max_admins, max_roles, max_farms, max_warehouses, modules, created_at) VALUES ?', [
        [
          ['starter', 'Starter', 5, 1, 3, 1, 1, '[]', at],
          ['growth', 'Growth', 15, 2, 10, 3, 3, all, at],
          ['enterprise', 'Enterprise', 50, 5, 30, 10, 10, all, at]
        ]
      ])
      // Organizations from before subscriptions keep everything they have: Enterprise, no end date.
      const enterprise = ((await db.prepare("SELECT id FROM plans WHERE code = 'enterprise'").get()) as { id: number }).id
      const today = at.slice(0, 10)
      for (const o of (await db.prepare('SELECT id FROM organizations').all()) as { id: number }[]) {
        await db
          .prepare("INSERT INTO subscriptions (organization_id, plan_id, status, starts_on, updated_at) VALUES (?, ?, 'active', ?, ?)")
          .run(o.id, enterprise, today, at)
      }
    }
  },
  {
    version: 8,
    name: 'poultry operations: exact decimals, houses, flocks, age reminders',
    up: async (db) => {
      // Quantities, meter readings and money as exact decimals instead of floating point.
      // Values are rounded to the stated places (they were entered with at most this precision).
      for (const [table, cols] of Object.entries(DECIMAL_COLUMNS)) {
        const parts = Object.entries(cols).map(([c, type]) => `MODIFY ${c} ${type}`)
        await db.query(`ALTER TABLE ${table} ${parts.join(', ')}`)
      }
      await db.exec(`
-- Poultry houses (sheds) of a farm; cages and pens belong to a house (optional).
CREATE TABLE houses (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  farm_id INT NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(255) NOT NULL,
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_houses_code (farm_id, code),
  UNIQUE KEY ux_houses_org_id (organization_id, id),
  CONSTRAINT fk_houses_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_houses_farm FOREIGN KEY (organization_id, farm_id) REFERENCES farms(organization_id, id)
) ${T};

ALTER TABLE cages ADD COLUMN house_id INT NULL AFTER farm_id,
  ADD CONSTRAINT fk_cages_house FOREIGN KEY (organization_id, house_id) REFERENCES houses(organization_id, id);

-- A flock (batch) of birds of one age, tracked as a group (not bird by bird). Its age is counted
-- from the hatch date; when only the arrival date and age on arrival are known, the hatch date is
-- worked out from them and marked as estimated.
CREATE TABLE flocks (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  farm_id INT NOT NULL,
  code VARCHAR(40) NOT NULL,
  breed VARCHAR(100),
  source VARCHAR(16) NOT NULL CHECK (source IN ('hatched','purchased')),
  hatch_date DATE NOT NULL,
  hatch_date_estimated TINYINT NOT NULL DEFAULT 0 CHECK (hatch_date_estimated IN (0,1)),
  arrival_date DATE NOT NULL,
  initial_count INT NOT NULL CHECK (initial_count >= 0),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  closed_on DATE,
  close_reason TEXT,
  notes TEXT,
  created_by INT,
  created_at VARCHAR(32) NOT NULL,
  CHECK (arrival_date >= hatch_date),
  UNIQUE KEY ux_flocks_code (farm_id, code),
  UNIQUE KEY ux_flocks_org_id (organization_id, id),
  CONSTRAINT fk_flocks_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_flocks_farm FOREIGN KEY (organization_id, farm_id) REFERENCES farms(organization_id, id),
  CONSTRAINT fk_flocks_user FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
) ${T};

-- Which cages a flock occupied, and when (to_date NULL = still there). A cage holds one flock at a time.
CREATE TABLE flock_placements (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  flock_id INT NOT NULL,
  cage_id INT NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE,
  created_at VARCHAR(32) NOT NULL,
  CHECK (to_date IS NULL OR to_date >= from_date),
  KEY ix_placements_cage (cage_id, from_date),
  CONSTRAINT fk_placements_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_placements_flock FOREIGN KEY (organization_id, flock_id) REFERENCES flocks(organization_id, id),
  CONSTRAINT fk_placements_cage FOREIGN KEY (organization_id, cage_id) REFERENCES cages(organization_id, id)
) ${T};

-- Reminders by flock age, written by the organization (e.g. from its veterinarian's programme).
-- They are reminders only: the system never suggests treatments or doses.
CREATE TABLE flock_reminders (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  at_week INT NOT NULL CHECK (at_week >= 0 AND at_week <= 200),
  title VARCHAR(200) NOT NULL,
  instructions TEXT,
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by INT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_reminders_org_id (organization_id, id),
  CONSTRAINT fk_reminders_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_reminders_user FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
) ${T};

CREATE TABLE flock_reminder_done (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  flock_id INT NOT NULL,
  reminder_id INT NOT NULL,
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('done','skipped')),
  note TEXT,
  done_by INT,
  done_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_reminder_done (flock_id, reminder_id),
  CONSTRAINT fk_reminder_done_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_reminder_done_flock FOREIGN KEY (organization_id, flock_id) REFERENCES flocks(organization_id, id),
  CONSTRAINT fk_reminder_done_reminder FOREIGN KEY (organization_id, reminder_id) REFERENCES flock_reminders(organization_id, id),
  CONSTRAINT fk_reminder_done_user FOREIGN KEY (organization_id, done_by) REFERENCES users(organization_id, id)
) ${T};
`)
      // Roles that manage cages also manage houses and flocks; roles that manage settings, farms.
      await db.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission)
         SELECT organization_id, role_id, 'flocks.manage' FROM role_permissions WHERE permission = 'cages.manage'`
      )
      await db.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission)
         SELECT organization_id, role_id, 'farms.manage' FROM role_permissions WHERE permission = 'settings.manage'`
      )
    }
  },
  {
    version: 9,
    name: 'stores, purchase orders, GRN approval, stock counts, tasks',
    up: async (db) => {
      await db.exec(`
-- Stores and warehouses. Each belongs to a farm (location); every farm has one main store.
CREATE TABLE warehouses (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  farm_id INT NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(255) NOT NULL,
  is_main TINYINT NOT NULL DEFAULT 0 CHECK (is_main IN (0,1)),
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  notes TEXT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_warehouses_code (organization_id, code),
  UNIQUE KEY ux_warehouses_org_id (organization_id, id),
  CONSTRAINT fk_warehouses_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_warehouses_farm FOREIGN KEY (organization_id, farm_id) REFERENCES farms(organization_id, id)
) ${T};
`)
      // Every existing farm gets its main store; the existing stock history moves into it.
      await ensureMainStores(db)
      await db.exec(`
ALTER TABLE inventory_transactions
  ADD COLUMN warehouse_id INT NULL AFTER item_id,
  ADD COLUMN transfer_ref VARCHAR(40) NULL,
  ADD COLUMN counterpart_warehouse_id INT NULL;

-- Records of a farm day go to that farm's main store; the rest to the main store of the organization's first farm.
UPDATE inventory_transactions t JOIN farm_days d ON d.id = t.day_id
  JOIN warehouses w ON w.farm_id = d.farm_id AND w.is_main = 1
  SET t.warehouse_id = w.id;
UPDATE inventory_transactions t
  SET t.warehouse_id = (SELECT w.id FROM warehouses w JOIN farms f ON f.id = w.farm_id
    WHERE w.organization_id = t.organization_id AND w.is_main = 1 ORDER BY f.id LIMIT 1)
  WHERE t.warehouse_id IS NULL;

ALTER TABLE inventory_transactions MODIFY warehouse_id INT NOT NULL,
  ADD KEY ix_inv_store (warehouse_id, item_id),
  ADD CONSTRAINT fk_inv_warehouse FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id),
  ADD CONSTRAINT fk_inv_counterpart FOREIGN KEY (organization_id, counterpart_warehouse_id) REFERENCES warehouses(organization_id, id);
`)
      // The movement types now include transfers between stores, stock-count corrections and reversals.
      const checks = (await db
        .prepare(
          `SELECT c.constraint_name AS n FROM information_schema.check_constraints c
           JOIN information_schema.table_constraints t ON t.constraint_schema = c.constraint_schema AND t.constraint_name = c.constraint_name
           WHERE c.constraint_schema = DATABASE() AND t.table_name = 'inventory_transactions' AND c.check_clause LIKE '%opening%'`
        )
        .all()) as { n: string }[]
      for (const c of checks) await db.query(`ALTER TABLE inventory_transactions DROP CHECK \`${c.n}\``)
      await db.query(
        `ALTER TABLE inventory_transactions ADD CONSTRAINT ck_inv_type CHECK (type IN
          ('opening','purchase','receipt','issue','usage','return','adjustment','wastage','expired','transfer_in','transfer_out','count','reversal'))`
      )

      await db.exec(`
-- Purchase orders: what was ordered from a supplier, for which store.
CREATE TABLE purchase_orders (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  po_no VARCHAR(32) NOT NULL,
  order_date DATE NOT NULL,
  expected_date DATE,
  supplier_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  notes TEXT,
  created_by INT,
  created_at VARCHAR(32) NOT NULL,
  closed_by INT,
  closed_at VARCHAR(32),
  close_reason TEXT,
  UNIQUE KEY ux_po_no (organization_id, po_no),
  UNIQUE KEY ux_purchase_orders_org_id (organization_id, id),
  CONSTRAINT fk_po_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_po_supplier FOREIGN KEY (organization_id, supplier_id) REFERENCES suppliers(organization_id, id),
  CONSTRAINT fk_po_warehouse FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id),
  CONSTRAINT fk_po_created_by FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id),
  CONSTRAINT fk_po_closed_by FOREIGN KEY (organization_id, closed_by) REFERENCES users(organization_id, id)
) ${T};

CREATE TABLE purchase_order_lines (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  po_id INT NOT NULL,
  item_id INT NOT NULL,
  quantity DECIMAL(16,3) NOT NULL CHECK (quantity > 0),
  unit_cost DECIMAL(16,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  UNIQUE KEY ux_purchase_order_lines_org_id (organization_id, id),
  CONSTRAINT fk_pol_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_pol_po FOREIGN KEY (organization_id, po_id) REFERENCES purchase_orders(organization_id, id),
  CONSTRAINT fk_pol_item FOREIGN KEY (organization_id, item_id) REFERENCES inventory_items(organization_id, id)
) ${T};

-- Goods received notes: store, purchase order, approval and cancellation (never deleted).
ALTER TABLE goods_receipts
  ADD COLUMN warehouse_id INT NULL AFTER supplier_id,
  ADD COLUMN po_id INT NULL AFTER warehouse_id,
  ADD COLUMN delivery_note VARCHAR(255) NULL AFTER invoice_no,
  ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'posted' CHECK (status IN ('submitted','posted','rejected','cancelled')),
  ADD COLUMN client_ref VARCHAR(64) NULL,
  ADD COLUMN approved_by INT NULL,
  ADD COLUMN approved_at VARCHAR(32) NULL,
  ADD COLUMN cancelled_by INT NULL,
  ADD COLUMN cancelled_at VARCHAR(32) NULL,
  ADD COLUMN cancel_reason TEXT NULL;

UPDATE goods_receipts g
  SET g.warehouse_id = (SELECT w.id FROM warehouses w JOIN farms f ON f.id = w.farm_id
    WHERE w.organization_id = g.organization_id AND w.is_main = 1 ORDER BY f.id LIMIT 1);

ALTER TABLE goods_receipts MODIFY warehouse_id INT NOT NULL,
  ADD UNIQUE KEY ux_grn_client_ref (organization_id, client_ref),
  ADD CONSTRAINT fk_grn_warehouse FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id),
  ADD CONSTRAINT fk_grn_po FOREIGN KEY (organization_id, po_id) REFERENCES purchase_orders(organization_id, id),
  ADD CONSTRAINT fk_grn_approved_by FOREIGN KEY (organization_id, approved_by) REFERENCES users(organization_id, id),
  ADD CONSTRAINT fk_grn_cancelled_by FOREIGN KEY (organization_id, cancelled_by) REFERENCES users(organization_id, id);

-- quantity = delivered; rejected and damaged are not taken into stock; ordered comes from the purchase order.
ALTER TABLE goods_receipt_lines
  ADD COLUMN po_line_id INT NULL AFTER receipt_id,
  ADD COLUMN ordered_qty DECIMAL(16,3) NULL,
  ADD COLUMN rejected_qty DECIMAL(16,3) NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  ADD COLUMN damaged_qty DECIMAL(16,3) NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  ADD COLUMN reject_reason TEXT NULL,
  ADD CONSTRAINT fk_grn_lines_po_line FOREIGN KEY (organization_id, po_line_id) REFERENCES purchase_order_lines(organization_id, id);

-- Stock counts: counted quantities per item (and batch) in one store; differences are posted as 'count' movements.
CREATE TABLE stock_counts (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  count_date DATE NOT NULL,
  notes TEXT,
  counted_by INT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_stock_counts_org_id (organization_id, id),
  CONSTRAINT fk_counts_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_counts_warehouse FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouses(organization_id, id),
  CONSTRAINT fk_counts_user FOREIGN KEY (organization_id, counted_by) REFERENCES users(organization_id, id)
) ${T};

CREATE TABLE stock_count_lines (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  count_id INT NOT NULL,
  item_id INT NOT NULL,
  batch_id INT,
  system_qty DECIMAL(16,3) NOT NULL,
  counted_qty DECIMAL(16,3) NOT NULL CHECK (counted_qty >= 0),
  UNIQUE KEY ux_stock_count_lines_org_id (organization_id, id),
  CONSTRAINT fk_count_lines_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_count_lines_count FOREIGN KEY (organization_id, count_id) REFERENCES stock_counts(organization_id, id),
  CONSTRAINT fk_count_lines_item FOREIGN KEY (organization_id, item_id) REFERENCES inventory_items(organization_id, id),
  CONSTRAINT fk_count_lines_batch FOREIGN KEY (organization_id, batch_id) REFERENCES inventory_batches(organization_id, id)
) ${T};

-- Recurring tasks: a definition from which one task per occurrence is made.
CREATE TABLE task_series (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  farm_id INT,
  house_id INT,
  title VARCHAR(200) NOT NULL,
  category VARCHAR(32) NOT NULL,
  priority VARCHAR(8) NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
  instructions TEXT,
  completion_criteria TEXT,
  assignee_user_id INT,
  assignee_role_id INT,
  recurrence VARCHAR(8) NOT NULL CHECK (recurrence IN ('daily','weekly','monthly')),
  start_date DATE NOT NULL,
  until_date DATE,
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by INT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_task_series_org_id (organization_id, id),
  CONSTRAINT fk_series_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_series_farm FOREIGN KEY (organization_id, farm_id) REFERENCES farms(organization_id, id),
  CONSTRAINT fk_series_house FOREIGN KEY (organization_id, house_id) REFERENCES houses(organization_id, id),
  CONSTRAINT fk_series_user FOREIGN KEY (organization_id, assignee_user_id) REFERENCES users(organization_id, id),
  CONSTRAINT fk_series_role FOREIGN KEY (organization_id, assignee_role_id) REFERENCES roles(organization_id, id),
  CONSTRAINT fk_series_created_by FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
) ${T};

CREATE TABLE tasks (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  series_id INT,
  farm_id INT,
  house_id INT,
  title VARCHAR(200) NOT NULL,
  category VARCHAR(32) NOT NULL,
  priority VARCHAR(8) NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
  instructions TEXT,
  completion_criteria TEXT,
  assignee_user_id INT,
  assignee_role_id INT,
  start_date DATE NOT NULL,
  due_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','verified','cancelled')),
  created_by INT,
  created_at VARCHAR(32) NOT NULL,
  completed_by INT,
  completed_at VARCHAR(32),
  verified_by INT,
  verified_at VARCHAR(32),
  CHECK (due_date >= start_date),
  UNIQUE KEY ux_tasks_occurrence (series_id, due_date),
  UNIQUE KEY ux_tasks_org_id (organization_id, id),
  KEY ix_tasks_due (organization_id, due_date),
  CONSTRAINT fk_tasks_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_tasks_series FOREIGN KEY (organization_id, series_id) REFERENCES task_series(organization_id, id),
  CONSTRAINT fk_tasks_farm FOREIGN KEY (organization_id, farm_id) REFERENCES farms(organization_id, id),
  CONSTRAINT fk_tasks_house FOREIGN KEY (organization_id, house_id) REFERENCES houses(organization_id, id),
  CONSTRAINT fk_tasks_user FOREIGN KEY (organization_id, assignee_user_id) REFERENCES users(organization_id, id),
  CONSTRAINT fk_tasks_role FOREIGN KEY (organization_id, assignee_role_id) REFERENCES roles(organization_id, id),
  CONSTRAINT fk_tasks_created_by FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id),
  CONSTRAINT fk_tasks_completed_by FOREIGN KEY (organization_id, completed_by) REFERENCES users(organization_id, id),
  CONSTRAINT fk_tasks_verified_by FOREIGN KEY (organization_id, verified_by) REFERENCES users(organization_id, id)
) ${T};

-- Who created, assigned, started, completed, verified or cancelled each task, and notes.
CREATE TABLE task_events (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  task_id INT NOT NULL,
  at VARCHAR(32) NOT NULL,
  user_id INT,
  action VARCHAR(24) NOT NULL,
  note TEXT,
  KEY ix_task_events_task (task_id),
  CONSTRAINT fk_task_events_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_task_events_task FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id),
  CONSTRAINT fk_task_events_user FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id)
) ${T};
`)
      // Item catalogue: SKU, reorder level, default supplier, and more categories.
      const itemChecks = (await db
        .prepare(
          `SELECT c.constraint_name AS n FROM information_schema.check_constraints c
           JOIN information_schema.table_constraints t ON t.constraint_schema = c.constraint_schema AND t.constraint_name = c.constraint_name
           WHERE c.constraint_schema = DATABASE() AND t.table_name = 'inventory_items' AND c.check_clause LIKE '%medicine%'`
        )
        .all()) as { n: string }[]
      for (const c of itemChecks) await db.query(`ALTER TABLE inventory_items DROP CHECK \`${c.n}\``)
      await db.exec(`
ALTER TABLE inventory_items
  ADD COLUMN sku VARCHAR(64) NULL AFTER category,
  ADD COLUMN reorder_level DECIMAL(16,3) NULL CHECK (reorder_level IS NULL OR reorder_level >= 0) AFTER low_stock_threshold,
  ADD COLUMN default_supplier_id INT NULL AFTER reorder_level,
  ADD UNIQUE KEY ux_items_sku (organization_id, sku),
  ADD CONSTRAINT ck_items_category CHECK (category IN ('feed','medicine','cleaning','packaging','spare_part','equipment','supply')),
  ADD CONSTRAINT fk_items_supplier FOREIGN KEY (organization_id, default_supplier_id) REFERENCES suppliers(organization_id, id);
`)
      // Who could record purchases may also raise purchase orders and approve receipts; who manages users, tasks.
      for (const [perm, from] of [
        ['purchases.approve', 'purchases.cancel'],
        ['stores.manage', 'inventory.manage_items'],
        ['inventory.transfer', 'inventory.adjust'],
        ['tasks.manage', 'users.manage']
      ]) {
        await db.query(
          `INSERT INTO role_permissions (organization_id, role_id, permission)
           SELECT organization_id, role_id, ? FROM role_permissions WHERE permission = ?`,
          [perm, from]
        )
      }
    }
  },
  {
    version: 10,
    name: 'release history and restore tests',
    up: `
-- Each release the server started with: version, commit, environment and database upgrade.
CREATE TABLE deployments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  version VARCHAR(32) NOT NULL,
  release_sha VARCHAR(40),
  environment VARCHAR(16) NOT NULL,
  host VARCHAR(255),
  schema_from INT NOT NULL,
  schema_to INT NOT NULL,
  status VARCHAR(8) NOT NULL CHECK (status IN ('ok','failed')),
  error TEXT,
  started_at VARCHAR(32) NOT NULL,
  last_started_at VARCHAR(32) NOT NULL,
  restarts INT NOT NULL DEFAULT 0
) ${T};

-- Backups restored into a separate database to prove they can be restored.
CREATE TABLE restore_tests (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at VARCHAR(32) NOT NULL,
  backup_file VARCHAR(500) NOT NULL,
  backup_created_at VARCHAR(32),
  target_database VARCHAR(64) NOT NULL,
  status VARCHAR(8) NOT NULL CHECK (status IN ('ok','failed')),
  duration_ms INT NOT NULL,
  tables_checked INT NOT NULL DEFAULT 0,
  rows_checked INT NOT NULL DEFAULT 0,
  problems TEXT
) ${T};
`
  },
  {
    version: 11,
    name: 'feeding schedules and egg withdrawal periods',
    up: async (db) => {
      await db.exec(`
-- Egg withdrawal period of a medicine, from its label or the veterinarian (never filled in by the system).
ALTER TABLE inventory_items ADD COLUMN egg_withdrawal_days INT NULL CHECK (egg_withdrawal_days IS NULL OR (egg_withdrawal_days >= 0 AND egg_withdrawal_days <= 365));

-- Planned feeding times of a farm (all its cages, or one cage), with the planned quantity.
CREATE TABLE feeding_schedules (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  farm_id INT NOT NULL,
  cage_id INT,
  at_time VARCHAR(5) NOT NULL,
  item_id INT,
  planned_kg DECIMAL(16,3) CHECK (planned_kg IS NULL OR planned_kg >= 0),
  notes TEXT,
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_feeding_schedules_org_id (organization_id, id),
  CONSTRAINT fk_feedsch_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_feedsch_farm FOREIGN KEY (organization_id, farm_id) REFERENCES farms(organization_id, id),
  CONSTRAINT fk_feedsch_cage FOREIGN KEY (organization_id, cage_id) REFERENCES cages(organization_id, id),
  CONSTRAINT fk_feedsch_item FOREIGN KEY (organization_id, item_id) REFERENCES inventory_items(organization_id, id)
) ${T};

-- When each planned feeding was actually done (one entry per feeding and date).
CREATE TABLE feeding_log (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  schedule_id INT NOT NULL,
  feed_date DATE NOT NULL,
  fed_at VARCHAR(5) NOT NULL,
  note TEXT,
  recorded_by INT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_feeding_log (schedule_id, feed_date),
  CONSTRAINT fk_feedlog_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_feedlog_schedule FOREIGN KEY (organization_id, schedule_id) REFERENCES feeding_schedules(organization_id, id),
  CONSTRAINT fk_feedlog_user FOREIGN KEY (organization_id, recorded_by) REFERENCES users(organization_id, id)
) ${T};
`)
      await db.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission)
         SELECT organization_id, role_id, 'feeding.manage' FROM role_permissions WHERE permission = 'cages.manage'`
      )
    }
  },
  {
    // The new permissions ('records.edit', 'medicine.schedule') are given to no existing role:
    // only administrators hold them until an administrator gives them to a role.
    version: 12,
    name: 'medicine schedules',
    up: `
-- Planned medicine routines: the next date each is due, for one cage or the whole farm (cage_id NULL).
CREATE TABLE medicine_schedules (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  farm_id INT NOT NULL,
  cage_id INT,
  item_id INT NOT NULL,
  dose DECIMAL(16,3) CHECK (dose IS NULL OR dose >= 0),
  due_date DATE NOT NULL,
  repeat_days INT CHECK (repeat_days IS NULL OR (repeat_days >= 1 AND repeat_days <= 365)),
  notes TEXT,
  active TINYINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_done_on DATE,
  created_by INT,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ux_medicine_schedules_org_id (organization_id, id),
  KEY ix_medicine_schedules_due (organization_id, farm_id, active, due_date),
  CONSTRAINT fk_medsch_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_medsch_farm FOREIGN KEY (organization_id, farm_id) REFERENCES farms(organization_id, id),
  CONSTRAINT fk_medsch_cage FOREIGN KEY (organization_id, cage_id) REFERENCES cages(organization_id, id),
  CONSTRAINT fk_medsch_item FOREIGN KEY (organization_id, item_id) REFERENCES inventory_items(organization_id, id),
  CONSTRAINT fk_medsch_user FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id)
) ${T};
`
  }
]

/** Gives every farm (of one organization, or all) without a main store its main store. */
export async function ensureMainStores(db: DB, orgId?: number) {
  const farms = (await db
    .prepare(
      `SELECT f.id, f.organization_id AS org, f.code, f.name,
         (SELECT COUNT(*) FROM farms f2 WHERE f2.organization_id = f.organization_id AND f2.id < f.id) AS earlier
       FROM farms f WHERE ${orgId === undefined ? '1 = 1' : 'f.organization_id = ?'}
         AND NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.farm_id = f.id AND w.is_main = 1)`
    )
    .all(...(orgId === undefined ? [] : [orgId]))) as { id: number; org: number; code: string; name: string; earlier: number }[]
  for (const f of farms) {
    let code = f.earlier === 0 ? 'MAIN' : `MAIN-${f.code}`.slice(0, 40)
    for (let i = 2; await db.prepare('SELECT 1 AS x FROM warehouses WHERE organization_id = ? AND code = ?').get(f.org, code); i++) code = `MAIN-${f.id}-${i}`
    await db
      .prepare('INSERT INTO warehouses (organization_id, farm_id, code, name, is_main, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(f.org, f.id, code, f.earlier === 0 ? 'Main Store' : `${f.name} — Main Store`, new Date().toISOString())
  }
}

/** Exact decimal types (migration 8): quantities and readings to 3 places, prices to 4, amounts of money to 2. */
const QTY = 'DECIMAL(16,3)'
const DECIMAL_COLUMNS: Record<string, Record<string, string>> = {
  inventory_items: { low_stock_threshold: QTY },
  inventory_transactions: { quantity: `${QTY} NOT NULL`, unit_cost: 'DECIMAL(16,4)' },
  feed_records: {
    opening_stock: QTY,
    issued: `${QTY} NOT NULL DEFAULT 0`,
    returned: `${QTY} NOT NULL DEFAULT 0`,
    wasted: `${QTY} NOT NULL DEFAULT 0`,
    measured_consumption: QTY,
    closing_stock: QTY
  },
  water_records: { opening_reading: QTY, closing_reading: QTY, litres: QTY },
  medicine_treatments: { quantity: `${QTY} NOT NULL` },
  goods_receipt_lines: { quantity: `${QTY} NOT NULL`, unit_cost: 'DECIMAL(16,4)' },
  egg_dispatches: {
    good_price: 'DECIMAL(14,4) NOT NULL DEFAULT 0',
    cracked_price: 'DECIMAL(14,4) NOT NULL DEFAULT 0',
    amount: 'DECIMAL(16,2) NOT NULL',
    amount_paid: 'DECIMAL(16,2) NOT NULL DEFAULT 0'
  },
  customer_payments: { amount: 'DECIMAL(16,2) NOT NULL' }
}

/** Platform tables: only in whole-database backups, never in (or restored from) an organization's backup. */
export const PLATFORM_TABLES = ['platform_users', 'plans', 'subscriptions', 'platform_audit', 'deployments', 'restore_tests'] as const

/** Tables holding farm data, parents before children (the order used by backup and restore). */
export const DATA_TABLES = [
  'organizations',
  'farms',
  'warehouses',
  'app_settings',
  'roles',
  'role_permissions',
  'users',
  'houses',
  'flock_reminders',
  'cages',
  'flocks',
  'flock_placements',
  'flock_reminder_done',
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
  'purchase_orders',
  'purchase_order_lines',
  'goods_receipts',
  'goods_receipt_lines',
  'egg_dispatches',
  'customer_payments',
  'egg_store_adjustments',
  'stock_counts',
  'stock_count_lines',
  'task_series',
  'tasks',
  'task_events',
  'feeding_schedules',
  'feeding_log',
  'medicine_schedules'
] as const

export async function currentSchemaVersion(db: DB): Promise<number> {
  const exists = await db.prepare("SELECT 1 AS x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'").get()
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
      await db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString())
    }
    return { from, to: Math.max(from, target) }
  } finally {
    await db.query('SELECT RELEASE_LOCK(?)', [lock])
  }
}
