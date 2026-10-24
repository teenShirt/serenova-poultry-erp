import { addDays, isIsoDate, isValidTimezone, todayInTimezone } from '@shared/dates'
import type { InventoryCategory, Language } from '@shared/types'
import type { AnonCtx, Ctx } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { createUserRaw, toSessionUser } from './auth'
import { ensureRoles } from './roles'
import { insertCageRaw } from './cages'
import { getOrCreateBatch, insertItemRaw } from './inventory'
import { saveSettings } from './settings'

export interface SetupInput {
  farmName: string
  farmLocation: string
  timezone: string
  language: Language
  /** First business date that will be recorded; opening stock is dated the day before it. */
  startDate: string
  cages: { code: string; name: string; initialHens: number; hasWaterMeter: boolean }[]
  admin: { email: string; displayName: string; password: string }
  inventory: {
    category: InventoryCategory
    name: string
    unit: string
    lowStockThreshold: number | null
    openingBalance: number
    batchNo: string | null
    expiryDate: string | null
  }[]
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'farm'
  )
}

/** A unique organization code (used when staff sign themselves up), from the organization's name. */
async function uniqueOrgCode(anon: AnonCtx, name: string) {
  const base = slug(name)
  for (let n = 1; ; n++) {
    const code = n === 1 ? base : `${base}-${n}`
    if (!(await anon.db.prepare('SELECT 1 AS x FROM organizations WHERE code = ?').get(code))) return code
  }
}

export interface NewOrganization {
  organizationId: number
  organizationCode: string
  farmId: number
  adminId: number
  recoveryCode: string
}

/**
 * Creates an organization with its first farm, administrator, cages and starting stock, in one
 * transaction so a failure leaves nothing half-created.
 */
export async function createOrganization(anon: AnonCtx, s: SetupInput): Promise<NewOrganization> {
  assert(s.farmName.trim(), 'required_field', { field: 'farmName' })
  assert(isValidTimezone(s.timezone), 'invalid_timezone')
  const today = todayInTimezone(s.timezone, anon.now())
  assert(isIsoDate(s.startDate) && s.startDate <= today && s.startDate >= addDays(today, -60), 'invalid_start_date')
  assert(s.cages.length > 0 && s.cages.length <= 200, 'no_active_cages')
  return anon.db.transaction(async () => {
    const at = anon.now().toISOString()
    const name = s.farmName.trim()
    const code = await uniqueOrgCode(anon, name)
    const org = (await anon.db.prepare('INSERT INTO organizations (code, name, created_at) VALUES (?, ?, ?)').run(code, name, at)).lastInsertRowid
    const farm = (
      await anon.db
        .prepare('INSERT INTO farms (organization_id, code, name, location, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(org, 'main', name, s.farmLocation.trim() || null, at)
    ).lastInsertRowid
    const ctx: Ctx = { db: anon.db, now: anon.now, org, farm, user: null }
    await ensureRoles(anon.db, org)
    const adminRole = (await anon.db.prepare('SELECT id FROM roles WHERE organization_id = ? AND is_admin = 1').get(org)) as { id: number }
    const { id: adminId, recoveryCode } = await createUserRaw(ctx, { ...s.admin, roleId: adminRole.id })
    const adminRow = (await anon.db.prepare('SELECT * FROM users WHERE id = ?').get(adminId)) as Parameters<typeof toSessionUser>[1]
    const actor: Ctx = { ...ctx, user: await toSessionUser(ctx, adminRow) }
    await saveSettings(actor, {
      farmName: name,
      farmLocation: s.farmLocation.trim(),
      timezone: s.timezone,
      language: s.language,
      setupComplete: true
    })
    for (const [i, c] of s.cages.entries()) {
      await insertCageRaw(actor, {
        code: c.code,
        name: c.name,
        initialHens: c.initialHens,
        capacity: null,
        hasWaterMeter: c.hasWaterMeter,
        active: true,
        sortOrder: i + 1,
        notes: null
      })
    }
    // Opening balances are dated the day before the first business date so they carry into that day.
    const openingDate = addDays(s.startDate, -1)
    for (const inv of s.inventory) {
      const itemId = await insertItemRaw(actor, {
        category: inv.category,
        name: inv.name,
        unit: inv.unit,
        lowStockThreshold: inv.lowStockThreshold,
        active: true,
        notes: null
      })
      if (inv.openingBalance > 0) {
        const batchId = inv.batchNo ? await getOrCreateBatch(actor, itemId, inv.batchNo, inv.expiryDate) : null
        await ctx.db
          .prepare(
            `INSERT INTO inventory_transactions (organization_id, item_id, batch_id, txn_date, type, quantity, notes, recorded_by, created_at)
             VALUES (?, ?, ?, ?, 'opening', ?, 'Opening balance (setup)', ?, ?)`
          )
          .run(org, itemId, batchId, openingDate, inv.openingBalance, adminId, at)
      }
    }
    await audit(actor, { action: 'complete_setup', entity: 'settings', details: { farm: name, cages: s.cages.length } })
    return { organizationId: org, organizationCode: code, farmId: farm, adminId, recoveryCode }
  })()
}

/** The platform has been set up once its first organization exists. */
export async function platformHasOrganizations(anon: Pick<AnonCtx, 'db'>): Promise<boolean> {
  return !!(await anon.db.prepare('SELECT 1 AS x FROM organizations LIMIT 1').get())
}

/** First-run setup of a new installation: creates its first organization. Later organizations are added by the platform owner. */
export async function completeSetup(anon: AnonCtx, s: SetupInput): Promise<NewOrganization> {
  assert(!(await platformHasOrganizations(anon)), 'setup_already_done')
  return createOrganization(anon, s)
}
