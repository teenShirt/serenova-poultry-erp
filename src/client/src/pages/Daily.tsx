import { useEffect, useState } from 'react'
import { CalendarCheck, CheckCircle2, Lock, Pencil, PlayCircle, Printer, ShieldCheck, Unlock } from 'lucide-react'
import type { ReportSpec } from '@shared/api'
import { ReportPreview } from '../components/ReportPreview'
import { addDays } from '@shared/dates'
import type { DayIssue, DayOverview, StartDayPreview } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, ConfirmDialog, DateBar, Empty, Field, Modal, Notice, NumInput, ReasonDialog, StatusBadge, useDay } from '../components/ui'

export function DailyPage() {
  const { t, workDate } = useApp()
  const { overview, reload } = useDay(workDate)
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="row" style={{ gap: 10 }}>
          <CalendarCheck size={26} color="var(--brand)" />
          {t('day.title')}
        </h1>
        {overview && <StatusBadge status={overview.status} amending={overview.amendmentOpen} />}
        <DateBar />
      </div>
      {!overview ? (
        <div className="muted">{t('common.loading')}</div>
      ) : overview.dayId === null ? (
        <StartDay date={workDate} onStarted={reload} />
      ) : (
        <DayReview overview={overview} />
      )}
      <RecentDays />
    </div>
  )
}

