import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Role, SessionUser, UserRow } from '@shared/types'
import { type AnonCtx, type Ctx, requireAdmin, requireUser } from '../context'
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

/** Email addresses are compared in lower case and must look like an address. */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase()
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 255, 'invalid_email')
  return e
}

/** Gives the user a new recovery code (replacing any previous one) and returns it in plain text once. */
async function issueRecoveryCode(ctx: Pick<Ctx, 'db'>, userId: number): Promise<string> {
  const code = generateRecoveryCode()
  await ctx.db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?').run(hashPassword(normalizeRecoveryCode(code)), userId)
  return code
}

const userCols = `id, username, email, display_name AS displayName, role, active, pending, recovery_hash IS NOT NULL AS hasRecoveryCode,
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

export async function countUsers(ctx: Pick<Ctx, 'db' | 'org'>): Promise<number> {
  return ((await ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE organization_id = ?').get(ctx.org)) as { n: number }).n
}

export async function countPendingSignups(ctx: Pick<Ctx, 'db' | 'org'>): Promise<number> {
  return ((await ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND pending = 1').get(ctx.org)) as { n: number }).n
}

interface AuthRow {
  id: number
  organization_id: number
  username: string
  email: string | null
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

/** Finds an account by its email address, across all organizations (an email is unique on the platform). */
async function findByEmail(ctx: AnonCtx, email: string): Promise<AuthRow | undefined> {
  const e = email.trim().toLowerCase()
  if (!e) return undefined
  return (await ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(e)) as AuthRow | undefined
}

/** The farm a user starts on: the organization's first active farm. */
export async function defaultFarm(ctx: Pick<Ctx, 'db'>, orgId: number): Promise<number> {
  const r = (await ctx.db.prepare("SELECT id FROM farms WHERE organization_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(orgId)) as
    | { id: number }
    | undefined
  if (!r) throw new AppError('no_farm')
  return r.id
}

/** The context of the organization an account belongs to (to record what happens to the account). */
async function orgCtx(ctx: AnonCtx, orgId: number, user: SessionUser | null = null): Promise<Ctx> {
  return { db: ctx.db, now: ctx.now, org: orgId, farm: await defaultFarm(ctx, orgId), user }
}

function toSessionUser(row: AuthRow): SessionUser {
  const access = accessFromRow(row)
  return { id: row.id, username: row.username, email: row.email ?? '', displayName: row.display_name, role: row.role, duties: access.duties, cages: access.cages }
}

function assertNotLocked(ctx: AnonCtx, row: AuthRow) {
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

async function clearFailures(ctx: Pick<Ctx, 'db'>, id: number) {
  await ctx.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(id)
}

export interface SignedIn {
  user: SessionUser
  org: number
  farm: number
}

/** Signs in with an email address. The account's organization becomes the session's organization. */
export async function login(anon: AnonCtx, email: string, password: string): Promise<SignedIn> {
  const row = await findByEmail(anon, email)
  if (row) assertNotLocked(anon, row)
  if (!row || !verifyPassword(password, row.password_hash)) {
    if (row) {
      const ctx = await orgCtx(anon, row.organization_id)
      await recordFailure(ctx, row, 'login')
      await audit(ctx, { action: 'login_failed', entity: 'user', details: { email } })
    } else {
      // An unknown address belongs to no organization: recorded as a platform event.
      await audit({ ...anon, org: null, user: null }, { action: 'login_failed', entity: 'user', details: { email } })
    }
    throw new AppError('invalid_login')
  }
  if (row.pending) throw new AppError('account_pending')
  if (!row.active) throw new AppError('user_inactive')
  const org = (await anon.db.prepare('SELECT status FROM organizations WHERE id = ?').get(row.organization_id)) as { status: string }
  if (org.status !== 'active') throw new AppError('organization_suspended')
  await clearFailures(anon, row.id)
  await anon.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(anon.now().toISOString(), row.id)
  const user = toSessionUser(row)
  const ctx = await orgCtx(anon, row.organization_id, user)
  await audit(ctx, { action: 'login', entity: 'user', entityId: row.id })
  return { user, org: ctx.org, farm: ctx.farm }
}

export interface NewUser {
  email: string
  displayName: string
  password: string
  role: Role
}

/** A short name for the audit history, taken from the email address, unique within the organization. */
async function usernameFor(ctx: Pick<Ctx, 'db' | 'org'>, email: string): Promise<string> {
  const base = (email.split('@')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 28) || 'user').padEnd(3, '0')
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}${n}`
    if (!(await ctx.db.prepare('SELECT 1 AS x FROM users WHERE organization_id = ? AND username = ?').get(ctx.org, name))) return name
  }
}

