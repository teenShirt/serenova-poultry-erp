import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '@shared/i18n/en'
import { si } from '@shared/i18n/si'
import { formatDate, formatDateTime, translate } from '@shared/i18n'

const root = path.resolve(import.meta.dirname, '..')
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name)
    return d.isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(d.name) ? [p] : []
  })
}
const all = sources(path.join(root, 'src'))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n')
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('Sinhala and English translations', () => {
  it('have exactly the same keys, all non-empty', () => {
    expect(Object.keys(si).sort()).toEqual(Object.keys(en).sort())
    for (const [k, v] of Object.entries(si)) expect(v.trim(), k).not.toBe('')
  })

  it('use the same placeholders in both languages', () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(si[k]), k).toEqual(placeholders(en[k]))
    }
  })

  it('Sinhala strings are actually Sinhala (not copied English)', () => {
    const sinhala = /[\u0D80-\u0DFF]/
    const allowedLatin = ['report.method'] // contains formula symbols only
    const english = Object.entries(si).filter(([k, v]) => !sinhala.test(v) && !allowedLatin.includes(k) && !/^[\s\W\d]*$/.test(v))
    expect(english.map(([k]) => k)).toEqual([])
  })

  it('every literal t("…") key used in the UI exists', () => {
    const used = new Set([...all.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'\s*[,)]/g)].map((m) => m[1]))
    const missing = [...used].filter((k) => !(k in en) && !k.endsWith('.'))
    expect(missing).toEqual([])
  })

  it('every error code raised by the main process has a message', () => {
    const codes = new Set([
      ...[...all.matchAll(/new AppError\(\s*'(\w+)'/g)].map((m) => m[1]),
      ...[...all.matchAll(/assert\([^;]*?,\s*'(\w+)'(?:,|\))/g)].map((m) => m[1])
    ])
    const missing = [...codes].filter((c) => !(`err.${c}` in en))
    expect(missing).toEqual([])
  })

  it('every day-check and alert code has a message', () => {
    const days = fs.readFileSync(path.join(root, 'src/server/services/days.ts'), 'utf8')
    const issueCodes = [...days.matchAll(/add\(\s*'(\w+)'/g)].map((m) => m[1])
    expect(issueCodes.length).toBeGreaterThan(10)
    expect(issueCodes.filter((c) => !(`issue.${c}` in en))).toEqual([])
    const analytics = fs.readFileSync(path.join(root, 'src/server/services/analytics.ts'), 'utf8')
    const alertCodes = [...analytics.matchAll(/code: '(\w+)'/g)].map((m) => m[1])
    const fromIssues = ['high_mortality', 'production_drop', 'water_change', 'negative_stock', 'feed_inconsistent', 'transfer_mismatch']
    expect([...alertCodes, ...fromIssues].filter((c) => !(`alert.${c}` in en))).toEqual([])
  })

  it('fills placeholders and falls back to English for unknown keys', () => {
    expect(translate('en', 'bak.done', { path: 'x.pfmbackup' })).toBe('Backup saved: x.pfmbackup')
    expect(translate('si', 'setup.totalHens', { count: '10,000' })).toBe('මුළු කිකිළියන්: 10,000')
    expect(translate('si', 'no.such.key')).toBe('no.such.key')
  })

  it('formats dates in both languages', () => {
    expect(formatDate('si', '2026-10-12', { year: 'numeric', month: 'long', day: 'numeric' })).toBe('2026 ඔක්තෝබර් 12')
    expect(formatDate('si', '2026-10-12', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })).toBe('2026 ඔක්තෝබර් 12, සඳුදා')
    expect(formatDate('en', '2026-10-12', { year: 'numeric', month: 'long', day: 'numeric' })).toBe('12 October 2026')
    expect(formatDateTime('si', '2026-10-12T02:30:00Z', 'Asia/Colombo')).toBe('2026 ඔක්තෝබර් 12 08:00')
  })
})

describe('keys built at runtime', () => {
  it('every duty, menu entry, quick action and database table has text in both languages', async () => {
    const { DUTIES } = await import('@shared/types')
    const { DATA_TABLES } = await import('../src/server/db/migrations')
    const app = fs.readFileSync(path.join(root, 'src/client/src/App.tsx'), 'utf8')
    const tables = DATA_TABLES.map((t) => 'table.' + t)
    const keys = [
      ...DUTIES.flatMap((d) => [`duty.${d}`, `duty.${d}.hint`]),
      ...[...app.matchAll(/'((?:navg|nav|quick)\.[a-zA-Z]+)'/g)].map((m) => m[1]),
      ...tables,
      ...['cash', 'bank', 'cheque', 'other'].map((m) => `sal.method.${m}`),
      ...['paid', 'partial', 'unpaid'].map((s) => `sal.status.${s}`)
    ]
    expect(tables.length).toBeGreaterThan(20)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })
})
