import { useState } from 'react'
import { CheckCircle2, Circle, ClipboardCheck } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { Duty, DutyTask, UserRow } from '@shared/types'
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

/** Short text such as "Cage 01, Cage 02": the cages a user looks after (administrators: all). */
export function useCageSummary() {
  const { t } = useApp()
  const { data: cages } = useLoad(() => call('cages.list', { includeInactive: true }), [])
  return (u: Pick<UserRow, 'role' | 'cages'>) => {
    if (u.role === 'admin' || u.cages === null) return t('duty.allCages')
    return u.cages.map((id) => cages?.find((c) => c.id === id)?.name ?? id).join(', ') || t('common.none')
  }
}

/** Which cages a user looks after. (What they may do comes from their role.) */
export function CagesDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t, toast, fail } = useApp()
  const { data: cages } = useLoad(() => call('cages.list', { includeInactive: false }), [])
  const [allCages, setAllCages] = useState(user.cages === null)
  const [picked, setPicked] = useState<number[]>(user.cages ?? [])
  const ok = allCages || picked.length > 0
  return (
    <Modal
      wide
      title={`${t('duty.cages')} — ${user.displayName}`}
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
                await call('users.setCages', { id: user.id, cages: allCages ? null : picked })
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
        <Notice tone="info">{t('role.cagesHint')}</Notice>
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
