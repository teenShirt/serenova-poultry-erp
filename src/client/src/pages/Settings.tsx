import { useEffect, useState } from 'react'
import { Check, ClipboardList, KeyRound, Pencil, Plus, Settings as SettingsIcon, ShieldCheck, ShieldQuestion, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { CagesDialog, useCageSummary } from '../components/Duties'
import { EGG_SESSIONS, type FarmSettings, type RoleRow, type UserRow } from '@shared/types'
import { RolesCard } from '../components/Roles'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, ConfirmDialog, Field, Modal, Notice, NumInput, PageHeader, RecoveryCodeDialog, Tabs } from '../components/ui'

export function SettingsPage() {
  const { t, can } = useApp()
  const manage = can('settings.manage')
  const [tab, setTab] = useState<'farm' | 'calc' | 'me'>(manage ? 'farm' : 'me')
  const nav = useNavigate()
  return (
    <div className="page">
      <PageHeader title={t('set.title')} icon={<SettingsIcon size={26} color="var(--brand)" />} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ...(manage
            ? [
                { value: 'farm' as const, label: t('set.farm') },
                { value: 'calc' as const, label: `${t('set.calc')} & ${t('set.alerts')}` }
              ]
            : []),
          { value: 'me', label: t('auth.changePassword') }
        ]}
      />
      {tab === 'farm' && <FarmTab />}
      {tab === 'calc' && <CalcTab />}
      {manage && tab === 'farm' && (
        <div className="mt">
          <Notice tone="info">
            <div className="row">
              <span className="grow">{t('admin.movedHint')}</span>
              <button className="btn sm" onClick={() => nav('/admin')}>
                <ShieldCheck size={16} /> {t('nav.admin')}
              </button>
            </div>
          </Notice>
        </div>
      )}
      {tab === 'me' && <PasswordTab />}
    </div>
  )
}

function useSettingsForm() {
  const { status, refreshStatus, toast, fail, t } = useApp()
  const [f, setF] = useState<FarmSettings>(status.settings)
  useEffect(() => setF(status.settings), [status.settings])
  const save = async (patch: Partial<FarmSettings>) => {
    try {
      await call('settings.save', patch)
      await refreshStatus()
      toast('success', t('set.saved'))
    } catch (e) {
      fail(e)
    }
  }
  return { f, setF, save }
}

function FarmTab() {
  const { t, status } = useApp()
  const { f, setF, save } = useSettingsForm()
  return (
    <div className="stack">
    <Card>
      <div className="stack">
        <div className="form-grid">
          <Field label={t('setup.farmName')} required>
            <input className="input" value={f.farmName} onChange={(e) => setF({ ...f, farmName: e.target.value })} />
          </Field>
          <Field label={t('setup.location')}>
            <input className="input" value={f.farmLocation} onChange={(e) => setF({ ...f, farmLocation: e.target.value })} />
          </Field>
          <Field label={t('setup.timezone')}>
            <input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
          </Field>
          <Field label={t('app.language')}>
            <select className="select" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value as 'en' | 'si' })}>
              <option value="si">සිංහල</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label={t('set.currency')}>
            <input className="input" value={f.currency} maxLength={10} onChange={(e) => setF({ ...f, currency: e.target.value })} style={{ maxWidth: 140 }} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.allowSignup} onChange={(e) => setF({ ...f, allowSignup: e.target.checked })} />
          {t('set.allowSignup')}
        </label>
        <div className="row end">
          <button className="btn primary" disabled={!f.farmName.trim()} onClick={() => save({ farmName: f.farmName.trim(), farmLocation: f.farmLocation.trim(), timezone: f.timezone.trim(), language: f.language, allowSignup: f.allowSignup, currency: f.currency.trim() || 'Rs.' })}>
            {t('common.saveChanges')}
          </button>
        </div>
        <h3>{t('set.about')}</h3>
        <dl className="kv">
          <dt>{t('app.name')}</dt>
          <dd>{t('app.version', { version: status.version })}</dd>
          {status.organization && (
            <>
              <dt>{t('set.orgCode')}</dt>
              <dd>
                <strong>{status.organization.code}</strong> <span className="muted small">{t('set.orgCodeHint')}</span>
              </dd>
            </>
          )}
          <dt>{t('set.dataFolder')}</dt>
          <dd className="small">{status.dataDir}</dd>
        </dl>
      </div>
    </Card>
    </div>
  )
}

