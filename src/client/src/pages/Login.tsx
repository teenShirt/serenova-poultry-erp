import { useState } from 'react'
import { Bird, FlaskConical } from 'lucide-react'
import { call } from '../lib/api'
import { useApp } from '../lib/app'
import { Field, Notice, RecoveryCodeDialog } from '../components/ui'
import { LanguageSwitch } from '../App'

type Mode = 'login' | 'signup' | 'reset'

export function LoginPage() {
  const { t, status } = useApp()
  const [mode, setMode] = useState<Mode>('login')
  const [message, setMessage] = useState<string | null>(null)
  const back = (msg: string | null = null) => {
    setMessage(msg)
    setMode('login')
  }
  return (
    <div className="auth-page">
      <div className="auth-card stack">
        <div className="auth-brand">
          <div className="brand-logo">
            <Bird size={22} />
          </div>
          <div>
            <h1 style={{ fontSize: 20 }}>{t('app.name')}</h1>
            <div className="muted">{status.settings.farmName}</div>
          </div>
        </div>
        {status.isDemo && <Notice tone="bad">{t('app.demoBanner')}</Notice>}
        <LanguageSwitch />
        {mode === 'login' && <LoginForm message={message} onMode={(m) => { setMessage(null); setMode(m) }} />}
        {mode === 'signup' && <SignupForm onDone={back} />}
        {mode === 'reset' && <ResetForm onDone={back} />}
      </div>
    </div>
  )
}

function LoginForm({ message, onMode }: { message: string | null; onMode: (m: Mode) => void }) {
  const { t, status, refreshStatus, fail, errorText } = useApp()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await call('auth.login', { username, password })
      await refreshStatus()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div>
        <h2>{t('auth.title')}</h2>
        <div className="muted small">{t('auth.subtitle')}</div>
      </div>
      {message && <Notice tone="good">{message}</Notice>}
      <Field label={t('auth.username')}>
        <input className="input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      </Field>
      <Field label={t('auth.password')}>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </Field>
      {error && <Notice tone="bad">{error}</Notice>}
      <button className="btn primary big" disabled={busy || !username || !password}>
        {t('auth.login')}
      </button>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button type="button" className="link-btn" onClick={() => onMode('reset')}>
          {t('auth.forgot')}
        </button>
        {status.settings.allowSignup && !status.isDemo && (
          <button type="button" className="link-btn" onClick={() => onMode('signup')}>
            {t('auth.signup')}
          </button>
        )}
      </div>
      {status.isDemo ? (
        <button
          type="button"
          className="btn ghost"
          onClick={async () => {
            await call('demo.exit').catch(fail)
            await refreshStatus()
          }}
        >
          {t('app.exitDemo')}
        </button>
      ) : (
        <DemoButton />
      )}
    </form>
  )
}

function SignupForm({ onDone }: { onDone: (msg: string | null) => void }) {
  const { t, errorText } = useApp()
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const mismatch = confirm.length > 0 && confirm !== password
  const ok = displayName.trim() && username.trim().length >= 3 && password.length >= 6 && password === confirm

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await call('auth.signup', { username: username.trim(), displayName: displayName.trim(), password })
      setCode(r.recoveryCode)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div>
        <h2>{t('auth.signupTitle')}</h2>
        <div className="muted small">{t('auth.signupHint')}</div>
      </div>
      <Field label={t('setup.displayName')} required>
        <input className="input" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
      </Field>
      <Field label={t('auth.username')} required hint={t('err.invalid_username')}>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" maxLength={32} />
      </Field>
      <Field label={t('auth.password')} required hint={t('err.password_too_short')}>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label={t('auth.confirmPassword')} required>
        <input className={`input ${mismatch ? 'invalid' : ''}`} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Field>
      {mismatch && <Notice tone="warn">{t('auth.passwordMismatch')}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      <button className="btn primary big" disabled={busy || !ok}>
        {t('auth.signupButton')}
      </button>
      <button type="button" className="link-btn" onClick={() => onDone(null)}>
        {t('auth.backToLogin')}
      </button>
      {code && <RecoveryCodeDialog code={code} onClose={() => onDone(t('auth.signupDone'))} />}
    </form>
  )
}

function ResetForm({ onDone }: { onDone: (msg: string | null) => void }) {
  const { t, errorText } = useApp()
  const [username, setUsername] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newCode, setNewCode] = useState<string | null>(null)
  const mismatch = confirm.length > 0 && confirm !== password
  const ok = username.trim() && recoveryCode.trim().length >= 12 && password.length >= 6 && password === confirm

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await call('auth.resetWithCode', { username: username.trim(), recoveryCode, newPassword: password })
      setNewCode(r.recoveryCode)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div>
        <h2>{t('auth.resetTitle')}</h2>
        <div className="muted small">{t('auth.resetHint')}</div>
      </div>
      <Field label={t('auth.username')} required>
        <input className="input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      </Field>
      <Field label={t('auth.recoveryCode')} required>
        <input
          className="input"
          value={recoveryCode}
          placeholder="XXXX-XXXX-XXXX"
          onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
          style={{ fontFamily: 'Consolas, monospace', letterSpacing: 2 }}
          maxLength={20}
        />
      </Field>
      <Field label={t('auth.newPassword')} required hint={t('err.password_too_short')}>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label={t('auth.confirmPassword')} required>
        <input className={`input ${mismatch ? 'invalid' : ''}`} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Field>
      {mismatch && <Notice tone="warn">{t('auth.passwordMismatch')}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      <button className="btn primary big" disabled={busy || !ok}>
        {t('auth.resetButton')}
      </button>
      <button type="button" className="link-btn" onClick={() => onDone(null)}>
        {t('auth.backToLogin')}
      </button>
      {newCode && <RecoveryCodeDialog code={newCode} intro={t('auth.codeReplaced')} onClose={() => onDone(t('auth.resetDone'))} />}
    </form>
  )
}

export function DemoButton() {
  const { t, status, refreshStatus, fail } = useApp()
  const [busy, setBusy] = useState(false)
  if (!status.demoAvailable) return null
  return (
    <div className="stack" style={{ gap: 6 }}>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await call('demo.enter')
            await refreshStatus()
          } catch (e) {
            fail(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <FlaskConical size={18} />
        {busy ? t('common.loading') : t('auth.tryDemo')}
      </button>
      <div className="muted small" style={{ textAlign: 'center' }}>
        {t('setup.demoHint')} (demo / demo123)
      </div>
    </div>
  )
}
