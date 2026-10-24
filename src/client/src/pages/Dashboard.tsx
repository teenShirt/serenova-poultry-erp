import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bird,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  Egg,
  HeartPulse,
  Leaf,
  PackagePlus,
  Pill,
  PieChart as PieIcon,
  Play,
  ShieldPlus,
  Star,
  TrendingDown,
  TrendingUp,
  Truck,
  Wheat,
  Zap
} from 'lucide-react'
import { addDays } from '@shared/dates'
import type { Permission } from '@shared/permissions'
import type { DailySeriesPoint } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { StatusBadge } from '../components/ui'

/** Dashboard colours (Serenova ERP palette). */
const C = { blue: '#1d63ed', green: '#16a34a', orange: '#f59e0b', red: '#ef4444', purple: '#7c3aed', teal: '#0ea5a4', slate: '#94a3b8' }
const DONUT = [C.blue, C.green, C.orange, C.purple, C.teal]

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x))
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
/** Percentage change of today's value against the average of the previous days (null when either is unknown). */
function vsAverage(points: DailySeriesPoint[], key: 'eggs' | 'feedKg' | 'mortalityPct' | 'closing') {
  const recorded = points.filter((p) => p.status !== 'not_started')
  const today = points[points.length - 1]
  if (!today || today.status === 'not_started') return null
  const base = avg(recorded.filter((p) => p !== today).map((p) => p[key]))
  const now = today[key]
  if (now === null || base === null || base === 0) return null
  return ((now - base) / base) * 100
}

function greetingKey(now = new Date()) {
  const h = now.getHours()
  return h < 12 ? 'dash2.morning' : h < 17 ? 'dash2.afternoon' : 'dash2.evening'
}

