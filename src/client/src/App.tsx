import { useEffect, useMemo, useRef, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  Bell,
  Bird,
  BookOpen,
  Boxes,
  CalendarCheck,
  ChartColumn,
  ChevronsLeft,
  ChevronsRight,
  DatabaseBackup,
  Droplets,
  Egg,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Pill,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Truck,
  TrendingDown,
  Warehouse,
  Wheat,
  PackagePlus,
  type LucideIcon
} from 'lucide-react'
import type { AppStatus, Duty, Language } from '@shared/types'
import { translate } from '@shared/i18n'
import { call } from './lib/api'
import { AppProvider, useApp, useLoad } from './lib/app'
import { ConfirmDialog } from './components/ui'
import { LoginPage } from './pages/Login'
import { SetupPage } from './pages/Setup'
import { DashboardPage } from './pages/Dashboard'
import { DailyPage } from './pages/Daily'
import { EggsPage } from './pages/Eggs'
import { FeedPage } from './pages/Feed'
import { WaterPage } from './pages/Water'
import { MedicinePage } from './pages/Medicine'
import { MortalityPage } from './pages/Mortality'
import { CagesPage } from './pages/Cages'
import { ReportsPage } from './pages/Reports'
import { InventoryPage } from './pages/Inventory'
import { SettingsPage } from './pages/Settings'
import { BackupPage } from './pages/Backup'
import { PurchasesPage } from './pages/Purchases'
import { SalesPage } from './pages/Sales'
import { FlowPage } from './pages/Flow'
import { AdminPage } from './pages/Admin'

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    call('app.status')
      .then(setStatus)
      .catch((e) => setError(String(e?.code ?? e)))
  }, [])
  if (error) return <div className="page">Error: {error}</div>
  if (!status) return <div className="page muted">{translate('si', 'app.loading')} / Loading…</div>
  return (
    <AppProvider initial={status}>
      <Gate />
    </AppProvider>
  )
}

function Gate() {
  const { status } = useApp()
  if (!status.setupComplete) return <SetupPage />
  if (!status.user) return <LoginPage />
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  )
}

interface NavItem {
  to: string
  key: string
  icon: LucideIcon
  /** Hidden for users without this duty */
  duty?: Duty
  adminOnly?: boolean
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'navg.overview',
    items: [
      { to: '/', key: 'nav.dashboard', icon: LayoutDashboard },
      { to: '/flow', key: 'nav.flow', icon: GitBranch }
    ]
  },
  {
    group: 'navg.daily',
    items: [
      { to: '/daily', key: 'nav.daily', icon: CalendarCheck },
      { to: '/eggs', key: 'nav.eggs', icon: Egg, duty: 'eggs' },
      { to: '/feed', key: 'nav.feed', icon: Wheat, duty: 'feed' },
      { to: '/water', key: 'nav.water', icon: Droplets, duty: 'water' },
      { to: '/mortality', key: 'nav.mortality', icon: TrendingDown, duty: 'flock' },
      { to: '/medicine', key: 'nav.medicine', icon: Pill, duty: 'medicine' }
    ]
  },
  {
    group: 'navg.stores',
    items: [
      { to: '/purchases', key: 'nav.purchases', icon: PackagePlus, duty: 'purchases' },
      { to: '/inventory', key: 'nav.inventory', icon: Boxes, duty: 'inventory' },
      { to: '/sales', key: 'nav.sales', icon: Truck, duty: 'sales' }
    ]
  },
  {
    group: 'navg.farm',
    items: [
      { to: '/cages', key: 'nav.cages', icon: Warehouse },
      { to: '/reports', key: 'nav.reports', icon: ChartColumn, duty: 'reports' }
    ]
  },
  {
    group: 'navg.system',
    items: [
      { to: '/admin', key: 'nav.admin', icon: ShieldCheck, adminOnly: true },
      { to: '/settings', key: 'nav.settings', icon: Settings },
      { to: '/backup', key: 'nav.backup', icon: DatabaseBackup, duty: 'backup' }
    ]
  }
]

/** Quick actions offered by the "New" menu and the search box (only those the user may do). */
const QUICK: { to: string; key: string; icon: LucideIcon; duty?: Duty }[] = [
  { to: '/eggs', key: 'quick.eggs', icon: Egg, duty: 'eggs' },
  { to: '/mortality?new=1', key: 'quick.death', icon: TrendingDown, duty: 'flock' },
  { to: '/feed', key: 'quick.feed', icon: Wheat, duty: 'feed' },
  { to: '/purchases?new=1', key: 'quick.receipt', icon: PackagePlus, duty: 'purchases' },
  { to: '/sales?new=1', key: 'quick.dispatch', icon: Truck, duty: 'sales' }
]

