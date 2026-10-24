import { useState } from 'react'
import { DatabaseBackup, Download, ShieldCheck, Upload } from 'lucide-react'
import type { BackupFileCheck } from '@shared/types'
import { backupDownloadUrl, call, uploadBackup } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, NumInput, PageHeader } from '../components/ui'

export function BackupPage() {
  const { t, isAdmin, status, toast, fail, refreshStatus, dateTime, num } = useApp()
  const { data: runs, reload } = useLoad(() => call('backup.list'), [])
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<(BackupFileCheck & { token: string }) | null>(null)
  const s = status.settings
  const [auto, setAuto] = useState({ enabled: s.backupEnabled, interval: s.backupIntervalHours as number | null, retention: s.backupRetention as number | null })

  if (status.isDemo) {
    return (
      <div className="page">
        <PageHeader title={t('bak.title')} icon={<DatabaseBackup size={26} color="var(--brand)" />} />
        <Notice tone="warn">{t('app.demoBanner')}</Notice>
      </div>
    )
  }

  const backup = async () => {
    setBusy(true)
    try {
      const r = await call('backup.create')
      toast('success', t('bak.done', { path: (r.path ?? '').split(/[\/]/).pop() ?? '' }))
      reload()
    } catch (e) {
      fail(e)
      reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <PageHeader title={t('bak.title')} icon={<DatabaseBackup size={26} color="var(--brand)" />} />
      <div className="stack">
        {status.backupWarning && <Notice tone="bad">{t('alert.backup_failed', { message: status.backupWarning })}</Notice>}
        <Notice tone="info">{t('bak.intro')}</Notice>
        <div className="grid cols-2">
          <Card title={t('bak.now')}>
            <div className="stack">
              <button className="btn primary big" disabled={busy} onClick={backup}>
                <ShieldCheck size={20} />
                {t('bak.now')}
              </button>
            </div>
          </Card>
          <Card title={t('bak.auto')}>
            {isAdmin ? (
              <div className="stack">
                <label className="check">
                  <input type="checkbox" checked={auto.enabled} onChange={(e) => setAuto({ ...auto, enabled: e.target.checked })} />
                  {t('bak.autoEnabled')}
                </label>
                <div className="form-grid">
                  <Field label={t('bak.interval')}>
                    <NumInput value={auto.interval} onChange={(v) => setAuto({ ...auto, interval: v })} />
                  </Field>
                  <Field label={t('bak.retention')}>
                    <NumInput value={auto.retention} onChange={(v) => setAuto({ ...auto, retention: v })} />
                  </Field>
                </div>
                <div className="row">
                  <span className="grow" />
                  <button
                    className="btn primary"
                    disabled={!auto.interval || !auto.retention}
                    onClick={async () => {
                      try {
                        await call('settings.save', { backupEnabled: auto.enabled, backupIntervalHours: auto.interval!, backupRetention: auto.retention! })
                        await refreshStatus()
                        toast('success', t('set.saved'))
                      } catch (e) {
                        fail(e)
                      }
                    }}
                  >
                    {t('common.saveChanges')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="muted">{t('common.adminOnly')}</div>
            )}
          </Card>
        </div>

        <Card title={t('bak.restore')}>
          {isAdmin ? (
            <div className="stack">
              <Notice tone="warn">{t('bak.restoreIntro')}</Notice>
              <div className="muted small">{t('bak.desktopImport')}</div>
              <div className="row">
                <label className={`btn ${busy ? 'disabled' : ''}`}>
                  <Upload size={18} /> {busy ? t('bak.checking') : t('bak.pickFile')}
                  <input
                    type="file"
                    accept=".pfmbackup,.db"
                    hidden
                    disabled={busy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (!file) return
                      setBusy(true)
                      try {
                        setCheck(await uploadBackup(file))
                      } catch (err) {
                        fail(err)
                      } finally {
                        setBusy(false)
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="muted">{t('bak.adminOnly')}</div>
          )}
        </Card>

        <Card title={t('bak.history')}>
          {!runs || runs.length === 0 ? (
            <Empty text={t('common.noData')} />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('common.time')}</th>
                    <th>{t('common.type')}</th>
                    <th>{t('common.status')}</th>
                    <th className="num">{t('bak.size')}</th>
                    <th>{t('bak.folder')}</th>
                    {isAdmin && <th />}
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{dateTime(r.createdAt)}</td>
                      <td>{t('bak.kind.' + r.kind)}</td>
                      <td>{r.status === 'ok' ? <span className="badge good">{t('bak.ok')}</span> : <span className="badge bad" title={r.message ?? ''}>{t('bak.failed')}</span>}</td>
                      <td className="num">{r.sizeBytes ? `${num(r.sizeBytes / 1024 / 1024, 2)} MB` : '—'}</td>
                      <td className="small muted">{r.path ?? r.message}</td>
                      {isAdmin && (
                        <td>
                          {r.status === 'ok' && r.path && (
                            <a className="btn sm" href={backupDownloadUrl(r.id)} download>
                              <Download size={14} /> {t('bak.download')}
                            </a>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {check && <RestoreDialog check={check} onClose={() => setCheck(null)} />}
    </div>
  )
}

function RestoreDialog({ check, onClose }: { check: BackupFileCheck & { token: string }; onClose: () => void }) {
  const { t, toast, fail, refreshStatus } = useApp()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={t('bak.restore')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {check.ok && (
            <button
              className="btn danger"
              disabled={typed !== 'RESTORE' || busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await call('backup.restore', { token: check.token })
                  toast('success', t('bak.restored'))
                  await refreshStatus()
                } catch (e) {
                  fail(e)
                  setBusy(false)
                }
              }}
            >
              {t('bak.restoreButton')}
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        <div className="small muted">{check.path}</div>
        {check.ok ? (
          <>
            <Notice tone="good">
              <div>{t('bak.checkOk')}</div>
              <div>{t('bak.backupFarm', { farm: check.farmName ?? '—' })}</div>
              <div>{t('bak.backupDays', { count: check.dayCount, date: check.lastDate ?? '—' })}</div>
            </Notice>
            <Notice tone="warn">{t('bak.restoreIntro')}</Notice>
            <Field label={t('bak.confirmRestore')}>
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </Field>
          </>
        ) : (
          <Notice tone="bad">{t('bak.checkFailed', { error: check.error ?? '' })}</Notice>
        )}
      </div>
    </Modal>
  )
}
