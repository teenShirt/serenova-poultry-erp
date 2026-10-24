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

export async function audit(ctx: Ctx, a: AuditInput) {
  await ctx.db
    .prepare(
      `INSERT INTO audit_log (at, user_id, username, action, entity, entity_id, day_id, reason, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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

export async function listAudit(
  ctx: Ctx,
  f: { from?: string; to?: string; entity?: string; search?: string; limit?: number }
): Promise<AuditEntry[]> {
  const where: string[] = []
  const args: unknown[] = []
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
    FROM audit_log a LEFT JOIN farm_days d ON d.id = a.day_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT ?`
  args.push(Math.min(f.limit ?? 500, 5000))
  return (await ctx.db.prepare(sql).all(...args)) as AuditEntry[]
}
