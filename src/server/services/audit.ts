import type { AuditEntry } from '@shared/types'
import type { Ctx } from '../context'

export interface AuditInput {
  action: string
  entity: string
  entityId?: number | null
  dayId?: number | null
  reason?: string | null
  details?: unknown
}

/** Who may be recorded: an organization's context, or a platform event (org null, e.g. a sign-in with an unknown address). */
type AuditCtx = Pick<Ctx, 'db' | 'now' | 'user'> & { org: number | null }

export async function audit(ctx: AuditCtx, a: AuditInput) {
  await ctx.db
    .prepare(
      `INSERT INTO audit_log (organization_id, at, user_id, username, action, entity, entity_id, day_id, reason, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ctx.org,
      ctx.now().toISOString(),
      ctx.user?.id ?? null,
      ctx.user?.username ?? null,
      a.action,
      a.entity,
      a.entityId ?? null,
      a.dayId ?? null,
      a.reason ?? null,
      a.details === undefined ? null : JSON.stringify(a.details)
    )
}

export async function listAudit(ctx: Ctx, f: { from?: string; to?: string; entity?: string; search?: string; limit?: number }): Promise<AuditEntry[]> {
  const where: string[] = ['a.organization_id = ?']
  const args: unknown[] = [ctx.org]
  if (f.from) {
    where.push('a.at >= ?')
    args.push(f.from)
  }
  if (f.to) {
    where.push('a.at < ?')
    args.push(f.to + 'T99')
  }
  if (f.entity) {
    where.push('a.entity = ?')
    args.push(f.entity)
  }
  if (f.search) {
    where.push('(a.action LIKE ? OR a.reason LIKE ? OR a.username LIKE ? OR a.details LIKE ?)')
    const q = `%${f.search}%`
    args.push(q, q, q, q)
  }
  const sql = `SELECT a.id, a.at, a.username, a.action, a.entity, a.entity_id AS entityId,
      d.business_date AS date, a.reason, a.details
    FROM audit_log a LEFT JOIN farm_days d ON d.id = a.day_id AND d.organization_id = a.organization_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.id DESC LIMIT ?`
  args.push(Math.min(f.limit ?? 500, 5000))
  return (await ctx.db.prepare(sql).all(...args)) as AuditEntry[]
}
