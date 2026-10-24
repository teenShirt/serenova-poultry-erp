import type { Cage } from '@shared/types'
import { type Ctx } from '../context'
import { assert } from '../errors'
import { audit } from './audit'
import { requirePermission } from './roles'

const cols = `id, code, name, initial_hens AS initialHens, capacity, has_water_meter AS hasWaterMeter,
  active, sort_order AS sortOrder, notes`

function toCage(r: Record<string, unknown>): Cage {
  return { ...(r as unknown as Cage), hasWaterMeter: !!r.hasWaterMeter, active: !!r.active }
}

/** The cages of the context's farm. */
export async function listCages(ctx: Pick<Ctx, 'db' | 'org' | 'farm'>, includeInactive = true): Promise<Cage[]> {
  const rows = (await ctx.db
    .prepare(`SELECT ${cols} FROM cages WHERE organization_id = ? AND farm_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY sort_order, code`)
    .all(ctx.org, ctx.farm)) as Record<string, unknown>[]
  return rows.map(toCage)
}

/** A cage of the context's farm; any other id is "not found". */
export async function getCage(ctx: Pick<Ctx, 'db' | 'org' | 'farm'>, id: number): Promise<Cage> {
  const r = (await ctx.db.prepare(`SELECT ${cols} FROM cages WHERE id = ? AND organization_id = ? AND farm_id = ?`).get(id, ctx.org, ctx.farm)) as
    | Record<string, unknown>
    | undefined
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

/** Inserts a cage into the context's farm without a permission check (used by the first-run wizard). */
export async function insertCageRaw(ctx: Ctx, c: CageInput): Promise<number> {
  const code = c.code.trim()
  assert(code.length > 0, 'required_field', { field: 'code' })
  const dup = await ctx.db.prepare('SELECT 1 AS x FROM cages WHERE farm_id = ? AND code = ?').get(ctx.farm, code)
  assert(!dup, 'cage_code_taken')
  const info = await ctx.db
    .prepare(
      `INSERT INTO cages (organization_id, farm_id, code, name, initial_hens, capacity, has_water_meter, active, sort_order, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ctx.org,
      ctx.farm,
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
  requirePermission(ctx, 'cages.manage')
  return ctx.db.transaction(async () => insertCageRaw(ctx, c))()
}

/** Whether any day has been opened for this cage (its starting flock is then historical). */
export async function cageHasHistory(ctx: Pick<Ctx, 'db' | 'org'>, cageId: number): Promise<boolean> {
  return !!(await ctx.db.prepare('SELECT 1 AS x FROM cage_days WHERE organization_id = ? AND cage_id = ? LIMIT 1').get(ctx.org, cageId))
}

export async function updateCage(ctx: Ctx, id: number, c: CageInput, reason: string | null) {
  requirePermission(ctx, 'cages.manage')
  await ctx.db.transaction(async () => {
    const before = await getCage(ctx, id)
    const dup = await ctx.db.prepare('SELECT 1 AS x FROM cages WHERE farm_id = ? AND code = ? AND id <> ?').get(ctx.farm, c.code.trim(), id)
    assert(!dup, 'cage_code_taken')
    // Live counts come from daily records; changing the starting flock after days exist would rewrite history.
    assert(before.initialHens === c.initialHens || !(await cageHasHistory(ctx, id)), 'initial_hens_locked')
    await ctx.db
      .prepare(
        `UPDATE cages SET code = ?, name = ?, initial_hens = ?, capacity = ?, has_water_meter = ?, active = ?,
           sort_order = ?, notes = ? WHERE id = ? AND organization_id = ?`
      )
      .run(c.code.trim(), c.name.trim() || c.code.trim(), c.initialHens, c.capacity, c.hasWaterMeter ? 1 : 0, c.active ? 1 : 0, c.sortOrder, c.notes, id, ctx.org)
    await audit(ctx, { action: 'update', entity: 'cage', entityId: id, reason, details: { before, after: c } })
  })()
}
