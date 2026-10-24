import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, CheckCircle2, Database, DatabaseBackup, Gauge, HardDrive, ShieldCheck, Users, Wrench, XCircle } from 'lucide-react'
import { addDays } from '@shared/dates'
import type { DbInfo } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Notice, PageHeader, Tabs } from '../components/ui'
import { CageBars, SERIES, TimeChart } from '../components/charts'
import { Kpi } from '../components/Kpi'
import { UsersTab } from './Settings'
import { AuditTab } from './Reports'

type Tab = 'overview' | 'users' | 'database' | 'activity'

export function AdminPage() {
  const { t, can } = useApp()
  // Each tab needs its own permission; the overview combines them all.
  const tabs = (
    [
      { value: 'overview', label: t('admin.overview'), ok: can('users.manage') && can('database.manage') && can('audit.view') },
      { value: 'users', label: t('admin.users'), ok: can('users.manage') || can('roles.manage') },
      { value: 'database', label: t('admin.database'), ok: can('database.manage') },
      { value: 'activity', label: t('admin.activity'), ok: can('audit.view') }
    ] as { value: Tab; label: string; ok: boolean }[]
  ).filter((x) => x.ok)
  const [chosen, setTab] = useState<Tab | null>(null)
  const tab = chosen ?? tabs[0]?.value
  if (!tab) {
    return (
      <div className="page">
        <Notice tone="warn">{t('common.adminOnly')}</Notice>
      </div>
    )
  }
  return (
    <div className="page">
      <PageHeader title={t('admin.title')} icon={<ShieldCheck size={26} color="var(--brand)" />} />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'overview' && <Overview onTab={setTab} />}
      {tab === 'users' && <UsersTab />}
      {tab === 'database' && <DatabaseTab />}
      {tab === 'activity' && <AuditTab />}
    </div>
  )
}

const mb = (b: number) => (b / 1024 / 1024).toFixed(b > 10 * 1024 * 1024 ? 0 : 2)

