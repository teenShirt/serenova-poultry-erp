import { useState } from 'react'
import { Building2, Leaf, LogOut, Pencil, Plus, ShieldCheck } from 'lucide-react'
import { MODULES, SUBSCRIPTION_STATUSES, type Module, type OrgSummary, type Plan, type PlatformUser, type SubscriptionStatus } from '@shared/platform'
import type { Language } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, ReasonDialog, RecoveryCodeDialog, Stat, Tabs } from '../components/ui'
import { LanguageSwitch } from '../App'

/**
 * The Serenova platform console (#/platform): organizations, plans and subscriptions. For platform
 * administrators only (created on the server with `npm run create-super-admin`). It never shows an
 * organization's farm records, and the server records every action in the platform audit log.
 */
export function PlatformConsole() {
  const { t } = useApp()
  const { data: st, reload } = useLoad(() => call('platform.status'), [])
  if (!st) return <div className="page muted">{t('app.loading')}</div>
  return st.user ? <Console user={st.user} version={st.version} onSignedOut={reload} /> : <PlatformLogin onSignedIn={reload} />
}

function PlatformLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const { t, errorText } = useApp()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await call('platform.login', { email, password })
      onSignedIn()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auth-page">
      <form className="auth-card stack" onSubmit={submit}>
        <div className="auth-brand">
          <div className="brand-logo">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h1 style={{ fontSize: 20 }}>{t('plat.title')}</h1>
            <div className="muted">Serenova Tech</div>
          </div>
        </div>
        <LanguageSwitch />
        <Notice tone="info">{t('plat.loginHint')}</Notice>
        <Field label={t('auth.email')}>
          <input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </Field>
        <Field label={t('auth.password')}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn primary big" disabled={busy || !email || !password}>
          {t('auth.login')}
        </button>
        <a className="link-btn" href="#/">
          {t('plat.backToApp')}
        </a>
      </form>
    </div>
  )
}

type Tab = 'overview' | 'orgs' | 'plans'

function Console({ user, version, onSignedOut }: { user: PlatformUser; version: string; onSignedOut: () => void }) {
  const { t, fail } = useApp()
  const [tab, setTab] = useState<Tab>('overview')
  return (
    <div className="platform">
      <header className="platform-bar">
        <div className="brand">
          <div className="brand-logo">
            <Leaf size={22} />
          </div>
          <div className="brand-text">
            Serenova Tech
            <small>{t('plat.title')}</small>
          </div>
        </div>
        <div className="grow" />
        <LanguageSwitch dark />
        <span className="platform-user">{user.displayName}</span>
        <button
          className="side-btn"
          onClick={async () => {
            await call('platform.logout').catch(fail)
            onSignedOut()
          }}
        >
          <LogOut size={18} /> <span>{t('nav.logout')}</span>
        </button>
      </header>
      <main className="page stack">
        <Notice tone="info">{t('plat.privacy')}</Notice>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'overview', label: t('plat.overview') },
            { value: 'orgs', label: t('plat.organizations') },
            { value: 'plans', label: t('plat.plans') }
          ]}
        />
        {tab === 'overview' && <Overview />}
        {tab === 'orgs' && <Organizations />}
        {tab === 'plans' && <Plans />}
        <div className="muted small">v{version}</div>
      </main>
    </div>
  )
}

const STATUS_TONE: Record<SubscriptionStatus, string> = {
  trial: 'info',
  active: 'good',
  grace: 'warn',
  past_due: 'warn',
  suspended: 'bad',
  cancelled: 'bad',
  expired: 'bad'
}

function SubBadge({ s }: { s: SubscriptionStatus }) {
  const { t } = useApp()
  return <span className={`pill ${STATUS_TONE[s]}`}>{t('sub.status.' + s)}</span>
}

