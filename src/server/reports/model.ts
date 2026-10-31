import { addDays } from '@shared/dates'
import { formatDate, formatDateTime, formatNumber, translate } from '@shared/i18n'
import type { DayIssue, Language } from '@shared/types'
import type { Ctx } from '../context'
import { cageComparison, dailySeries } from '../services/analytics'
import { getOverview } from '../services/days'
import { balances } from '../services/inventory'
import { listMovements } from '../services/flock'
import { listTreatments } from '../services/medicine'
import { getSettings } from '../services/settings'
import { flowSummary } from '../services/supply'

export type Cell = string | number | null

export type Section =
  | { kind: 'kv'; heading: string; pairs: [string, string][] }
  | { kind: 'table'; heading: string; columns: string[]; rows: Cell[][]; totals?: Cell[]; numeric?: boolean[] }
  | { kind: 'list'; heading: string; items: string[]; tone?: 'warn' | 'info' }
  | { kind: 'note'; text: string; tone: 'warn' | 'info' }
  | { kind: 'signature'; heading: string; lines: string[] }

export interface ReportModel {
  title: string
  farmName: string
  subtitle: string
  generated: string
  isDemo: boolean
  sections: Section[]
  fileStem: string
}

function issueText(lang: Language, i: DayIssue, cageName: string | null) {
  const params: Record<string, string | number> = { ...i.params }
  if (i.code === 'missing_eggs') {
    params.sessions = String(i.params.sessions ?? '')
      .split(',')
      .map((x) => translate(lang, 'session.' + x.trim()))
      .join(', ')
  }
  if (i.code === 'possible_duplicate_eggs') {
    params.a = translate(lang, 'session.' + i.params.a)
    params.b = translate(lang, 'session.' + i.params.b)
  }
  const msg = translate(lang, 'issue.' + i.code, params)
  return cageName ? `${cageName}: ${msg}` : msg
}

/** A report without its water figures (for an organization that does not track water). */
export function withoutWater(model: ReportModel, lang: Language): ReportModel {
  const total = translate(lang, 'rep.totalWater')
  const col = translate(lang, 'col.water')
  const sections = model.sections.map((s): Section => {
    if (s.kind === 'kv') return { ...s, pairs: s.pairs.filter(([k]) => k !== total) }
    if (s.kind !== 'table') return s
    const i = s.columns.indexOf(col)
    if (i < 0) return s
    const drop = <T>(a: T[] | undefined) => a?.filter((_, j) => j !== i)
    return { ...s, columns: drop(s.columns)!, rows: s.rows.map((r) => drop(r)!), totals: drop(s.totals), numeric: drop(s.numeric) }
  })
  return { ...model, sections }
}

async function header(ctx: Ctx, lang: Language, isDemo: boolean) {
  const s = await getSettings(ctx)
  return {
    s,
    farmName: s.farmName,
    generated: translate(lang, 'report.generated', {
      at: formatDateTime(lang, ctx.now().toISOString(), s.timezone),
      by: ctx.user?.displayName ?? ''
    }),
    isDemo
  }
}

