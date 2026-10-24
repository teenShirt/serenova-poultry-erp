import { describe, expect, it } from 'vitest'
import { AppError } from '../src/server/errors'
import { latestSchemaVersion, migrate, migrations } from '../src/server/db/migrations'
import {
  adminNewRecoveryCode,
  approveSignup,
  countPendingSignups,
  createUser,
  generateRecoveryCode,
  listUsers,
  login,
  newOwnRecoveryCode,
  rejectSignup,
  resetWithRecoveryCode,
  signup
} from '../src/server/services/auth'
import { saveSettings } from '../src/server/services/settings'
import { completeSetup } from '../src/server/services/setup'
import type { Ctx } from '../src/server/context'
import { type Farm, makeFarm, NOW, openTestDb, setupInput } from './helpers'

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof AppError) return e.code
    throw e
  }
  return 'no_error'
}

const anon = (f: Farm): Ctx => ({ db: f.db, user: null, now: () => NOW })

describe('self sign-up', () => {
  it('creates a pending data-entry account that cannot sign in until approved', async () => {
    const f = await makeFarm()
    const { recoveryCode } = await signup(anon(f), { username: 'nimal', displayName: 'Nimal', password: 'nimal123' })
    expect(recoveryCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(await countPendingSignups(f.admin)).toBe(1)
    expect(await code(() => login(anon(f), 'nimal', 'nimal123'))).toBe('account_pending')
    const pending = (await listUsers(f.admin)).find((u) => u.username === 'nimal')!
    expect(pending).toMatchObject({ pending: true, active: false, role: 'operator', hasRecoveryCode: true })

    expect(await code(() => approveSignup(f.worker, pending.id, 'operator'))).toBe('admin_only')
    await approveSignup(f.admin, pending.id, 'operator')
    expect(await login(anon(f), 'nimal', 'nimal123')).toMatchObject({ username: 'nimal', role: 'operator' })
    expect(await countPendingSignups(f.admin)).toBe(0)
  })

  it('rejecting deletes the request; usernames stay unique; sign-up can be switched off', async () => {
    const f = await makeFarm()
    expect(await code(() => signup(anon(f), { username: 'worker', displayName: 'X', password: 'abcdef' }))).toBe('username_taken')
    await signup(anon(f), { username: 'kamal', displayName: 'Kamal', password: 'kamal123' })
    const id = (await listUsers(f.admin)).find((u) => u.username === 'kamal')!.id
    await rejectSignup(f.admin, id)
    expect((await listUsers(f.admin)).some((u) => u.username === 'kamal')).toBe(false)
    expect(await code(() => rejectSignup(f.admin, f.worker.user!.id))).toBe('not_pending')

    await saveSettings(f.admin, { allowSignup: false })
    expect(await code(() => signup(anon(f), { username: 'sunil', displayName: 'Sunil', password: 'sunil123' }))).toBe('signup_disabled')
  })

  it('is not possible before the farm is set up', async () => {
    const db = await openTestDb()
    expect(await code(() => signup({ db, user: null, now: () => NOW }, { username: 'first', displayName: 'F', password: 'abcdef' }))).toBe('setup_required')
  })
})

describe('password reset with recovery code', () => {
  it('resets the password, and the code works only once', async () => {
    const db = await openTestDb()
    const ctx: Ctx = { db, user: null, now: () => NOW }
    const { recoveryCode } = await completeSetup(ctx, setupInput())
    // Typed in lower case without dashes still works.
    const typed = recoveryCode.replace(/-/g, '').toLowerCase()
    const { recoveryCode: next } = await resetWithRecoveryCode(ctx, 'admin', typed, 'brandnew1')
    expect(next).not.toBe(recoveryCode)
    expect((await login(ctx, 'admin', 'brandnew1')).username).toBe('admin')
    expect(await code(() => login(ctx, 'admin', 'secret123'))).toBe('invalid_login')
    expect(await code(() => resetWithRecoveryCode(ctx, 'admin', recoveryCode, 'again123'))).toBe('invalid_recovery')
    await resetWithRecoveryCode(ctx, 'admin', next, 'again123')
    expect((await login(ctx, 'admin', 'again123')).username).toBe('admin')
  })

  it('locks the account after 5 wrong attempts for 15 minutes', async () => {
    const f = await makeFarm()
    let now = NOW
    const ctx: Ctx = { db: f.db, user: null, now: () => now }
    for (let i = 0; i < 5; i++) expect(await code(() => resetWithRecoveryCode(ctx, 'worker', 'AAAA-BBBB-CCCC', 'newpass1'))).toBe('invalid_recovery')
    expect(await code(() => login(ctx, 'worker', 'worker123'))).toBe('account_locked')
    now = new Date(NOW.getTime() + 16 * 60000)
    expect((await login(ctx, 'worker', 'worker123')).username).toBe('worker')
  })

  it('wrong passwords also count towards the lock', async () => {
    const f = await makeFarm()
    const ctx = anon(f)
    for (let i = 0; i < 5; i++) expect(await code(() => login(ctx, 'worker', 'nope'))).toBe('invalid_login')
    expect(await code(() => login(ctx, 'worker', 'worker123'))).toBe('account_locked')
  })

  it('users and administrators can issue a new code, which replaces the old one', async () => {
    const f = await makeFarm()
    const ctx = anon(f)
    const { recoveryCode: created } = await createUser(f.admin, { username: 'ruwan', displayName: 'Ruwan', password: 'ruwan123', role: 'operator' })
    const ruwan: Ctx = { ...ctx, user: await login(ctx, 'ruwan', 'ruwan123') }
    expect(await code(() => newOwnRecoveryCode(ruwan, 'wrong'))).toBe('wrong_password')
    const { recoveryCode: own } = await newOwnRecoveryCode(ruwan, 'ruwan123')
    expect(await code(() => resetWithRecoveryCode(ctx, 'ruwan', created, 'xyz12345'))).toBe('invalid_recovery')
    const { recoveryCode: byAdmin } = await adminNewRecoveryCode(f.admin, ruwan.user!.id)
    expect(await code(() => resetWithRecoveryCode(ctx, 'ruwan', own, 'xyz12345'))).toBe('invalid_recovery')
    await resetWithRecoveryCode(ctx, 'ruwan', byAdmin, 'xyz12345')
    expect((await login(ctx, 'ruwan', 'xyz12345')).username).toBe('ruwan')
  })

  it('stores only hashes of recovery codes', async () => {
    const db = await openTestDb()
    const { recoveryCode } = await completeSetup({ db, user: null, now: () => NOW }, setupInput())
    const dump = JSON.stringify(await db.prepare('SELECT * FROM users').all())
    expect(dump).not.toContain(recoveryCode)
    expect(dump).not.toContain(recoveryCode.replace(/-/g, ''))
  })

  it('codes are random', () => {
    const codes = new Set(Array.from({ length: 200 }, generateRecoveryCode))
    expect(codes.size).toBe(200)
  })
})

describe('upgrade from version 1 database', () => {
  it('adds the account columns and keeps existing users signing in', async () => {
    // Build a database exactly as version 1 created it, with one administrator.
    const db = await openTestDb(false)
    await db.exec('CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at VARCHAR(32) NOT NULL)')
    await db.exec(migrations[0].up)
    await db.prepare("INSERT INTO schema_migrations VALUES (1, 'initial schema', 'x')").run()
    const other = await openTestDb()
    await completeSetup({ db: other, user: null, now: () => NOW }, setupInput())
    const hash = ((await other.prepare("SELECT password_hash FROM users WHERE username='admin'").get()) as { password_hash: string }).password_hash
    await db.prepare("INSERT INTO users (username, display_name, password_hash, role, active, created_at) VALUES ('admin','Admin',?, 'admin', 1, 'x')").run(hash)

    expect(await migrate(db)).toEqual({ from: 1, to: latestSchemaVersion() })
    expect(((await db.prepare('SELECT MAX(version) v FROM schema_migrations').get()) as { v: number }).v).toBe(latestSchemaVersion())
    const ctx: Ctx = { db, user: null, now: () => NOW }
    const admin = await login(ctx, 'admin', 'secret123')
    const u = (await listUsers({ ...ctx, user: admin }))[0]
    expect(u).toMatchObject({ pending: false, hasRecoveryCode: false })
    // Users from before the upgrade have no code until one is issued.
    expect(await code(() => resetWithRecoveryCode(ctx, 'admin', 'AAAA-BBBB-CCCC', 'newpass1'))).toBe('invalid_recovery')
  })
})
