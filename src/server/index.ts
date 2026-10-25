import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { ApiResponse } from '@shared/api'
import { createPlatformHandlers, dispatchPlatform } from './platform-api'
import { loadPlatformUser } from './services/platform'
import type { PlatformUser } from '@shared/platform'
import { assertModule } from './services/subscriptions'
import { createHandlers, dispatch, loadSessionUser, recordReport, buildReport, sessionFarm, APP_VERSION, type PublicCtx, type RequestCtx } from './api'
import { loadConfig, type ServerConfig } from './config'
import { Databases } from './databases'
import type { DB } from './db/connection'
import { AppError } from './errors'
import { reportSpecSchema } from './schemas'
import { SESSION_COOKIE, Sessions, type Session } from './sessions'
import { RestoreTokens } from './uploads'
import { checkAccess } from './services/duties'
import { getSettings } from './services/settings'
import { applyRetention, createBackup, inspectBackup, isDesktopBackup, lastBackup } from './services/backup'
import { renderXlsx } from './reports/render'
import { buildCsv } from './reports/csv'
import { recordJobFailure } from './jobs'
import { RateLimiter } from './rate-limit'
import { configProblems } from './config'
import { currentSchemaVersion, latestSchemaVersion } from './db/migrations'
import { restoreTestDue, runRestoreTest } from './services/restore-test'
import { audit } from './services/audit'

const RATE_LIMITED = new Set(['auth.login', 'platform.login', 'auth.signup', 'auth.resetWithCode', 'setup.complete'])
import { CSV_KINDS, type CsvKind } from '@shared/overview'
import { addDays, isIsoDate } from '@shared/dates'
import { requirePermission } from './services/roles'

const here = path.dirname(fileURLToPath(import.meta.url))
// Works both from the source tree (src/server) and from the build (dist/server).
const projectRoot = path.resolve(here, '..', '..')

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

