import { useEffect, useState } from 'react'
import { Droplets, Save, Trash2, Wrench } from 'lucide-react'
import { waterConsumption } from '@shared/calc'
import { addDays } from '@shared/dates'
import type { WaterRecord } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, DateBar, DayGate, Field, Modal, Notice, NumInput, PageHeader, ReasonDialog, Seg, Stat, nz, useDay } from '../components/ui'
import { CageBars, RangePicker, SERIES, TimeChart } from '../components/charts'

interface Row {
  id: number | null
  method: 'meter' | 'manual'
  opening: number | null
  closing: number | null
  litres: number | null
  meterReset: boolean
  notes: string
  dirty: boolean
}

export function WaterPage() {
  const { t, num, workDate, toast, fail, can } = useApp()
  const { overview, writable } = useDay(workDate)
  const { data: records } = useLoad(() => call('water.list', { date: workDate }), [workDate])
  const { data: cageList } = useLoad(() => call('cages.list', { includeInactive: true }), [])
  const [rows, setRows] = useState<Record<number, Row>>({})
  const [busy, setBusy] = useState(false)
  const [reset, setReset] = useState<{ cageId: number; name: string } | null>(null)
  const [toDelete, setToDelete] = useState<WaterRecord | null>(null)
  const [days, setDays] = useState(30)
  const { data: series } = useLoad(() => call('analytics.series', { from: addDays(workDate, -(days - 1)), to: workDate }), [workDate, days])
  const { data: comparison } = useLoad(() => call('analytics.comparison', { from: addDays(workDate, -(days - 1)), to: workDate }), [workDate, days])
  const cages = overview?.cages ?? []

  useEffect(() => {
    if (!overview?.dayId || !cageList) return
    let alive = true
    ;(async () => {
      const next: Record<number, Row> = {}
      for (const c of cages) {
        const r = records?.find((x) => x.cageId === c.cageId)
        const hasMeter = cageList.find((x) => x.id === c.cageId)?.hasWaterMeter ?? true
        if (r) next[c.cageId] = { id: r.id, method: r.method, opening: r.openingReading, closing: r.closingReading, litres: r.litres, meterReset: r.meterReset, notes: r.notes ?? '', dirty: false }
        else {
          const opening = hasMeter ? await call('water.suggestOpening', { date: workDate, cageId: c.cageId }) : null
          next[c.cageId] = { id: null, method: hasMeter ? 'meter' : 'manual', opening, closing: null, litres: null, meterReset: false, notes: '', dirty: false }
        }
      }
      if (alive) setRows(next)
    })().catch(fail)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, overview?.dayId, cages.length, cageList, workDate])

  const upd = (cageId: number, p: Partial<Row>) => setRows((x) => ({ ...x, [cageId]: { ...x[cageId], ...p, dirty: true } }))
  const calc = (r: Row) => waterConsumption({ method: r.method, openingReading: r.opening, closingReading: r.closing, litres: r.litres, meterReset: r.meterReset })
  const dirty = Object.entries(rows).filter(([, r]) => r.dirty && !r.meterReset && (r.method === 'manual' ? r.litres !== null : r.closing !== null || r.opening !== null))

  const saveAll = async () => {
    setBusy(true)
    let saved = 0
    for (const [cageId, r] of dirty) {
      try {
        await call('water.save', { expectedId: r.id, date: workDate, cageId: Number(cageId), method: r.method, openingReading: r.opening, closingReading: r.closing, litres: r.method === 'manual' ? r.litres : null, meterReset: false, correctionReason: null, notes: nz(r.notes) })
        saved++
      } catch (e) {
        fail(e)
        break
      }
    }
    setBusy(false)
    if (saved) toast('success', `${t('common.saved')} (${saved})`)
  }

  const tot = overview?.totals
  return (
    <div className="page">
      <PageHeader title={t('water.title')} icon={<Droplets size={26} color="var(--brand)" />}>
        <DateBar />
      </PageHeader>
      <div className="stack">
        <DayGate overview={overview} />
        <div className="grid stats">
          <Stat label={t('dash.waterToday')} value={tot?.waterLitres === null || !tot ? '—' : `${num(tot.waterLitres)} L`} />
          <Stat label={t('common.hens')} value={tot ? num(tot.closing) : '—'} sub={tot && tot.waterLitres !== null && tot.avgHens > 0 ? `${num((tot.waterLitres * 1000) / tot.avgHens, 0)} ml / ${t('common.hens')}` : undefined} />
        </div>
        <Notice tone="info">{t('water.note')}</Notice>
        {overview?.dayId && (
          <Card
            title={t('water.record')}
            actions={
              writable && (
                <button className="btn primary" disabled={busy || dirty.length === 0} onClick={saveAll}>
                  <Save size={18} />
                  {t('common.save')} {dirty.length > 0 && `(${dirty.length})`}
                </button>
              )
            }
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('common.cage')}</th>
                    <th>{t('water.method')}</th>
                    <th className="num">{t('water.openingReading')}</th>
                    <th className="num">{t('water.closingReading')}</th>
                    <th className="num">{t('water.litres')}</th>
                    <th>{t('common.notes')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {cages.map((c) => {
                    const r = rows[c.cageId]
                    if (!r) return null
                    const res = calc(r)
                    const record = records?.find((x) => x.id === r.id)
                    return (
                      <tr key={c.cageId} style={r.dirty ? { background: '#fffbea' } : undefined}>
                        <td>
                          <strong>{c.name}</strong>
                        </td>
                        <td>
                          <Seg
                            value={r.method}
                            options={[
                              { value: 'meter', label: t('water.method.meter') },
                              { value: 'manual', label: t('water.method.manual') }
                            ]}
                            onChange={(m) => writable && upd(c.cageId, { method: m })}
                          />
                        </td>
                        <td style={{ width: 130 }}>{r.method === 'meter' ? <NumInput decimals disabled={!writable} value={r.opening} onChange={(v) => upd(c.cageId, { opening: v })} /> : '—'}</td>
                        <td style={{ width: 130 }}>{r.method === 'meter' ? <NumInput decimals disabled={!writable} value={r.closing} invalid={res.error === 'closing_below_opening'} onChange={(v) => upd(c.cageId, { closing: v })} /> : '—'}</td>
                        <td className="num" style={{ width: 130 }}>
                          {r.method === 'manual' ? (
                            <NumInput decimals disabled={!writable} value={r.litres} onChange={(v) => upd(c.cageId, { litres: v })} />
                          ) : res.error === 'closing_below_opening' ? (
                            <span className="badge bad">!</span>
                          ) : (
                            <strong>{res.litres === null ? '—' : num(res.litres, 1)}</strong>
                          )}
                          {r.meterReset && <div className="badge warn">{t('water.meterReset').split('(')[0]}</div>}
                        </td>
                        <td>
                          <input className="input" disabled={!writable} value={r.notes} onChange={(e) => upd(c.cageId, { notes: e.target.value })} />
                        </td>
                        <td className="nowrap">
                          {can('water.meter_reset') && writable && r.method === 'meter' && (
                            <button className="icon-btn" title={t('water.meterReset')} onClick={() => setReset({ cageId: c.cageId, name: c.name })}>
                              <Wrench size={16} />
                            </button>
                          )}
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
            {Object.values(rows).some((r) => calc(r).error === 'closing_below_opening') && (
              <div className="mt">
                <Notice tone="bad">{t('err.meter_closing_below_opening')}</Notice>
              </div>
            )}
          </Card>
        )}
        <div className="row end">
          <RangePicker days={days} onChange={setDays} />
        </div>
        <div className="grid cols-2">
          <TimeChart title={t('chart.waterDaily')} data={series ?? []} series={[{ key: 'waterLitres', label: t('chart.waterDaily'), color: SERIES.blue }]} unit="L" note={t('chart.missingDays')} />
          <CageBars title={t('chart.waterCage')} data={(comparison ?? [])} valueKey="waterLitres" label={t('col.water')} unit="L" />
        </div>
      </div>
      {reset && rows[reset.cageId] && <MeterReset date={workDate} cage={reset} row={rows[reset.cageId]} onClose={() => setReset(null)} />}
      {toDelete && (
        <ReasonDialog
          title={t('common.deleteTitle')}
          hint={`${toDelete.cageName}. ${t('common.deleteHint')}`}
          danger
          confirmLabel={t('common.delete')}
          onClose={() => setToDelete(null)}
          onSubmit={(reason) => call('water.delete', { id: toDelete.id, reason })}
        />
      )}
    </div>
  )
}

function MeterReset({ date, cage, row, onClose }: { date: string; cage: { cageId: number; name: string }; row: Row; onClose: () => void }) {
  const { t, fail, toast } = useApp()
  const [opening, setOpening] = useState(row.opening)
  const [closing, setClosing] = useState(row.closing)
  const [litres, setLitres] = useState<number | null>(row.litres)
  const [reason, setReason] = useState('')
  const ok = litres !== null && reason.trim().length >= 3
  return (
    <Modal
      title={`${t('water.meterReset')} — ${cage.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!ok}
            onClick={async () => {
              try {
                await call('water.save', { expectedId: row.id, date, cageId: cage.cageId, method: 'meter', openingReading: opening, closingReading: closing, litres, meterReset: true, correctionReason: reason.trim(), notes: null })
                toast('success', t('common.saved'))
                onClose()
              } catch (e) {
                fail(e)
              }
            }}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Notice tone="warn">{t('err.litres_required_after_reset')}</Notice>
        <div className="form-grid">
          <Field label={t('water.openingReading')}>
            <NumInput decimals value={opening} onChange={setOpening} />
          </Field>
          <Field label={t('water.closingReading')}>
            <NumInput decimals value={closing} onChange={setClosing} />
          </Field>
          <Field label={t('water.litres')} required>
            <NumInput decimals value={litres} onChange={setLitres} />
          </Field>
        </div>
        <Field label={t('water.resetReason')} required>
          <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
