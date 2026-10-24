import { addDays, todayInTimezone } from '@shared/dates'
import type { AnonCtx, Ctx } from '../context'
import type { DB } from '../db/connection'
import { createUserRaw, login } from './auth'
import { closeDay, confirmIssue, confirmMortality, getOverview, isBlocking, startDay } from './days'
import { saveEggs } from './eggs'
import { saveFeed } from './feed'
import { addMovement } from './flock'
import { listBatches } from './inventory'
import { setUserCages } from './duties'
import { saveRole } from './roles'
import { saveParty } from './parties'
import { createReceipt } from './purchases'
import { addPayment, createDispatch, eggStock } from './sales'
import { addHealthEvent, addTreatment } from './medicine'
import { createOrganization } from './setup'
import { saveWater } from './water'

/**
 * Demonstration data lives in a separate database, never in the farm database, so resetting
 * or deleting it cannot touch genuine records. (example.com is reserved for examples.)
 */
export const DEMO_USERS = {
  admin: { email: 'demo@example.com', password: 'demo123' },
  operator: { email: 'worker@example.com', password: 'worker123' },
  sales: { email: 'nimal@example.com', password: 'nimal123' }
}

function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fills an empty database with sample data. One transaction: much faster on MySQL, and all-or-nothing. */
export async function seedDemo(db: DB, now: Date = new Date(), days = 45) {
  await db.transaction(() => seedDemoData(db, now, days))()
}

