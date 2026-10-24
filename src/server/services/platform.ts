import type { Language } from '@shared/types'
import { MODULES, SUBSCRIPTION_STATUSES, type OrgSummary, type Plan, type PlatformMetrics, type PlatformUser, type SubscriptionChange, type SubscriptionStatus } from '@shared/platform'
import { isIsoDate, isValidTimezone } from '@shared/dates'
import type { AnonCtx } from '../context'
import type { DB } from '../db/connection'
import { AppError, assert } from '../errors'
import { hashPassword, LOCK_MINUTES, MAX_ATTEMPTS, normalizeEmail, validatePassword, verifyPassword } from './auth'
import { createOrganization } from './setup'
import { getEntitlements, toPlan } from './subscriptions'

/**
 * The Serenova platform console. Platform administrators manage organizations, plans and
 * subscriptions. They are separate accounts (platform_users), never members of an
 * organization, and the console never shows an organization's farm records.
 */

interface PlatformRow {
  id: number
  email: string
  display_name: string
  password_hash: string
  active: number
  failed_attempts: number
  locked_until: string | null
}

const toPlatformUser = (r: Pick<PlatformRow, 'id' | 'email' | 'display_name'>): PlatformUser => ({ id: r.id, email: r.email, displayName: r.display_name })

/** Records what a platform administrator did. */
export async function platformAudit(db: DB, actor: PlatformUser | null, action: string, organizationId: number | null, details: unknown, now = new Date()) {
  await db
    .prepare('INSERT INTO platform_audit (at, platform_user_id, email, action, organization_id, details) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now.toISOString(), actor?.id ?? null, actor?.email ?? null, action, organizationId, details === undefined ? null : JSON.stringify(details))
}

/** Creates a platform administrator (from the server's command line only). */
export async function createPlatformUser(db: DB, u: { email: string; displayName: string; password: string }) {
  validatePassword(u.password)
  assert(u.password.length >= 10, 'password_too_short')
  const email = normalizeEmail(u.email)
  assert(!(await db.prepare('SELECT 1 AS x FROM platform_users WHERE email = ?').get(email)), 'email_taken')
  const id = (
    await db
      .prepare('INSERT INTO platform_users (email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(email, u.displayName.trim() || email, hashPassword(u.password), new Date().toISOString())
  ).lastInsertRowid
  await platformAudit(db, null, 'create_platform_user', null, { email })
  return id
}

/** Signs in a platform administrator; five wrong passwords lock the account for 15 minutes. */
export async function platformLogin(anon: AnonCtx, email: string, password: string): Promise<PlatformUser> {
  const row = (await anon.db.prepare('SELECT * FROM platform_users WHERE email = ?').get(email.trim().toLowerCase())) as PlatformRow | undefined
  const now = anon.now()
  if (row?.locked_until && row.locked_until > now.toISOString()) {
    throw new AppError('account_locked', { minutes: Math.ceil((Date.parse(row.locked_until) - now.getTime()) / 60000) })
  }
  if (!row || !verifyPassword(password, row.password_hash)) {
    if (row) {
      const attempts = row.failed_attempts + 1
      if (attempts >= MAX_ATTEMPTS) {
        await anon.db.prepare('UPDATE platform_users SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString(), row.id)
      } else {
        await anon.db.prepare('UPDATE platform_users SET failed_attempts = ? WHERE id = ?').run(attempts, row.id)
      }
    }
    await platformAudit(anon.db, null, 'platform_login_failed', null, { email }, now)
    throw new AppError('invalid_login')
  }
  if (!row.active) throw new AppError('user_inactive')
  await anon.db.prepare('UPDATE platform_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now.toISOString(), row.id)
  const user = toPlatformUser(row)
  await platformAudit(anon.db, user, 'platform_login', null, undefined, now)
  return user
}

/** The signed-in platform administrator, read afresh on every request (a disabled account stops working at once). */
export async function loadPlatformUser(db: DB, id: number | null): Promise<PlatformUser | null> {
  if (!id) return null
  const row = (await db.prepare('SELECT id, email, display_name, active FROM platform_users WHERE id = ?').get(id)) as (PlatformRow & { active: number }) | undefined
  return row && row.active ? toPlatformUser(row) : null
}

export async function listOrganizations(db: DB, today: string): Promise<OrgSummary[]> {
  const orgs = (await db
    .prepare(
      `SELECT o.id, o.code, o.name, o.status, o.created_at AS createdAt,
         (SELECT MAX(a.at) FROM audit_log a WHERE a.organization_id = o.id) AS lastActivityAt
       FROM organizations o ORDER BY o.name`
    )
    .all()) as Omit<OrgSummary, 'entitlements'>[]
  const out: OrgSummary[] = []
  for (const o of orgs) out.push({ ...o, entitlements: await getEntitlements(db, o.id, today) })
  return out
}

export interface NewOrganizationInput {
  name: string
  location: string
  timezone: string
  language: Language
  adminEmail: string
  adminName: string
  adminPassword: string
  planId: number
  trialDays: number
}

/** Creates a customer organization with its first farm and administrator, on a plan (optionally as a trial). */
export async function platformCreateOrganization(anon: AnonCtx, actor: PlatformUser, i: NewOrganizationInput) {
  assert(isValidTimezone(i.timezone), 'invalid_timezone')
  assert(Number.isInteger(i.trialDays) && i.trialDays >= 0 && i.trialDays <= 365, 'invalid_input', { field: 'trialDays' })
  const plan = (await anon.db.prepare('SELECT id, active FROM plans WHERE id = ?').get(i.planId)) as { id: number; active: number } | undefined
  assert(plan && plan.active, 'plan_not_found')
  const created = await createOrganization(
    anon,
    {
      farmName: i.name,
      farmLocation: i.location,
      timezone: i.timezone,
      language: i.language,
      startDate: anon.now().toISOString().slice(0, 10),
      cages: [],
      admin: { email: i.adminEmail, displayName: i.adminName, password: i.adminPassword },
      inventory: []
    },
    { planId: i.planId, trialDays: i.trialDays, allowNoCages: true }
  )
  await platformAudit(anon.db, actor, 'create_organization', created.organizationId, { name: i.name, code: created.organizationCode, plan: i.planId, trialDays: i.trialDays, admin: i.adminEmail })
  return { id: created.organizationId, code: created.organizationCode, recoveryCode: created.recoveryCode }
}

/**
 * Suspends (nobody can sign in), archives (kept, no sign-in) or reactivates an organization.
 * Its records are never deleted. Suspending or archiving signs everyone out at once.
 */
export async function setOrganizationStatus(db: DB, actor: PlatformUser, id: number, status: 'active' | 'suspended' | 'archived', reason: string, now = new Date()) {
  assert(reason.trim().length >= 3, 'reason_required')
  const org = (await db.prepare('SELECT status FROM organizations WHERE id = ?').get(id)) as { status: string } | undefined
  assert(org, 'not_found')
  await db.transaction(async () => {
    await db.prepare('UPDATE organizations SET status = ?, archived_at = ? WHERE id = ?').run(status, status === 'archived' ? now.toISOString() : null, id)
    if (status !== 'active') await db.prepare('DELETE FROM sessions WHERE organization_id = ?').run(id)
    await platformAudit(db, actor, 'set_organization_status', id, { from: org.status, to: status, reason: reason.trim() }, now)
  })()
}

export async function listPlans(db: DB): Promise<Plan[]> {
  return ((await db.prepare('SELECT * FROM plans ORDER BY max_users, id').all()) as Parameters<typeof toPlan>[0][]).map(toPlan)
}

export async function savePlan(db: DB, actor: PlatformUser, p: Omit<Plan, 'id'> & { id: number | null }): Promise<number> {
  const code = p.code.trim().toLowerCase()
  assert(/^[a-z0-9-]{2,40}$/.test(code), 'invalid_input', { field: 'code' })
  assert(p.name.trim().length >= 2, 'required_field', { field: 'name' })
  for (const [k, v] of Object.entries({ maxUsers: p.maxUsers, maxAdmins: p.maxAdmins, maxRoles: p.maxRoles, maxFarms: p.maxFarms, maxWarehouses: p.maxWarehouses })) {
    assert(Number.isInteger(v) && v >= (k === 'maxRoles' || k === 'maxWarehouses' ? 0 : 1) && v <= 100000, 'invalid_input', { field: k })
  }
  assert(p.maxAdmins <= p.maxUsers, 'invalid_input', { field: 'maxAdmins' })
  const modules = [...new Set(p.modules)].filter((m) => (MODULES as readonly string[]).includes(m))
  const dup = await db.prepare('SELECT 1 AS x FROM plans WHERE code = ? AND NOT (id <=> ?)').get(code, p.id)
  assert(!dup, 'name_taken')
  const vals = [code, p.name.trim(), p.maxUsers, p.maxAdmins, p.maxRoles, p.maxFarms, p.maxWarehouses, JSON.stringify(modules), p.active ? 1 : 0]
  let id = p.id
  if (id) {
    const r = await db
      .prepare('UPDATE plans SET code = ?, name = ?, max_users = ?, max_admins = ?, max_roles = ?, max_farms = ?, max_warehouses = ?, modules = ?, active = ? WHERE id = ?')
      .run(...vals, id)
    assert(r.changes === 1, 'not_found')
  } else {
    id = (
      await db
        .prepare('INSERT INTO plans (code, name, max_users, max_admins, max_roles, max_farms, max_warehouses, modules, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...vals, new Date().toISOString())
    ).lastInsertRowid
  }
  await platformAudit(db, actor, p.id ? 'update_plan' : 'create_plan', null, { ...p, code, modules })
  return id
}

/**
 * Changes an organization's subscription: plan, status, dates, grace period and per-customer
 * limits. Lowering limits below what is in use never removes anything: existing accounts and
 * roles stay; only adding more is refused until usage is within the limits.
 */
export async function setSubscription(db: DB, actor: PlatformUser, c: SubscriptionChange) {
  assert((SUBSCRIPTION_STATUSES as readonly string[]).includes(c.status), 'invalid_input', { field: 'status' })
  assert(isIsoDate(c.startsOn), 'invalid_date')
  for (const d of [c.endsOn, c.trialEndsOn]) assert(d === null || (isIsoDate(d) && d >= c.startsOn), 'invalid_date')
  assert(Number.isInteger(c.graceDays) && c.graceDays >= 0 && c.graceDays <= 365, 'invalid_input', { field: 'graceDays' })
  assert(c.note.trim().length >= 3, 'reason_required')
  const plan = await db.prepare('SELECT 1 AS x FROM plans WHERE id = ?').get(c.planId)
  assert(plan, 'plan_not_found')
  const before = await db.prepare('SELECT * FROM subscriptions WHERE organization_id = ?').get(c.organizationId)
  assert(before, 'not_found')
  const overrides = c.overrides ? Object.fromEntries(Object.entries(c.overrides).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0)) : null
  await db.transaction(async () => {
    await db
      .prepare('UPDATE subscriptions SET plan_id = ?, status = ?, starts_on = ?, ends_on = ?, trial_ends_on = ?, grace_days = ?, overrides = ?, updated_at = ? WHERE organization_id = ?')
      .run(c.planId, c.status as SubscriptionStatus, c.startsOn, c.endsOn, c.trialEndsOn, c.graceDays, overrides && Object.keys(overrides).length ? JSON.stringify(overrides) : null, new Date().toISOString(), c.organizationId)
    await platformAudit(db, actor, 'set_subscription', c.organizationId, { before, after: { ...c, overrides } })
  })()
}

export async function platformMetrics(db: DB, today: string): Promise<PlatformMetrics> {
  const orgs = await listOrganizations(db, today)
  const subscriptions = Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, 0])) as Record<SubscriptionStatus, number>
  for (const o of orgs) subscriptions[o.entitlements.effective]++
  const n = async (sql: string, ...args: unknown[]) => ((await db.prepare(sql).get(...args)) as { n: number }).n
  const weekAgo = new Date(Date.parse(today) - 7 * 86400000).toISOString()
  const lastWhole = (await db
    .prepare("SELECT status, created_at AS createdAt FROM backup_runs WHERE organization_id IS NULL ORDER BY id DESC LIMIT 1")
    .get()) as { status: string; createdAt: string } | undefined
  const events = (await db
    .prepare(
      `SELECT a.at, a.action, o.name AS organization, a.email AS \`by\`, a.details FROM platform_audit a
       LEFT JOIN organizations o ON o.id = a.organization_id ORDER BY a.id DESC LIMIT 12`
    )
    .all()) as PlatformMetrics['recentEvents']
  return {
    organizations: {
      total: orgs.length,
      active: orgs.filter((o) => o.status === 'active').length,
      suspended: orgs.filter((o) => o.status === 'suspended').length,
      archived: orgs.filter((o) => o.status === 'archived').length
    },
    subscriptions,
    users: {
      active: await n('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND pending = 0'),
      signedInLast7Days: await n('SELECT COUNT(*) AS n FROM users WHERE last_login_at >= ?', weekAgo)
    },
    backups: { lastWholeDatabase: lastWhole ?? null, failedLast7Days: await n("SELECT COUNT(*) AS n FROM backup_runs WHERE status = 'failed' AND created_at >= ?", weekAgo) },
    recentEvents: events
  }
}
