import { useState } from 'react'
import { CalendarClock, CheckCircle2, ListChecks, Play, Plus, ShieldCheck } from 'lucide-react'
import { addDays } from '@shared/dates'
import { TASK_CATEGORIES, TASK_PRIORITIES, type TaskInput, type TaskRow } from '@shared/stores'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, PageHeader, ReasonDialog, Tabs, nz } from '../components/ui'

type Tab = 'mine' | 'all' | 'report'

/** Weekly task board: the user's own tasks; for task managers, all tasks and the completion report. */
export function TasksPage() {
  const { t, can } = useApp()
  const manage = can('tasks.manage')
  const [tab, setTab] = useState<Tab>('mine')
  const [editing, setEditing] = useState<TaskRow | 'new' | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="page stack">
      <PageHeader title={t('task.title')} icon={<ListChecks size={26} color="var(--brand)" />}>
        {manage && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Plus size={18} /> {t('task.new')}
          </button>
        )}
      </PageHeader>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'mine', label: t('task.mine') },
          ...(manage
            ? [
                { value: 'all' as const, label: t('task.all') },
                { value: 'report' as const, label: t('task.report') }
              ]
            : [])
        ]}
      />
      {tab === 'report' ? <Report /> : <Board mineOnly={tab === 'mine'} onOpen={setOpen} />}
      {editing && <TaskForm task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {open !== null && <TaskView id={open} onClose={() => setOpen(null)} onEdit={(x) => (setOpen(null), setEditing(x))} />}
    </div>
  )
}

const PRIORITY_TONE: Record<string, string> = { urgent: 'bad', high: 'warn', normal: 'info', low: '' }

function StatusBadge({ task }: { task: TaskRow }) {
  const { t } = useApp()
  if (task.overdue) return <span className="badge bad">{t('task.overdue')}</span>
  const tone = task.status === 'verified' || task.status === 'completed' ? 'good' : task.status === 'in_progress' ? 'warn' : task.status === 'cancelled' ? '' : 'info'
  return <span className={`badge ${tone}`}>{t('task.status.' + task.status)}</span>
}

