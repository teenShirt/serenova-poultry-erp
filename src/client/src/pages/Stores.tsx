import { useMemo, useState } from 'react'
import { ArrowLeftRight, ClipboardCheck, Pencil, Plus, Warehouse as StoreIcon } from 'lucide-react'
import { addDays } from '@shared/dates'
import type { StoreBalance, Warehouse } from '@shared/stores'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, NumInput, PageHeader, Tabs, nz } from '../components/ui'

/** Stores (warehouses) of the farm being worked on: stock per store, transfers and stock counts. */
export function StoresPage() {
  const { t, can } = useApp()
  const [tab, setTab] = useState<'stock' | 'counts' | 'stores'>('stock')
  const [transfer, setTransfer] = useState(false)
  const [count, setCount] = useState(false)
  return (
    <div className="page stack">
      <PageHeader title={t('stores.title')} icon={<StoreIcon size={26} color="var(--brand)" />}>
        {can('inventory.transfer') && (
          <button className="btn" onClick={() => setTransfer(true)}>
            <ArrowLeftRight size={18} /> {t('stores.transfer')}
          </button>
        )}
        {can('inventory.adjust') && (
          <button className="btn primary" onClick={() => setCount(true)}>
            <ClipboardCheck size={18} /> {t('stores.count')}
          </button>
        )}
      </PageHeader>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'stock', label: t('stores.stock') },
          { value: 'counts', label: t('stores.counts') },
          { value: 'stores', label: t('stores.stores') }
        ]}
      />
      {tab === 'stock' && <StockTab />}
      {tab === 'counts' && <CountsTab />}
      {tab === 'stores' && <StoresTab />}
      {transfer && <TransferDialog onClose={() => setTransfer(false)} />}
      {count && <CountDialog onClose={() => setCount(false)} />}
    </div>
  )
}

