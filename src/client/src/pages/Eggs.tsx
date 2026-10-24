import { useEffect, useMemo, useState } from 'react'
import { Egg, Save, Trash2 } from 'lucide-react'
import { timeInTimezone } from '@shared/dates'
import { EGG_SESSIONS, type EggCollection, type EggSession } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, DateBar, DayGate, Empty, NumInput, PageHeader, ReasonDialog, Seg, nz, useDay } from '../components/ui'

interface Row {
  id: number | null
  good: number | null
  damaged: number | null
  rejected: number | null
  time: string
  notes: string
  dirty: boolean
}

export function EggsPage() {
  const { t, num, workDate, status, toast, fail } = useApp()
  const { overview, writable } = useDay(workDate)
  const { data: records } = useLoad(() => call('eggs.list', { date: workDate }), [workDate])
  const [session, setSession] = useState<EggSession>(() => (Number(timeInTimezone(status.settings.timezone).slice(0, 2)) < 12 ? 'morning' : 'evening'))
  const [rows, setRows] = useState<Record<number, Row>>({})
  const [busy, setBusy] = useState(false)
  const [toDelete, setToDelete] = useState<EggCollection | null>(null)
  const cages = overview?.cages ?? []

  useEffect(() => {
    const next: Record<number, Row> = {}
    for (const c of cages) {
      const r = records?.find((x) => x.cageId === c.cageId && x.session === session)
      next[c.cageId] = r
        ? { id: r.id, good: r.good, damaged: r.damaged, rejected: r.rejected, time: r.collectedAt ?? '', notes: r.notes ?? '', dirty: false }
        : { id: null, good: null, damaged: null, rejected: null, time: '', notes: '', dirty: false }
    }
    setRows(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, session, overview?.dayId, cages.length])

  const dirty = Object.entries(rows).filter(([, r]) => r.dirty && r.good !== null)
  const upd = (cageId: number, p: Partial<Row>) => setRows((x) => ({ ...x, [cageId]: { ...x[cageId], ...p, dirty: true } }))

  const saveAll = async () => {
    setBusy(true)
    let saved = 0
    const now = timeInTimezone(status.settings.timezone)
    for (const [cageId, r] of dirty) {
      try {
        await call('eggs.save', {
          expectedId: r.id,
          date: workDate,
          cageId: Number(cageId),
          session,
          collectedAt: r.time || now,
          good: r.good ?? 0,
          damaged: r.damaged ?? 0,
          rejected: r.rejected ?? 0,
          notes: nz(r.notes)
        })
        saved++
      } catch (e) {
        fail(e)
        break
      }
    }
    setBusy(false)
    if (saved) toast('success', `${t('common.saved')} (${saved})`)
  }

  const sessionOptions = useMemo(() => {
    const expected = status.settings.expectedEggSessions
    return EGG_SESSIONS.map((s) => ({ value: s, label: t('session.' + s) + (expected.includes(s) ? '' : ' (+)') }))
  }, [status.settings.expectedEggSessions, t])

  const bySession = (cageId: number, s: EggSession) => records?.find((r) => r.cageId === cageId && r.session === s)
  const usedSessions = EGG_SESSIONS.filter((s) => status.settings.expectedEggSessions.includes(s) || records?.some((r) => r.session === s))
  const tot = overview?.totals.eggs

  return (
    <div className="page">
      <PageHeader title={t('eggs.title')} icon={<Egg size={26} color="var(--brand)" />}>
        <DateBar />
      </PageHeader>
      <div className="stack">
        <DayGate overview={overview} />
        {overview && overview.dayId !== null && (
          <>
            <div className="grid stats">
              <div className="card stat">
                <div className="stat-label">{t('eggs.collected')}</div>
                <div className="stat-value">{num(tot?.collected)}</div>
                <div className="stat-sub">{t('dash.goodDamaged', { good: num(tot?.good), damaged: num(tot?.damaged), rejected: num(tot?.rejected) })}</div>
              </div>
              <div className="card stat">
                <div className="stat-label">{t('eggs.saleable')}</div>
                <div className="stat-value">{num(tot?.saleable)}</div>
              </div>
              <div className="card stat">
                <div className="stat-label">{t('dash.production')}</div>
                <div className="stat-value">{overview.totals.productionPct === null ? '—' : num(overview.totals.productionPct, 1) + '%'}</div>
                <div className="stat-sub">{t('eggs.productionNote')}</div>
              </div>
            </div>

            {writable && (
              <Card
                title={t('eggs.entryGrid')}
                actions={
                  <button className="btn primary" disabled={busy || dirty.length === 0} onClick={saveAll}>
                    <Save size={18} />
                    {t('common.save')} {dirty.length > 0 && `(${dirty.length})`}
                  </button>
                }
              >
                <div className="row" style={{ marginBottom: 12 }}>
                  <span className="field-label">{t('eggs.session')}</span>
                  <Seg value={session} options={sessionOptions} onChange={setSession} />
                </div>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>{t('common.cage')}</th>
                        <th className="num">{t('eggs.good')}</th>
                        <th className="num">{t('eggs.damaged')}</th>
                        <th className="num">{t('eggs.rejected')}</th>
                        <th className="num">{t('common.total')}</th>
                        <th>{t('common.time')}</th>
                        <th>{t('common.notes')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cages.map((c) => {
                        const r = rows[c.cageId]
                        if (!r) return null
                        const total = (r.good ?? 0) + (r.damaged ?? 0) + (r.rejected ?? 0)
                        return (
                          <tr key={c.cageId} style={r.dirty ? { background: '#fffbea' } : undefined}>
                            <td>
                              <strong>{c.name}</strong>
                              {r.id && !r.dirty && (
                                <span className="badge good" style={{ marginLeft: 8 }}>
                                  ✓
                                </span>
                              )}
                            </td>
                            <td style={{ width: 140 }}>
                              <NumInput value={r.good} onChange={(v) => upd(c.cageId, { good: v })} ariaLabel={`${c.name} ${t('eggs.good')}`} />
                            </td>
                            <td style={{ width: 130 }}>
                              <NumInput value={r.damaged} onChange={(v) => upd(c.cageId, { damaged: v })} ariaLabel={`${c.name} ${t('eggs.damaged')}`} />
                            </td>
                            <td style={{ width: 130 }}>
                              <NumInput value={r.rejected} onChange={(v) => upd(c.cageId, { rejected: v })} ariaLabel={`${c.name} ${t('eggs.rejected')}`} />
                            </td>
                            <td className="num">{r.good === null ? '—' : num(total)}</td>
                            <td style={{ width: 120 }}>
                              <input className="input" type="time" value={r.time} onChange={(e) => upd(c.cageId, { time: e.target.value })} />
                            </td>
                            <td>
                              <input className="input" value={r.notes} maxLength={500} onChange={(e) => upd(c.cageId, { notes: e.target.value })} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            <Card title={t('eggs.dayTotals')}>
              {!records || records.length === 0 ? (
                <Empty text={t('common.noData')} />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>{t('common.cage')}</th>
                        {usedSessions.map((s) => (
                          <th key={s} className="num">
                            {t('session.' + s)}
                          </th>
                        ))}
                        <th className="num">{t('col.good')}</th>
                        <th className="num">{t('col.damaged')}</th>
                        <th className="num">{t('col.rejected')}</th>
                        <th className="num">{t('eggs.collected')}</th>
                        <th className="num">{t('col.production')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cages.map((c) => (
                        <tr key={c.cageId}>
                          <td>
                            <strong>{c.name}</strong>
                          </td>
                          {usedSessions.map((s) => {
                            const r = bySession(c.cageId, s)
                            return (
                              <td key={s} className="num nowrap">
                                {r ? (
                                  <>
                                    {num(r.good + r.damaged + r.rejected)}
                                    {writable && (
                                      <button className="icon-btn" title={t('common.delete')} onClick={() => setToDelete(r)}>
                                        <Trash2 size={14} />
                                      </button>
                                    )}
                                  </>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                            )
                          })}
                          <td className="num">{num(c.eggs.good)}</td>
                          <td className="num">{num(c.eggs.damaged)}</td>
                          <td className="num">{num(c.eggs.rejected)}</td>
                          <td className="num">
                            <strong>{num(c.eggs.collected)}</strong>
                          </td>
                          <td className="num">{c.productionPct === null ? '—' : num(c.productionPct, 1) + '%'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
      {toDelete && (
        <ReasonDialog
          title={t('common.deleteTitle')}
          hint={`${toDelete.cageName} — ${t('session.' + toDelete.session)}: ${toDelete.good + toDelete.damaged + toDelete.rejected}. ${t('common.deleteHint')}`}
          danger
          confirmLabel={t('common.delete')}
          onClose={() => setToDelete(null)}
          onSubmit={(reason) => call('eggs.delete', { id: toDelete.id, reason })}
        />
      )}
    </div>
  )
}
