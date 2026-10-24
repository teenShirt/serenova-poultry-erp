import { useEffect, useState } from 'react'
import { Building2, Check, Pencil, Plus, Trash2 } from 'lucide-react'
import type { FarmRow, HouseRow, ProductionStage } from '@shared/flocks'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { useStageName } from '../pages/Flocks'
import { Card, Field, Modal, Notice, NumInput, ReasonDialog, nz } from './ui'

/** The organization's farms; each has its own cages, houses, flocks and day cycle. */
export function FarmsCard() {
  const { t, can, status, refreshStatus, fail } = useApp()
  const { data: farms } = useLoad(() => call('farms.list'), [])
  const [editing, setEditing] = useState<FarmRow | 'new' | null>(null)
  const [archiving, setArchiving] = useState<FarmRow | null>(null)
  const manage = can('farms.manage')
  const sub = status.subscription
  const atLimit = !!sub && sub.usage.farms >= sub.limits.maxFarms
  return (
    <Card
      title={t('farm.title')}
      actions={
        manage ? (
          <button className="btn primary" disabled={atLimit} title={atLimit ? t('farm.atLimit', { n: sub!.limits.maxFarms }) : undefined} onClick={() => setEditing('new')}>
            <Plus size={18} /> {t('farm.add')}
          </button>
        ) : undefined
      }
    >
      {sub && <div className="muted small" style={{ marginBottom: 8 }}>{t('farm.usage', { used: sub.usage.farms, max: sub.limits.maxFarms, plan: sub.planName })}</div>}
      <table className="data">
        <thead>
          <tr>
            <th>{t('farm.name')}</th>
            <th>{t('setup.location')}</th>
            <th className="num">{t('farm.cages')}</th>
            <th className="num">{t('farm.flocks')}</th>
            <th>{t('common.status')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {farms?.map((f) => (
            <tr key={f.id}>
              <td>
                <strong>{f.name}</strong>
                {f.current && <span className="badge info" style={{ marginLeft: 8 }}>{t('farm.current')}</span>}
              </td>
              <td>{f.location ?? '—'}</td>
              <td className="num">{f.cages}</td>
              <td className="num">{f.activeFlocks}</td>
              <td>{f.status === 'active' ? <span className="badge good">{t('common.active')}</span> : <span className="badge">{t('farm.archived')}</span>}</td>
              <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                {!f.current && f.status === 'active' && (
                  <button
                    className="btn sm"
                    onClick={async () => {
                      try {
                        await call('farms.switch', { id: f.id })
                        await refreshStatus()
                      } catch (e) {
                        fail(e)
                      }
                    }}
                  >
                    <Check size={14} /> {t('farm.switch')}
                  </button>
                )}
                {manage && (
                  <button className="icon-btn" title={t('common.edit')} onClick={() => setEditing(f)}>
                    <Pencil size={16} />
                  </button>
                )}
                {manage && !f.current && f.status === 'active' && (
                  <button className="icon-btn" title={t('farm.archive')} onClick={() => setArchiving(f)}>
                    <Trash2 size={16} />
                  </button>
                )}
                {manage && f.status === 'archived' && (
                  <button
                    className="btn sm"
                    onClick={() => call('farms.setStatus', { id: f.id, status: 'active', reason: 'Reactivated' }).catch(fail)}
                  >
                    {t('farm.reactivate')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <FarmForm farm={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {archiving && (
        <ReasonDialog
          title={`${t('farm.archive')}: ${archiving.name}`}
          hint={t('farm.archiveHint')}
          danger
          onClose={() => setArchiving(null)}
          onSubmit={(reason) => call('farms.setStatus', { id: archiving.id, status: 'archived', reason })}
        />
      )}
    </Card>
  )
}

function FarmForm({ farm, onClose }: { farm: FarmRow | null; onClose: () => void }) {
  const { t, toast, fail, refreshStatus } = useApp()
  const [name, setName] = useState(farm?.name ?? '')
  const [location, setLocation] = useState(farm?.location ?? '')
  return (
    <Modal
      title={farm ? farm.name : t('farm.add')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={name.trim().length < 2}
            onClick={async () => {
              try {
                await call('farms.save', { id: farm?.id ?? null, name, location: nz(location) })
                await refreshStatus()
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
        <Field label={t('farm.name')} required>
          <input className="input" autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('setup.location')}>
          <input className="input" value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        {!farm && <Notice tone="info">{t('farm.newHint')}</Notice>}
      </div>
    </Modal>
  )
}

/** Production stages by flock age (in completed weeks), shared by all the organization's farms. */
export function StagesCard() {
  const { t, status, refreshStatus, toast, fail } = useApp()
  const stageName = useStageName()
  const [stages, setStages] = useState<ProductionStage[]>(status.settings.productionStages)
  useEffect(() => setStages(status.settings.productionStages), [status.settings.productionStages])
  const sorted = [...stages].sort((a, b) => a.fromWeek - b.fromWeek)
  const valid = stages.every((s) => s.name.trim()) && new Set(stages.map((s) => s.fromWeek)).size === stages.length
  return (
    <Card title={t('stage.title')}>
      <div className="muted small" style={{ marginBottom: 10 }}>
        {t('stage.hint')}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {stages.map((s, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <input
              className="input"
              value={stageName(s.name) === s.name ? s.name : stageName(s.name)}
              maxLength={60}
              onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              style={{ maxWidth: 260 }}
            />
            <span className="muted">{t('stage.fromWeek')}</span>
            <div style={{ width: 100 }}>
              <NumInput value={s.fromWeek} onChange={(v) => setStages(stages.map((x, j) => (j === i ? { ...x, fromWeek: v ?? 0 } : x)))} />
            </div>
            <button className="icon-btn" title={t('common.delete')} onClick={() => setStages(stages.filter((_, j) => j !== i))}>
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => setStages([...stages, { name: '', fromWeek: (sorted[sorted.length - 1]?.fromWeek ?? 0) + 1 }])}>
            <Plus size={14} /> {t('stage.add')}
          </button>
          <span className="grow" />
          <button
            className="btn primary"
            disabled={!valid}
            onClick={async () => {
              try {
                await call('settings.save', { productionStages: sorted.map((s) => ({ name: s.name.trim(), fromWeek: s.fromWeek })) })
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
    </Card>
  )
}

/** Poultry houses (sheds) of the current farm; cages can be grouped into them. */
export function HousesCard() {
  const { t, can } = useApp()
  const { data: houses } = useLoad(() => call('houses.list'), [])
  const [editing, setEditing] = useState<HouseRow | 'new' | null>(null)
  const manage = can('cages.manage')
  return (
    <Card
      title={t('house.title')}
      actions={
        manage ? (
          <button className="btn" onClick={() => setEditing('new')}>
            <Plus size={18} /> {t('house.add')}
          </button>
        ) : undefined
      }
    >
      <div className="muted small" style={{ marginBottom: 8 }}>
        {t('house.hint')}
      </div>
      {houses && houses.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th>{t('cage.code')}</th>
              <th>{t('cage.name')}</th>
              <th className="num">{t('farm.cages')}</th>
              <th>{t('common.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {houses.map((h) => (
              <tr key={h.id}>
                <td>{h.code}</td>
                <td>
                  <strong>{h.name}</strong>
                </td>
                <td className="num">{h.cages}</td>
                <td>{h.active ? <span className="badge good">{t('common.active')}</span> : <span className="badge">{t('common.inactive')}</span>}</td>
                <td>
                  {manage && (
                    <button className="icon-btn" title={t('common.edit')} onClick={() => setEditing(h)}>
                      <Pencil size={16} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <HouseForm house={editing === 'new' ? null : editing} next={(houses?.length ?? 0) + 1} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function HouseForm({ house, next, onClose }: { house: HouseRow | null; next: number; onClose: () => void }) {
  const { t, toast, fail } = useApp()
  const [f, setF] = useState({
    code: house?.code ?? `H${next}`,
    name: house?.name ?? `House ${next}`,
    active: house?.active ?? true,
    sortOrder: house?.sortOrder ?? next,
    notes: house?.notes ?? null
  })
  return (
    <Modal
      title={house ? house.name : t('house.add')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!f.code.trim()}
            onClick={async () => {
              try {
                await call('houses.save', { id: house?.id ?? null, ...f })
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
            <input className="input" value={f.code} maxLength={40} onChange={(e) => setF({ ...f, code: e.target.value })} />
          </Field>
          <Field label={t('cage.name')}>
            <input className="input" value={f.name} maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label={t('cage.order')}>
            <NumInput value={f.sortOrder} onChange={(v) => setF({ ...f, sortOrder: v ?? 0 })} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          {t('common.active')}
        </label>
        <Field label={t('common.notes')}>
          <input className="input" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: nz(e.target.value) })} />
        </Field>
      </div>
    </Modal>
  )
}

/** Farm chip in the top bar: shows the farm being worked on, and switches when there are several. */
export function FarmSwitcher() {
  const { t, status, refreshStatus, fail } = useApp()
  const { data: farms } = useLoad(() => call('farms.list'), [status.farm?.id])
  const [open, setOpen] = useState(false)
  const active = (farms ?? []).filter((f) => f.status === 'active')
  if (!status.farm) return null
  return (
    <div className="menu-anchor">
      <button className="farm-chip" title={status.organization?.name} onClick={() => active.length > 1 && setOpen(!open)} aria-expanded={open}>
        <Building2 size={18} />
        <span>{status.farm.name}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-title">{t('farm.switchTo')}</div>
          {active.map((f) => (
            <button
              key={f.id}
              role="menuitem"
              className={f.current ? 'on' : ''}
              onClick={async () => {
                setOpen(false)
                if (f.current) return
                try {
                  await call('farms.switch', { id: f.id })
                  await refreshStatus()
                } catch (e) {
                  fail(e)
                }
              }}
            >
              <Building2 size={16} /> {f.name}
              {f.current && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
