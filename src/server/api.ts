import fs from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import type { Api, ApiMethod, ApiResponse, ReportSpec } from '@shared/api'
import { API_KIND } from '@shared/api'
import { addDays } from '@shared/dates'
import type { AppStatus, SessionUser } from '@shared/types'
import { requireAdmin, requireUser, type Ctx } from './context'
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
import { getSettings, saveSettings } from './services/settings'
import { completeSetup } from './services/setup'
import { DEMO_USERS } from './services/demo'
import { createBackup, lastBackup, listBackupRuns, restoreData } from './services/backup'
import { dayReport, periodReport, type ReportModel } from './reports/model'
import { renderHtml } from './reports/render'
import { accessFromRow, checkAccess, dutyTasks, setUserDuties } from './services/duties'
import { listParties, saveParty } from './services/parties'
import { cancelReceipt, createReceipt, listReceipts } from './services/purchases'
import * as sales from './services/sales'
import { flowSummary, purchasesSeries } from './services/supply'
import * as adminSvc from './services/admin'
import type { RestoreTokens } from './uploads'

export const APP_VERSION = '2.0.0'

/** Everything a handler may need besides its input: the request's database session and its browser session. */
export interface RequestCtx extends Ctx {
  mode: Mode
  /** Changes to the browser session, applied by the HTTP layer once the request has succeeded. */
  session: SessionChange
}

export interface ApiDeps {
  cfg: ServerConfig
  dbs: Databases
  restoreTokens: RestoreTokens
}

type Handler<M extends ApiMethod> = (input: Api[M]['in'], ctx: RequestCtx) => Promise<Api[M]['out']> | Api[M]['out']
type Handlers = { [M in ApiMethod]: Handler<M> }

/** Methods callable before signing in. Everything else requires a signed-in user. */
const PUBLIC = new Set<ApiMethod>(['app.status', 'app.setLanguage', 'auth.signup', 'auth.resetWithCode', 'setup.complete', 'demo.enter', 'demo.exit', 'demo.reset', 'auth.login'])

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
    .prepare('INSERT INTO report_runs (kind, period_start, period_end, format, file_path, generated_by, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(spec.kind, from, to, format, fileName, ctx.user?.id ?? null, ctx.now().toISOString())
}

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Loads the signed-in user afresh on every request, so a disabled account or changed role takes effect at once. */
export async function loadSessionUser(ctx: Pick<Ctx, 'db'>, userId: number | null): Promise<SessionUser | null> {
  if (!userId) return null
  const row = (await ctx.db
    .prepare('SELECT id, username, display_name, role, active, pending, duties, assigned_cages FROM users WHERE id = ?')
    .get(userId)) as
    | { id: number; username: string; display_name: string; role: 'admin' | 'operator'; active: number; pending: number; duties: string | null; assigned_cages: string | null }
    | undefined
  if (!row || !row.active || row.pending) return null
  const access = accessFromRow(row)
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, duties: access.duties, cages: access.cages }
}

