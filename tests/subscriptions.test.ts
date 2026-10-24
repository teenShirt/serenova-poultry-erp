import { describe, expect, it } from 'vitest'
import type { ApiMethod } from '@shared/api'
import { createHandlers, dispatch, loadSessionUser, type PublicCtx } from '../src/server/api'
import type { ServerConfig } from '../src/server/config'
import type { Ctx } from '../src/server/context'
import type { Databases } from '../src/server/databases'
import { createPlatformHandlers, dispatchPlatform, type PlatformCtx, type PlatformMethod } from '../src/server/platform-api'
import { createUser, signup, updateUser } from '../src/server/services/auth'
import { saveRole } from '../src/server/services/roles'
import { saveSettings } from '../src/server/services/settings'
import { createPlatformUser, loadPlatformUser } from '../src/server/services/platform'
import { effectiveStatus, getEntitlements } from '../src/server/services/subscriptions'
import { RestoreTokens } from '../src/server/uploads'
import { makeFarm, NOW } from './helpers'

const D = '2026-03-09'
const TODAY = '2026-03-10'

function api(db: Ctx['db']) {
  const dbs = { demoAvailable: false, location: () => 'test', with: <T>(_m: string, fn: (d: typeof db) => Promise<T>) => fn(db) } as unknown as Databases
  const cfg = { setupKey: null, backupDir: 'unused' } as unknown as ServerConfig
  const handlers = createHandlers({ cfg, dbs, restoreTokens: new RestoreTokens() })
  return (ctx: Ctx, method: ApiMethod, input: unknown) => dispatch(handlers, method, input, { ...ctx, mode: 'farm', session: {} } as PublicCtx)
}

/** The console, as the web server runs it; `as` is the signed-in platform administrator (or nobody). */
function consoleApi(db: Ctx['db']) {
  const handlers = createPlatformHandlers('test')
  return async (as: number | null, method: PlatformMethod, input?: unknown) => {
    const ctx: PlatformCtx = { db, now: () => NOW, mode: 'farm', session: {}, platformUser: await loadPlatformUser(db, as) }
    return { res: await dispatchPlatform(handlers, method, input, ctx), session: ctx.session }
  }
}

async function superAdmin(db: Ctx['db']) {
  return createPlatformUser(db, { email: 'ops@serenova.test', displayName: 'Ops', password: 'platform-secret-1' })
}

describe('subscription state from dates', () => {
  const base = { endsOn: null, trialEndsOn: null, graceDays: 7 }
  it('moves a trial into its grace period and then to expired', () => {
    const trial = { ...base, status: 'trial' as const, trialEndsOn: '2026-03-31' }
    expect(effectiveStatus(trial, '2026-03-31')).toEqual({ status: 'trial', until: '2026-03-31' })
    expect(effectiveStatus(trial, '2026-04-01')).toEqual({ status: 'grace', until: '2026-04-07' })
    expect(effectiveStatus(trial, '2026-04-08')).toEqual({ status: 'expired', until: null })
  })
  it('keeps an active subscription without an end date active, and suspended stays suspended', () => {
    expect(effectiveStatus({ ...base, status: 'active' }, '2030-01-01').status).toBe('active')
    expect(effectiveStatus({ ...base, status: 'suspended', endsOn: '2099-01-01' }, TODAY).status).toBe('suspended')
  })
})