function StockTab() {
  const { t, num, status } = useApp()
  const { data: stores } = useLoad(() => call('stores.list', { includeInactive: false }), [])
  const own = (stores ?? []).filter((w) => w.farmId === status.farm?.id)
  const [warehouseId, setWarehouseId] = useState<number | null>(null)
  const { data: rows } = useLoad(() => call('stores.balances', { warehouseId }), [warehouseId])
  const money = (n: number | null) => (n === null ? '—' : `${status.settings.currency} ${num(n, 2)}`)
  const total = (rows ?? []).reduce((s, r) => s + (r.value ?? 0), 0)
  const shown = rows ?? []
  return (
    <Card
      title={t('stores.stockTitle')}
      actions={
        <select className="select" value={warehouseId ?? ''} onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : null)} style={{ maxWidth: 260 }}>
          <option value="">{t('stores.allStores')}</option>
          {own.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      }
    >
      <div className="muted small" style={{ marginBottom: 8 }}>
        {t('stores.valueHint')}
      </div>
      {!rows ? null : shown.length === 0 ? (
        <Empty text={t('common.noData')} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('stores.store')}</th>
                <th>{t('inv.item')}</th>
                <th>{t('inv.sku')}</th>
                <th className="num">{t('inv.balance')}</th>
                <th className="num">{t('stores.avgCost')}</th>
                <th className="num">{t('stores.value')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r: StoreBalance) => (
                <tr key={`${r.warehouseId}-${r.itemId}`}>
                  <td>{r.warehouseName}</td>
                  <td>
                    <strong>{r.itemName}</strong> <span className="muted small">{t('inv.cat.' + r.category)}</span>
                  </td>
                  <td className="muted">{r.sku ?? '—'}</td>
                  <td className="num">
                    {num(r.balance, 2)} {r.unit}
                  </td>
                  <td className="num">{money(r.avgCost)}</td>
                  <td className="num">{money(r.value)}</td>
                  <td>
                    {r.isLow && <span className="badge bad">{t('inv.low')}</span>} {r.needsReorder && <span className="badge warn">{t('stores.reorder')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={5}>{t('stores.totalValue')}</th>
                <th className="num">{money(total)}</th>
                <th />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  )
}

function CountsTab() {
  const { t, num, date, status } = useApp()
  const from = addDays(status.today, -89)
  const { data: counts } = useLoad(() => call('stores.counts', { from, to: status.today }), [from])
  return (
    <Card title={t('stores.countsTitle')}>
      {!counts || counts.length === 0 ? (
        <Empty text={t('stores.noCounts')} />
      ) : (
        counts.map((c) => (
          <div key={c.id} className="stack" style={{ marginBottom: 18 }}>
            <div>
              <strong>{date(c.date)}</strong> · {c.warehouseName} · {c.countedBy ?? '—'}
              {c.notes && <span className="muted"> · {c.notes}</span>}
            </div>
            <table className="data">
              <thead>
                <tr>
                  <th>{t('inv.item')}</th>
                  <th>{t('inv.batchNo')}</th>
                  <th className="num">{t('stores.systemQty')}</th>
                  <th className="num">{t('stores.countedQty')}</th>
                  <th className="num">{t('stores.difference')}</th>
                </tr>
              </thead>
              <tbody>
                {c.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.itemName}</td>
                    <td>{l.batchNo ?? '—'}</td>
                    <td className="num">{num(l.systemQty, 2)}</td>
                    <td className="num">{num(l.countedQty, 2)}</td>
                    <td className={`num ${l.difference < 0 ? 'bad' : ''}`}>
                      {l.difference > 0 ? '+' : ''}
                      {num(l.difference, 2)} {l.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </Card>
  )
}

function StoresTab() {
  const { t, can, status } = useApp()
  const { data: stores } = useLoad(() => call('stores.list', { includeInactive: true }), [])
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null)
  const sub = status.subscription
  const used = (stores ?? []).filter((w) => w.active).length
  const atLimit = !!sub && used >= sub.limits.maxWarehouses
  return (
    <Card
      title={t('stores.stores')}
      actions={
        can('stores.manage') ? (
          <button className="btn primary" disabled={atLimit} title={atLimit ? t('stores.atLimit', { n: sub!.limits.maxWarehouses }) : undefined} onClick={() => setEditing('new')}>
            <Plus size={18} /> {t('stores.add')}
          </button>
        ) : undefined
      }
    >
      {sub && <div className="muted small" style={{ marginBottom: 8 }}>{t('stores.usage', { used, max: sub.limits.maxWarehouses, plan: sub.planName })}</div>}
      <table className="data">
        <thead>
          <tr>
            <th>{t('cage.code')}</th>
            <th>{t('cage.name')}</th>
            <th>{t('farm.name')}</th>
            <th>{t('common.status')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {stores?.map((w) => (
            <tr key={w.id}>
              <td>{w.code}</td>
              <td>
                <strong>{w.name}</strong> {w.isMain && <span className="badge info">{t('stores.main')}</span>}
              </td>
              <td>{w.farmName}</td>
              <td>{w.active ? <span className="badge good">{t('common.active')}</span> : <span className="badge">{t('common.inactive')}</span>}</td>
              <td>
                {can('stores.manage') && w.farmId === status.farm?.id && (
                  <button className="icon-btn" title={t('common.edit')} onClick={() => setEditing(w)}>
                    <Pencil size={16} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Notice tone="info">{t('stores.mainHint')}</Notice>
      {editing && <StoreForm store={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function StoreForm({ store, onClose }: { store: Warehouse | null; onClose: () => void }) {
  const { t, toast, fail } = useApp()
  const [f, setF] = useState({ code: store?.code ?? '', name: store?.name ?? '', active: store?.active ?? true, notes: store?.notes ?? null })
  return (
    <Modal
      title={store ? store.name : t('stores.add')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!f.code.trim() || !f.name.trim()}
            onClick={async () => {
              try {
                await call('stores.save', { id: store?.id ?? null, ...f })
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
          <Field label={t('cage.name')} required>
            <input className="input" value={f.name} maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
        </div>
        {!store?.isMain && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            {t('common.active')}
          </label>
        )}
        <Field label={t('common.notes')}>
          <input className="input" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: nz(e.target.value) })} />
        </Field>
      </div>
    </Modal>
  )
}

function TransferDialog({ onClose }: { onClose: () => void }) {
  const { t, num, status, toast, fail } = useApp()
  const { data: stores } = useLoad(() => call('stores.list', { includeInactive: false }), [])
  const own = (stores ?? []).filter((w) => w.farmId === status.farm?.id)
  const [from, setFrom] = useState<number | null>(null)
  const [to, setTo] = useState<number | null>(null)
  const fromId = from ?? own[0]?.id ?? null
  const { data: bal } = useLoad(() => (fromId ? call('stores.balances', { warehouseId: fromId }) : Promise.resolve([])), [fromId])
  const available = useMemo(() => (bal ?? []).filter((b) => b.balance > 0), [bal])
  const [lines, setLines] = useState<{ itemId: number; quantity: number; batchNo: string | null }[]>([])
  const [date, setDate] = useState(status.today)
  const [notes, setNotes] = useState('')
  const valid = fromId && to && fromId !== to && lines.length > 0 && lines.every((l) => l.quantity > 0 && l.quantity <= (available.find((b) => b.itemId === l.itemId)?.balance ?? 0))
  return (
    <Modal
      wide
      title={t('stores.transfer')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!valid}
            onClick={async () => {
              try {
                const ref = await call('stores.transfer', { date, fromWarehouseId: fromId!, toWarehouseId: to!, notes: nz(notes), lines })
                toast('success', t('stores.transferred', { ref }))
                onClose()
              } catch (e) {
                fail(e)
              }
            }}
          >
            <ArrowLeftRight size={17} /> {t('stores.transfer')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('common.date')}>
            <input className="input" type="date" max={status.today} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('stores.from')}>
            <select className="select" value={fromId ?? ''} onChange={(e) => (setFrom(Number(e.target.value)), setLines([]))}>
              {own.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('stores.to')}>
            <select className="select" value={to ?? ''} onChange={(e) => setTo(e.target.value ? Number(e.target.value) : null)}>
              <option value="">—</option>
              {stores
                ?.filter((w) => w.id !== fromId)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.farmName})
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>{t('inv.item')}</th>
              <th className="num">{t('stores.available')}</th>
              <th className="num">{t('common.quantity')}</th>
              <th>{t('inv.batchNo')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const b = available.find((x) => x.itemId === l.itemId)
              return (
                <tr key={i}>
                  <td>
                    <select className="select" value={l.itemId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: Number(e.target.value) } : x)))}>
                      {available.map((a) => (
                        <option key={a.itemId} value={a.itemId}>
                          {a.itemName}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    {num(b?.balance ?? 0, 2)} {b?.unit}
                  </td>
                  <td style={{ width: 140 }}>
                    <NumInput decimals value={l.quantity || null} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: v ?? 0 } : x)))} />
                  </td>
                  <td style={{ width: 160 }}>
                    <input className="input" value={l.batchNo ?? ''} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, batchNo: nz(e.target.value) } : x)))} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div>
          <button className="btn sm" disabled={!available.length} onClick={() => setLines([...lines, { itemId: available[0].itemId, quantity: 0, batchNo: null }])}>
            <Plus size={16} /> {t('pur.addLine')}
          </button>
        </div>
        <Field label={t('common.notes')}>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function CountDialog({ onClose }: { onClose: () => void }) {
  const { t, num, status, toast, fail } = useApp()
  const { data: stores } = useLoad(() => call('stores.list', { includeInactive: false }), [])
  const own = (stores ?? []).filter((w) => w.farmId === status.farm?.id)
  const [store, setStore] = useState<number | null>(null)
  const storeId = store ?? own[0]?.id ?? null
  const { data: bal } = useLoad(() => (storeId ? call('stores.balances', { warehouseId: storeId }) : Promise.resolve([])), [storeId])
  const [counted, setCounted] = useState<Record<number, number | null>>({})
  const [notes, setNotes] = useState('')
  const lines = (bal ?? []).filter((b) => counted[b.itemId] !== undefined && counted[b.itemId] !== null)
  return (
    <Modal
      wide
      title={t('stores.count')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!storeId || lines.length === 0}
            onClick={async () => {
              try {
                await call('stores.count', {
                  warehouseId: storeId!,
                  date: status.today,
                  notes: nz(notes),
                  lines: lines.map((b) => ({ itemId: b.itemId, batchId: null, countedQty: counted[b.itemId] ?? 0 }))
                })
                toast('success', t('stores.counted'))
                onClose()
              } catch (e) {
                fail(e)
              }
            }}
          >
            <ClipboardCheck size={17} /> {t('stores.postCount')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Notice tone="info">{t('stores.countHint')}</Notice>
        <Field label={t('stores.store')}>
          <select className="select" value={storeId ?? ''} onChange={(e) => (setStore(Number(e.target.value)), setCounted({}))}>
            {own.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <table className="data">
          <thead>
            <tr>
              <th>{t('inv.item')}</th>
              <th className="num">{t('stores.systemQty')}</th>
              <th className="num">{t('stores.countedQty')}</th>
              <th className="num">{t('stores.difference')}</th>
            </tr>
          </thead>
          <tbody>
            {(bal ?? []).map((b) => {
              const c = counted[b.itemId]
              const diff = c === undefined || c === null ? null : c - b.balance
              return (
                <tr key={b.itemId}>
                  <td>{b.itemName}</td>
                  <td className="num">
                    {num(b.balance, 2)} {b.unit}
                  </td>
                  <td style={{ width: 150 }}>
                    <NumInput decimals value={c ?? null} onChange={(v) => setCounted({ ...counted, [b.itemId]: v })} />
                  </td>
                  <td className={`num ${diff !== null && diff < 0 ? 'bad' : ''}`}>{diff === null ? '' : `${diff > 0 ? '+' : ''}${num(diff, 2)}`}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <Field label={t('common.notes')}>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