export async function createServer(cfg: ServerConfig) {
  const problems = configProblems(cfg)
  if (problems.length) throw new Error(`Unsafe settings for a ${cfg.environment} server:\n - ${problems.join('\n - ')}`)
  const dbs = await Databases.open(cfg)
  const authLimiter = new RateLimiter(cfg.authRequestsPerMinute)
  const sessions = new Sessions(dbs, cfg.sessionIdleHours)
  const restoreTokens = new RestoreTokens()
  const handlers = createHandlers({ cfg, dbs, restoreTokens })
  const platformHandlers = createPlatformHandlers(APP_VERSION, cfg.backupDir, {
    environment: cfg.environment,
    releaseSha: cfg.releaseSha,
    securityEvents: () => authLimiter.refused,
    changelogPath: path.join(projectRoot, 'CHANGELOG.md')
  })

  const cookie = (req: Request, value: string | null) => {
    const secure = cfg.secureCookies || req.secure ? '; Secure' : ''
    return value === null
      ? `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
      : `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(cfg.sessionIdleHours * 3600)}${secure}`
  }

  /** Saves what the request changed about its browser session (sign-in, sign-out, demonstration mode). */
  async function saveSession(req: Request, res: Response, current: Session | null, ctx: PublicCtx) {
    const change = ctx.session
    if (!('userId' in change) && !('orgId' in change) && !('farmId' in change) && !('platformUserId' in change) && !change.mode && !change.rotate) {
      if (current) await sessions.touch(current)
      return
    }
    const pick = <K extends 'userId' | 'orgId' | 'farmId' | 'platformUserId'>(k: K) => (k in change ? (change[k] ?? null) : (current?.[k] ?? null))
    const next = {
      userId: pick('userId'),
      orgId: pick('orgId'),
      farmId: pick('farmId'),
      platformUserId: pick('platformUserId'),
      mode: change.mode ?? current?.mode ?? 'farm'
    }
    if (current && !change.rotate) {
      await sessions.update(current.id, next)
      return
    }
    if (current) await sessions.destroy(current.id)
    if (next.userId === null && next.platformUserId === null && next.mode === 'farm') {
      res.setHeader('Set-Cookie', cookie(req, null))
      return
    }
    const token = await sessions.create(next, { userAgent: req.get('user-agent'), ip: req.ip })
    res.setHeader('Set-Cookie', cookie(req, token))
  }

  /**
   * Runs `fn` with the request's database (farm or demonstration), signed-in user, and the
   * organization and farm from the session. The browser never chooses the organization.
   */
  async function withRequest<T>(
    req: Request,
    res: Response,
    fn: (ctx: PublicCtx, platformUser: PlatformUser | null) => Promise<T>,
    keepSession?: (result: T) => boolean
  ): Promise<T> {
    const session = await sessions.find(readCookie(req, SESSION_COOKIE))
    const mode = session?.mode === 'demo' && dbs.demoAvailable ? 'demo' : 'farm'
    return dbs.with(mode, async (db) => {
      const user = await loadSessionUser({ db }, session?.userId ?? null, session?.orgId ?? null)
      const org = user ? session!.orgId : null
      const farm = org !== null ? await sessionFarm({ db }, org, session?.farmId ?? null) : null
      // Platform administrators sign in to the console on the real database only.
      const platformUser = mode === 'farm' ? await loadPlatformUser(db, session?.platformUserId ?? null) : null
      const ctx: PublicCtx = { db, user, org, farm, now: () => new Date(), mode, session: {} }
      const result = await fn(ctx, platformUser)
      if (!keepSession || keepSession(result)) await saveSession(req, res, session, ctx)
      return result
    })
  }

  /** Like withRequest, for a signed-in user only: the context is bound to their organization and farm. */
  async function withSignedIn<T>(req: Request, res: Response, fn: (ctx: RequestCtx) => Promise<T>): Promise<T> {
    return withRequest(req, res, async (ctx) => {
      if (!ctx.user || ctx.org === null || ctx.farm === null) throw new AppError('not_logged_in')
      return fn({ ...ctx, org: ctx.org, farm: ctx.farm })
    })
  }

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', cfg.trustProxy)

  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'same-origin')
    // Browsers keep to HTTPS for a year once they have seen it served securely.
    if (cfg.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
    next()
  })

  // Liveness: the process answers. Readiness: the database answers and is at this release's schema.
  // Neither shows anything private (used by the deployment's checks and by monitoring).
  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ status: 'ok' })
  })
  app.get('/readyz', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const base = { version: APP_VERSION, release: cfg.releaseSha, environment: cfg.environment, expectedSchema: latestSchemaVersion() }
    try {
      const schema = await dbs.with('farm', (db) => currentSchemaVersion(db))
      const ready = schema === latestSchemaVersion()
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'schema_mismatch', schema, ...base })
    } catch {
      res.status(503).json({ status: 'database_unavailable', ...base })
    }
  })

  // Data-changing requests must come from the app's own pages: browsers will not send this header
  // cross-site without permission (and the session cookie is SameSite), which blocks request forgery.
  const sameOrigin = (req: Request, res: Response, next: NextFunction) => {
    if (req.get('x-requested-with') !== 'pfm') {
      res.status(403).json({ ok: false, code: 'forbidden', params: {} })
      return
    }
    next()
  }

  app.post('/api/call/:method', sameOrigin, express.json({ limit: '2mb' }), async (req, res) => {
    const input = (req.body as { input?: unknown } | undefined)?.input
    const method = String(req.params['method'])
    // Sign-in, sign-up, password reset and first-run setup: a limited number of tries per minute from one address.
    if (RATE_LIMITED.has(method)) {
      const wait = authLimiter.hit(`${req.ip ?? 'unknown'}:${method}`)
      if (wait > 0) {
        res.status(429).setHeader('Retry-After', String(wait))
        res.json({ ok: false, code: 'too_many_attempts', params: { seconds: wait } })
        return
      }
    }
    const out = await withRequest<ApiResponse<unknown>>(
      req,
      res,
      (ctx, platformUser) =>
        method.startsWith('platform.')
          ? dispatchPlatform(platformHandlers, method, input, { db: ctx.db, now: ctx.now, mode: ctx.mode, session: ctx.session, platformUser })
          : dispatch(handlers, method, input, ctx),
      (r) => r.ok
    )
    res.setHeader('Cache-Control', 'no-store')
    res.json(out)
  })

  // Excel report download. PDF reports are printed (or saved as PDF) by the browser from reports.print.
  app.get('/api/reports/download', async (req, res) => {
    let raw: unknown = null
    try {
      raw = JSON.parse(String(req.query['spec'] ?? 'null'))
    } catch {
      /* rejected below */
    }
    const spec = reportSpecSchema.safeParse(raw)
    if (!spec.success) throw new AppError('invalid_input', { field: 'spec' })
    const file = await withSignedIn(req, res, async (ctx) => {
      await checkAccess(ctx, 'reports.preview', spec.data)
      requirePermission(ctx, 'reports.export')
      await assertModule(ctx, 'exports')
      const model = await buildReport(ctx, spec.data)
      const data = await renderXlsx(model, (await getSettings(ctx)).language)
      await recordReport(ctx, spec.data, 'xlsx', `${model.fileStem}.xlsx`)
      await audit(ctx, { action: 'export', entity: 'report', details: { format: 'xlsx', ...spec.data } })
      return { name: `${model.fileStem}.xlsx`, data }
    })
    res.attachment(file.name)
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.send(file.data)
  })

  // CSV downloads: reports, stock movements, receipts and tasks (who may export, and the plan's Excel/CSV module).
  app.get('/api/export/:kind', async (req, res) => {
    const kind = String(req.params['kind'])
    const q = (k: string) => String(req.query[k] ?? '')
    if (
      !(CSV_KINDS as readonly string[]).includes(kind) ||
      !isIsoDate(q('from')) ||
      !isIsoDate(q('to')) ||
      q('from') > q('to') ||
      q('from') < addDays(q('to'), -400)
    ) {
      throw new AppError('invalid_input', { field: 'kind' })
    }
    const out = await withSignedIn(req, res, async (ctx) => {
      requirePermission(ctx, 'reports.export')
      await assertModule(ctx, 'exports')
      if (kind === 'tasks') requirePermission(ctx, 'tasks.manage')
      if (kind === 'organization') requirePermission(ctx, 'reports.view')
      const warehouseId = Number(q('warehouseId')) || null
      const csv = await buildCsv(ctx, kind as CsvKind, q('from'), q('to'), { warehouseId })
      await audit(ctx, { action: 'export', entity: 'report', details: { format: 'csv', kind, from: q('from'), to: q('to'), warehouseId } })
      return csv
    })
    res.attachment(`${out.name}.csv`)
    res.type('text/csv; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.send(out.csv)
  })

  // A backup contains every record of the organization (including password hashes), so only its
  // administrators may download it; whole-database backups never leave the server this way.
  app.get('/api/backup/download/:id', async (req, res) => {
    const file = await withSignedIn(req, res, async (ctx) => {
      requirePermission(ctx, 'backup.restore')
      if (ctx.mode === 'demo') throw new AppError('demo_mode_blocked')
      const row = (await ctx.db
        .prepare("SELECT path FROM backup_runs WHERE id = ? AND organization_id = ? AND status = 'ok'")
        .get(Number(req.params['id']), ctx.org)) as { path: string } | undefined
      const p = row?.path ? path.resolve(row.path) : null
      if (!p || path.dirname(p) !== path.resolve(cfg.backupDir) || !fs.existsSync(p)) throw new AppError('file_not_allowed')
      await audit(ctx, { action: 'download_backup', entity: 'backup', details: { file: path.basename(p) } })
      return p
    })
    res.download(file, path.basename(file))
  })

  // Upload one of the organization's own backups to restore it. (Desktop-edition backups are
  // imported with `npm run import-sqlite`, which also gives each account an email address.)
  app.post('/api/backup/upload', sameOrigin, express.raw({ type: () => true, limit: `${cfg.maxUploadMb}mb` }), async (req, res) => {
    const name = String(req.query['name'] ?? 'backup').slice(0, 200)
    const out = await withSignedIn(req, res, async (ctx) => {
      requirePermission(ctx, 'backup.restore')
      if (ctx.mode === 'demo') throw new AppError('demo_mode_blocked')
      const tmp = path.join(os.tmpdir(), `pfm-upload-${randomUUID()}`)
      fs.writeFileSync(tmp, req.body as Buffer)
      const { data, ...check } = await inspectBackup(tmp, name)
      if (check.ok && data && isDesktopBackup(data)) Object.assign(check, { ok: false, error: 'desktop_backup_use_import' })
      else if (check.ok && data?.scope !== 'organization') Object.assign(check, { ok: false, error: 'not_an_organization_backup' })
      if (!check.ok) {
        fs.rmSync(tmp, { force: true })
        return { ...check, token: '' }
      }
      return { ...check, token: restoreTokens.add({ file: tmp, name, userId: ctx.user!.id, data }) }
    })
    res.json({ ok: true, data: out })
  })

  app.use('/manuals', express.static(path.join(projectRoot, 'resources', 'manuals'), { index: false }))

  const clientDir = path.join(projectRoot, 'dist', 'client')
  if (fs.existsSync(clientDir)) {
    app.use(
      express.static(clientDir, { index: false, maxAge: '7d', setHeaders: (res, p) => p.endsWith('.html') && res.setHeader('Cache-Control', 'no-cache') })
    )
    app.get('/', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(path.join(clientDir, 'index.html'))
    })
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res
        .status(err.code === 'not_logged_in' || err.code === 'admin_only' || err.code === 'no_permission' ? 403 : 400)
        .json({ ok: false, code: err.code, params: err.params })
      return
    }
    const e = err as { type?: string; message?: string }
    if (e.type === 'entity.too.large') {
      res.status(413).json({ ok: false, code: 'file_too_large', params: { mb: cfg.maxUploadMb } })
      return
    }
    console.error('[http]', err)
    res.status(500).json({ ok: false, code: 'unknown', params: { message: e.message ?? String(err) } })
  })

  const timers = startSchedulers(cfg, dbs, sessions)
  return {
    app,
    dbs,
    async close() {
      for (const t of timers) clearInterval(t)
      await dbs.close()
    }
  }
}

/** Whole-database backups for the platform (all organizations): one a day, the last 14 kept. */
const PLATFORM_BACKUP_HOURS = 24
const PLATFORM_BACKUP_KEEP = 14
/** How often the newest whole-database backup is test-restored (when RESTORE_TEST_DB_NAME is set). */
const RESTORE_TEST_DAYS = 7

/**
 * Automatic backups: each organization's records on its own schedule (Backup settings), plus a daily
 * backup of the whole database for the platform owner. And clean-up of expired sessions.
 */
function startSchedulers(cfg: ServerConfig, dbs: Databases, sessions: Sessions) {
  const due = async (db: DB, orgId: number | null, hours: number) => {
    const last = (await db
      .prepare("SELECT created_at FROM backup_runs WHERE organization_id <=> ? AND kind = 'auto' AND status = 'ok' ORDER BY id DESC LIMIT 1")
      .get(orgId)) as { created_at: string } | undefined
    if (last && Date.now() - Date.parse(last.created_at) < hours * 3600_000) return false
    // After a failure, retry at most every 30 minutes.
    const attempt = await lastBackup(db, orgId, 'auto')
    return !(attempt?.status === 'failed' && Date.now() - Date.parse(attempt.createdAt) < 30 * 60_000)
  }
  const backupTick = () =>
    dbs.with('farm', async (db) => {
      // Only one server process makes the automatic backups.
      const [got] = (await db.query("SELECT GET_LOCK('pfm_auto_backup', 0) AS got")) as { got: number }[]
      if (got?.got !== 1) return
      try {
        const orgs = (await db.prepare("SELECT id, code FROM organizations WHERE status = 'active' ORDER BY id").all()) as { id: number; code: string }[]
        for (const o of orgs) {
          const s = await getSettings({ db, org: o.id })
          if (!s.backupEnabled || !(await due(db, o.id, s.backupIntervalHours))) continue
          const info = await createBackup(db, cfg.backupDir, 'auto', { orgId: o.id })
          if (info.status === 'ok') applyRetention(cfg.backupDir, s.backupRetention, o.code)
          else recordJobFailure(`Automatic backup of ${o.code}`, new Error(info.message ?? 'failed'))
        }
        if (orgs.length && (await due(db, null, PLATFORM_BACKUP_HOURS))) {
          const info = await createBackup(db, cfg.backupDir, 'auto', { orgId: null })
          if (info.status === 'ok') applyRetention(cfg.backupDir, PLATFORM_BACKUP_KEEP, 'all')
          // Once a week the newest whole-database backup is test-restored into the separate restore-test database.
          if (info.status === 'ok' && cfg.restoreTestDatabase && (await restoreTestDue(db, RESTORE_TEST_DAYS))) {
            const r = await runRestoreTest(db, cfg)
            if (r.status !== 'ok') recordJobFailure('Restore test', new Error(r.problems.join('; ')))
          } else recordJobFailure('Automatic whole-database backup', new Error(info.message ?? 'failed'))
        }
      } finally {
        await db.query("SELECT RELEASE_LOCK('pfm_auto_backup')")
      }
    })
  const safely = (name: string, fn: () => Promise<unknown>) => () => {
    fn().catch((e: unknown) => recordJobFailure(name, e))
  }
  setTimeout(safely('Automatic backup', backupTick), 60_000).unref()
  return [
    setInterval(safely('Automatic backup', backupTick), 10 * 60_000).unref(),
    setInterval(
      safely('Session clean-up', () => sessions.purgeExpired()),
      60 * 60_000
    ).unref()
  ]
}

async function main() {
  const cfg = loadConfig()
  const server = await createServer(cfg)
  const http = server.app.listen(cfg.port, cfg.host, () => {
    console.log(
      `Poultry Farm Manager ${APP_VERSION} (${cfg.environment}${cfg.releaseSha ? ', ' + cfg.releaseSha.slice(0, 7) : ''}) — http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`
    )
    console.log(`Farm data: ${server.dbs.location('farm')} · backups: ${cfg.backupDir}`)
  })
  const stop = () => {
    http.close()
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    const msg = (e as Error).message ?? String(e)
    console.error(
      msg.startsWith('DATABASE_TOO_NEW')
        ? 'The farm database was created by a newer version of Poultry Farm Manager. Please install the latest version.'
        : `Could not start Poultry Farm Manager: ${msg}`
    )
    process.exit(1)
  })
}
