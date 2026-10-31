import { isProductionDrop, mean, percentChange, round } from '@shared/calc'
import { addDays, daysBetween, isIsoDate, todayInTimezone } from '@shared/dates'
import type { CageDaySummary, DayIssue, DayOverview, DayStatus, FarmSettings, StartDayPreview } from '@shared/types'
import { type Ctx, requireUser } from '../context'
import { AppError, assert } from '../errors'
import { audit } from './audit'
import { listCages } from './cages'
import { balances } from './inventory'
import { getSettings } from './settings'
import { loadCageDayStats, sumCages } from './stats'
import { requirePermission } from './roles'

export interface DayRow {
  id: number
  business_date: string
  status: 'in_progress' | 'closed'
  opened_by: number | null
  opened_at: string
  closed_by: number | null
  closed_at: string | null
  manager_comment: string | null
  amendment_open: number
}

/** The context farm's day for a date. */
export async function getDay(ctx: Pick<Ctx, 'db' | 'org' | 'farm'>, date: string): Promise<DayRow | undefined> {
  return (await ctx.db.prepare('SELECT * FROM farm_days WHERE organization_id = ? AND farm_id = ? AND business_date = ?').get(ctx.org, ctx.farm, date)) as
    | DayRow
    | undefined
}

export async function farmToday(ctx: Pick<Ctx, 'db' | 'org' | 'now'>): Promise<string> {
  return todayInTimezone((await getSettings(ctx)).timezone, ctx.now())
}

/**
 * Returns the day if records on it may be changed by the current user:
 * open days for everyone; closed days only while an amendment is open, and only for admins.
 */
export async function requireWritableDay(ctx: Ctx, date: string): Promise<DayRow> {
  requireUser(ctx)
  assert(isIsoDate(date), 'invalid_date')
  const day = await getDay(ctx, date)
  if (!day) throw new AppError('day_not_started', { date })
  if (day.status === 'closed') {
    if (!day.amendment_open) throw new AppError('day_closed', { date })
    requirePermission(ctx, 'day.amend')
  }
  return day
}

