import { useState } from 'react'
import { ChartColumn, FileSpreadsheet, FileText, History, Printer } from 'lucide-react'
import type { ReportKind, ReportSpec } from '@shared/api'
import { addDays, monthBounds, startOfWeek } from '@shared/dates'
import { call, download, excelReportUrl, printHtml } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, PageHeader, Tabs } from '../components/ui'
import { CageBars, SERIES, TimeChart } from '../components/charts'
import { ReportPreview } from '../components/ReportPreview'

export function ReportsPage() {
  const { t, isAdmin } = useApp()
  const [tab, setTab] = useState<'reports' | 'analytics' | 'audit'>('reports')
  return (
    <div className="page">
      <PageHeader title={t('rep.title')} icon={<ChartColumn size={26} color="var(--brand)" />} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'reports', label: t('rep.daily') + ' / ' + t('rep.period') },
          { value: 'analytics', label: t('rep.compare') },
          ...(isAdmin ? [{ value: 'audit' as const, label: t('rep.audit') }] : [])
        ]}
      />
      {tab === 'reports' && <ReportsTab />}
      {tab === 'analytics' && <AnalyticsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  )
}

function usePresets() {
  const { status, t } = useApp()
  const today = status.today
  const thisWeek = startOfWeek(today)
  const thisMonth = monthBounds(today)
  const lastMonth = monthBounds(addDays(thisMonth.from, -1))
  return [
    { label: t('rep.thisWeek'), from: thisWeek, to: today },
    { label: t('rep.lastWeek'), from: addDays(thisWeek, -7), to: addDays(thisWeek, -1) },
    { label: t('rep.thisMonth'), from: thisMonth.from, to: today },
    { label: t('rep.lastMonth'), from: lastMonth.from, to: lastMonth.to },
    { label: t('common.last30'), from: addDays(today, -29), to: today }
  ]
}