function CalcTab() {
  const { t } = useApp()
  const { f, setF, save } = useSettingsForm()
  const toggleSession = (s: (typeof EGG_SESSIONS)[number]) =>
    setF({ ...f, expectedEggSessions: f.expectedEggSessions.includes(s) ? f.expectedEggSessions.filter((x) => x !== s) : EGG_SESSIONS.filter((x) => x === s || f.expectedEggSessions.includes(x)) })
  return (
    <Card>
      <div className="stack">
        <h3>{t('set.calc')}</h3>
        <div className="form-grid">
          <Field label={t('set.prodDen')}>
            <select className="select" value={f.productionDenominator} onChange={(e) => setF({ ...f, productionDenominator: e.target.value as FarmSettings['productionDenominator'] })}>
              <option value="average">{t('set.prodDen.average')}</option>
              <option value="opening">{t('set.prodDen.opening')}</option>
              <option value="closing">{t('set.prodDen.closing')}</option>
            </select>
          </Field>
          <Field label={t('set.mortDen')}>
            <select className="select" value={f.mortalityDenominator} onChange={(e) => setF({ ...f, mortalityDenominator: e.target.value as FarmSettings['mortalityDenominator'] })}>
              <option value="opening">{t('set.mortDen.opening')}</option>
              <option value="average">{t('set.mortDen.average')}</option>
            </select>
          </Field>
        </div>
        <Field label={t('set.expectedSessions')}>
          <div className="row">
            {EGG_SESSIONS.map((s) => (
              <label key={s} className="check">
                <input type="checkbox" checked={f.expectedEggSessions.includes(s)} onChange={() => toggleSession(s)} />
                {t('session.' + s)}
              </label>
            ))}
          </div>
        </Field>
        <h3>{t('set.alerts')}</h3>
        <Notice tone="info">{t('issue.informational')}</Notice>
        <div className="form-grid">
          <Field label={t('set.prodDrop')}>
            <NumInput decimals value={f.productionDropPct} onChange={(v) => setF({ ...f, productionDropPct: v ?? 10 })} />
          </Field>
          <Field label={t('set.baselineDays')}>
            <NumInput value={f.baselineDays} onChange={(v) => setF({ ...f, baselineDays: v ?? 7 })} />
          </Field>
          <Field label={t('set.mortAlert')}>
            <NumInput decimals value={f.mortalityAlertPct} onChange={(v) => setF({ ...f, mortalityAlertPct: v ?? 0.1 })} />
          </Field>
          <Field label={t('set.waterChange')}>
            <NumInput decimals value={f.waterChangePct} onChange={(v) => setF({ ...f, waterChangePct: v ?? 30 })} />
          </Field>
          <Field label={t('set.expiryWarn')}>
            <NumInput value={f.medicineExpiryWarnDays} onChange={(v) => setF({ ...f, medicineExpiryWarnDays: v ?? 30 })} />
          </Field>
          <Field label={t('set.medUnits')}>
            <input className="input" value={f.medicineUnits.join(', ')} onChange={(e) => setF({ ...f, medicineUnits: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          </Field>
        </div>
        <div className="row end">
          <button
            className="btn primary"
            onClick={() =>
              save({
                productionDenominator: f.productionDenominator,
                mortalityDenominator: f.mortalityDenominator,
                expectedEggSessions: f.expectedEggSessions,
                productionDropPct: f.productionDropPct,
                baselineDays: f.baselineDays,
                mortalityAlertPct: f.mortalityAlertPct,
                waterChangePct: f.waterChangePct,
                medicineExpiryWarnDays: f.medicineExpiryWarnDays,
                medicineUnits: f.medicineUnits
              })
            }
          >
            {t('common.saveChanges')}
          </button>
        </div>
      </div>
    </Card>
  )
}

export function UsersTab() {
  const { t, dateTime, fail, toast, refreshStatus } = useApp()
  const { data: users } = useLoad(() => call('users.list'), [])
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null)
  const [resetFor, setResetFor] = useState<UserRow | null>(null)
  const [codeFor, setCodeFor] = useState<UserRow | null>(null)
  const [cagesFor, setCagesFor] = useState<UserRow | null>(null)
  const cageSummary = useCageSummary()
  const { can } = useApp()
  const { data: roleList } = useLoad(() => call('roles.list'), [])
  const roles = (roleList ?? []).filter((r) => !r.archived)
  const defaultRole = roles.find((r) => r.name === 'Farm Worker') ?? roles.find((r) => !r.isAdmin)
  const [shownCode, setShownCode] = useState<{ code: string; name: string } | null>(null)
  const [rejecting, setRejecting] = useState<UserRow | null>(null)
  const [approveRole, setApproveRole] = useState<Record<number, number>>({})
  const pending = (users ?? []).filter((u) => u.pending)
  const accounts = (users ?? []).filter((u) => !u.pending)

  const approve = async (u: UserRow) => {
    try {
      const roleId = approveRole[u.id] ?? defaultRole?.id
      if (!roleId) return
      await call('users.approve', { id: u.id, roleId })
      toast('success', t('common.saved'))
      await refreshStatus()
    } catch (e) {
      fail(e)
    }
  }

  return (
    <div className="stack">
      {pending.length > 0 && (
        <Card title={t('set.pendingTitle')}>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {pending.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.displayName}</strong> <span className="muted">({u.email ?? u.username})</span>
                    </td>
                    <td className="nowrap">{dateTime(u.createdAt)}</td>
                    <td className="nowrap">
                      <span className="field-label">{t('set.approveAs')} </span>
                      <RoleSelect roles={roles} value={approveRole[u.id] ?? defaultRole?.id ?? null} onChange={(id) => setApproveRole({ ...approveRole, [u.id]: id })} />
                    </td>
                    <td className="nowrap right">
                      <button className="btn sm primary" onClick={() => approve(u)}>
                        <Check size={14} /> {t('set.approve')}
                      </button>{' '}
                      <button className="btn sm" onClick={() => setRejecting(u)}>
                        <X size={14} /> {t('set.reject')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card
        title={t('set.users')}
        actions={
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Plus size={18} />
            {t('set.addUser')}
          </button>
        }
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('setup.displayName')}</th>
                <th>{t('auth.email')}</th>
                <th>{t('role.label')}</th>
                <th>{t('common.status')}</th>
                <th>{t('duty.cages')}</th>
                <th>{t('set.lastLogin')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.displayName}</strong>
                  </td>
                  <td>{u.email ?? <span className="badge bad">{t('set.noEmail')}</span>}</td>
                  <td>{u.roleName ?? '—'}</td>
                  <td>{u.active ? <span className="badge good">{t('common.active')}</span> : <span className="badge">{t('common.inactive')}</span>}</td>
                  <td className="small">{cageSummary(u)}</td>
                  <td>{dateTime(u.lastLoginAt)}</td>
                  <td className="nowrap">
                    {u.role !== 'admin' && (
                      <button className="icon-btn" title={t('duty.cages')} onClick={() => setCagesFor(u)}>
                        <ClipboardList size={16} />
                      </button>
                    )}
                    <button className="icon-btn" title={t('common.edit')} onClick={() => setEditing(u)}>
                      <Pencil size={16} />
                    </button>
                    <button className="icon-btn" title={t('set.resetPassword')} onClick={() => setResetFor(u)}>
                      <KeyRound size={16} />
                    </button>
                    <button className="icon-btn" title={t('set.newCodeFor')} onClick={() => setCodeFor(u)}>
                      <ShieldQuestion size={16} />
                    </button>
                    {!u.hasRecoveryCode && <span className="badge warn">{t('set.noCode')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {can('roles.manage') && <RolesCard />}
      {editing && (
        <UserForm user={editing === 'new' ? null : editing} roles={roles} defaultRole={defaultRole ?? null} onClose={() => setEditing(null)} onCode={(code, name) => setShownCode({ code, name })} />
      )}
      {resetFor && <ResetPassword user={resetFor} onClose={() => setResetFor(null)} />}
      {cagesFor && <CagesDialog user={cagesFor} onClose={() => setCagesFor(null)} />}
      {codeFor && (
        <ConfirmDialog
          title={`${t('set.newCodeFor')} — ${codeFor.displayName}`}
          body={t('auth.codeReplaced')}
          onClose={() => setCodeFor(null)}
          onConfirm={async () => {
            const r = await call('users.newRecoveryCode', { id: codeFor.id })
            setShownCode({ code: r.recoveryCode, name: codeFor.displayName })
          }}
        />
      )}
      {rejecting && (
        <ConfirmDialog
          title={t('set.reject')}
          body={t('set.rejectConfirm', { name: rejecting.displayName })}
          danger
          confirmLabel={t('set.reject')}
          onClose={() => setRejecting(null)}
          onConfirm={async () => {
            await call('users.reject', { id: rejecting.id })
            await refreshStatus()
          }}
        />
      )}
      {shownCode && <RecoveryCodeDialog code={shownCode.code} intro={t('set.giveCode', { name: shownCode.name })} onClose={() => setShownCode(null)} />}
    </div>
  )
}

/** A role picker: the organization's active roles. */
function RoleSelect({ roles, value, onChange }: { roles: RoleRow[]; value: number | null; onChange: (id: number) => void }) {
  return (
    <select className="select" style={{ width: 'auto', minWidth: 180 }} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      {value === null && <option value="">—</option>}
      {roles.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  )
}

function UserForm({
  user,
  roles,
  defaultRole,
  onClose,
  onCode
}: {
  user: UserRow | null
  roles: RoleRow[]
  defaultRole: RoleRow | null
  onClose: () => void
  onCode: (code: string, name: string) => void
}) {
  const { t, toast, fail } = useApp()
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [roleId, setRoleId] = useState<number | null>(user?.roleId ?? defaultRole?.id ?? null)
  const [active, setActive] = useState(user?.active ?? true)
  const [password, setPassword] = useState('')
  const ok = email.includes('@') && roleId !== null && (user ? displayName.trim().length > 0 : password.length >= 6)
  return (
    <Modal
      title={user ? `${t('common.edit')} — ${user.displayName}` : t('set.addUser')}
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
                if (user) await call('users.update', { id: user.id, email: email.trim(), displayName, roleId: roleId!, active })
                else {
                  const r = await call('users.create', { email: email.trim(), displayName: displayName.trim(), password, roleId: roleId! })
                  // The new user's recovery code is shown once so the administrator can hand it over.
                  onCode(r.recoveryCode, displayName.trim() || email.trim())
                }
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
        <Field label={t('setup.displayName')}>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label={t('auth.email')}>
          <input className="input" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('role.label')}>
          <RoleSelect roles={roles} value={roleId} onChange={setRoleId} />
        </Field>
        {!user && (
          <Field label={t('auth.password')} hint={t('err.password_too_short')}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        {user && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {t('common.active')}
          </label>
        )}
      </div>
    </Modal>
  )
}

function ResetPassword({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t, toast, fail } = useApp()
  const [pw, setPw] = useState('')
  return (
    <Modal
      title={`${t('set.resetPassword')} — ${user.email ?? user.displayName}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={pw.length < 6}
            onClick={async () => {
              try {
                await call('users.resetPassword', { id: user.id, password: pw })
                toast('success', t('auth.passwordChanged'))
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
      <Field label={t('auth.newPassword')} hint={t('err.password_too_short')}>
        <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      </Field>
    </Modal>
  )
}

function PasswordTab() {
  return (
    <div className="stack">
      <ChangePassword />
      <OwnRecoveryCode />
    </div>
  )
}

function OwnRecoveryCode() {
  const { t, fail } = useApp()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState<string | null>(null)
  return (
    <Card title={t('auth.newCode')}>
      <div className="stack" style={{ maxWidth: 420 }}>
        <div className="muted">{t('auth.newCodeHint')}</div>
        <Field label={t('auth.currentPassword')}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div>
          <button
            className="btn"
            disabled={!password}
            onClick={async () => {
              try {
                const r = await call('auth.newRecoveryCode', { password })
                setPassword('')
                setCode(r.recoveryCode)
              } catch (e) {
                fail(e)
              }
            }}
          >
            <ShieldQuestion size={18} /> {t('auth.newCode')}
          </button>
        </div>
      </div>
      {code && <RecoveryCodeDialog code={code} intro={t('auth.codeReplaced')} onClose={() => setCode(null)} />}
    </Card>
  )
}

function ChangePassword() {
  const { t, toast, fail } = useApp()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  return (
    <Card>
      <div className="stack" style={{ maxWidth: 420 }}>
        <Field label={t('auth.currentPassword')}>
          <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t('auth.newPassword')} hint={t('err.password_too_short')}>
          <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t('auth.confirmPassword')}>
          <input className={`input ${confirm && confirm !== next ? 'invalid' : ''}`} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div>
          <button
            className="btn primary"
            disabled={!current || next.length < 6 || next !== confirm}
            onClick={async () => {
              try {
                await call('auth.changePassword', { current, next })
                toast('success', t('auth.passwordChanged'))
                setCurrent('')
                setNext('')
                setConfirm('')
              } catch (e) {
                fail(e)
              }
            }}
          >
            {t('auth.changePassword')}
          </button>
        </div>
      </div>
    </Card>
  )
}
