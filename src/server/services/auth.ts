import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Role, SessionUser, UserRow } from '@shared/types'
import { type Ctx, requireAdmin, requireUser } from '../context'
import { AppError, assert } from '../errors'
import { audit } from './audit'
import { accessFromRow } from './duties'
import { getSettings } from './settings'

const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

/** Wrong passwords or recovery codes allowed before an account is locked for LOCK_MINUTES. */
export const MAX_ATTEMPTS = 5
export const LOCK_MINUTES = 15

/** Stored as scrypt$N$r$p$salt$hash: a salted, memory-hard password hash. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P })
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$')
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p)
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function validatePassword(pw: string) {
  assert(pw.length >= 6, 'password_too_short')
}

// Recovery codes avoid look-alike characters (no I, L, O, 0, 1) so they can be copied by hand.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateRecoveryCode(): string {
  const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)])
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join('')).join('-')
}

/** Accepts the code typed with or without dashes/spaces, in any letter case. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Gives the user a new recovery code (replacing any previous one) and returns it in plain text once. */
async function issueRecoveryCode(ctx: Ctx, userId: number): Promise<string> {
  const code = generateRecoveryCode()
  await ctx.db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?').run(hashPassword(normalizeRecoveryCode(code)), userId)
  return code
}

const userCols = `id, username, display_name AS displayName, role, active, pending, recovery_hash IS NOT NULL AS hasRecoveryCode,
  created_at AS createdAt, last_login_at AS lastLoginAt, duties, assigned_cages`

function toUser(r: Record<string, unknown>): UserRow {
  const { duties: _d, assigned_cages: _c, ...rest } = r
  const access = accessFromRow({ role: r.role as Role, duties: r.duties as string | null, assigned_cages: r.assigned_cages as string | null })
  return {
    ...(rest as unknown as UserRow),
    active: !!r.active,
    pending: !!r.pending,
    hasRecoveryCode: !!r.hasRecoveryCode,
    duties: access.duties,
    cages: access.cages
  }
}

export async function countUsers(ctx: Pick<Ctx, 'db'>): Promise<number> {
  return ((await ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get()) as { n: number }).n
}

export async function countPendingSignups(ctx: Pick<Ctx, 'db'>): Promise<number> {
  return ((await ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE pending = 1').get()) as { n: number }).n
}

interface AuthRow {
  id: number
  username: string
  display_name: string
  password_hash: string
  recovery_hash: string | null
  role: Role
  active: number
  pending: number
  failed_attempts: number
  locked_until: string | null
  duties: string | null
  assigned_cages: string | null
}

async function findUser(ctx: Ctx, username: string): Promise<AuthRow | undefined> {
  return (await ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim())) as AuthRow | undefined
}

function assertNotLocked(ctx: Ctx, row: AuthRow) {
  if (row.locked_until && row.locked_until > ctx.now().toISOString()) {
    const minutes = Math.ceil((Date.parse(row.locked_until) - ctx.now().getTime()) / 60000)
    throw new AppError('account_locked', { minutes })
  }
}

/** Counts a failed attempt; the fifth failure locks the account for LOCK_MINUTES. */
async function recordFailure(ctx: Ctx, row: AuthRow, action: string) {
  const attempts = row.failed_attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    const until = new Date(ctx.now().getTime() + LOCK_MINUTES * 60000).toISOString()
    await ctx.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(until, row.id)
    await audit(ctx, { action: 'account_locked', entity: 'user', entityId: row.id, details: { after: action } })
  } else {
    await ctx.db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, row.id)
  }
}

async function clearFailures(ctx: Ctx, id: number) {
  await ctx.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(id)
}

