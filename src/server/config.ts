import path from 'node:path'
import type { DbConfig } from './db/connection'

/** Server settings, read from environment variables (or a .env file next to package.json). */
export interface ServerConfig {
  port: number
  host: string
  /** Farm database; the demonstration data uses `<database>_demo` on the same server. */
  db: DbConfig
  demoDatabase: string | null
  backupDir: string
  /** When set, the first-run setup asks for this key, so a stranger cannot claim a new installation. */
  setupKey: string | null
  sessionIdleHours: number
  /** Send the session cookie only over HTTPS. */
  secureCookies: boolean
  /** Number of reverse proxies in front of the server (for client IPs and HTTPS detection). */
  trustProxy: number
  maxUploadMb: number
  /** development, staging or production: production refuses to start with unsafe settings */
  environment: AppEnvironment
  /** The release (git commit) being run, set by the deployment (RELEASE_SHA) */
  releaseSha: string | null
  /** 32-byte key (hex or base64) that encrypts backup files at rest; none = not encrypted */
  backupKey: Buffer | null
  /** An existing, separate database where backups are test-restored (never the farm database) */
  restoreTestDatabase: string | null
  /** Sign-in, sign-up and password-reset requests allowed per minute from one address */
  authRequestsPerMinute: number
}

export const APP_ENVIRONMENTS = ['development', 'staging', 'production'] as const
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number]

function parseKey(v: string | undefined): Buffer | null {
  if (!v) return null
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64')
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64 (e.g. openssl rand -hex 32)')
  return key
}

/**
 * Settings a production server must have. Problems are listed by name only (never values), and
 * the server does not start until they are fixed.
 */
export function configProblems(c: ServerConfig): string[] {
  if (c.environment !== 'production') return []
  const p: string[] = []
  if (!c.setupKey) p.push('SETUP_KEY must be set')
  if (!c.secureCookies) p.push('COOKIE_SECURE must be true (serve the site over HTTPS)')
  if (!c.db.password) p.push('DB_PASSWORD must be set')
  if (['root', 'admin'].includes(c.db.user)) p.push('DB_USER must be the application’s own account, not an administrator account')
  if (c.demoDatabase) p.push('DEMO_ENABLED must be false')
  if (!c.backupKey) p.push('BACKUP_ENCRYPTION_KEY must be set (backups are encrypted at rest)')
  if (c.restoreTestDatabase && c.restoreTestDatabase === c.db.database) p.push('RESTORE_TEST_DB_NAME must not be the farm database')
  return p
}

function env(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v !== undefined && v !== '') return v
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required environment variable ${name} (see .env.example)`)
}

const flag = (name: string, fallback: boolean) => {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

export function loadConfig(): ServerConfig {
  const database = env('DB_NAME', 'poultry_farm')
  if (!/^[A-Za-z0-9_]{1,48}$/.test(database)) throw new Error('DB_NAME may only contain letters, digits and _')
  const dataDir = path.resolve(env('DATA_DIR', 'data'))
  const environment = env('APP_ENV', 'development') as AppEnvironment
  if (!(APP_ENVIRONMENTS as readonly string[]).includes(environment)) throw new Error('APP_ENV must be development, staging or production')
  const restoreDb = process.env['RESTORE_TEST_DB_NAME']
  if (restoreDb && !/^[A-Za-z0-9_]{1,48}$/.test(restoreDb)) throw new Error('RESTORE_TEST_DB_NAME may only contain letters, digits and _')
  return {
    port: Number(env('PORT', '3000')),
    host: env('HOST', '0.0.0.0'),
    db: {
      host: env('DB_HOST', 'localhost'),
      port: Number(env('DB_PORT', '3306')),
      user: env('DB_USER', 'poultry'),
      password: env('DB_PASSWORD', ''),
      database,
      connectionLimit: Number(env('DB_CONNECTIONS', '10'))
    },
    demoDatabase: flag('DEMO_ENABLED', true) ? `${database}_demo` : null,
    backupDir: path.resolve(env('BACKUP_DIR', path.join(dataDir, 'backups'))),
    setupKey: process.env['SETUP_KEY'] || null,
    sessionIdleHours: Number(env('SESSION_IDLE_HOURS', '12')),
    secureCookies: flag('COOKIE_SECURE', false),
    trustProxy: Number(env('TRUST_PROXY', '0')),
    maxUploadMb: Number(env('MAX_UPLOAD_MB', '512')),
    environment,
    releaseSha: process.env['RELEASE_SHA']?.slice(0, 40) || null,
    backupKey: parseKey(process.env['BACKUP_ENCRYPTION_KEY']),
    restoreTestDatabase: process.env['RESTORE_TEST_DB_NAME'] || null,
    authRequestsPerMinute: Number(env('AUTH_REQUESTS_PER_MINUTE', '10'))
  }
}
