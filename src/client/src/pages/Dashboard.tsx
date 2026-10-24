import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Banknote, Bird, Boxes, CalendarCheck, ClipboardList, Droplets, Egg, Percent, Pill, Skull, TrendingDown, Truck, Wheat, XCircle, Info } from 'lucide-react'
import { percentChange } from '@shared/calc'
import { MyDutiesCard } from '../components/Duties'
import { Kpi } from '../components/Kpi'
import { addDays } from '@shared/dates'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, CageSelect, DateBar, Notice, PageHeader, StatusBadge, useCages } from '../components/ui'
import { CageBars, RangePicker, SERIES, TimeChart } from '../components/charts'

const MISSING = ['missing_eggs', 'missing_feed', 'missing_water', 'water_incomplete', 'mortality_unconfirmed']

export function DashboardPage() {
  const { t, num, workDate, status } = useApp()
  const nav = useNavigate()
  const [days, setDays] = useState(30)
  const [cageId, setCageId] = useState<number | null>(null)
  const { data: cages } = useCages()
  const { data: d } = useLoad(() => call('analytics.dashboard', { date: workDate }), [workDate])
  const from = addDays(workDate, -(days - 1))
  const { data: series } = useLoad(() => call('analytics.series', { from, to: workDate, cageId }), [workDate, days, cageId])
  const { data: comparison } = useLoad(() => call('analytics.comparison', { from, to: workDate }), [workDate, days])
  // Trend lines always show the farm's last 14 days, whatever the chart filters are.
  const { data: trend } = useLoad(() => call('analytics.series', { from: addDays(workDate, -13), to: workDate }), [workDate])
  const { data: store } = useLoad(() => call('sales.stock'), [])
  const tr = (k: 'eggs' | 'productionPct' | 'feedKg' | 'waterLitres' | 'deaths' | 'closing') => (trend ?? []).map((p) => (p.status === 'not_started' ? null : p[k]))
  const vsYesterday = (k: 'eggs' | 'productionPct' | 'feedKg' | 'waterLitres') => {
    const a = trend?.[trend.length - 1]
    const b = trend?.[trend.length - 2]
    return a && b && a.status !== 'not_started' && b.status !== 'not_started' ? percentChange(a[k], b[k]) : null
  }

  const ov = d?.today
  const tot = ov?.totals
  const missingCages = new Set(ov?.issues.filter((i) => MISSING.includes(i.code) && !i.confirmation && i.cageId !== null).map((i) => i.cageId))
  const cmp = (comparison ?? []).map((c) => ({ ...c }))

  return (
    <div className="page">
      <PageHeader title={t('dash.title')} icon={<Bird size={26} color="var(--brand)" />}>
        <DateBar />
      </PageHeader>
      {!d || !ov || !tot ? (
        <div className="muted">{t('common.loading')}</div>
      ) : (
        <div className="stack">
          <div className="card row">
            <CalendarCheck size={22} color="var(--brand)" />
            <strong>{t('dash.dayStatus')}:</strong>
            <StatusBadge status={ov.status} amending={ov.amendmentOpen} />
            <span className="grow" />
            {ov.status !== 'closed' && (
              <button className="btn primary" onClick={() => nav('/daily')}>
                {ov.status === 'not_started' ? t('dash.startDay') : t('dash.continueDay')}
              </button>
            )}
          </div>

          <MyDutiesCard />

          <div className="grid stats">
            <Kpi icon={<Bird size={18} />} label={t('dash.currentHens')} value={num(tot.closing)} sub={`${t('dash.openingHens')}: ${num(tot.opening)}`} trend={tr('closing')} color={SERIES.blue} />
            <Kpi icon={<Egg size={18} />} label={t('dash.eggsToday')} value={num(tot.eggs.collected)} sub={t('dash.goodDamaged', { good: num(tot.eggs.good), damaged: num(tot.eggs.damaged), rejected: num(tot.eggs.rejected) })} trend={tr('eggs')} color={SERIES.blue} change={vsYesterday('eggs')} />
            <Kpi icon={<Percent size={18} />} label={t('dash.production')} value={tot.productionPct === null ? '—' : `${num(tot.productionPct, 1)}%`} trend={tr('productionPct')} color={SERIES.blue} change={vsYesterday('productionPct')} />
            <Kpi icon={<Wheat size={18} />} label={t('dash.feedToday')} value={tot.feedKg === null ? '—' : `${num(tot.feedKg, 1)} kg`} sub={tot.feedIsEstimate ? t('feed.method.estimate') : undefined} trend={tr('feedKg')} color={SERIES.aqua} change={vsYesterday('feedKg')} goodWhenUp={false} />
            <Kpi icon={<Droplets size={18} />} label={t('dash.waterToday')} value={tot.waterLitres === null ? '—' : `${num(tot.waterLitres)} L`} trend={tr('waterLitres')} color={SERIES.blue} />
            <Kpi icon={<Skull size={18} />} label={t('dash.deathsToday')} value={num(tot.movements.deaths)} tone={tot.movements.deaths > 0 ? 'warn' : undefined} sub={tot.mortalityPct === null ? undefined : `${num(tot.mortalityPct, 3)}%`} trend={tr('deaths')} color={SERIES.red} />
            <Kpi icon={<Pill size={18} />} label={t('dash.medicineToday')} value={num(tot.medicineUses)} sub={t('dash.itemsInStock', { count: d.inventory.medicineItems })} />
            <Kpi icon={<Boxes size={18} />} label={t('dash.feedStock')} value={`${num(d.inventory.feedKg)} kg`} tone={d.inventory.lowStock.some((i) => i.category === 'feed') ? 'warn' : undefined} />
            <Kpi icon={<Truck size={18} />} label={t('sal.stockGood')} value={num(store?.good)} sub={`${t('sal.stockCracked')}: ${num(store?.cracked)}`} />
            <Kpi icon={<Banknote size={18} />} label={t('sal.outstanding')} value={`${status.settings.currency} ${num(store?.outstanding ?? 0, 0)}`} tone={store && store.outstanding > 0 ? 'warn' : undefined} />
            <Kpi icon={<ClipboardList size={18} />} label={t('dash.missingCages')} value={ov.status === 'not_started' ? '—' : num(missingCages.size)} tone={missingCages.size > 0 ? 'warn' : undefined} sub={[...missingCages].map((id) => ov.cages.find((c) => c.cageId === id)?.name).join(', ')} />
          </div>

          <Card title={t('dash.alerts')}>
            {d.alerts.length === 0 ? (
              <Notice tone="good">{t('dash.noAlerts')}</Notice>
            ) : (
              <div className="issues">
                {d.alerts.map((a, i) => (
                  <div key={i} className={`issue ${a.severity}`}>
                    {a.severity === 'error' ? <XCircle size={18} color="var(--bad)" /> : a.severity === 'warning' ? <AlertTriangle size={18} color="#b56d00" /> : <Info size={18} color="var(--info)" />}
                    <div className="text">
                      {t('alert.' + a.code, a.params)}
                      {['production_drop', 'high_mortality', 'water_change'].includes(a.code) && <div className="sub">{t('issue.informational')}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="row">
            <h2 className="grow">{t('dash.charts')}</h2>
            <CageSelect cages={cages ?? []} value={cageId} onChange={setCageId} allowAll />
            <RangePicker days={days} onChange={setDays} />
          </div>
          {status.settings && (
            <div className="grid cols-2">
              <TimeChart title={t('chart.eggsDaily')} data={series ?? []} series={[{ key: 'eggs', label: t('chart.eggs'), color: SERIES.blue }]} kind="bar" note={t('chart.missingDays')} />
              <TimeChart title={t('chart.production')} data={series ?? []} series={[{ key: 'productionPct', label: t('chart.production'), color: SERIES.blue }]} unit="%" digits={1} />
              <TimeChart
                title={t('chart.goodDamaged')}
                data={series ?? []}
                kind="stacked"
                series={[
                  { key: 'good', label: t('chart.good'), color: SERIES.blue },
                  { key: 'damaged', label: t('chart.damaged'), color: SERIES.orange },
                  { key: 'rejected', label: t('chart.rejected'), color: SERIES.aqua }
                ]}
              />
              <CageBars title={t('chart.cageEggs')} data={cmp} valueKey="eggs" label={t('col.eggs')} />
              <TimeChart title={t('chart.feedDaily')} data={series ?? []} series={[{ key: 'feedKg', label: t('chart.feedDaily'), color: SERIES.aqua }]} kind="bar" unit="kg" digits={1} />
              <CageBars title={t('chart.feedCage')} data={cmp} valueKey="feedKg" label={t('col.feed')} unit="kg" digits={1} color={SERIES.aqua} />
              <TimeChart title={t('chart.waterDaily')} data={series ?? []} series={[{ key: 'waterLitres', label: t('chart.waterDaily'), color: SERIES.blue }]} unit="L" />
              <CageBars title={t('chart.waterCage')} data={cmp} valueKey="waterLitres" label={t('col.water')} unit="L" />
              <TimeChart title={t('chart.deathsSeries')} data={series ?? []} series={[{ key: 'deaths', label: t('chart.deathsSeries'), color: SERIES.red }]} kind="bar" />
              <TimeChart title={t('chart.cumulative')} data={(series ?? []).filter((p) => p.status !== 'not_started')} series={[{ key: 'cumulativeDeaths', label: t('chart.cumulative'), color: SERIES.orange }]} />
            </div>
          )}
          <div className="muted small row">
            <TrendingDown size={14} /> {t('eggs.productionNote')}
          </div>
        </div>
      )}
    </div>
  )
}