function Overview({ onTab }: { onTab: (t: Tab) => void }) {
  const { t, num, status, dateTime } = useApp()
  const nav = useNavigate()
  const from = addDays(status.today, -29)
  const { data: users } = useLoad(() => call('users.list'), [])
  const { data: info } = useLoad(() => call('admin.dbInfo'), [])
  const { data: act } = useLoad(() => call('admin.activity', { from, to: status.today }), [from, status.today])
  const { data: cages } = useLoad(() => call('cages.list', { includeInactive: false }), [])
  const active = (users ?? []).filter((u) => u.active && !u.pending)
  const pending = (users ?? []).filter((u) => u.pending)
  const failed = (act?.byDay ?? []).reduce((s, d) => s + d.failedLogins, 0)
  const backupAgeH = info?.lastBackup ? (Date.now() - Date.parse(info.lastBackup.createdAt)) / 3600000 : null

  return (
    <div className="stack">
      {pending.length > 0 && (
        <Notice tone="warn">
          <div className="row">
            <span className="grow">{t('alert.pending_signups', { count: pending.length })}</span>
            <button className="btn sm" onClick={() => onTab('users')}>
              {t('admin.users')}
            </button>
          </div>
        </Notice>
      )}
      <div className="grid stats">
        <Kpi
          icon={<Users size={18} />}
          label={t('admin.activeUsers')}
          value={num(active.length)}
          sub={t('admin.adminsWorkers', {
            admins: active.filter((u) => u.role === 'admin').length,
            workers: active.filter((u) => u.role === 'operator').length
          })}
        />
        <Kpi
          icon={<Database size={18} />}
          label={t('admin.dbSize')}
          value={info ? `${mb(info.sizeBytes)} MB` : '—'}
          sub={info ? t('admin.records', { count: num(info.tables.reduce((s, x) => s + x.rows, 0)) }) : undefined}
        />
        <Kpi
          icon={<DatabaseBackup size={18} />}
          label={t('admin.lastBackup')}
          value={info?.lastBackup ? dateTime(info.lastBackup.createdAt) : t('common.none')}
          sub={info ? t('admin.backups30', { count: info.backupsOk30d }) : undefined}
          tone={backupAgeH === null || backupAgeH > 48 || info?.lastBackup?.status === 'failed' ? 'warn' : undefined}
        />
        <Kpi
          icon={<Gauge size={18} />}
          label={t('admin.health')}
          value={info?.lastCheck ? (info.lastCheck.ok ? t('admin.healthy') : t('admin.problem')) : t('admin.notChecked')}
          sub={info?.lastCheck ? dateTime(info.lastCheck.at) : undefined}
          tone={info?.lastCheck && !info.lastCheck.ok ? 'bad' : undefined}
        />
        <Kpi
          icon={<Activity size={18} />}
          label={t('admin.failedLogins')}
          value={num(failed)}
          sub={t('common.last30')}
          tone={failed > 10 ? 'warn' : undefined}
        />
      </div>
      <div className="grid cols-2">
        <TimeChart
          title={t('admin.activityChart')}
          data={act?.byDay ?? []}
          kind="bar"
          series={[
            { key: 'changes', label: t('admin.changes'), color: SERIES.blue },
            { key: 'logins', label: t('admin.logins'), color: SERIES.aqua }
          ]}
        />
        <CageBars
          title={t('admin.byUser')}
          data={(act?.byUser ?? []).map((u) => ({ name: u.username, changes: u.changes }))}
          valueKey="changes"
          label={t('admin.changes')}
        />
      </div>
      <Card
        title={t('admin.coverage')}
        actions={
          <button className="btn sm" onClick={() => onTab('users')}>
            {t('duty.title')}
          </button>
        }
      >
        <div className="muted small" style={{ marginBottom: 10 }}>
          {t('admin.coverageHint')}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('common.cage')}</th>
                <th>{t('admin.responsible')}</th>
              </tr>
            </thead>
            <tbody>
              {(cages ?? []).map((c) => {
                const who = active.filter((u) => u.role === 'operator' && u.cages !== null && u.cages.includes(c.id))
                const all = active.filter((u) => u.role === 'operator' && u.cages === null)
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                    </td>
                    <td>
                      {who.length + all.length === 0 ? (
                        <span className="badge warn">{t('admin.nobody')}</span>
                      ) : (
                        <span className="chips">
                          {who.map((u) => (
                            <span key={u.id} className="badge good">
                              {u.displayName}
                            </span>
                          ))}
                          {all.map((u) => (
                            <span key={u.id} className="badge">
                              {u.displayName} · {t('duty.allCages')}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="row">
        <button className="btn" onClick={() => onTab('database')}>
          <Database size={18} /> {t('admin.database')}
        </button>
        <button className="btn" onClick={() => nav('/backup')}>
          <DatabaseBackup size={18} /> {t('nav.backup')}
        </button>
      </div>
    </div>
  )
}

function DatabaseTab() {
  const { t, num, toast, fail, dateTime } = useApp()
  const { data, reload } = useLoad(() => call('admin.dbInfo'), [])
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [busy, setBusy] = useState<'check' | 'optimize' | null>(null)
  const d = info ?? data
  if (!d) return <div className="muted">{t('common.loading')}</div>
  const tables = [...d.tables].sort((a, b) => b.rows - a.rows)
  return (
    <div className="stack">
      <div className="grid cols-2">
        <Card title={t('admin.dbFile')}>
          <dl className="kv">
            <dt>{t('admin.location')}</dt>
            <dd className="small" style={{ wordBreak: 'break-all' }}>
              {d.file}
            </dd>
            <dt>{t('admin.dbSize')}</dt>
            <dd>{mb(d.sizeBytes)} MB</dd>
            <dt>{t('admin.schema')}</dt>
            <dd>v{d.schemaVersion}</dd>
            <dt>Server</dt>
            <dd>{d.serverVersion}</dd>
            <dt>{t('admin.lastBackup')}</dt>
            <dd>{d.lastBackup ? `${dateTime(d.lastBackup.createdAt)} · ${t(d.lastBackup.status === 'ok' ? 'bak.ok' : 'bak.failed')}` : t('common.none')}</dd>
          </dl>
        </Card>
        <Card title={t('admin.maintenance')}>
          <div className="stack">
            {d.lastCheck ? (
              <Notice tone={d.lastCheck.ok ? 'good' : 'bad'}>
                <div className="row" style={{ gap: 8 }}>
                  {d.lastCheck.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                  <strong>{d.lastCheck.ok ? t('admin.checkOk') : t('admin.checkFailed', { message: d.lastCheck.message })}</strong>
                </div>
                <div className="small">{dateTime(d.lastCheck.at)}</div>
              </Notice>
            ) : (
              <Notice tone="info">{t('admin.notChecked')}</Notice>
            )}
            <div className="muted small">{t('admin.checkHint')}</div>
            <div className="row">
              <button
                className="btn primary"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy('check')
                  try {
                    const r = await call('admin.checkDb')
                    toast(r.ok ? 'success' : 'error', r.ok ? t('admin.checkOk') : t('admin.checkFailed', { message: r.message }))
                    reload()
                    setInfo(null)
                  } catch (e) {
                    fail(e)
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                <ShieldCheck size={18} /> {t('admin.checkNow')}
              </button>
              <button
                className="btn"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy('optimize')
                  try {
                    setInfo(await call('admin.optimize'))
                    toast('success', t('admin.optimized'))
                  } catch (e) {
                    fail(e)
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                <Wrench size={18} /> {t('admin.optimize')}
              </button>
            </div>
            <div className="muted small">{t('admin.optimizeHint')}</div>
          </div>
        </Card>
      </div>
      <Card
        title={
          <h2 className="row" style={{ gap: 8 }}>
            <HardDrive size={20} /> {t('admin.tables')}
          </h2>
        }
      >
        {tables.length === 0 ? (
          <Empty text={t('common.noData')} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('admin.table')}</th>
                  <th>{t('admin.holds')}</th>
                  <th className="num">{t('admin.rows')}</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((x) => (
                  <tr key={x.name}>
                    <td>
                      <code>{x.name}</code>
                    </td>
                    <td className="small">{t('table.' + x.name)}</td>
                    <td className="num">{num(x.rows)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