export async function login(ctx: Ctx, username: string, password: string): Promise<SessionUser> {
  const row = await findUser(ctx, username)
  if (row) assertNotLocked(ctx, row)
  if (!row || !verifyPassword(password, row.password_hash)) {
    if (row) await recordFailure(ctx, row, 'login')
    await audit(ctx, { action: 'login_failed', entity: 'user', details: { username } })
    throw new AppError('invalid_login')
  }
  if (row.pending) throw new AppError('account_pending')
  if (!row.active) throw new AppError('user_inactive')
  await clearFailures(ctx, row.id)
  await ctx.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(ctx.now().toISOString(), row.id)
  const access = accessFromRow(row)
  const user: SessionUser = { id: row.id, username: row.username, displayName: row.display_name, role: row.role, duties: access.duties, cages: access.cages }
  await audit({ ...ctx, user }, { action: 'login', entity: 'user', entityId: row.id })
  return user
}

export interface NewUser {
  username: string
  displayName: string
  password: string
  role: Role
}

/**
 * Inserts a user without a permission check (used by setup, sign-up and createUser).
 * Returns the new id and the user's first recovery code (shown once, stored only as a hash).
 */
export async function createUserRaw(ctx: Ctx, u: NewUser, opts: { pending?: boolean } = {}): Promise<{ id: number; recoveryCode: string }> {
  validatePassword(u.password)
  const username = u.username.trim()
  assert(/^[A-Za-z0-9._-]{3,32}$/.test(username), 'invalid_username')
  const exists = await ctx.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)
  assert(!exists, 'username_taken')
  const pending = !!opts.pending
  const info = await ctx.db
    .prepare(
      'INSERT INTO users (username, display_name, password_hash, role, active, pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(username, u.displayName.trim() || username, hashPassword(u.password), u.role, pending ? 0 : 1, pending ? 1 : 0, ctx.now().toISOString())
  const id = Number(info.lastInsertRowid)
  const recoveryCode = await issueRecoveryCode(ctx, id)
  await audit(ctx, { action: pending ? 'signup_request' : 'create', entity: 'user', entityId: id, details: { username, role: u.role } })
  return { id, recoveryCode }
}

/**
 * Self sign-up from the sign-in screen. The account is created as a data-entry user that
 * cannot sign in until an administrator approves it.
 */
export async function signup(ctx: Ctx, u: { username: string; displayName: string; password: string }) {
  const s = await getSettings(ctx)
  assert(await countUsers(ctx) > 0, 'setup_required')
  assert(s.allowSignup, 'signup_disabled')
  return ctx.db.transaction(async () => {
    const { recoveryCode } = await createUserRaw({ ...ctx, user: null }, { ...u, role: 'operator' }, { pending: true })
    return { recoveryCode }
  })()
}

/** Resets a forgotten password with the user's recovery code. The code is single-use: a new one is returned. */
export async function resetWithRecoveryCode(ctx: Ctx, username: string, code: string, newPassword: string) {
  validatePassword(newPassword)
  const row = await findUser(ctx, username)
  if (row) assertNotLocked(ctx, row)
  if (!row || !row.recovery_hash || !verifyPassword(normalizeRecoveryCode(code), row.recovery_hash)) {
    if (row) await recordFailure(ctx, row, 'recovery_code')
    await audit(ctx, { action: 'password_reset_failed', entity: 'user', details: { username } })
    throw new AppError('invalid_recovery')
  }
  return ctx.db.transaction(async () => {
    await ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), row.id)
    await clearFailures(ctx, row.id)
    const recoveryCode = await issueRecoveryCode(ctx, row.id)
    await audit({ ...ctx, user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role } }, {
      action: 'password_reset_with_code',
      entity: 'user',
      entityId: row.id
    })
    return { recoveryCode }
  })()
}

/** A signed-in user replaces their own recovery code (requires their current password). */
export async function newOwnRecoveryCode(ctx: Ctx, password: string) {
  const user = requireUser(ctx)
  const row = (await ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id)) as { password_hash: string }
  assert(verifyPassword(password, row.password_hash), 'wrong_password')
  return ctx.db.transaction(async () => {
    const recoveryCode = await issueRecoveryCode(ctx, user.id)
    await audit(ctx, { action: 'new_recovery_code', entity: 'user', entityId: user.id })
    return { recoveryCode }
  })()
}

