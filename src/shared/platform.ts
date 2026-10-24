/**
 * The SaaS platform layer: plans, subscriptions and the Super Admin console.
 * Shared by the server and the browser.
 */

/** Optional parts of the product a plan can include. Everything else is in every plan. */
export const MODULES = ['purchasing', 'sales', 'advanced_reports', 'multi_farm', 'exports'] as const
export type Module = (typeof MODULES)[number]

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'grace', 'past_due', 'suspended', 'cancelled', 'expired'] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export interface PlanLimits {
  maxUsers: number
  maxAdmins: number
  maxRoles: number
  maxFarms: number
  maxWarehouses: number
}

export interface Plan extends PlanLimits {
  id: number
  code: string
  name: string
  modules: Module[]
  active: boolean
}

/** What an organization may use now: its plan, any per-customer overrides, and its subscription's state. */
export interface Entitlements {
  planCode: string
  planName: string
  /** The status as stored; `effective` takes the dates into account (e.g. active → grace → expired). */
  status: SubscriptionStatus
  effective: SubscriptionStatus
  startsOn: string
  endsOn: string | null
  trialEndsOn: string | null
  graceDays: number
  /** No changes allowed (expired, cancelled): records can be viewed and backed up, never deleted. */
  readOnly: boolean
  limits: PlanLimits
  modules: Module[]
  usage: { users: number; admins: number; roles: number; farms: number }
  /** Days until the trial / paid period / grace period ends (negative when past). */
  daysLeft: number | null
}

export interface OrgSummary {
  id: number
  code: string
  name: string
  status: 'active' | 'suspended' | 'archived'
  createdAt: string
  entitlements: Entitlements
  lastActivityAt: string | null
}

export interface PlatformUser {
  id: number
  email: string
  displayName: string
}

export interface PlatformStatus {
  user: PlatformUser | null
  version: string
  schemaVersion: number
}

export interface PlatformMetrics {
  organizations: { total: number; active: number; suspended: number; archived: number }
  subscriptions: Record<SubscriptionStatus, number>
  users: { active: number; signedInLast7Days: number }
  backups: { lastWholeDatabase: { status: string; createdAt: string } | null; failedLast7Days: number }
  recentEvents: { at: string; action: string; organization: string | null; by: string | null; details: string | null }[]
}

export interface SubscriptionChange {
  organizationId: number
  planId: number
  status: SubscriptionStatus
  startsOn: string
  endsOn: string | null
  trialEndsOn: string | null
  graceDays: number
  /** Per-customer limits that replace the plan's (null = use the plan's) */
  overrides: Partial<PlanLimits> | null
  note: string
}

/** Requests each module unlocks. Requests not listed are in every plan. */
export const MODULE_FOR_METHOD: Record<string, Module> = {
  'parties.saveSupplier': 'purchasing',
  'purchases.create': 'purchasing',
  'purchases.cancel': 'purchasing',
  'purchases.series': 'purchasing',
  'parties.saveCustomer': 'sales',
  'sales.dispatch': 'sales',
  'sales.addPayment': 'sales',
  'sales.cancel': 'sales',
  'sales.adjust': 'sales',
  'sales.series': 'sales',
  'supply.flow': 'advanced_reports'
}
