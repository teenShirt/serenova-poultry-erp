import { useState } from 'react'
import { Bird, CheckCircle2, Plus, X } from 'lucide-react'
import { addDays } from '@shared/dates'
import type { FlockDetail, FlockInput, FlockSummary, ReminderDue, ReminderRow } from '@shared/flocks'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, NumInput, PageHeader, ReasonDialog, Stat, Tabs, nz } from '../components/ui'
import { RangePicker, SERIES, TimeChart } from '../components/charts'

/** Default production stage names are translated; names typed by the organization are shown as typed. */
export function useStageName() {
  const { t } = useApp()
  return (name: string | null) => {
    if (!name) return '—'
    const key = 'stage.' + name
    const s = t(key)
    return s === key ? name : s
  }
}

export function FlocksPage() {
  const { t, can } = useApp()
  const [tab, setTab] = useState<'flocks' | 'reminders'>('flocks')
  const [editing, setEditing] = useState<FlockSummary | 'new' | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="page stack">
      <PageHeader title={t('flk.title')} icon={<Bird size={26} color="var(--brand)" />}>
        {can('flocks.manage') && tab === 'flocks' && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Plus size={18} /> {t('flk.new')}
          </button>
        )}
      </PageHeader>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'flocks', label: t('flk.title') },
          { value: 'reminders', label: t('flk.reminders') }
        ]}
      />
      {tab === 'flocks' ? <FlockList onOpen={setOpen} /> : <RemindersCard />}
      {editing && <FlockForm flock={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {open !== null && <FlockView id={open} onClose={() => setOpen(null)} onEdit={(f) => setEditing(f)} />}
    </div>
  )
}

function ageText(t: (k: string, p?: Record<string, string | number>) => string, a: { weeks: number; dayOfWeek: number; days: number }) {
  return t('flk.ageValue', { weeks: a.weeks, days: a.dayOfWeek, total: a.days })
}