export async function adminNewRecoveryCode(ctx: Ctx, id: number) {
  requireAdmin(ctx)
  return ctx.db.transaction(async () => {
    assert(await ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id), 'not_found')
    const recoveryCode = await issueRecoveryCode(ctx, id)
    await audit(ctx, { action: 'new_recovery_code', entity: 'user', entityId: id })
    return { recoveryCode }
  })()
}

export async function listUsers(ctx: Ctx): Promise<UserRow[]> {
  requireAdmin(ctx)
  return ((await ctx.db.prepare(`SELECT ${userCols} FROM users ORDER BY pending DESC, username`).all()) as Record<string, unknown>[]).map(toUser)
}

export async function createUser(ctx: Ctx, u: NewUser) {
  requireAdmin(ctx)
  return ctx.db.transaction(async () => createUserRaw(ctx, u))()
}

async function getAuthRow(ctx: Ctx, id: number): Promise<AuthRow> {
  const row = (await ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id)) as AuthRow | undefined
  assert(row, 'not_found')
  return row
}

export async function approveSignup(ctx: Ctx, id: number, role: Role) {
  requireAdmin(ctx)
  await ctx.db.transaction(async () => {
    const row = await getAuthRow(ctx, id)
    assert(row.pending, 'not_pending')
    await ctx.db.prepare('UPDATE users SET pending = 0, active = 1, role = ? WHERE id = ?').run(role, id)
    await audit(ctx, { action: 'approve_signup', entity: 'user', entityId: id, details: { username: row.username, role } })
  })()
}

/** Rejecting removes the request; it has no farm records attached. */
export async function rejectSignup(ctx: Ctx, id: number) {
  requireAdmin(ctx)
  await ctx.db.transaction(async () => {
    const row = await getAuthRow(ctx, id)
    assert(row.pending, 'not_pending')
    await ctx.db.prepare('DELETE FROM users WHERE id = ?').run(id)
    await audit(ctx, { action: 'reject_signup', entity: 'user', entityId: id, details: { username: row.username } })
  })()
}

async function otherActiveAdmins(ctx: Ctx, excludeId: number) {
  const r = (await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND pending = 0 AND id <> ?")
    .get(excludeId)) as { n: number }
  return r.n
}

export async function updateUser(ctx: Ctx, u: { id: number; displayName: string; role: Role; active: boolean }) {
  const admin = requireAdmin(ctx)
  await ctx.db.transaction(async () => {
    const before = (await ctx.db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(u.id)) as Record<string, unknown> | undefined
    assert(before, 'not_found')
    assert(!before.pending, 'account_pending')
    if (before.role === 'admin' && (u.role !== 'admin' || !u.active)) {
      assert(await otherActiveAdmins(ctx, u.id) > 0, 'last_admin')
    }
    assert(!(u.id === admin.id && !u.active), 'cannot_disable_self')
    await ctx.db
      .prepare('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?')
      .run(u.displayName.trim(), u.role, u.active ? 1 : 0, u.id)
    await audit(ctx, { action: 'update', entity: 'user', entityId: u.id, details: { before, after: u } })
  })()
}

export async function resetPassword(ctx: Ctx, id: number, password: string) {
  requireAdmin(ctx)
  validatePassword(password)
  await ctx.db.transaction(async () => {
    const info = await ctx.db
      .prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
      .run(hashPassword(password), id)
    assert(info.changes === 1, 'not_found')
    await audit(ctx, { action: 'reset_password', entity: 'user', entityId: id })
  })()
}

export async function changeOwnPassword(ctx: Ctx, current: string, next: string) {
  const user = requireUser(ctx)
  validatePassword(next)
  const row = (await ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id)) as { password_hash: string }
  assert(verifyPassword(current, row.password_hash), 'wrong_password')
  await ctx.db.transaction(async () => {
    await ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id)
    await audit(ctx, { action: 'change_password', entity: 'user', entityId: user.id })
  })()
}