export async function dayReport(ctx: Ctx, date: string, kind: 'day_open' | 'day_close', lang: Language, isDemo: boolean): Promise<ReportModel> {
  const t = (k: string, p?: Record<string, string | number | null>) => translate(lang, k, p ?? {})
  const n = (v: number | null | undefined, d = 0) => formatNumber(lang, v, d)
  const { s, farmName, generated } = await header(ctx, lang, isDemo)
  const ov = await getOverview(ctx, date)
  const cageName = (id: number | null) => (id === null ? null : (ov.cages.find((c) => c.cageId === id)?.name ?? null))
  const statusLabel = ov.amendmentOpen ? t('status.amending') : t('status.' + ov.status)
  const sections: Section[] = []
  const meta: [string, string][] = [
    [t('report.farm'), farmName],
    [t('report.location'), s.farmLocation || '—'],
    [t('report.date'), formatDate(lang, date, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })],
    [t('report.dayStatus'), statusLabel]
  ]
  if (ov.openedBy) meta.push([t('report.openedBy'), `${ov.openedBy} · ${formatDateTime(lang, ov.openedAt, s.timezone)}`])
  sections.push({ kind: 'kv', heading: t('report.farm'), pairs: meta })

  if (kind === 'day_open') {
    sections.push({
      kind: 'table',
      heading: t('report.openingBalances'),
      columns: [t('common.cage'), t('day.carried'), t('day.adjust'), t('day.opening'), t('common.reason')],
      numeric: [false, true, true, true, false],
      rows: ov.cages.map((c) => [c.name, c.carried, c.adjustment || null, c.opening, c.adjustmentReason ?? '']),
      totals: [t('common.total'), ov.cages.reduce((a, c) => a + c.carried, 0), null, ov.totals.opening, '']
    })
    const inv = (await balances(ctx, undefined, addDays(date, -1), { farmId: ctx.farm })).filter((b) => b.active)
    sections.push({
      kind: 'table',
      heading: t('day.inventoryCarried'),
      columns: [t('inv.item'), t('inv.category'), t('inv.balance'), t('common.unit'), t('inv.low')],
      numeric: [false, false, true, false, false],
      rows: inv.map((b) => [b.name, t('inv.cat.' + b.category), b.balance, b.unit, b.isLow ? t('inv.low') : ''])
    })
    const pending = ov.issues.filter((i) => i.severity !== 'info' && !i.confirmation)
    sections.push({
      kind: 'list',
      heading: t('report.pendingTasks'),
      items: pending.length ? pending.map((i) => issueText(lang, i, cageName(i.cageId))) : [t('common.none')],
      tone: 'info'
    })
    if (ov.previousDay)
      sections.push({
        kind: 'note',
        tone: ov.previousDay.status === 'closed' ? 'info' : 'warn',
        text: t('day.previousDay', { date: ov.previousDay.date, status: t('status.' + ov.previousDay.status) })
      })
    return {
      title: t('report.openTitle'),
      farmName,
      subtitle: formatDate(lang, date, { year: 'numeric', month: 'long', day: 'numeric' }),
      generated,
      isDemo,
      sections,
      fileStem: `Start-of-Day-${date}`
    }
  }

  if (ov.status !== 'closed') sections.push({ kind: 'note', tone: 'warn', text: t('report.notClosed') })
  const tot = ov.totals
  sections.push({
    kind: 'kv',
    heading: t('rep.periodTotals'),
    pairs: [
      [t('dash.openingHens'), n(tot.opening)],
      [t('col.closing'), n(tot.closing)],
      [
        t('rep.totalEggs'),
        `${n(tot.eggs.collected)} (${t('col.good')} ${n(tot.eggs.good)} · ${t('col.damaged')} ${n(tot.eggs.damaged)} · ${t('col.rejected')} ${n(tot.eggs.rejected)})`
      ],
      [t('dash.production'), tot.productionPct === null ? '—' : `${n(tot.productionPct, 2)}%`],
      [t('rep.totalFeed'), tot.feedKg === null ? t('common.unknown') : `${n(tot.feedKg, 1)} kg${tot.feedIsEstimate ? ` (${t('common.estimate')})` : ''}`],
      [t('rep.totalWater'), tot.waterLitres === null ? t('common.unknown') : `${n(tot.waterLitres, 0)} L`],
      [t('rep.totalDeaths'), `${n(tot.movements.deaths)} (${tot.mortalityPct === null ? '—' : n(tot.mortalityPct, 3) + '%'})`]
    ]
  })
  sections.push({
    kind: 'table',
    heading: t('report.cageDetail'),
    columns: [
      t('common.cage'),
      t('col.opening'),
      t('col.deaths'),
      t('col.removals'),
      t('col.additions'),
      t('col.transfersIn'),
      t('col.transfersOut'),
      t('col.closing'),
      t('col.good'),
      t('col.damaged'),
      t('col.rejected'),
      t('col.eggs'),
      t('col.production'),
      t('col.feed'),
      t('col.water'),
      t('col.medicine'),
      t('col.mortality')
    ],
    numeric: [false, ...Array(16).fill(true)],
    rows: ov.cages.map((c) => [
      c.name,
      c.opening,
      c.movements.deaths,
      c.movements.removals,
      c.movements.additions,
      c.movements.transfersIn,
      c.movements.transfersOut,
      c.closing,
      c.eggs.good,
      c.eggs.damaged,
      c.eggs.rejected,
      c.eggs.collected,
      c.productionPct === null ? null : n(c.productionPct, 2),
      c.feed.consumption === null ? null : n(c.feed.consumption, 1) + (c.feed.isEstimate ? '*' : ''),
      c.water.litres,
      c.medicineUses,
      c.mortalityPct === null ? null : n(c.mortalityPct, 3)
    ]),
    totals: [
      t('common.total'),
      tot.opening,
      tot.movements.deaths,
      tot.movements.removals,
      tot.movements.additions,
      tot.movements.transfersIn,
      tot.movements.transfersOut,
      tot.closing,
      tot.eggs.good,
      tot.eggs.damaged,
      tot.eggs.rejected,
      tot.eggs.collected,
      tot.productionPct === null ? null : n(tot.productionPct, 2),
      tot.feedKg === null ? null : n(tot.feedKg, 1) + (tot.feedIsEstimate ? '*' : ''),
      tot.waterLitres,
      tot.medicineUses,
      tot.mortalityPct === null ? null : n(tot.mortalityPct, 3)
    ]
  })
  if (tot.feedIsEstimate) sections.push({ kind: 'note', tone: 'info', text: `* ${t('issue.feed_estimated')}` })

  const moves = await listMovements(ctx, date)
  if (moves.length) {
    sections.push({
      kind: 'table',
      heading: t('report.flock'),
      columns: [t('common.cage'), t('common.type'), t('common.quantity'), t('common.reason'), t('common.recordedBy')],
      numeric: [false, false, true, false, false],
      rows: moves.map((m) => [
        m.cageName + (m.counterpartCageName ? ` ↔ ${m.counterpartCageName}` : ''),
        t('flock.type.' + m.type),
        m.quantity,
        m.reason ?? '',
        m.recordedBy ?? ''
      ])
    })
  }
  const treatments = await listTreatments(ctx, date, date)
  if (treatments.length) {
    sections.push({
      kind: 'table',
      heading: t('report.treatments'),
      columns: [t('common.cage'), t('med.medicine'), t('med.batch'), t('common.quantity'), t('med.reasonForUse'), t('med.prescribedBy')],
      numeric: [false, false, false, true, false, false],
      rows: treatments.map((x) => [
        x.cageName ?? t('common.farm'),
        x.itemName,
        x.batchNo ?? '',
        `${n(x.quantity, 2)} ${x.unit}`,
        x.reason,
        x.prescribedBy ?? ''
      ])
    })
  }
  const inv = (await balances(ctx, undefined, date, { farmId: ctx.farm })).filter((b) => b.active)
  sections.push({
    kind: 'table',
    heading: t('report.inventory'),
    columns: [t('inv.item'), t('inv.category'), t('inv.balance'), t('common.unit'), t('inv.low')],
    numeric: [false, false, true, false, false],
    rows: inv.map((b) => [b.name, t('inv.cat.' + b.category), b.balance, b.unit, b.isLow ? t('inv.low') : ''])
  })
  const confirmed = ov.issues.filter((i) => i.confirmation)
  const missing = ov.issues.filter((i) => ['missing_eggs', 'missing_feed', 'missing_water', 'water_incomplete', 'feed_estimated'].includes(i.code))
  const alerts = ov.issues.filter((i) =>
    ['high_mortality', 'production_drop', 'water_change', 'negative_stock', 'expired_medicine_used', 'opening_corrected'].includes(i.code)
  )
  sections.push({
    kind: 'list',
    heading: t('report.alerts'),
    items: alerts.length ? alerts.map((i) => issueText(lang, i, cageName(i.cageId))) : [t('common.none')],
    tone: 'warn'
  })
  sections.push({
    kind: 'list',
    heading: t('report.estimates'),
    items: missing.length ? missing.map((i) => issueText(lang, i, cageName(i.cageId))) : [t('common.none')],
    tone: 'info'
  })
  sections.push({
    kind: 'list',
    heading: t('report.confirmed'),
    items: confirmed.length
      ? confirmed.map((i) => `${issueText(lang, i, cageName(i.cageId))} — ${t('day.confirmedBy', { by: i.confirmation!.by, reason: i.confirmation!.reason })}`)
      : [t('common.none')],
    tone: 'info'
  })
  sections.push({
    kind: 'note',
    tone: 'info',
    text: t('report.method', { prodDen: t('report.den.' + s.productionDenominator), mortDen: t('report.den.' + s.mortalityDenominator) })
  })
  sections.push({
    kind: 'signature',
    heading: t('report.approval'),
    lines: [
      `${t('report.comment')}: ${ov.managerComment ?? '—'}`,
      `${t('report.approvedBy')}: ${ov.closedBy ? `${ov.closedBy} · ${formatDateTime(lang, ov.closedAt, s.timezone)}` : '—'}`,
      `${t('report.signature')}: ______________________________`
    ]
  })
  return {
    title: t('report.closeTitle'),
    farmName,
    subtitle: formatDate(lang, date, { year: 'numeric', month: 'long', day: 'numeric' }),
    generated,
    isDemo,
    sections,
    fileStem: `End-of-Day-${date}`
  }
}