function ReportsTab() {
  const { t, workDate, status, toast, fail, dateTime } = useApp()
  const [day, setDay] = useState(workDate)
  const presets = usePresets()
  const [from, setFrom] = useState(presets[0].from)
  const [to, setTo] = useState(presets[0].to)
  const { data: recent, reload } = useLoad(() => call('reports.recent'), [])
  const [preview, setPreview] = useState<ReportSpec | null>(null)
  // PDF: the browser's print dialog, where "Save as PDF" is one of the printers.
  const pdf = async (spec: ReportSpec) => {
    try {
      const r = await call('reports.print', spec)
      toast('info', t('rep.pdfHint'))
      await printHtml(r.html, r.title)
      reload()
    } catch (e) {
      fail(e)
    }
  }
  const excel = (spec: ReportSpec) => {
    download(excelReportUrl(spec))
    setTimeout(reload, 1500)
  }
  const specOf = (r: { kind: ReportKind; periodStart: string; periodEnd: string }): ReportSpec =>
    r.kind === 'period' ? { kind: 'period', from: r.periodStart, to: r.periodEnd } : { kind: r.kind, date: r.periodStart }
  return (
    <div className="stack">
      <div className="grid cols-2">
        <Card title={t('rep.daily')}>
          <div className="stack">
            <Field label={t('common.date')}>
              <input className="input" type="date" value={day} max={status.today} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 220 }} />
            </Field>
            <div className="row">
              <span className="field-label" style={{ minWidth: 170 }}>
                {t('day.openReport')}
              </span>
              <button className="btn primary" onClick={() => setPreview({ kind: 'day_open', date: day })}>
                <Printer size={18} /> {t('rep.print')}
              </button>
              <button className="btn" onClick={() => pdf({ kind: 'day_open', date: day })}>
                <FileText size={18} /> PDF
              </button>
              <button className="btn" onClick={() => excel({ kind: 'day_open', date: day })}>
                <FileSpreadsheet size={18} /> Excel
              </button>
            </div>
            <div className="row">
              <span className="field-label" style={{ minWidth: 170 }}>
                {t('day.closeReport')}
              </span>
              <button className="btn primary" onClick={() => setPreview({ kind: 'day_close', date: day })}>
                <Printer size={18} /> {t('rep.print')}
              </button>
              <button className="btn" onClick={() => pdf({ kind: 'day_close', date: day })}>
                <FileText size={18} /> PDF
              </button>
              <button className="btn" onClick={() => excel({ kind: 'day_close', date: day })}>
                <FileSpreadsheet size={18} /> Excel
              </button>
            </div>
          </div>
        </Card>
        <Card title={t('rep.period')}>
          <div className="stack">
            <div className="row">
              {presets.map((p) => (
                <button
                  key={p.label}
                  className={`btn sm ${p.from === from && p.to === to ? 'primary' : ''}`}
                  onClick={() => {
                    setFrom(p.from)
                    setTo(p.to)
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="row">
              <Field label={t('common.from')}>
                <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label={t('common.to')}>
                <input className="input" type="date" value={to} min={from} max={status.today} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </div>
            <div className="row">
              <button className="btn primary" onClick={() => setPreview({ kind: 'period', from, to })}>
                <Printer size={18} /> {t('rep.preview')}
              </button>
              <button className="btn" onClick={() => pdf({ kind: 'period', from, to })}>
                <FileText size={18} /> {t('rep.pdf')}
              </button>
              <button className="btn" onClick={() => excel({ kind: 'period', from, to })}>
                <FileSpreadsheet size={18} /> {t('rep.excel')}
              </button>
            </div>
          </div>
        </Card>
      </div>
      {preview && (
        <ReportPreview
          spec={preview}
          onClose={() => {
            setPreview(null)
            reload()
          }}
        />
      )}
      <Card title={t('rep.recent')}>
        {!recent || recent.length === 0 ? (
          <Empty text={t('common.noData')} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td>{r.kind === 'day_open' ? t('day.openReport') : r.kind === 'day_close' ? t('day.closeReport') : t('rep.period')}</td>
                    <td className="nowrap">{r.periodStart === r.periodEnd ? r.periodStart : `${r.periodStart} – ${r.periodEnd}`}</td>
                    <td>{r.format.toUpperCase()}</td>
                    <td className="nowrap">{dateTime(r.generatedAt)}</td>
                    <td>
                      <button className="btn sm" onClick={() => (r.format === 'pdf' ? pdf(specOf(r)) : excel(specOf(r)))}>
                        {r.format === 'pdf' ? <Printer size={14} /> : <FileSpreadsheet size={14} />} {t('common.open')}
                      </button>
                    </td>
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

function AnalyticsTab() {
  const { t, num, status } = useApp()
  const presets = usePresets()
  const [from, setFrom] = useState(presets[4].from)
  const [to, setTo] = useState(status.today)
  const { data: cmp } = useLoad(() => call('analytics.comparison', { from, to }), [from, to])
  const { data: series } = useLoad(() => call('analytics.series', { from, to }), [from, to])
  return (
    <div className="stack">
      <div className="row">
        {presets.map((p) => (
          <button
            key={p.label}
            className={`btn sm ${p.from === from && p.to === to ? 'primary' : ''}`}
            onClick={() => {
              setFrom(p.from)
              setTo(p.to)
            }}
          >
            {p.label}
          </button>
        ))}
        <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ width: 170 }} />
        <input className="input" type="date" value={to} min={from} max={status.today} onChange={(e) => setTo(e.target.value)} style={{ width: 170 }} />
      </div>
      <Card title={t('rep.compare')}>
        {!cmp || cmp.length === 0 ? (
          <Empty text={t('common.noData')} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.cage')}</th>
                  <th className="num">{t('col.eggs')}</th>
                  <th className="num">{t('col.good')}</th>
                  <th className="num">{t('col.damaged')}</th>
                  <th className="num">{t('col.rejected')}</th>
                  <th className="num">{t('rep.avgProduction')}</th>
                  <th className="num">{t('col.feed')}</th>
                  <th className="num">{t('col.water')}</th>
                  <th className="num">{t('col.deaths')}</th>
                  <th className="num">{t('flock.cumulative')} %</th>
                  <th className="num">{t('col.closing')}</th>
                </tr>
              </thead>
              <tbody>
                {cmp.map((c) => (
                  <tr key={c.cageId}>
                    <td>
                      <strong>{c.name}</strong>
                    </td>
                    <td className="num">{num(c.eggs)}</td>
                    <td className="num">{num(c.good)}</td>
                    <td className="num">{num(c.damaged)}</td>
                    <td className="num">{num(c.rejected)}</td>
                    <td className="num">{c.avgProductionPct === null ? '—' : num(c.avgProductionPct, 1) + '%'}</td>
                    <td className="num">{num(c.feedKg, 1)}</td>
                    <td className="num">{num(c.waterLitres)}</td>
                    <td className="num">{num(c.deaths)}</td>
                    <td className="num">{c.mortalityPct === null ? '—' : num(c.mortalityPct, 2)}</td>
                    <td className="num">{num(c.closingHens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid cols-2">
        <CageBars title={`${t('rep.avgProduction')} %`} data={(cmp ?? [])} valueKey="avgProductionPct" label={t('rep.avgProduction')} unit="%" digits={1} />
        <CageBars title={t('chart.cageEggs')} data={(cmp ?? [])} valueKey="eggs" label={t('col.eggs')} />
        <TimeChart title={t('chart.production')} data={series ?? []} series={[{ key: 'productionPct', label: t('chart.production'), color: SERIES.blue }]} unit="%" digits={1} />
        <TimeChart title={t('chart.feedPerHen')} data={series ?? []} series={[{ key: 'feedPerHenG', label: t('chart.feedPerHen'), color: SERIES.aqua }]} unit="g" digits={1} />
      </div>
    </div>
  )
}

export function AuditTab() {
  const { t, dateTime } = useApp()
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const { data } = useLoad(() => call('audit.list', { search: q || undefined, limit: 1000 }), [q])
  return (
    <Card
      title={
        <h2 className="row">
          <History size={20} /> {t('rep.audit')}
        </h2>
      }
      actions={
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            setQ(search)
          }}
        >
          <input className="input" placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
          <button className="btn">{t('common.search')}</button>
        </form>
      }
    >
      {!data || data.length === 0 ? (
        <Empty text={t('common.noData')} />
      ) : (
        <div className="table-wrap" style={{ maxHeight: 640, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>{t('common.time')}</th>
                <th>{t('common.recordedBy')}</th>
                <th>{t('rep.auditAction')}</th>
                <th>{t('rep.auditEntity')}</th>
                <th>{t('common.date')}</th>
                <th>{t('common.reason')}</th>
                <th>{t('rep.auditDetails')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{dateTime(a.at)}</td>
                  <td>{a.username}</td>
                  <td>{a.action}</td>
                  <td>
                    {a.entity}
                    {a.entityId ? ` #${a.entityId}` : ''}
                  </td>
                  <td className="nowrap">{a.date}</td>
                  <td>{a.reason}</td>
                  <td className="small muted" style={{ maxWidth: 420, wordBreak: 'break-word' }}>
                    {a.details && a.details.length > 300 ? a.details.slice(0, 300) + '…' : a.details}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
