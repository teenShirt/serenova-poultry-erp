import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { BackupData } from './services/backup'

interface Upload {
  file: string
  name: string
  userId: number
  data?: BackupData
  expires: number
}

/**
 * Backup files uploaded for restoring. The browser gets a one-time token, never a server path;
 * a token can only be used by the administrator who uploaded the file, within 30 minutes.
 */
export class RestoreTokens {
  private readonly items = new Map<string, Upload>()

  add(u: Omit<Upload, 'expires'>): string {
    this.sweep()
    const token = randomUUID()
    this.items.set(token, { ...u, expires: Date.now() + 30 * 60_000 })
    return token
  }

  take(token: string, userId: number): Upload | null {
    this.sweep()
    const u = this.items.get(token)
    if (!u || u.userId !== userId) return null
    this.items.delete(token)
    return u
  }

  private sweep() {
    const now = Date.now()
    for (const [k, u] of this.items) {
      if (u.expires < now) {
        fs.rmSync(u.file, { force: true })
        this.items.delete(k)
      }
    }
  }
}
