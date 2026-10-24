import { addDays, isIsoDate, isValidTimezone, todayInTimezone } from '@shared/dates'
import type { InventoryCategory, Language } from '@shared/types'
import type { Ctx } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { countUsers, createUserRaw } from './auth'
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
  admin: { username: string; displayName: string; password: string }
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

/**
 * First-run setup. Allowed only while the database has no users, and done in one
 * transaction so a failed setup leaves nothing half-created.
 */
export async function completeSetup(ctx: Ctx, s: SetupInput): Promise<{ adminId: number; recoveryCode: string }> {
  assert(await countUsers(ctx) === 0, 'setup_already_done')
  assert(s.farmName.trim(), 'required_field', { field: 'farmName' })
  assert(isValidTimezone(s.timezone), 'invalid_timezone')
  const today = todayInTimezone(s.timezone, ctx.now())
  assert(isIsoDate(s.startDate) && s.startDate <= today && s.startDate >= addDays(today, -60), 'invalid_start_date')
  assert(s.cages.length > 0 && s.cages.length <= 200, 'no_active_cages')
  return ctx.db.transaction(async () => {
    const { id: adminId, recoveryCode } = await createUserRaw(ctx, { ...s.admin, role: 'admin' })
    const actor: Ctx = { ...ctx, user: { id: adminId, username: s.admin.username, displayName: s.admin.displayName, role: 'admin' } }
    await saveSettings(actor, {
      farmName: s.farmName.trim(),
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
            `INSERT INTO inventory_transactions (item_id, batch_id, txn_date, type, quantity, notes, recorded_by, created_at)
             VALUES (?, ?, ?, 'opening', ?, 'Opening balance (setup)', ?, ?)`
          )
          .run(itemId, batchId, openingDate, inv.openingBalance, adminId, ctx.now().toISOString())
      }
    }
    await audit(actor, { action: 'complete_setup', entity: 'settings', details: { farm: s.farmName, cages: s.cages.length } })
    return { adminId, recoveryCode }
  })()
}
