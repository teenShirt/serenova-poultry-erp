import { useState } from 'react'
import { Check, Clock, Pencil, Plus } from 'lucide-react'
import type { FeedingSchedule } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, NumInput, nz } from './ui'

const STATE_TONE: Record<string, string> = { done: 'good', late: 'warn', missed: 'bad', due: 'info', upcoming: '' }

/** Today's planned feedings with what was done, and (for managers) the schedule itself. */
export function FeedingScheduleCard({ date }: { date: string }) {
  const { t, num, can, fail, toast, status } = useApp()
  const { data: slots, reload } = useLoad(() => call('feeding.status', { date }), [date])
  const { data: schedules } = useLoad(() => call('feeding.schedules'), [])
  const [editing, setEditing] = useState<FeedingSchedule | 'new' | null>(null)
  const [showAll, setShowAll] = useState(false)
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: status.settings.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
  return (
    <Card
      title={t('fsch.title')}
      actions={
        can('feeding.manage') ? (
          <button className="btn sm" onClick={() => setShowAll(!showAll)}>
            <Clock size={15} /> {t('fsch.edit')}
          </button>
        ) : undefined
      }
    >
      <div className="muted small" style={{ marginBottom: 8 }}>
        {t('fsch.rule')}
      </div>
      {!slots ? null : slots.length === 0 ? (
        <Empty text={t('fsch.none')} />
      ) : (
        <table className="data">
          <tbody>
            {slots.map((s) => (
              <tr key={s.scheduleId}>
                <td className="nowrap">
                  <strong>{s.atTime}</strong>
                </td>
                <td>
                  {s.cageName ?? t('fsch.allCages')}
                  {s.itemName && <span className="muted small"> · {s.itemName}</span>}
                  {s.plannedKg !== null && <span className="muted small"> · {num(s.plannedKg, 1)} kg</span>}
                </td>
                <td>
                  <span className={`badge ${STATE_TONE[s.state]}`}>{t('fsch.state.' + s.state)}</span>
                  {s.fedAt && (
                    <div className="muted small">
                      {t('fsch.fedAt', { time: s.fedAt })} · {s.recordedBy}
                      {s.note ? ` · ${s.note}` : ''}
                    </div>
                  )}
                </td>
                <td>
                  {!s.fedAt && can('feed.record') && s.state !== 'upcoming' && (
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          await call('feeding.markFed', { scheduleId: s.scheduleId, date, fedAt: date === status.today ? now : s.atTime, note: null })
                          toast('success', t('common.saved'))
                          reload()
                        } catch (e) {
                          fail(e)
                        }
                      }}
                    >
                      <Check size={14} /> {t('fsch.markFed')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showAll && (
        <div className="stack mt">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3>{t('fsch.planned')}</h3>
            <button className="btn sm primary" onClick={() => setEditing('new')}>
              <Plus size={14} /> {t('fsch.add')}
            </button>
          </div>
          <table className="data">
            <tbody>
              {schedules?.map((s) => (
                <tr key={s.id} className={s.active ? '' : 'muted'}>
                  <td>{s.atTime}</td>
                  <td>{s.cageName ?? t('fsch.allCages')}</td>
                  <td>{s.itemName ?? '—'}</td>
                  <td className="num">{s.plannedKg === null ? '—' : `${num(s.plannedKg, 1)} kg`}</td>
                  <td>{s.active ? t('common.active') : t('common.inactive')}</td>
                  <td>
                    <button className="icon-btn" title={t('common.edit')} onClick={() => setEditing(s)}>
                      <Pencil size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ScheduleForm s={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function ScheduleForm({ s, onClose }: { s: FeedingSchedule | null; onClose: () => void }) {
  const { t, fail, toast } = useApp()
  const { data: cages } = useLoad(() => call('cages.list', { includeInactive: false }), [])
  const { data: items } = useLoad(() => call('inventory.items', { category: 'feed' }), [])
  const [f, setF] = useState({
    cageId: s?.cageId ?? null,
    atTime: s?.atTime ?? '07:00',
    itemId: s?.itemId ?? null,
    plannedKg: s?.plannedKg ?? null,
    notes: s?.notes ?? null,
    active: s?.active ?? true
  })
  return (
    <Modal
      title={s ? `${t('fsch.title')} ${s.atTime}` : t('fsch.add')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!/^\d{2}:\d{2}$/.test(f.atTime)}
            onClick={async () => {
              try {
                await call('feeding.saveSchedule', { id: s?.id ?? null, ...f })
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
      <div className="form-grid">
        <Field label={t('fsch.time')} required>
          <input className="input" type="time" value={f.atTime} onChange={(e) => setF({ ...f, atTime: e.target.value })} />
        </Field>
        <Field label={t('flk.cage')}>
          <select className="select" value={f.cageId ?? ''} onChange={(e) => setF({ ...f, cageId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{t('fsch.allCages')}</option>
            {cages?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('inv.item')}>
          <select className="select" value={f.itemId ?? ''} onChange={(e) => setF({ ...f, itemId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {items?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fsch.plannedKg')}>
          <NumInput decimals value={f.plannedKg} onChange={(v) => setF({ ...f, plannedKg: v })} />
        </Field>
        <Field label={t('common.notes')}>
          <input className="input" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: nz(e.target.value) })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          {t('common.active')}
        </label>
      </div>
    </Modal>
  )
}

/** Warns that eggs of some cages are under a withdrawal period after a treatment. */
export function WithdrawalNotice({ date }: { date: string }) {
  const { t, date: fmt } = useApp()
  const { data } = useLoad(() => call('medicine.withdrawals', { date }), [date])
  if (!data?.length) return null
  return (
    <Notice tone="bad">
      <strong>{t('wd.title')}</strong>{' '}
      {data.map((w) => t('wd.line', { cage: w.cageName ?? t('fsch.allCages'), item: w.item, date: fmt(w.eggsUsableFrom) })).join(' · ')}
    </Notice>
  )
}