export async function periodReport(ctx: Ctx, from: string, to: string, lang: Language, isDemo: boolean): Promise<ReportModel> {
  const t = (k: string, p?: Record<string, string | number | null>) => translate(lang, k, p ?? {})
  const n = (v: number | null | undefined, d = 0) => formatNumber(lang, v, d)
  const { s, farmName, generated } = await header(ctx, lang, isDemo)
  const series = await dailySeries(ctx, from, to)
  const recorded = series.filter((p) => p.status !== 'not_started')
  const sum = (f: (p: (typeof series)[number]) => number | null) => {
    const v = recorded.map(f).filter((x): x is number => x !== null)
    return v.length ? v.reduce((a, b) => a + b, 0) : null
  }
  const prod = recorded.map((p) => p.productionPct).filter((x): x is number => x !== null)
  const sections: Section[] = [
    {
      kind: 'kv',
      heading: t('rep.periodTotals'),
      pairs: [
        [t('report.farm'), farmName],
        [t('report.period'), `${formatDate(lang, from)} – ${formatDate(lang, to)}`],
        [t('rep.daysClosed'), `${recorded.filter((p) => p.status === 'closed').length} / ${series.length}`],
        [t('rep.totalEggs'), n(sum((p) => p.eggs))],
        [t('rep.avgProduction'), prod.length ? `${n(prod.reduce((a, b) => a + b, 0) / prod.length, 2)}%` : '—'],
        [
          t('rep.totalFeed'),
          sum((p) => p.feedKg) === null
            ? '—'
            : `${n(
                sum((p) => p.feedKg),
                1
              )} kg`
        ],
        [
          t('rep.totalWater'),
          sum((p) => p.waterLitres) === null
            ? '—'
            : `${n(
                sum((p) => p.waterLitres),
                0
              )} L`
        ],
        [t('rep.totalDeaths'), n(sum((p) => p.deaths))],
        [t('col.closing'), recorded.length ? n(recorded[recorded.length - 1].closing) : '—']
      ]
    }
  ]
  if (recorded.some((p) => p.status !== 'closed')) sections.push({ kind: 'note', tone: 'warn', text: t('report.notClosed') })
  sections.push({
    kind: 'table',
    heading: t('report.daily'),
    columns: [
      t('common.date'),
      t('common.status'),
      t('col.opening'),
      t('col.closing'),
      t('col.good'),
      t('col.damaged'),
      t('col.rejected'),
      t('col.eggs'),
      t('col.production'),
      t('col.feed'),
      t('col.feedPerHen'),
      t('col.water'),
      t('col.deaths')
    ],
    numeric: [false, false, ...Array(11).fill(true)],
    rows: series.map((p) =>
      p.status === 'not_started'
        ? [p.date, t('status.not_started'), null, null, null, null, null, null, null, null, null, null, null]
        : [
            p.date,
            t('status.' + p.status),
            p.opening,
            p.closing,
            p.good,
            p.damaged,
            p.rejected,
            p.eggs,
            p.productionPct === null ? null : n(p.productionPct, 2),
            p.feedKg === null ? null : n(p.feedKg, 1),
            p.feedPerHenG,
            p.waterLitres,
            p.deaths
          ]
    ),
    totals: [
      t('common.total'),
      '',
      null,
      null,
      sum((p) => p.good),
      sum((p) => p.damaged),
      sum((p) => p.rejected),
      sum((p) => p.eggs),
      null,
      sum((p) => p.feedKg) === null
        ? null
        : n(
            sum((p) => p.feedKg),
            1
          ),
      null,
      sum((p) => p.waterLitres),
      sum((p) => p.deaths)
    ]
  })
  // Stores and sales: feed in and out of the store, eggs in and out of the egg store, money.
  const flow = await flowSummary(ctx, from, to)
  const money = (v: number) => `${s.currency} ${n(v, 2)}`
  sections.push({
    kind: 'kv',
    heading: t('navg.stores'),
    pairs: [
      [t('flow.received'), `${n(flow.feed.receivedKg, 1)} kg · ${money(flow.feed.purchaseCost)}`],
      [t('flow.issued'), `${n(flow.feed.issuedKg, 1)} kg`],
      [t('flow.feedStore'), `${n(flow.feed.openingKg, 1)} → ${n(flow.feed.closingKg, 1)} kg`],
      [t('flow.dispatched'), `${t('col.good')} ${n(flow.eggs.dispatchedGood)} · ${t('col.damaged')} ${n(flow.eggs.dispatchedCracked)}`],
      [t('sal.stockGood'), `${n(flow.eggs.openingGood)} → ${n(flow.eggs.closingGood)}`],
      [t('flow.sales'), money(flow.money.sales)],
      [t('sal.received'), money(flow.money.received)],
      [t('sal.outstanding'), money(flow.money.outstanding)]
    ]
  })
  if (flow.topCustomers.length) {
    sections.push({
      kind: 'table',
      heading: t('flow.topCustomers'),
      columns: [t('sal.customer'), t('col.eggs'), t('sal.amount')],
      numeric: [false, true, true],
      rows: flow.topCustomers.map((c) => [c.name, c.eggs, money(c.amount)])
    })
  }
  if (flow.topSuppliers.length) {
    sections.push({
      kind: 'table',
      heading: t('flow.topSuppliers'),
      columns: [t('pur.supplier'), t('common.quantity'), t('pur.total')],
      numeric: [false, true, true],
      rows: flow.topSuppliers.map((x) => [x.name, x.quantity, money(x.cost)])
    })
  }
  const cmp = await cageComparison(ctx, from, to)
  sections.push({
    kind: 'table',
    heading: t('rep.compare'),
    columns: [
      t('common.cage'),
      t('col.eggs'),
      t('col.good'),
      t('col.damaged'),
      t('col.production'),
      t('col.feed'),
      t('col.water'),
      t('col.deaths'),
      t('col.mortality'),
      t('col.closing')
    ],
    numeric: [false, ...Array(9).fill(true)],
    rows: cmp.map((c) => [
      c.name,
      c.eggs,
      c.good,
      c.damaged,
      c.avgProductionPct === null ? null : n(c.avgProductionPct, 2),
      c.feedKg === null ? null : n(c.feedKg, 1),
      c.waterLitres,
      c.deaths,
      c.mortalityPct === null ? null : n(c.mortalityPct, 3),
      c.closingHens
    ])
  })
  sections.push({
    kind: 'note',
    tone: 'info',
    text: t('report.method', { prodDen: t('report.den.' + s.productionDenominator), mortDen: t('report.den.' + s.mortalityDenominator) })
  })
  return {
    title: t('report.periodTitle'),
    farmName,
    subtitle: `${formatDate(lang, from)} – ${formatDate(lang, to)}`,
    generated,
    isDemo,
    sections,
    fileStem: `Farm-Summary-${from}-to-${to}`
  }
}