/**
 * Inserts a user into the context's organization without a permission check (used by setup,
 * sign-up and createUser). Returns the new id and the user's first recovery code (shown once,
 * stored only as a hash).
 */
export async function createUserRaw(ctx: Ctx, u: NewUser, opts: { pending?: boolean } = {}): Promise<{ id: number; recoveryCode: string }> {
  validatePassword(u.password)
  const email = normalizeEmail(u.email)
  assert(!(await ctx.db.prepare('SELECT 1 AS x FROM users WHERE email = ?').get(email)), 'email_taken')
  const username = await usernameFor(ctx, email)
  const pending = !!opts.pending
  const info = await ctx.db
    .prepare(
      'INSERT INTO users (organization_id, username, email, display_name, password_hash, role, active, pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(ctx.org, username, email, u.displayName.trim() || username, hashPassword(u.password), u.role, pending ? 0 : 1, pending ? 1 : 0, ctx.now().toISOString())
  const id = Number(info.lastInsertRowid)
  const recoveryCode = await issueRecoveryCode(ctx, id)
  await audit(ctx, { action: pending ? 'signup_request' : 'create', entity: 'user', entityId: id, details: { email, username, role: u.role } })
  return { id, recoveryCode }
}

/**
 * Self sign-up from the sign-in screen, into the organization with the given code. The account is
 * created as a data-entry user that cannot sign in until an administrator approves it.
 */
export async function signup(anon: AnonCtx, u: { organizationCode: string; email: string; displayName: string; password: string }) {
  const org = (await anon.db
    .prepare("SELECT id FROM organizations WHERE code = ? AND status = 'active'")
    .get(u.organizationCode.trim().toLowerCase())) as { id: number } | undefined
  assert(org, 'organization_not_found')
  const ctx = await orgCtx(anon, org.id)
  assert((await getSettings(ctx)).allowSignup, 'signup_disabled')
  return ctx.db.transaction(async () => {
    const { recoveryCode } = await createUserRaw(ctx, { email: u.email, displayName: u.displayName, password: u.password, role: 'operator' }, { pending: true })
    return { recoveryCode }
  })()
}

/** Resets a forgotten password with the user's recovery code. The code is single-use: a new one is returned. */
export async function resetWithRecoveryCode(anon: AnonCtx, email: string, code: string, newPassword: string) {
  validatePassword(newPassword)
  const row = await findByEmail(anon, email)
  if (row) assertNotLocked(anon, row)
  if (!row || !row.recovery_hash || !verifyPassword(normalizeRecoveryCode(code), row.recovery_hash)) {
    const ctx = row ? await orgCtx(anon, row.organization_id) : { ...anon, org: null, user: null }
    if (row) await recordFailure(ctx as Ctx, row, 'recovery_code')
    await audit(ctx, { action: 'password_reset_failed', entity: 'user', details: { email } })
    throw new AppError('invalid_recovery')
  }
  const ctx = await orgCtx(anon, row.organization_id, toSessionUser(row))
  return ctx.db.transaction(async () => {
    await ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), row.id)
    await clearFailures(ctx, row.id)
    const recoveryCode = await issueRecoveryCode(ctx, row.id)
    await audit(ctx, { action: 'password_reset_with_code', entity: 'user', entityId: row.id })
    return { recoveryCode }
  })()
}

/** An account of the context's organization; any other id is "not found". */
async function getAuthRow(ctx: Pick<Ctx, 'db' | 'org'>, id: number): Promise<AuthRow> {
  const row = (await ctx.db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(id, ctx.org)) as AuthRow | undefined
  assert(row, 'not_found')
  return row
}

