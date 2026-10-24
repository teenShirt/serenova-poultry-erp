import { useState } from 'react'
import { Banknote, Bird, Egg, GitBranch, PackagePlus, Truck, Warehouse, Wheat } from 'lucide-react'
import { addDays } from '@shared/dates'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, PageHeader } from '../components/ui'
import { RangePicker, SERIES, TimeChart } from '../components/charts'

/**
 * The farm as one chain for a period:
 * feed received → feed store → issued to cages → hens → eggs collected → egg store → dispatched → money.
 */
export function FlowPage() {
  const { t, num, status } = useApp()
  const [days, setDays] = useState(30)
  const to = status.today
  const from = addDays(to, -(days - 1))
  const { data: flow } = useLoad(() => call('supply.flow', { from, to }), [from, to])
  const { data: feed } = useLoad(() => call('purchases.series', { from, to }), [from, to])
  const { data: eggs } = useLoad(() => call('sales.series', { from, to }), [from, to])
  const money = (n: number | null | undefined) => `${status.settings.currency} ${num(n ?? 0, 0)}`
  const moneyChart = (eggs ?? []).map((d, i) => ({ date: d.date, revenue: d.revenue, cost: feed?.[i]?.cost ?? 0 }))

  return (
    <div className="page">
      <PageHeader title={t('flow.title')} icon={<GitBranch size={26} color="var(--brand)" />}>
        <RangePicker days={days} onChange={setDays} />
      </PageHeader>
      {!flow ? (
        <div className="muted">{t('common.loading')}</div>
      ) : (
        <div className="stack">
          <div className="muted">{t('flow.intro')}</div>
          <div className="flow-chain" role="list">
            <Node icon={<PackagePlus size={14} />} label={t('flow.received')} value={`${num(flow.feed.receivedKg)} kg`} sub={money(flow.feed.purchaseCost)} />
            <Node
              icon={<Warehouse size={14} />}
              label={t('flow.feedStore')}
              value={`${num(flow.feed.closingKg)} kg`}
              sub={t('flow.opening', { value: `${num(flow.feed.openingKg)} kg` })}
            />
            <Node
              icon={<Wheat size={14} />}
              label={t('flow.issued')}
              value={`${num(flow.feed.issuedKg)} kg`}
              sub={flow.feed.consumedKg === null ? t('common.unknown') : t('flow.eaten', { value: `${num(flow.feed.consumedKg)} kg` })}
            />
            <Node icon={<Bird size={14} />} label={t('flow.hens')} value={num(flow.hens.closing)} sub={t('flow.deaths', { count: num(flow.hens.deaths) })} />
            <Node
              icon={<Egg size={14} />}
              label={t('flow.collected')}
              value={num(flow.eggs.collected)}
              sub={`${t('col.good')} ${num(flow.eggs.good)} · ${t('col.damaged')} ${num(flow.eggs.cracked)}`}
            />
            <Node
              icon={<Truck size={14} />}
              label={t('flow.dispatched')}
              value={num(flow.eggs.dispatchedGood + flow.eggs.dispatchedCracked)}
              sub={t('flow.inStore', { good: num(flow.eggs.closingGood), cracked: num(flow.eggs.closingCracked) })}
            />
          </div>
          <div className="grid stats">
            <Node
              money
              icon={<Banknote size={14} />}
              label={t('flow.sales')}
              value={money(flow.money.sales)}
              sub={t('flow.receivedMoney', { value: money(flow.money.received) })}
            />
            <Node money icon={<Banknote size={14} />} label={t('sal.outstanding')} value={money(flow.money.outstanding)} />
            <Node icon={<PackagePlus size={14} />} label={t('pur.cost')} value={money(flow.money.purchases)} />
            <Node icon={<Banknote size={14} />} label={t('flow.margin')} value={money(flow.money.sales - flow.money.purchases)} sub={t('flow.marginHint')} />
          </div>
          <div className="grid cols-2">
            <TimeChart
              title={t('pur.inOut')}
              data={feed ?? []}
              kind="bar"
              unit="kg"
              series={[
                { key: 'feedKg', label: t('pur.received'), color: SERIES.aqua },
                { key: 'feedIssuedKg', label: t('pur.issued'), color: SERIES.orange }
              ]}
            />
            <TimeChart
              title={t('sal.inOut')}
              data={eggs ?? []}
              kind="bar"
              series={[
                { key: 'collectedGood', label: t('sal.collected'), color: SERIES.blue },
                { key: 'dispatchedGood', label: t('sal.dispatched'), color: SERIES.orange }
              ]}
            />
            <TimeChart
              title={t('flow.stores')}
              data={(eggs ?? []).map((d, i) => ({ date: d.date, eggs: d.stockGood, feed: feed?.[i]?.feedStockKg ?? null }))}
              series={[{ key: 'eggs', label: t('sal.stockGood'), color: SERIES.blue }]}
            />
            <TimeChart
              title={t('flow.moneyChart')}
              data={moneyChart}
              kind="bar"
              unit={status.settings.currency}
              series={[
                { key: 'revenue', label: t('sal.revenue'), color: SERIES.aqua },
                { key: 'cost', label: t('pur.cost'), color: SERIES.orange }
              ]}
            />
          </div>
          <div className="grid cols-2">
            <Card title={t('flow.topCustomers')}>
              {flow.topCustomers.length === 0 ? (
                <Empty text={t('common.noData')} />
              ) : (
                <table className="data">
                  <tbody>
                    {flow.topCustomers.map((c) => (
                      <tr key={c.name}>
                        <td>
                          <strong>{c.name}</strong>
                        </td>
                        <td className="num">
                          {num(c.eggs)} {t('common.eggs')}
                        </td>
                        <td className="num">{money(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title={t('flow.topSuppliers')}>
              {flow.topSuppliers.length === 0 ? (
                <Empty text={t('common.noData')} />
              ) : (
                <table className="data">
                  <tbody>
                    {flow.topSuppliers.map((s) => (
                      <tr key={s.name}>
                        <td>
                          <strong>{s.name}</strong>
                        </td>
                        <td className="num">{num(s.quantity)}</td>
                        <td className="num">{money(s.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}

function Node({ icon, label, value, sub, money }: { icon: React.ReactNode; label: string; value: string; sub?: string; money?: boolean }) {
  return (
    <div className={`flow-node ${money ? 'money' : ''}`} role="listitem">
      <span className="flow-label">
        {icon}
        {label}
      </span>
      <span className="flow-value">{value}</span>
      {sub && <span className="flow-sub">{sub}</span>}
    </div>
  )
}
