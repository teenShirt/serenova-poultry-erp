import { useState } from 'react'
import { Boxes, Pencil, Plus, Repeat } from 'lucide-react'
import type { ItemInputDto } from '@shared/api'
import { addDays } from '@shared/dates'
import type { InventoryBalance, InventoryCategory, TxnType } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, NumInput, PageHeader, Seg, Tabs, nz } from '../components/ui'

export function InventoryPage() {
  const { t, num, isAdmin, date, workDate, status } = useApp()
  const [tab, setTab] = useState<'balances' | 'history' | 'batches'>('balances')
  const [category, setCategory] = useState<InventoryCategory | 'all'>('all')
  const cat = category === 'all' ? undefined : category
  const { data: items } = useLoad(() => call('inventory.balances', { category: cat }), [category])
  const { data: txns } = useLoad(() => call('inventory.txns', { category: cat, from: addDays(workDate, -89), to: status.today, limit: 1000 }), [category, workDate])
  const { data: batches } = useLoad(() => call('inventory.batches', {}), [])
  const [record, setRecord] = useState<InventoryBalance | 'any' | null>(null)
  const [editing, setEditing] = useState<InventoryBalance | 'new' | null>(null)

  return (
    <div className="page">
      <PageHeader title={t('inv.title')} icon={<Boxes size={26} color="var(--brand)" />}>
        <button className="btn primary" onClick={() => setRecord('any')}>
          <Repeat size={18} />
          {t('inv.record')}
        </button>
        {isAdmin && (
          <button className="btn" onClick={() => setEditing('new')}>
            <Plus size={18} />
            {t('inv.addItem')}
          </button>
        )}
      </PageHeader>
      <div className="stack">
        <div className="row">
          <Seg
            value={category}
            onChange={setCategory}
            options={[
              { value: 'all', label: t('common.all') },
              { value: 'feed', label: t('inv.cat.feed') },
              { value: 'medicine', label: t('inv.cat.medicine') },
              { value: 'supply', label: t('inv.cat.supply') }
            ]}
          />
          <span className="muted small grow">{t('inv.allHistory')}</span>
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'balances', label: t('inv.balances') },
            { value: 'history', label: t('inv.history') },
            { value: 'batches', label: t('inv.batches') }
          ]}
        />
        {tab === 'balances' && (
          <Card>
            {!items || items.length === 0 ? (
              <Empty text={t('common.noData')} />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('inv.item')}</th>
                      <th>{t('inv.category')}</th>
                      <th className="num">{t('inv.balance')}</th>
                      <th>{t('common.unit')}</th>
                      <th className="num">{t('inv.lowThreshold')}</th>
                      <th>{t('common.status')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id} style={i.active ? undefined : { opacity: 0.55 }}>
                        <td>
                          <strong>{i.name}</strong>
                        </td>
                        <td>{t('inv.cat.' + i.category)}</td>
                        <td className="num">
                          <strong>{num(i.balance, 2)}</strong>
                        </td>
                        <td>{i.unit}</td>
                        <td className="num">{i.lowStockThreshold === null ? '—' : num(i.lowStockThreshold, 2)}</td>
                        <td>
                          {!i.active ? <span className="badge">{t('common.inactive')}</span> : i.balance < 0 ? <span className="badge bad">{'< 0'}</span> : i.isLow ? <span className="badge warn">{t('inv.low')}</span> : <span className="badge good">OK</span>}
                        </td>
                        <td className="nowrap">
                          <button className="btn sm" onClick={() => setRecord(i)}>
                            {t('inv.record')}
                          </button>
                          {isAdmin && (
                            <button className="icon-btn" title={t('common.edit')} onClick={() => setEditing(i)}>
                              <Pencil size={16} />
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
        {tab === 'history' && (
          <Card title={`${t('inv.history')} — ${t('common.last90')}`}>
            {!txns || txns.length === 0 ? (
              <Empty text={t('common.noData')} />
            ) : (
              <div className="table-wrap" style={{ maxHeight: 620, overflowY: 'auto' }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th>
                      <th>{t('inv.item')}</th>
                      <th>{t('common.type')}</th>
                      <th className="num">{t('common.quantity')}</th>
                      <th>{t('inv.batchNo')}</th>
                      <th>{t('common.cage')}</th>
                      <th>{t('inv.supplier')} / {t('inv.reference')}</th>
                      <th>{t('common.notes')}</th>
                      <th>{t('common.recordedBy')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txns.map((x) => (
                      <tr key={x.id}>
                        <td className="nowrap">{date(x.txnDate)}</td>
                        <td>{x.itemName}</td>
                        <td>
                          {t('txn.' + x.type)}
                          {x.sourceType && <span className="muted small"> · {t('inv.linked')}</span>}
                        </td>
                        <td className="num nowrap" style={{ color: x.quantity < 0 ? 'var(--bad)' : 'var(--good)' }}>
                          {x.quantity > 0 ? '+' : ''}
                          {num(x.quantity, 2)} {x.unit}
                        </td>
                        <td>{x.batchNo}</td>
                        <td>{x.cageName}</td>
                        <td>{[x.supplier, x.reference].filter(Boolean).join(' · ')}</td>
                        <td>{x.notes}</td>
                        <td>{x.recordedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
        {tab === 'batches' && (
          <Card>
            {!batches || batches.length === 0 ? (
              <Empty text={t('common.noData')} />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('inv.item')}</th>
                      <th>{t('inv.batchNo')}</th>
                      <th>{t('inv.expiryDate')}</th>
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
                        <td className="num">{b.daysToExpiry === null ? '—' : b.daysToExpiry < 0 ? <span className="badge bad">{t('inv.expired')}</span> : b.daysToExpiry}</td>
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
      {record && <RecordTxn items={(items ?? []).filter((i) => i.active)} initial={record === 'any' ? null : record} onClose={() => setRecord(null)} />}
      {editing && <ItemForm item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

const USER_TYPES: TxnType[] = ['purchase', 'receipt', 'usage', 'issue', 'return', 'wastage', 'expired']

function RecordTxn({ items, initial, onClose }: { items: InventoryBalance[]; initial: InventoryBalance | null; onClose: () => void }) {
  const { t, num, toast, fail, isAdmin, workDate, status } = useApp()
  const [itemId, setItemId] = useState<number | null>(initial?.id ?? items[0]?.id ?? null)
  const [type, setType] = useState<TxnType>('purchase')
  const [quantity, setQuantity] = useState<number | null>(null)
  const [txDate, setTxDate] = useState(workDate)
  const [batchNo, setBatchNo] = useState('')
  const [expiry, setExpiry] = useState('')
  const [unitCost, setUnitCost] = useState<number | null>(null)
  const [supplier, setSupplier] = useState('')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const { data: batches } = useLoad(() => (itemId ? call('inventory.batches', { itemId, onlyInStock: true }) : Promise.resolve([])), [itemId])
  const item = items.find((i) => i.id === itemId)
  const isMed = item?.category === 'medicine'
  const incoming = ['purchase', 'receipt', 'return', 'opening'].includes(type)
  const types = isAdmin ? [...USER_TYPES, 'adjustment' as TxnType] : USER_TYPES
  const ok =
    itemId !== null &&
    quantity !== null &&
    quantity !== 0 &&
    (type === 'adjustment' ? notes.trim().length >= 3 : quantity > 0) &&
    (!isMed || !['purchase', 'receipt'].includes(type) || batchNo.trim().length > 0)
  return (
    <Modal
      wide
      title={t('inv.record')}
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
                await call('inventory.record', { itemId: itemId!, type, quantity: quantity!, date: txDate, batchNo: nz(batchNo), expiryDate: expiry || null, unitCost, supplier: nz(supplier), reference: nz(reference), notes: nz(notes), cageId: null })
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
          <Field label={t('inv.item')} required>
            <select className="select" value={itemId ?? ''} onChange={(e) => setItemId(Number(e.target.value))}>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({num(i.balance, 2)} {i.unit})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.type')}>
            <select className="select" value={type} onChange={(e) => setType(e.target.value as TxnType)}>
              {types.map((x) => (
                <option key={x} value={x}>
                  {t('txn.' + x)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`${t('common.quantity')}${item ? ` (${item.unit})` : ''}`} required hint={type === 'adjustment' ? '+ / −' : undefined}>
            <NumInput decimals allowNegative={type === 'adjustment'} value={quantity} onChange={setQuantity} />
          </Field>
          <Field label={t('common.date')}>
            <input className="input" type="date" value={txDate} max={status.today} onChange={(e) => setTxDate(e.target.value)} />
          </Field>
        </div>
        {type === 'adjustment' && <Notice tone="warn">{t('inv.adjustHint')}</Notice>}
        {isMed && (
          <div className="form-grid">
            <Field label={t('inv.batchNo')} required={['purchase', 'receipt'].includes(type)}>
              <input className="input" list="batch-list" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
              <datalist id="batch-list">
                {batches?.map((b) => (
                  <option key={b.id} value={b.batchNo} />
                ))}
              </datalist>
            </Field>
            {incoming && (
              <Field label={t('inv.expiryDate')}>
                <input className="input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
              </Field>
            )}
          </div>
        )}
        {incoming && (
          <div className="form-grid">
            <Field label={t('inv.unitCost')}>
              <NumInput decimals value={unitCost} onChange={setUnitCost} />
            </Field>
            <Field label={t('inv.supplier')}>
              <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </Field>
            <Field label={t('inv.reference')}>
              <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label={type === 'adjustment' ? t('common.reason') : t('common.notes')} required={type === 'adjustment'}>
          <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function ItemForm({ item, onClose }: { item: InventoryBalance | null; onClose: () => void }) {
  const { t, toast, fail, status } = useApp()
  const [f, setF] = useState<ItemInputDto>(item ? { category: item.category, name: item.name, unit: item.unit, lowStockThreshold: item.lowStockThreshold, active: item.active, notes: item.notes } : { category: 'feed', name: '', unit: 'kg', lowStockThreshold: null, active: true, notes: null })
  const units = f.category === 'medicine' ? status.settings.medicineUnits : f.category === 'feed' ? ['kg'] : ['pcs', 'kg', 'L', 'boxes']
  return (
    <Modal
      title={item ? t('inv.editItem') : t('inv.addItem')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!f.name.trim() || !f.unit.trim()}
            onClick={async () => {
              try {
                if (item) await call('inventory.updateItem', { id: item.id, item: f })
                else await call('inventory.createItem', f)
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
      <div className="form-grid">
        <Field label={t('inv.category')}>
          <select className="select" value={f.category} disabled={!!item} onChange={(e) => setF({ ...f, category: e.target.value as InventoryCategory, unit: e.target.value === 'feed' ? 'kg' : e.target.value === 'medicine' ? 'ml' : 'pcs' })}>
            <option value="feed">{t('inv.cat.feed')}</option>
            <option value="medicine">{t('inv.cat.medicine')}</option>
            <option value="supply">{t('inv.cat.supply')}</option>
          </select>
        </Field>
        <Field label={t('common.name')} required>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t('common.unit')} required>
          <input className="input" list="unit-list" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
          <datalist id="unit-list">
            {units.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </Field>
        <Field label={t('inv.lowThreshold')}>
          <NumInput decimals value={f.lowStockThreshold} onChange={(v) => setF({ ...f, lowStockThreshold: v })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          {t('common.active')}
        </label>
      </div>
    </Modal>
  )
}