async function seedDemoData(db: DB, now: Date, days: number) {
  const tz = 'Asia/Colombo'
  const today = todayInTimezone(tz, now)
  const start = addDays(today, -days)
  const anon: AnonCtx = { db, now: () => now }
  // The demonstration shows every module, so it is on the Enterprise plan.
  const created = await createOrganization(
    anon,
    {
      farmName: 'DEMO – Sample Poultry Farm',
      farmLocation: 'Demonstration only',
      timezone: tz,
      language: 'si',
      startDate: start,
      cages: Array.from({ length: 10 }, (_, i) => ({
        code: String(i + 1).padStart(2, '0'),
        name: `Cage ${String(i + 1).padStart(2, '0')}`,
        initialHens: 1000,
        hasWaterMeter: true
      })),
      admin: { email: DEMO_USERS.admin.email, displayName: 'Demo Manager', password: DEMO_USERS.admin.password },
      inventory: [
        { category: 'feed', name: 'Layer Mash', unit: 'kg', lowStockThreshold: 2000, openingBalance: 12000, batchNo: null, expiryDate: null },
        { category: 'feed', name: 'Grit / Shell', unit: 'kg', lowStockThreshold: 50, openingBalance: 300, batchNo: null, expiryDate: null },
        {
          category: 'medicine',
          name: 'Multivitamin',
          unit: 'ml',
          lowStockThreshold: 500,
          openingBalance: 3000,
          batchNo: 'MV-2401',
          expiryDate: addDays(today, 200)
        },
        {
          category: 'medicine',
          name: 'Electrolyte',
          unit: 'g',
          lowStockThreshold: 200,
          openingBalance: 1000,
          batchNo: 'EL-118',
          expiryDate: addDays(today, 20)
        },
        { category: 'supply', name: 'Egg trays', unit: 'pcs', lowStockThreshold: 500, openingBalance: 3000, batchNo: null, expiryDate: null }
      ]
    },
    { planCode: 'enterprise', trialDays: 0 }
  )
  const scope = { db, org: created.organizationId, farm: created.farmId, now: () => now }
  const admin: Ctx = { ...scope, user: (await login(anon, DEMO_USERS.admin.email, DEMO_USERS.admin.password)).user }
  // Two data-entry roles sharing the cages, to show what roles and cage assignments do (Settings → Users and Roles).
  const technician = await saveRole(admin, {
    id: null,
    name: 'Poultry Technician',
    description: 'Daily records for the cages they look after',
    permissions: ['day.start', 'eggs.record', 'feed.record', 'water.record', 'flock.record', 'medicine.record', 'reports.view']
  })
  const stores = await saveRole(admin, {
    id: null,
    name: 'Stores & Sales',
    description: null,
    permissions: ['eggs.record', 'feed.record', 'water.record', 'flock.record', 'purchases.record', 'inventory.record', 'sales.record', 'backup.create']
  })
  await createUserRaw(admin, { email: DEMO_USERS.operator.email, displayName: 'Demo Worker', password: DEMO_USERS.operator.password, roleId: technician })
  const worker: Ctx = { ...scope, user: (await login(anon, DEMO_USERS.operator.email, DEMO_USERS.operator.password)).user }

  const rand = rng(20240601)
  const cages = ((await db.prepare('SELECT id FROM cages WHERE farm_id = ? ORDER BY sort_order').all(scope.farm)) as { id: number }[]).map((r) => r.id)
  const items = (await db.prepare('SELECT id, name FROM inventory_items WHERE organization_id = ?').all(scope.org)) as { id: number; name: string }[]
  const mash = items.find((i) => i.name === 'Layer Mash')!.id
  const vit = items.find((i) => i.name === 'Multivitamin')!.id
  const elec = items.find((i) => i.name === 'Electrolyte')!.id
  const baseRate = cages.map(() => 0.86 + rand() * 0.07)
  const meter = cages.map(() => 10000 + Math.round(rand() * 5000))
  const cageStock = cages.map(() => 20)

  await setUserCages(admin, worker.user!.id, cages.slice(0, 5))
  const { id: salesId } = await createUserRaw(admin, {
    email: DEMO_USERS.sales.email,
    displayName: 'Nimal (stores & sales)',
    password: DEMO_USERS.sales.password,
    roleId: stores
  })
  await setUserCages(admin, salesId, cages.slice(5))
  const mill = await saveParty(admin, 'supplier', {
    id: null,
    name: 'Prima Feed Mill',
    phone: '037 222 3344',
    address: 'Kurunegala',
    notes: 'Layer mash, weekly',
    active: true
  })
  const vet = await saveParty(admin, 'supplier', { id: null, name: 'Lanka Vet Supplies', phone: '011 255 7788', address: 'Colombo', notes: null, active: true })
  const buyers = [
    await saveParty(admin, 'customer', {
      id: null,
      name: 'Kurunegala Egg Centre',
      phone: '077 123 4567',
      address: 'Kurunegala town',
      notes: 'Pays weekly',
      active: true
    }),
    await saveParty(admin, 'customer', { id: null, name: 'City Bakery', phone: '071 987 6543', address: 'Main Street', notes: null, active: true }),
    await saveParty(admin, 'customer', { id: null, name: 'Sunday Fair Trader', phone: null, address: null, notes: 'Cash only', active: true })
  ]
  const unpaid: { id: number; amount: number; date: string }[] = []

  for (let i = 0; i <= days; i++) {
    const date = addDays(start, i)
    const isToday = date === today
    await startDay(worker, { date, corrections: [], acknowledgeWarnings: true })
    if (i > 0 && i % 7 === 0) {
      await createReceipt(admin, {
        date,
        supplierId: mill,
        invoiceNo: `PFM-${1000 + i}`,
        vehicle: 'NW LK-4521',
        notes: null,
        lines: [{ itemId: mash, quantity: 8000, unitCost: 152 + (i % 3), batchNo: null, expiryDate: null }]
      })
      if (i === 21) {
        await createReceipt(admin, {
          date,
          supplierId: vet,
          invoiceNo: `LVS-${i}`,
          vehicle: null,
          notes: null,
          lines: [{ itemId: vit, quantity: 1000, unitCost: 4.5, batchNo: 'MV-2409', expiryDate: addDays(today, 260) }]
        })
      }
    }
    const ov = await getOverview(worker, date)
    for (const [k, cageId] of cages.entries()) {
      const hens = ov.cages[k].opening
      // Cage 07 shows a temporary production dip mid-period so the alerts can be demonstrated.
      const dip = k === 6 && i >= days - 15 && i <= days - 12 ? 0.12 : 0
      const rate = Math.max(0.5, baseRate[k] - dip + (rand() - 0.5) * 0.04)
      const total = Math.round(hens * rate)
      const damaged = Math.round(total * (0.006 + rand() * 0.008))
      const rejected = Math.round(total * rand() * 0.004)
      const good = total - damaged - rejected
      const mGood = Math.round(good * 0.62)
      await saveEggs(
        worker,
        {
          date,
          cageId,
          session: 'morning',
          collectedAt: '08:30',
          good: mGood,
          damaged: Math.ceil(damaged / 2),
          rejected: Math.ceil(rejected / 2),
          notes: null
        },
        null
      )
      if (isToday) continue
      await saveEggs(
        worker,
        {
          date,
          cageId,
          session: 'evening',
          collectedAt: '16:30',
          good: good - mGood,
          damaged: Math.floor(damaged / 2),
          rejected: Math.floor(rejected / 2),
          notes: null
        },
        null
      )

      const issued = Math.round((hens * 0.115) / 5) * 5
      const returned = rand() < 0.2 ? Math.round(rand() * 4) : 0
      const wasted = rand() < 0.3 ? Math.round(rand() * 2 * 10) / 10 : 0
      if (k === 0) {
        // Cage 01 counts its feeder stock, so consumption is calculated, not estimated.
        const opening = cageStock[k]
        const eaten = Math.round(hens * (0.112 + rand() * 0.006) * 10) / 10
        const closing = Math.max(0, Math.round((opening + issued - returned - wasted - eaten) * 10) / 10)
        cageStock[k] = closing
        await saveFeed(
          worker,
          {
            date,
            cageId,
            itemId: mash,
            batchNo: null,
            openingStock: opening,
            issued,
            returned,
            wasted,
            measuredConsumption: null,
            closingStock: closing,
            notes: null
          },
          null
        )
      } else {
        await saveFeed(
          worker,
          {
            date,
            cageId,
            itemId: mash,
            batchNo: null,
            openingStock: null,
            issued,
            returned,
            wasted,
            measuredConsumption: null,
            closingStock: null,
            notes: null
          },
          null
        )
      }
      const litres = Math.round(hens * (0.21 + rand() * 0.05))
      await saveWater(
        worker,
        {
          date,
          cageId,
          method: 'meter',
          openingReading: meter[k],
          closingReading: meter[k] + litres,
          litres: null,
          meterReset: false,
          correctionReason: null,
          notes: null
        },
        null
      )
      meter[k] += litres

      const deaths = rand() < 0.45 ? 1 + Math.floor(rand() * (k === 6 && dip ? 4 : 2)) : 0
      if (deaths) await addMovement(worker, { date, cageId, type: 'death', quantity: deaths, reason: null, notes: null })
      if (rand() < 0.03)
        await addMovement(worker, { date, cageId, type: 'removal', quantity: 1 + Math.floor(rand() * 3), reason: 'Culled (weak birds)', notes: null })
    }
    if (i === 10) {
      const b = (await listBatches(worker, { itemId: vit }))[0]
      for (const cageId of cages) {
        await addTreatment(worker, {
          date,
          cageId,
          itemId: vit,
          batchId: b.id,
          quantity: 100,
          administeredAt: '07:00',
          reason: 'Routine vitamin supplement (manager instruction)',
          prescribedBy: 'Farm manager',
          notes: 'Demo record'
        })
      }
    }
    if (i === days - 14) {
      await addHealthEvent(worker, {
        date,
        cageId: cages[6],
        eventTime: '10:15',
        category: 'observation',
        severity: 'medium',
        description: 'Reduced feed intake and lower production observed',
        actionTaken: 'Veterinarian informed'
      })
      const b = (await listBatches(worker, { itemId: elec }))[0]
      await addTreatment(worker, {
        date,
        cageId: cages[6],
        itemId: elec,
        batchId: b.id,
        quantity: 150,
        administeredAt: '11:00',
        reason: 'As instructed by veterinarian',
        prescribedBy: 'Demo Veterinarian',
        notes: 'Demo record'
      })
    }
    // Eggs leave the store: most of yesterday's good eggs are sold, cracked eggs every few days.
    if (i > 0) {
      const stock = await eggStock(admin, date)
      const goodQty = Math.floor((stock.good * (0.85 + rand() * 0.1)) / 30) * 30
      const crackedQty = i % 3 === 0 ? stock.cracked : 0
      if (goodQty + crackedQty > 0) {
        const buyer = buyers[i % 3]
        const price = 42 + Math.round(rand() * 4)
        const amount = goodQty * price + crackedQty * 25
        const payNow = buyer === buyers[2] ? amount : rand() < 0.6 ? amount : rand() < 0.5 ? Math.round(amount / 2) : 0
        const d = await createDispatch(admin, {
          date,
          customerId: buyer,
          goodQty,
          goodPrice: price,
          crackedQty,
          crackedPrice: 25,
          amountPaid: payNow,
          paymentMethod: payNow ? 'cash' : 'bank',
          invoiceNo: null,
          vehicle: 'NW CAB-7788',
          driver: 'Sunil',
          notes: null
        })
        if (payNow < amount) unpaid.push({ id: d.id, amount: amount - payNow, date })
      }
      // Older balances are settled a few days later, leaving the last week partly unpaid.
      while (unpaid.length && unpaid[0].date <= addDays(date, -5)) {
        const u = unpaid.shift()!
        await addPayment(admin, { dispatchId: u.id, date, amount: u.amount, method: 'bank', reference: `TT-${u.id}` })
      }
    }
    if (isToday) break
    await confirmMortality(worker, date, cages)
    for (const issue of (await getOverview(admin, date)).issues.filter(isBlocking)) {
      if (issue.confirmable) await confirmIssue(admin, date, issue.cageId, issue.key, 'Demo: reviewed by manager')
    }
    await closeDay(admin, date, i % 10 === 0 ? 'Demo day reviewed.' : null)
  }
}