/** A signed-in user replaces their own recovery code (requires their current password). */
export async function newOwnRecoveryCode(ctx: Ctx, password: string) {
  const user = requireUser(ctx)
  const row = await getAuthRow(ctx, user.id)
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
    await getAuthRow(ctx, id)
    const recoveryCode = await issueRecoveryCode(ctx, id)
    await audit(ctx, { action: 'new_recovery_code', entity: 'user', entityId: id })
    return { recoveryCode }
  })()
}

export async function listUsers(ctx: Ctx): Promise<UserRow[]> {
  requireAdmin(ctx)
  const rows = (await ctx.db.prepare(`SELECT ${userCols} FROM users WHERE organization_id = ? ORDER BY pending DESC, username`).all(ctx.org)) as Record<
    string,
    unknown
  >[]
  return rows.map(toUser)
}

export async function createUser(ctx: Ctx, u: NewUser) {
  requireAdmin(ctx)
  return ctx.db.transaction(async () => createUserRaw(ctx, u))()
}

export async function approveSignup(ctx: Ctx, id: number, role: Role) {
  requireAdmin(ctx)
  await ctx.db.transaction(async () => {
    const row = await getAuthRow(ctx, id)
    assert(row.pending, 'not_pending')
    await ctx.db.prepare('UPDATE users SET pending = 0, active = 1, role = ? WHERE id = ?').run(role, id)
    await audit(ctx, { action: 'approve_signup', entity: 'user', entityId: id, details: { username: row.username, email: row.email, role } })
  })()
}

/** Rejecting removes the request; it has no farm records attached. */
export async function rejectSignup(ctx: Ctx, id: number) {
  requireAdmin(ctx)
  await ctx.db.transaction(async () => {
    const row = await getAuthRow(ctx, id)
    assert(row.pending, 'not_pending')
    await ctx.db.prepare('DELETE FROM users WHERE id = ?').run(id)
    await audit(ctx, { action: 'reject_signup', entity: 'user', entityId: id, details: { username: row.username, email: row.email } })
  })()
}

async function otherActiveAdmins(ctx: Ctx, excludeId: number) {
  const r = (await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND role = 'admin' AND active = 1 AND pending = 0 AND id <> ?")
    .get(ctx.org, excludeId)) as { n: number }
  return r.n
}

export async function updateUser(ctx: Ctx, u: { id: number; email: string; displayName: string; role: Role; active: boolean }) {
  const admin = requireAdmin(ctx)
  const email = normalizeEmail(u.email)
  await ctx.db.transaction(async () => {
    const before = (await ctx.db.prepare(`SELECT ${userCols} FROM users WHERE id = ? AND organization_id = ?`).get(u.id, ctx.org)) as
      | Record<string, unknown>
      | undefined
    assert(before, 'not_found')
    assert(!before.pending, 'account_pending')
    if (before.role === 'admin' && (u.role !== 'admin' || !u.active)) {
      assert((await otherActiveAdmins(ctx, u.id)) > 0, 'last_admin')
    }
    assert(!(u.id === admin.id && !u.active), 'cannot_disable_self')
    assert(!(await ctx.db.prepare('SELECT 1 AS x FROM users WHERE email = ? AND id <> ?').get(email, u.id)), 'email_taken')
    await ctx.db.prepare('UPDATE users SET email = ?, display_name = ?, role = ?, active = ? WHERE id = ?').run(email, u.displayName.trim(), u.role, u.active ? 1 : 0, u.id)
    await audit(ctx, { action: 'update', entity: 'user', entityId: u.id, details: { before, after: { ...u, email } } })
  })()
}

export async function resetPassword(ctx: Ctx, id: number, password: string) {
  requireAdmin(ctx)
  validatePassword(password)
  await ctx.db.transaction(async () => {
    const info = await ctx.db
      .prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ? AND organization_id = ?')
      .run(hashPassword(password), id, ctx.org)
    assert(info.changes === 1, 'not_found')
    await audit(ctx, { action: 'reset_password', entity: 'user', entityId: id })
  })()
}

export async function changeOwnPassword(ctx: Ctx, current: string, next: string) {
  const user = requireUser(ctx)
  validatePassword(next)
  const row = await getAuthRow(ctx, user.id)
  assert(verifyPassword(current, row.password_hash), 'wrong_password')
  await ctx.db.transaction(async () => {
    await ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id)
    await audit(ctx, { action: 'change_password', entity: 'user', entityId: user.id })
  })()
}
