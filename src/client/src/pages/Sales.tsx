import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ban, Banknote, Egg, Pencil, Plus, Scale, Truck, Users } from 'lucide-react'
import type { DispatchDto, PartyDto } from '@shared/api'
import { addDays } from '@shared/dates'
import type { EggDispatch, Party } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, Empty, Field, Modal, Notice, NumInput, PageHeader, ReasonDialog, Seg, Tabs, nz } from '../components/ui'
import { RangePicker, SERIES, TimeChart } from '../components/charts'
import { Kpi } from '../components/Kpi'

const TRAY = 30

export function SalesPage() {
  const { t, num, status, can, date } = useApp()
  const [days, setDays] = useState(30)
  const [tab, setTab] = useState<'dispatches' | 'unpaid' | 'store'>('dispatches')
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(params.get('new') === '1')
  const [paying, setPaying] = useState<EggDispatch | null>(null)
  const [cancel, setCancel] = useState<EggDispatch | null>(null)
  const [adjusting, setAdjusting] = useState(false)
  const to = status.today
  const from = addDays(to, -(days - 1))
  const { data: stock } = useLoad(() => call('sales.stock'), [])
  const { data: series } = useLoad(() => call('sales.series', { from, to }), [from, to])
  const { data: list } = useLoad(() => call('sales.list', { from: tab === 'unpaid' ? '2000-01-01' : from, to, unpaidOnly: tab === 'unpaid' }), [from, to, tab])
  const { data: adjustments } = useLoad(() => call('sales.adjustments', { from, to }), [from, to])
  const money = (n: number | null | undefined) => `${status.settings.currency} ${num(n ?? 0, 2)}`
  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true)
      setParams({}, { replace: true })
    }
  }, [params, setParams])

  const sold = (series ?? []).reduce((s, d) => s + d.dispatchedGood + d.dispatchedCracked, 0)
  const revenue = (series ?? []).reduce((s, d) => s + d.revenue, 0)

  return (
    <div className="page">
      <PageHeader title={t('sal.title')} icon={<Truck size={26} color="var(--brand)" />}>
        <RangePicker days={days} onChange={setDays} />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={18} /> {t('sal.new')}
        </button>
      </PageHeader>
      <div className="stack">
        <div className="grid stats">
          <Kpi icon={<Egg size={18} />} label={t('sal.stockGood')} value={num(stock?.good)} sub={t('sal.trays', { trays: num(Math.floor((stock?.good ?? 0) / TRAY)), loose: (stock?.good ?? 0) % TRAY })} trend={series?.map((d) => d.stockGood)} color={SERIES.blue} tone={stock && stock.good < 0 ? 'bad' : undefined} />
          <Kpi icon={<Egg size={18} />} label={t('sal.stockCracked')} value={num(stock?.cracked)} trend={series?.map((d) => d.stockCracked)} color={SERIES.orange} />
          <Kpi icon={<Truck size={18} />} label={t('sal.sold')} value={num(sold)} sub={t('common.last' + days)} trend={series?.map((d) => d.dispatchedGood + d.dispatchedCracked)} color={SERIES.aqua} />
          <Kpi icon={<Banknote size={18} />} label={t('sal.revenue')} value={money(revenue)} trend={series?.map((d) => d.revenue)} color={SERIES.aqua} />
          <Kpi icon={<Banknote size={18} />} label={t('sal.outstanding')} value={money(stock?.outstanding)} tone={stock && stock.outstanding > 0 ? 'warn' : undefined} />
        </div>
        <div className="grid cols-2">
          <TimeChart
            title={t('sal.inOut')}
            data={series ?? []}
            kind="bar"
            series={[
              { key: 'collectedGood', label: t('sal.collected'), color: SERIES.blue },
              { key: 'dispatchedGood', label: t('sal.dispatched'), color: SERIES.orange }
            ]}
          />
          <TimeChart
            title={t('sal.stockTrend')}
            data={series ?? []}
            series={[
              { key: 'stockGood', label: t('chart.good'), color: SERIES.blue },
              { key: 'stockCracked', label: t('chart.damaged'), color: SERIES.orange }
            ]}
          />
          <TimeChart
            title={t('sal.moneyChart')}
            data={series ?? []}
            kind="bar"
            unit={status.settings.currency}
            series={[
              { key: 'revenue', label: t('sal.revenue'), color: SERIES.aqua },
              { key: 'received', label: t('sal.received'), color: SERIES.blue }
            ]}
          />
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'dispatches', label: t('sal.list') },
            { value: 'unpaid', label: t('sal.unpaid') },
            { value: 'store', label: t('sal.store') }
          ]}
        />
        {tab !== 'store' && (
          <Card>
            {!list || list.length === 0 ? (
              <Empty text={t('common.noData')} />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('sal.no')}</th>
                      <th>{t('common.date')}</th>
                      <th>{t('sal.customer')}</th>
                      <th className="num">{t('col.good')}</th>
                      <th className="num">{t('col.damaged')}</th>
                      <th className="num">{t('sal.amount')}</th>
                      <th className="num">{t('sal.paid')}</th>
                      <th className="num">{t('sal.balance')}</th>
                      <th>{t('common.status')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((d) => (
                      <tr key={d.id}>
                        <td className="nowrap">
                          <strong>{d.dispatchNo}</strong>
                          {d.invoiceNo && <div className="small muted">{d.invoiceNo}</div>}
                        </td>
                        <td className="nowrap">{date(d.date)}</td>
                        <td>
                          {d.customerName}
                          {(d.vehicle || d.driver) && <div className="small muted">{[d.vehicle, d.driver].filter(Boolean).join(' · ')}</div>}
                        </td>
                        <td className="num">{d.goodQty ? num(d.goodQty) : '·'}</td>
                        <td className="num">{d.crackedQty ? num(d.crackedQty) : '·'}</td>
                        <td className="num">{money(d.amount)}</td>
                        <td className="num">{money(d.amountPaid)}</td>
                        <td className="num">
                          <strong>{money(d.balance)}</strong>
                        </td>
                        <td>
                          <span className={`badge ${d.paymentStatus === 'paid' ? 'good' : d.paymentStatus === 'partial' ? 'warn' : 'bad'}`}>{t('sal.status.' + d.paymentStatus)}</span>
                        </td>
                        <td className="nowrap">
                          {d.balance > 0 && (
                            <button className="btn sm" onClick={() => setPaying(d)}>
                              <Banknote size={14} /> {t('sal.addPayment')}
                            </button>
                          )}
                          {can('sales.cancel') && (
                            <button className="icon-btn" title={t('sal.cancel')} onClick={() => setCancel(d)}>
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
        )}
        {tab === 'store' && (
          <Card
            title={t('sal.adjustments')}
            actions={
              can('sales.adjust_store') && (
                <button className="btn" onClick={() => setAdjusting(true)}>
                  <Scale size={18} /> {t('sal.adjust')}
                </button>
              )
            }
          >
            <div className="muted small" style={{ marginBottom: 10 }}>
              {t('sal.storeHint')}
            </div>
            {!adjustments || adjustments.length === 0 ? (
              <Empty text={t('common.noData')} />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th>
                      <th>{t('sal.grade')}</th>
                      <th className="num">{t('common.quantity')}</th>
                      <th>{t('common.reason')}</th>
                      <th>{t('common.recordedBy')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adjustments.map((a) => (
                      <tr key={a.id}>
                        <td>{date(a.date)}</td>
                        <td>{t('sal.grade.' + a.grade)}</td>
                        <td className="num" style={{ color: a.quantity < 0 ? 'var(--bad)' : 'var(--good)' }}>
                          {a.quantity > 0 ? '+' : ''}
                          {num(a.quantity)}
                        </td>
                        <td>{a.reason}</td>
                        <td>{a.recordedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
        <PartyList kind="customer" />
      </div>
      {creating && <DispatchDialog stock={stock} onClose={() => setCreating(false)} />}
      {paying && <PaymentDialog dispatch={paying} onClose={() => setPaying(null)} />}
      {adjusting && <AdjustDialog onClose={() => setAdjusting(false)} />}
      {cancel && (
        <ReasonDialog
          title={`${t('sal.cancel')} — ${cancel.dispatchNo}`}
          hint={t('sal.cancelHint')}
          danger
          confirmLabel={t('sal.cancel')}
          onClose={() => setCancel(null)}
          onSubmit={(reason) => call('sales.cancel', { id: cancel.id, reason })}
        />
      )}
    </div>
  )
}

function DispatchDialog({ stock, onClose }: { stock: { good: number; cracked: number } | undefined; onClose: () => void }) {
  const { t, num, status, toast, fail } = useApp()
  const { data: customers, reload } = useLoad(() => call('parties.list', { kind: 'customer' }), [])
  const [f, setF] = useState<DispatchDto>({
    date: status.today,
    customerId: 0,
    goodQty: 0,
    goodPrice: 0,
    crackedQty: 0,
    crackedPrice: 0,
    amountPaid: 0,
    paymentMethod: 'cash',
    invoiceNo: null,
    vehicle: null,
    driver: null,
    notes: null
  })
  const [newCustomer, setNewCustomer] = useState(false)
  const [busy, setBusy] = useState(false)
  const amount = f.goodQty * f.goodPrice + f.crackedQty * f.crackedPrice
  const overGood = stock !== undefined && f.goodQty > stock.good
  const overCracked = stock !== undefined && f.crackedQty > stock.cracked
  const ok = f.customerId > 0 && f.goodQty + f.crackedQty > 0 && !overGood && !overCracked && f.amountPaid <= amount + 0.005
  const set = (p: Partial<DispatchDto>) => setF({ ...f, ...p })
  return (
    <Modal
      wide
      title={t('sal.new')}
      onClose={onClose}
      footer={
        <>
          <span className="grow">
            {t('sal.amount')}: <strong>{`${status.settings.currency} ${num(amount, 2)}`}</strong>
          </span>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await call('sales.dispatch', { ...f, invoiceNo: nz(f.invoiceNo ?? ''), vehicle: nz(f.vehicle ?? ''), driver: nz(f.driver ?? ''), notes: nz(f.notes ?? '') })
                toast('success', t('sal.saved', { no: r.dispatchNo }))
                onClose()
              } catch (e) {
                fail(e)
              } finally {
                setBusy(false)
              }
            }}
          >
            <Truck size={18} /> {t('sal.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('common.date')} required>
            <input className="input" type="date" value={f.date} max={status.today} onChange={(e) => set({ date: e.target.value })} />
          </Field>
          <Field label={t('sal.customer')} required>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <select className="select" value={f.customerId || ''} onChange={(e) => set({ customerId: Number(e.target.value) })}>
                <option value="">—</option>
                {customers
                  ?.filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <button className="btn sm" type="button" onClick={() => setNewCustomer(true)} title={t('party.newCustomer')}>
                <Plus size={16} />
              </button>
            </div>
          </Field>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('sal.grade')}</th>
                <th className="num">{t('sal.inStore')}</th>
                <th className="num">{t('common.quantity')}</th>
                <th className="num">{t('sal.price')}</th>
                <th className="num">{t('sal.amount')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>{t('sal.grade.good')}</strong>
                </td>
                <td className="num">{num(stock?.good)}</td>
                <td style={{ width: 160 }}>
                  <NumInput value={f.goodQty || null} invalid={overGood} onChange={(v) => set({ goodQty: v ?? 0 })} />
                  <div className="small muted right">{t('sal.trays', { trays: Math.floor(f.goodQty / TRAY), loose: f.goodQty % TRAY })}</div>
                </td>
                <td style={{ width: 140 }}>
                  <NumInput decimals value={f.goodPrice || null} onChange={(v) => set({ goodPrice: v ?? 0 })} />
                </td>
                <td className="num">{num(f.goodQty * f.goodPrice, 2)}</td>
              </tr>
              <tr>
                <td>
                  <strong>{t('sal.grade.cracked')}</strong>
                </td>
                <td className="num">{num(stock?.cracked)}</td>
                <td>
                  <NumInput value={f.crackedQty || null} invalid={overCracked} onChange={(v) => set({ crackedQty: v ?? 0 })} />
                </td>
                <td>
                  <NumInput decimals value={f.crackedPrice || null} onChange={(v) => set({ crackedPrice: v ?? 0 })} />
                </td>
                <td className="num">{num(f.crackedQty * f.crackedPrice, 2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {(overGood || overCracked) && <Notice tone="bad">{t('sal.overStock')}</Notice>}
        <div className="form-grid">
          <Field label={t('sal.paidNow')}>
            <NumInput decimals value={f.amountPaid || null} invalid={f.amountPaid > amount + 0.005} onChange={(v) => set({ amountPaid: v ?? 0 })} />
          </Field>
          <Field label={t('sal.method')}>
            <Seg value={f.paymentMethod} onChange={(m) => set({ paymentMethod: m })} options={(['cash', 'bank', 'cheque', 'other'] as const).map((m) => ({ value: m, label: t('sal.method.' + m) }))} />
          </Field>
          <Field label={t('pur.invoice')}>
            <input className="input" value={f.invoiceNo ?? ''} onChange={(e) => set({ invoiceNo: e.target.value })} />
          </Field>
          <Field label={t('pur.vehicle')}>
            <input className="input" value={f.vehicle ?? ''} onChange={(e) => set({ vehicle: e.target.value })} />
          </Field>
          <Field label={t('sal.driver')}>
            <input className="input" value={f.driver ?? ''} onChange={(e) => set({ driver: e.target.value })} />
          </Field>
        </div>
        <Field label={t('common.notes')}>
          <textarea className="input" value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
      {newCustomer && (
        <PartyDialog
          kind="customer"
          party={null}
          onClose={(id) => {
            setNewCustomer(false)
            if (id) {
              reload()
              set({ customerId: id })
            }
          }}
        />
      )}
    </Modal>
  )
}

function PaymentDialog({ dispatch, onClose }: { dispatch: EggDispatch; onClose: () => void }) {
  const { t, num, status, toast, fail } = useApp()
  const [amount, setAmount] = useState<number | null>(dispatch.balance)
  const [method, setMethod] = useState<'cash' | 'bank' | 'cheque' | 'other'>('cash')
  const [date, setDate] = useState(status.today)
  const [reference, setReference] = useState('')
  const ok = amount !== null && amount > 0 && amount <= dispatch.balance + 0.005
  return (
    <Modal
      title={`${t('sal.addPayment')} — ${dispatch.dispatchNo}`}
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
                await call('sales.addPayment', { dispatchId: dispatch.id, date, amount: amount!, method, reference: nz(reference) })
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
        <Notice tone="info">
          {dispatch.customerName} · {t('sal.balance')}: <strong>{`${status.settings.currency} ${num(dispatch.balance, 2)}`}</strong>
        </Notice>
        <div className="form-grid">
          <Field label={t('sal.amount')} required>
            <NumInput big decimals value={amount} onChange={setAmount} invalid={amount !== null && amount > dispatch.balance + 0.005} />
          </Field>
          <Field label={t('common.date')}>
            <input className="input" type="date" value={date} max={status.today} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label={t('sal.method')}>
          <Seg value={method} onChange={setMethod} options={(['cash', 'bank', 'cheque', 'other'] as const).map((m) => ({ value: m, label: t('sal.method.' + m) }))} />
        </Field>
        <Field label={t('inv.reference')}>
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function AdjustDialog({ onClose }: { onClose: () => void }) {
  const { t, status, toast, fail } = useApp()
  const [grade, setGrade] = useState<'good' | 'cracked'>('good')
  const [quantity, setQuantity] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [date, setDate] = useState(status.today)
  const ok = quantity !== null && quantity !== 0 && reason.trim().length >= 3
  return (
    <Modal
      title={t('sal.adjust')}
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
                await call('sales.adjust', { date, grade, quantity: quantity!, reason: reason.trim() })
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
        <Notice tone="info">{t('sal.adjustHint')}</Notice>
        <Seg value={grade} onChange={setGrade} options={[{ value: 'good', label: t('sal.grade.good') }, { value: 'cracked', label: t('sal.grade.cracked') }]} />
        <div className="form-grid">
          <Field label={`${t('common.quantity')} (+ / −)`} required>
            <NumInput allowNegative value={quantity} onChange={setQuantity} />
          </Field>
          <Field label={t('common.date')}>
            <input className="input" type="date" value={date} max={status.today} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label={t('common.reason')} required>
          <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** Suppliers or customers: list with add and edit. */
export function PartyList({ kind }: { kind: 'supplier' | 'customer' }) {
  const { t } = useApp()
  const { data } = useLoad(() => call('parties.list', { kind }), [kind])
  const [editing, setEditing] = useState<Party | 'new' | null>(null)
  return (
    <Card
      title={
        <h2 className="row" style={{ gap: 8 }}>
          <Users size={20} /> {t(kind === 'supplier' ? 'party.suppliers' : 'party.customers')}
        </h2>
      }
      actions={
        <button className="btn" onClick={() => setEditing('new')}>
          <Plus size={18} /> {t(kind === 'supplier' ? 'party.newSupplier' : 'party.newCustomer')}
        </button>
      }
    >
      {!data || data.length === 0 ? (
        <Empty text={t('common.noData')} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('party.phone')}</th>
                <th>{t('party.address')}</th>
                <th>{t('common.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} style={p.active ? undefined : { opacity: 0.55 }}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.notes && <div className="small muted">{p.notes}</div>}
                  </td>
                  <td>{p.phone}</td>
                  <td>{p.address}</td>
                  <td>{p.active ? <span className="badge good">{t('common.active')}</span> : <span className="badge">{t('common.inactive')}</span>}</td>
                  <td>
                    <button className="icon-btn" title={t('common.edit')} onClick={() => setEditing(p)}>
                      <Pencil size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <PartyDialog kind={kind} party={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  )
}

export function PartyDialog({ kind, party, onClose }: { kind: 'supplier' | 'customer'; party: Party | null; onClose: (id: number | null) => void }) {
  const { t, toast, fail } = useApp()
  const [f, setF] = useState<PartyDto>(party ?? { id: null, name: '', phone: null, address: null, notes: null, active: true })
  return (
    <Modal
      title={party ? `${t('common.edit')} — ${party.name}` : t(kind === 'supplier' ? 'party.newSupplier' : 'party.newCustomer')}
      onClose={() => onClose(null)}
      footer={
        <>
          <button className="btn" onClick={() => onClose(null)}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={f.name.trim().length < 2}
            onClick={async () => {
              try {
                const id = await call(kind === 'supplier' ? 'parties.saveSupplier' : 'parties.saveCustomer', { ...f, phone: nz(f.phone ?? ''), address: nz(f.address ?? ''), notes: nz(f.notes ?? '') })
                toast('success', t('common.saved'))
                onClose(id)
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
        <Field label={t('common.name')} required>
          <input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t('party.phone')}>
          <input className="input" value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label={t('party.address')}>
          <input className="input" value={f.address ?? ''} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
        <Field label={t('common.notes')}>
          <input className="input" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          {t('common.active')}
        </label>
      </div>
    </Modal>
  )
}