function useVisibleNav() {
  const { status, isAdmin } = useApp()
  const duties = status.user?.duties
  const can = (i: { duty?: Duty; adminOnly?: boolean }) => (i.adminOnly ? isAdmin : !i.duty || isAdmin || !duties || duties.includes(i.duty))
  return {
    groups: NAV.map((g) => ({ ...g, items: g.items.filter(can) })).filter((g) => g.items.length),
    quick: QUICK.filter(can)
  }
}

export function LanguageSwitch({ dark }: { dark?: boolean }) {
  const { lang, setLanguage, fail } = useApp()
  const opts: { v: Language; label: string }[] = [
    { v: 'si', label: 'සිංහල' },
    { v: 'en', label: 'English' }
  ]
  return (
    <div className="lang-switch" style={dark ? undefined : { background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      {opts.map((o) => (
        <button key={o.v} className={lang === o.v ? 'on' : ''} style={dark || lang === o.v ? undefined : { color: 'var(--text-2)' }} onClick={() => setLanguage(o.v).catch(fail)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function readPref(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function Shell() {
  const { t, lang, status, refreshStatus, fail, toast } = useApp()
  const [confirmReset, setConfirmReset] = useState(false)
  const [collapsed, setCollapsed] = useState(() => readPref('pfm.navCollapsed', false))
  const [palette, setPalette] = useState(false)
  const { groups } = useVisibleNav()
  const user = status.user!

  useEffect(() => {
    try {
      localStorage.setItem('pfm.navCollapsed', collapsed ? '1' : '0')
    } catch {
      /* preference only */
    }
  }, [collapsed])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(true)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const logout = async () => {
    await call('auth.logout').catch(fail)
    await refreshStatus()
  }

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <Bird size={22} />
          </div>
          <div className="brand-text">
            {t('app.name')}
            <small>{status.settings.farmName}</small>
          </div>
        </div>
        <nav className="nav" aria-label={t('app.name')}>
          {groups.map((g) => (
            <div key={g.group} className="nav-group">
              <div className="nav-group-label">{t(g.group)}</div>
              {g.items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === '/'} title={t(n.key)}>
                  <n.icon size={19} />
                  <span>{t(n.key)}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <LanguageSwitch dark />
          <a className="side-btn" href={`/manuals/manual-${lang}.pdf`} target="_blank" rel="noopener" title={t('nav.help')}>
            <BookOpen size={18} />
            <span>{t('nav.help')}</span>
          </a>
          <button className="side-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? t('nav.expand') : t('nav.collapse')}>
            {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
            <span>{t('nav.collapse')}</span>
          </button>
          <div className="side-version">{t('app.version', { version: status.version })}</div>
        </div>
      </aside>
      <main className="main">
        {status.isDemo && (
          <div className="demo-banner">
            <span>{t('app.demoBanner')}</span>
            <span className="spacer" />
            <button onClick={() => setConfirmReset(true)}>{t('app.resetDemo')}</button>
            <button
              onClick={async () => {
                await call('demo.exit').catch(fail)
                await refreshStatus()
              }}
            >
              {t('app.exitDemo')}
            </button>
          </div>
        )}
        <TopBar onSearch={() => setPalette(true)} onLogout={logout} userName={user.displayName} role={user.role} />
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/flow" element={<FlowPage />} />
          <Route path="/daily" element={<DailyPage />} />
          <Route path="/eggs" element={<EggsPage />} />
          <Route path="/feed" element={<FeedPage />} />
          <Route path="/water" element={<WaterPage />} />
          <Route path="/medicine" element={<MedicinePage />} />
          <Route path="/mortality" element={<MortalityPage />} />
          <Route path="/purchases" element={<PurchasesPage />} />
          <Route path="/sales" element={<SalesPage />} />
          <Route path="/cages" element={<CagesPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/backup" element={<BackupPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {confirmReset && (
        <ConfirmDialog
          title={t('app.resetDemo')}
          body={t('setup.demoHint')}
          danger
          onClose={() => setConfirmReset(false)}
          onConfirm={async () => {
            await call('demo.reset')
            await refreshStatus()
            toast('success', t('common.saved'))
          }}
        />
      )}
    </div>
  )
}

function TopBar({ onSearch, onLogout, userName, role }: { onSearch: () => void; onLogout: () => void; userName: string; role: string }) {
  const { t, status } = useApp()
  const nav = useNavigate()
  const { quick } = useVisibleNav()
  const [menu, setMenu] = useState<'new' | 'alerts' | 'user' | null>(null)
  const { data: dash } = useLoad(() => call('analytics.dashboard', { date: status.today }), [status.today])
  const alerts = (dash?.alerts ?? []).filter((a) => a.severity !== 'info' || a.code === 'pending_signups')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(null)
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [menu])

  const initials = userName
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <header className="topbar no-print" ref={ref}>
      <button className="search-trigger" onClick={onSearch}>
        <Search size={17} />
        <span>{t('top.search')}</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="grow" />
      {quick.length > 0 && (
        <div className="menu-anchor">
          <button className="btn primary sm-h" onClick={() => setMenu(menu === 'new' ? null : 'new')} aria-expanded={menu === 'new'}>
            <Plus size={18} /> {t('top.new')}
          </button>
          {menu === 'new' && (
            <div className="menu" role="menu">
              {quick.map((q) => (
                <button
                  key={q.key}
                  role="menuitem"
                  onClick={() => {
                    setMenu(null)
                    nav(q.to)
                  }}
                >
                  <q.icon size={17} /> {t(q.key)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="menu-anchor">
        <button className="icon-btn bell" onClick={() => setMenu(menu === 'alerts' ? null : 'alerts')} aria-label={t('dash.alerts')} title={t('dash.alerts')}>
          <Bell size={20} />
          {alerts.length > 0 && <span className="bell-count">{alerts.length > 9 ? '9+' : alerts.length}</span>}
        </button>
        {menu === 'alerts' && (
          <div className="menu wide" role="menu">
            <div className="menu-title">{t('dash.alerts')}</div>
            {alerts.length === 0 ? (
              <div className="menu-empty">{t('dash.noAlerts')}</div>
            ) : (
              alerts.slice(0, 12).map((a, i) => (
                <button
                  key={i}
                  className={`alert-row ${a.severity}`}
                  onClick={() => {
                    setMenu(null)
                    nav(a.code === 'pending_signups' ? '/admin' : a.code.includes('stock') || a.code.startsWith('medicine') ? '/inventory' : a.code === 'backup_failed' ? '/backup' : '/')
                  }}
                >
                  <i />
                  {t('alert.' + a.code, a.params)}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <div className="menu-anchor">
        <button className="user-chip" onClick={() => setMenu(menu === 'user' ? null : 'user')} aria-expanded={menu === 'user'}>
          <span className="avatar">{initials}</span>
          <span className="user-chip-text">
            <strong>{userName}</strong>
            <small>{t('auth.role.' + role)}</small>
          </span>
        </button>
        {menu === 'user' && (
          <div className="menu" role="menu">
            <button
              onClick={() => {
                setMenu(null)
                nav('/settings')
              }}
            >
              <Settings size={17} /> {t('auth.changePassword')}
            </button>
            <button onClick={onLogout}>
              <LogOut size={17} /> {t('nav.logout')}
            </button>
          </div>
        )}
      </div>
    </header>
  )
}

/** Ctrl+K: type part of a page or action name and press Enter to go there. */
function CommandPalette({ onClose }: { onClose: () => void }) {
  const { t } = useApp()
  const nav = useNavigate()
  const loc = useLocation()
  const { groups, quick } = useVisibleNav()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const entries = useMemo(() => {
    const pages = groups.flatMap((g) => g.items.map((i) => ({ to: i.to, label: t(i.key), hint: t(g.group), icon: i.icon })))
    const actions = quick.map((a) => ({ to: a.to, label: t(a.key), hint: t('top.new'), icon: a.icon }))
    const all = [...actions, ...pages]
    const needle = q.trim().toLowerCase()
    return needle ? all.filter((e) => e.label.toLowerCase().includes(needle) || e.hint.toLowerCase().includes(needle)) : all
  }, [q, groups, quick, t])
  useEffect(() => setActive(0), [q])
  const go = (to: string) => {
    onClose()
    if (to !== loc.pathname) nav(to)
  }
  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('top.search')}>
        <div className="palette-input">
          <Search size={18} />
          <input
            autoFocus
            value={q}
            placeholder={t('top.searchPlaceholder')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, entries.length - 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              }
              if (e.key === 'Enter' && entries[active]) go(entries[active].to)
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" role="listbox">
          {entries.length === 0 && <div className="menu-empty">{t('common.noData')}</div>}
          {entries.map((e, i) => (
            <button key={e.to + e.label} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onMouseEnter={() => setActive(i)} onClick={() => go(e.to)}>
              <e.icon size={18} />
              <span className="grow">{e.label}</span>
              <small>{e.hint}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
