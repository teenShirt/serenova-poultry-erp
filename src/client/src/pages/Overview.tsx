import { useState } from 'react'
import { Building, Info } from 'lucide-react'
import { addDays } from '@shared/dates'
import type { FarmOverviewRow } from '@shared/overview'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Notice, PageHeader } from '../components/ui'
import { CageBars, RangePicker, SERIES, TimeChart } from '../components/charts'
import { CsvButton } from '../components/Export'

const FARM_COLORS = [SERIES.blue, SERIES.orange, SERIES.aqua, SERIES.yellow, SERIES.red]

/**
 * Organization overview: every farm side by side for the chosen period, with totals. Production
 * figures count closed days only; the definitions are shown under the table.
 */
export function OverviewPage() {
  const { t, num, date, status } = useApp()
  const [days, setDays] = useState(30)
  const to = status.today
  const from = addDays(to, -(days - 1))
  const { data: o } = useLoad(() => call('overview.organization', { from, to }), [from, to])
  const [showDefs, setShowDefs] = useState(false)
  const n = (v: number | null, d = 0) => (v === null ? '—' : num(v, d))

  const cols: { key: keyof FarmOverviewRow; label: string; digits?: number; tone?: (r: FarmOverviewRow) => string }[] = [
    { key: 'birdsNow', label: t('ov.birdsNow') },
    { key: 'eggs', label: t('ov.eggs') },
    { key: 'layingPct', label: t('ov.layingPct'), digits: 1 },
    { key: 'deaths', label: t('ov.deaths') },
    { key: 'culls', label: t('ov.culls') },
    { key: 'mortalityPct', label: t('ov.mortalityPct'), digits: 2 },
    { key: 'feedKg', label: t('ov.feedKg'), digits: 1 },
    { key: 'feedPerBirdG', label: t('ov.feedPerBird'), digits: 1 },
    ...(status.settings.waterTracking ? [{ key: 'waterLitres' as const, label: t('ov.waterL') }] : []),
    { key: 'activeFlocks', label: t('ov.flocks') },
    { key: 'tasksOverdue', label: t('ov.tasksOverdue'), tone: (r) => (r.tasksOverdue ? 'bad' : '') },
    { key: 'remindersDue', label: t('ov.reminders'), tone: (r) => (r.remindersDue ? 'warn' : '') },
    { key: 'lowStockItems', label: t('ov.lowStock'), tone: (r) => (r.lowStockItems ? 'warn' : '') },
    { key: 'expiringBatches', label: t('ov.expiring'), tone: (r) => (r.expiringBatches ? 'warn' : '') }
  ]

  return (
    <div className="page stack">
      <PageHeader title={t('ov.title')} icon={<Building size={26} color="var(--brand)" />}>
        <RangePicker days={days} onChange={setDays} />
        <CsvButton kind="organization" from={from} to={to} />
      </PageHeader>
      {!o ? (
        <div className="muted">{t('app.loading')}</div>
      ) : (
        <>
          {o.totals.openDays > 0 && <Notice tone="info">{t('ov.openDaysNote', { count: o.totals.openDays })}</Notice>}
          <Card
            title={t('ov.byFarm', { from: date(from), to: date(to) })}
            actions={
              <button className="btn sm" onClick={() => setShowDefs(!showDefs)}>
                <Info size={15} /> {t('ov.howCalculated')}
              </button>
            }
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('ov.farm')}</th>
                    <th className="num">{t('ov.closedDays')}</th>
                    {cols.map((c) => (
                      <th key={c.key} className="num">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {o.farms.map((r) => (
                    <tr key={r.farmId}>
                      <td>
                        <strong>{r.farmName}</strong>
                      </td>
                      <td className="num">{r.closedDays}</td>
                      {cols.map((c) => (
                        <td key={c.key} className={`num ${c.tone?.(r) ?? ''}`}>
                          {n(r[c.key] as number | null, c.digits)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {o.farms.length > 1 && (
                  <tfoot>
                    <tr>
                      <th>{t('common.total')}</th>
                      <th className="num">{o.totals.closedDays}</th>
                      {cols.map((c) => (
                        <th key={c.key} className="num">
                          {n(o.totals[c.key as keyof typeof o.totals] as number | null, c.digits)}
                        </th>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {showDefs && (
              <ul className="defs small">
                {['birdsNow', 'birdDays', 'laying', 'mortality', 'feedPerBird', 'culls', 'closedOnly', 'totals', 'stock'].map((k) => (
                  <li key={k}>{t('ov.def.' + k)}</li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid cols-2">
            <TimeChart
              title={t('ov.eggTrend')}
              data={o.trend}
              series={o.farms.map((f, i) => ({ key: String(f.farmId), label: f.farmName, color: FARM_COLORS[i % FARM_COLORS.length] }))}
              note={t('ov.closedOnlyNote')}
            />
            <CageBars
              title={t('ov.layingByFarm')}
              data={o.farms.map((f) => ({ name: f.farmName, v: f.layingPct ?? 0 }))}
              valueKey="v"
              label={t('ov.layingPct')}
              unit="%"
              digits={1}
            />
          </div>

          <div className="grid cols-2">
            <Card title={t('ov.stockAlerts')}>
              {o.stockAlerts.length === 0 && o.expiring.length === 0 ? (
                <Empty text={t('ov.noStockAlerts')} />
              ) : (
                <table className="data">
                  <tbody>
                    {o.stockAlerts.map((a, i) => (
                      <tr key={'s' + i}>
                        <td>
                          <strong>{a.item}</strong>
                          <div className="muted small">
                            {a.farmName} · {a.warehouseName}
                          </div>
                        </td>
                        <td className="num">
                          {num(a.balance, 1)} {a.unit}
                        </td>
                        <td>
                          <span className={`badge ${a.kind === 'low' ? 'bad' : 'warn'}`}>{a.kind === 'low' ? t('inv.low') : t('stores.reorder')}</span>
                        </td>
                      </tr>
                    ))}
                    {o.expiring.map((e, i) => (
                      <tr key={'e' + i}>
                        <td>
                          <strong>{e.item}</strong> <span className="muted small">{e.batchNo}</span>
                          <div className="muted small">{e.farmName}</div>
                        </td>
                        <td className="num">
                          {num(e.balance, 1)} {e.unit}
                        </td>
                        <td>
                          <span className={`badge ${e.daysToExpiry < 0 ? 'bad' : 'warn'}`}>
                            {e.daysToExpiry < 0 ? t('ov.expired') : t('ov.expiresIn', { n: e.daysToExpiry })}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title={t('ov.remindersTitle')}>
              {o.reminders.length === 0 ? (
                <Empty text={t('ov.noReminders')} />
              ) : (
                <table className="data">
                  <tbody>
                    {o.reminders.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <strong>{r.title}</strong>
                          <div className="muted small">
                            {r.farmName} · {r.flockCode} · {t('flk.weekN', { n: r.atWeek })}
                          </div>
                        </td>
                        <td>{date(r.dueOn)}</td>
                        <td>
                          <span className={`badge ${r.state === 'overdue' ? 'bad' : 'warn'}`}>{t('flk.rstate.' + r.state)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <div className="grid cols-2">
            <Card title={t('ov.recentReceipts')}>
              {o.recentReceipts.length === 0 ? (
                <Empty text={t('common.noData')} />
              ) : (
                <table className="data">
                  <tbody>
                    {o.recentReceipts.map((r) => (
                      <tr key={r.grnNo}>
                        <td>
                          <strong>{r.grnNo}</strong>
                          <div className="muted small">
                            {r.supplier ?? '—'} · {r.store}
                          </div>
                        </td>
                        <td>{date(r.date)}</td>
                        <td className="num">
                          {status.settings.currency} {num(r.total, 2)}
                        </td>
                        <td>
                          <span className={`badge ${r.status === 'posted' ? 'good' : r.status === 'submitted' ? 'warn' : 'bad'}`}>
                            {t('pur.status.' + r.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title={t('ov.recentMovements')}>
              {o.recentMovements.length === 0 ? (
                <Empty text={t('common.noData')} />
              ) : (
                <table className="data">
                  <tbody>
                    {o.recentMovements.map((m, i) => (
                      <tr key={i}>
                        <td>{date(m.date)}</td>
                        <td>
                          {m.item}
                          <div className="muted small">
                            {m.store} · {t('txn.' + m.type)}
                          </div>
                        </td>
                        <td className={`num ${m.quantity < 0 ? 'bad' : ''}`}>
                          {m.quantity > 0 ? '+' : ''}
                          {num(m.quantity, 2)} {m.unit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