function Board({ mineOnly, onOpen }: { mineOnly: boolean; onOpen: (id: number) => void }) {
  const { t, date, status } = useApp()
  const [week, setWeek] = useState(0)
  // The week shown runs Monday to Sunday.
  const monday = addDays(status.today, -((new Date(status.today + 'T00:00:00Z').getUTCDay() + 6) % 7) + week * 7)
  const sunday = addDays(monday, 6)
  const { data: tasks } = useLoad(() => call('tasks.list', { from: monday, to: sunday, mineOnly }), [monday, mineOnly])
  const overdue = (tasks ?? []).filter((x) => x.overdue)
  const today = (tasks ?? []).filter((x) => x.dueDate === status.today && !x.overdue)
  return (
    <>
      {week === 0 && overdue.length > 0 && <Notice tone="bad">{t('task.overdueCount', { count: overdue.length })}</Notice>}
      <Card
        title={t('task.weekOf', { from: date(monday), to: date(sunday) })}
        actions={
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => setWeek(week - 1)}>
              ‹ {t('task.prevWeek')}
            </button>
            {week !== 0 && (
              <button className="btn sm" onClick={() => setWeek(0)}>
                {t('task.thisWeek')}
              </button>
            )}
            <button className="btn sm" onClick={() => setWeek(week + 1)}>
              {t('task.nextWeek')} ›
            </button>
          </div>
        }
      >
        {week === 0 && <div className="muted small" style={{ marginBottom: 8 }}>{t('task.todayCount', { count: today.length })}</div>}
        {!tasks ? null : tasks.length === 0 ? (
          <Empty text={t('task.none')} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('task.due')}</th>
                  <th>{t('task.task')}</th>
                  <th>{t('task.priority')}</th>
                  <th>{t('task.assignee')}</th>
                  <th>{t('task.where')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((x) => (
                  <tr key={x.id} onClick={() => onOpen(x.id)} style={{ cursor: 'pointer' }} className={x.dueDate === status.today ? 'highlight' : ''}>
                    <td className="nowrap">{date(x.dueDate)}</td>
                    <td>
                      <strong>{x.title}</strong>
                      <div className="muted small">
                        {t('task.cat.' + x.category)}
                        {x.recurrence !== 'none' && ` · ${t('task.rec.' + x.recurrence)}`}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${PRIORITY_TONE[x.priority]}`}>{t('task.prio.' + x.priority)}</span>
                    </td>
                    <td>{x.assigneeName ?? x.assigneeRoleName ?? '—'}</td>
                    <td>{[x.farmName, x.houseName].filter(Boolean).join(' · ') || t('task.wholeOrg')}</td>
                    <td>
                      <StatusBadge task={x} />
                    </td>
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

function TaskView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (t: TaskRow) => void }) {
  const { t, date, dateTime, can, toast, fail } = useApp()
  const { data: task, reload } = useLoad(() => call('tasks.get', { id }), [id])
  const [note, setNote] = useState('')
  const [asking, setAsking] = useState<'cancel' | 'stop_series' | null>(null)
  const manage = can('tasks.manage')
  if (!task) return null
  const act = async (action: 'start' | 'complete' | 'verify' | 'comment', n: string | null = nz(note)) => {
    try {
      await call('tasks.action', { id, action, note: n })
      setNote('')
      toast('success', t('common.saved'))
      reload()
    } catch (e) {
      fail(e)
    }
  }
  const openTask = task.status === 'pending' || task.status === 'in_progress'
  const canWork = manage || task.mine
  return (
    <Modal title={task.title} onClose={onClose} wide>
      <div className="stack">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <StatusBadge task={task} />
          <span className={`badge ${PRIORITY_TONE[task.priority]}`}>{t('task.prio.' + task.priority)}</span>
          <span className="badge">{t('task.cat.' + task.category)}</span>
          {task.recurrence !== 'none' && <span className="badge info">{t('task.rec.' + task.recurrence)}</span>}
          <span className="grow" />
          {manage && openTask && (
            <button className="btn sm" onClick={() => onEdit(task)}>
              {t('common.edit')}
            </button>
          )}
        </div>
        <dl className="kv">
          <dt>{t('task.due')}</dt>
          <dd>
            {date(task.startDate)}
            {task.startDate !== task.dueDate && ` – ${date(task.dueDate)}`}
          </dd>
          <dt>{t('task.assignee')}</dt>
          <dd>{task.assigneeName ?? (task.assigneeRoleName ? t('task.team', { role: task.assigneeRoleName }) : '—')}</dd>
          <dt>{t('task.where')}</dt>
          <dd>{[task.farmName, task.houseName].filter(Boolean).join(' · ') || t('task.wholeOrg')}</dd>
          {task.instructions && (
            <>
              <dt>{t('task.instructions')}</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{task.instructions}</dd>
            </>
          )}
          {task.completionCriteria && (
            <>
              <dt>{t('task.criteria')}</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{task.completionCriteria}</dd>
            </>
          )}
        </dl>
        <Field label={t('task.note')} hint={task.completionCriteria && openTask ? t('task.noteForCriteria') : undefined}>
          <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </Field>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {canWork && task.status === 'pending' && (
            <button className="btn" onClick={() => act('start')}>
              <Play size={16} /> {t('task.start')}
            </button>
          )}
          {canWork && openTask && (
            <button className="btn primary" onClick={() => act('complete')}>
              <CheckCircle2 size={16} /> {t('task.complete')}
            </button>
          )}
          {manage && task.status === 'completed' && (
            <button className="btn primary" onClick={() => act('verify')}>
              <ShieldCheck size={16} /> {t('task.verify')}
            </button>
          )}
          <button className="btn" disabled={!note.trim()} onClick={() => act('comment')}>
            {t('task.addNote')}
          </button>
          <span className="grow" />
          {manage && openTask && (
            <button className="btn danger" onClick={() => setAsking('cancel')}>
              {t('task.cancel')}
            </button>
          )}
          {manage && task.seriesId && (
            <button className="btn" onClick={() => setAsking('stop_series')}>
              {t('task.stopSeries')}
            </button>
          )}
        </div>
        <Card title={t('task.history')}>
          <table className="data">
            <tbody>
              {task.events.map((e, i) => (
                <tr key={i}>
                  <td className="nowrap">{dateTime(e.at)}</td>
                  <td>{e.user ?? t('task.system')}</td>
                  <td>{t('task.ev.' + e.action)}</td>
                  <td className="muted">{e.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      {asking && (
        <ReasonDialog
          title={t(asking === 'cancel' ? 'task.cancel' : 'task.stopSeries')}
          danger
          onClose={() => setAsking(null)}
          onSubmit={async (reason) => {
            await call('tasks.action', { id, action: asking, note: reason })
            reload()
          }}
        />
      )}
    </Modal>
  )
}

function TaskForm({ task, onClose }: { task: TaskRow | null; onClose: () => void }) {
  const { t, status, toast, fail } = useApp()
  const { data: who } = useLoad(() => call('tasks.assignees'), [])
  const { data: houses } = useLoad(() => call('houses.list'), [])
  const [f, setF] = useState<TaskInput>(
    task
      ? {
          id: task.id,
          title: task.title,
          category: task.category,
          priority: task.priority,
          instructions: task.instructions,
          completionCriteria: task.completionCriteria,
          farmId: task.farmId,
          houseId: task.houseId,
          assigneeUserId: task.assigneeUserId,
          assigneeRoleId: task.assigneeRoleId,
          startDate: task.startDate,
          dueDate: task.dueDate,
          recurrence: task.recurrence,
          untilDate: null
        }
      : {
          id: null,
          title: '',
          category: 'feeding',
          priority: 'normal',
          instructions: null,
          completionCriteria: null,
          farmId: status.farm?.id ?? null,
          houseId: null,
          assigneeUserId: null,
          assigneeRoleId: null,
          startDate: status.today,
          dueDate: status.today,
          recurrence: 'none',
          untilDate: null
        }
  )
  const set = (p: Partial<TaskInput>) => setF({ ...f, ...p })
  const assignee = f.assigneeUserId ? `u${f.assigneeUserId}` : f.assigneeRoleId ? `r${f.assigneeRoleId}` : ''
  const ok = f.title.trim().length >= 2 && f.dueDate >= f.startDate
  return (
    <Modal
      wide
      title={task ? task.title : t('task.new')}
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
                await call('tasks.save', { ...f, dueDate: f.recurrence !== 'none' ? f.startDate : f.dueDate })
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
          <Field label={t('task.task')} required>
            <input className="input" autoFocus value={f.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label={t('task.category')}>
            <select className="select" value={f.category} onChange={(e) => set({ category: e.target.value as TaskInput['category'] })}>
              {TASK_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t('task.cat.' + c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('task.priority')}>
            <select className="select" value={f.priority} onChange={(e) => set({ priority: e.target.value as TaskInput['priority'] })}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t('task.prio.' + p)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('task.assignee')} hint={t('task.assigneeHint')}>
            <select
              className="select"
              value={assignee}
              onChange={(e) => {
                const v = e.target.value
                set({ assigneeUserId: v.startsWith('u') ? Number(v.slice(1)) : null, assigneeRoleId: v.startsWith('r') ? Number(v.slice(1)) : null })
              }}
            >
              <option value="">—</option>
              <optgroup label={t('task.people')}>
                {who?.users.map((u) => (
                  <option key={u.id} value={`u${u.id}`}>
                    {u.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('task.teams')}>
                {who?.roles.map((r) => (
                  <option key={r.id} value={`r${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label={t('task.where')}>
            <select className="select" value={f.houseId ? `h${f.houseId}` : f.farmId ? 'farm' : ''} onChange={(e) => {
              const v = e.target.value
              set(v === '' ? { farmId: null, houseId: null } : v === 'farm' ? { farmId: status.farm?.id ?? null, houseId: null } : { farmId: status.farm?.id ?? null, houseId: Number(v.slice(1)) })
            }}>
              <option value="farm">{status.farm?.name}</option>
              {houses?.map((h) => (
                <option key={h.id} value={`h${h.id}`}>
                  {status.farm?.name} · {h.name}
                </option>
              ))}
              <option value="">{t('task.wholeOrg')}</option>
            </select>
          </Field>
          {!task && (
            <Field label={t('task.repeat')}>
              <select className="select" value={f.recurrence} onChange={(e) => set({ recurrence: e.target.value as TaskInput['recurrence'] })}>
                {(['none', 'daily', 'weekly', 'monthly'] as const).map((r) => (
                  <option key={r} value={r}>
                    {t('task.rec.' + r)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={f.recurrence === 'none' ? t('task.start') : t('task.firstDate')}>
            <input className="input" type="date" value={f.startDate} disabled={!!task?.seriesId} onChange={(e) => set({ startDate: e.target.value, dueDate: f.dueDate < e.target.value ? e.target.value : f.dueDate })} />
          </Field>
          {f.recurrence === 'none' ? (
            <Field label={t('task.due')}>
              <input className="input" type="date" min={f.startDate} value={f.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
            </Field>
          ) : (
            <Field label={t('task.until')} hint={t('task.untilHint')}>
              <input className="input" type="date" min={f.startDate} value={f.untilDate ?? ''} onChange={(e) => set({ untilDate: e.target.value || null })} />
            </Field>
          )}
        </div>
        <Field label={t('task.instructions')}>
          <textarea className="input" value={f.instructions ?? ''} maxLength={4000} onChange={(e) => set({ instructions: nz(e.target.value) })} />
        </Field>
        <Field label={t('task.criteria')} hint={t('task.criteriaHint')}>
          <textarea className="input" value={f.completionCriteria ?? ''} maxLength={2000} onChange={(e) => set({ completionCriteria: nz(e.target.value) })} />
        </Field>
        {task?.seriesId && <Notice tone="info">{t('task.seriesEditHint')}</Notice>}
      </div>
    </Modal>
  )
}

function Report() {
  const { t, num, date, status } = useApp()
  const [by, setBy] = useState<'week' | 'month'>('week')
  const from = addDays(status.today, by === 'week' ? -83 : -364)
  const { data } = useLoad(() => call('tasks.report', { from, to: status.today, by }), [from, by])
  const pct = (a: number, b: number) => (b ? `${num((a / b) * 100, 0)}%` : '—')
  return (
    <Card
      title={t('task.report')}
      actions={
        <select className="select" value={by} onChange={(e) => setBy(e.target.value as 'week' | 'month')} style={{ maxWidth: 180 }}>
          <option value="week">{t('task.byWeek')}</option>
          <option value="month">{t('task.byMonth')}</option>
        </select>
      }
    >
      {!data || data.length === 0 ? (
        <Empty text={t('common.noData')} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>
                  <CalendarClock size={15} /> {t(by === 'week' ? 'task.weekFrom' : 'task.month')}
                </th>
                <th className="num">{t('task.total')}</th>
                <th className="num">{t('task.onTime')}</th>
                <th className="num">{t('task.late')}</th>
                <th className="num">{t('task.verified')}</th>
                <th className="num">{t('task.overdue')}</th>
                <th className="num">{t('task.open')}</th>
                <th className="num">{t('task.cancelled')}</th>
                <th className="num">{t('task.completionRate')}</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((r) => (
                <tr key={r.period}>
                  <td>{by === 'week' ? date(r.period) : date(r.period, { month: 'long', year: 'numeric' })}</td>
                  <td className="num">{r.total}</td>
                  <td className="num">{r.completedOnTime}</td>
                  <td className="num">{r.completedLate}</td>
                  <td className="num">{r.verified}</td>
                  <td className={`num ${r.overdue ? 'bad' : ''}`}>{r.overdue}</td>
                  <td className="num">{r.open}</td>
                  <td className="num">{r.cancelled}</td>
                  <td className="num">{pct(r.completedOnTime + r.completedLate, r.total - r.cancelled)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
