import type { Cage } from '@shared/types'
import { type Ctx, requireAdmin } from '../context'
import { assert } from '../errors'
import { audit } from './audit'

const cols = `id, code, name, initial_hens AS initialHens, capacity, has_water_meter AS hasWaterMeter,
  active, sort_order AS sortOrder, notes`

function toCage(r: Record<string, unknown>): Cage {
  return { ...(r as unknown as Cage), hasWaterMeter: !!r.hasWaterMeter, active: !!r.active }
}

export async function listCages(ctx: Pick<Ctx, 'db'>, includeInactive = true): Promise<Cage[]> {
  const rows = (await ctx.db
    .prepare(`SELECT ${cols} FROM cages ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, code`)
    .all()) as Record<string, unknown>[]
  return rows.map(toCage)
}

export async function getCage(ctx: Pick<Ctx, 'db'>, id: number): Promise<Cage> {
  const r = (await ctx.db.prepare(`SELECT ${cols} FROM cages WHERE id = ?`).get(id)) as Record<string, unknown> | undefined
  assert(r, 'cage_not_found')
  return toCage(r)
}

export interface CageInput {
  code: string
  name: string
  initialHens: number
  capacity: number | null
  hasWaterMeter: boolean
  active: boolean
  sortOrder: number
  notes: string | null
}

/** Inserts a cage without a permission check (used by the first-run wizard). */
export async function insertCageRaw(ctx: Ctx, c: CageInput): Promise<number> {
  const code = c.code.trim()
  assert(code.length > 0, 'required_field', { field: 'code' })
  const dup = await ctx.db.prepare('SELECT 1 FROM cages WHERE code = ?').get(code)
  assert(!dup, 'cage_code_taken')
  const info = await ctx.db
    .prepare(
      `INSERT INTO cages (code, name, initial_hens, capacity, has_water_meter, active, sort_order, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      code,
      c.name.trim() || code,
      c.initialHens,
      c.capacity,
      c.hasWaterMeter ? 1 : 0,
      c.active ? 1 : 0,
      c.sortOrder,
      c.notes,
      ctx.now().toISOString()
    )
  const id = Number(info.lastInsertRowid)
  await audit(ctx, { action: 'create', entity: 'cage', entityId: id, details: c })
  return id
}

export async function createCage(ctx: Ctx, c: CageInput) {
  requireAdmin(ctx)
  return ctx.db.transaction(async () => insertCageRaw(ctx, c))()
}

/** Whether any day has been opened for this cage (its starting flock is then historical). */
export async function cageHasHistory(ctx: Pick<Ctx, 'db'>, cageId: number): Promise<boolean> {
  return !!await ctx.db.prepare('SELECT 1 FROM cage_days WHERE cage_id = ? LIMIT 1').get(cageId)
}

export async function updateCage(ctx: Ctx, id: number, c: CageInput, reason: string | null) {
  requireAdmin(ctx)
  await ctx.db.transaction(async () => {
    const before = await getCage(ctx, id)
    const dup = await ctx.db.prepare('SELECT 1 FROM cages WHERE code = ? AND id <> ?').get(c.code.trim(), id)
    assert(!dup, 'cage_code_taken')
    // Live counts come from daily records; changing the starting flock after days exist would rewrite history.
    assert(before.initialHens === c.initialHens || !await cageHasHistory(ctx, id), 'initial_hens_locked')
    await ctx.db
      .prepare(
        `UPDATE cages SET code = ?, name = ?, initial_hens = ?, capacity = ?, has_water_meter = ?, active = ?,
           sort_order = ?, notes = ? WHERE id = ?`
      )
      .run(
        c.code.trim(),
        c.name.trim() || c.code.trim(),
        c.initialHens,
        c.capacity,
        c.hasWaterMeter ? 1 : 0,
        c.active ? 1 : 0,
        c.sortOrder,
        c.notes,
        id
      )
    await audit(ctx, { action: 'update', entity: 'cage', entityId: id, reason, details: { before, after: c } })
  })()
}
