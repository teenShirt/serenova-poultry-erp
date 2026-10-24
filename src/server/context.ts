import type { DB } from './db/connection'
import type { SessionUser } from '@shared/types'
import { AppError } from './errors'

/**
 * Everything a business service works with. Every service is bound to one organization (`org`)
 * and works on one of its farms (`farm`); every query must be limited to them. A service never
 * takes an organization or farm id from the request input.
 */
export interface Ctx {
  db: DB
  /** The organization whose data this request may touch. */
  org: number
  /** The farm (location) this request works on; always a farm of `org`. */
  farm: number
  user: SessionUser | null
  now: () => Date
}

/** For the few flows that happen before an organization is known (sign-in, first-run setup, recovery). */
export interface AnonCtx {
  db: DB
  now: () => Date
}

export function requireUser(ctx: Pick<Ctx, 'user'>): SessionUser {
  if (!ctx.user) throw new AppError('not_logged_in')
  return ctx.user
}

export function requireAdmin(ctx: Pick<Ctx, 'user'>): SessionUser {
  const u = requireUser(ctx)
  if (u.role !== 'admin') throw new AppError('admin_only')
  return u
}

export const nowIso = (ctx: Pick<Ctx, 'now'>) => ctx.now().toISOString()