describe('plan limits (enforced on the server)', () => {
  it('a Starter organization can have 5 users, counting sign-ups waiting for approval', async () => {
    const f = await makeFarm({ plan: 'starter', trialDays: 30 })
    const e = await getEntitlements(f.db, f.org, TODAY)
    expect(e).toMatchObject({ planCode: 'starter', effective: 'trial', trialEndsOn: '2026-04-09', readOnly: false, usage: { users: 2, admins: 1 } })
    await createUser(f.admin, { email: 'u3@test.farm', displayName: 'U3', password: 'secret123', roleId: f.roles.worker })
    await createUser(f.admin, { email: 'u4@test.farm', displayName: 'U4', password: 'secret123', roleId: f.roles.worker })
    await saveSettings(f.admin, { allowSignup: true })
    await signup(f.anon, { organizationCode: f.orgCode, email: 'u5@test.farm', displayName: 'U5', password: 'secret123' })
    const call = api(f.db)
    expect(await call(f.admin, 'users.create', { email: 'u6@test.farm', displayName: 'U6', password: 'secret123', roleId: f.roles.worker })).toMatchObject({
      ok: false,
      code: 'user_limit_reached',
      params: { limit: 5 }
    })
    await expect(signup(f.anon, { organizationCode: f.orgCode, email: 'u7@test.farm', displayName: 'U7', password: 'secret123' })).rejects.toMatchObject({ code: 'user_limit_reached' })
    // A deactivated account frees its seat, and reactivating it needs one again.
    const u3 = (await f.db.prepare("SELECT id FROM users WHERE email = 'u3@test.farm'").get()) as { id: number }
    await updateUser(f.admin, { id: u3.id, email: 'u3@test.farm', displayName: 'U3', roleId: f.roles.worker, active: false })
    await createUser(f.admin, { email: 'u6@test.farm', displayName: 'U6', password: 'secret123', roleId: f.roles.worker })
    await expect(updateUser(f.admin, { id: u3.id, email: 'u3@test.farm', displayName: 'U3', roleId: f.roles.worker, active: true })).rejects.toMatchObject({ code: 'user_limit_reached' })
  })

  it('a Starter organization has one administrator, and limited custom roles', async () => {
    const f = await makeFarm({ plan: 'starter' })
    const call = api(f.db)
    expect(await call(f.admin, 'users.create', { email: 'a2@test.farm', displayName: 'A2', password: 'secret123', roleId: f.roles.admin })).toMatchObject({ ok: false, code: 'admin_limit_reached' })
    const worker = f.worker.user!.id
    expect(await call(f.admin, 'users.update', { id: worker, email: 'worker@test.farm', displayName: 'Worker', roleId: f.roles.admin, active: true })).toMatchObject({
      ok: false,
      code: 'admin_limit_reached'
    })
    const limit = (await getEntitlements(f.db, f.org, TODAY)).limits.maxRoles
    let made = (await getEntitlements(f.db, f.org, TODAY)).usage.roles
    while (made < limit) await saveRole(f.admin, { id: null, name: `Role ${++made}`, description: null, permissions: ['eggs.record'] })
    expect(await call(f.admin, 'roles.save', { id: null, name: 'One too many', description: null, permissions: [] })).toMatchObject({ ok: false, code: 'role_limit_reached' })
  })

  it("modules outside the plan are refused, the rest of the farm's work is not", async () => {
    const f = await makeFarm({ plan: 'starter' })
    const call = api(f.db)
    expect(await call(f.admin, 'parties.saveSupplier', { id: null, name: 'Mill', phone: null, address: null, notes: null, active: true })).toMatchObject({
      ok: false,
      code: 'module_not_in_plan',
      params: { module: 'purchasing' }
    })
    expect(await call(f.admin, 'sales.dispatch', { date: D, customerId: 1, goodQty: 1, goodPrice: 1, crackedQty: 0, crackedPrice: 0, amountPaid: 0, paymentMethod: 'cash', invoiceNo: null, vehicle: null, driver: null, notes: null })).toMatchObject({ ok: false, code: 'module_not_in_plan' })
    expect(await call(f.worker, 'days.start', { date: D, corrections: [], acknowledgeWarnings: true })).toMatchObject({ ok: true })
    expect(await call(f.admin, 'analytics.comparison', { from: D, to: D })).toMatchObject({ ok: true })
  })
})

