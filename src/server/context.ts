import type { DB } from './db/connection'
import type { SessionUser } from '@shared/types'
import { AppError } from './errors'

export interface Ctx {
  db: DB
  user: SessionUser | null
  now: () => Date
}

export function requireUser(ctx: Ctx): SessionUser {
  if (!ctx.user) throw new AppError('not_logged_in')
  return ctx.user
}

export function requireAdmin(ctx: Ctx): SessionUser {
  const u = requireUser(ctx)
  if (u.role !== 'admin') throw new AppError('admin_only')
  return u
}

export const nowIso = (ctx: Ctx) => ctx.now().toISOString()
