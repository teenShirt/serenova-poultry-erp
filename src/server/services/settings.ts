import type { FarmSettings } from '@shared/types'
import { DEFAULT_STAGES } from '@shared/flocks'
import type { Ctx } from '../context'

export const DEFAULT_SETTINGS: FarmSettings = {
  farmName: 'My Poultry Farm',
  farmLocation: '',
  timezone: 'Asia/Colombo',
  language: 'si',
  productionDenominator: 'average',
  mortalityDenominator: 'opening',
  expectedEggSessions: ['morning', 'evening'],
  productionDropPct: 10,
  baselineDays: 7,
  mortalityAlertPct: 0.1,
  waterChangePct: 30,
  medicineExpiryWarnDays: 30,
  medicineUnits: ['ml', 'L', 'g', 'kg', 'tablets', 'doses', 'sachets'],
  backupEnabled: true,
  backupIntervalHours: 24,
  backupRetention: 14,
  backupFolder: null,
  allowSignup: true,
  autoCheckUpdates: true,
  currency: 'Rs.',
  productionStages: DEFAULT_STAGES,
  grnApprovalRequired: false,
  waterTracking: true,
  feedGramsPerBird: 110,
  setupComplete: false
}

/** The organization's settings (defaults for anything not saved yet). */
export async function getSettings(ctx: Pick<Ctx, 'db' | 'org'>): Promise<FarmSettings> {
  const rows = (await ctx.db.prepare('SELECT `key`, value FROM app_settings WHERE organization_id = ?').all(ctx.org)) as { key: string; value: string }[]
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) {
      try {
        s[r.key] = JSON.parse(r.value)
      } catch {
        /* keep the default for a corrupt value */
      }
    }
  }
  return s as unknown as FarmSettings
}

/** Writes only known keys. Returns the changed keys with old/new values for auditing. */
export async function saveSettings(ctx: Ctx, patch: Partial<FarmSettings>) {
  const current = (await getSettings(ctx)) as unknown as Record<string, unknown>
  const changed: Record<string, { from: unknown; to: unknown }> = {}
  const stmt = ctx.db.prepare(
    `INSERT INTO app_settings (organization_id, \`key\`, value, updated_at) VALUES (?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE value = new.value, updated_at = new.updated_at`
  )
  const at = ctx.now().toISOString()
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS) || v === undefined) continue
    const before = current[k]
    if (JSON.stringify(before) === JSON.stringify(v)) continue
    await stmt.run(ctx.org, k, JSON.stringify(v), at)
    changed[k] = { from: before, to: v }
  }
  return changed
}