function StartDay({ date, onStarted }: { date: string; onStarted: () => void }) {
  const { t, num, isAdmin, toast, fail, status } = useApp()
  const { data: p } = useLoad(() => call('days.preview', { date }), [date])
  const [corr, setCorr] = useState<Record<number, { opening: number | null; reason: string }>>({})
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setCorr({})
    setAck(false)
  }, [date])
  if (!p) return <div className="muted">{t('common.loading')}</div>

  const blocking = p.warnings.filter((w) => ['future_date', 'already_started', 'no_active_cages'].includes(w))
  const needAck = p.warnings.some((w) => ['previous_not_closed', 'gap_days', 'backfill'].includes(w))
  const corrections = Object.entries(corr)
    .map(([cageId, c]) => ({ cageId: Number(cageId), opening: c.opening, reason: c.reason.trim() }))
    .filter((c) => c.opening !== null && c.opening !== p.cages.find((x) => x.cageId === c.cageId)?.carried)
  const correctionsValid = corrections.every((c) => c.reason.length >= 3)
  const backfillBlocked = p.laterDayExists && !isAdmin
  const canStart = blocking.length === 0 && (!needAck || ack) && correctionsValid && !backfillBlocked && !busy

  const start = async () => {
    setBusy(true)
    try {
      await call('days.start', { date, corrections: corrections.map((c) => ({ cageId: c.cageId, opening: c.opening!, reason: c.reason })), acknowledgeWarnings: ack })
      toast('success', t('day.started'))
      onStarted()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const totalCarried = p.cages.reduce((s, c) => s + c.carried, 0)
  const totalOpening = p.cages.reduce((s, c) => s + (corr[c.cageId]?.opening ?? c.carried), 0)

  return (
    <div className="stack">
      <Card title={t('day.startTitle')}>
        <div className="stack">
          <Notice tone="info">{t('day.startIntro')}</Notice>
          <div className="muted">{p.previous ? t('day.previousDay', { date: p.previous.date, status: t('status.' + p.previous.status) }) : t('day.noPrevious')}</div>
          {p.warnings.map((w) => (
            <Notice key={w} tone={blocking.includes(w) ? 'bad' : 'warn'}>
              {t('day.warn.' + w, { date: p.previous?.date ?? '', count: p.gapDays })}
            </Notice>
          ))}
          {blocking.length === 0 && (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('common.cage')}</th>
                      <th className="num">{t('day.carried')}</th>
                      {isAdmin && <th className="num">{t('day.opening')}</th>}
                      {isAdmin && <th>{t('common.reason')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {p.cages.map((c) => {
                      const v = corr[c.cageId]
                      const changed = v && v.opening !== null && v.opening !== c.carried
                      return (
                        <tr key={c.cageId}>
                          <td>
                            <strong>{c.name}</strong>
                          </td>
                          <td className="num">{num(c.carried)}</td>
                          {isAdmin && (
                            <td style={{ width: 150 }}>
                              <NumInput value={v?.opening ?? c.carried} onChange={(o) => setCorr({ ...corr, [c.cageId]: { opening: o, reason: v?.reason ?? '' } })} ariaLabel={`${c.name} ${t('day.opening')}`} />
                            </td>
                          )}
                          {isAdmin && (
                            <td>
                              {changed && (
                                <input
                                  className={`input ${v.reason.trim().length < 3 ? 'invalid' : ''}`}
                                  placeholder={t('common.reasonRequired')}
                                  value={v.reason}
                                  onChange={(e) => setCorr({ ...corr, [c.cageId]: { ...v, reason: e.target.value } })}
                                />
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th>{t('common.total')}</th>
                      <th className="num">{num(totalCarried)}</th>
                      {isAdmin && <th className="num">{num(totalOpening)}</th>}
                      {isAdmin && <th />}
                    </tr>
                  </tfoot>
                </table>
              </div>
              {isAdmin && <div className="muted small">{t('day.correctionHint')}</div>}
              <InventoryCarried preview={p} />
              {needAck && (
                <label className="check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  {t('day.acknowledge')}
                </label>
              )}
              {backfillBlocked && <Notice tone="bad">{t('common.adminOnly')}</Notice>}
              <div className="row end">
                <button className="btn primary big" disabled={!canStart} onClick={start}>
                  <PlayCircle size={20} />
                  {t('day.startButton')} — {date === status.today ? t('common.today') : date}
                </button>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  )
}

function InventoryCarried({ preview }: { preview: StartDayPreview }) {
  const { t, num } = useApp()
  const items = preview.inventory.filter((i) => i.active)
  if (!items.length) return null
  return (
    <div>
      <h3 style={{ marginBottom: 8 }}>{t('day.inventoryCarried')}</h3>
      <div className="row">
        {items.map((i) => (
          <span key={i.id} className={`badge ${i.balance < 0 ? 'bad' : i.isLow ? 'warn' : ''}`}>
            {i.name}: {num(i.balance, 2)} {i.unit}
          </span>
        ))}
      </div>
    </div>
  )
}

function DayReview({ overview: ov }: { overview: DayOverview }) {
  const { t, num, isAdmin, toast, fail, dateTime } = useApp()
  const [comment, setComment] = useState(ov.managerComment ?? '')
  const [confirmIssue, setConfirmIssue] = useState<DayIssue | null>(null)
  const [confirmGroup, setConfirmGroup] = useState<DayIssue[] | null>(null)
  const [correct, setCorrect] = useState<{ cageId: number; name: string; opening: number } | null>(null)
  const [closing, setClosing] = useState(false)
  const [amending, setAmending] = useState(false)
  const [finishing, setFinishing] = useState(false)
  useEffect(() => setComment(ov.managerComment ?? ''), [ov.managerComment, ov.date])

  const writable = ov.status !== 'closed' || (ov.amendmentOpen && isAdmin)
  const cageName = (id: number | null) => (id === null ? t('common.farm') : (ov.cages.find((c) => c.cageId === id)?.name ?? ''))
  const blocking = ov.issues.filter((i) => i.severity !== 'info' && !i.confirmation)
  const unconfirmedMortality = ov.cages.filter((c) => !c.mortalityConfirmed).map((c) => c.cageId)
  const tot = ov.totals

  const [preview, setPreview] = useState<ReportSpec | null>(null)

  const confirmMortality = async (cageIds: number[]) => {
    try {
      await call('days.confirmMortality', { date: ov.date, cageIds })
    } catch (e) {
      fail(e)
    }
  }

  return (
    <div className="stack">
      <div className="row muted small">
        {ov.openedBy && <span>{t('day.openedBy', { by: ov.openedBy, at: dateTime(ov.openedAt) })}</span>}
        {ov.closedBy && (
          <span>
            · <Lock size={12} /> {t('day.closedBy', { by: ov.closedBy, at: dateTime(ov.closedAt) })}
          </span>
        )}
      </div>
      {ov.status === 'closed' && !ov.amendmentOpen && <Notice tone="info">{t('common.dayClosed')}</Notice>}
      {ov.amendmentOpen && <Notice tone="warn">{t('common.amending')}</Notice>}

      <Card title={t('day.review')}>
        <div className="muted small" style={{ marginBottom: 10 }}>
          {t('day.reviewIntro')}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('common.cage')}</th>
                <th className="num">{t('col.opening')}</th>
                <th className="num">{t('col.deaths')}</th>
                <th className="num">{t('col.removals')}</th>
                <th className="num">{t('col.additions')}</th>
                <th className="num">{t('col.transfersIn')}</th>
                <th className="num">{t('col.transfersOut')}</th>
                <th className="num">{t('col.closing')}</th>
                <th className="num">{t('col.eggs')}</th>
                <th className="num">{t('col.production')}</th>
                <th className="num">{t('col.feed')}</th>
                <th className="num">{t('col.water')}</th>
                <th className="num">{t('col.medicine')}</th>
                <th>{t('col.deaths')} ✓</th>
              </tr>
            </thead>
            <tbody>
              {ov.cages.map((c) => (
                <tr key={c.cageId}>
                  <td>
                    <strong>{c.name}</strong>
                  </td>
                  <td className="num nowrap">
                    {num(c.opening)}
                    {c.adjustment !== 0 && (
                      <span className="badge info" title={c.adjustmentReason ?? ''} style={{ marginLeft: 6 }}>
                        {c.adjustment > 0 ? '+' : ''}
                        {c.adjustment}
                      </span>
                    )}
                    {isAdmin && writable && (
                      <button className="icon-btn" title={t('day.correction')} onClick={() => setCorrect({ cageId: c.cageId, name: c.name, opening: c.opening })}>
                        <Pencil size={14} />
                      </button>
                    )}
                  </td>
                  <td className="num">{c.movements.deaths || '·'}</td>
                  <td className="num">{c.movements.removals || '·'}</td>
                  <td className="num">{c.movements.additions || '·'}</td>
                  <td className="num">{c.movements.transfersIn || '·'}</td>
                  <td className="num">{c.movements.transfersOut || '·'}</td>
                  <td className="num">
                    <strong>{num(c.closing)}</strong>
                  </td>
                  <td className="num">{c.eggs.collected ? num(c.eggs.collected) : <span className="muted">—</span>}</td>
                  <td className="num">{c.productionPct === null ? '—' : num(c.productionPct, 1) + '%'}</td>
                  <td className="num">
                    {c.feed.consumption === null ? '—' : num(c.feed.consumption, 1)}
                    {c.feed.isEstimate && <span title={t('common.estimate')}>*</span>}
                  </td>
                  <td className="num">{c.water.litres === null ? '—' : num(c.water.litres)}</td>
                  <td className="num">{c.medicineUses || '·'}</td>
                  <td>
                    {c.mortalityConfirmed ? (
                      <span className="badge good">
                        <CheckCircle2 size={12} /> {t('day.mortalityConfirmed')}
                      </span>
                    ) : writable ? (
                      <button className="btn sm" onClick={() => confirmMortality([c.cageId])}>
                        {t('common.confirm')}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>{t('common.total')}</th>
                <td className="num">{num(tot.opening)}</td>
                <td className="num">{num(tot.movements.deaths)}</td>
                <td className="num">{num(tot.movements.removals)}</td>
                <td className="num">{num(tot.movements.additions)}</td>
                <td className="num">{num(tot.movements.transfersIn)}</td>
                <td className="num">{num(tot.movements.transfersOut)}</td>
                <td className="num">{num(tot.closing)}</td>
                <td className="num">{num(tot.eggs.collected)}</td>
                <td className="num">{tot.productionPct === null ? '—' : num(tot.productionPct, 1) + '%'}</td>
                <td className="num">
                  {tot.feedKg === null ? '—' : num(tot.feedKg, 1)}
                  {tot.feedIsEstimate && '*'}
                </td>
                <td className="num">{tot.waterLitres === null ? '—' : num(tot.waterLitres)}</td>
                <td className="num">{tot.medicineUses}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        {tot.feedIsEstimate && <div className="muted small mt">* {t('issue.feed_estimated')}</div>}
        {writable && unconfirmedMortality.length > 1 && (
          <div className="row end mt">
            <button className="btn" onClick={() => confirmMortality(unconfirmedMortality)}>
              <ShieldCheck size={18} />
              {t('day.confirmAllMortality')}
            </button>
          </div>
        )}
      </Card>

      <Card title={t('day.checklist')}>
        {ov.issues.length === 0 || blocking.length === 0 ? (
          <Notice tone="good">{t('day.allClear')}</Notice>
        ) : null}
        {writable && isAdmin && (
          <div className="row mt">
            {Object.entries(
              ov.issues.filter((i) => i.confirmable && !i.confirmation).reduce<Record<string, DayIssue[]>>((g, i) => ({ ...g, [i.code]: [...(g[i.code] ?? []), i] }), {})
            )
              .filter(([, list]) => list.length > 1)
              .map(([code, list]) => (
                <button key={code} className="btn sm" onClick={() => setConfirmGroup(list)}>
                  {t('issue.' + code, { sessions: '…', date: '', item: '', a: '', b: '' }).split(':')[0]} — {t('day.confirmAllSimilar', { count: list.length })}
                </button>
              ))}
          </div>
        )}
        <div className="issues mt">
          {ov.issues.map((i) => (
            <div key={i.key + ':' + i.cageId} className={`issue ${i.confirmation ? 'done' : i.severity}`}>
              <div className="text">
                <div>
                  <strong>{cageName(i.cageId)}</strong> — {issueText(t, i)}
                </div>
                {i.confirmation && <div className="sub">{t('day.confirmedBy', { by: i.confirmation.by, reason: i.confirmation.reason })}</div>}
                {['production_drop', 'high_mortality', 'water_change'].includes(i.code) && <div className="sub">{t('issue.informational')}</div>}
              </div>
              {writable && isAdmin && i.confirmable && !i.confirmation && (
                <button className="btn sm" onClick={() => setConfirmIssue(i)}>
                  {t('day.confirmWithReason')}
                </button>
              )}
              {writable && isAdmin && i.confirmation && (
                <button
                  className="btn sm ghost"
                  onClick={() => call('days.revokeConfirmation', { date: ov.date, cageId: i.cageId, key: i.key }).catch(fail)}
                >
                  {t('day.revoke')}
                </button>
              )}
              {writable && i.code === 'mortality_unconfirmed' && i.cageId !== null && (
                <button className="btn sm" onClick={() => confirmMortality([i.cageId!])}>
                  {t('day.confirmMortality')}
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card title={t('day.managerComment')}>
        <div className="stack">
          <textarea className="input" value={comment} disabled={!isAdmin || !writable} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
          <div className="row">
            <button className="btn" onClick={() => setPreview({ kind: 'day_open', date: ov.date })}>
              <Printer size={18} /> {t('day.openReport')}
            </button>
            <button className="btn" onClick={() => setPreview({ kind: 'day_close', date: ov.date })}>
              <Printer size={18} /> {t('day.closeReport')}
            </button>
            <div className="grow" />
            {isAdmin && writable && ov.status !== 'closed' && comment !== (ov.managerComment ?? '') && (
              <button
                className="btn"
                onClick={() =>
                  call('days.saveComment', { date: ov.date, comment })
                    .then(() => toast('success', t('common.saved')))
                    .catch(fail)
                }
              >
                {t('day.saveProgress')}
              </button>
            )}
            {isAdmin && ov.status !== 'closed' && (
              <button className="btn primary big" disabled={blocking.length > 0} onClick={() => setClosing(true)} title={blocking.length ? t('err.day_has_open_issues', { count: blocking.length }) : ''}>
                <Lock size={18} /> {t('day.closeButton')}
              </button>
            )}
            {isAdmin && ov.status === 'closed' && !ov.amendmentOpen && (
              <button className="btn" onClick={() => setAmending(true)}>
                <Unlock size={18} /> {t('day.amend')}
              </button>
            )}
            {isAdmin && ov.amendmentOpen && (
              <button className="btn primary big" disabled={blocking.length > 0} onClick={() => setFinishing(true)}>
                <Lock size={18} /> {t('day.finishAmend')}
              </button>
            )}
          </div>
          {!isAdmin && ov.status !== 'closed' && <div className="muted small">{t('common.adminOnly')}</div>}
        </div>
      </Card>

      <AmendmentHistory date={ov.date} />

      {confirmIssue && (
        <ReasonDialog
          title={t('day.confirmWithReason')}
          hint={`${cageName(confirmIssue.cageId)} — ${issueText(t, confirmIssue)}`}
          onClose={() => setConfirmIssue(null)}
          onSubmit={(reason) => call('days.confirmIssue', { date: ov.date, cageId: confirmIssue.cageId, key: confirmIssue.key, reason })}
        />
      )}
      {confirmGroup && (
        <ReasonDialog
          title={t('day.confirmAllSimilar', { count: confirmGroup.length })}
          hint={confirmGroup.map((i) => `${cageName(i.cageId)} — ${issueText(t, i)}`).join(' · ')}
          onClose={() => setConfirmGroup(null)}
          onSubmit={async (reason) => {
            for (const i of confirmGroup) await call('days.confirmIssue', { date: ov.date, cageId: i.cageId, key: i.key, reason })
          }}
        />
      )}
      {preview && <ReportPreview spec={preview} onClose={() => setPreview(null)} />}
      {correct && <CorrectOpening date={ov.date} cage={correct} onClose={() => setCorrect(null)} />}
      {closing && (
        <ConfirmDialog
          title={t('day.closeButton')}
          body={t('day.closeConfirm', { date: ov.date })}
          confirmLabel={t('day.closeButton')}
          onClose={() => setClosing(false)}
          onConfirm={async () => {
            await call('days.close', { date: ov.date, comment })
            toast('success', t('day.closed'))
          }}
        />
      )}
      {amending && (
        <ReasonDialog
          title={t('day.amend')}
          hint={t('day.amendReason')}
          minLength={5}
          onClose={() => setAmending(false)}
          onSubmit={async (reason) => {
            await call('days.startAmendment', { date: ov.date, reason })
            toast('info', t('day.amendStarted'))
          }}
        />
      )}
      {finishing && (
        <ConfirmDialog
          title={t('day.finishAmend')}
          body={t('day.closeConfirm', { date: ov.date })}
          onClose={() => setFinishing(false)}
          onConfirm={async () => {
            await call('days.finishAmendment', { date: ov.date, comment })
            toast('success', t('day.amendFinished'))
          }}
        />
      )}
    </div>
  )
}

/** Issue message with session names translated. */
export function issueText(t: (k: string, p?: Record<string, string | number>) => string, i: DayIssue) {
  const params: Record<string, string | number> = { ...i.params }
  if (i.code === 'missing_eggs') params.sessions = translateSessions(t, String(i.params.sessions ?? ''))
  if (i.code === 'possible_duplicate_eggs') {
    params.a = t('session.' + i.params.a)
    params.b = t('session.' + i.params.b)
  }
  return t('issue.' + i.code, params)
}

function translateSessions(t: (k: string) => string, s: string) {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => t('session.' + x))
    .join(', ')
}

function CorrectOpening({ date, cage, onClose }: { date: string; cage: { cageId: number; name: string; opening: number }; onClose: () => void }) {
  const { t, fail, toast } = useApp()
  const [opening, setOpening] = useState<number | null>(cage.opening)
  const [reason, setReason] = useState('')
  const ok = opening !== null && opening !== cage.opening && reason.trim().length >= 3
  return (
    <Modal
      title={`${t('day.correction')} — ${cage.name}`}
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
                await call('days.correctOpening', { date, cageId: cage.cageId, opening: opening!, reason: reason.trim() })
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
      <div className="stack">
        <Notice tone="info">{t('day.correctionHint')}</Notice>
        <Field label={t('day.opening')}>
          <NumInput big value={opening} onChange={setOpening} autoFocus />
        </Field>
        <Field label={t('common.reason')} required>
          <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function AmendmentHistory({ date }: { date: string }) {
  const { t, dateTime } = useApp()
  const { data } = useLoad(() => call('days.amendments', { date }), [date])
  if (!data || data.length === 0) return null
  return (
    <Card title={t('day.amendHistory')}>
      <div className="table-wrap">
        <table className="data">
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <td>{a.reason}</td>
                <td className="nowrap">
                  {a.openedBy} · {dateTime(a.openedAt)}
                </td>
                <td className="nowrap">{a.closedAt ? `${a.closedBy} · ${dateTime(a.closedAt)}` : <span className="badge warn">{t('status.amending')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function RecentDays() {
  const { t, status, setWorkDate, workDate, date } = useApp()
  const { data } = useLoad(() => call('days.list', { from: addDays(status.today, -30), to: status.today }), [status.today])
  return (
    <Card title={t('day.recentDays')} className="mt">
      {!data || data.length === 0 ? (
        <Empty text={t('common.noData')} />
      ) : (
        <div className="row">
          {data.map((d) => (
            <button key={d.date} className={`btn sm ${d.date === workDate ? 'primary' : ''}`} onClick={() => setWorkDate(d.date)}>
              {date(d.date, { month: 'short', day: 'numeric' })}
              <StatusBadge status={d.status} amending={!!d.amendmentOpen} />
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}
