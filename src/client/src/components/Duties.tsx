import { useState } from 'react'
import { CheckCircle2, Circle, ClipboardCheck } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { DUTIES, type Duty, type DutyTask, type UserRow } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Modal, Notice } from './ui'

const DUTY_PAGE: Record<Duty, string> = {
  start_day: '/daily',
  eggs: '/eggs',
  feed: '/feed',
  water: '/water',
  flock: '/mortality',
  medicine: '/medicine',
  inventory: '/inventory',
  purchases: '/purchases',
  sales: '/sales',
  reports: '/reports',
  backup: '/backup'
}

/** Short text such as "6 of 11 duties · Cage 01, Cage 02". */
export function useDutySummary() {
  const { t } = useApp()
  const { data: cages } = useLoad(() => call('cages.list', { includeInactive: true }), [])
  return (u: Pick<UserRow, 'role' | 'duties' | 'cages'>) => {
    if (u.role === 'admin') return t('duty.allAdmin')
    const cageText = u.cages === null ? t('duty.allCages') : u.cages.map((id) => cages?.find((c) => c.id === id)?.name ?? id).join(', ') || t('common.none')
    return `${t('duty.count', { count: u.duties.length, total: DUTIES.length })} · ${cageText}`
  }
}

/** Administrator chooses what a user may do and which cages they look after. */
export function DutiesDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t, toast, fail } = useApp()
  const { data: cages } = useLoad(() => call('cages.list', { includeInactive: false }), [])
  const [duties, setDuties] = useState<Duty[]>(user.duties)
  const [allCages, setAllCages] = useState(user.cages === null)
  const [picked, setPicked] = useState<number[]>(user.cages ?? [])
  const toggle = (d: Duty) => setDuties(duties.includes(d) ? duties.filter((x) => x !== d) : [...duties, d])
  const ok = allCages || picked.length > 0
  return (
    <Modal
      wide
      title={`${t('duty.title')} — ${user.displayName}`}
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
                await call('users.setDuties', { id: user.id, duties, cages: allCages ? null : picked })
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
        <Notice tone="info">{t('duty.hint')}</Notice>
        <div>
          <div className="row" style={{ marginBottom: 8 }}>
            <h3 className="grow">{t('duty.jobs')}</h3>
            <button className="btn sm" onClick={() => setDuties([...DUTIES])}>
              {t('duty.selectAll')}
            </button>
            <button className="btn sm" onClick={() => setDuties([])}>
              {t('duty.clear')}
            </button>
          </div>
          <div className="duty-grid">
            {DUTIES.map((d) => (
              <label key={d} className={`duty ${duties.includes(d) ? 'done' : ''}`} style={{ cursor: 'pointer' }}>
                <span className="check">
                  <input type="checkbox" checked={duties.includes(d)} onChange={() => toggle(d)} />
                  <strong>{t('duty.' + d)}</strong>
                </span>
                <span className="small muted">{t('duty.' + d + '.hint')}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <h3 style={{ marginBottom: 8 }}>{t('duty.cages')}</h3>
          <label className="check" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={allCages} onChange={(e) => setAllCages(e.target.checked)} />
            {t('duty.allCages')}
          </label>
          {!allCages && (
            <div className="chips">
              {cages?.map((c) => (
                <button key={c.id} type="button" className={`chip ${picked.includes(c.id) ? 'on' : ''}`} onClick={() => setPicked(picked.includes(c.id) ? picked.filter((x) => x !== c.id) : [...picked, c.id])}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {!ok && <div className="small" style={{ color: 'var(--bad)', marginTop: 6 }}>{t('duty.pickCage')}</div>}
        </div>
      </div>
    </Modal>
  )
}

/** "My duties today": the signed-in user's jobs for the working date, ticked off as data is entered. */
export function MyDutiesCard() {
  const { t, workDate } = useApp()
  const nav = useNavigate()
  const { data: tasks } = useLoad(() => call('duties.mine', { date: workDate }), [workDate])
  if (!tasks || tasks.length === 0) return null
  const groups = new Map<Duty, DutyTask[]>()
  for (const task of tasks) groups.set(task.duty, [...(groups.get(task.duty) ?? []), task])
  const done = tasks.filter((x) => x.done).length
  const pct = Math.round((done / tasks.length) * 100)
  return (
    <Card
      title={
        <h2 className="row" style={{ gap: 8 }}>
          <ClipboardCheck size={22} color="var(--brand)" /> {t('duty.mine')}
        </h2>
      }
      actions={<span className={`badge ${pct === 100 ? 'good' : 'warn'}`}>{t('duty.progress', { done, total: tasks.length })}</span>}
    >
      <div className="progress" style={{ marginBottom: 12 }} aria-label={`${pct}%`}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="duty-grid">
        {[...groups.entries()].map(([duty, list]) => {
          const d = list.filter((x) => x.done).length
          const left = list.filter((x) => !x.done)
          return (
            <button key={duty} className={`duty ${d === list.length ? 'done' : ''}`} style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }} onClick={() => nav(DUTY_PAGE[duty])}>
              <span className="row" style={{ gap: 8 }}>
                {d === list.length ? <CheckCircle2 size={18} color="var(--good)" /> : <Circle size={18} color="var(--muted)" />}
                <strong className="grow">{t('duty.' + duty)}</strong>
                <span className="small">
                  {d}/{list.length}
                </span>
              </span>
              {left.length > 0 && (
                <span className="small muted">
                  {left
                    .slice(0, 4)
                    .map((x) => [x.cageName, x.params.session ? t('session.' + x.params.session) : null].filter(Boolean).join(' · '))
                    .filter(Boolean)
                    .join(', ')}
                  {left.length > 4 ? ` +${left.length - 4}` : ''}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </Card>
  )
}
