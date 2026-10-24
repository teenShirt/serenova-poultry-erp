import { addDays, daysBetween } from '@shared/dates'
import { MODULES, type Entitlements, type Module, type Plan, type PlanLimits, type SubscriptionStatus } from '@shared/platform'
import type { Ctx } from '../context'
import type { DB } from '../db/connection'
import { AppError } from '../errors'

interface PlanRow {
  id: number
  code: string
  name: string
  max_users: number
  max_admins: number
  max_roles: number
  max_farms: number
  max_warehouses: number
  modules: string
  active: number
}

export function toPlan(r: PlanRow): Plan {
  let modules: Module[] = []
  try {
    modules = (JSON.parse(r.modules) as string[]).filter((m): m is Module => (MODULES as readonly string[]).includes(m))
  } catch {
    /* none */
  }
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    maxUsers: r.max_users,
    maxAdmins: r.max_admins,
    maxRoles: r.max_roles,
    maxFarms: r.max_farms,
    maxWarehouses: r.max_warehouses,
    modules,
    active: !!r.active
  }
}

/** The plan a new organization starts on, as a trial. */
export const DEFAULT_TRIAL = { plan: 'starter', days: 30 }

/** Gives an organization its first subscription (a trial of the given plan, or Enterprise for older organizations). */
export async function createSubscription(db: DB, orgId: number, opts: { planCode?: string; planId?: number; trialDays?: number; today: string }) {
  const plan = opts.planId
    ? ((await db.prepare('SELECT id FROM plans WHERE id = ?').get(opts.planId)) as { id: number } | undefined)
    : ((await db.prepare('SELECT id FROM plans WHERE code = ?').get(opts.planCode ?? DEFAULT_TRIAL.plan)) as { id: number } | undefined)
  if (!plan) throw new AppError('plan_not_found')
  const trial = opts.trialDays ?? 0
  await db
    .prepare('INSERT INTO subscriptions (organization_id, plan_id, status, starts_on, trial_ends_on, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(orgId, plan.id, trial > 0 ? 'trial' : 'active', opts.today, trial > 0 ? addDays(opts.today, trial) : null, new Date().toISOString())
}

/**
 * The subscription's state on a date, from its stored status and its dates: a trial or paid period
 * that has ended moves into its grace period, and after that it is expired. Suspended, cancelled
 * and expired stay as they are.
 */
export function effectiveStatus(
  s: { status: SubscriptionStatus; endsOn: string | null; trialEndsOn: string | null; graceDays: number },
  today: string
): {
  status: SubscriptionStatus
  until: string | null
} {
  if (s.status === 'suspended' || s.status === 'cancelled' || s.status === 'expired') return { status: s.status, until: null }
  const end = s.status === 'trial' ? s.trialEndsOn : s.endsOn
  if (!end || today <= end) return { status: s.status, until: end }
  const graceEnd = addDays(end, s.graceDays)
  if (today <= graceEnd) return { status: 'grace', until: graceEnd }
  return { status: 'expired', until: null }
}

/** What an organization may use today. */
export async function getEntitlements(db: DB, orgId: number, today: string): Promise<Entitlements> {
  let row = (await db
    .prepare(
      `SELECT s.status, s.starts_on, s.ends_on, s.trial_ends_on, s.grace_days, s.overrides, p.*
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.organization_id = ?`
    )
    .get(orgId)) as
    | (PlanRow & {
        status: SubscriptionStatus
        starts_on: string
        ends_on: string | null
        trial_ends_on: string | null
        grace_days: number
        overrides: string | null
      })
    | undefined
  if (!row) {
    // An organization restored from a backup made before subscriptions existed keeps everything it had.
    await createSubscription(db, orgId, { planCode: 'enterprise', today })
    return getEntitlements(db, orgId, today)
  }
  const plan = toPlan(row)
  let overrides: Partial<PlanLimits> = {}
  try {
    overrides = row.overrides ? (JSON.parse(row.overrides) as Partial<PlanLimits>) : {}
  } catch {
    /* ignore a damaged value */
  }
  const limits: PlanLimits = {
    maxUsers: overrides.maxUsers ?? plan.maxUsers,
    maxAdmins: overrides.maxAdmins ?? plan.maxAdmins,
    maxRoles: overrides.maxRoles ?? plan.maxRoles,
    maxFarms: overrides.maxFarms ?? plan.maxFarms,
    maxWarehouses: overrides.maxWarehouses ?? plan.maxWarehouses
  }
  const eff = effectiveStatus({ status: row.status, endsOn: row.ends_on, trialEndsOn: row.trial_ends_on, graceDays: row.grace_days }, today)
  return {
    planCode: plan.code,
    planName: plan.name,
    status: row.status,
    effective: eff.status,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    trialEndsOn: row.trial_ends_on,
    graceDays: row.grace_days,
    readOnly: ['expired', 'cancelled', 'suspended'].includes(eff.status),
    limits,
    modules: plan.modules,
    usage: await usage(db, orgId),
    daysLeft: eff.until ? daysBetween(today, eff.until) : null
  }
}

/**
 * How the plan's limits are counted:
 * - users: active accounts plus sign-ups waiting for approval (each will need a seat);
 *   deactivated accounts do not count
 * - admins: active accounts with the administrator role
 * - roles: custom roles in use or available (not archived), not counting the administrator role
 * - farms: active farms
 */
async function usage(db: DB, orgId: number) {
  const n = async (sql: string) => ((await db.prepare(sql).get(orgId)) as { n: number }).n
  return {
    users: await n('SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND (active = 1 OR pending = 1)'),
    admins: await n(
      'SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE u.organization_id = ? AND r.is_admin = 1 AND u.active = 1 AND u.pending = 0'
    ),
    roles: await n('SELECT COUNT(*) AS n FROM roles WHERE organization_id = ? AND is_admin = 0 AND archived_at IS NULL'),
    farms: await n("SELECT COUNT(*) AS n FROM farms WHERE organization_id = ? AND status = 'active'")
  }
}

export const today = (ctx: Pick<Ctx, 'now'>) => ctx.now().toISOString().slice(0, 10)

/** Changes are refused while the subscription is expired, cancelled or suspended (viewing and backups still work). */
export async function assertWritable(ctx: Pick<Ctx, 'db' | 'org' | 'now'>) {
  const e = await getEntitlements(ctx.db, ctx.org, today(ctx))
  if (e.readOnly) throw new AppError('subscription_read_only', { status: e.effective })
}

export async function assertModule(ctx: Pick<Ctx, 'db' | 'org' | 'now'>, module: Module) {
  const e = await getEntitlements(ctx.db, ctx.org, today(ctx))
  if (!e.modules.includes(module)) throw new AppError('module_not_in_plan', { module, plan: e.planName })
}

/** Before an account starts using a seat (new user, sign-up, reactivation) or an administrator seat. */
export async function assertSeat(ctx: Pick<Ctx, 'db' | 'org' | 'now'>, kind: { user?: boolean; admin?: boolean }) {
  const e = await getEntitlements(ctx.db, ctx.org, today(ctx))
  if (kind.user && e.usage.users >= e.limits.maxUsers) throw new AppError('user_limit_reached', { limit: e.limits.maxUsers, plan: e.planName })
  if (kind.admin && e.usage.admins >= e.limits.maxAdmins) throw new AppError('admin_limit_reached', { limit: e.limits.maxAdmins, plan: e.planName })
}

export async function assertRoleSlot(ctx: Pick<Ctx, 'db' | 'org' | 'now'>) {
  const e = await getEntitlements(ctx.db, ctx.org, today(ctx))
  if (e.usage.roles >= e.limits.maxRoles) throw new AppError('role_limit_reached', { limit: e.limits.maxRoles, plan: e.planName })
}
