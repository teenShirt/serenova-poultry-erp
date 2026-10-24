import type { Party } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { assert } from '../errors'
import { audit } from './audit'

/** Suppliers (feed mills, pharmacies) and customers (egg buyers) share the same simple record. */
export type PartyKind = 'supplier' | 'customer'
const TABLE: Record<PartyKind, string> = { supplier: 'suppliers', customer: 'customers' }

export interface PartyInput {
  id: number | null
  name: string
  phone: string | null
  address: string | null
  notes: string | null
  active: boolean
}

export async function listParties(ctx: Pick<Ctx, 'db'>, kind: PartyKind): Promise<Party[]> {
  return (
    (await ctx.db
      .prepare(`SELECT id, name, phone, address, notes, active FROM ${TABLE[kind]} ORDER BY active DESC, name`)
      .all()) as (Omit<Party, 'active'> & { active: number })[]
  ).map((p) => ({ ...p, active: !!p.active }))
}

export async function saveParty(ctx: Ctx, kind: PartyKind, p: PartyInput): Promise<number> {
  requireUser(ctx)
  const name = p.name.trim()
  assert(name.length >= 2, 'required_field', { field: 'name' })
  const table = TABLE[kind]
  return ctx.db.transaction(async () => {
    const dup = (await ctx.db.prepare(`SELECT id FROM ${table} WHERE name = ? AND NOT (id <=> ?)`).get(name, p.id)) as { id: number } | undefined
    assert(!dup, 'name_taken')
    const vals = [name, p.phone?.trim() || null, p.address?.trim() || null, p.notes?.trim() || null, p.active ? 1 : 0]
    if (p.id) {
      const info = await ctx.db.prepare(`UPDATE ${table} SET name = ?, phone = ?, address = ?, notes = ?, active = ? WHERE id = ?`).run(...vals, p.id)
      assert(info.changes === 1, 'not_found')
      await audit(ctx, { action: 'update', entity: kind, entityId: p.id, details: p })
      return p.id
    }
    const id = Number(
      (await ctx.db.prepare(`INSERT INTO ${table} (name, phone, address, notes, active, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(...vals, ctx.now().toISOString())).lastInsertRowid
    )
    await audit(ctx, { action: 'create', entity: kind, entityId: id, details: p })
    return id
  })()
}