/** Closing hens of a cage-day: opening (carried + adjustment) plus/minus flock movements. */
export async function cageDayClosing(ctx: Pick<Ctx, 'db' | 'org'>, dayId: number, cageId: number): Promise<number | null> {
  const cd = (await ctx.db
    .prepare('SELECT carried_hens + opening_adjustment AS opening FROM cage_days WHERE organization_id = ? AND day_id = ? AND cage_id = ?')
    .get(ctx.org, dayId, cageId)) as { opening: number } | undefined
  if (!cd) return null
  const m = (await ctx.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('addition','transfer_in') THEN quantity ELSE -quantity END), 0) AS delta
       FROM flock_movements WHERE organization_id = ? AND day_id = ? AND cage_id = ?`
    )
    .get(ctx.org, dayId, cageId)) as { delta: number }
  return cd.opening + m.delta
}

/** Hens carried into `date`: the closing count of the cage's most recent earlier day, or its starting flock. */
export async function carriedFor(ctx: Pick<Ctx, 'db' | 'org' | 'farm'>, cageId: number, date: string): Promise<number> {
  const prev = (await ctx.db
    .prepare(
      `SELECT d.id FROM cage_days cd JOIN farm_days d ON d.id = cd.day_id
       WHERE cd.organization_id = ? AND d.farm_id = ? AND cd.cage_id = ? AND d.business_date < ? ORDER BY d.business_date DESC LIMIT 1`
    )
    .get(ctx.org, ctx.farm, cageId, date)) as { id: number } | undefined
  if (prev) return (await cageDayClosing(ctx, prev.id, cageId)) ?? 0
  const cage = (await ctx.db.prepare('SELECT initial_hens FROM cages WHERE organization_id = ? AND id = ?').get(ctx.org, cageId)) as { initial_hens: number }
  return cage.initial_hens
}

/** Throws if a cage-day would end with a negative number of hens. */
export async function assertCageDayValid(ctx: Ctx, dayId: number, cageId: number, date: string) {
  const closing = await cageDayClosing(ctx, dayId, cageId)
  if (closing !== null && closing < 0) {
    const cage = (await ctx.db.prepare('SELECT name FROM cages WHERE organization_id = ? AND id = ?').get(ctx.org, cageId)) as { name: string }
    throw new AppError('negative_hens', { cage: cage.name, date })
  }
}

/**
 * Re-derives carried-forward hen counts for every day after `date`, so a correction on an
 * earlier day flows through to later opening balances. Fails (rolling back the caller's
 * transaction) if any later day would go negative.
 */
export async function recalcFrom(ctx: Ctx, date: string): Promise<number> {
  const later = (await ctx.db
    .prepare('SELECT id, business_date FROM farm_days WHERE organization_id = ? AND farm_id = ? AND business_date > ? ORDER BY business_date')
    .all(ctx.org, ctx.farm, date)) as { id: number; business_date: string }[]
  let changed = 0
  const update = ctx.db.prepare('UPDATE cage_days SET carried_hens = ? WHERE id = ?')
  for (const d of later) {
    const cds = (await ctx.db
      .prepare('SELECT id, cage_id, carried_hens, opening_adjustment FROM cage_days WHERE organization_id = ? AND day_id = ?')
      .all(ctx.org, d.id)) as { id: number; cage_id: number; carried_hens: number; opening_adjustment: number }[]
    for (const cd of cds) {
      const carried = await carriedFor(ctx, cd.cage_id, d.business_date)
      if (carried !== cd.carried_hens) {
        if (carried < 0 || carried + cd.opening_adjustment < 0) {
          const cage = (await ctx.db.prepare('SELECT name FROM cages WHERE organization_id = ? AND id = ?').get(ctx.org, cd.cage_id)) as { name: string }
          throw new AppError('negative_hens', { cage: cage.name, date: d.business_date })
        }
        await update.run(carried, cd.id)
        changed++
      }
      await assertCageDayValid(ctx, d.id, cd.cage_id, d.business_date)
    }
  }
  if (changed > 0) {
    await audit(ctx, { action: 'recalculate_openings', entity: 'farm_day', details: { after: date, cageDaysChanged: changed } })
  }
  return changed
}

/** Adds cage rows for active cages that were created after the day was opened. */
export async function ensureCageDays(ctx: Ctx, day: DayRow) {
  const missing = (await ctx.db
    .prepare(`SELECT id FROM cages WHERE organization_id = ? AND farm_id = ? AND active = 1 AND id NOT IN (SELECT cage_id FROM cage_days WHERE day_id = ?)`)
    .all(ctx.org, ctx.farm, day.id)) as { id: number }[]
  for (const c of missing) {
    await ctx.db
      .prepare('INSERT INTO cage_days (organization_id, day_id, cage_id, carried_hens) VALUES (?, ?, ?, ?)')
      .run(ctx.org, day.id, c.id, await carriedFor(ctx, c.id, day.business_date))
  }
}

export async function requireCageDay(ctx: Ctx, day: DayRow, cageId: number) {
  await ensureCageDays(ctx, day)
  const cd = await ctx.db.prepare('SELECT id FROM cage_days WHERE organization_id = ? AND day_id = ? AND cage_id = ?').get(ctx.org, day.id, cageId)
  assert(cd, 'cage_not_in_day')
}

async function previousDay(ctx: Pick<Ctx, 'db' | 'org' | 'farm'>, date: string) {
  return (await ctx.db
    .prepare('SELECT business_date, status FROM farm_days WHERE organization_id = ? AND farm_id = ? AND business_date < ? ORDER BY business_date DESC LIMIT 1')
    .get(ctx.org, ctx.farm, date)) as { business_date: string; status: 'in_progress' | 'closed' } | undefined
}

export async function previewStartDay(ctx: Ctx, date: string): Promise<StartDayPreview> {
  assert(isIsoDate(date), 'invalid_date')
  const exists = !!(await getDay(ctx, date))
  const prev = await previousDay(ctx, date)
  const later = await ctx.db
    .prepare('SELECT 1 AS x FROM farm_days WHERE organization_id = ? AND farm_id = ? AND business_date > ? LIMIT 1')
    .get(ctx.org, ctx.farm, date)
  const today = await farmToday(ctx)
  const warnings: string[] = []
  if (date > today) warnings.push('future_date')
  if (exists) warnings.push('already_started')
  if (prev && prev.status !== 'closed') warnings.push('previous_not_closed')
  const gapDays = prev ? daysBetween(prev.business_date, date) - 1 : 0
  if (gapDays > 0) warnings.push('gap_days')
  if (later) warnings.push('backfill')
  const cages: StartDayPreview['cages'] = []
  for (const c of await listCages(ctx, false)) {
    cages.push({ cageId: c.id, code: c.code, name: c.name, carried: await carriedFor(ctx, c.id, date) })
  }
  if (cages.length === 0) warnings.push('no_active_cages')
  return {
    date,
    exists,
    previous: prev ? { date: prev.business_date, status: prev.status } : null,
    gapDays,
    laterDayExists: !!later,
    cages,
    inventory: await balances(ctx, undefined, addDays(date, -1), { farmId: ctx.farm }),
    warnings
  }
}

export interface StartDayInput {
  date: string
  corrections: { cageId: number; opening: number; reason: string }[]
  acknowledgeWarnings: boolean
}

export async function startDay(ctx: Ctx, input: StartDayInput): Promise<DayOverview> {
  const user = requireUser(ctx)
  const { date } = input
  await ctx.db.transaction(async () => {
    const p = await previewStartDay(ctx, date)
    if (p.exists) throw new AppError('day_already_started', { date })
    if (p.warnings.includes('future_date')) throw new AppError('future_date')
    if (p.warnings.includes('no_active_cages')) throw new AppError('no_active_cages')
    if (p.laterDayExists) requirePermission(ctx, 'day.backfill')
    const needsAck = p.warnings.some((w) => ['previous_not_closed', 'gap_days', 'backfill'].includes(w))
    if (needsAck && !input.acknowledgeWarnings) throw new AppError('warnings_not_acknowledged')
    if (input.corrections.length > 0) requirePermission(ctx, 'day.correct_opening')

    const info = await ctx.db
      .prepare('INSERT INTO farm_days (organization_id, farm_id, business_date, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ctx.org, ctx.farm, date, 'in_progress', user.id, ctx.now().toISOString())
    const dayId = Number(info.lastInsertRowid)
    const ins = ctx.db.prepare(
      'INSERT INTO cage_days (organization_id, day_id, cage_id, carried_hens, opening_adjustment, opening_adjustment_reason) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const c of p.cages) {
      const corr = input.corrections.find((x) => x.cageId === c.cageId)
      let adj = 0
      let reason: string | null = null
      if (corr && corr.opening !== c.carried) {
        assert(Number.isInteger(corr.opening) && corr.opening >= 0, 'invalid_hen_count')
        assert(corr.reason.trim().length >= 3, 'reason_required')
        adj = corr.opening - c.carried
        reason = corr.reason.trim()
      }
      await ins.run(ctx.org, dayId, c.cageId, c.carried, adj, reason)
      if (reason) {
        await audit(ctx, {
          action: 'correct_opening',
          entity: 'cage_day',
          entityId: c.cageId,
          dayId,
          reason,
          details: { cage: c.name, carried: c.carried, opening: c.carried + adj }
        })
      }
    }
    await writeSnapshot(ctx, dayId, date, 'open', null)
    await audit(ctx, {
      action: 'start_day',
      entity: 'farm_day',
      entityId: dayId,
      dayId,
      details: { date, warnings: p.warnings }
    })
    if (p.laterDayExists) await recalcFrom(ctx, date)
  })()
  return getOverview(ctx, date)
}

/** Authorised correction of a cage's opening hen count (stored as an adjustment with a reason). */
export async function correctOpening(ctx: Ctx, date: string, cageId: number, opening: number, reason: string) {
  requirePermission(ctx, 'day.correct_opening')
  assert(Number.isInteger(opening) && opening >= 0, 'invalid_hen_count')
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, date)
    await requireCageDay(ctx, day, cageId)
    const cd = (await ctx.db
      .prepare('SELECT id, carried_hens, opening_adjustment FROM cage_days WHERE organization_id = ? AND day_id = ? AND cage_id = ?')
      .get(ctx.org, day.id, cageId)) as { id: number; carried_hens: number; opening_adjustment: number }
    const adj = opening - cd.carried_hens
    await ctx.db
      .prepare('UPDATE cage_days SET opening_adjustment = ?, opening_adjustment_reason = ? WHERE organization_id = ? AND id = ?')
      .run(adj, adj === 0 ? null : reason.trim(), ctx.org, cd.id)
    await assertCageDayValid(ctx, day.id, cageId, date)
    await audit(ctx, {
      action: 'correct_opening',
      entity: 'cage_day',
      entityId: cageId,
      dayId: day.id,
      reason: reason.trim(),
      details: { before: cd.carried_hens + cd.opening_adjustment, after: opening }
    })
    await recalcFrom(ctx, date)
  })()
}

export async function confirmMortality(ctx: Ctx, date: string, cageIds: number[]) {
  const user = requireUser(ctx)
  await ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, date)
    for (const cageId of cageIds) {
      await requireCageDay(ctx, day, cageId)
      await ctx.db
        .prepare(
          'UPDATE cage_days SET mortality_confirmed = 1, mortality_confirmed_by = ?, mortality_confirmed_at = ? WHERE organization_id = ? AND day_id = ? AND cage_id = ?'
        )
        .run(user.id, ctx.now().toISOString(), ctx.org, day.id, cageId)
    }
    await audit(ctx, { action: 'confirm_mortality', entity: 'cage_day', dayId: day.id, details: { cageIds } })
  })()
}

export async function confirmIssue(ctx: Ctx, date: string, cageId: number | null, key: string, reason: string) {
  const user = requirePermission(ctx, 'day.approve_issues')
  assert(reason.trim().length >= 3, 'reason_required')
  await ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, date)
    const issue = (await getOverview(ctx, date)).issues.find((i) => i.key === key && i.cageId === cageId)
    assert(issue && issue.confirmable, 'issue_not_confirmable')
    await ctx.db
      .prepare(
        `INSERT INTO day_confirmations (organization_id, day_id, cage_id, check_code, reason, confirmed_by, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE reason = new.reason,
           confirmed_by = new.confirmed_by, confirmed_at = new.confirmed_at`
      )
      .run(ctx.org, day.id, cageId ?? 0, key, reason.trim(), user.id, ctx.now().toISOString())
    await audit(ctx, { action: 'confirm_issue', entity: 'farm_day', entityId: day.id, dayId: day.id, reason, details: { key, cageId } })
  })()
}

export async function revokeConfirmation(ctx: Ctx, date: string, cageId: number | null, key: string) {
  requirePermission(ctx, 'day.approve_issues')
  await ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, date)
    await ctx.db
      .prepare('DELETE FROM day_confirmations WHERE organization_id = ? AND day_id = ? AND cage_id = ? AND check_code = ?')
      .run(ctx.org, day.id, cageId ?? 0, key)
    await audit(ctx, { action: 'revoke_confirmation', entity: 'farm_day', entityId: day.id, dayId: day.id, details: { key, cageId } })
  })()
}

function emptyCage(c: { cageId: number; code: string; name: string; carried: number }): CageDaySummary {
  return {
    cageId: c.cageId,
    code: c.code,
    name: c.name,
    carried: c.carried,
    adjustment: 0,
    adjustmentReason: null,
    opening: c.carried,
    movements: { deaths: 0, removals: 0, additions: 0, transfersIn: 0, transfersOut: 0 },
    closing: c.carried,
    avgHens: c.carried,
    eggs: { good: 0, damaged: 0, rejected: 0, collected: 0, saleable: 0, sessions: [] },
    productionPct: null,
    feed: { consumption: null, isEstimate: false, issued: 0, wasted: 0, records: 0, hasError: false },
    water: { litres: null, recorded: false },
    medicineUses: 0,
    mortalityPct: null,
    mortalityConfirmed: false
  }
}

async function computeIssues(ctx: Ctx, day: DayRow, cages: CageDaySummary[], settings: FarmSettings): Promise<Omit<DayIssue, 'confirmation'>[]> {
  const out: Omit<DayIssue, 'confirmation'>[] = []
  const add = (
    code: string,
    severity: DayIssue['severity'],
    cageId: number | null,
    params: DayIssue['params'] = {},
    confirmable = severity !== 'info',
    keySuffix = ''
  ) => out.push({ key: keySuffix ? `${code}#${keySuffix}` : code, code, severity, cageId, params, confirmable })

  const prev = await previousDay(ctx, day.business_date)
  if (prev && prev.status !== 'closed') add('previous_day_open', 'warning', null, { date: prev.business_date })

  // Baselines from the preceding days (informational comparisons only).
  const baseFrom = addDays(day.business_date, -Math.max(1, settings.baselineDays))
  const history = await loadCageDayStats(ctx, settings, baseFrom, addDays(day.business_date, -1))

  for (const c of cages) {
    const hasHens = c.opening > 0 || c.closing > 0
    if (c.adjustment !== 0) add('opening_corrected', 'info', c.cageId, { adjustment: c.adjustment, reason: c.adjustmentReason ?? '' })
    if (hasHens) {
      const missing = settings.expectedEggSessions.filter((s) => !c.eggs.sessions.includes(s))
      if (missing.length > 0) add('missing_eggs', 'warning', c.cageId, { sessions: missing.join(', ') })
      if (c.feed.records === 0) add('missing_feed', 'warning', c.cageId)
      if (settings.waterTracking) {
        if (!c.water.recorded) add('missing_water', 'warning', c.cageId)
        else if (c.water.litres === null) add('water_incomplete', 'warning', c.cageId)
      }
    }
    if (c.feed.hasError) add('feed_inconsistent', 'error', c.cageId, {}, false)
    else if (c.feed.isEstimate) add('feed_estimated', 'info', c.cageId)
    if (!c.mortalityConfirmed) add('mortality_unconfirmed', 'error', c.cageId, {}, false)
    if (c.closing < 0) add('negative_hens', 'error', c.cageId, {}, false)
    if (c.mortalityPct !== null && c.mortalityPct > settings.mortalityAlertPct) {
      add('high_mortality', 'warning', c.cageId, { pct: c.mortalityPct, threshold: settings.mortalityAlertPct, deaths: c.movements.deaths })
    }
    const hist = history.filter((h) => h.cageId === c.cageId)
    const baseProd = mean(hist.map((h) => h.productionPct))
    if (c.eggs.collected > 0 && isProductionDrop(c.productionPct, baseProd, settings.productionDropPct)) {
      add('production_drop', 'warning', c.cageId, {
        pct: c.productionPct ?? 0,
        baseline: round(baseProd ?? 0, 1),
        change: percentChange(c.productionPct, baseProd) ?? 0
      })
    }
    const baseWater = mean(hist.map((h) => h.water.litres))
    const wch = percentChange(c.water.litres, baseWater)
    if (settings.waterTracking && wch !== null && Math.abs(wch) >= settings.waterChangePct) {
      add('water_change', 'info', c.cageId, { change: wch, baseline: round(baseWater ?? 0, 0) })
    }
  }

  // Possible duplicate egg entries: two sessions with identical non-zero counts.
  const eggRows = (await ctx.db
    .prepare('SELECT cage_id, session, good, damaged, rejected FROM egg_collections WHERE organization_id = ? AND day_id = ?')
    .all(ctx.org, day.id)) as { cage_id: number; session: string; good: number; damaged: number; rejected: number }[]
  const seen = new Map<string, string>()
  for (const e of eggRows) {
    if (e.good + e.damaged + e.rejected === 0) continue
    const k = `${e.cage_id}:${e.good}:${e.damaged}:${e.rejected}`
    if (seen.has(k)) add('possible_duplicate_eggs', 'warning', e.cage_id, { a: seen.get(k)!, b: e.session }, true, e.session)
    else seen.set(k, e.session)
  }

  // Transfers must balance (every transfer out has a matching transfer in).
  const t = (await ctx.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN type='transfer_in' THEN quantity END), 0) AS tin,
              COALESCE(SUM(CASE WHEN type='transfer_out' THEN quantity END), 0) AS tout
       FROM flock_movements WHERE organization_id = ? AND day_id = ?`
    )
    .get(ctx.org, day.id)) as { tin: number; tout: number }
  if (t.tin !== t.tout) add('transfer_mismatch', 'error', null, { in: t.tin, out: t.tout }, false)

  for (const b of await balances(ctx, undefined, day.business_date, { farmId: ctx.farm })) {
    if (b.balance < 0) add('negative_stock', 'error', null, { item: b.name, balance: b.balance, unit: b.unit }, true, String(b.id))
  }

  const expiredUse = (await ctx.db
    .prepare(
      `SELECT t.id, i.name, b.batch_no, b.expiry_date FROM medicine_treatments t
       JOIN inventory_items i ON i.id = t.item_id JOIN inventory_batches b ON b.id = t.batch_id
       WHERE t.organization_id = ? AND t.day_id = ? AND b.expiry_date IS NOT NULL AND b.expiry_date < ?`
    )
    .all(ctx.org, day.id, day.business_date)) as { id: number; name: string; batch_no: string; expiry_date: string }[]
  for (const e of expiredUse) {
    add('expired_medicine_used', 'warning', null, { item: e.name, batch: e.batch_no, expiry: e.expiry_date }, true, String(e.id))
  }
  return out
}

export function isBlocking(i: DayIssue): boolean {
  return i.severity !== 'info' && !i.confirmation
}

export async function getOverview(ctx: Ctx, date: string): Promise<DayOverview> {
  assert(isIsoDate(date), 'invalid_date')
  const settings = await getSettings(ctx)
  const day = await getDay(ctx, date)
  const prev = await previousDay(ctx, date)
  const previous = prev ? { date: prev.business_date, status: prev.status as DayStatus } : null
  if (!day) {
    const cages: CageDaySummary[] = []
    for (const c of await listCages(ctx, false)) {
      cages.push(emptyCage({ cageId: c.id, code: c.code, name: c.name, carried: await carriedFor(ctx, c.id, date) }))
    }
    return {
      date,
      dayId: null,
      status: 'not_started',
      amendmentOpen: false,
      openedAt: null,
      openedBy: null,
      closedAt: null,
      closedBy: null,
      managerComment: null,
      cages,
      totals: sumCages(cages, settings),
      issues: [],
      previousDay: previous
    }
  }
  const cages: CageDaySummary[] = await loadCageDayStats(ctx, settings, date, date)
  const confirmations = (await ctx.db
    .prepare(
      `SELECT dc.cage_id, dc.check_code, dc.reason, dc.confirmed_at, u.display_name AS by_name
       FROM day_confirmations dc LEFT JOIN users u ON u.id = dc.confirmed_by WHERE dc.organization_id = ? AND dc.day_id = ?`
    )
    .all(ctx.org, day.id)) as { cage_id: number; check_code: string; reason: string; confirmed_at: string; by_name: string | null }[]
  const issues: DayIssue[] = (await computeIssues(ctx, day, cages, settings)).map((i) => {
    const c = confirmations.find((x) => x.check_code === i.key && x.cage_id === (i.cageId ?? 0))
    return {
      ...i,
      confirmation: c && i.confirmable ? { reason: c.reason, by: c.by_name ?? '', at: c.confirmed_at } : null
    }
  })
  const names = (await ctx.db
    .prepare(
      `SELECT (SELECT display_name FROM users WHERE organization_id = ? AND id = ?) AS opened,
         (SELECT display_name FROM users WHERE organization_id = ? AND id = ?) AS closed`
    )
    .get(ctx.org, day.opened_by, ctx.org, day.closed_by)) as { opened: string | null; closed: string | null }
  let status: DayStatus = day.status === 'closed' ? 'closed' : 'in_progress'
  if (status === 'in_progress' && !issues.some(isBlocking)) status = 'ready_to_close'
  return {
    date,
    dayId: day.id,
    status,
    amendmentOpen: !!day.amendment_open,
    openedAt: day.opened_at,
    openedBy: names.opened,
    closedAt: day.closed_at,
    closedBy: names.closed,
    managerComment: day.manager_comment,
    cages,
    totals: sumCages(cages, settings),
    issues,
    previousDay: previous
  }
}

async function writeSnapshot(ctx: Ctx, dayId: number, date: string, kind: 'open' | 'close', note: string | null) {
  const v = (await ctx.db
    .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM day_snapshots WHERE organization_id = ? AND day_id = ? AND kind = ?')
    .get(ctx.org, dayId, kind)) as { v: number }
  const data = {
    overview: kind === 'close' ? await getOverview(ctx, date) : null,
    openings: await ctx.db
      .prepare(
        `SELECT c.code, c.name, cd.carried_hens AS carried, cd.opening_adjustment AS adjustment
         FROM cage_days cd JOIN cages c ON c.id = cd.cage_id WHERE cd.organization_id = ? AND cd.day_id = ? ORDER BY c.sort_order, c.code`
      )
      .all(ctx.org, dayId),
    inventory: (await balances(ctx, undefined, kind === 'open' ? addDays(date, -1) : date, { farmId: ctx.farm })).map((b) => ({
      id: b.id,
      name: b.name,
      unit: b.unit,
      balance: b.balance
    }))
  }
  await ctx.db
    .prepare('INSERT INTO day_snapshots (organization_id, day_id, kind, version, data, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ctx.org, dayId, kind, v.v, JSON.stringify(data), note, ctx.user?.id ?? null, ctx.now().toISOString())
  return v.v
}

export async function saveComment(ctx: Ctx, date: string, comment: string) {
  requirePermission(ctx, 'day.comment')
  await ctx.db.transaction(async () => {
    const day = await requireWritableDay(ctx, date)
    await ctx.db.prepare('UPDATE farm_days SET manager_comment = ? WHERE id = ?').run(comment.trim() || null, day.id)
    await audit(ctx, { action: 'update_comment', entity: 'farm_day', entityId: day.id, dayId: day.id })
  })()
}

export async function closeDay(ctx: Ctx, date: string, comment: string | null): Promise<DayOverview> {
  const user = requirePermission(ctx, 'day.close')
  await ctx.db.transaction(async () => {
    const day = await getDay(ctx, date)
    assert(day, 'day_not_started', { date })
    assert(day.status === 'in_progress', 'day_closed', { date })
    if (comment !== null) await ctx.db.prepare('UPDATE farm_days SET manager_comment = ? WHERE id = ?').run(comment.trim() || null, day.id)
    const ov = await getOverview(ctx, date)
    const blocking = ov.issues.filter(isBlocking)
    if (blocking.length > 0) throw new AppError('day_has_open_issues', { count: blocking.length })
    await ctx.db.prepare("UPDATE farm_days SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?").run(user.id, ctx.now().toISOString(), day.id)
    await writeSnapshot(ctx, day.id, date, 'close', null)
    await audit(ctx, {
      action: 'close_day',
      entity: 'farm_day',
      entityId: day.id,
      dayId: day.id,
      details: {
        closingHens: ov.totals.closing,
        eggs: ov.totals.eggs.collected,
        confirmedIssues: ov.issues.filter((i) => i.confirmation).map((i) => ({ key: i.key, cageId: i.cageId, reason: i.confirmation!.reason }))
      }
    })
  })()
  return getOverview(ctx, date)
}

export async function startAmendment(ctx: Ctx, date: string, reason: string) {
  const user = requirePermission(ctx, 'day.amend')
  assert(reason.trim().length >= 5, 'reason_required')
  await ctx.db.transaction(async () => {
    const day = await getDay(ctx, date)
    assert(day, 'day_not_started', { date })
    assert(day.status === 'closed', 'day_not_closed')
    assert(!day.amendment_open, 'amendment_already_open')
    await ctx.db.prepare('UPDATE farm_days SET amendment_open = 1 WHERE id = ?').run(day.id)
    await ctx.db
      .prepare('INSERT INTO day_amendments (organization_id, day_id, reason, opened_by, opened_at) VALUES (?, ?, ?, ?, ?)')
      .run(ctx.org, day.id, reason.trim(), user.id, ctx.now().toISOString())
    await audit(ctx, { action: 'start_amendment', entity: 'farm_day', entityId: day.id, dayId: day.id, reason: reason.trim() })
  })()
}

/**
 * Completes an amendment: re-runs the closing checks, stores a new closing snapshot version and
 * refreshes the snapshots of later closed days whose balances changed as a result.
 */
export async function finishAmendment(ctx: Ctx, date: string, comment: string | null) {
  const user = requirePermission(ctx, 'day.amend')
  await ctx.db.transaction(async () => {
    const day = await getDay(ctx, date)
    assert(day && day.status === 'closed' && day.amendment_open, 'no_amendment_open')
    if (comment !== null) await ctx.db.prepare('UPDATE farm_days SET manager_comment = ? WHERE id = ?').run(comment.trim() || null, day.id)
    const ov = await getOverview(ctx, date)
    const blocking = ov.issues.filter(isBlocking)
    if (blocking.length > 0) throw new AppError('day_has_open_issues', { count: blocking.length })
    const amendment = (await ctx.db
      .prepare('SELECT id, reason FROM day_amendments WHERE organization_id = ? AND day_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(ctx.org, day.id)) as { id: number; reason: string }
    await ctx.db.prepare('UPDATE day_amendments SET closed_by = ?, closed_at = ? WHERE id = ?').run(user.id, ctx.now().toISOString(), amendment.id)
    await ctx.db.prepare('UPDATE farm_days SET amendment_open = 0 WHERE id = ?').run(day.id)
    await writeSnapshot(ctx, day.id, date, 'close', `amendment: ${amendment.reason}`)
    await recalcFrom(ctx, date)
    const later = (await ctx.db
      .prepare(
        "SELECT id, business_date FROM farm_days WHERE organization_id = ? AND farm_id = ? AND business_date > ? AND status = 'closed' ORDER BY business_date"
      )
      .all(ctx.org, ctx.farm, date)) as { id: number; business_date: string }[]
    for (const d of later) {
      const last = (await ctx.db
        .prepare("SELECT data FROM day_snapshots WHERE organization_id = ? AND day_id = ? AND kind = 'close' ORDER BY version DESC LIMIT 1")
        .get(ctx.org, d.id)) as { data: string } | undefined
      const now = await getOverview(ctx, d.business_date)
      const prevTotals = last ? (JSON.parse(last.data).overview?.totals as { opening: number; closing: number } | undefined) : undefined
      if (!prevTotals || prevTotals.opening !== now.totals.opening || prevTotals.closing !== now.totals.closing) {
        await writeSnapshot(ctx, d.id, d.business_date, 'close', `recalculated after amendment of ${date}`)
      }
    }
    await audit(ctx, { action: 'finish_amendment', entity: 'farm_day', entityId: day.id, dayId: day.id, reason: amendment.reason })
  })()
  return getOverview(ctx, date)
}

export async function listDays(ctx: Ctx, from: string, to: string) {
  return (await ctx.db
    .prepare(
      `SELECT d.business_date AS date, d.status, d.amendment_open AS amendmentOpen, d.closed_at AS closedAt,
         (SELECT COUNT(*) FROM day_amendments a WHERE a.day_id = d.id) AS amendments
       FROM farm_days d WHERE d.organization_id = ? AND d.farm_id = ? AND d.business_date BETWEEN ? AND ? ORDER BY d.business_date DESC`
    )
    .all(ctx.org, ctx.farm, from, to)) as {
    date: string
    status: 'in_progress' | 'closed'
    amendmentOpen: number
    closedAt: string | null
    amendments: number
  }[]
}

export async function latestDay(ctx: Pick<Ctx, 'db' | 'org' | 'farm'>) {
  return (await ctx.db
    .prepare('SELECT business_date AS date, status FROM farm_days WHERE organization_id = ? AND farm_id = ? ORDER BY business_date DESC LIMIT 1')
    .get(ctx.org, ctx.farm)) as { date: string; status: 'in_progress' | 'closed' } | undefined
}

export async function listAmendments(ctx: Ctx, date: string) {
  return ctx.db
    .prepare(
      `SELECT a.id, a.reason, a.opened_at AS openedAt, a.closed_at AS closedAt, u1.display_name AS openedBy,
         u2.display_name AS closedBy
       FROM day_amendments a JOIN farm_days d ON d.id = a.day_id
       LEFT JOIN users u1 ON u1.id = a.opened_by LEFT JOIN users u2 ON u2.id = a.closed_by
       WHERE d.organization_id = ? AND d.farm_id = ? AND d.business_date = ? ORDER BY a.id`
    )
    .all(ctx.org, ctx.farm, date)
}
