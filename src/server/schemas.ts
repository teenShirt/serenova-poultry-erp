import { z } from 'zod'
import { isIsoDate } from '@shared/dates'
import { EGG_SESSIONS, INVENTORY_CATEGORIES } from '@shared/types'
import type { ApiMethod } from '@shared/api'
import { PERMISSIONS } from '@shared/permissions'
import { MODULES, SUBSCRIPTION_STATUSES } from '@shared/platform'
import { MANUAL_TXN_TYPES, TASK_CATEGORIES, TASK_PRIORITIES } from '@shared/stores'

/** Input schemas for every API method. Unknown keys are stripped; wrong types are rejected. */
const date = z.string().refine(isIsoDate, 'date')
const id = z.number().int().positive()
const count = z.number().int().min(0).max(1_000_000)
const qty = z.number().finite().min(0).max(100_000_000)
const text = (max = 500) => z.string().max(max)
const optText = (max = 500) => z.string().max(max).nullable()
const time = z.string().regex(/^\d{2}:\d{2}$/).nullable()
const none = z.unknown().optional()
const lang = z.enum(['en', 'si'])
const category = z.enum(INVENTORY_CATEGORIES)
const range = z.object({ from: date, to: date, cageId: id.nullable().optional() })
const limit = z.number().int().min(0).max(100000)
const withReason = z.object({ id, reason: text(500) })
const payMethod = z.enum(['cash', 'bank', 'cheque', 'other'])
const partyInput = z.object({ id: id.nullable(), name: text(100), phone: optText(40), address: optText(200), notes: optText(), active: z.boolean() })
const reportSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['day_open', 'day_close']), date }),
  z.object({ kind: z.literal('period'), from: date, to: date })
])

const cageInput = z.object({
  code: text(20),
  name: text(60),
  initialHens: count,
  capacity: count.nullable(),
  hasWaterMeter: z.boolean(),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(10000),
  notes: optText(),
  houseId: id.nullable().optional()
})

const itemInput = z.object({
  category,
  name: text(80),
  unit: text(20),
  lowStockThreshold: qty.nullable(),
  active: z.boolean(),
  notes: optText(),
  sku: optText(64).optional(),
  reorderLevel: qty.nullable().optional(),
  defaultSupplierId: id.nullable().optional()
})

const settingsPatch = z
  .object({
    farmName: text(100),
    farmLocation: text(200),
    timezone: text(64),
    language: lang,
    productionDenominator: z.enum(['average', 'opening', 'closing']),
    mortalityDenominator: z.enum(['opening', 'average']),
    expectedEggSessions: z.array(z.enum(EGG_SESSIONS)).max(4),
    productionDropPct: z.number().min(1).max(100),
    baselineDays: z.number().int().min(1).max(60),
    mortalityAlertPct: z.number().min(0.001).max(100),
    waterChangePct: z.number().min(1).max(500),
    medicineExpiryWarnDays: z.number().int().min(0).max(365),
    medicineUnits: z.array(text(20)).max(30),
    backupEnabled: z.boolean(),
    backupIntervalHours: z.number().int().min(1).max(24 * 30),
    backupRetention: z.number().int().min(1).max(365),
    allowSignup: z.boolean(),
    autoCheckUpdates: z.boolean(),
    currency: text(10),
    grnApprovalRequired: z.boolean(),
    productionStages: z.array(z.object({ name: text(60).min(1), fromWeek: z.number().int().min(0).max(200) })).max(20)
  })
  .partial()

export const reportSpecSchema = reportSpec

