import type { Language } from '../types'
import { en, type TranslationKey } from './en'
import { si } from './si'

export type { TranslationKey }
export const dictionaries: Record<Language, Record<TranslationKey, string>> = { en, si }

export type Params = Record<string, string | number | null | undefined>

export function translate(lang: Language, key: string, params: Params = {}): string {
  const dict = dictionaries[lang] ?? en
  const template = (dict as Record<string, string>)[key] ?? (en as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, p: string) => {
    const v = params[p]
    return v === undefined || v === null ? '' : String(v)
  })
}

export function hasKey(key: string): key is TranslationKey {
  return key in en
}

/** Locale used for number and date formatting. Sinhala uses Sri Lankan conventions. */
export function localeFor(lang: Language): string {
  return lang === 'si' ? 'si-LK' : 'en-GB'
}

/** Sri Lanka uses Western digits in both languages, so numbers are formatted the same way. */
export function formatNumber(_lang: Language, n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n)
}

const SI_MONTHS = ['ජනවාරි', 'පෙබරවාරි', 'මාර්තු', 'අප්‍රේල්', 'මැයි', 'ජූනි', 'ජූලි', 'අගෝස්තු', 'සැප්තැම්බර්', 'ඔක්තෝබර්', 'නොවැම්බර්', 'දෙසැම්බර්']
const SI_WEEKDAYS = ['ඉරිදා', 'සඳුදා', 'අඟහරුවාදා', 'බදාදා', 'බ්‍රහස්පතින්දා', 'සිකුරාදා', 'සෙනසුරාදා']

/**
 * Sinhala dates are built here rather than with Intl, because Electron's bundled ICU data
 * does not always include Sinhala month names. Format: "2026 ඔක්තෝබර් 12" (optionally with weekday).
 */
function formatSinhalaDate(y: number, m: number, d: number, opts: Intl.DateTimeFormatOptions) {
  const parts: string[] = []
  if (opts.year) parts.push(String(y))
  if (opts.month) parts.push(opts.month === 'numeric' || opts.month === '2-digit' ? String(m).padStart(2, '0') : SI_MONTHS[m - 1])
  if (opts.day) parts.push(String(d))
  const date = parts.join(' ')
  return opts.weekday ? `${date}, ${SI_WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}` : date
}

export function formatDate(lang: Language, iso: string, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  if (!y) return iso
  if (lang === 'si') return formatSinhalaDate(y, m, d, opts)
  try {
    return new Intl.DateTimeFormat(localeFor(lang), { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
  } catch {
    return iso
  }
}

export function formatDateTime(lang: Language, iso: string | null, timeZone: string): string {
  if (!iso) return '—'
  if (lang === 'si') {
    try {
      const local = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
      const [datePart, timePart] = local.split(', ')
      return `${formatDate('si', datePart)} ${timePart}`
    } catch {
      return iso
    }
  }
  try {
    return new Intl.DateTimeFormat(localeFor(lang), {
      hourCycle: 'h23',
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso))
  } catch {
    return iso
  }
}
