import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ban, PackagePlus, Plus, Trash2, Truck } from 'lucide-react'
import type { ReceiptDto } from '@shared/api'
import { addDays } from '@shared/dates'
import type { GoodsReceipt } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, NumInput, PageHeader, ReasonDialog, nz } from '../components/ui'
import { RangePicker, SERIES, TimeChart } from '../components/charts'
import { Kpi } from '../components/Kpi'
import { PartyDialog, PartyList } from './Sales'

export function PurchasesPage() {
  const { t, num, status, can, date } = useApp()
  const [days, setDays] = useState(30)
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(params.get('new') === '1')
  const [cancel, setCancel] = useState<GoodsReceipt | null>(null)
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
        <Card title={t('pur.list')}>
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
                    <th>{t('common.recordedBy')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">
                        <strong>{r.grnNo}</strong>
                      </td>
                      <td className="nowrap">{date(r.date)}</td>
                      <td>{r.supplierName ?? '—'}</td>
                      <td>
                        {r.lines.map((l, i) => (
                          <div key={i} className="small">
                            {l.itemName}: <strong>{num(l.quantity, 2)} {l.unit}</strong>
                            {l.batchNo && <span className="muted"> · {l.batchNo}</span>}
                          </div>
                        ))}
                      </td>
                      <td>
                        {r.invoiceNo}
                        {r.vehicle && <div className="small muted">{r.vehicle}</div>}
                      </td>
                      <td className="num">{money(r.totalCost)}</td>
                      <td>{r.recordedBy}</td>
                      <td>
                        {can('purchases.cancel') && (
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
        <PartyList kind="supplier" />
      </div>
      {creating && <ReceiptDialog onClose={() => setCreating(false)} />}
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
const emptyLine = (itemId: number): Line => ({ itemId, quantity: 0, unitCost: null, batchNo: null, expiryDate: null })

function ReceiptDialog({ onClose }: { onClose: () => void }) {
  const { t, num, status, toast, fail } = useApp()
  const { data: items } = useLoad(() => call('inventory.items', {}), [])
  const { data: suppliers, reload } = useLoad(() => call('parties.list', { kind: 'supplier' }), [])
  const active = (items ?? []).filter((i) => i.active)
  const [date, setDate] = useState(status.today)
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [invoiceNo, setInvoiceNo] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [newSupplier, setNewSupplier] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (lines.length === 0 && active.length) setLines([emptyLine(active.find((i) => i.category === 'feed')?.id ?? active[0].id)])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.length])
  const upd = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)))
  const total = lines.reduce((s, l) => s + l.quantity * (l.unitCost ?? 0), 0)
  const itemOf = (id: number) => active.find((x) => x.id === id)
  const valid = lines.length > 0 && lines.every((l) => l.quantity > 0 && (itemOf(l.itemId)?.category !== 'medicine' || (l.batchNo ?? '').trim()))
  return (
    <Modal
      wide
      title={t('pur.new')}
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
                const r = await call('purchases.create', { date, supplierId, invoiceNo: nz(invoiceNo), vehicle: nz(vehicle), notes: nz(notes), lines: lines.map((l) => ({ ...l, batchNo: l.batchNo?.trim() || null })) })
                toast('success', t('pur.saved', { no: r.grnNo }))
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
          <Field label={t('pur.supplier')}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
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
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('inv.item')}</th>
                <th className="num">{t('common.quantity')}</th>
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
                      <select className="select" value={l.itemId} onChange={(e) => upd(i, { itemId: Number(e.target.value), batchNo: null, expiryDate: null })}>
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
                    <td style={{ width: 120 }}>
                      <NumInput decimals value={l.unitCost} onChange={(v) => upd(i, { unitCost: v })} />
                    </td>
                    <td style={{ width: 130 }}>
                      <input className={`input ${med && !(l.batchNo ?? '').trim() ? 'invalid' : ''}`} disabled={!med} value={l.batchNo ?? ''} onChange={(e) => upd(i, { batchNo: e.target.value })} />
                    </td>
                    <td style={{ width: 160 }}>
                      <input className="input" type="date" disabled={!med} value={l.expiryDate ?? ''} onChange={(e) => upd(i, { expiryDate: e.target.value || null })} />
                    </td>
                    <td className="num nowrap">{num(l.quantity * (l.unitCost ?? 0), 2)}</td>
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
        <div>
          <button className="btn sm" onClick={() => active.length && setLines([...lines, emptyLine(active[0].id)])}>
            <Plus size={16} /> {t('pur.addLine')}
          </button>
        </div>
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