describe('an expired subscription', () => {
  it('becomes read-only: records stay and can be viewed and backed up, nothing can be changed', async () => {
    const f = await makeFarm({ plan: 'growth' })
    const call = api(f.db)
    expect(await call(f.worker, 'days.start', { date: D, corrections: [], acknowledgeWarnings: true })).toMatchObject({ ok: true })
    const egg = { date: D, cageId: f.cageIds[0], session: 'morning', collectedAt: '08:00', good: 800, damaged: 0, rejected: 0, notes: null, expectedId: null }
    expect(await call(f.worker, 'eggs.save', egg)).toMatchObject({ ok: true })
    await f.db.prepare("UPDATE subscriptions SET ends_on = '2026-02-01', grace_days = 14 WHERE organization_id = ?").run(f.org)

    expect((await getEntitlements(f.db, f.org, TODAY)).effective).toBe('expired')
    expect(await call(f.worker, 'eggs.save', { ...egg, cageId: f.cageIds[1] })).toMatchObject({ ok: false, code: 'subscription_read_only', params: { status: 'expired' } })
    expect(await call(f.admin, 'users.create', { email: 'x@test.farm', displayName: 'X', password: 'secret123', roleId: f.roles.worker })).toMatchObject({ ok: false, code: 'subscription_read_only' })
    const list = await call(f.worker, 'eggs.list', { date: D })
    expect(list.ok && (list.data as unknown[]).length).toBe(1)
    const status = await call(f.admin, 'app.status', undefined)
    expect(status.ok && (status.data as { subscription: { readOnly: boolean } }).subscription.readOnly).toBe(true)
    expect(await call(f.admin, 'auth.logout', undefined)).toMatchObject({ ok: true })
    // Nothing was removed.
    expect(((await f.db.prepare('SELECT COUNT(*) AS n FROM egg_collections WHERE organization_id = ?').get(f.org)) as { n: number }).n).toBe(1)
  })
})