function FlockList({ onOpen }: { onOpen: (id: number) => void }) {
  const { t, num, date } = useApp()
  const stageName = useStageName()
  const [showClosed, setShowClosed] = useState(false)
  const { data: flocks } = useLoad(() => call('flocks.list', { includeClosed: showClosed }), [showClosed])
  const { data: due } = useLoad(() => call('flocks.dueReminders'), [])
  const pending = (due ?? []).filter((r) => r.state === 'due' || r.state === 'overdue')
  return (
    <>
      {pending.length > 0 && (
        <Notice tone="warn">
          {t('flk.remindersDue', { count: pending.length })}{' '}
          {pending
            .slice(0, 4)
            .map((r) => `${r.flockCode}: ${r.title}`)
            .join(' · ')}
        </Notice>
      )}
      <Card
        actions={
          <label className="check">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            {t('flk.showClosed')}
          </label>
        }
        title={t('flk.listTitle')}
      >
        <div className="muted small" style={{ marginBottom: 10 }}>
          {t('flk.ageRule')}
        </div>
        {!flocks ? (
          <div className="muted">{t('app.loading')}</div>
        ) : flocks.length === 0 ? (
          <Empty text={t('flk.none')} />
        ) : (
          <div className="table-wrap">
            <table className="data clickable">
              <thead>
                <tr>
                  <th>{t('flk.code')}</th>
                  <th>{t('flk.breed')}</th>
                  <th>{t('flk.hatchDate')}</th>
                  <th>{t('flk.age')}</th>
                  <th>{t('flk.stage')}</th>
                  <th className="num">{t('flk.hensNow')}</th>
                  <th className="num">{t('flk.deaths')}</th>
                  <th>{t('flk.cages')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {flocks.map((f) => (
                  <tr key={f.id} onClick={() => onOpen(f.id)} style={{ cursor: 'pointer' }}>
                    <td>
                      <strong>{f.code}</strong>
                    </td>
                    <td>{f.breed ?? '—'}</td>
                    <td>
                      {date(f.hatchDate)}
                      {f.hatchDateEstimated && <span className="muted small"> ({t('flk.estimated')})</span>}
                    </td>
                    <td>{ageText(t, f.age)}</td>
                    <td>{stageName(f.stage)}</td>
                    <td className="num">{f.status === 'active' ? num(f.currentHens) : '—'}</td>
                    <td className="num">{num(f.deaths)}</td>
                    <td>{f.cages.map((c) => c.cageCode).join(', ') || '—'}</td>
                    <td>{f.status === 'active' ? <span className="badge good">{t('common.active')}</span> : <span className="badge">{t('flk.closed')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

function FlockForm({ flock, onClose }: { flock: FlockSummary | null; onClose: () => void }) {
  const { t, toast, fail, status } = useApp()
  const [f, setF] = useState<FlockInput>(
    flock
      ? {
          id: flock.id,
          code: flock.code,
          breed: flock.breed,
          source: flock.source,
          hatchDate: flock.hatchDateEstimated ? null : flock.hatchDate,
          arrivalDate: flock.arrivalDate,
          ageOnArrivalDays: flock.hatchDateEstimated ? Math.round((Date.parse(flock.arrivalDate) - Date.parse(flock.hatchDate)) / 86400000) : null,
          initialCount: flock.initialCount,
          notes: flock.notes
        }
      : { id: null, code: '', breed: null, source: 'purchased', hatchDate: null, arrivalDate: status.today, ageOnArrivalDays: null, initialCount: 0, notes: null }
  )
  const [knownHatch, setKnownHatch] = useState(flock ? !flock.hatchDateEstimated : false)
  const [busy, setBusy] = useState(false)
  const ok = f.code.trim() && f.arrivalDate && (knownHatch ? !!f.hatchDate : f.ageOnArrivalDays !== null)
  const save = async () => {
    setBusy(true)
    try {
      await call('flocks.save', { ...f, hatchDate: knownHatch ? f.hatchDate : null, ageOnArrivalDays: knownHatch ? null : f.ageOnArrivalDays })
      toast('success', t('common.saved'))
      onClose()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={flock ? `${t('flk.flock')} ${flock.code}` : t('flk.new')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!ok || busy} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('flk.code')} required hint={t('flk.codeHint')}>
            <input className="input" autoFocus value={f.code} maxLength={40} onChange={(e) => setF({ ...f, code: e.target.value })} />
          </Field>
          <Field label={t('flk.breed')}>
            <input className="input" value={f.breed ?? ''} maxLength={100} onChange={(e) => setF({ ...f, breed: nz(e.target.value) })} />
          </Field>
          <Field label={t('flk.source')}>
            <select className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value as FlockInput['source'] })}>
              <option value="purchased">{t('flk.source.purchased')}</option>
              <option value="hatched">{t('flk.source.hatched')}</option>
            </select>
          </Field>
          <Field label={t('flk.arrivalDate')} required>
            <input className="input" type="date" max={status.today} value={f.arrivalDate} onChange={(e) => setF({ ...f, arrivalDate: e.target.value })} />
          </Field>
          <Field label={t('flk.initialCount')}>
            <NumInput value={f.initialCount} onChange={(v) => setF({ ...f, initialCount: v ?? 0 })} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={knownHatch} onChange={(e) => setKnownHatch(e.target.checked)} />
          {t('flk.knowHatch')}
        </label>
        <div className="form-grid">
          {knownHatch ? (
            <Field label={t('flk.hatchDate')} required>
              <input className="input" type="date" max={f.arrivalDate} value={f.hatchDate ?? ''} onChange={(e) => setF({ ...f, hatchDate: e.target.value || null })} />
            </Field>
          ) : (
            <Field label={t('flk.ageOnArrival')} required hint={f.ageOnArrivalDays !== null ? t('flk.hatchWouldBe', { date: addDays(f.arrivalDate, -f.ageOnArrivalDays) }) : t('flk.ageOnArrivalHint')}>
              <NumInput value={f.ageOnArrivalDays} onChange={(v) => setF({ ...f, ageOnArrivalDays: v })} />
            </Field>
          )}
        </div>
        <Field label={t('common.notes')}>
          <input className="input" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: nz(e.target.value) })} />
        </Field>
        {!flock && <Notice tone="info">{t('flk.afterCreate')}</Notice>}
      </div>
    </Modal>
  )
}

function FlockView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (f: FlockSummary) => void }) {
  const { t, num, date, can, status, toast } = useApp()
  const stageName = useStageName()
  const { data: f } = useLoad(() => call('flocks.get', { id }), [id])
  const [days, setDays] = useState(30)
  const from = f ? (addDays(status.today, -days + 1) < f.arrivalDate ? f.arrivalDate : addDays(status.today, -days + 1)) : status.today
  const to = f?.closedOn ?? status.today
  const { data: series } = useLoad(() => (f ? call('flocks.series', { id, from: from > to ? to : from, to }) : Promise.resolve([])), [f?.id, from, to])
  const [placing, setPlacing] = useState(false)
  const [closing, setClosing] = useState(false)
  const manage = can('flocks.manage')
  if (!f) return null
  return (
    <Modal title={`${t('flk.flock')} ${f.code}`} onClose={onClose} wide>
      <div className="stack">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {f.status === 'closed' && <span className="badge">{t('flk.closedOn', { date: date(f.closedOn!) })}</span>}
          {f.breed && <span className="badge info">{f.breed}</span>}
          <span className="badge">{t('flk.source.' + f.source)}</span>
          <span className="grow" />
          {manage && f.status === 'active' && (
            <>
              <button className="btn" onClick={() => onEdit(f)}>
                {t('common.edit')}
              </button>
              <button className="btn danger" onClick={() => setClosing(true)}>
                {t('flk.close')}
              </button>
            </>
          )}
        </div>
        <div className="grid stats">
          <Stat label={t('flk.age')} value={t('flk.weeksShort', { n: f.age.weeks })} sub={`${ageText(t, f.age)}${f.hatchDateEstimated ? ' · ' + t('flk.estimated') : ''}`} />
          <Stat label={t('flk.stage')} value={stageName(f.stage)} sub={`${t('flk.hatchDate')}: ${date(f.hatchDate)}`} />
          <Stat label={t('flk.hensNow')} value={num(f.currentHens)} sub={t('flk.ofInitial', { n: num(f.initialCount) })} />
          <Stat label={t('flk.deaths')} value={num(f.deaths)} sub={f.initialCount > 0 ? `${num((f.deaths / f.initialCount) * 100, 2)}%` : undefined} />
        </div>

        <Card
          title={t('flk.placements')}
          actions={
            manage && f.status === 'active' ? (
              <button className="btn sm" onClick={() => setPlacing(true)}>
                <Plus size={15} /> {t('flk.place')}
              </button>
            ) : undefined
          }
        >
          {f.placements.length === 0 ? (
            <Empty text={t('flk.noPlacements')} />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>{t('flk.cage')}</th>
                  <th>{t('flk.house')}</th>
                  <th>{t('flk.from')}</th>
                  <th>{t('flk.to')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {f.placements.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.cageCode} — {p.cageName}
                    </td>
                    <td>{p.houseName ?? '—'}</td>
                    <td>{date(p.fromDate)}</td>
                    <td>{p.toDate ? date(p.toDate) : t('flk.stillThere')}</td>
                    <td>{manage && !p.toDate && <EndPlacement flockId={f.id} cageId={p.cageId} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <RangePicker days={days} onChange={setDays} />
        </div>
        {series && series.length > 0 ? (
          <div className="grid cols-2">
            <TimeChart title={t('flk.chartProduction')} data={series} series={[{ key: 'productionPct', label: t('flk.productionPct'), color: SERIES.blue }]} unit="%" digits={1} />
            <TimeChart title={t('flk.chartDeaths')} data={series} kind="bar" series={[{ key: 'deaths', label: t('flk.deaths'), color: SERIES.red }]} />
            <TimeChart title={t('flk.chartFeed')} data={series} series={[{ key: 'feedPerHenG', label: t('flk.feedPerHen'), color: SERIES.orange }]} unit="g" digits={1} />
            <TimeChart title={t('flk.chartWater')} data={series} series={[{ key: 'waterLitres', label: t('flk.water'), color: SERIES.aqua }]} unit="L" digits={1} />
          </div>
        ) : (
          <Empty text={t('flk.noDays')} />
        )}

        <Card title={t('flk.reminders')}>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {t('flk.remindersNotAdvice')}
          </div>
          <ReminderList items={f.reminders} />
        </Card>

        <Card title={t('flk.treatments')}>
          {f.treatments.length === 0 ? (
            <Empty text={t('common.noData')} />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('flk.cage')}</th>
                  <th>{t('flk.product')}</th>
                  <th className="num">{t('flk.quantity')}</th>
                  <th>{t('common.reason')}</th>
                  <th>{t('flk.prescribedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {f.treatments.map((x, i) => (
                  <tr key={i}>
                    <td>{date(x.date)}</td>
                    <td>{x.cageCode}</td>
                    <td>{x.item}</td>
                    <td className="num">
                      {num(x.quantity, 2)} {x.unit}
                    </td>
                    <td>{x.reason ?? '—'}</td>
                    <td>{x.prescribedBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      {placing && <PlaceDialog flock={f} onClose={() => setPlacing(false)} />}
      {closing && (
        <ReasonDialog
          title={`${t('flk.close')}: ${f.code}`}
          hint={t('flk.closeHint')}
          danger
          onClose={() => setClosing(false)}
          onSubmit={async (reason) => {
            await call('flocks.close', { id: f.id, date: status.today, reason })
            toast('success', t('common.saved'))
          }}
        />
      )}
    </Modal>
  )
}

function EndPlacement({ flockId, cageId }: { flockId: number; cageId: number }) {
  const { t, status, fail, toast } = useApp()
  const [open, setOpen] = useState(false)
  const [d, setD] = useState(status.today)
  if (!open)
    return (
      <button className="btn sm" onClick={() => setOpen(true)}>
        <X size={14} /> {t('flk.endPlacement')}
      </button>
    )
  return (
    <span className="row" style={{ gap: 6 }}>
      <input className="input" type="date" value={d} max={status.today} onChange={(e) => setD(e.target.value)} style={{ width: 160 }} />
      <button
        className="btn sm primary"
        onClick={async () => {
          try {
            await call('flocks.endPlacement', { id: flockId, cageId, toDate: d })
            toast('success', t('common.saved'))
          } catch (e) {
            fail(e)
          }
        }}
      >
        {t('common.confirm')}
      </button>
    </span>
  )
}

function PlaceDialog({ flock, onClose }: { flock: FlockDetail; onClose: () => void }) {
  const { t, status, fail, toast } = useApp()
  const { data: cages } = useLoad(() => call('cages.list', { includeInactive: false }), [])
  const { data: flocks } = useLoad(() => call('flocks.list', { includeClosed: false }), [])
  const [chosen, setChosen] = useState<number[]>([])
  const [from, setFrom] = useState(flock.arrivalDate > status.today ? status.today : flock.arrivalDate)
  const occupant = (cageId: number) => flocks?.find((x) => x.cages.some((c) => c.cageId === cageId))
  return (
    <Modal
      title={`${t('flk.place')}: ${flock.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!chosen.length}
            onClick={async () => {
              try {
                await call('flocks.place', { id: flock.id, cageIds: chosen, fromDate: from })
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
        <Field label={t('flk.from')} hint={t('flk.fromHint')}>
          <input className="input" type="date" min={flock.arrivalDate} max={status.today} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <div className="stack" style={{ gap: 6 }}>
          {cages?.map((c) => {
            const o = occupant(c.id)
            return (
              <label key={c.id} className="check">
                <input type="checkbox" disabled={!!o} checked={chosen.includes(c.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))} />
                {c.code} — {c.name}
                {o && <span className="muted small"> ({t('flk.occupiedBy', { flock: o.code })})</span>}
              </label>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

function ReminderList({ items }: { items: ReminderDue[] }) {
  const { t, date, dateTime, can, fail, toast } = useApp()
  const [skipping, setSkipping] = useState<ReminderDue | null>(null)
  const canMark = can('flock.record') || can('medicine.record') || can('flocks.manage')
  if (!items.length) return <Empty text={t('flk.noReminders')} />
  const mark = async (r: ReminderDue, outcome: 'done' | 'skipped', note: string | null) => {
    await call('flocks.markReminder', { flockId: r.flockId, reminderId: r.reminderId, outcome, note })
    toast('success', t('common.saved'))
  }
  return (
    <>
      <table className="data">
        <thead>
          <tr>
            <th>{t('flk.atWeek')}</th>
            <th>{t('flk.reminder')}</th>
            <th>{t('flk.dueOn')}</th>
            <th>{t('common.status')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.reminderId}>
              <td>{t('flk.weekN', { n: r.atWeek })}</td>
              <td>
                <strong>{r.title}</strong>
                {r.instructions && <div className="muted small">{r.instructions}</div>}
              </td>
              <td>{date(r.dueOn)}</td>
              <td>
                <span className={`badge ${r.state === 'overdue' ? 'bad' : r.state === 'due' ? 'warn' : r.state === 'done' ? 'good' : ''}`}>{t('flk.rstate.' + r.state)}</span>
                {r.doneAt && (
                  <div className="muted small">
                    {r.doneBy ?? ''} · {dateTime(r.doneAt)}
                    {r.note ? ` · ${r.note}` : ''}
                  </div>
                )}
              </td>
              <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                {canMark && (r.state === 'due' || r.state === 'overdue' || r.state === 'upcoming') && (
                  <>
                    <button className="btn sm" onClick={() => mark(r, 'done', null).catch(fail)}>
                      <CheckCircle2 size={14} /> {t('flk.markDone')}
                    </button>
                    <button className="btn sm" onClick={() => setSkipping(r)}>
                      {t('flk.skip')}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {skipping && <ReasonDialog title={`${t('flk.skip')}: ${skipping.title}`} onClose={() => setSkipping(null)} onSubmit={(note) => mark(skipping, 'skipped', note)} />}
    </>
  )
}

function RemindersCard() {
  const { t, can } = useApp()
  const { data } = useLoad(() => call('flocks.reminders'), [])
  const [editing, setEditing] = useState<ReminderRow | 'new' | null>(null)
  return (
    <Card
      title={t('flk.reminderSetup')}
      actions={
        can('flocks.manage') ? (
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Plus size={18} /> {t('flk.newReminder')}
          </button>
        ) : undefined
      }
    >
      <Notice tone="info">{t('flk.remindersNotAdvice')}</Notice>
      {!data ? null : data.length === 0 ? (
        <Empty text={t('flk.noReminderSetup')} />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>{t('flk.atWeek')}</th>
              <th>{t('flk.reminder')}</th>
              <th>{t('flk.instructions')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id} onClick={() => can('flocks.manage') && setEditing(r)} style={{ cursor: can('flocks.manage') ? 'pointer' : undefined }}>
                <td>{t('flk.weekN', { n: r.atWeek })}</td>
                <td>
                  <strong>{r.title}</strong>
                </td>
                <td className="muted">{r.instructions ?? '—'}</td>
                <td>{r.active ? <span className="badge good">{t('common.active')}</span> : <span className="badge">{t('common.inactive')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <ReminderForm r={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function ReminderForm({ r, onClose }: { r: ReminderRow | null; onClose: () => void }) {
  const { t, fail, toast } = useApp()
  const [f, setF] = useState({ atWeek: r?.atWeek ?? 0, title: r?.title ?? '', instructions: r?.instructions ?? null, active: r?.active ?? true })
  return (
    <Modal
      title={r ? r.title : t('flk.newReminder')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={f.title.trim().length < 2}
            onClick={async () => {
              try {
                await call('flocks.saveReminder', { id: r?.id ?? null, ...f })
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
        <Notice tone="info">{t('flk.remindersNotAdvice')}</Notice>
        <div className="form-grid">
          <Field label={t('flk.atWeek')} hint={t('flk.atWeekHint')}>
            <NumInput value={f.atWeek} onChange={(v) => setF({ ...f, atWeek: v ?? 0 })} />
          </Field>
          <Field label={t('flk.reminder')} required>
            <input className="input" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </Field>
        </div>
        <Field label={t('flk.instructions')} hint={t('flk.instructionsHint')}>
          <textarea className="input" value={f.instructions ?? ''} maxLength={2000} onChange={(e) => setF({ ...f, instructions: nz(e.target.value) })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          {t('common.active')}
        </label>
      </div>
    </Modal>
  )
}
