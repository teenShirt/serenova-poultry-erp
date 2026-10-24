import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ban, Check, ClipboardList, PackagePlus, Plus, Trash2, Truck, X } from 'lucide-react'
import type { ReceiptDto } from '@shared/api'
import { addDays } from '@shared/dates'
import type { GoodsReceipt } from '@shared/types'
import type { PurchaseOrder } from '@shared/stores'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, NumInput, PageHeader, ReasonDialog, nz } from '../components/ui'
import { RangePicker, SERIES, TimeChart } from '../components/charts'
import { Kpi } from '../components/Kpi'
import { PartyDialog, PartyList } from './Sales'
import { CsvButton } from '../components/Export'

export function PurchasesPage() {
  const { t, num, status, can, date } = useApp()
  const [days, setDays] = useState(30)
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(params.get('new') === '1')
  const [cancel, setCancel] = useState<GoodsReceipt | null>(null)
  const [rejecting, setRejecting] = useState<GoodsReceipt | null>(null)
  const { fail, toast } = useApp()
  const to = status.today
  const from = addDays(to, -(days - 1))
  const { data: receipts } = useLoad(() => call('purchases.list', { from, to }), [from, to])
  const { data: series } = useLoad(() => call('purchases.series', { from, to }), [from, to])
  const { data: feedItems } = useLoad(() => call('inventory.balances', { category: 'feed' }), [])
  const money = (n: number | null | undefined) => `${status.settings.currency} ${num(n ?? 0, 2)}`
  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true)
      setParams({}, { replace: true })
    }
  }, [params, setParams])

  const received = (series ?? []).reduce((s, d) => s + d.feedKg, 0)
  const cost = (series ?? []).reduce((s, d) => s + d.cost, 0)
  const feedNow = (feedItems ?? []).reduce((s, i) => s + i.balance, 0)

  return (
    <div className="page">
      <PageHeader title={t('pur.title')} icon={<PackagePlus size={26} color="var(--brand)" />}>
        <RangePicker days={days} onChange={setDays} />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={18} /> {t('pur.new')}
        </button>
      </PageHeader>
      <div className="stack">
        <div className="grid stats">
          <Kpi label={t('pur.feedReceived')} value={`${num(received)} kg`} trend={series?.map((d) => d.feedKg)} color={SERIES.aqua} sub={t('common.last' + days)} />
          <Kpi label={t('pur.cost')} value={money(cost)} trend={series?.map((d) => d.cost)} color={SERIES.orange} />
          <Kpi label={t('dash.feedStock')} value={`${num(feedNow)} kg`} trend={series?.map((d) => d.feedStockKg)} color={SERIES.blue} tone={feedItems?.some((i) => i.isLow) ? 'warn' : undefined} sub={feedItems?.some((i) => i.isLow) ? t('inv.low') : undefined} />
          <Kpi label={t('pur.deliveries')} value={num(receipts?.length ?? 0)} />
        </div>
        <div className="grid cols-2">
          <TimeChart
            title={t('pur.inOut')}
            data={series ?? []}
            kind="bar"
            unit="kg"
            series={[
              { key: 'feedKg', label: t('pur.received'), color: SERIES.aqua },
              { key: 'feedIssuedKg', label: t('pur.issued'), color: SERIES.orange }
            ]}
          />
          <TimeChart title={t('pur.storeTrend')} data={series ?? []} unit="kg" series={[{ key: 'feedStockKg', label: t('dash.feedStock'), color: SERIES.blue }]} />
        </div>
        <Card title={t('pur.list')} actions={<CsvButton kind="receipts" from={from} to={to} />}>
          {!receipts || receipts.length === 0 ? (
            <Empty text={t('common.noData')}>
              <button className="btn primary" onClick={() => setCreating(true)}>
                <Plus size={18} /> {t('pur.new')}
              </button>
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('pur.grn')}</th>
                    <th>{t('common.date')}</th>
                    <th>{t('pur.supplier')}</th>
                    <th>{t('pur.items')}</th>
                    <th>{t('pur.invoice')}</th>
                    <th className="num">{t('pur.total')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('common.recordedBy')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">
                        <strong>{r.grnNo}</strong>
                        <div className="small muted">
                          {r.warehouseName}
                          {r.poNo && ` · ${r.poNo}`}
                        </div>
                      </td>
                      <td className="nowrap">{date(r.date)}</td>
                      <td>{r.supplierName ?? '—'}</td>
                      <td>
                        {r.lines.map((l, i) => (
                          <div key={i} className="small">
                            {l.itemName}: <strong>{num(l.quantity - l.rejectedQty - l.damagedQty, 2)} {l.unit}</strong>
                            {l.orderedQty !== null && <span className="muted"> / {num(l.orderedQty, 2)}</span>}
                            {l.batchNo && <span className="muted"> · {l.batchNo}</span>}
                            {l.rejectedQty + l.damagedQty > 0 && (
                              <span className="badge warn" title={l.rejectReason ?? ''}>
                                {t('pur.notAccepted', { n: num(l.rejectedQty + l.damagedQty, 2) })}
                              </span>
                            )}
                          </div>
                        ))}
                      </td>
                      <td>
                        {r.invoiceNo}
                        {r.vehicle && <div className="small muted">{r.vehicle}</div>}
                      </td>
                      <td className="num">{money(r.totalCost)}</td>
                      <td>
                        <span className={`badge ${r.status === 'posted' ? 'good' : r.status === 'submitted' ? 'warn' : 'bad'}`}>{t('pur.status.' + r.status)}</span>
                        {r.approvedBy && <div className="small muted">{t('pur.approvedBy', { name: r.approvedBy })}</div>}
                        {r.cancelReason && <div className="small muted">{r.cancelReason}</div>}
                      </td>
                      <td>{r.recordedBy}</td>
                      <td className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                        {r.status === 'submitted' && can('purchases.approve') && (
                          <>
                            <button
                              className="icon-btn"
                              title={t('pur.approve')}
                              onClick={async () => {
                                try {
                                  await call('purchases.approve', { id: r.id })
                                  toast('success', t('pur.approved'))
                                } catch (e) {
                                  fail(e)
                                }
                              }}
                            >
                              <Check size={16} />
                            </button>
                            <button className="icon-btn" title={t('pur.reject')} onClick={() => setRejecting(r)}>
                              <X size={16} />
                            </button>
                          </>
                        )}
                        {(r.status === 'posted' || r.status === 'submitted') && can('purchases.cancel') && (
                          <button className="icon-btn" title={t('pur.cancel')} onClick={() => setCancel(r)}>
                            <Ban size={16} />
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
        <OrdersCard />
        <PartyList kind="supplier" />
      </div>
      {creating && <ReceiptDialog onClose={() => setCreating(false)} />}
      {rejecting && (
        <ReasonDialog
          title={`${t('pur.reject')} — ${rejecting.grnNo}`}
          danger
          confirmLabel={t('pur.reject')}
          onClose={() => setRejecting(null)}
          onSubmit={(reason) => call('purchases.reject', { id: rejecting.id, reason })}
        />
      )}
      {cancel && (
        <ReasonDialog
          title={`${t('pur.cancel')} — ${cancel.grnNo}`}
          hint={t('pur.cancelHint')}
          danger
          confirmLabel={t('pur.cancel')}
          onClose={() => setCancel(null)}
          onSubmit={(reason) => call('purchases.cancel', { id: cancel.id, reason })}
        />
      )}
    </div>
  )
}

type Line = ReceiptDto['lines'][number]
const emptyLine = (itemId: number): Line => ({ itemId, quantity: 0, unitCost: null, batchNo: null, expiryDate: null, rejectedQty: 0, damagedQty: 0, rejectReason: null, poLineId: null })

function ReceiptDialog({ onClose, order }: { onClose: () => void; order?: PurchaseOrder }) {
  const { t, num, status, toast, fail } = useApp()
  const { data: items } = useLoad(() => call('inventory.items', {}), [])
  const { data: suppliers, reload } = useLoad(() => call('parties.list', { kind: 'supplier' }), [])
  const active = (items ?? []).filter((i) => i.active)
  const [date, setDate] = useState(status.today)
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [invoiceNo, setInvoiceNo] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [notes, setNotes] = useState('')
  const [deliveryNote, setDeliveryNote] = useState('')
  const { data: stores } = useLoad(() => call('stores.list', { includeInactive: false }), [])
  const own = (stores ?? []).filter((w) => w.farmId === status.farm?.id)
  const [warehouseId, setWarehouseId] = useState<number | null>(order?.warehouseId ?? null)
  // One key per form: sending it twice (double click, retry) records the delivery once.
  const [clientRef] = useState(() => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()))
  const [lines, setLines] = useState<Line[]>(() =>
    order
      ? order.lines
          .filter((l) => l.received < l.quantity)
          .map((l) => ({ ...emptyLine(l.itemId), poLineId: l.id, quantity: Math.round((l.quantity - l.received) * 1000) / 1000, unitCost: l.unitCost }))
      : []
  )
  const [newSupplier, setNewSupplier] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (lines.length === 0 && active.length) setLines([emptyLine(active.find((i) => i.category === 'feed')?.id ?? active[0].id)])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.length])
  const upd = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)))
  const accepted = (l: Line) => l.quantity - (l.rejectedQty ?? 0) - (l.damagedQty ?? 0)
  const total = lines.reduce((s, l) => s + accepted(l) * (l.unitCost ?? 0), 0)
  const itemOf = (id: number) => active.find((x) => x.id === id)
  const valid =
    lines.length > 0 &&
    lines.every(
      (l) =>
        l.quantity > 0 &&
        accepted(l) >= 0 &&
        (accepted(l) === l.quantity || (l.rejectReason ?? '').trim().length >= 3) &&
        (itemOf(l.itemId)?.category !== 'medicine' || (l.batchNo ?? '').trim())
    )
  return (
    <Modal
      wide
      title={order ? `${t('pur.new')} — ${order.poNo}` : t('pur.new')}
      onClose={onClose}
      footer={
        <>
          <span className="grow">
            {t('pur.total')}: <strong>{`${status.settings.currency} ${num(total, 2)}`}</strong>
          </span>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await call('purchases.create', {
                  date,
                  supplierId: order ? order.supplierId : supplierId,
                  invoiceNo: nz(invoiceNo),
                  vehicle: nz(vehicle),
                  notes: nz(notes),
                  deliveryNote: nz(deliveryNote),
                  warehouseId,
                  poId: order?.id ?? null,
                  clientRef,
                  lines: lines.map((l) => ({ ...l, batchNo: l.batchNo?.trim() || null, rejectReason: l.rejectReason?.trim() || null }))
                })
                toast('success', t(r.status === 'submitted' ? 'pur.savedForApproval' : 'pur.saved', { no: r.grnNo }))
                onClose()
              } catch (e) {
                fail(e)
              } finally {
                setBusy(false)
              }
            }}
          >
            <Truck size={18} /> {t('pur.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('common.date')} required>
            <input className="input" type="date" value={date} max={status.today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('stores.store')}>
            <select className="select" value={warehouseId ?? ''} onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('stores.mainDefault')}</option>
              {own.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('pur.supplier')}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <select className="select" disabled={!!order} value={order ? order.supplierId : (supplierId ?? '')} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">—</option>
                {suppliers
                  ?.filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <button className="btn sm" type="button" onClick={() => setNewSupplier(true)} title={t('party.newSupplier')}>
                <Plus size={16} />
              </button>
            </div>
          </Field>
          <Field label={t('pur.invoice')}>
            <input className="input" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          </Field>
          <Field label={t('pur.vehicle')}>
            <input className="input" value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
          </Field>
          <Field label={t('pur.deliveryNote')}>
            <input className="input" value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} />
          </Field>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('inv.item')}</th>
                <th className="num">{t('pur.delivered')}</th>
                <th className="num">{t('pur.rejected')}</th>
                <th className="num">{t('pur.damaged')}</th>
                <th className="num">{t('inv.unitCost')}</th>
                <th>{t('inv.batchNo')}</th>
                <th>{t('inv.expiryDate')}</th>
                <th className="num">{t('pur.lineTotal')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const item = itemOf(l.itemId)
                const med = item?.category === 'medicine'
                return (
                  <tr key={i}>
                    <td>
                      <select className="select" disabled={!!l.poLineId} value={l.itemId} onChange={(e) => upd(i, { itemId: Number(e.target.value), batchNo: null, expiryDate: null })}>
                        {active.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name} ({t('inv.cat.' + it.category)})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ width: 140 }}>
                      <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                        <NumInput decimals value={l.quantity || null} onChange={(v) => upd(i, { quantity: v ?? 0 })} />
                        <span className="small muted">{item?.unit}</span>
                      </div>
                    </td>
                    <td style={{ width: 100 }}>
                      <NumInput decimals value={l.rejectedQty || null} onChange={(v) => upd(i, { rejectedQty: v ?? 0 })} />
                    </td>
                    <td style={{ width: 100 }}>
                      <NumInput decimals value={l.damagedQty || null} onChange={(v) => upd(i, { damagedQty: v ?? 0 })} />
                      {accepted(l) !== l.quantity && (
                        <input
                          className={`input ${(l.rejectReason ?? '').trim().length < 3 ? 'invalid' : ''}`}
                          placeholder={t('common.reason')}
                          value={l.rejectReason ?? ''}
                          onChange={(e) => upd(i, { rejectReason: e.target.value })}
                          style={{ marginTop: 4 }}
                        />
                      )}
                    </td>
                    <td style={{ width: 120 }}>
                      <NumInput decimals value={l.unitCost} onChange={(v) => upd(i, { unitCost: v })} />
                    </td>
                    <td style={{ width: 130 }}>
                      <input className={`input ${med && !(l.batchNo ?? '').trim() ? 'invalid' : ''}`} disabled={!med} value={l.batchNo ?? ''} onChange={(e) => upd(i, { batchNo: e.target.value })} />
                    </td>
                    <td style={{ width: 160 }}>
                      <input className="input" type="date" disabled={!med} value={l.expiryDate ?? ''} onChange={(e) => upd(i, { expiryDate: e.target.value || null })} />
                    </td>
                    <td className="num nowrap">{num(accepted(l) * (l.unitCost ?? 0), 2)}</td>
                    <td>
                      {lines.length > 1 && (
                        <button className="icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={t('common.delete')}>
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {!order && (
          <div>
            <button className="btn sm" onClick={() => active.length && setLines([...lines, emptyLine(active[0].id)])}>
              <Plus size={16} /> {t('pur.addLine')}
            </button>
          </div>
        )}
        {status.settings.grnApprovalRequired && <Notice tone="info">{t('pur.approvalHint')}</Notice>}
        {lines.some((l) => itemOf(l.itemId)?.category === 'medicine') && <Notice tone="info">{t('err.batch_required')}</Notice>}
        <Field label={t('common.notes')}>
          <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      {newSupplier && (
        <PartyDialog
          kind="supplier"
          party={null}
          onClose={async (id) => {
            setNewSupplier(false)
            if (id) {
              reload()
              setSupplierId(id)
            }
          }}
        />
      )}
    </Modal>
  )
}


