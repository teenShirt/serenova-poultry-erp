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
  signup,
  updateUser
} from '../src/server/services/auth'
import { saveSettings } from '../src/server/services/settings'
import { completeSetup } from '../src/server/services/setup'
import type { AnonCtx, Ctx } from '../src/server/context'
import { makeFarm, NOW, openTestDb, setupInput } from './helpers'

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof AppError) return e.code
    throw e
  }
  return 'no_error'
}

describe('signing in with an email address', () => {
  it('finds the account in any organization, in any letter case', async () => {
    const f = await makeFarm()
    const g = await makeFarm({ db: f.db, name: 'Other Farm', domain: 'other.farm' })
    const a = await login(f.anon, '  ADMIN@Test.Farm ', 'secret123')
    expect(a).toMatchObject({ org: f.org, farm: f.farm, user: { email: 'admin@test.farm', role: 'admin' } })
    expect((await login(f.anon, 'admin@other.farm', 'secret123')).org).toBe(g.org)
    expect(await code(() => login(f.anon, 'admin@test.farm', 'wrong'))).toBe('invalid_login')
    expect(await code(() => login(f.anon, 'nobody@test.farm', 'secret123'))).toBe('invalid_login')
  })

  it('an email address can belong to only one account on the platform', async () => {
    const f = await makeFarm()
    const g = await makeFarm({ db: f.db, name: 'Other Farm', domain: 'other.farm' })
    expect(await code(() => createUser(g.admin, { email: 'worker@test.farm', displayName: 'X', password: 'abcdef', role: 'operator' }))).toBe('email_taken')
    expect(await code(() => updateUser(g.admin, { id: g.worker.user!.id, email: 'Worker@Test.Farm', displayName: 'W', role: 'operator', active: true }))).toBe('email_taken')
    expect(await code(() => createUser(g.admin, { email: 'not-an-address', displayName: 'X', password: 'abcdef', role: 'operator' }))).toBe('invalid_email')
  })

  it('a suspended organization cannot sign in', async () => {
    const f = await makeFarm()
    await f.db.prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?").run(f.org)
    expect(await code(() => login(f.anon, 'admin@test.farm', 'secret123'))).toBe('organization_suspended')
  })
})