describe('the Super Admin console', () => {
  it('needs a platform administrator; organization administrators cannot use it', async () => {
    const f = await makeFarm()
    const con = consoleApi(f.db)
    expect((await con(null, 'platform.organizations')).res).toMatchObject({ ok: false, code: 'not_logged_in' })
    expect((await con(null, 'platform.status')).res).toMatchObject({ ok: true, data: { user: null } })
    // An organization administrator's email and password are not a platform account.
    expect((await con(null, 'platform.login', { email: 'admin@test.farm', password: 'secret123' })).res).toMatchObject({ ok: false, code: 'invalid_login' })
    // And a platform session has no organization user, so organization requests are refused.
    const call = api(f.db)
    expect(await call({ ...f.admin, user: null }, 'users.list', undefined)).toMatchObject({ ok: false, code: 'not_logged_in' })
  })

  it('locks a platform account after five wrong passwords', async () => {
    const f = await makeFarm()
    await superAdmin(f.db)
    const con = consoleApi(f.db)
    for (let i = 0; i < 5; i++) expect((await con(null, 'platform.login', { email: 'ops@serenova.test', password: 'wrong-password' })).res).toMatchObject({ code: 'invalid_login' })
    expect((await con(null, 'platform.login', { email: 'ops@serenova.test', password: 'platform-secret-1' })).res).toMatchObject({ ok: false, code: 'account_locked' })
  })

  it('creates an organization on a plan, changes its subscription, suspends it; every action is audited', async () => {
    const f = await makeFarm()
    const ops = await superAdmin(f.db)
    const con = consoleApi(f.db)
    const login = await con(null, 'platform.login', { email: 'ops@serenova.test', password: 'platform-secret-1' })
    expect(login.res).toMatchObject({ ok: true })
    expect(login.session).toMatchObject({ platformUserId: ops, userId: null, orgId: null, rotate: true })

    const plans = (await con(ops, 'platform.plans')).res as { ok: true; data: { id: number; code: string }[] }
    expect(plans.data.map((p) => p.code)).toEqual(['starter', 'growth', 'enterprise'])
    const growth = plans.data.find((p) => p.code === 'growth')!.id
    const created = (await con(ops, 'platform.createOrganization', {
      name: 'Madawala Test',
      location: 'Madawala',
      timezone: 'Asia/Colombo',
      language: 'en',
      adminEmail: 'owner@madawala.test',
      adminName: 'Owner',
      adminPassword: 'secret123',
      planId: growth,
      trialDays: 14
    })).res as { ok: true; data: { id: number; code: string } }
    expect(created.ok).toBe(true)
    const orgId = created.data.id
    expect(await getEntitlements(f.db, orgId, TODAY)).toMatchObject({ planCode: 'growth', effective: 'trial', trialEndsOn: '2026-03-24', usage: { users: 1, admins: 1 } })

    // Per-customer limits: 4 users instead of Growth's 15.
    const change = { organizationId: orgId, planId: growth, status: 'active', startsOn: TODAY, endsOn: '2027-03-09', trialEndsOn: null, graceDays: 14, overrides: { maxUsers: 4 }, note: 'Paid yearly' }
    expect((await con(ops, 'platform.setSubscription', change)).res).toMatchObject({ ok: true })
    expect(await getEntitlements(f.db, orgId, TODAY)).toMatchObject({ effective: 'active', limits: { maxUsers: 4, maxAdmins: 2 } })
    expect((await con(ops, 'platform.setSubscription', { ...change, note: '' })).res).toMatchObject({ ok: false, code: 'reason_required' })

    // Suspending signs everyone out at once; the records stay.
    const owner = (await f.db.prepare("SELECT id FROM users WHERE email = 'owner@madawala.test'").get()) as { id: number }
    expect(await loadSessionUser({ db: f.db }, owner.id, orgId)).not.toBeNull()
    await f.db.prepare("INSERT INTO sessions (id, user_id, organization_id, mode, created_at, last_seen_at, expires_at) VALUES ('s1', ?, ?, 'farm', ?, ?, '2099-01-01')").run(owner.id, orgId, TODAY, TODAY)
    expect((await con(ops, 'platform.setOrganizationStatus', { id: orgId, status: 'suspended', reason: 'Unpaid invoice' })).res).toMatchObject({ ok: true })
    expect(await loadSessionUser({ db: f.db }, owner.id, orgId)).toBeNull()
    expect(await f.db.prepare('SELECT 1 AS x FROM sessions WHERE organization_id = ?').get(orgId)).toBeUndefined()
    expect(await f.db.prepare('SELECT 1 AS x FROM users WHERE id = ?').get(owner.id)).toBeDefined()
    // The other organization is untouched.
    expect(await loadSessionUser({ db: f.db }, f.admin.user!.id, f.org)).not.toBeNull()

    const orgs = (await con(ops, 'platform.organizations')).res as { ok: true; data: { id: number; status: string }[] }
    expect(orgs.data.find((o) => o.id === orgId)?.status).toBe('suspended')
    const metrics = (await con(ops, 'platform.metrics')).res as { ok: true; data: { organizations: { total: number; suspended: number } } }
    expect(metrics.data.organizations).toMatchObject({ total: 2, suspended: 1 })

    const actions = ((await f.db.prepare('SELECT action FROM platform_audit ORDER BY id').all()) as { action: string }[]).map((r) => r.action)
    expect(actions).toEqual(['create_platform_user', 'platform_login', 'create_organization', 'set_subscription', 'set_organization_status'])
  })

  it('validates plans: limits are numbers in range, codes are unique', async () => {
    const f = await makeFarm()
    const ops = await superAdmin(f.db)
    const con = consoleApi(f.db)
    const plan = { id: null, code: 'growth', name: 'Copy', maxUsers: 10, maxAdmins: 2, maxRoles: 5, maxFarms: 2, maxWarehouses: 2, modules: ['sales'], active: true }
    expect((await con(ops, 'platform.savePlan', plan)).res).toMatchObject({ ok: false, code: 'name_taken' })
    expect((await con(ops, 'platform.savePlan', { ...plan, code: 'small', maxAdmins: 20 })).res).toMatchObject({ ok: false, code: 'invalid_input' })
    expect((await con(ops, 'platform.savePlan', { ...plan, code: 'small', maxUsers: -1 })).res).toMatchObject({ ok: false, code: 'invalid_input' })
    expect((await con(ops, 'platform.savePlan', { ...plan, code: 'small' })).res).toMatchObject({ ok: true })
  })
})