export function createHandlers({ cfg, dbs, restoreTokens }: ApiDeps): Handlers {
  const status = async (ctx: RequestCtx): Promise<AppStatus> => {
    const settings = await getSettings(ctx)
    const lastAuto = ctx.mode === 'farm' ? await lastBackup(ctx.db, 'auto') : undefined
    const demoExists = dbs.demoAvailable ? await dbs.with('demo', async (db) => (await auth.countUsers({ db })) > 0) : false
    return {
      setupComplete: (await auth.countUsers(ctx)) > 0,
      setupKeyRequired: !!cfg.setupKey,
      isDemo: ctx.mode === 'demo',
      demoAvailable: dbs.demoAvailable,
      demoExists,
      user: ctx.user,
      settings,
      version: APP_VERSION,
      dataDir: dbs.location(ctx.mode),
      today: await days.farmToday(ctx),
      backupWarning: lastAuto && lastAuto.status === 'failed' ? lastAuto.message : null,
      pendingSignups: ctx.user?.role === 'admin' ? await auth.countPendingSignups(ctx) : 0
    }
  }

  return {
    'app.status': (_, ctx) => status(ctx),
    'app.setLanguage': async ({ language }, ctx) => {
      // The language is a farm-wide setting: only a signed-in user may change it (or anyone during first-run setup).
      if (!ctx.user && (await auth.countUsers(ctx)) > 0) throw new AppError('not_logged_in')
      await saveSettings(ctx, { language })
    },
    'setup.complete': async ({ setupKey, ...input }, ctx) => {
      if (ctx.mode === 'demo') throw new AppError('not_in_demo')
      if (cfg.setupKey && !sameSecret(setupKey ?? '', cfg.setupKey)) throw new AppError('invalid_setup_key')
      return { recoveryCode: (await completeSetup(ctx, input)).recoveryCode }
    },
    'demo.enter': async (_, ctx) => {
      if (ctx.user) throw new AppError('demo_only_in_setup')
      if (!dbs.demoAvailable) throw new AppError('demo_unavailable')
      const empty = await dbs.with('demo', async (db) => (await auth.countUsers({ db })) === 0)
      if (empty) await dbs.resetDemo()
      ctx.session.mode = 'demo'
      ctx.session.userId = null
      return { username: DEMO_USERS.admin.username, password: DEMO_USERS.admin.password }
    },
    'demo.exit': (_, ctx) => {
      ctx.session.mode = 'farm'
      ctx.session.userId = null
      ctx.session.rotate = true
    },
    'demo.reset': async (_, ctx) => {
      // Only ever touches the separate demonstration database.
      if (ctx.mode !== 'demo') throw new AppError('not_in_demo')
      await dbs.resetDemo()
      ctx.session.userId = null
    },

    'auth.login': async ({ username, password }, ctx) => {
      const user = await auth.login(ctx, username, password)
      ctx.session.userId = user.id
      ctx.session.rotate = true
      return user
    },
    'auth.logout': async (_, ctx) => {
      await audit(ctx, { action: 'logout', entity: 'user', entityId: ctx.user?.id })
      ctx.session.userId = null
      ctx.session.rotate = true
    },
    'auth.changePassword': ({ current, next }, ctx) => auth.changeOwnPassword(ctx, current, next),
    'auth.signup': (u, ctx) => auth.signup(ctx, u),
    'auth.resetWithCode': ({ username, recoveryCode, newPassword }, ctx) => auth.resetWithRecoveryCode(ctx, username, recoveryCode, newPassword),
    'auth.newRecoveryCode': ({ password }, ctx) => auth.newOwnRecoveryCode(ctx, password),
    'users.list': (_, ctx) => auth.listUsers(ctx),
    'users.create': (u, ctx) => auth.createUser(ctx, u),
    'users.update': (u, ctx) => auth.updateUser(ctx, u),
    'users.resetPassword': ({ id, password }, ctx) => auth.resetPassword(ctx, id, password),
    'users.approve': ({ id, role }, ctx) => auth.approveSignup(ctx, id, role),
    'users.reject': ({ id }, ctx) => auth.rejectSignup(ctx, id),
    'users.newRecoveryCode': ({ id }, ctx) => auth.adminNewRecoveryCode(ctx, id),

    'settings.get': (_, ctx) => getSettings(ctx),
    'settings.save': async (patch, ctx) => {
      requireAdmin(ctx)
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
    'medicine.healthEvents': ({ from, to, cageId }, ctx) => medicine.listHealthEvents(ctx, from, to, cageId),
    'medicine.addHealthEvent': (h, ctx) => medicine.addHealthEvent(ctx, h),
    'medicine.deleteHealthEvent': ({ id, reason }, ctx) => medicine.deleteHealthEvent(ctx, id, reason),

    'inventory.items': ({ category }, ctx) => inventory.listItems(ctx, category),
    'inventory.createItem': (i, ctx) => inventory.createItem(ctx, i),
    'inventory.updateItem': ({ id, item }, ctx) => inventory.updateItem(ctx, id, item),
    'inventory.balances': ({ category }, ctx) => inventory.balances(ctx, category),
    'inventory.batches': (f, ctx) => inventory.listBatches(ctx, f),
    'inventory.txns': (f, ctx) => inventory.listTxns(ctx, f),
    'inventory.record': (t, ctx) => inventory.recordTxn(ctx, t),

    'analytics.dashboard': async ({ date }, ctx) => {
      const d = await analytics.dashboard(ctx, date, ctx.mode === 'demo', (await status(ctx)).backupWarning)
      const pending = ctx.user?.role === 'admin' ? await auth.countPendingSignups(ctx) : 0
      if (pending > 0) d.alerts.unshift({ code: 'pending_signups', severity: 'info', params: { count: pending } })
      return d
    },
    'analytics.series': ({ from, to, cageId }, ctx) => analytics.dailySeries(ctx, from, to, cageId),
    'analytics.comparison': ({ from, to }, ctx) => analytics.cageComparison(ctx, from, to),

    'audit.list': (f, ctx) => {
      requireAdmin(ctx)
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
    'users.setDuties': ({ id, duties, cages }, ctx) => setUserDuties(ctx, id, duties, cages),

    'parties.list': ({ kind }, ctx) => listParties(ctx, kind),
    'parties.saveSupplier': (p, ctx) => saveParty(ctx, 'supplier', p),
    'parties.saveCustomer': (p, ctx) => saveParty(ctx, 'customer', p),
    'purchases.list': ({ from, to }, ctx) => listReceipts(ctx, from, to),
    'purchases.create': (r, ctx) => createReceipt(ctx, r),
    'purchases.cancel': ({ id, reason }, ctx) => cancelReceipt(ctx, id, reason),
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

    'backup.list': (_, ctx) => listBackupRuns(ctx.db),
    'backup.create': async (_, ctx) => {
      if (ctx.mode === 'demo') throw new AppError('demo_mode_blocked')
      requireUser(ctx)
      const info = await createBackup(ctx.db, cfg.backupDir, 'manual')
      await audit(ctx, { action: 'backup', entity: 'backup', details: { path: info.path, status: info.status, message: info.message } })
      if (info.status === 'failed') throw new AppError('backup_failed', { message: info.message ?? '' })
      return info
    },
    'backup.restore': async ({ token }, ctx) => {
      if (ctx.mode === 'demo') throw new AppError('demo_mode_blocked')
      requireAdmin(ctx)
      const upload = restoreTokens.take(token, ctx.user!.id)
      if (!upload?.data) throw new AppError('file_not_allowed')
      try {
        // Safety copy of the current data first.
        const safety = await createBackup(ctx.db, cfg.backupDir, 'pre_restore')
        if (safety.status !== 'ok') throw new AppError('backup_failed', { message: safety.message ?? '' })
        await audit(ctx, { action: 'restore', entity: 'backup', details: { from: upload.name, safetyBackup: safety.path } })
        try {
          await restoreData(ctx.db, upload.data)
        } catch (e) {
          throw new AppError('restore_failed', { message: (e as Error).message })
        }
        // The restored data has its own users, so whoever restored it is signed out (as is everyone else).
        await audit({ ...ctx, user: null }, { action: 'restored_from_backup', entity: 'backup', details: { from: upload.name, safetyBackup: safety.path } })
        ctx.session.userId = null
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
export async function dispatch(handlers: Handlers, method: string, input: unknown, ctx: RequestCtx): Promise<ApiResponse<unknown>> {
  if (!Object.prototype.hasOwnProperty.call(handlers, method)) return { ok: false, code: 'unknown_method', params: {} }
  const m = method as ApiMethod
  const parsed = schemas[m].safeParse(input)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? ''
    return { ok: false, code: 'invalid_input', params: { field } }
  }
  try {
    const run = async () => {
      if (!PUBLIC.has(m)) {
        requireUser(ctx)
        await checkAccess(ctx, m, parsed.data)
      }
      return (handlers[m] as Handler<ApiMethod>)(parsed.data as never, ctx)
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