export function DashboardPage() {
  const { t, num, date, workDate, status, can } = useApp()
  const nav = useNavigate()
  const [range, setRange] = useState(7)
  const { data: d } = useLoad(() => call('analytics.dashboard', { date: workDate }), [workDate])
  const { data: week } = useLoad(() => call('analytics.series', { from: addDays(workDate, -7), to: workDate }), [workDate])
  const { data: trend } = useLoad(() => call('analytics.series', { from: addDays(workDate, -(range - 1)), to: workDate }), [workDate, range])
  const { data: cagesPerf } = useLoad(() => call('analytics.comparison', { from: addDays(workDate, -6), to: workDate }), [workDate])
  const { data: tasks } = useLoad(() => call('duties.mine', { date: workDate }), [workDate])
  const { data: receipts } = useLoad(() => call('purchases.list', { from: addDays(workDate, -60), to: workDate }), [workDate])
  const { data: stock } = useLoad(() => call('inventory.balances', {}), [])
  const { data: batches } = useLoad(() => call('inventory.batches', { onlyInStock: true }), [])

  const ov = d?.today
  const tot = ov?.totals
  // Comparisons only for a finished (closed) day: a day still being recorded would always look like a drop.
  const final = ov?.status === 'closed'
  const change = (key: 'eggs' | 'feedKg' | 'mortalityPct' | 'closing') => (final || key === 'closing' ? vsAverage(week ?? [], key) : null)
  const subText = final ? t('dash2.vsWeek') : t('dash2.soFar')
  const first = (status.user?.displayName ?? '').split(/\s+/)[0]
  const hens = tot ? (ov?.status === 'not_started' ? tot.opening : tot.closing) : null

  // Closed days only: a day still being recorded would show as a sudden drop.
  const chart = (trend ?? []).map((p) => ({ label: date(p.date, { month: 'short', day: 'numeric' }), eggs: p.status === 'closed' ? p.eggs : null }))
  const byCage = (ov?.cages ?? [])
    .map((c) => ({ name: c.name, value: ov?.status === 'not_started' ? c.opening : c.closing }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value)
  const donut = byCage.length > 5 ? [...byCage.slice(0, 4), { name: t('dash2.otherCages', { count: byCage.length - 4 }), value: byCage.slice(4).reduce((s, c) => s + c.value, 0) }] : byCage
  const donutTotal = donut.reduce((s, c) => s + c.value, 0)

  const stockRows = [...(stock ?? [])]
    .filter((b) => b.active)
    .map((b) => ({ ...b, state: b.balance <= 0 ? 'out' : b.isLow ? 'low' : 'ok' }))
    .sort((a, b) => ['out', 'low', 'ok'].indexOf(a.state) - ['out', 'low', 'ok'].indexOf(b.state))
    .slice(0, 5)
  const expiring = [...(batches ?? [])]
    .filter((b) => b.daysToExpiry !== null)
    .sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0))
    .slice(0, 5)
  const pendingTasks = [...(tasks ?? [])].sort((a, b) => Number(a.done) - Number(b.done)).slice(0, 6)

  const quick: { to: string; key: string; icon: ReactNode; perm: Permission }[] = [
    { to: '/daily', key: 'dash2.qStartDay', icon: <Play size={22} />, perm: 'day.start' },
    { to: '/eggs', key: 'quick.eggs', icon: <Egg size={22} />, perm: 'eggs.record' },
    { to: '/feed', key: 'quick.feed', icon: <Wheat size={22} />, perm: 'feed.record' },
    { to: '/medicine', key: 'dash2.qMedicine', icon: <Pill size={22} />, perm: 'medicine.record' },
    { to: '/mortality?new=1', key: 'quick.death', icon: <HeartPulse size={22} />, perm: 'flock.record' },
    { to: '/purchases?new=1', key: 'quick.receipt', icon: <PackagePlus size={22} />, perm: 'purchases.record' },
    { to: '/sales?new=1', key: 'quick.dispatch', icon: <Truck size={22} />, perm: 'sales.record' }
  ].filter((q) => can(q.perm as Permission)) as { to: string; key: string; icon: ReactNode; perm: Permission }[]

  return (
    <div className="page dash">
      <div className="dash-hello">
        <div className="sun" aria-hidden="true" />
        <div className="grow">
          <h1>{t(greetingKey(), { name: first })}</h1>
          <div className="muted">{t('dash2.subtitle')}</div>
        </div>
        {ov && (
          <div className="dash-day">
            <StatusBadge status={ov.status} amending={ov.amendmentOpen} />
            {ov.status !== 'closed' && can('day.start') && (
              <button className="btn primary sm" onClick={() => nav('/daily')}>
                {ov.status === 'not_started' ? t('dash.startDay') : t('dash.continueDay')}
              </button>
            )}
          </div>
        )}
        <div className="dash-date">
          <CalendarDays size={22} />
          <div>
            <strong>{date(workDate, { year: 'numeric', month: 'long', day: 'numeric' })}</strong>
            <small>{date(workDate, { weekday: 'long' })}</small>
          </div>
        </div>
      </div>

      {!d || !ov || !tot ? (
        <div className="muted">{t('common.loading')}</div>
      ) : (
        <>
          <div className="dash-kpis">
            <KpiTile tone="blue" icon={<Bird size={26} />} label={t('dash2.flock')} value={hens === null ? '—' : num(hens)} change={change('closing')} sub={t('dash2.vsWeek')} />
            <KpiTile tone="green" icon={<Egg size={26} />} label={t('dash2.eggs')} value={ov.status === 'not_started' ? '—' : num(tot.eggs.collected)} change={change('eggs')} sub={subText} />
            <KpiTile
              tone="orange"
              icon={<Wheat size={26} />}
              label={t('dash2.feed')}
              value={tot.feedKg === null ? '—' : num(tot.feedKg, 1)}
              unit="kg"
              change={change('feedKg')}
              sub={subText}
              upIsGood={false}
            />
            <KpiTile
              tone="red"
              icon={<ShieldPlus size={26} />}
              label={t('dash2.mortality')}
              value={tot.mortalityPct === null ? '—' : `${num(tot.mortalityPct, 2)}%`}
              change={change('mortalityPct')}
              sub={subText}
              upIsGood={false}
            />
          </div>

          <div className="dash-row3">
            <section className="dcard">
              <header>
                <h2>
                  <TrendingUp size={18} /> {t('dash2.eggTrend')}
                </h2>
                <select className="select sm" value={range} onChange={(e) => setRange(Number(e.target.value))} aria-label={t('dash2.eggTrend')}>
                  {[7, 14, 30].map((n) => (
                    <option key={n} value={n}>
                      {t('dash2.lastDays', { count: n })}
                    </option>
                  ))}
                </select>
              </header>
              <div style={{ height: 250 }}>
                <ResponsiveContainer>
                  <AreaChart data={chart} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="eggFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.blue} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={C.blue} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e7ecf4" vertical />
                    <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => num(v)} />
                    <Tooltip formatter={(v) => [num(Number(v)), t('chart.eggs')]} />
                    <Area type="monotone" dataKey="eggs" stroke={C.blue} strokeWidth={2.5} fill="url(#eggFill)" connectNulls={false} dot={{ r: 3.5, fill: C.blue }} activeDot={{ r: 5 }} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="muted small">{t('dash2.closedOnly')}</div>
            </section>

            <section className="dcard">
              <header>
                <h2>
                  <PieIcon size={18} /> {t('dash2.byCage')}
                </h2>
              </header>
              {donut.length === 0 ? (
                <div className="muted small">{t('common.noData')}</div>
              ) : (
                <div className="donut-wrap">
                  <div className="donut">
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie data={donut} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="96%" paddingAngle={1} startAngle={90} endAngle={-270} stroke="none">
                          {donut.map((_, i) => (
                            <Cell key={i} fill={DONUT[i % DONUT.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v) => num(Number(v))} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="donut-center">
                      <strong>{num(donutTotal)}</strong>
                      <small>{t('dash2.total')}</small>
                    </div>
                  </div>
                  <ul className="donut-legend">
                    {donut.map((c, i) => (
                      <li key={c.name}>
                        <i style={{ background: DONUT[i % DONUT.length] }} />
                        <span className="grow">
                          {c.name} <small>({Math.round((c.value / donutTotal) * 100)}%)</small>
                        </span>
                        <strong>{num(c.value)}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section className="dcard dash-tasks">
              <header>
                <h2>
                  <Star size={18} /> {t('dash2.tasks')}
                </h2>
                <button className="link-btn" onClick={() => nav('/daily')}>
                  {t('dash2.viewAll')}
                </button>
              </header>
              {pendingTasks.length === 0 ? (
                <div className="muted small">{t('dash2.noTasks')}</div>
              ) : (
                <ul className="task-list">
                  {pendingTasks.map((x) => (
                    <li key={x.key}>
                      <span className="grow">
                        <strong>{t('duty.' + x.duty)}</strong>
                        <small>{[x.cageName, x.params.session ? t('session.' + x.params.session) : null].filter(Boolean).join(' · ') || t('dash2.wholeFarm')}</small>
                      </span>
                      <span className={`pill ${x.done ? 'good' : 'warn'}`}>{x.done ? t('dash2.done') : t('dash2.pending')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="dash-row3 tables">
            <section className="dcard">
              <header>
                <h2>
                  <ClipboardCheck size={18} /> {t('dash2.recentGrn')}
                </h2>
                <button className="link-btn" onClick={() => nav('/purchases')}>
                  {t('dash2.viewAll')}
                </button>
              </header>
              <MiniTable
                head={[t('dash2.grnNo'), t('pur.supplier'), t('common.date'), t('common.status')]}
                rows={(receipts ?? []).slice(0, 5).map((r) => [
                  <span className="link">{r.grnNo}</span>,
                  r.supplierName ?? '—',
                  date(r.date, { month: 'short', day: 'numeric' }),
                  <span className="pill good">{t('dash2.received')}</span>
                ])}
                empty={t('common.noData')}
              />
            </section>
            <section className="dcard">
              <header>
                <h2>
                  <AlertTriangle size={18} /> {t('dash2.stockAlerts')}
                </h2>
                <button className="link-btn" onClick={() => nav('/inventory')}>
                  {t('dash2.viewAll')}
                </button>
              </header>
              <MiniTable
                head={[t('dash2.item'), t('dash2.currentStock'), t('common.status')]}
                rows={stockRows.map((b) => [
                  b.name,
                  `${num(b.balance, 1)} ${b.unit}`,
                  <span className={`pill ${b.state === 'out' ? 'bad' : b.state === 'low' ? 'warn' : 'good'}`}>{t('dash2.stock.' + b.state)}</span>
                ])}
                empty={t('common.noData')}
              />
            </section>
            <section className="dcard">
              <header>
                <h2>
                  <CalendarClock size={18} /> {t('dash2.expiring')}
                </h2>
                <button className="link-btn" onClick={() => nav('/inventory')}>
                  {t('dash2.viewAll')}
                </button>
              </header>
              <MiniTable
                head={[t('dash2.item'), t('dash2.expiry'), t('dash2.daysLeft')]}
                rows={expiring.map((b) => [
                  `${b.itemName} · ${b.batchNo}`,
                  <span className={(b.daysToExpiry ?? 0) <= 30 ? 'text-bad' : undefined}>{b.expiryDate ? date(b.expiryDate, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</span>,
                  <span className={`pill ${(b.daysToExpiry ?? 0) < 0 ? 'bad' : (b.daysToExpiry ?? 0) <= 30 ? 'warn' : 'good'}`}>{num(b.daysToExpiry)}</span>
                ])}
                empty={t('common.noData')}
              />
            </section>
          </div>

          <div className="dash-bottom">
            {quick.length > 0 && (
              <section className="dcard">
                <header>
                  <h2>
                    <Zap size={18} /> {t('dash2.quick')}
                  </h2>
                </header>
                <div className="quick-grid">
                  {quick.map((q) => (
                    <button key={q.key} className="quick-tile" onClick={() => nav(q.to)}>
                      <span className="quick-icon">{q.icon}</span>
                      <span>{t(q.key)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="dcard">
              <header>
                <h2>
                  <TrendingDown size={18} /> {t('dash2.cagePerf')}
                </h2>
                <button className="link-btn" onClick={() => nav('/reports')}>
                  {t('dash2.viewAll')}
                </button>
              </header>
              <MiniTable
                head={[t('dash2.cage'), t('dash2.hens'), t('col.eggs'), t('dash2.prod'), t('dash2.mortality')]}
                rows={(cagesPerf ?? []).slice(0, 6).map((c) => [
                  c.name,
                  num(c.closingHens),
                  num(c.eggs),
                  c.avgProductionPct === null ? '—' : `${num(c.avgProductionPct, 1)}%`,
                  c.mortalityPct === null ? '—' : `${num(c.mortalityPct, 2)}%`
                ])}
                empty={t('common.noData')}
              />
            </section>
            <section className="dash-banner">
              <div>
                <h2>{t('dash2.bannerTitle')}</h2>
                <p>{t('dash2.bannerText')}</p>
              </div>
              <div className="dash-banner-brand">
                <Leaf size={26} /> Serenova Tech
              </div>
              <Bird className="dash-banner-art" size={170} strokeWidth={1} aria-hidden="true" />
            </section>
          </div>
        </>
      )}
    </div>
  )
}

function KpiTile({ tone, icon, label, value, unit, change, sub, upIsGood = true }: { tone: 'blue' | 'green' | 'orange' | 'red'; icon: ReactNode; label: string; value: string; unit?: string; change: number | null; sub: string; upIsGood?: boolean }) {
  const { num } = useApp()
  const up = change !== null && change >= 0
  const good = change === null ? null : up === upIsGood
  return (
    <section className={`kpi-tile ${tone}`}>
      <div className="kpi-icon">{icon}</div>
      <div>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">
          {value}
          {unit && value !== '—' && <small> {unit}</small>}
        </div>
        {change !== null && (
          <div className={`kpi-change ${good ? 'good' : 'bad'}`}>
            {up ? <ArrowUp size={14} /> : <ArrowDown size={14} />} {num(Math.abs(change), 1)}%
          </div>
        )}
        <div className="kpi-sub">{sub}</div>
      </div>
    </section>
  )
}

function MiniTable({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <div className="muted small">{empty}</div>
  return (
    <div className="table-wrap">
      <table className="mini">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
