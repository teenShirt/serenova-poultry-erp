import { createHash, randomBytes } from 'node:crypto'
import type { Databases, Mode } from './databases'

export const SESSION_COOKIE = 'pfm_sid'

export interface Session {
  /** SHA-256 of the cookie value; the cookie value itself is never stored. */
  id: string
  userId: number | null
  /** The signed-in user's organization, and the farm they are working on. */
  orgId: number | null
  farmId: number | null
  mode: Mode
  lastSeenAt: string
}

/**
 * What a request wants to change about its session. Handlers set these; the HTTP layer saves
 * them after the request succeeds. Signing in or out always issues a new session id.
 */
export interface SessionChange {
  userId?: number | null
  orgId?: number | null
  farmId?: number | null
  mode?: Mode
  /** Replace the session id (sign-in / sign-out) so an old cookie can never be reused. */
  rotate?: boolean
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** Browser sessions, stored in the farm database (also for visitors looking at the demonstration data). */
export class Sessions {
  constructor(
    private readonly dbs: Databases,
    private readonly idleHours: number
  ) {}

  private expiry(now: Date) {
    return new Date(now.getTime() + this.idleHours * 3600_000).toISOString()
  }

  async find(token: string | undefined, now = new Date()): Promise<Session | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const id = hash(token)
    return this.dbs.with('farm', async (db) => {
      const row = (await db.prepare('SELECT id, user_id, organization_id, farm_id, mode, last_seen_at, expires_at FROM sessions WHERE id = ?').get(id)) as
        | { id: string; user_id: number | null; organization_id: number | null; farm_id: number | null; mode: Mode; last_seen_at: string; expires_at: string }
        | undefined
      if (!row) return null
      if (row.expires_at <= now.toISOString()) {
        await db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
        return null
      }
      return { id: row.id, userId: row.user_id, orgId: row.organization_id, farmId: row.farm_id, mode: row.mode, lastSeenAt: row.last_seen_at }
    })
  }

  /** Creates a session and returns the cookie value. */
  async create(s: Pick<Session, 'userId' | 'orgId' | 'farmId' | 'mode'>, meta: { userAgent?: string; ip?: string }, now = new Date()): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const at = now.toISOString()
    await this.dbs.with('farm', (db) =>
      db
        .prepare('INSERT INTO sessions (id, user_id, organization_id, farm_id, mode, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(hash(token), s.userId, s.orgId, s.farmId, s.mode, at, at, this.expiry(now), meta.userAgent?.slice(0, 255) ?? null, meta.ip?.slice(0, 64) ?? null)
    )
    return token
  }

  async update(id: string, s: Pick<Session, 'userId' | 'orgId' | 'farmId' | 'mode'>, now = new Date()) {
    await this.dbs.with('farm', (db) =>
      db
        .prepare('UPDATE sessions SET user_id = ?, organization_id = ?, farm_id = ?, mode = ?, last_seen_at = ?, expires_at = ? WHERE id = ?')
        .run(s.userId, s.orgId, s.farmId, s.mode, now.toISOString(), this.expiry(now), id)
    )
  }

  /** Extends an active session (at most once a minute, to keep writes down). */
  async touch(s: Session, now = new Date()) {
    if (now.getTime() - Date.parse(s.lastSeenAt) < 60_000) return
    await this.dbs.with('farm', (db) =>
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now.toISOString(), this.expiry(now), s.id)
    )
  }

  async destroy(id: string) {
    await this.dbs.with('farm', (db) => db.prepare('DELETE FROM sessions WHERE id = ?').run(id))
  }

  async purgeExpired(now = new Date()) {
    await this.dbs.with('farm', (db) => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString()))
  }
}
