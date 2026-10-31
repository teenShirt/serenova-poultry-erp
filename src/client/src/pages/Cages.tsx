import { useState } from 'react'
import { Pencil, Plus, Warehouse } from 'lucide-react'
import type { CageInputDto } from '@shared/api'
import type { Cage } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Field, Modal, Notice, NumInput, PageHeader, nz } from '../components/ui'
import { HousesCard } from '../components/Farms'

export function CagesPage() {
  const { t, num, can, status } = useApp()
  const { data: cages } = useLoad(() => call('cages.list', { includeInactive: true }), [])
  const { data: today } = useLoad(() => call('days.overview', { date: status.today }), [status.today])
  const [editing, setEditing] = useState<(Cage & { hasHistory: boolean }) | 'new' | null>(null)
  return (
    <div className="page">
      <PageHeader title={t('cage.title')} icon={<Warehouse size={26} color="var(--brand)" />}>
        {can('cages.manage') && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Plus size={18} />
            {t('cage.add')}
          </button>
        )}
      </PageHeader>
      <Card>
        <div className="muted small" style={{ marginBottom: 10 }}>
          {t('cage.deactivateHint')}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('cage.code')}</th>
                <th>{t('cage.name')}</th>
                <th className="num">{t('cage.initialHens')}</th>
                <th className="num">{t('cage.capacity')}</th>
                <th className="num">{t('cage.currentHens')}</th>
                {status.settings.waterTracking && <th>{t('cage.hasMeter')}</th>}
                <th>{t('common.status')}</th>
                <th>{t('common.notes')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cages?.map((c) => {
                const live = today?.cages.find((x) => x.cageId === c.id)
                return (
                  <tr key={c.id}>
                    <td>{c.code}</td>
                    <td>
                      <strong>{c.name}</strong>
                    </td>
                    <td className="num">{num(c.initialHens)}</td>
                    <td className="num">{c.capacity === null ? '—' : num(c.capacity)}</td>
                    <td className="num">{live ? num(live.closing) : '—'}</td>
                    {status.settings.waterTracking && <td>{c.hasWaterMeter ? t('common.yes') : t('common.no')}</td>}
                    <td>{c.active ? <span className="badge good">{t('common.active')}</span> : <span className="badge">{t('common.inactive')}</span>}</td>
                    <td className="muted">{c.notes}</td>
                    <td>
                      {can('cages.manage') && (
                        <button className="icon-btn" title={t('common.edit')} onClick={() => setEditing(c)}>
                          <Pencil size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={2}>{t('common.total')}</th>
                <th className="num">{num(cages?.filter((c) => c.active).reduce((s, c) => s + c.initialHens, 0))}</th>
                <th />
                <th className="num">{today ? num(today.totals.closing) : '—'}</th>
                <th colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      <div className="mt">
        <HousesCard />
      </div>
      {editing && <CageForm cage={editing === 'new' ? null : editing} nextOrder={(cages?.length ?? 0) + 1} onClose={() => setEditing(null)} />}
    </div>
  )
}

function CageForm({ cage, nextOrder, onClose }: { cage: (Cage & { hasHistory: boolean }) | null; nextOrder: number; onClose: () => void }) {
  const { t, toast, fail, status } = useApp()
  const [f, setF] = useState<CageInputDto>(
    cage
      ? {
          code: cage.code,
          name: cage.name,
          initialHens: cage.initialHens,
          capacity: cage.capacity,
          hasWaterMeter: cage.hasWaterMeter,
          active: cage.active,
          sortOrder: cage.sortOrder,
          notes: cage.notes,
          houseId: cage.houseId
        }
      : {
          code: String(nextOrder).padStart(2, '0'),
          name: `Cage ${String(nextOrder).padStart(2, '0')}`,
          initialHens: 0,
          capacity: null,
          hasWaterMeter: true,
          active: true,
          sortOrder: nextOrder,
          notes: null,
          houseId: null
        }
  )
  const [reason, setReason] = useState('')
  const { data: houses } = useLoad(() => call('houses.list'), [])
  const locked = !!cage?.hasHistory
  const ok = f.code.trim() && f.name.trim()
  return (
    <Modal
      title={cage ? `${t('cage.details')} — ${cage.name}` : t('cage.add')}
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
                if (cage) await call('cages.update', { id: cage.id, cage: f, reason: nz(reason) })
                else await call('cages.create', f)
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
        <div className="form-grid">
          <Field label={t('cage.code')} required>
            <input className="input" value={f.code} maxLength={20} onChange={(e) => setF({ ...f, code: e.target.value })} />
          </Field>
          <Field label={t('cage.name')} required>
            <input className="input" value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label={t('cage.initialHens')} hint={locked ? t('cage.lockedHint') : undefined}>
            <NumInput value={f.initialHens} disabled={locked} onChange={(v) => setF({ ...f, initialHens: v ?? 0 })} />
          </Field>
          <Field label={t('cage.capacity')}>
            <NumInput value={f.capacity} onChange={(v) => setF({ ...f, capacity: v })} />
          </Field>
          <Field label={t('cage.order')}>
            <NumInput value={f.sortOrder} onChange={(v) => setF({ ...f, sortOrder: v ?? 0 })} />
          </Field>
          {houses && houses.length > 0 && (
            <Field label={t('house.one')}>
              <select className="select" value={f.houseId ?? ''} onChange={(e) => setF({ ...f, houseId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">—</option>
                {houses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {status.settings.waterTracking && (
          <label className="check">
            <input type="checkbox" checked={f.hasWaterMeter} onChange={(e) => setF({ ...f, hasWaterMeter: e.target.checked })} />
            {t('cage.hasMeter')}
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          {t('common.active')}
        </label>
        {!f.active && <Notice tone="info">{t('cage.deactivateHint')}</Notice>}
        <Field label={t('common.notes')}>
          <input className="input" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: nz(e.target.value) })} />
        </Field>
        {cage && (
          <Field label={`${t('common.reason')} (${t('common.optional')})`}>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
