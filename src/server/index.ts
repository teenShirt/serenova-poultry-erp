import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { ApiResponse } from '@shared/api'
import { createHandlers, dispatch, loadSessionUser, recordReport, buildReport, APP_VERSION, type RequestCtx } from './api'
import { loadConfig, type ServerConfig } from './config'
import { Databases } from './databases'
import { AppError } from './errors'
import { reportSpecSchema } from './schemas'
import { SESSION_COOKIE, Sessions, type Session } from './sessions'
import { RestoreTokens } from './uploads'
import { requireAdmin, requireUser } from './context'
import { checkAccess } from './services/duties'
import { getSettings } from './services/settings'
import { applyRetention, createBackup, inspectBackup, lastBackup } from './services/backup'
import { renderXlsx } from './reports/render'

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
  const dbs = await Databases.open(cfg)
  const sessions = new Sessions(dbs, cfg.sessionIdleHours)
  const restoreTokens = new RestoreTokens()
  const handlers = createHandlers({ cfg, dbs, restoreTokens })

  const cookie = (req: Request, value: string | null) => {
    const secure = cfg.secureCookies || req.secure ? '; Secure' : ''
    return value === null
      ? `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
      : `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(cfg.sessionIdleHours * 3600)}${secure}`
  }

  /** Saves what the request changed about its browser session (sign-in, sign-out, demonstration mode). */
  async function saveSession(req: Request, res: Response, current: Session | null, ctx: RequestCtx) {
    const change = ctx.session
    if (!('userId' in change) && !change.mode && !change.rotate) {
      if (current) await sessions.touch(current)
      return
    }
    const userId = 'userId' in change ? (change.userId ?? null) : (current?.userId ?? null)
    const mode = change.mode ?? current?.mode ?? 'farm'
    if (current && !change.rotate) {
      await sessions.update(current.id, userId, mode)
      return
    }
    if (current) await sessions.destroy(current.id)
    if (userId === null && mode === 'farm') {
      res.setHeader('Set-Cookie', cookie(req, null))
      return
    }
    const token = await sessions.create(userId, mode, { userAgent: req.get('user-agent'), ip: req.ip })
    res.setHeader('Set-Cookie', cookie(req, token))
  }

  /** Runs `fn` with the request's database (farm or demonstration) and signed-in user. */
  async function withRequest<T>(req: Request, res: Response, fn: (ctx: RequestCtx) => Promise<T>, keepSession?: (result: T) => boolean): Promise<T> {
    const session = await sessions.find(readCookie(req, SESSION_COOKIE))
    const mode = session?.mode === 'demo' && dbs.demoAvailable ? 'demo' : 'farm'
    return dbs.with(mode, async (db) => {
      const user = await loadSessionUser({ db }, session?.userId ?? null)
      const ctx: RequestCtx = { db, user, now: () => new Date(), mode, session: {} }
      const result = await fn(ctx)
      if (!keepSession || keepSession(result)) await saveSession(req, res, session, ctx)
      return result
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
    next()
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
    const out = await withRequest<ApiResponse<unknown>>(req, res, (ctx) => dispatch(handlers, String(req.params['method']), input, ctx), (r) => r.ok)
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
    const file = await withRequest(req, res, async (ctx) => {
      requireUser(ctx)
      await checkAccess(ctx, 'reports.preview', spec.data)
      const model = await buildReport(ctx, spec.data)
      const data = await renderXlsx(model, (await getSettings(ctx)).language)
      await recordReport(ctx, spec.data, 'xlsx', `${model.fileStem}.xlsx`)
      return { name: `${model.fileStem}.xlsx`, data }
    })
    res.attachment(file.name)
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.send(file.data)
  })

  // A backup contains every record (including password hashes), so only administrators may download one.
  app.get('/api/backup/download/:id', async (req, res) => {
    const file = await withRequest(req, res, async (ctx) => {
      requireAdmin(ctx)
      if (ctx.mode === 'demo') throw new AppError('demo_mode_blocked')
      const row = (await ctx.db.prepare("SELECT path FROM backup_runs WHERE id = ? AND status = 'ok'").get(Number(req.params['id']))) as
        | { path: string }
        | undefined
      const p = row?.path ? path.resolve(row.path) : null
      if (!p || path.dirname(p) !== path.resolve(cfg.backupDir) || !fs.existsSync(p)) throw new AppError('file_not_allowed')
      return p
    })
    res.download(file, path.basename(file))
  })

  // Upload a backup (from this web app or from the desktop edition) to restore it.
  app.post('/api/backup/upload', sameOrigin, express.raw({ type: () => true, limit: `${cfg.maxUploadMb}mb` }), async (req, res) => {
    const name = String(req.query['name'] ?? 'backup').slice(0, 200)
    const out = await withRequest(req, res, async (ctx) => {
      requireAdmin(ctx)
      if (ctx.mode === 'demo') throw new AppError('demo_mode_blocked')
      const tmp = path.join(os.tmpdir(), `pfm-upload-${randomUUID()}`)
      fs.writeFileSync(tmp, req.body as Buffer)
      const { data, ...check } = await inspectBackup(tmp, name)
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
    app.use(express.static(clientDir, { index: false, maxAge: '7d', setHeaders: (res, p) => p.endsWith('.html') && res.setHeader('Cache-Control', 'no-cache') }))
    app.get('/', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(path.join(clientDir, 'index.html'))
    })
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.code === 'not_logged_in' || err.code === 'admin_only' || err.code === 'no_permission' ? 403 : 400).json({ ok: false, code: err.code, params: err.params })
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

/** Automatic backups of the farm database, and clean-up of expired sessions. */
function startSchedulers(cfg: ServerConfig, dbs: Databases, sessions: Sessions) {
  const backupTick = () =>
    dbs.with('farm', async (db) => {
      const s = await getSettings({ db })
      if (!s.backupEnabled || !s.setupComplete) return
      const last = (await db
        .prepare("SELECT created_at FROM backup_runs WHERE kind = 'auto' AND status = 'ok' ORDER BY id DESC LIMIT 1")
        .get()) as { created_at: string } | undefined
      const due = !last || Date.now() - Date.parse(last.created_at) >= s.backupIntervalHours * 3600_000
      if (!due) return
      const lastAttempt = await lastBackup(db, 'auto')
      // After a failure, retry at most every 30 minutes.
      if (lastAttempt?.status === 'failed' && Date.now() - Date.parse(lastAttempt.createdAt) < 30 * 60_000) return
      // Only one server process makes the automatic backup.
      const [got] = (await db.query("SELECT GET_LOCK('pfm_auto_backup', 0) AS got")) as { got: number }[]
      if (got?.got !== 1) return
      try {
        const info = await createBackup(db, cfg.backupDir, 'auto')
        if (info.status === 'ok') applyRetention(cfg.backupDir, s.backupRetention)
        else console.error('Automatic backup failed:', info.message)
      } finally {
        await db.query("SELECT RELEASE_LOCK('pfm_auto_backup')")
      }
    })
  const safely = (name: string, fn: () => Promise<unknown>) => () => {
    fn().catch((e: unknown) => console.error(`${name} failed:`, e))
  }
  setTimeout(safely('Automatic backup', backupTick), 60_000).unref()
  return [
    setInterval(safely('Automatic backup', backupTick), 10 * 60_000).unref(),
    setInterval(safely('Session clean-up', () => sessions.purgeExpired()), 60 * 60_000).unref()
  ]
}

async function main() {
  const cfg = loadConfig()
  const server = await createServer(cfg)
  const http = server.app.listen(cfg.port, cfg.host, () => {
    console.log(`Poultry Farm Manager ${APP_VERSION} — http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`)
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
