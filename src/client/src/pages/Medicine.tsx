import { useEffect, useState } from 'react'
import { HeartPulse, Pill, Plus, Trash2 } from 'lucide-react'
import { addDays } from '@shared/dates'
import type { HealthEvent, Treatment } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, CageSelect, DateBar, DayGate, Empty, Field, Modal, Notice, NumInput, PageHeader, ReasonDialog, Seg, Tabs, nz, useCages, useDay } from '../components/ui'

export function MedicinePage() {
  const { t, num, workDate, date, status } = useApp()
  const { overview, writable } = useDay(workDate)
  const [tab, setTab] = useState<'treatments' | 'health' | 'stock'>('treatments')
  const from = addDays(workDate, -29)
  const { data: treatments } = useLoad(() => call('medicine.treatments', { from, to: workDate }), [workDate])
  const { data: events } = useLoad(() => call('medicine.healthEvents', { from, to: workDate }), [workDate])
  const { data: batches } = useLoad(() => call('inventory.batches', { onlyInStock: true }), [])
  const [adding, setAdding] = useState<'treatment' | 'health' | null>(null)
  const [delT, setDelT] = useState<Treatment | null>(null)
  const [delH, setDelH] = useState<HealthEvent | null>(null)
  const warnDays = status.settings.medicineExpiryWarnDays

  return (
    <div className="page">
      <PageHeader title={t('med.title')} icon={<Pill size={26} color="var(--brand)" />}>
        <DateBar />
      </PageHeader>
      <div className="stack">
        <Notice tone="warn">{t('med.disclaimer')}</Notice>
        <DayGate overview={overview} />
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'treatments', label: t('med.treatments') },
            { value: 'health', label: t('med.health') },
            { value: 'stock', label: t('inv.batches') }
          ]}
        />
        {tab === 'treatments' && (
          <Card
            title={`${t('med.treatments')} — ${t('common.last30')}`}
            actions={
              writable && (
                <button className="btn primary" onClick={() => setAdding('treatment')}>
                  <Plus size={18} />
                  {t('med.addTreatment')}
                </button>
              )
            }
          >
            {!treatments || treatments.length === 0 ? (
              <Empty text={t('common.noData')} />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th>
                      <th>{t('common.cage')}</th>
                      <th>{t('med.medicine')}</th>
                      <th>{t('med.batch')}</th>
                      <th className="num">{t('common.quantity')}</th>
                      <th>{t('med.reasonForUse')}</th>
                      <th>{t('med.prescribedBy')}</th>
                      <th>{t('common.recordedBy')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {treatments.map((x) => (
                      <tr key={x.id}>
                        <td className="nowrap">
                          {date(x.date)} {x.administeredAt}
                        </td>
                        <td>{x.cageName ?? t('common.farm')}</td>
                        <td>{x.itemName}</td>
                        <td>
                          {x.batchNo}
                          {x.expiryDate && x.expiryDate < x.date && <span className="badge bad"> {t('inv.expired')}</span>}
                        </td>
                        <td className="num nowrap">
                          {num(x.quantity, 2)} {x.unit}
                        </td>
                        <td>{x.reason}</td>
                        <td>{x.prescribedBy}</td>
                        <td>{x.recordedBy}</td>
                        <td>
                          {x.date === workDate && writable && (
                            <button className="icon-btn" title={t('common.delete')} onClick={() => setDelT(x)}>
                              <Trash2 size={16} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
        {tab === 'health' && (
          <Card
            title={`${t('med.health')} — ${t('common.last30')}`}
            actions={
              writable && (
                <button className="btn primary" onClick={() => setAdding('health')}>
                  <HeartPulse size={18} />
                  {t('med.addHealth')}
                </button>
              )
            }
          >
            {!events || events.length === 0 ? (
              <Empty text={t('common.noData')} />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th>
                      <th>{t('common.cage')}</th>
                      <th>{t('med.category')}</th>
                      <th>{t('med.severity')}</th>
                      <th>{t('med.description')}</th>
                      <th>{t('med.actionTaken')}</th>
                      <th>{t('common.recordedBy')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((h) => (
                      <tr key={h.id}>
                        <td className="nowrap">
                          {date(h.date)} {h.eventTime}
                        </td>
                        <td>{h.cageName ?? t('common.farm')}</td>
                        <td>{t('med.cat.' + h.category)}</td>
                        <td>
                          <span className={`badge ${h.severity === 'high' ? 'bad' : h.severity === 'medium' ? 'warn' : ''}`}>{t('med.severity.' + h.severity)}</span>
                        </td>
                        <td>{h.description}</td>
                        <td>{h.actionTaken}</td>
                        <td>{h.recordedBy}</td>
                        <td>
                          {h.date === workDate && writable && (
                            <button className="icon-btn" title={t('common.delete')} onClick={() => setDelH(h)}>
                              <Trash2 size={16} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
        {tab === 'stock' && (
          <Card title={t('inv.batches')}>
            {!batches || batches.length === 0 ? (
              <Empty text={t('common.noData')} />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('med.medicine')}</th>
                      <th>{t('med.batch')}</th>
                      <th>{t('med.expiry')}</th>
                      <th className="num">{t('inv.daysToExpiry')}</th>
                      <th className="num">{t('inv.balance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id}>
                        <td>{b.itemName}</td>
                        <td>{b.batchNo}</td>
                        <td>{b.expiryDate ? date(b.expiryDate) : '—'}</td>
                        <td className="num">
                          {b.daysToExpiry === null ? '—' : <span className={`badge ${b.daysToExpiry < 0 ? 'bad' : b.daysToExpiry <= warnDays ? 'warn' : ''}`}>{b.daysToExpiry < 0 ? t('inv.expired') : b.daysToExpiry}</span>}
                        </td>
                        <td className="num">
                          {num(b.balance, 2)} {b.unit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
      {adding === 'treatment' && <AddTreatment date={workDate} onClose={() => setAdding(null)} />}
      {adding === 'health' && <AddHealth date={workDate} onClose={() => setAdding(null)} />}
      {delT && <ReasonDialog title={t('common.deleteTitle')} hint={`${delT.itemName} ${delT.quantity} ${delT.unit}. ${t('common.deleteHint')}`} danger confirmLabel={t('common.delete')} onClose={() => setDelT(null)} onSubmit={(reason) => call('medicine.deleteTreatment', { id: delT.id, reason })} />}
      {delH && <ReasonDialog title={t('common.deleteTitle')} hint={`${delH.description}. ${t('common.deleteHint')}`} danger confirmLabel={t('common.delete')} onClose={() => setDelH(null)} onSubmit={(reason) => call('medicine.deleteHealthEvent', { id: delH.id, reason })} />}
    </div>
  )
}

function AddTreatment({ date, onClose }: { date: string; onClose: () => void }) {
  const { t, num, toast, fail, date: fmt } = useApp()
  const { data: cages } = useCages()
  const { data: meds } = useLoad(() => call('inventory.balances', { category: 'medicine' }), [])
  const [itemId, setItemId] = useState<number | null>(null)
  const { data: batches } = useLoad(() => (itemId ? call('inventory.batches', { itemId, onlyInStock: true }) : Promise.resolve([])), [itemId])
  const [batchId, setBatchId] = useState<number | null>(null)
  const [cageId, setCageId] = useState<number | null>(null)
  const [quantity, setQuantity] = useState<number | null>(null)
  const [time, setTime] = useState('')
  const [reason, setReason] = useState('')
  const [prescribedBy, setPrescribedBy] = useState('')
  const [notes, setNotes] = useState('')
  useEffect(() => setBatchId(batches?.[0]?.id ?? null), [batches])
  const item = meds?.find((m) => m.id === itemId)
  const batch = batches?.find((b) => b.id === batchId)
  const ok = itemId !== null && quantity !== null && quantity > 0 && reason.trim().length >= 3
  return (
    <Modal
      wide
      title={t('med.addTreatment')}
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
                await call('medicine.addTreatment', { date, cageId, itemId: itemId!, batchId, quantity: quantity!, administeredAt: time || null, reason: reason.trim(), prescribedBy: nz(prescribedBy), notes: nz(notes) })
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
        <Notice tone="warn">{t('med.disclaimer')}</Notice>
        <div className="form-grid">
          <Field label={t('med.medicine')} required>
            <select className="select" value={itemId ?? ''} onChange={(e) => setItemId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">—</option>
              {meds
                ?.filter((m) => m.active)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({num(m.balance, 2)} {m.unit})
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('med.batch')}>
            <select className="select" value={batchId ?? ''} onChange={(e) => setBatchId(e.target.value ? Number(e.target.value) : null)} disabled={!itemId}>
              {(batches ?? []).length === 0 && <option value="">—</option>}
              {batches?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.batchNo} · {b.expiryDate ? fmt(b.expiryDate) : '—'} · {num(b.balance, 2)} {b.unit}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.cage')}>
            <CageSelect cages={cages ?? []} value={cageId} onChange={setCageId} allowFarm />
          </Field>
          <Field label={`${t('med.quantityUsed')}${item ? ` (${item.unit})` : ''}`} required>
            <NumInput decimals value={quantity} onChange={setQuantity} />
          </Field>
          <Field label={t('common.time')}>
            <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label={t('med.prescribedBy')}>
            <input className="input" value={prescribedBy} onChange={(e) => setPrescribedBy(e.target.value)} />
          </Field>
        </div>
        {itemId && batches && batches.length === 0 && <Notice tone="bad">{t('med.noBatches')}</Notice>}
        {batch && batch.daysToExpiry !== null && batch.daysToExpiry < 0 && <Notice tone="bad">{t('med.expiredBatch')}</Notice>}
        <Field label={t('med.reasonForUse')} required>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <Field label={t('common.notes')}>
          <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

const CATEGORIES = ['observation', 'vaccination', 'vet_visit', 'disease', 'other']

function AddHealth({ date, onClose }: { date: string; onClose: () => void }) {
  const { t, toast, fail } = useApp()
  const { data: cages } = useCages()
  const [cageId, setCageId] = useState<number | null>(null)
  const [category, setCategory] = useState('observation')
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high'>('low')
  const [time, setTime] = useState('')
  const [description, setDescription] = useState('')
  const [action, setAction] = useState('')
  const ok = description.trim().length >= 3
  return (
    <Modal
      title={t('med.addHealth')}
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
                await call('medicine.addHealthEvent', { date, cageId, eventTime: time || null, category, severity, description: description.trim(), actionTaken: nz(action) })
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
          <Field label={t('common.cage')}>
            <CageSelect cages={cages ?? []} value={cageId} onChange={setCageId} allowFarm />
          </Field>
          <Field label={t('med.category')}>
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t('med.cat.' + c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.time')}>
            <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        <Field label={t('med.severity')}>
          <Seg
            value={severity}
            onChange={setSeverity}
            options={[
              { value: 'low', label: t('med.severity.low') },
              { value: 'medium', label: t('med.severity.medium') },
              { value: 'high', label: t('med.severity.high') }
            ]}
          />
        </Field>
        <Field label={t('med.description')} required>
          <textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </Field>
        <Field label={t('med.actionTaken')}>
          <textarea className="input" value={action} onChange={(e) => setAction(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Modal>
  )
}
