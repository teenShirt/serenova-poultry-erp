import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatDate, formatDateTime, formatNumber, translate, type Params } from '@shared/i18n'
import type { AppStatus, Language } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type { Module } from '@shared/platform'
import { ApiError, call, onDataChanged } from './api'

interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  text: string
}

interface AppCtx {
  status: AppStatus
  lang: Language
  t: (key: string, params?: Params) => string
  num: (n: number | null | undefined, digits?: number) => string
  date: (iso: string, opts?: Intl.DateTimeFormatOptions) => string
  dateTime: (iso: string | null) => string
  refreshStatus: () => Promise<void>
  setLanguage: (l: Language) => Promise<void>
  /** Working business date shared by all data-entry screens */
  workDate: string
  setWorkDate: (d: string) => void
  toast: (kind: Toast['kind'], text: string) => void
  /** Translates any thrown error into a readable message and shows it */
  fail: (e: unknown) => void
  errorText: (e: unknown) => string
  isAdmin: boolean
  /** Whether the signed-in user's role allows this (the server checks it again on every request) */
  can: (p: Permission) => boolean
  /** Whether the organization's plan includes this module (the server checks it again) */
  hasModule: (m: Module) => boolean
  dataVersion: number
}

const Ctx = createContext<AppCtx | null>(null)

function readLang(): Language | null {
  try {
    const v = localStorage.getItem('pfm.lang')
    return v === 'en' || v === 'si' ? v : null
  } catch {
    return null
  }
}

export function useApp() {
  const c = useContext(Ctx)
  if (!c) throw new Error('AppProvider missing')
  return c
}

export function AppProvider({ initial, children }: { initial: AppStatus; children: ReactNode }) {
  const [status, setStatus] = useState(initial)
  const [workDate, setWorkDate] = useState(initial.today)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dataVersion, setDataVersion] = useState(0)
  const seq = useRef(0)
  // Before signing in, the language is this browser's choice: the farm-wide setting can only be
  // changed by a signed-in user (or during first-run setup).
  const [browserLang, setBrowserLang] = useState<Language | null>(readLang)
  const lang = status.user || !status.setupComplete ? status.settings.language : (browserLang ?? status.settings.language)

  useEffect(() => onDataChanged(() => setDataVersion((v) => v + 1)), [])
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const refreshStatus = useCallback(async () => {
    setStatus(await call('app.status'))
  }, [])

  const t = useCallback((key: string, params?: Params) => translate(lang, key, params), [lang])

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++seq.current
    setToasts((x) => [...x, { id, kind, text }])
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), kind === 'error' ? 8000 : 4500)
  }, [])

  const errorText = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        const params = { ...e.params }
        if (typeof params.session === 'string') params.session = translate(lang, 'session.' + params.session)
        if (typeof params.field === 'string' && !params.field) params.field = '—'
        if (e.code === 'subscription_read_only' && typeof params.status === 'string') params.status = translate(lang, 'sub.status.' + params.status)
        const key = 'err.' + e.code
        const msg = translate(lang, key, params)
        return msg === key ? translate(lang, 'err.unknown', { message: e.code }) : msg
      }
      return translate(lang, 'err.unknown', { message: (e as Error)?.message ?? String(e) })
    },
    [lang]
  )

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.code === 'not_logged_in') void refreshStatus()
      toast('error', errorText(e))
    },
    [errorText, toast, refreshStatus]
  )

  const value = useMemo<AppCtx>(
    () => ({
      status,
      lang,
      t,
      num: (n, d = 0) => formatNumber(lang, n, d),
      date: (iso, opts) => formatDate(lang, iso, opts),
      dateTime: (iso) => formatDateTime(lang, iso, status.settings.timezone),
      refreshStatus,
      setLanguage: async (l) => {
        setBrowserLang(l)
        try {
          localStorage.setItem('pfm.lang', l)
        } catch {
          /* preference only */
        }
        if (status.user || !status.setupComplete) {
          await call('app.setLanguage', { language: l })
          await refreshStatus()
        }
      },
      workDate,
      setWorkDate,
      toast,
      fail,
      errorText,
      isAdmin: status.user?.role === 'admin',
      can: (p) => !!status.user?.permissions.includes(p),
      hasModule: (m) => !status.subscription || status.subscription.modules.includes(m),
      dataVersion
    }),
    [status, lang, t, refreshStatus, workDate, toast, fail, errorText, dataVersion]
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast toast-${x.kind}`} onClick={() => setToasts((all) => all.filter((y) => y.id !== x.id))}>
            {x.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

/** Loads data with the given loader and reloads whenever its deps or any saved data change. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; reload: () => void; error: unknown } {
  const { dataVersion } = useApp()
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    loader()
      .then((d) => {
        if (alive) {
          setData(d)
          setError(null)
        }
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, dataVersion, tick])
  return { data, loading, reload: () => setTick((x) => x + 1), error }
}
