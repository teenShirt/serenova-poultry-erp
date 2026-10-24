import { useState } from 'react'
import { Bird, Plus, Trash2 } from 'lucide-react'
import type { SetupDto } from '@shared/api'
import type { InventoryCategory } from '@shared/types'
import { call } from '../lib/api'
import { useApp } from '../lib/app'
import { Field, Notice, NumInput, RecoveryCodeDialog } from '../components/ui'
import { DemoButton } from './Login'
import { LanguageSwitch } from '../App'

type Inv = SetupDto['inventory'][number]

const TIMEZONES = ['Asia/Colombo', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'UTC']

export function SetupPage() {
  const { t, lang, status, refreshStatus, toast, errorText } = useApp()
  const [step, setStep] = useState(0)
  const [farmName, setFarmName] = useState('')
  const [location, setLocation] = useState('')
  const [timezone, setTimezone] = useState('Asia/Colombo')
  const [startDate, setStartDate] = useState(status.today)
  const [cages, setCages] = useState(
    Array.from({ length: 10 }, (_, i) => ({
      code: String(i + 1).padStart(2, '0'),
      name: `Cage ${String(i + 1).padStart(2, '0')}`,
      initialHens: 1000 as number | null,
      hasWaterMeter: true
    }))
  )
  const [inventory, setInventory] = useState<Inv[]>([
    { category: 'feed', name: 'Layer Mash', unit: 'kg', lowStockThreshold: 1000, openingBalance: 0, batchNo: null, expiryDate: null }
  ])
  const [admin, setAdmin] = useState({ email: '', displayName: '', password: '', confirm: '' })
  const [setupKey, setSetupKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adminCode, setAdminCode] = useState<string | null>(null)

  const steps = [t('setup.step.farm'), t('setup.step.cages'), t('setup.step.inventory'), t('setup.step.admin')]
  const totalHens = cages.reduce((s, c) => s + (c.initialHens ?? 0), 0)

  const valid = [
    farmName.trim().length > 0 && !!startDate,
    cages.length > 0 &&
      cages.every((c) => c.name.trim() && c.code.trim() && c.initialHens !== null) &&
      new Set(cages.map((c) => c.code.trim())).size === cages.length,
    inventory.every((i) => i.name.trim() && i.unit.trim() && (i.category !== 'medicine' || i.openingBalance === 0 || (i.batchNo ?? '').trim())),
    admin.email.includes('@') && admin.password.length >= 6 && admin.password === admin.confirm && (!status.setupKeyRequired || setupKey.trim().length > 0)
  ]

  const setCageCount = (n: number) => {
    setCages((cur) => {
      const next = cur.slice(0, n)
      for (let i = cur.length; i < n; i++)
        next.push({ code: String(i + 1).padStart(2, '0'), name: `Cage ${String(i + 1).padStart(2, '0')}`, initialHens: 1000, hasWaterMeter: true })
      return next
    })
  }

  const finish = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await call('setup.complete', {
        farmName: farmName.trim(),
        farmLocation: location.trim(),
        timezone,
        language: lang,
        startDate,
        cages: cages.map((c) => ({ code: c.code.trim(), name: c.name.trim(), initialHens: c.initialHens ?? 0, hasWaterMeter: c.hasWaterMeter })),
        admin: { email: admin.email.trim(), displayName: admin.displayName.trim() || admin.email.trim(), password: admin.password },
        inventory: inventory.map((i) => ({ ...i, name: i.name.trim(), batchNo: i.batchNo?.trim() || null })),
        ...(status.setupKeyRequired ? { setupKey: setupKey.trim() } : {})
      })
      // Show the administrator's recovery code once before going to the sign-in screen.
      setAdminCode(r.recoveryCode)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card wide">
        <div className="auth-brand">
          <div className="brand-logo">
            <Bird size={22} />
          </div>
          <div className="grow">
            <h1 style={{ fontSize: 22 }}>{t('setup.title')}</h1>
            <div className="muted">{t('app.name')}</div>
          </div>
          <div style={{ width: 220 }}>
            <LanguageSwitch />
          </div>
        </div>
        <div className="steps">
          {steps.map((s, i) => (
            <div key={s} className={`step ${i === step ? 'on' : i < step ? 'done' : ''}`}>
              {i + 1}. {s}
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="stack">
            <div className="form-grid">
              <Field label={t('setup.farmName')} required>
                <input className="input" autoFocus value={farmName} onChange={(e) => setFarmName(e.target.value)} maxLength={100} />
              </Field>
              <Field label={t('setup.location')}>
                <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} />
              </Field>
              <Field label={t('setup.timezone')}>
                <select className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {TIMEZONES.map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('setup.startDate')} hint={t('setup.startDateHint')}>
                <input className="input" type="date" value={startDate} max={status.today} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
            </div>
            <div className="row" style={{ justifyContent: 'center', margin: '8px 0' }}>
              <span className="muted">— {t('setup.or')} —</span>
            </div>
            <div style={{ maxWidth: 420, margin: '0 auto', width: '100%' }}>
              <DemoButton />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="stack">
            <Notice tone="info">{t('setup.cagesHint')}</Notice>
            <div className="row">
              <Field label={t('setup.cageCount')}>
                <NumInput value={cages.length} onChange={(v) => v !== null && v >= 1 && v <= 50 && setCageCount(v)} />
              </Field>
              <div className="grow" />
              <strong>{t('setup.totalHens', { count: totalHens.toLocaleString() })}</strong>
            </div>
            <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('cage.code')}</th>
                    <th>{t('cage.name')}</th>
                    <th className="num">{t('setup.initialHens')}</th>
                    <th>{t('setup.hasMeter')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cages.map((c, i) => (
                    <tr key={i}>
                      <td style={{ width: 110 }}>
                        <input
                          className="input"
                          value={c.code}
                          maxLength={20}
                          onChange={(e) => setCages(cages.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          value={c.name}
                          maxLength={60}
                          onChange={(e) => setCages(cages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                        />
                      </td>
                      <td style={{ width: 160 }}>
                        <NumInput value={c.initialHens} onChange={(v) => setCages(cages.map((x, j) => (j === i ? { ...x, initialHens: v } : x)))} />
                      </td>
                      <td style={{ width: 120 }}>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={c.hasWaterMeter}
                            onChange={(e) => setCages(cages.map((x, j) => (j === i ? { ...x, hasWaterMeter: e.target.checked } : x)))}
                          />
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="stack">
            <Notice tone="info">{t('setup.inventoryHint')}</Notice>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('inv.category')}</th>
                    <th>{t('common.name')}</th>
                    <th>{t('common.unit')}</th>
                    <th className="num">{t('setup.openingBalance')}</th>
                    <th className="num">{t('setup.lowStock')}</th>
                    <th>{t('inv.batchNo')}</th>
                    <th>{t('inv.expiryDate')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {inventory.map((it, i) => {
                    const upd = (p: Partial<Inv>) => setInventory(inventory.map((x, j) => (j === i ? { ...x, ...p } : x)))
                    return (
                      <tr key={i}>
                        <td>
                          <select
                            className="select"
                            value={it.category}
                            onChange={(e) =>
                              upd({
                                category: e.target.value as InventoryCategory,
                                unit: e.target.value === 'feed' ? 'kg' : e.target.value === 'medicine' ? 'ml' : 'pcs'
                              })
                            }
                          >
                            <option value="feed">{t('inv.cat.feed')}</option>
                            <option value="medicine">{t('inv.cat.medicine')}</option>
                            <option value="supply">{t('inv.cat.supply')}</option>
                          </select>
                        </td>
                        <td>
                          <input className="input" value={it.name} onChange={(e) => upd({ name: e.target.value })} />
                        </td>
                        <td style={{ width: 90 }}>
                          <input className="input" value={it.unit} onChange={(e) => upd({ unit: e.target.value })} />
                        </td>
                        <td style={{ width: 120 }}>
                          <NumInput decimals value={it.openingBalance} onChange={(v) => upd({ openingBalance: v ?? 0 })} />
                        </td>
                        <td style={{ width: 110 }}>
                          <NumInput decimals value={it.lowStockThreshold} onChange={(v) => upd({ lowStockThreshold: v })} />
                        </td>
                        <td style={{ width: 120 }}>
                          <input
                            className="input"
                            disabled={it.category !== 'medicine'}
                            value={it.batchNo ?? ''}
                            onChange={(e) => upd({ batchNo: e.target.value })}
                          />
                        </td>
                        <td style={{ width: 150 }}>
                          <input
                            className="input"
                            type="date"
                            disabled={it.category !== 'medicine'}
                            value={it.expiryDate ?? ''}
                            onChange={(e) => upd({ expiryDate: e.target.value || null })}
                          />
                        </td>
                        <td>
                          <button className="icon-btn" onClick={() => setInventory(inventory.filter((_, j) => j !== i))} aria-label={t('common.delete')}>
                            <Trash2 size={18} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div>
              <button
                className="btn"
                onClick={() =>
                  setInventory([
                    ...inventory,
                    { category: 'medicine', name: '', unit: 'ml', lowStockThreshold: null, openingBalance: 0, batchNo: null, expiryDate: null }
                  ])
                }
              >
                <Plus size={18} />
                {t('setup.addItem')}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="stack">
            <Notice tone="info">{t('setup.adminHint')}</Notice>
            <div className="form-grid">
              <Field label={t('setup.displayName')}>
                <input className="input" value={admin.displayName} onChange={(e) => setAdmin({ ...admin, displayName: e.target.value })} />
              </Field>
              <Field label={t('auth.email')} required>
                <input
                  className="input"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  value={admin.email}
                  onChange={(e) => setAdmin({ ...admin, email: e.target.value })}
                />
              </Field>
              <Field label={t('auth.password')} required hint={t('err.password_too_short')}>
                <input className="input" type="password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} />
              </Field>
              <Field label={t('auth.confirmPassword')} required>
                <input
                  className={`input ${admin.confirm && admin.confirm !== admin.password ? 'invalid' : ''}`}
                  type="password"
                  value={admin.confirm}
                  onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })}
                />
              </Field>
            </div>
            {admin.confirm && admin.confirm !== admin.password && <Notice tone="warn">{t('auth.passwordMismatch')}</Notice>}
            {status.setupKeyRequired && (
              <Field label={t('setup.setupKey')} required hint={t('setup.setupKeyHint')}>
                <input className="input" type="password" autoComplete="off" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} />
              </Field>
            )}
          </div>
        )}

        {error && (
          <div className="mt">
            <Notice tone="bad">{error}</Notice>
          </div>
        )}
        <div className="row end mt">
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              {t('common.back')}
            </button>
          )}
          {step < 3 ? (
            <button className="btn primary" disabled={!valid[step]} onClick={() => setStep(step + 1)}>
              {t('common.next')}
            </button>
          ) : (
            <button className="btn primary big" disabled={!valid.every(Boolean) || busy} onClick={finish}>
              {t('setup.finish')}
            </button>
          )}
        </div>
      </div>
      {adminCode && (
        <RecoveryCodeDialog
          code={adminCode}
          title={t('setup.codeTitle')}
          onClose={async () => {
            toast('success', t('setup.done'))
            await refreshStatus()
          }}
        />
      )}
    </div>
  )
}