describe('self sign-up', () => {
  it('creates a pending data-entry account in the organization with that code, which cannot sign in until approved', async () => {
    const f = await makeFarm()
    const { recoveryCode } = await signup(f.anon, { organizationCode: f.orgCode, email: 'nimal@test.farm', displayName: 'Nimal', password: 'nimal123' })
    expect(recoveryCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(await countPendingSignups(f.admin)).toBe(1)
    expect(await code(() => login(f.anon, 'nimal@test.farm', 'nimal123'))).toBe('account_pending')
    const pending = (await listUsers(f.admin)).find((u) => u.email === 'nimal@test.farm')!
    expect(pending).toMatchObject({ username: 'nimal', pending: true, active: false, role: 'operator', hasRecoveryCode: true })

    expect(await code(() => approveSignup(f.worker, pending.id, 'operator'))).toBe('admin_only')
    await approveSignup(f.admin, pending.id, 'operator')
    expect((await login(f.anon, 'nimal@test.farm', 'nimal123')).user).toMatchObject({ username: 'nimal', role: 'operator' })
    expect(await countPendingSignups(f.admin)).toBe(0)
  })

  it('rejecting deletes the request; emails stay unique; sign-up can be switched off; the code must exist', async () => {
    const f = await makeFarm()
    const join = (email: string) => signup(f.anon, { organizationCode: f.orgCode, email, displayName: 'X', password: 'abcdef' })
    expect(await code(() => join('worker@test.farm'))).toBe('email_taken')
    await join('kamal@test.farm')
    const id = (await listUsers(f.admin)).find((u) => u.email === 'kamal@test.farm')!.id
    await rejectSignup(f.admin, id)
    expect((await listUsers(f.admin)).some((u) => u.email === 'kamal@test.farm')).toBe(false)
    expect(await code(() => rejectSignup(f.admin, f.worker.user!.id))).toBe('not_pending')

    expect(await code(() => signup(f.anon, { organizationCode: 'no-such-org', email: 'x@y.z', displayName: 'X', password: 'abcdef' }))).toBe('organization_not_found')
    await saveSettings(f.admin, { allowSignup: false })
    expect(await code(() => join('sunil@test.farm'))).toBe('signup_disabled')
  })

  it('usernames for the audit history are unique within the organization', async () => {
    const f = await makeFarm()
    await createUser(f.admin, { email: 'worker@elsewhere.org', displayName: 'Second worker', password: 'abcdef', role: 'operator' })
    expect((await listUsers(f.admin)).map((u) => u.username).sort()).toEqual(['admin', 'worker', 'worker2'])
  })
})

describe('first-run setup', () => {
  it('creates the first organization only once', async () => {
    const db = await openTestDb()
    const anon: AnonCtx = { db, now: () => NOW }
    const org = await completeSetup(anon, setupInput())
    expect(org.organizationCode).toBe('test-farm')
    expect(await code(() => completeSetup(anon, setupInput()))).toBe('setup_already_done')
  })
})

describe('password reset with recovery code', () => {
  it('resets the password, and the code works only once', async () => {
    const db = await openTestDb()
    const anon: AnonCtx = { db, now: () => NOW }
    const { recoveryCode } = await completeSetup(anon, setupInput())
    // Typed in lower case without dashes still works.
    const typed = recoveryCode.replace(/-/g, '').toLowerCase()
    const { recoveryCode: next } = await resetWithRecoveryCode(anon, 'admin@test.farm', typed, 'brandnew1')
    expect(next).not.toBe(recoveryCode)
    expect((await login(anon, 'admin@test.farm', 'brandnew1')).user.username).toBe('admin')
    expect(await code(() => login(anon, 'admin@test.farm', 'secret123'))).toBe('invalid_login')
    expect(await code(() => resetWithRecoveryCode(anon, 'admin@test.farm', recoveryCode, 'again123'))).toBe('invalid_recovery')
    await resetWithRecoveryCode(anon, 'admin@test.farm', next, 'again123')
    expect((await login(anon, 'admin@test.farm', 'again123')).user.username).toBe('admin')
  })

  it('locks the account after 5 wrong attempts for 15 minutes', async () => {
    const f = await makeFarm()
    let now = NOW
    const anon: AnonCtx = { db: f.db, now: () => now }
    for (let i = 0; i < 5; i++) expect(await code(() => resetWithRecoveryCode(anon, 'worker@test.farm', 'AAAA-BBBB-CCCC', 'newpass1'))).toBe('invalid_recovery')
    expect(await code(() => login(anon, 'worker@test.farm', 'worker123'))).toBe('account_locked')
    now = new Date(NOW.getTime() + 16 * 60000)
    expect((await login(anon, 'worker@test.farm', 'worker123')).user.username).toBe('worker')
  })

  it('wrong passwords also count towards the lock', async () => {
    const f = await makeFarm()
    for (let i = 0; i < 5; i++) expect(await code(() => login(f.anon, 'worker@test.farm', 'nope'))).toBe('invalid_login')
    expect(await code(() => login(f.anon, 'worker@test.farm', 'worker123'))).toBe('account_locked')
  })

  it('users and administrators can issue a new code, which replaces the old one', async () => {
    const f = await makeFarm()
    const { recoveryCode: created } = await createUser(f.admin, { email: 'ruwan@test.farm', displayName: 'Ruwan', password: 'ruwan123', role: 'operator' })
    const ruwan: Ctx = { ...f.admin, user: (await login(f.anon, 'ruwan@test.farm', 'ruwan123')).user }
    expect(await code(() => newOwnRecoveryCode(ruwan, 'wrong'))).toBe('wrong_password')
    const { recoveryCode: own } = await newOwnRecoveryCode(ruwan, 'ruwan123')
    expect(await code(() => resetWithRecoveryCode(f.anon, 'ruwan@test.farm', created, 'xyz12345'))).toBe('invalid_recovery')
    const { recoveryCode: byAdmin } = await adminNewRecoveryCode(f.admin, ruwan.user!.id)
    expect(await code(() => resetWithRecoveryCode(f.anon, 'ruwan@test.farm', own, 'xyz12345'))).toBe('invalid_recovery')
    await resetWithRecoveryCode(f.anon, 'ruwan@test.farm', byAdmin, 'xyz12345')
    expect((await login(f.anon, 'ruwan@test.farm', 'xyz12345')).user.username).toBe('ruwan')
  })

  it('stores only hashes of recovery codes', async () => {
    const db = await openTestDb()
    const { recoveryCode } = await completeSetup({ db, now: () => NOW }, setupInput())
    const dump = JSON.stringify(await db.prepare('SELECT * FROM users').all())
    expect(dump).not.toContain(recoveryCode)
    expect(dump).not.toContain(recoveryCode.replace(/-/g, ''))
  })

  it('codes are random', () => {
    const codes = new Set(Array.from({ length: 200 }, generateRecoveryCode))
    expect(codes.size).toBe(200)
  })
})

describe('upgrade from a version 1 database', () => {
  it('keeps existing accounts and passwords; an account signs in once it has an email address', async () => {
    // Build a database exactly as version 1 created it, with one administrator.
    const db = await openTestDb(false)
    await db.exec('CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at VARCHAR(32) NOT NULL)')
    await db.exec(migrations[0].up as string)
    await db.prepare("INSERT INTO schema_migrations VALUES (1, 'initial schema', 'x')").run()
    const other = await openTestDb()
    await completeSetup({ db: other, now: () => NOW }, setupInput())
    const hash = ((await other.prepare("SELECT password_hash FROM users WHERE username='admin'").get()) as { password_hash: string }).password_hash
    await db.prepare("INSERT INTO users (username, display_name, password_hash, role, active, created_at) VALUES ('admin','Admin',?, 'admin', 1, 'x')").run(hash)

    expect(await migrate(db)).toEqual({ from: 1, to: latestSchemaVersion() })
    const anon: AnonCtx = { db, now: () => NOW }
    expect(await code(() => login(anon, 'admin@hill.farm', 'secret123'))).toBe('invalid_login')
    await db.prepare("UPDATE users SET email = 'admin@hill.farm' WHERE username = 'admin'").run()
    const signedIn = await login(anon, 'admin@hill.farm', 'secret123')
    const u = (await listUsers({ db, now: () => NOW, org: signedIn.org, farm: signedIn.farm, user: signedIn.user }))[0]
    expect(u).toMatchObject({ username: 'admin', pending: false, hasRecoveryCode: false })
    // Users from before the upgrade have no recovery code until one is issued.
    expect(await code(() => resetWithRecoveryCode(anon, 'admin@hill.farm', 'AAAA-BBBB-CCCC', 'newpass1'))).toBe('invalid_recovery')
  })
})
