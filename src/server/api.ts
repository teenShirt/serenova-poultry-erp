import fs from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import type { Api, ApiMethod, ApiResponse, ReportSpec } from '@shared/api'
import { API_KIND } from '@shared/api'
import { addDays, todayInTimezone } from '@shared/dates'
import type { AppStatus, SessionUser } from '@shared/types'
import { MODULE_FOR_METHOD } from '@shared/platform'
import { requireUser, type AnonCtx, type Ctx } from './context'
import type { ServerConfig } from './config'
import type { Databases, Mode } from './databases'
import { AppError } from './errors'
import { schemas } from './schemas'
import type { SessionChange } from './sessions'
import { audit, listAudit } from './services/audit'
import * as auth from './services/auth'
import * as cages from './services/cages'
import * as days from './services/days'
import * as eggs from './services/eggs'
import * as flock from './services/flock'
import * as feed from './services/feed'
import * as water from './services/water'
import * as medicine from './services/medicine'
import * as inventory from './services/inventory'
import * as analytics from './services/analytics'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from './services/settings'
import { completeSetup, platformHasOrganizations } from './services/setup'
import { DEMO_USERS } from './services/demo'
import { createBackup, lastBackup, listBackupRuns, restoreOrganization } from './services/backup'
import { dayReport, periodReport, type ReportModel } from './reports/model'
import { renderHtml } from './reports/render'
import { checkAccess, dutyTasks, setUserCages } from './services/duties'
import { archiveRole, hasPermission, listRoles, saveRole, requirePermission } from './services/roles'
import { listParties, saveParty } from './services/parties'
import { cancelReceipt, createReceipt, listReceipts } from './services/purchases'
import * as sales from './services/sales'
import { flowSummary, purchasesSeries } from './services/supply'
import * as adminSvc from './services/admin'
import * as flocks from './services/flocks'
import * as stores from './services/stores'
import * as tasks from './services/tasks'
import * as schedules from './services/schedules'
import { movementsPage, organizationOverview } from './services/overview'
import { approveReceipt, closeOrder, createOrder, listOrders, rejectReceipt } from './services/purchases'
import { assertModule, assertWritable, getEntitlements, today } from './services/subscriptions'
import type { RestoreTokens } from './uploads'

export { APP_VERSION } from './version'
import { APP_VERSION } from './version'

/**
 * What a signed-in request runs with: its organization and farm (from the session, never from the
 * input), its database session, and the browser session it may change.
 */
export interface RequestCtx extends Ctx {
  mode: Mode
  /** Changes to the browser session, applied by the HTTP layer once the request has succeeded. */
  session: SessionChange
}

/** What a request runs with before anyone has signed in: no organization yet. */
export interface PublicCtx extends AnonCtx {
  mode: Mode
  session: SessionChange
  user: SessionUser | null
  org: number | null
  farm: number | null
}

export interface ApiDeps {
  cfg: ServerConfig
  dbs: Databases
  restoreTokens: RestoreTokens
}

/** Methods callable before signing in. Everything else requires a signed-in user of an organization. */
const PUBLIC_METHODS = [
  'app.status',
  'app.setLanguage',
  'auth.signup',
  'auth.resetWithCode',
  'setup.complete',
  'demo.enter',
  'demo.exit',
  'demo.reset',
  'auth.login'
] as const
type PublicMethod = (typeof PUBLIC_METHODS)[number]
const PUBLIC = new Set<ApiMethod>(PUBLIC_METHODS)

/** Organization requests; the Super Admin console's platform.* requests are handled in platform-api.ts. */
export type OrgMethod = Exclude<ApiMethod, `platform.${string}`>
type Handler<M extends OrgMethod> = (input: Api[M]['in'], ctx: M extends PublicMethod ? PublicCtx : RequestCtx) => Promise<Api[M]['out']> | Api[M]['out']
type Handlers = { [M in OrgMethod]: Handler<M> }

/**
 * Requests that still work while the subscription is read-only (expired, cancelled, suspended):
 * signing out, looking after one's own account, and taking a backup of the organization's records.
 */