/** Purchase orders: what was ordered, what has been received against each line, and receiving the rest. */
function OrdersCard() {
  const { t, num, date, can, status } = useApp()
  const [showAll, setShowAll] = useState(false)
  const { data: orders } = useLoad(() => call('purchases.orders', { openOnly: !showAll }), [showAll])
  const [creating, setCreating] = useState(false)
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null)
  const [closing, setClosing] = useState<{ o: PurchaseOrder; status: 'closed' | 'cancelled' } | null>(null)
  const money = (n: number) => `${status.settings.currency} ${num(n, 2)}`
  return (
    <Card
      title={t('po.title')}
      actions={
        <div className="row" style={{ gap: 10 }}>
          <label className="check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            {t('po.showAll')}
          </label>
          {can('purchases.record') && (
            <button className="btn" onClick={() => setCreating(true)}>
              <ClipboardList size={17} /> {t('po.new')}
            </button>
          )}
        </div>
      }
    >
      {!orders || orders.length === 0 ? (
        <Empty text={t('po.none')} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('po.no')}</th>
                <th>{t('common.date')}</th>
                <th>{t('pur.supplier')}</th>
                <th>{t('stores.store')}</th>
                <th>{t('pur.items')}</th>
                <th className="num">{t('pur.total')}</th>
                <th>{t('common.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="nowrap">
                    <strong>{o.poNo}</strong>
                  </td>
                  <td className="nowrap">
                    {date(o.orderDate)}
                    {o.expectedDate && <div className="small muted">{t('po.expected', { date: date(o.expectedDate) })}</div>}
                  </td>
                  <td>{o.supplierName}</td>
                  <td>{o.warehouseName}</td>
                  <td>
                    {o.lines.map((l) => (
                      <div key={l.id} className="small">
                        {l.itemName}: <strong>{num(l.received, 2)}</strong> / {num(l.quantity, 2)} {l.unit}
                      </div>
                    ))}
                  </td>
                  <td className="num">{money(o.total)}</td>
                  <td>
                    <span className={`badge ${o.status === 'received' ? 'good' : o.status === 'partial' ? 'warn' : o.status === 'open' ? 'info' : ''}`}>{t('po.status.' + o.status)}</span>
                  </td>
                  <td className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                    {(o.status === 'open' || o.status === 'partial') && can('purchases.record') && (
                      <>
                        <button className="btn sm primary" onClick={() => setReceiving(o)}>
                          <Truck size={14} /> {t('po.receive')}
                        </button>
                        <button className="btn sm" onClick={() => setClosing({ o, status: o.status === 'open' ? 'cancelled' : 'closed' })}>
                          {t(o.status === 'open' ? 'po.cancel' : 'po.close')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <OrderDialog onClose={() => setCreating(false)} />}
      {receiving && <ReceiptDialog order={receiving} onClose={() => setReceiving(null)} />}
      {closing && (
        <ReasonDialog
          title={`${t(closing.status === 'cancelled' ? 'po.cancel' : 'po.close')} — ${closing.o.poNo}`}
          onClose={() => setClosing(null)}
          onSubmit={(reason) => call('purchases.closeOrder', { id: closing.o.id, status: closing.status, reason })}
        />
      )}
    </Card>
  )
}

function OrderDialog({ onClose }: { onClose: () => void }) {
  const { t, num, status, toast, fail } = useApp()
  const { data: items } = useLoad(() => call('inventory.items', {}), [])
  const { data: suppliers } = useLoad(() => call('parties.list', { kind: 'supplier' }), [])
  const { data: stores } = useLoad(() => call('stores.list', { includeInactive: false }), [])
  const active = (items ?? []).filter((i) => i.active)
  const [orderDate, setOrderDate] = useState(status.today)
  const [expectedDate, setExpectedDate] = useState('')
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [warehouseId, setWarehouseId] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<{ itemId: number; quantity: number; unitCost: number | null }[]>([])
  const store = warehouseId ?? stores?.find((w) => w.farmId === status.farm?.id && w.isMain)?.id ?? null
  const total = lines.reduce((s, l) => s + l.quantity * (l.unitCost ?? 0), 0)
  const valid = supplierId && store && lines.length > 0 && lines.every((l) => l.quantity > 0)
  return (
    <Modal
      wide
      title={t('po.new')}
      onClose={onClose}
      footer={
        <>
          <span className="grow">
            {t('pur.total')}: <strong>{`${status.settings.currency} ${num(total, 2)}`}</strong>
          </span>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!valid}
            onClick={async () => {
              try {
                const r = await call('purchases.createOrder', { orderDate, expectedDate: expectedDate || null, supplierId: supplierId!, warehouseId: store!, notes: nz(notes), lines })
                toast('success', t('po.saved', { no: r.poNo }))
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
          <Field label={t('common.date')} required>
            <input className="input" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
          </Field>
          <Field label={t('po.expectedDate')}>
            <input className="input" type="date" min={orderDate} value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
          </Field>
          <Field label={t('pur.supplier')} required>
            <select className="select" value={supplierId ?? ''} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">—</option>
              {suppliers
                ?.filter((s) => s.active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('stores.store')} required>
            <select className="select" value={store ?? ''} onChange={(e) => setWarehouseId(Number(e.target.value))}>
              {stores?.map((w) => (
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
              <th className="num">{t('common.quantity')}</th>
              <th className="num">{t('inv.unitCost')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="select" value={l.itemId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: Number(e.target.value) } : x)))}>
                    {active.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} ({it.unit})
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ width: 140 }}>
                  <NumInput decimals value={l.quantity || null} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: v ?? 0 } : x)))} />
                </td>
                <td style={{ width: 140 }}>
                  <NumInput decimals value={l.unitCost} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, unitCost: v } : x)))} />
                </td>
                <td>
                  <button className="icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={t('common.delete')}>
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <button className="btn sm" onClick={() => active.length && setLines([...lines, { itemId: active[0].id, quantity: 0, unitCost: null }])}>
            <Plus size={16} /> {t('pur.addLine')}
          </button>
        </div>
        <Field label={t('common.notes')}>
          <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