export const schemas: Record<ApiMethod, z.ZodType> = {
  'app.status': none,
  'app.setLanguage': z.object({ language: lang }),
  'setup.complete': z.object({
    farmName: text(100),
    farmLocation: text(200),
    timezone: text(64),
    language: lang,
    startDate: date,
    cages: z.array(z.object({ code: text(20), name: text(60), initialHens: count, hasWaterMeter: z.boolean() })).min(1).max(200),
    admin: z.object({ email: text(255), displayName: text(80), password: text(200) }),
    inventory: z
      .array(
        z.object({
          category,
          name: text(80),
          unit: text(20),
          lowStockThreshold: qty.nullable(),
          openingBalance: qty,
          batchNo: optText(60),
          expiryDate: date.nullable()
        })
      )
      .max(200),
    setupKey: text(200).optional()
  }),
  'demo.enter': none,
  'demo.exit': none,
  'demo.reset': none,

  'auth.login': z.object({ email: text(255), password: text(200) }),
  'auth.logout': none,
  'auth.changePassword': z.object({ current: text(200), next: text(200) }),
  'auth.signup': z.object({ organizationCode: text(40), email: text(255), displayName: text(80), password: text(200) }),
  'auth.resetWithCode': z.object({ email: text(255), recoveryCode: text(40), newPassword: text(200) }),
  'auth.newRecoveryCode': z.object({ password: text(200) }),
  'users.list': none,
  'users.create': z.object({ email: text(255), displayName: text(80), password: text(200), roleId: id }),
  'users.update': z.object({ id, email: text(255), displayName: text(80), roleId: id, active: z.boolean() }),
  'roles.list': none,
  'roles.save': z.object({ id: id.nullable(), name: text(100), description: optText(500), permissions: z.array(z.enum(PERMISSIONS)).max(100) }),
  'roles.archive': z.object({ id }),
  'users.resetPassword': z.object({ id, password: text(200) }),
  'users.approve': z.object({ id, roleId: id }),
  'users.reject': z.object({ id }),
  'users.newRecoveryCode': z.object({ id }),

  'settings.get': none,
  'settings.save': settingsPatch,

  'cages.list': z.object({ includeInactive: z.boolean().optional() }),
  'cages.create': cageInput,
  'farms.list': none,
  'farms.save': z.object({ id: id.nullable(), name: text(100), location: optText(200) }),
  'farms.setStatus': z.object({ id, status: z.enum(['active', 'archived']), reason: text(500) }),
  'farms.switch': z.object({ id }),
  'houses.list': none,
  'houses.save': z.object({ id: id.nullable(), code: text(40), name: text(100), active: z.boolean(), sortOrder: z.number().int().min(0).max(10000), notes: optText() }),
  'flocks.list': z.object({ includeClosed: z.boolean().optional() }),
  'flocks.get': z.object({ id }),
  'flocks.save': z.object({
    id: id.nullable(),
    code: text(40),
    breed: optText(100),
    source: z.enum(['hatched', 'purchased']),
    hatchDate: date.nullable(),
    arrivalDate: date,
    ageOnArrivalDays: z.number().int().min(0).max(1500).nullable(),
    initialCount: count,
    notes: optText()
  }),
  'flocks.place': z.object({ id, cageIds: z.array(id).min(1).max(200), fromDate: date }),
  'flocks.endPlacement': z.object({ id, cageId: id, toDate: date }),
  'flocks.close': z.object({ id, date, reason: text(500) }),
  'flocks.series': z.object({ id, from: date, to: date }),
  'flocks.reminders': none,
  'flocks.saveReminder': z.object({ id: id.nullable(), atWeek: z.number().int().min(0).max(200), title: text(200), instructions: optText(2000), active: z.boolean() }),
  'flocks.dueReminders': none,
  'flocks.markReminder': z.object({ flockId: id, reminderId: id, outcome: z.enum(['done', 'skipped']), note: optText() }),
  'cages.update': z.object({ id, cage: cageInput, reason: optText() }),

  'days.preview': z.object({ date }),
  'days.start': z.object({
    date,
    corrections: z.array(z.object({ cageId: id, opening: count, reason: text(500) })).max(500),
    acknowledgeWarnings: z.boolean()
  }),
  'days.overview': z.object({ date }),
  'days.list': z.object({ from: date, to: date }),
  'days.latest': none,
  'days.correctOpening': z.object({ date, cageId: id, opening: count, reason: text(500) }),
  'days.confirmMortality': z.object({ date, cageIds: z.array(id).max(500) }),
  'days.confirmIssue': z.object({ date, cageId: id.nullable(), key: text(100), reason: text(500) }),
  'days.revokeConfirmation': z.object({ date, cageId: id.nullable(), key: text(100) }),
  'days.saveComment': z.object({ date, comment: text(2000) }),
  'days.close': z.object({ date, comment: optText(2000) }),
  'days.startAmendment': z.object({ date, reason: text(500) }),
  'days.finishAmendment': z.object({ date, comment: optText(2000) }),
  'days.amendments': z.object({ date }),

  'eggs.list': z.object({ date, cageId: id.optional() }),
  'eggs.save': z.object({
    expectedId: id.nullable(),
    date,
    cageId: id,
    session: z.enum(EGG_SESSIONS),
    collectedAt: time,
    good: count,
    damaged: count,
    rejected: count,
    notes: optText()
  }),
  'eggs.delete': withReason,

  'flock.list': z.object({ date, cageId: id.optional() }),
  'flock.listRange': range,
  'flock.add': z.object({ date, cageId: id, type: z.enum(['death', 'removal', 'addition']), quantity: count, reason: optText(), notes: optText() }),
  'flock.transfer': z.object({ date, fromCageId: id, toCageId: id, quantity: count, reason: optText(), notes: optText() }),
  'flock.delete': withReason,

  'feed.list': z.object({ date, cageId: id.optional() }),
  'feed.suggestOpening': z.object({ date, cageId: id, itemId: id }),
  'feed.save': z.object({
    expectedId: id.nullable(),
    date,
    cageId: id,
    itemId: id,
    batchNo: optText(60),
    openingStock: qty.nullable(),
    issued: qty,
    returned: qty,
    wasted: qty,
    measuredConsumption: qty.nullable(),
    closingStock: qty.nullable(),
    notes: optText()
  }),
  'feed.delete': withReason,

  'water.list': z.object({ date }),
  'water.suggestOpening': z.object({ date, cageId: id }),
  'water.save': z.object({
    expectedId: id.nullable(),
    date,
    cageId: id,
    method: z.enum(['meter', 'manual']),
    openingReading: qty.nullable(),
    closingReading: qty.nullable(),
    litres: qty.nullable(),
    meterReset: z.boolean(),
    correctionReason: optText(),
    notes: optText()
  }),
  'water.delete': withReason,

  'medicine.treatments': range,
  'medicine.addTreatment': z.object({
    date,
    cageId: id.nullable(),
    itemId: id,
    batchId: id.nullable(),
    quantity: qty,
    administeredAt: time,
    reason: text(500),
    prescribedBy: optText(100),
    notes: optText()
  }),
  'medicine.deleteTreatment': withReason,
  'medicine.healthEvents': range,
  'medicine.addHealthEvent': z.object({
    date,
    cageId: id.nullable(),
    eventTime: time,
    category: text(40),
    severity: z.enum(['low', 'medium', 'high']),
    description: text(2000),
    actionTaken: optText(2000)
  }),
  'medicine.deleteHealthEvent': withReason,

  'inventory.items': z.object({ category: category.optional() }),
  'inventory.createItem': itemInput,
  'inventory.updateItem': z.object({ id, item: itemInput }),
  'inventory.balances': z.object({ category: category.optional(), warehouseId: id.nullable().optional() }),
  'inventory.batches': z.object({ itemId: id.optional(), onlyInStock: z.boolean().optional(), warehouseId: id.nullable().optional() }),
  'inventory.txns': z.object({ itemId: id.optional(), category: category.optional(), from: date.optional(), to: date.optional(), limit: z.number().int().min(1).max(5000).optional(), warehouseId: id.nullable().optional() }),
  'inventory.record': z.object({
    itemId: id,
    type: z.enum(MANUAL_TXN_TYPES),
    quantity: z.number().finite().min(-100_000_000).max(100_000_000),
    date,
    batchNo: optText(60),
    expiryDate: date.nullable(),
    unitCost: qty.nullable(),
    supplier: optText(100),
    reference: optText(100),
    notes: optText(),
    cageId: id.nullable(),
    warehouseId: id.nullable().optional()
  }),

  'analytics.dashboard': z.object({ date }),
  'analytics.series': range,
  'analytics.comparison': z.object({ from: date, to: date }),

  'audit.list': z.object({ from: date.optional(), to: date.optional(), entity: text(40).optional(), search: text(100).optional(), limit: z.number().int().min(1).max(5000).optional() }),

  'reports.preview': reportSpec,
  'reports.print': reportSpec,
  'reports.recent': none,

  'duties.mine': z.object({ date }),
  'users.setCages': z.object({ id, cages: z.array(id).max(500).nullable() }),

  'parties.list': z.object({ kind: z.enum(['supplier', 'customer']) }),
  'parties.saveSupplier': partyInput,
  'parties.saveCustomer': partyInput,
  'purchases.list': z.object({ from: date, to: date }),
  'purchases.create': z.object({
    date,
    supplierId: id.nullable(),
    invoiceNo: optText(60),
    vehicle: optText(40),
    notes: optText(),
    warehouseId: id.nullable().optional(),
    poId: id.nullable().optional(),
    deliveryNote: optText(100).optional(),
    clientRef: optText(64).optional(),
    lines: z
      .array(
        z.object({
          itemId: id,
          quantity: qty,
          unitCost: qty.nullable(),
          batchNo: optText(60),
          expiryDate: date.nullable(),
          poLineId: id.nullable().optional(),
          rejectedQty: qty.optional(),
          damagedQty: qty.optional(),
          rejectReason: optText().optional()
        })
      )
      .min(1)
      .max(50)
  }),
  'purchases.cancel': withReason,
  'purchases.approve': z.object({ id }),
  'purchases.reject': withReason,
  'purchases.orders': z.object({ openOnly: z.boolean().optional() }),
  'purchases.createOrder': z.object({
    orderDate: date,
    expectedDate: date.nullable(),
    supplierId: id,
    warehouseId: id,
    notes: optText(),
    lines: z.array(z.object({ itemId: id, quantity: qty, unitCost: qty.nullable() })).min(1).max(50)
  }),
  'purchases.closeOrder': z.object({ id, status: z.enum(['closed', 'cancelled']), reason: text(500) }),
  'stores.list': z.object({ includeInactive: z.boolean().optional() }),
  'stores.save': z.object({ id: id.nullable(), code: text(40), name: text(100), active: z.boolean(), notes: optText() }),
  'stores.balances': z.object({ warehouseId: id.nullable().optional(), category: category.optional() }),
  'stores.transfer': z.object({
    date,
    fromWarehouseId: id,
    toWarehouseId: id,
    notes: optText(),
    lines: z.array(z.object({ itemId: id, batchNo: optText(60), quantity: qty })).min(1).max(50)
  }),
  'stores.count': z.object({
    warehouseId: id,
    date,
    notes: optText(),
    lines: z.array(z.object({ itemId: id, batchId: id.nullable(), countedQty: qty })).min(1).max(500)
  }),
  'stores.counts': z.object({ from: date, to: date }),
  'tasks.list': z.object({ from: date, to: date, mineOnly: z.boolean().optional() }),
  'tasks.get': z.object({ id }),
  'tasks.save': z.object({
    id: id.nullable(),
    title: text(200),
    category: z.enum(TASK_CATEGORIES),
    priority: z.enum(TASK_PRIORITIES),
    instructions: optText(4000),
    completionCriteria: optText(2000),
    farmId: id.nullable(),
    houseId: id.nullable(),
    assigneeUserId: id.nullable(),
    assigneeRoleId: id.nullable(),
    startDate: date,
    dueDate: date,
    recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']),
    untilDate: date.nullable()
  }),
  'tasks.action': z.object({ id, action: z.enum(['start', 'complete', 'verify', 'cancel', 'comment', 'stop_series']), note: optText(2000) }),
  'tasks.assignees': none,
  'tasks.report': z.object({ from: date, to: date, by: z.enum(['week', 'month']) }),
  'purchases.series': z.object({ from: date, to: date }),
  'sales.stock': none,
  'sales.list': z.object({ from: date, to: date, customerId: id.nullable().optional(), unpaidOnly: z.boolean().optional() }),
  'sales.dispatch': z.object({
    date,
    customerId: id,
    goodQty: count,
    goodPrice: qty,
    crackedQty: count,
    crackedPrice: qty,
    amountPaid: qty,
    paymentMethod: payMethod,
    invoiceNo: optText(60),
    vehicle: optText(40),
    driver: optText(60),
    notes: optText()
  }),
  'sales.addPayment': z.object({ dispatchId: id, date, amount: qty, method: payMethod, reference: optText(60) }),
  'sales.cancel': withReason,
  'sales.adjust': z.object({ date, grade: z.enum(['good', 'cracked']), quantity: z.number().int().min(-1_000_000).max(1_000_000), reason: text(500) }),
  'sales.adjustments': z.object({ from: date, to: date }),
  'sales.series': z.object({ from: date, to: date }),
  'supply.flow': z.object({ from: date, to: date }),

  'admin.dbInfo': none,
  'admin.checkDb': none,
  'admin.optimize': none,
  'admin.activity': z.object({ from: date, to: date }),

  'backup.list': none,
  'backup.create': none,
  'backup.restore': z.object({ token: text(100) }),

  'platform.status': none,
  'platform.login': z.object({ email: text(255), password: text(200) }),
  'platform.logout': none,
  'platform.metrics': none,
  'platform.organizations': none,
  'platform.createOrganization': z.object({
    name: text(100),
    location: text(200),
    timezone: text(64),
    language: lang,
    adminEmail: text(255),
    adminName: text(80),
    adminPassword: text(200),
    planId: id,
    trialDays: z.number().int().min(0).max(365)
  }),
  'platform.setOrganizationStatus': z.object({ id, status: z.enum(['active', 'suspended', 'archived']), reason: text(500) }),
  'platform.plans': none,
  'platform.savePlan': z.object({
    id: id.nullable(),
    code: text(40),
    name: text(100),
    maxUsers: limit,
    maxAdmins: limit,
    maxRoles: limit,
    maxFarms: limit,
    maxWarehouses: limit,
    modules: z.array(z.enum(MODULES)).max(MODULES.length),
    active: z.boolean()
  }),
  'platform.setSubscription': z.object({
    organizationId: id,
    planId: id,
    status: z.enum(SUBSCRIPTION_STATUSES),
    startsOn: date,
    endsOn: date.nullable(),
    trialEndsOn: date.nullable(),
    graceDays: z.number().int().min(0).max(365),
    overrides: z.object({ maxUsers: limit, maxAdmins: limit, maxRoles: limit, maxFarms: limit, maxWarehouses: limit }).partial().nullable(),
    note: text(500)
  })
}
