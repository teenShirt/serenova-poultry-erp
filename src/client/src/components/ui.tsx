import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Info, Inbox, Lock, X, XCircle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { addDays } from '@shared/dates'
import type { Cage, DayOverview, DayStatus } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'

export function PageHeader({ title, icon, children }: { title: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1 className="row" style={{ gap: 10 }}>
        {icon}
        {title}
      </h1>
      {children}
    </div>
  )
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : <div className="grow">{title}</div>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stat({ icon, label, value, sub, tone }: { icon?: ReactNode; label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'bad' }) {
  return (
    <div className={`card stat ${tone ?? ''}`}>
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Field({ label, hint, children, required }: { label: string; hint?: ReactNode; children: ReactNode; required?: boolean }) {
  return (
    <div className="field">
      <label>
        {label}
        {required && <span style={{ color: 'var(--bad)' }}> *</span>}
      </label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

/** Numeric input that keeps "empty" distinct from 0 (null means not entered). */
export function NumInput({
  value,
  onChange,
  decimals = false,
  allowNegative = false,
  big = false,
  placeholder,
  disabled,
  autoFocus,
  invalid,
  ariaLabel
}: {
  value: number | null
  onChange: (v: number | null) => void
  decimals?: boolean
  allowNegative?: boolean
  big?: boolean
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  invalid?: boolean
  ariaLabel?: string
}) {
  const [text, setText] = useState(value === null ? '' : String(value))
  useEffect(() => {
    const parsed = text.trim() === '' ? null : Number(text)
    if (parsed !== value) setText(value === null ? '' : String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const pattern = decimals ? (allowNegative ? /^-?\d*\.?\d*$/ : /^\d*\.?\d*$/) : allowNegative ? /^-?\d*$/ : /^\d*$/
  return (
    <input
      className={`input num ${big ? 'big' : ''} ${invalid ? 'invalid' : ''}`}
      inputMode={decimals ? 'decimal' : 'numeric'}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const v = e.target.value.replace(',', '.')
        if (!pattern.test(v)) return
        setText(v)
        if (v === '' || v === '-' || v === '.') onChange(null)
        else onChange(Number(v))
      }}
    />
  )
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Asks for a mandatory reason (≥ 3 characters) before running an action. */
export function ReasonDialog({
  title,
  hint,
  confirmLabel,
  danger,
  minLength = 3,
  onSubmit,
  onClose,
  children
}: {
  title: string
  hint?: ReactNode
  confirmLabel?: string
  danger?: boolean
  minLength?: number
  onSubmit: (reason: string) => Promise<void> | void
  onClose: () => void
  children?: ReactNode
}) {
  const { t, fail } = useApp()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = reason.trim().length >= minLength
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    try {
      await onSubmit(reason.trim())
      onClose()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={!ok || busy} onClick={submit}>
            {confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      <div className="stack">
        {hint && <Notice tone="info">{hint}</Notice>}
        {children}
        <Field label={t('common.reason')} required hint={t('common.reasonRequired')}>
          <textarea className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const { t, fail } = useApp()
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            disabled={busy}
            autoFocus
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                onClose()
              } catch (e) {
                fail(e)
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      {body}
    </Modal>
  )
}

export function Notice({ tone, children }: { tone: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode }) {
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : Info
  return (
    <div className={`notice ${tone}`}>
      <Icon size={18} />
      <div className="grow">{children}</div>
    </div>
  )
}

export function Empty({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={40} />
      <div>{text}</div>
      {children && <div className="mt">{children}</div>}
    </div>
  )
}

export function StatusBadge({ status, amending }: { status: DayStatus; amending?: boolean }) {
  const { t } = useApp()
  if (amending) return <span className="badge warn">{t('status.amending')}</span>
  const tone = status === 'closed' ? 'good' : status === 'ready_to_close' ? 'info' : status === 'in_progress' ? 'warn' : ''
  return (
    <span className={`badge ${tone}`}>
      {status === 'closed' && <Lock size={12} />}
      {t('status.' + status)}
    </span>
  )
}

export function DateBar() {
  const { workDate, setWorkDate, status, t } = useApp()
  return (
    <div className="datebar no-print">
      <button className="icon-btn" title={t('common.yesterday')} onClick={() => setWorkDate(addDays(workDate, -1))}>
        <ChevronLeft size={20} />
      </button>
      <CalendarDays size={18} color="var(--brand)" />
      <input type="date" value={workDate} max={status.today} onChange={(e) => e.target.value && setWorkDate(e.target.value)} aria-label={t('common.date')} />
      <button className="icon-btn" title={t('common.nextDay')} disabled={workDate >= status.today} onClick={() => setWorkDate(addDays(workDate, 1))}>
        <ChevronRight size={20} />
      </button>
      {workDate !== status.today && (
        <button className="btn sm" onClick={() => setWorkDate(status.today)}>
          {t('common.today')}
        </button>
      )}
    </div>
  )
}

export function useCages(includeInactive = false) {
  return useLoad(() => call('cages.list', { includeInactive }), [includeInactive])
}

export function CageSelect({ cages, value, onChange, allowAll, allowFarm }: { cages: Pick<Cage, 'id' | 'name'>[]; value: number | null; onChange: (id: number | null) => void; allowAll?: boolean; allowFarm?: boolean }) {
  const { t } = useApp()
  return (
    <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} style={{ width: 'auto', minWidth: 170 }}>
      {allowAll && <option value="">{t('common.allCages')}</option>}
      {allowFarm && <option value="">{t('med.wholeFarm')}</option>}
      {!allowAll && !allowFarm && value === null && <option value="">—</option>}
      {cages.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  )
}

/** Loads the day for the working date and reports whether its records can be edited. */
export function useDay(date: string) {
  const { isAdmin } = useApp()
  const r = useLoad(() => call('days.overview', { date }), [date])
  const ov = r.data
  const writable = !!ov && ov.dayId !== null && (ov.status !== 'closed' || (ov.amendmentOpen && isAdmin))
  return { ...r, overview: ov, writable }
}

/** Explains why the day cannot be edited (not started / closed) or that an amendment is open. */
export function DayGate({ overview }: { overview: DayOverview | undefined }) {
  const { t } = useApp()
  const nav = useNavigate()
  if (!overview) return null
  if (overview.dayId === null) {
    return (
      <Notice tone="warn">
        <div className="row">
          <span className="grow">{t('common.dayNotStarted')}</span>
          <button className="btn sm" onClick={() => nav('/daily')}>
            {t('common.goToDaily')}
          </button>
        </div>
      </Notice>
    )
  }
  if (overview.status === 'closed' && overview.amendmentOpen) return <Notice tone="warn">{t('common.amending')}</Notice>
  if (overview.status === 'closed') return <Notice tone="info">{t('common.dayClosed')}</Notice>
  return null
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((x) => (
        <button key={x.value} role="tab" aria-selected={x.value === value} className={x.value === value ? 'on' : ''} onClick={() => onChange(x.value)}>
          {x.label}
        </button>
      ))}
    </div>
  )
}

export const nz = (s: string) => (s.trim() === '' ? null : s.trim())

/**
 * Shows a recovery code once. The dialog cannot be dismissed until the user confirms
 * they have written it down, because the code is never shown again.
 */
export function RecoveryCodeDialog({ code, title, intro, onClose }: { code: string; title?: string; intro?: ReactNode; onClose: () => void }) {
  const { t } = useApp()
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <div className="overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title ?? t('auth.yourCode')}>
        <div className="modal-head">
          <h2>{title ?? t('auth.yourCode')}</h2>
        </div>
        <div className="modal-body stack">
          {intro && <Notice tone="info">{intro}</Notice>}
          <div className="recovery-code" aria-label={t('auth.recoveryCode')}>
            {code}
          </div>
          <Notice tone="warn">{t('auth.codeHint')}</Notice>
          <div className="row">
            <button
              className="btn"
              onClick={() =>
                navigator.clipboard
                  .writeText(code)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }
            >
              {copied ? t('auth.copied') : t('auth.copy')}
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            {t('auth.codeSaved')}
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn primary" disabled={!saved} onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
