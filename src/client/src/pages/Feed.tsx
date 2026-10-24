import { useEffect, useState } from 'react'
import { Save, Trash2, Wheat } from 'lucide-react'
import { feedConsumption } from '@shared/calc'
import { addDays } from '@shared/dates'
import type { FeedRecord } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, DateBar, DayGate, Empty, Field, Notice, NumInput, PageHeader, ReasonDialog, Stat, nz, useDay } from '../components/ui'
import { RangePicker, SERIES, TimeChart } from '../components/charts'

function feedErrorKey(error: string | null) {
  return error === 'stock_imbalance' ? 'feed_stock_imbalance' : error === 'returned_exceeds_issued' ? 'feed_returned_exceeds_issued' : 'quantity_positive'
}

interface Row {
  id: number | null
  openingStock: number | null
  issued: number | null
  returned: number | null
  wasted: number | null
  measured: number | null
  closingStock: number | null
  batchNo: string
  notes: string
  dirty: boolean
}

export function FeedPage() {
  const { t, num, workDate, toast, fail } = useApp()
  const { overview, writable } = useDay(workDate)
  const { data: items } = useLoad(() => call('inventory.balances', { category: 'feed' }), [])
  const feedItems = (items ?? []).filter((i) => i.active)
  const [itemId, setItemId] = useState<number | null>(null)
  const { data: records } = useLoad(() => call('feed.list', { date: workDate }), [workDate])
  const [rows, setRows] = useState<Record<number, Row>>({})
  const [busy, setBusy] = useState(false)
  const [toDelete, setToDelete] = useState<FeedRecord | null>(null)
  const [days, setDays] = useState(30)
  const { data: series } = useLoad(() => call('analytics.series', { from: addDays(workDate, -(days - 1)), to: workDate }), [workDate, days])
  const cages = overview?.cages ?? []

  useEffect(() => {
    if (itemId !== null || !feedItems.length || !records) return
    // Default to the feed type already used today, otherwise the main feed (largest stock).
    const used = records[0]?.itemId
    setItemId(used ?? [...feedItems].sort((a, b) => b.balance - a.balance)[0].id)
  }, [feedItems, itemId, records])

  useEffect(() => {
    if (!itemId || !overview?.dayId) return
    let alive = true
    ;(async () => {
      const next: Record<number, Row> = {}
      for (const c of cages) {
        const r = records?.find((x) => x.cageId === c.cageId && x.itemId === itemId)
        if (r) {
          next[c.cageId] = {
            id: r.id,
            openingStock: r.openingStock,
            issued: r.issued,
            returned: r.returned,
            wasted: r.wasted,
            measured: r.measuredConsumption,
            closingStock: r.closingStock,
            batchNo: r.batchNo ?? '',
            notes: r.notes ?? '',
            dirty: false
          }
        } else {
          const suggested = await call('feed.suggestOpening', { date: workDate, cageId: c.cageId, itemId })
          next[c.cageId] = {
            id: null,
            openingStock: suggested,
            issued: null,
            returned: null,
            wasted: null,
            measured: null,
            closingStock: null,
            batchNo: '',
            notes: '',
            dirty: false
          }
        }
      }
      if (alive) setRows(next)
    })().catch(fail)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, itemId, overview?.dayId, cages.length, workDate])

  const upd = (cageId: number, p: Partial<Row>) => setRows((x) => ({ ...x, [cageId]: { ...x[cageId], ...p, dirty: true } }))
  const toInput = (r: Row) => ({
    openingStock: r.openingStock,
    issued: r.issued ?? 0,
    returned: r.returned ?? 0,
    wasted: r.wasted ?? 0,
    measuredConsumption: r.measured,
    closingStock: r.closingStock
  })
  const dirty = Object.entries(rows).filter(([, r]) => r.dirty && (r.issued !== null || r.measured !== null || r.closingStock !== null))

  const saveAll = async () => {
    if (!itemId) return
    setBusy(true)
    let saved = 0
    for (const [cageId, r] of dirty) {
      try {
        await call('feed.save', { expectedId: r.id, date: workDate, cageId: Number(cageId), itemId, batchNo: nz(r.batchNo), notes: nz(r.notes), ...toInput(r) })
        saved++
      } catch (e) {
        fail(e)
        break
      }
    }
    setBusy(false)
    if (saved) toast('success', `${t('common.saved')} (${saved})`)
  }

  const store = feedItems.find((i) => i.id === itemId)
  const tot = overview?.totals
  const perHen = tot && tot.feedKg !== null && tot.avgHens > 0 ? (tot.feedKg * 1000) / tot.avgHens : null

  return (
    <div className="page">
      <PageHeader title={t('feed.title')} icon={<Wheat size={26} color="var(--brand)" />}>
        <DateBar />
      </PageHeader>
      <div className="stack">
        <DayGate overview={overview} />
        <div className="grid stats">
          <Stat
            label={t('dash.feedToday')}
            value={tot?.feedKg === null || !tot ? '—' : `${num(tot.feedKg, 1)} kg`}
            sub={tot?.feedIsEstimate ? t('feed.method.estimate') : undefined}
          />
          <Stat label={t('feed.perHen')} value={perHen === null ? '—' : `${num(perHen, 1)} g`} />
          {feedItems.map((i) => (
            <Stat
              key={i.id}
              label={`${t('feed.storeBalance')}: ${i.name}`}
              value={`${num(i.balance, 1)} ${i.unit}`}
              tone={i.balance < 0 ? 'bad' : i.isLow ? 'warn' : undefined}
              sub={i.isLow ? t('inv.low') : undefined}
            />
          ))}
        </div>
        {feedItems.length === 0 && <Notice tone="warn">{t('feed.noFeedItems')}</Notice>}
        {overview?.dayId && feedItems.length > 0 && (
          <Card
            title={t('feed.record')}
            actions={
              writable && (
                <button className="btn primary" disabled={busy || dirty.length === 0} onClick={saveAll}>
                  <Save size={18} />
                  {t('common.save')} {dirty.length > 0 && `(${dirty.length})`}
                </button>
              )
            }
          >
            <div className="stack">
              <Notice tone="info">{t('feed.methodHelp')}</Notice>
              <div className="row">
                <Field label={t('feed.type')}>
                  <select className="select" value={itemId ?? ''} onChange={(e) => setItemId(Number(e.target.value))} style={{ minWidth: 220 }}>
                    {feedItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {store && (
                  <span className="badge">
                    {t('feed.storeBalance')}: {num(store.balance, 1)} {store.unit}
                  </span>
                )}
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('common.cage')}</th>
                      <th className="num">{t('feed.openingStock')}</th>
                      <th className="num">{t('feed.issued')}</th>
                      <th className="num">{t('feed.returned')}</th>
                      <th className="num">{t('feed.wasted')}</th>
                      <th className="num">{t('feed.closingStock')}</th>
                      <th className="num">{t('feed.measured')}</th>
                      <th className="num">{t('feed.consumption')}</th>
                      <th>{t('feed.batch')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {cages.map((c) => {
                      const r = rows[c.cageId]
                      if (!r) return null
                      const calc = feedConsumption(toInput(r))
                      const record = records?.find((x) => x.id === r.id)
                      const dis = !writable
                      return (
                        <tr key={c.cageId} style={r.dirty ? { background: '#fffbea' } : undefined}>
                          <td>
                            <strong>{c.name}</strong>
                          </td>
                          <td style={{ width: 110 }}>
                            <NumInput decimals disabled={dis} value={r.openingStock} onChange={(v) => upd(c.cageId, { openingStock: v })} />
                          </td>
                          <td style={{ width: 110 }}>
                            <NumInput decimals disabled={dis} value={r.issued} onChange={(v) => upd(c.cageId, { issued: v })} />
                          </td>
                          <td style={{ width: 100 }}>
                            <NumInput decimals disabled={dis} value={r.returned} onChange={(v) => upd(c.cageId, { returned: v })} />
                          </td>
                          <td style={{ width: 100 }}>
                            <NumInput decimals disabled={dis} value={r.wasted} onChange={(v) => upd(c.cageId, { wasted: v })} />
                          </td>
                          <td style={{ width: 110 }}>
                            <NumInput decimals disabled={dis} value={r.closingStock} onChange={(v) => upd(c.cageId, { closingStock: v })} />
                          </td>
                          <td style={{ width: 110 }}>
                            <NumInput decimals disabled={dis} value={r.measured} onChange={(v) => upd(c.cageId, { measured: v })} />
                          </td>
                          <td className="num nowrap">
                            {calc.error ? (
                              <span className="badge bad" title={t('err.' + feedErrorKey(calc.error))}>
                                ! {t('issue.feed_inconsistent').split('—')[0]}
                              </span>
                            ) : calc.consumption === null ? (
                              '—'
                            ) : (
                              <>
                                <strong>{num(calc.consumption, 1)}</strong>{' '}
                                <span className={`badge ${calc.isEstimate ? 'warn' : 'good'}`}>{t('feed.method.' + calc.method)}</span>
                              </>
                            )}
                          </td>
                          <td style={{ width: 110 }}>
                            <input className="input" disabled={dis} value={r.batchNo} onChange={(e) => upd(c.cageId, { batchNo: e.target.value })} />
                          </td>
                          <td>
                            {record && writable && (
                              <button className="icon-btn" title={t('common.delete')} onClick={() => setToDelete(record)}>
                                <Trash2 size={16} />
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {Object.values(rows)
                .map((r) => feedConsumption(toInput(r)).error)
                .filter(Boolean)
                .slice(0, 1)
                .map((err) => (
                  <Notice key={err} tone="bad">
                    {t('err.' + feedErrorKey(err))}
                  </Notice>
                ))}
            </div>
          </Card>
        )}
        <div className="row end">
          <RangePicker days={days} onChange={setDays} />
        </div>
        <div className="grid cols-2">
          <TimeChart
            title={t('chart.feedDaily')}
            data={series ?? []}
            series={[{ key: 'feedKg', label: t('chart.feedDaily'), color: SERIES.aqua }]}
            kind="bar"
            unit="kg"
            digits={1}
            note={t('chart.missingDays')}
          />
          <TimeChart
            title={t('chart.feedPerHen')}
            data={series ?? []}
            series={[{ key: 'feedPerHenG', label: t('chart.feedPerHen'), color: SERIES.blue }]}
            unit="g"
            digits={1}
          />
        </div>
        {!series && <Empty text={t('common.loading')} />}
      </div>
      {toDelete && (
        <ReasonDialog
          title={t('common.deleteTitle')}
          hint={`${toDelete.cageName} — ${toDelete.itemName}. ${t('common.deleteHint')}`}
          danger
          confirmLabel={t('common.delete')}
          onClose={() => setToDelete(null)}
          onSubmit={(reason) => call('feed.delete', { id: toDelete.id, reason })}
        />
      )}
    </div>
  )
}
