import type { Api, ApiResponse } from '@shared/api'
import { API_KIND } from '@shared/api'
import type { PlatformUser } from '@shared/platform'
import type { AnonCtx } from './context'
import type { Mode } from './databases'
import { latestSchemaVersion } from './db/migrations'
import { AppError } from './errors'
import { schemas } from './schemas'
import type { SessionChange } from './sessions'
import * as platform from './services/platform'
import { today } from './services/subscriptions'

export type PlatformMethod = Extract<keyof Api, `platform.${string}`>

/** What a console request runs with: the signed-in platform administrator, if any. */
export interface PlatformCtx extends AnonCtx {
  mode: Mode
  session: SessionChange
  platformUser: PlatformUser | null
}

type SignedInCtx = PlatformCtx & { platformUser: PlatformUser }
type Handler<M extends PlatformMethod> = (input: Api[M]['in'], ctx: M extends 'platform.status' | 'platform.login' ? PlatformCtx : SignedInCtx) => Promise<Api[M]['out']> | Api[M]['out']
export type PlatformHandlers = { [M in PlatformMethod]: Handler<M> }

const PUBLIC = new Set<PlatformMethod>(['platform.status', 'platform.login'])

export function createPlatformHandlers(version: string): PlatformHandlers {
  return {
    'platform.status': (_, ctx) => ({ user: ctx.platformUser, version, schemaVersion: latestSchemaVersion() }),
    'platform.login': async ({ email, password }, ctx) => {
      const user = await platform.platformLogin(ctx, email, password)
      // A platform session is never also an organization session.
      ctx.session.platformUserId = user.id
      ctx.session.userId = null
      ctx.session.orgId = null
      ctx.session.farmId = null
      ctx.session.rotate = true
      return user
    },
    'platform.logout': async (_, ctx) => {
      await platform.platformAudit(ctx.db, ctx.platformUser, 'platform_logout', null, undefined, ctx.now())
      ctx.session.platformUserId = null
      ctx.session.rotate = true
    },
    'platform.metrics': (_, ctx) => platform.platformMetrics(ctx.db, today(ctx)),
    'platform.organizations': (_, ctx) => platform.listOrganizations(ctx.db, today(ctx)),
    'platform.createOrganization': (i, ctx) => platform.platformCreateOrganization(ctx, ctx.platformUser, i),
    'platform.setOrganizationStatus': ({ id, status, reason }, ctx) => platform.setOrganizationStatus(ctx.db, ctx.platformUser, id, status, reason, ctx.now()),
    'platform.plans': (_, ctx) => platform.listPlans(ctx.db),
    'platform.savePlan': (p, ctx) => platform.savePlan(ctx.db, ctx.platformUser, p),
    'platform.setSubscription': (c, ctx) => platform.setSubscription(ctx.db, ctx.platformUser, c)
  }
}

/** Runs one console request. The console works on the real (not the demonstration) database only. */
export async function dispatchPlatform(handlers: PlatformHandlers, method: string, input: unknown, ctx: PlatformCtx): Promise<ApiResponse<unknown>> {
  if (!Object.prototype.hasOwnProperty.call(handlers, method)) return { ok: false, code: 'unknown_method', params: {} }
  const m = method as PlatformMethod
  const parsed = schemas[m].safeParse(input)
  if (!parsed.success) return { ok: false, code: 'invalid_input', params: { field: parsed.error.issues[0]?.path.join('.') ?? '' } }
  try {
    if (ctx.mode !== 'farm') throw new AppError('not_in_demo')
    if (!PUBLIC.has(m) && !ctx.platformUser) throw new AppError('not_logged_in')
    const run = async () => (handlers[m] as (i: never, c: PlatformCtx) => unknown)(parsed.data as never, ctx)
    const data = API_KIND[m] === 'write' ? await ctx.db.withWriteLock(run) : await run()
    return { ok: true, data }
  } catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, params: e.params }
    console.error(`[platform:${m}]`, e)
    return { ok: false, code: 'unknown', params: { message: (e as Error).message ?? String(e) } }
  }
}
