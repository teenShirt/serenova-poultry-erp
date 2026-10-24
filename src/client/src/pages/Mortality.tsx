import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeftRight, CheckCircle2, Plus, Trash2, TrendingDown } from 'lucide-react'
import { addDays } from '@shared/dates'
import type { FlockMovement } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, CageSelect, DateBar, DayGate, Empty, Field, Modal, Notice, NumInput, PageHeader, ReasonDialog, Seg, Stat, nz, useDay } from '../components/ui'
import { CageBars, RangePicker, SERIES, TimeChart } from '../components/charts'

export function MortalityPage() {
  const { t, num, workDate, fail } = useApp()
  const { overview, writable } = useDay(workDate)
  const { data: moves } = useLoad(() => call('flock.list', { date: workDate }), [workDate])
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(params.get('new') === '1')
  useEffect(() => {
    if (params.get('new') === '1') {
      setAdding(true)
      setParams({}, { replace: true })
    }
  }, [params, setParams])
  const [transfer, setTransfer] = useState(false)
  const [toDelete, setToDelete] = useState<FlockMovement | null>(null)
  const [days, setDays] = useState(30)
  const from = addDays(workDate, -(days - 1))
  const { data: series } = useLoad(() => call('analytics.series', { from, to: workDate }), [workDate, days])
  const { data: comparison } = useLoad(() => call('analytics.comparison', { from, to: workDate }), [workDate, days])
  const tot = overview?.totals
  const cages = overview?.cages ?? []

  return (
    <div className="page">
      <PageHeader title={t('flock.title')} icon={<TrendingDown size={26} color="var(--brand)" />}>
        <DateBar />
      </PageHeader>
      <div className="stack">
        <DayGate overview={overview} />
        <div className="grid stats">
          <Stat label={t('dash.openingHens')} value={num(tot?.opening)} />
          <Stat label={t('dash.deathsToday')} value={num(tot?.movements.deaths)} tone={tot && tot.movements.deaths > 0 ? 'warn' : undefined} sub={tot?.mortalityPct === null || !tot ? undefined : `${num(tot.mortalityPct, 3)}%`} />
          <Stat label={t('dash.currentHens')} value={num(tot?.closing)} />
        </div>
        <Card
          title={t('flock.balance')}
          actions={
            writable && (
              <div className="row">
                <button className="btn" onClick={() => setTransfer(true)}>
                  <ArrowLeftRight size={18} />
                  {t('flock.transfer')}
                </button>
                <button className="btn primary" onClick={() => setAdding(true)}>
                  <Plus size={18} />
                  {t('flock.record')}
                </button>
              </div>
            )
          }
        >
          <div className="muted small" style={{ marginBottom: 8 }}>
            {t('flock.formula')} · {t('flock.mortalityNote')}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.cage')}</th>
                  <th className="num">{t('col.opening')}</th>
                  <th className="num">{t('col.additions')}</th>
                  <th className="num">{t('col.transfersIn')}</th>
                  <th className="num">{t('col.transfersOut')}</th>
                  <th className="num">{t('col.deaths')}</th>
                  <th className="num">{t('col.removals')}</th>
                  <th className="num">{t('col.closing')}</th>
                  <th className="num">{t('col.mortality')}</th>
                  <th>{t('day.mortalityConfirmed')}</th>
                </tr>
              </thead>
              <tbody>
                {cages.map((c) => (
                  <tr key={c.cageId}>
                    <td>
                      <strong>{c.name}</strong>
                    </td>
                    <td className="num">{num(c.opening)}</td>
                    <td className="num">{c.movements.additions || '·'}</td>
                    <td className="num">{c.movements.transfersIn || '·'}</td>
                    <td className="num">{c.movements.transfersOut || '·'}</td>
                    <td className="num">{c.movements.deaths ? <strong style={{ color: 'var(--bad)' }}>{c.movements.deaths}</strong> : '·'}</td>
                    <td className="num">{c.movements.removals || '·'}</td>
                    <td className="num">
                      <strong>{num(c.closing)}</strong>
                    </td>
                    <td className="num">{c.mortalityPct === null ? '—' : num(c.mortalityPct, 3)}</td>
                    <td>
                      {c.mortalityConfirmed ? (
                        <span className="badge good">
                          <CheckCircle2 size={12} /> ✓
                        </span>
                      ) : writable ? (
                        <button className="btn sm" onClick={() => call('days.confirmMortality', { date: workDate, cageIds: [c.cageId] }).catch(fail)}>
                          {t('day.confirmMortality')}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title={t('flock.history')}>
          {!moves || moves.length === 0 ? (
            <Empty text={t('common.noData')} />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('common.cage')}</th>
                    <th>{t('common.type')}</th>
                    <th className="num">{t('common.quantity')}</th>
                    <th>{t('common.reason')}</th>
                    <th>{t('common.notes')}</th>
                    <th>{t('common.recordedBy')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.cageName}
                        {m.counterpartCageName && <span className="muted"> ↔ {m.counterpartCageName}</span>}
                      </td>
                      <td>
                        <span className={`badge ${m.type === 'death' ? 'bad' : m.type.startsWith('transfer') ? 'info' : ''}`}>{t('flock.type.' + m.type)}</span>
                      </td>
                      <td className="num">{m.quantity}</td>
                      <td>{m.reason ?? ''}</td>
                      <td>{m.notes ?? ''}</td>
                      <td>{m.recordedBy}</td>
                      <td>
                        {writable && (
                          <button className="icon-btn" title={t('common.delete')} onClick={() => setToDelete(m)}>
                            <Trash2 size={16} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="row end">
          <RangePicker days={days} onChange={setDays} />
        </div>
        <div className="grid cols-2">
          <TimeChart title={t('chart.deathsSeries')} data={series ?? []} series={[{ key: 'deaths', label: t('chart.deathsSeries'), color: SERIES.red }]} kind="bar" />
          <TimeChart title={t('chart.cumulative')} data={(series ?? []).filter((p) => p.status !== 'not_started')} series={[{ key: 'cumulativeDeaths', label: t('chart.cumulative'), color: SERIES.orange }]} />
          <CageBars title={`${t('rep.compare')} — ${t('col.deaths')}`} data={(comparison ?? [])} valueKey="deaths" label={t('col.deaths')} color={SERIES.red} />
        </div>
      </div>
      {adding && <AddMovement date={workDate} cages={cages.map((c) => ({ id: c.cageId, name: c.name, closing: c.closing }))} onClose={() => setAdding(false)} />}
      {transfer && <Transfer date={workDate} cages={cages.map((c) => ({ id: c.cageId, name: c.name, closing: c.closing }))} onClose={() => setTransfer(false)} />}
      {toDelete && (
        <ReasonDialog
          title={t('common.deleteTitle')}
          hint={`${toDelete.cageName} — ${t('flock.type.' + toDelete.type)}: ${toDelete.quantity}. ${t('common.deleteHint')}`}
          danger
          confirmLabel={t('common.delete')}
          onClose={() => setToDelete(null)}
          onSubmit={(reason) => call('flock.delete', { id: toDelete.id, reason })}
        />
      )}
    </div>
  )
}

type CageOpt = { id: number; name: string; closing: number }

function AddMovement({ date, cages, onClose }: { date: string; cages: CageOpt[]; onClose: () => void }) {
  const { t, toast, fail } = useApp()
  const [cageId, setCageId] = useState<number | null>(cages[0]?.id ?? null)
  const [type, setType] = useState<'death' | 'removal' | 'addition'>('death')
  const [quantity, setQuantity] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const needReason = type !== 'death'
  const ok = cageId !== null && quantity !== null && quantity > 0 && (!needReason || reason.trim().length >= 3)
  return (
    <Modal
      title={t('flock.record')}
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
                await call('flock.add', { date, cageId: cageId!, type, quantity: quantity!, reason: nz(reason), notes: nz(notes) })
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
        <Seg
          value={type}
          options={[
            { value: 'death', label: t('flock.type.death') },
            { value: 'removal', label: t('flock.type.removal') },
            { value: 'addition', label: t('flock.type.addition') }
          ]}
          onChange={setType}
        />
        <div className="form-grid">
          <Field label={t('common.cage')}>
            <CageSelect cages={cages.map((c) => ({ id: c.id, name: c.name }))} value={cageId} onChange={setCageId} />
          </Field>
          <Field label={t('common.quantity')} required hint={cageId ? `${t('dash.currentHens')}: ${cages.find((c) => c.id === cageId)?.closing}` : undefined}>
            <NumInput big value={quantity} onChange={setQuantity} autoFocus />
          </Field>
        </div>
        <Field label={t('common.reason')} required={needReason}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <Field label={t('common.notes')}>
          <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

function Transfer({ date, cages, onClose }: { date: string; cages: CageOpt[]; onClose: () => void }) {
  const { t, toast, fail } = useApp()
  const [from, setFrom] = useState<number | null>(cages[0]?.id ?? null)
  const [to, setTo] = useState<number | null>(cages[1]?.id ?? null)
  const [quantity, setQuantity] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const ok = from !== null && to !== null && from !== to && quantity !== null && quantity > 0
  const opts = cages.map((c) => ({ id: c.id, name: c.name }))
  return (
    <Modal
      title={t('flock.transfer')}
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
                await call('flock.transfer', { date, fromCageId: from!, toCageId: to!, quantity: quantity!, reason: nz(reason), notes: null })
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
        <div className="form-grid">
          <Field label={t('flock.fromCage')}>
            <CageSelect cages={opts} value={from} onChange={setFrom} />
          </Field>
          <Field label={t('flock.toCage')}>
            <CageSelect cages={opts} value={to} onChange={setTo} />
          </Field>
          <Field label={t('common.quantity')} required hint={from ? `${t('dash.currentHens')}: ${cages.find((c) => c.id === from)?.closing}` : undefined}>
            <NumInput big value={quantity} onChange={setQuantity} />
          </Field>
        </div>
        {from !== null && from === to && <Notice tone="warn">{t('err.transfer_same_cage')}</Notice>}
        <Field label={t('common.reason')}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