const ALLOWED_WHILE_READ_ONLY = new Set<ApiMethod>([
  'auth.logout',
  'auth.changePassword',
  'auth.newRecoveryCode',
  'app.setLanguage',
  'backup.create',
  'farms.switch'
])

function validatePeriod(from: string, to: string) {
  if (from > to || from < addDays(to, -400)) throw new AppError('invalid_date')
}

export async function buildReport(ctx: RequestCtx, spec: ReportSpec): Promise<ReportModel> {
  const lang = (await getSettings(ctx)).language
  const isDemo = ctx.mode === 'demo'
  if (spec.kind === 'period') {
    validatePeriod(spec.from, spec.to)
    return periodReport(ctx, spec.from, spec.to, lang, isDemo)
  }
  return dayReport(ctx, spec.date, spec.kind, lang, isDemo)
}

/** Records a generated report in the history (shown under Reports → Recent). */
export async function recordReport(ctx: Ctx, spec: ReportSpec, format: 'pdf' | 'xlsx', fileName: string) {
  const from = spec.kind === 'period' ? spec.from : spec.date
  const to = spec.kind === 'period' ? spec.to : spec.date
  await ctx.db
    .prepare(
      'INSERT INTO report_runs (organization_id, kind, period_start, period_end, format, file_path, generated_by, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(ctx.org, spec.kind, from, to, format, fileName, ctx.user?.id ?? null, ctx.now().toISOString())
}

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Loads the signed-in user afresh on every request, so a disabled account, a changed role or a
 * suspended organization takes effect at once. The user must belong to the session's organization.
 */
export async function loadSessionUser(ctx: Pick<Ctx, 'db'>, userId: number | null, orgId: number | null): Promise<SessionUser | null> {
  if (!userId || !orgId) return null
  const row = (await ctx.db
    .prepare(
      `SELECT u.id, u.organization_id, u.username, u.email, u.display_name, u.role_id, u.active, u.pending, u.assigned_cages, o.status AS org_status
       FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = ? AND u.organization_id = ?`
    )
    .get(userId, orgId)) as
    | {
        id: number
        organization_id: number
        username: string
        email: string | null
        display_name: string
        role_id: number | null
        active: number
        pending: number
        assigned_cages: string | null
        org_status: string
      }
    | undefined
  if (!row || !row.active || row.pending || !row.email || row.org_status !== 'active') return null
  // The role is read afresh too: a changed or archived role takes effect on the next request.
  return auth.toSessionUser(ctx, row)
}

/** The farm a session works on: the one it chose, if it is still an active farm of the organization, else the first one. */
export async function sessionFarm(ctx: Pick<Ctx, 'db'>, orgId: number, farmId: number | null): Promise<number> {
  if (farmId) {
    const ok = await ctx.db.prepare("SELECT 1 AS x FROM farms WHERE id = ? AND organization_id = ? AND status = 'active'").get(farmId, orgId)
    if (ok) return farmId
  }
  return auth.defaultFarm(ctx, orgId)
}

export function createHandlers({ cfg, dbs, restoreTokens }: ApiDeps): Handlers {
  const status = async (ctx: PublicCtx | RequestCtx): Promise<AppStatus> => {
    const scoped = ctx.org !== null && ctx.farm !== null && ctx.user ? (ctx as RequestCtx) : null
    const settings = scoped ? await getSettings(scoped) : { ...DEFAULT_SETTINGS }
    const lastAuto = scoped && ctx.mode === 'farm' ? await lastBackup(ctx.db, scoped.org, 'auto') : undefined
    const demoExists = dbs.demoAvailable ? await dbs.with('demo', (db) => platformHasOrganizations({ db })) : false
    const org = scoped ? ((await ctx.db.prepare('SELECT code, name FROM organizations WHERE id = ?').get(scoped.org)) as { code: string; name: string }) : null
    const farm = scoped ? ((await ctx.db.prepare('SELECT id, name FROM farms WHERE id = ?').get(scoped.farm)) as { id: number; name: string }) : null
    return {
      environment: cfg.environment,
      setupComplete: await platformHasOrganizations(ctx),
      organization: org,
      farm,
      setupKeyRequired: !!cfg.setupKey,
      isDemo: ctx.mode === 'demo',
      demoAvailable: dbs.demoAvailable,
      demoExists,
      user: ctx.user,
      settings,
      version: APP_VERSION,
      dataDir: dbs.location(ctx.mode),
      today: scoped ? await days.farmToday(scoped) : todayInTimezone(DEFAULT_SETTINGS.timezone, ctx.now()),
      backupWarning: lastAuto && lastAuto.status === 'failed' ? lastAuto.message : null,
      subscription: scoped ? await getEntitlements(ctx.db, scoped.org, today(ctx)) : null,
      pendingSignups: scoped && hasPermission(scoped.user, 'users.manage') ? await auth.countPendingSignups(scoped) : 0
    }
  }

  return {
    'app.status': (_, ctx) => status(ctx),
    'app.setLanguage': async ({ language }, ctx) => {
      // The language is an organization setting: only its signed-in users may change it. Before
      // signing in (and during first-run setup) the browser remembers the choice itself.
      if (!ctx.user || ctx.org === null || ctx.farm === null) {
        if (await platformHasOrganizations(ctx)) throw new AppError('not_logged_in')
        return
      }
      await saveSettings({ ...ctx, org: ctx.org, farm: ctx.farm }, { language })
    },
    'setup.complete': async ({ setupKey, ...input }, ctx) => {
      if (ctx.mode === 'demo') throw new AppError('not_in_demo')
      if (cfg.setupKey && !sameSecret(setupKey ?? '', cfg.setupKey)) throw new AppError('invalid_setup_key')
      return { recoveryCode: (await completeSetup(ctx, input)).recoveryCode }
    },
    'demo.enter': async (_, ctx) => {
      if (ctx.user) throw new AppError('demo_only_in_setup')
      if (!dbs.demoAvailable) throw new AppError('demo_unavailable')
      const empty = !(await dbs.with('demo', (db) => platformHasOrganizations({ db })))
      if (empty) await dbs.resetDemo()
      ctx.session.mode = 'demo'
      ctx.session.userId = null
      ctx.session.orgId = null
      ctx.session.farmId = null
      return { email: DEMO_USERS.admin.email, password: DEMO_USERS.admin.password }
    },
    'demo.exit': (_, ctx) => {
      ctx.session.mode = 'farm'
      ctx.session.userId = null
      ctx.session.orgId = null
      ctx.session.farmId = null
      ctx.session.rotate = true
    },
    'demo.reset': async (_, ctx) => {
      // Only ever touches the separate demonstration database.
      if (ctx.mode !== 'demo') throw new AppError('not_in_demo')
      await dbs.resetDemo()
      ctx.session.userId = null
      ctx.session.orgId = null
      ctx.session.farmId = null
    },

    'auth.login': async ({ email, password }, ctx) => {
      const signedIn = await auth.login(ctx, email, password)
      ctx.session.userId = signedIn.user.id
      ctx.session.orgId = signedIn.org
      ctx.session.farmId = signedIn.farm
      ctx.session.platformUserId = null
      ctx.session.rotate = true
      return signedIn.user
    },
    'auth.logout': async (_, ctx) => {
      await audit(ctx, { action: 'logout', entity: 'user', entityId: ctx.user?.id })
      ctx.session.userId = null
      ctx.session.orgId = null
      ctx.session.farmId = null
      ctx.session.rotate = true
    },
    'auth.changePassword': ({ current, next }, ctx) => auth.changeOwnPassword(ctx, current, next),
    'auth.signup': (u, ctx) => auth.signup(ctx, u),
    'auth.resetWithCode': ({ email, recoveryCode, newPassword }, ctx) => auth.resetWithRecoveryCode(ctx, email, recoveryCode, newPassword),
    'auth.newRecoveryCode': ({ password }, ctx) => auth.newOwnRecoveryCode(ctx, password),
    'users.list': (_, ctx) => auth.listUsers(ctx),
    'users.create': (u, ctx) => auth.createUser(ctx, u),
    'users.update': (u, ctx) => auth.updateUser(ctx, u),
    'users.resetPassword': ({ id, password }, ctx) => auth.resetPassword(ctx, id, password),
    'users.approve': ({ id, roleId }, ctx) => auth.approveSignup(ctx, id, roleId),
    'roles.list': (_, ctx) => listRoles(ctx),
    'roles.save': (r, ctx) => saveRole(ctx, r),
    'roles.archive': ({ id }, ctx) => archiveRole(ctx, id),
    'users.reject': ({ id }, ctx) => auth.rejectSignup(ctx, id),
    'users.newRecoveryCode': ({ id }, ctx) => auth.adminNewRecoveryCode(ctx, id),

    'settings.get': (_, ctx) => getSettings(ctx),
    'settings.save': async (patch, ctx) => {
      requirePermission(ctx, 'settings.manage')
      await ctx.db.transaction(async () => {
        const changed = await saveSettings(ctx, patch)
        if (Object.keys(changed).length) await audit(ctx, { action: 'update', entity: 'settings', details: changed })
      })()
      return getSettings(ctx)
    },

    'cages.list': async ({ includeInactive }, ctx) => {
      const out: Api['cages.list']['out'] = []
      for (const c of await cages.listCages(ctx, includeInactive ?? true)) out.push({ ...c, hasHistory: await cages.cageHasHistory(ctx, c.id) })
      return out
    },
    'cages.create': (c, ctx) => cages.createCage(ctx, c),
    'cages.update': ({ id, cage, reason }, ctx) => cages.updateCage(ctx, id, cage, reason),

    'farms.list': (_, ctx) => flocks.listFarms(ctx),
    'farms.save': (f, ctx) => flocks.saveFarm(ctx, f),
    'farms.setStatus': ({ id, status, reason }, ctx) => flocks.setFarmStatus(ctx, id, status, reason),
    'farms.switch': async ({ id }, ctx) => {
      await flocks.checkFarmForSwitch(ctx, id)
      ctx.session.farmId = id
    },
    'houses.list': (_, ctx) => flocks.listHouses(ctx),
    'houses.save': (h, ctx) => flocks.saveHouse(ctx, h),
    'flocks.list': ({ includeClosed }, ctx) => flocks.listFlocks(ctx, includeClosed ?? true),
    'flocks.get': ({ id }, ctx) => flocks.getFlock(ctx, id),
    'flocks.save': (f, ctx) => flocks.saveFlock(ctx, f),
    'flocks.place': ({ id, cageIds, fromDate }, ctx) => flocks.placeFlock(ctx, id, cageIds, fromDate),
    'flocks.endPlacement': ({ id, cageId, toDate }, ctx) => flocks.endPlacement(ctx, id, cageId, toDate),
    'flocks.close': ({ id, date, reason }, ctx) => flocks.closeFlock(ctx, id, date, reason),
    'flocks.series': ({ id, from, to }, ctx) => {
      validatePeriod(from, to)
      return flocks.flockSeries(ctx, id, from, to)
    },
    'flocks.reminders': (_, ctx) => flocks.listReminders(ctx),
    'flocks.saveReminder': (r, ctx) => flocks.saveReminder(ctx, r),
    'flocks.dueReminders': async (_, ctx) => flocks.remindersFor(ctx, await flocks.listFlocks(ctx, false)),
    'flocks.markReminder': ({ flockId, reminderId, outcome, note }, ctx) => flocks.markReminder(ctx, flockId, reminderId, outcome, note),

    'days.preview': ({ date }, ctx) => days.previewStartDay(ctx, date),
    'days.start': (input, ctx) => days.startDay(ctx, input),
    'days.overview': ({ date }, ctx) => days.getOverview(ctx, date),
    'days.list': ({ from, to }, ctx) => days.listDays(ctx, from, to),
    'days.latest': async (_, ctx) => (await days.latestDay(ctx)) ?? null,
    'days.correctOpening': ({ date, cageId, opening, reason }, ctx) => days.correctOpening(ctx, date, cageId, opening, reason),
    'days.confirmMortality': ({ date, cageIds }, ctx) => days.confirmMortality(ctx, date, cageIds),
    'days.confirmIssue': ({ date, cageId, key, reason }, ctx) => days.confirmIssue(ctx, date, cageId, key, reason),
    'days.revokeConfirmation': ({ date, cageId, key }, ctx) => days.revokeConfirmation(ctx, date, cageId, key),
    'days.saveComment': ({ date, comment }, ctx) => days.saveComment(ctx, date, comment),
    'days.close': async ({ date, comment }, ctx) => ({ overview: await days.closeDay(ctx, date, comment) }),
    'days.startAmendment': ({ date, reason }, ctx) => days.startAmendment(ctx, date, reason),
    'days.finishAmendment': ({ date, comment }, ctx) => days.finishAmendment(ctx, date, comment),
    'days.amendments': async ({ date }, ctx) => (await days.listAmendments(ctx, date)) as Api['days.amendments']['out'],

    'eggs.list': ({ date, cageId }, ctx) => eggs.listEggs(ctx, date, cageId),
    'eggs.save': ({ expectedId, ...input }, ctx) => eggs.saveEggs(ctx, input, expectedId),
    'eggs.delete': ({ id, reason }, ctx) => eggs.deleteEggs(ctx, id, reason),

    'flock.list': ({ date, cageId }, ctx) => flock.listMovements(ctx, date, cageId),
    'flock.listRange': ({ from, to, cageId }, ctx) => flock.listMovementsRange(ctx, from, to, cageId),
    'flock.add': (m, ctx) => flock.addMovement(ctx, m),
    'flock.transfer': (t, ctx) => flock.transferHens(ctx, t),
    'flock.delete': ({ id, reason }, ctx) => flock.deleteMovement(ctx, id, reason),

    'feed.list': ({ date, cageId }, ctx) => feed.listFeed(ctx, date, cageId),
    'feed.suggestOpening': ({ date, cageId, itemId }, ctx) => feed.suggestedOpeningStock(ctx, date, cageId, itemId),
    'feed.save': ({ expectedId, ...f }, ctx) => feed.saveFeed(ctx, f, expectedId),
    'feed.delete': ({ id, reason }, ctx) => feed.deleteFeed(ctx, id, reason),

    'water.list': ({ date }, ctx) => water.listWater(ctx, date),
    'water.suggestOpening': ({ date, cageId }, ctx) => water.suggestedOpeningReading(ctx, date, cageId),
    'water.save': ({ expectedId, ...w }, ctx) => water.saveWater(ctx, w, expectedId),
    'water.delete': ({ id, reason }, ctx) => water.deleteWater(ctx, id, reason),

    'medicine.treatments': ({ from, to, cageId }, ctx) => medicine.listTreatments(ctx, from, to, cageId),
    'medicine.addTreatment': (t, ctx) => medicine.addTreatment(ctx, t),
    'medicine.deleteTreatment': ({ id, reason }, ctx) => medicine.deleteTreatment(ctx, id, reason),
    'feeding.schedules': (_, ctx) => schedules.listSchedules(ctx),
    'feeding.saveSchedule': (s, ctx) => schedules.saveSchedule(ctx, s),
    'feeding.status': ({ date }, ctx) => schedules.feedingStatus(ctx, date),
    'feeding.markFed': ({ scheduleId, date, fedAt, note }, ctx) => schedules.markFed(ctx, scheduleId, date, fedAt, note),
    'medicine.withdrawals': ({ date }, ctx) => schedules.activeWithdrawals(ctx, date),
    'medicine.healthEvents': ({ from, to, cageId }, ctx) => medicine.listHealthEvents(ctx, from, to, cageId),
    'medicine.addHealthEvent': (h, ctx) => medicine.addHealthEvent(ctx, h),
    'medicine.deleteHealthEvent': ({ id, reason }, ctx) => medicine.deleteHealthEvent(ctx, id, reason),

    'inventory.items': ({ category }, ctx) => inventory.listItems(ctx, category),
    'inventory.createItem': (i, ctx) => inventory.createItem(ctx, i),
    'inventory.updateItem': ({ id, item }, ctx) => inventory.updateItem(ctx, id, item),
    'inventory.balances': ({ category, warehouseId }, ctx) => inventory.balances(ctx, category, undefined, warehouseId ? { warehouseId } : undefined),
    'inventory.batches': (f, ctx) => inventory.listBatches(ctx, f),
    'inventory.txns': (f, ctx) => inventory.listTxns(ctx, f),
    'inventory.record': (t, ctx) => inventory.recordTxn(ctx, t),

    'analytics.dashboard': async ({ date }, ctx) => {
      const d = await analytics.dashboard(ctx, date, ctx.mode === 'demo', (await status(ctx)).backupWarning)
      const pending = hasPermission(ctx.user, 'users.manage') ? await auth.countPendingSignups(ctx) : 0
      if (pending > 0) d.alerts.unshift({ code: 'pending_signups', severity: 'info', params: { count: pending } })
      for (const w of await schedules.activeWithdrawals(ctx, date)) {
        d.alerts.push({ code: 'egg_withdrawal', severity: 'warning', params: { cage: w.cageName ?? '—', item: w.item, date: w.eggsUsableFrom } })
      }
      const missed = (await schedules.feedingStatus(ctx, date)).filter((s) => s.state === 'missed').length
      if (missed) d.alerts.push({ code: 'feeding_missed', severity: 'warning', params: { count: missed } })
      const overdue = await tasks.myOverdueCount(ctx)
      if (overdue > 0) d.alerts.push({ code: 'tasks_overdue', severity: 'warning', params: { count: overdue } })
      // Age reminders the organization set up (its own programme; never suggested by the system).
      for (const r of await flocks.remindersFor(ctx, await flocks.listFlocks(ctx, false), 0)) {
        if (r.state === 'due' || r.state === 'overdue') {
          d.alerts.push({
            code: r.state === 'due' ? 'flock_reminder_due' : 'flock_reminder_overdue',
            severity: r.state === 'due' ? 'info' : 'warning',
            params: { flock: r.flockCode, title: r.title, week: r.atWeek }
          })
        }
      }
      return d
    },
    'analytics.series': ({ from, to, cageId }, ctx) => analytics.dailySeries(ctx, from, to, cageId),
    'analytics.comparison': ({ from, to }, ctx) => analytics.cageComparison(ctx, from, to),

    'audit.list': (f, ctx) => {
      requirePermission(ctx, 'audit.view')
      return listAudit(ctx, f)
    },

    'reports.preview': async (spec, ctx) => {
      const model = await buildReport(ctx, spec)
      return { title: `${model.title} — ${model.subtitle}`, html: renderHtml(model, (await getSettings(ctx)).language) }
    },
    'reports.print': async (spec, ctx) => {
      const model = await buildReport(ctx, spec)
      await recordReport(ctx, spec, 'pdf', `${model.fileStem}.pdf`)
      await audit(ctx, { action: 'print_report', entity: 'report', details: spec })
      return { title: `${model.title} — ${model.subtitle}`, html: renderHtml(model, (await getSettings(ctx)).language) }
    },
    'reports.recent': async (_, ctx) =>
      (await ctx.db
        .prepare(
          `SELECT id, kind, period_start AS periodStart, period_end AS periodEnd, format, generated_at AS generatedAt
           FROM report_runs ORDER BY id DESC LIMIT 30`
        )
        .all()) as Api['reports.recent']['out'],

    'duties.mine': ({ date }, ctx) => dutyTasks(ctx, date),
    'users.setCages': ({ id, cages }, ctx) => setUserCages(ctx, id, cages),

    'parties.list': ({ kind }, ctx) => listParties(ctx, kind),
    'parties.saveSupplier': (p, ctx) => saveParty(ctx, 'supplier', p),
    'parties.saveCustomer': (p, ctx) => saveParty(ctx, 'customer', p),
    'purchases.list': ({ from, to }, ctx) => listReceipts(ctx, from, to),
    'purchases.create': (r, ctx) => createReceipt(ctx, r),
    'purchases.cancel': ({ id, reason }, ctx) => cancelReceipt(ctx, id, reason),
    'purchases.approve': ({ id }, ctx) => approveReceipt(ctx, id),
    'purchases.reject': ({ id, reason }, ctx) => rejectReceipt(ctx, id, reason),
    'purchases.orders': ({ openOnly }, ctx) => listOrders(ctx, { openOnly }),
    'purchases.createOrder': (o, ctx) => createOrder(ctx, o),
    'purchases.closeOrder': ({ id, status, reason }, ctx) => closeOrder(ctx, id, status, reason),
    'stores.list': ({ includeInactive }, ctx) => stores.listWarehouses(ctx, includeInactive ?? true),
    'stores.save': (w, ctx) => stores.saveWarehouse(ctx, w),
    'stores.balances': (f, ctx) => stores.storeBalances(ctx, f),
    'stores.transfer': (t, ctx) => stores.transferStock(ctx, t),
    'stores.count': (c, ctx) => stores.countStock(ctx, c),
    'stores.counts': ({ from, to }, ctx) => {
      validatePeriod(from, to)
      return stores.listCounts(ctx, from, to)
    },
    'stores.movements': (f, ctx) => {
      validatePeriod(f.from, f.to)
      return movementsPage(ctx, f)
    },
    'overview.organization': ({ from, to }, ctx) => {
      validatePeriod(from, to)
      return organizationOverview(ctx, from, to)
    },
    'tasks.list': ({ from, to, mineOnly }, ctx) => {
      validatePeriod(from, to)
      return tasks.listTasks(ctx, { from, to, mineOnly })
    },
    'tasks.get': ({ id }, ctx) => tasks.getTask(ctx, id),
    'tasks.save': (t, ctx) => tasks.saveTask(ctx, t),
    'tasks.action': ({ id, action, note }, ctx) => tasks.taskAction(ctx, id, action, note),
    'tasks.assignees': (_, ctx) => tasks.assignees(ctx),
    'tasks.report': ({ from, to, by }, ctx) => {
      validatePeriod(from, to)
      return tasks.taskReport(ctx, from, to, by)
    },
    'purchases.series': ({ from, to }, ctx) => purchasesSeries(ctx, from, to),
    'sales.stock': async (_, ctx) => ({ ...(await sales.eggStock(ctx)), outstanding: await sales.outstandingTotal(ctx) }),
    'sales.list': (f, ctx) => sales.listDispatches(ctx, f),
    'sales.dispatch': (d, ctx) => sales.createDispatch(ctx, d),
    'sales.addPayment': (p, ctx) => sales.addPayment(ctx, p),
    'sales.cancel': ({ id, reason }, ctx) => sales.cancelDispatch(ctx, id, reason),
    'sales.adjust': (a, ctx) => sales.adjustEggStore(ctx, a),
    'sales.adjustments': ({ from, to }, ctx) => sales.listEggAdjustments(ctx, from, to),
    'sales.series': ({ from, to }, ctx) => sales.salesSeries(ctx, from, to),
    'supply.flow': ({ from, to }, ctx) => {
      validatePeriod(from, to)
      return flowSummary(ctx, from, to)
    },

    'admin.dbInfo': (_, ctx) => adminSvc.dbInfo(ctx, dbs.location(ctx.mode)),
    'admin.checkDb': (_, ctx) => adminSvc.checkDatabase(ctx),
    'admin.optimize': async (_, ctx) => {
      await adminSvc.optimizeDatabase(ctx)
      return adminSvc.dbInfo(ctx, dbs.location(ctx.mode))
    },
    'admin.activity': ({ from, to }, ctx) => adminSvc.activitySummary(ctx, from, to),

    'backup.list': (_, ctx) => listBackupRuns(ctx.db, ctx.org),
    'backup.create': async (_, ctx) => {
      if (ctx.mode === 'demo') throw new AppError('demo_mode_blocked')
      requireUser(ctx)
      const info = await createBackup(ctx.db, cfg.backupDir, 'manual', { orgId: ctx.org })
      await audit(ctx, { action: 'backup', entity: 'backup', details: { path: info.path, status: info.status, message: info.message } })
      if (info.status === 'failed') throw new AppError('backup_failed', { message: info.message ?? '' })
      return info
    },
    'backup.restore': async ({ token }, ctx) => {
      if (ctx.mode === 'demo') throw new AppError('demo_mode_blocked')
      requirePermission(ctx, 'backup.restore')
      const upload = restoreTokens.take(token, ctx.user!.id)
      if (!upload?.data) throw new AppError('file_not_allowed')
      try {
        // Only this organization's own backups, and only over this organization's data.
        const org = (await ctx.db.prepare('SELECT code FROM organizations WHERE id = ?').get(ctx.org)) as { code: string }
        const src = upload.data.tables['organizations']
        const code = src ? src.rows[0]?.[src.columns.indexOf('code')] : undefined
        if (upload.data.scope !== 'organization' || code !== org.code) throw new AppError('not_this_organization_backup')
        // Safety copy of the current data first.
        const safety = await createBackup(ctx.db, cfg.backupDir, 'pre_restore', { orgId: ctx.org })
        if (safety.status !== 'ok') throw new AppError('backup_failed', { message: safety.message ?? '' })
        await audit(ctx, { action: 'restore', entity: 'backup', details: { from: upload.name, safetyBackup: safety.path } })
        try {
          await restoreOrganization(ctx.db, ctx.org, upload.data)
        } catch (e) {
          throw new AppError('restore_failed', { message: (e as Error).message })
        }
        // The restored data has its own users, so whoever restored it is signed out (as is everyone else).
        await audit({ ...ctx, user: null }, { action: 'restored_from_backup', entity: 'backup', details: { from: upload.name, safetyBackup: safety.path } })
        ctx.session.userId = null
        ctx.session.orgId = null
        ctx.session.farmId = null
        ctx.session.rotate = true
      } finally {
        fs.rmSync(upload.file, { force: true })
      }
    }
  }
}

/**
 * Runs one API request: validates the input against its schema, checks sign-in and duties,
 * and runs the handler. Data-changing requests run one at a time per database.
 */
export async function dispatch(handlers: Handlers, method: string, input: unknown, ctx: PublicCtx): Promise<ApiResponse<unknown>> {
  if (!Object.prototype.hasOwnProperty.call(handlers, method)) return { ok: false, code: 'unknown_method', params: {} }
  const m = method as OrgMethod
  const parsed = schemas[m].safeParse(input)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? ''
    return { ok: false, code: 'invalid_input', params: { field } }
  }
  try {
    const run = async () => {
      if (PUBLIC.has(m)) return (handlers[m] as (i: never, c: PublicCtx) => unknown)(parsed.data as never, ctx)
      // Everything else runs inside the signed-in user's organization and farm.
      requireUser(ctx)
      if (ctx.org === null || ctx.farm === null) throw new AppError('not_logged_in')
      const scoped: RequestCtx = { ...ctx, org: ctx.org, farm: ctx.farm }
      // The subscription: its plan's modules, and no changes while it is read-only.
      const module = MODULE_FOR_METHOD[m]
      if (module) await assertModule(scoped, module)
      if (API_KIND[m] === 'write' && !ALLOWED_WHILE_READ_ONLY.has(m)) await assertWritable(scoped)
      await checkAccess(scoped, m, parsed.data)
      return (handlers[m] as (i: never, c: RequestCtx) => unknown)(parsed.data as never, scoped)
    }
    const data = API_KIND[m] === 'write' ? await ctx.db.withWriteLock(run) : await run()
    return { ok: true, data }
  } catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, params: e.params }
    const msg = (e as Error).message ?? String(e)
    if (msg.startsWith('DATABASE_TOO_NEW')) return { ok: false, code: 'DATABASE_TOO_NEW', params: {} }
    if (msg === 'DATABASE_BUSY') return { ok: false, code: 'database_busy', params: {} }
    console.error(`[api:${m}]`, e)
    return { ok: false, code: 'unknown', params: { message: msg } }
  }
}
