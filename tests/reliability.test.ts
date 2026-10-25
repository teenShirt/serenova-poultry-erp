import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { configProblems, type ServerConfig } from '../src/server/config'
import { Databases } from '../src/server/databases'
import { createServer } from '../src/server/index'
import { RateLimiter } from '../src/server/rate-limit'
import { configureBackupEncryption, createBackup, readBackup } from '../src/server/services/backup'
import { readChangelog } from '../src/server/services/platform'
import { assertRestoreTarget, runRestoreTest } from '../src/server/services/restore-test'
import { APP_VERSION } from '../src/server/version'
import { makeFarm, testServer } from './helpers'

const root = path.resolve(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-reliability-'))
afterAll(() => {
  configureBackupEncryption(null)
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A configuration for the test MySQL server and a database of its own (created on first use). */
function config(over: Partial<ServerConfig> = {}): ServerConfig {
  const s = testServer()
  return {
    port: 0,
    host: '127.0.0.1',
    db: { host: s.host, port: s.port, user: s.user, password: s.password, database: `pfm_test_${randomBytes(5).toString('hex')}`, connectionLimit: 4 },
    demoDatabase: null,
    backupDir: path.join(tmp, randomBytes(4).toString('hex')),
    setupKey: null,
    sessionIdleHours: 12,
    secureCookies: false,
    trustProxy: 0,
    maxUploadMb: 10,
    environment: 'development',
    releaseSha: null,
    backupKey: null,
    restoreTestDatabase: null,
    authRequestsPerMinute: 10,
    ...over
  }
}

describe('settings per environment', () => {
  it('a production server refuses unsafe settings, naming them without their values', () => {
    const c = config({ environment: 'production', demoDatabase: 'x_demo' })
    c.db.password = ''
    expect(configProblems(c)).toEqual([
      'SETUP_KEY must be set',
      'COOKIE_SECURE must be true (serve the site over HTTPS)',
      'DB_PASSWORD must be set',
      expect.stringContaining('DB_USER must be the application'),
      'DEMO_ENABLED must be false',
      'BACKUP_ENCRYPTION_KEY must be set (backups are encrypted at rest)'
    ])
    const safe = config({ environment: 'production', setupKey: 'k', secureCookies: true, backupKey: randomBytes(32) })
    safe.db.user = 'poultry'
    safe.db.password = 'not-a-real-password'
    expect(configProblems(safe)).toEqual([])
    expect(configProblems(config())).toEqual([])
  })

  it('the version, package.json and the newest release notes agree', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
    expect(pkg.version).toBe(APP_VERSION)
    const notes = readChangelog(path.join(root, 'CHANGELOG.md'))
    expect(notes[0]).toMatchObject({ version: APP_VERSION })
    expect(notes[0].body).toContain('Health checks')
  })
})

describe('sign-in rate limit', () => {
  it('allows the set number of tries per minute from one address, then asks to wait', () => {
    let now = 0
    const l = new RateLimiter(3, () => now)
    expect([1, 2, 3].map(() => l.hit('1.2.3.4:auth.login'))).toEqual([0, 0, 0])
    expect(l.hit('1.2.3.4:auth.login')).toBe(60)
    expect(l.hit('5.6.7.8:auth.login')).toBe(0)
    now = 30_000
    expect(l.hit('1.2.3.4:auth.login')).toBe(30)
    now = 60_000
    expect(l.hit('1.2.3.4:auth.login')).toBe(0)
    expect(l.refused[0]).toMatchObject({ key: '1.2.3.4' })
  })
})

describe('backups encrypted at rest', () => {
  it('can be read only with the same key, and any change to the file is detected', async () => {
    const f = await makeFarm()
    const key = randomBytes(32)
    configureBackupEncryption(key)
    try {
      const b = await createBackup(f.db, path.join(tmp, 'enc'), 'manual', { orgId: f.org, log: false })
      expect(b.status).toBe('ok')
      const raw = fs.readFileSync(b.path!)
      expect(raw.subarray(0, 7).toString('latin1')).toBe('PFMENC1')
      expect(raw.includes(Buffer.from('Test Farm'))).toBe(false)
      expect(readBackup(b.path!).tables['organizations'].rows).toHaveLength(1)

      configureBackupEncryption(null)
      expect(() => readBackup(b.path!)).toThrow('backup_encrypted')
      configureBackupEncryption(randomBytes(32))
      expect(() => readBackup(b.path!)).toThrow('backup_key_mismatch')
      configureBackupEncryption(key)
      raw[raw.length - 5] ^= 0xff
      fs.writeFileSync(b.path!, raw)
      expect(() => readBackup(b.path!)).toThrow('backup_key_mismatch')
    } finally {
      configureBackupEncryption(null)
    }
  })
})

describe('restore drill', () => {
  it('restores the newest whole-database backup into the separate database and checks it', async () => {
    const f = await makeFarm()
    const s = testServer()
    const target = `pfm_test_restore_${randomBytes(4).toString('hex')}`
    const admin = await mysql.createConnection({ ...s })
    await admin.query(`CREATE DATABASE ${target}`)
    await admin.end()
    const cfg = config({ restoreTestDatabase: target })
    cfg.db.database = f.db.name
    const backup = await createBackup(f.db, cfg.backupDir, 'auto', { orgId: null })
    expect(backup.status).toBe('ok')

    const r = await runRestoreTest(f.db, cfg)
    expect(r).toMatchObject({ status: 'ok', backupFile: path.resolve(backup.path!), targetDatabase: target, problems: [] })
    expect(r.tablesChecked).toBeGreaterThan(40)
    expect(r.rowsChecked).toBeGreaterThan(20)
    expect(await f.db.prepare('SELECT status, tables_checked AS t FROM restore_tests').all()).toEqual([{ status: 'ok', t: r.tablesChecked }])
    // The farm database is untouched by the drill.
    expect(((await f.db.prepare('SELECT COUNT(*) AS n FROM organizations').get()) as { n: number }).n).toBe(1)
  })

  it('never uses the farm database, or one not named for restore tests', () => {
    expect(() => assertRestoreTarget(config())).toThrow('RESTORE_TEST_DB_NAME is not set')
    const same = config()
    same.restoreTestDatabase = same.db.database
    expect(() => assertRestoreTarget(same)).toThrow('separate database')
    expect(() => assertRestoreTarget(config({ restoreTestDatabase: 'poultry_copy' }))).toThrow('must contain "restore"')
  })
})

describe('release history', () => {
  it('records each release the server starts with; a restart only updates it', async () => {
    const cfg = config({ environment: 'staging', releaseSha: 'abc1234' })
    for (let i = 0; i < 2; i++) await (await Databases.open(cfg)).close()
    const c = await mysql.createConnection({ ...testServer(), database: cfg.db.database })
    const [rows] = await c.query('SELECT version, release_sha, environment, schema_from, status, restarts FROM deployments')
    await c.end()
    expect(rows).toEqual([{ version: APP_VERSION, release_sha: 'abc1234', environment: 'staging', schema_from: 0, status: 'ok', restarts: 1 }])
  })
})

describe('the HTTP server', () => {
  it('answers health checks and limits sign-in attempts per address', async () => {
    const server = await createServer(config({ authRequestsPerMinute: 3 }))
    const http = server.app.listen(0, '127.0.0.1')
    await new Promise((r) => http.once('listening', r))
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    try {
      expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'ok' })
      const ready = await fetch(`${base}/readyz`)
      expect(ready.status).toBe(200)
      expect(await ready.json()).toMatchObject({ status: 'ready', version: APP_VERSION, environment: 'development' })
      const login = () =>
        fetch(`${base}/api/call/auth.login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pfm' },
          body: JSON.stringify({ input: { email: 'nobody@example.com', password: 'wrong-password' } })
        })
      for (let i = 0; i < 3; i++) expect((await login()).status).toBe(200)
      const refused = await login()
      expect(refused.status).toBe(429)
      expect(await refused.json()).toMatchObject({ ok: false, code: 'too_many_attempts' })
    } finally {
      http.close()
      await server.close()
    }
  })

  it('does not start in production with unsafe settings', async () => {
    await expect(createServer(config({ environment: 'production' }))).rejects.toThrow('Unsafe settings for a production server')
  })
})