function Overview() {
  const { t, num, dateTime } = useApp()
  const { data: m } = useLoad(() => call('platform.metrics'), [])
  if (!m) return <div className="muted">{t('app.loading')}</div>
  return (
    <div className="stack">
      <div className="grid stats">
        <Stat
          label={t('plat.m.orgs')}
          value={num(m.organizations.total)}
          sub={t('plat.m.orgsSub', { active: m.organizations.active, suspended: m.organizations.suspended })}
        />
        <Stat label={t('plat.m.users')} value={num(m.users.active)} sub={t('plat.m.usersSub', { n: m.users.signedInLast7Days })} />
        <Stat
          label={t('plat.m.trials')}
          value={num(m.subscriptions.trial)}
          sub={t('plat.m.trialsSub', { grace: m.subscriptions.grace, expired: m.subscriptions.expired })}
          tone={m.subscriptions.expired > 0 ? 'warn' : undefined}
        />
        <Stat
          label={t('plat.m.backup')}
          value={m.backups.lastWholeDatabase ? t('plat.backup.' + m.backups.lastWholeDatabase.status) : '—'}
          sub={m.backups.lastWholeDatabase ? dateTime(m.backups.lastWholeDatabase.createdAt) : t('plat.m.noBackup')}
          tone={m.backups.failedLast7Days > 0 || !m.backups.lastWholeDatabase ? 'bad' : undefined}
        />
      </div>
      <Card title={t('plat.health')}>
        <dl className="kv">
          <dt>{t('plat.h.version')}</dt>
          <dd>
            v{m.health.version} · {t('plat.h.schema', { n: m.health.schemaVersion })}
          </dd>
          <dt>{t('plat.h.uptime')}</dt>
          <dd>{t('plat.h.uptimeValue', { h: Math.floor(m.health.uptimeSeconds / 3600), m: Math.floor((m.health.uptimeSeconds % 3600) / 60) })}</dd>
          <dt>{t('plat.h.database')}</dt>
          <dd>{num(m.health.databaseMb, 1)} MB</dd>
          <dt>{t('plat.h.backups')}</dt>
          <dd>
            {m.health.backupFolderMb === null ? '—' : t('plat.h.backupFolder', { mb: num(m.health.backupFolderMb, 1), files: m.health.backupFiles ?? 0 })}
          </dd>
          <dt>{t('plat.h.failedBackups')}</dt>
          <dd className={m.backups.failedLast7Days ? 'bad' : ''}>{m.backups.failedLast7Days}</dd>
        </dl>
        <h3>{t('plat.h.jobFailures')}</h3>
        {m.health.jobFailures.length === 0 ? (
          <div className="muted small">{t('plat.h.noJobFailures')}</div>
        ) : (
          <table className="data">
            <tbody>
              {m.health.jobFailures.map((f, i) => (
                <tr key={i}>
                  <td className="nowrap">{dateTime(f.at)}</td>
                  <td>{f.job}</td>
                  <td className="muted small">{f.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title={t('plat.recent')}>
        {m.recentEvents.length === 0 ? (
          <Empty text={t('common.noData')} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('plat.when')}</th>
                  <th>{t('plat.action')}</th>
                  <th>{t('plat.organization')}</th>
                  <th>{t('plat.by')}</th>
                </tr>
              </thead>
              <tbody>
                {m.recentEvents.map((e, i) => (
                  <tr key={i}>
                    <td>{dateTime(e.at)}</td>
                    <td>{t('plat.act.' + e.action)}</td>
                    <td>{e.organization ?? '—'}</td>
                    <td>{e.by ?? '—'}</td>
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

const usage = (used: number, max: number) => `${used} / ${max}`

function Organizations() {
  const { t, date, toast } = useApp()
  const { data: orgs } = useLoad(() => call('platform.organizations'), [])
  const { data: plans } = useLoad(() => call('platform.plans'), [])
  const [editing, setEditing] = useState<OrgSummary | null>(null)
  const [changing, setChanging] = useState<{ org: OrgSummary; to: 'active' | 'suspended' | 'archived' } | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ code: string; recoveryCode: string } | null>(null)
  return (
    <Card
      title={t('plat.organizations')}
      actions={
        <button className="btn primary" onClick={() => setCreating(true)} disabled={!plans}>
          <Plus size={18} /> {t('plat.newOrg')}
        </button>
      }
    >
      {!orgs ? (
        <div className="muted">{t('app.loading')}</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('plat.organization')}</th>
                <th>{t('plat.plan')}</th>
                <th>{t('plat.subscription')}</th>
                <th>{t('plat.users')}</th>
                <th>{t('plat.admins')}</th>
                <th>{t('plat.lastActivity')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => {
                const e = o.entitlements
                return (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.name}</strong>
                      <div className="muted small">
                        {o.code}
                        {o.status !== 'active' && (
                          <>
                            {' '}
                            · <span className="pill bad">{t('plat.orgStatus.' + o.status)}</span>
                          </>
                        )}
                      </div>
                    </td>
                    <td>{e.planName}</td>
                    <td>
                      <SubBadge s={e.effective} />
                      {e.daysLeft !== null && <div className="muted small">{t('sub.daysLeft', { n: e.daysLeft })}</div>}
                    </td>
                    <td className={e.usage.users > e.limits.maxUsers ? 'bad' : ''}>{usage(e.usage.users, e.limits.maxUsers)}</td>
                    <td className={e.usage.admins > e.limits.maxAdmins ? 'bad' : ''}>{usage(e.usage.admins, e.limits.maxAdmins)}</td>
                    <td>{o.lastActivityAt ? date(o.lastActivityAt.slice(0, 10)) : '—'}</td>
                    <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => setEditing(o)}>
                        <Pencil size={15} /> {t('plat.subscription')}
                      </button>
                      {o.status === 'active' ? (
                        <button className="btn sm danger" onClick={() => setChanging({ org: o, to: 'suspended' })}>
                          {t('plat.suspend')}
                        </button>
                      ) : (
                        <button className="btn sm" onClick={() => setChanging({ org: o, to: 'active' })}>
                          {t('plat.reactivate')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && plans && <SubscriptionDialog org={editing} plans={plans} onClose={() => setEditing(null)} />}
      {creating && plans && (
        <NewOrgDialog
          plans={plans}
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false)
            setCreated(r)
          }}
        />
      )}
      {created && <RecoveryCodeDialog code={created.recoveryCode} intro={t('plat.createdIntro', { code: created.code })} onClose={() => setCreated(null)} />}
      {changing && (
        <ReasonDialog
          title={`${t(changing.to === 'active' ? 'plat.reactivate' : 'plat.suspend')}: ${changing.org.name}`}
          hint={changing.to === 'active' ? undefined : t('plat.suspendHint')}
          danger={changing.to !== 'active'}
          onClose={() => setChanging(null)}
          onSubmit={async (reason) => {
            await call('platform.setOrganizationStatus', { id: changing.org.id, status: changing.to, reason })
            toast('success', t('common.saved'))
          }}
        />
      )}
    </Card>
  )
}

const LIMIT_KEYS = ['maxUsers', 'maxAdmins', 'maxRoles', 'maxFarms', 'maxWarehouses'] as const
type LimitKey = (typeof LIMIT_KEYS)[number]

function SubscriptionDialog({ org, plans, onClose }: { org: OrgSummary; plans: Plan[]; onClose: () => void }) {
  const { t, fail, toast } = useApp()
  const e = org.entitlements
  const [planId, setPlanId] = useState(plans.find((p) => p.code === e.planCode)?.id ?? plans[0]!.id)
  const [status, setStatus] = useState<SubscriptionStatus>(e.status)
  const [startsOn, setStartsOn] = useState(e.startsOn)
  const [endsOn, setEndsOn] = useState(e.endsOn ?? '')
  const [trialEndsOn, setTrialEndsOn] = useState(e.trialEndsOn ?? '')
  const [graceDays, setGraceDays] = useState(String(e.graceDays))
  const plan = plans.find((p) => p.id === planId)!
  // Only limits that differ from the plan are kept as per-customer overrides.
  const [limits, setLimits] = useState<Record<LimitKey, string>>(
    () => Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(e.limits[k])])) as Record<LimitKey, string>
  )
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const overrides: Partial<Record<LimitKey, number>> = {}
      for (const k of LIMIT_KEYS) if (limits[k].trim() !== '' && Number(limits[k]) !== plan[k]) overrides[k] = Number(limits[k])
      await call('platform.setSubscription', {
        organizationId: org.id,
        planId,
        status,
        startsOn,
        endsOn: endsOn || null,
        trialEndsOn: trialEndsOn || null,
        graceDays: Number(graceDays),
        overrides: Object.keys(overrides).length ? overrides : null,
        note
      })
      toast('success', t('common.saved'))
      onClose()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={`${t('plat.subscription')}: ${org.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || note.trim().length < 3} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('plat.plan')}>
            <select
              className="input"
              value={planId}
              onChange={(ev) => {
                const next = plans.find((p) => p.id === Number(ev.target.value))!
                setPlanId(next.id)
                setLimits(Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(next[k])])) as Record<LimitKey, string>)
              }}
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.active && p.id !== planId}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('plat.status')}>
            <select className="input" value={status} onChange={(ev) => setStatus(ev.target.value as SubscriptionStatus)}>
              {SUBSCRIPTION_STATUSES.filter((s) => s !== 'grace' && s !== 'expired').map((s) => (
                <option key={s} value={s}>
                  {t('sub.status.' + s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('plat.graceDays')}>
            <input className="input" type="number" min={0} max={365} value={graceDays} onChange={(ev) => setGraceDays(ev.target.value)} />
          </Field>
          <Field label={t('plat.startsOn')}>
            <input className="input" type="date" value={startsOn} onChange={(ev) => setStartsOn(ev.target.value)} />
          </Field>
          <Field label={t('plat.trialEndsOn')}>
            <input className="input" type="date" value={trialEndsOn} onChange={(ev) => setTrialEndsOn(ev.target.value)} />
          </Field>
          <Field label={t('plat.endsOn')} hint={t('plat.endsOnHint')}>
            <input className="input" type="date" value={endsOn} onChange={(ev) => setEndsOn(ev.target.value)} />
          </Field>
        </div>
        <h3>{t('plat.limits')}</h3>
        <div className="form-grid">
          {LIMIT_KEYS.map((k) => (
            <Field key={k} label={t('plat.limit.' + k)} hint={Number(limits[k]) !== plan[k] ? t('plat.overridden', { n: plan[k] }) : undefined}>
              <input className="input" type="number" min={0} value={limits[k]} onChange={(ev) => setLimits({ ...limits, [k]: ev.target.value })} />
            </Field>
          ))}
        </div>
        <Notice tone="info">{t('plat.limitsHint')}</Notice>
        <Field label={t('common.reason')} required hint={t('common.reasonRequired')}>
          <textarea className="input" value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

function NewOrgDialog({ plans, onClose, onCreated }: { plans: Plan[]; onClose: () => void; onCreated: (r: { code: string; recoveryCode: string }) => void }) {
  const { t, fail } = useApp()
  const active = plans.filter((p) => p.active)
  const [f, setF] = useState({
    name: '',
    location: '',
    timezone: 'Asia/Colombo',
    language: 'si' as Language,
    adminEmail: '',
    adminName: '',
    adminPassword: '',
    planId: active[0]?.id ?? 0,
    trialDays: '30'
  })
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch })
  const ok = f.name.trim().length >= 2 && f.adminEmail.includes('@') && f.adminName.trim() && f.adminPassword.length >= 6 && f.planId
  const save = async () => {
    setBusy(true)
    try {
      const r = await call('platform.createOrganization', { ...f, trialDays: Number(f.trialDays) || 0 })
      onCreated(r)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('plat.newOrg')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!ok || busy} onClick={save}>
            <Building2 size={17} /> {t('plat.create')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('setup.farmName')} required>
          <input className="input" autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={100} />
        </Field>
        <Field label={t('setup.location')}>
          <input className="input" value={f.location} onChange={(e) => set({ location: e.target.value })} maxLength={200} />
        </Field>
        <Field label={t('setup.timezone')}>
          <input className="input" value={f.timezone} onChange={(e) => set({ timezone: e.target.value })} />
        </Field>
        <Field label={t('plat.language')}>
          <select className="input" value={f.language} onChange={(e) => set({ language: e.target.value as Language })}>
            <option value="si">සිංහල</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field label={t('plat.adminName')} required>
          <input className="input" value={f.adminName} onChange={(e) => set({ adminName: e.target.value })} maxLength={80} />
        </Field>
        <Field label={t('plat.adminEmail')} required>
          <input className="input" type="email" value={f.adminEmail} onChange={(e) => set({ adminEmail: e.target.value })} maxLength={255} />
        </Field>
        <Field label={t('plat.adminPassword')} required hint={t('plat.adminPasswordHint')}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={f.adminPassword}
            onChange={(e) => set({ adminPassword: e.target.value })}
          />
        </Field>
        <Field label={t('plat.plan')}>
          <select className="input" value={f.planId} onChange={(e) => set({ planId: Number(e.target.value) })}>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('plat.trialDays')} hint={t('plat.trialDaysHint')}>
          <input className="input" type="number" min={0} max={365} value={f.trialDays} onChange={(e) => set({ trialDays: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function Plans() {
  const { t } = useApp()
  const { data: plans } = useLoad(() => call('platform.plans'), [])
  const [editing, setEditing] = useState<Plan | 'new' | null>(null)
  return (
    <Card
      title={t('plat.plans')}
      actions={
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={18} /> {t('plat.newPlan')}
        </button>
      }
    >
      {!plans ? (
        <div className="muted">{t('app.loading')}</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('plat.plan')}</th>
                {LIMIT_KEYS.map((k) => (
                  <th key={k} className="num">
                    {t('plat.limit.' + k)}
                  </th>
                ))}
                <th>{t('plat.modules')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className={p.active ? '' : 'muted'}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="muted small">
                      {p.code}
                      {!p.active && ` · ${t('plat.inactive')}`}
                    </div>
                  </td>
                  {LIMIT_KEYS.map((k) => (
                    <td key={k} className="num">
                      {p[k]}
                    </td>
                  ))}
                  <td>{p.modules.length ? p.modules.map((m) => t('module.' + m)).join(', ') : '—'}</td>
                  <td>
                    <button className="btn sm" onClick={() => setEditing(p)}>
                      <Pencil size={15} /> {t('common.edit')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <PlanDialog plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function PlanDialog({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const { t, fail, toast } = useApp()
  const [code, setCode] = useState(plan?.code ?? '')
  const [name, setName] = useState(plan?.name ?? '')
  const [limits, setLimits] = useState<Record<LimitKey, string>>(
    () => Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(plan?.[k] ?? 1)])) as Record<LimitKey, string>
  )
  const [modules, setModules] = useState<Module[]>(plan?.modules ?? [])
  const [active, setActive] = useState(plan?.active ?? true)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await call('platform.savePlan', {
        id: plan?.id ?? null,
        code,
        name,
        maxUsers: Number(limits.maxUsers),
        maxAdmins: Number(limits.maxAdmins),
        maxRoles: Number(limits.maxRoles),
        maxFarms: Number(limits.maxFarms),
        maxWarehouses: Number(limits.maxWarehouses),
        modules,
        active
      })
      toast('success', t('common.saved'))
      onClose()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={plan ? `${t('plat.plan')}: ${plan.name}` : t('plat.newPlan')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || code.trim().length < 2 || name.trim().length < 2} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('plat.planCode')} hint={t('plat.planCodeHint')}>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} />
          </Field>
          <Field label={t('plat.planName')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
        </div>
        <div className="form-grid">
          {LIMIT_KEYS.map((k) => (
            <Field key={k} label={t('plat.limit.' + k)}>
              <input className="input" type="number" min={0} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <Field label={t('plat.modules')}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
            {MODULES.map((m) => (
              <label key={m} className="check">
                <input
                  type="checkbox"
                  checked={modules.includes(m)}
                  onChange={(e) => setModules(e.target.checked ? [...modules, m] : modules.filter((x) => x !== m))}
                />
                {t('module.' + m)}
              </label>
            ))}
          </div>
        </Field>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t('plat.planActive')}
        </label>
        {plan && <Notice tone="info">{t('plat.planEditHint')}</Notice>}
      </div>
    </Modal>
  )
}
