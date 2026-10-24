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
    maxUploadMb: Number(env('MAX_UPLOAD_MB', '512'))
  }
}
