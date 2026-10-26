import type {
  PurchaseOrder,
  PurchaseOrderInput,
  ReceiptLineInput,
  StockCountInput,
  StockCountRow,
  StoreBalance,
  TaskEvent,
  TaskInput,
  TaskReportRow,
  TaskRow,
  TransferInput,
  Warehouse
} from './stores'
import type { MovementPage, OrganizationOverview } from './overview'
import type { FarmRow, FlockDetail, FlockInput, FlockSummary, HouseRow, ReminderDue, ReminderRow } from './flocks'
import type { OrgSummary, Plan, PlatformMetrics, PlatformReleases, PlatformStatus, PlatformUser, SubscriptionChange } from './platform'
import type {
  AppStatus,
  AuditEntry,
  BackupFileCheck,
  BackupInfo,
  Cage,
  CageComparisonRow,
  DailySeriesPoint,
  DashboardData,
  DayOverview,
  EggCollection,
  EggSession,
  FarmSettings,
  FeedRecord,
  FlockMovement,
  HealthEvent,
  InventoryBalance,
  InventoryBatch,
  InventoryCategory,
  InventoryItem,
  InventoryTxn,
  Language,
  SessionUser,
  StartDayPreview,
  Treatment,
  TxnType,
  UserRow,
  RoleRow,
  ActivitySummary,
  DbInfo,
  DutyTask,
  EggDispatch,
  EggStock,
  EggStoreAdjustment,
  FlowSummary,
  GoodsReceipt,
  Party,
  PurchasesDay,
  SalesDay,
  WaterRecord,
  FeedingSchedule,
  FeedingSlot,
  Withdrawal
} from './types'

type DateArg = { date: string }
type Range = { from: string; to: string; cageId?: number | null }
type WithReason = { id: number; reason: string }

export interface CageInputDto {
  code: string
  name: string
  initialHens: number
  capacity: number | null
  hasWaterMeter: boolean
  active: boolean
  sortOrder: number
  notes: string | null
  /** The poultry house the cage is in (optional; unchanged when left out) */
  houseId?: number | null
}

export interface ItemInputDto {
  category: InventoryCategory
  name: string
  unit: string
  lowStockThreshold: number | null
  active: boolean
  notes: string | null
  sku?: string | null
  reorderLevel?: number | null
  defaultSupplierId?: number | null
  eggWithdrawalDays?: number | null
}

export interface SetupDto {
  farmName: string
  farmLocation: string
  timezone: string
  language: Language
  startDate: string
  cages: { code: string; name: string; initialHens: number; hasWaterMeter: boolean }[]
  admin: { email: string; displayName: string; password: string }
  inventory: {
    category: InventoryCategory
    name: string
    unit: string
    lowStockThreshold: number | null
    openingBalance: number
    batchNo: string | null
    expiryDate: string | null
  }[]
}

export interface PartyDto {
  id: number | null
  name: string
  phone: string | null
  address: string | null
  notes: string | null
  active: boolean
}

export interface ReceiptDto {
  date: string
  supplierId: number | null
  invoiceNo: string | null
  vehicle: string | null
  notes: string | null
  warehouseId?: number | null
  poId?: number | null
  deliveryNote?: string | null
  clientRef?: string | null
  lines: (Partial<ReceiptLineInput> & { itemId: number; quantity: number; unitCost: number | null; batchNo: string | null; expiryDate: string | null })[]
}

export interface DispatchDto {
  date: string
  customerId: number
  goodQty: number
  goodPrice: number
  crackedQty: number
  crackedPrice: number
  amountPaid: number
  paymentMethod: 'cash' | 'bank' | 'cheque' | 'other'
  invoiceNo: string | null
  vehicle: string | null
  driver: string | null
  notes: string | null
}

export type ReportKind = 'day_open' | 'day_close' | 'period'

/** Which report to build: one business day, or a date range summary. */
export type ReportSpec = { kind: 'day_open' | 'day_close'; date: string } | { kind: 'period'; from: string; to: string }

/**
 * Every operation the UI may request. The main process validates each input with a
 * schema and checks the user's role before running it; nothing else is reachable.
 */
export interface Api {
  'app.status': { in: void; out: AppStatus }
  'app.setLanguage': { in: { language: Language }; out: void }
  'setup.complete': { in: SetupDto & { setupKey?: string }; out: { recoveryCode: string } }
  'demo.enter': { in: void; out: { email: string; password: string } }
  'demo.exit': { in: void; out: void }
  'demo.reset': { in: void; out: void }

  'auth.login': { in: { email: string; password: string }; out: SessionUser }
  'auth.logout': { in: void; out: void }
  'auth.changePassword': { in: { current: string; next: string }; out: void }
  'auth.signup': { in: { organizationCode: string; email: string; displayName: string; password: string }; out: { recoveryCode: string } }
  'auth.resetWithCode': { in: { email: string; recoveryCode: string; newPassword: string }; out: { recoveryCode: string } }
  'auth.newRecoveryCode': { in: { password: string }; out: { recoveryCode: string } }
  'users.list': { in: void; out: UserRow[] }
  'users.create': { in: { email: string; displayName: string; password: string; roleId: number }; out: { id: number; recoveryCode: string } }
  'users.approve': { in: { id: number; roleId: number }; out: void }
  'users.reject': { in: { id: number }; out: void }
  'users.newRecoveryCode': { in: { id: number }; out: { recoveryCode: string } }
  'users.update': { in: { id: number; email: string; displayName: string; roleId: number; active: boolean }; out: void }
  'roles.list': { in: void; out: RoleRow[] }
  /** Creates (id null) or changes a role. Only permissions the signed-in user holds can be given. */
  'roles.save': { in: { id: number | null; name: string; description: string | null; permissions: string[] }; out: number }
  'roles.archive': { in: { id: number }; out: void }
  'users.resetPassword': { in: { id: number; password: string }; out: void }

  'settings.get': { in: void; out: FarmSettings }
  'settings.save': { in: Partial<FarmSettings>; out: FarmSettings }

  'cages.list': { in: { includeInactive?: boolean }; out: (Cage & { hasHistory: boolean })[] }
  'cages.create': { in: CageInputDto; out: number }
  'cages.update': { in: { id: number; cage: CageInputDto; reason: string | null }; out: void }

  // ---- Farms, poultry houses and flocks ----
  'farms.list': { in: void; out: FarmRow[] }
  'farms.save': { in: { id: number | null; name: string; location: string | null }; out: number }
  'farms.setStatus': { in: { id: number; status: 'active' | 'archived'; reason: string }; out: void }
  /** Switches the farm this browser session works on */
  'farms.switch': { in: { id: number }; out: void }
  'houses.list': { in: void; out: HouseRow[] }
  'houses.save': { in: Omit<HouseRow, 'cages' | 'id'> & { id: number | null }; out: number }
  'flocks.list': { in: { includeClosed?: boolean }; out: FlockSummary[] }
  'flocks.get': { in: { id: number }; out: FlockDetail }
  'flocks.save': { in: FlockInput; out: number }
  'flocks.place': { in: { id: number; cageIds: number[]; fromDate: string }; out: void }
  'flocks.endPlacement': { in: { id: number; cageId: number; toDate: string }; out: void }
  'flocks.close': { in: { id: number; date: string; reason: string }; out: void }
  'flocks.series': { in: { id: number; from: string; to: string }; out: (DailySeriesPoint & { ageDays: number; ageWeeks: number })[] }
  'flocks.reminders': { in: void; out: ReminderRow[] }
  'flocks.saveReminder': { in: Omit<ReminderRow, 'id'> & { id: number | null }; out: number }
  /** Reminders due now (and in the coming week) for the farm's active flocks */
  'flocks.dueReminders': { in: void; out: ReminderDue[] }
  'flocks.markReminder': { in: { flockId: number; reminderId: number; outcome: 'done' | 'skipped'; note: string | null }; out: void }

  'days.preview': { in: DateArg; out: StartDayPreview }
  'days.start': {
    in: { date: string; corrections: { cageId: number; opening: number; reason: string }[]; acknowledgeWarnings: boolean }
    out: DayOverview
  }
  'days.overview': { in: DateArg; out: DayOverview }
  'days.list': {
    in: { from: string; to: string }
    out: { date: string; status: 'in_progress' | 'closed'; amendmentOpen: number; closedAt: string | null; amendments: number }[]
  }
  'days.latest': { in: void; out: { date: string; status: 'in_progress' | 'closed' } | null }
  'days.correctOpening': { in: { date: string; cageId: number; opening: number; reason: string }; out: void }
  'days.confirmMortality': { in: { date: string; cageIds: number[] }; out: void }
  'days.confirmIssue': { in: { date: string; cageId: number | null; key: string; reason: string }; out: void }
  'days.revokeConfirmation': { in: { date: string; cageId: number | null; key: string }; out: void }
  'days.saveComment': { in: { date: string; comment: string }; out: void }
  'days.close': { in: { date: string; comment: string | null }; out: { overview: DayOverview } }
  'days.startAmendment': { in: { date: string; reason: string }; out: void }
  'days.finishAmendment': { in: { date: string; comment: string | null }; out: DayOverview }
  'days.amendments': {
    in: DateArg
    out: { id: number; reason: string; openedAt: string; closedAt: string | null; openedBy: string | null; closedBy: string | null }[]
  }

  'eggs.list': { in: { date: string; cageId?: number }; out: EggCollection[] }
  'eggs.save': {
    in: {
      expectedId: number | null
      date: string
      cageId: number
      session: EggSession
      collectedAt: string | null
      good: number
      damaged: number
      rejected: number
      notes: string | null
    }
    out: number
  }
  'eggs.delete': { in: WithReason; out: void }

  'flock.list': { in: { date: string; cageId?: number }; out: FlockMovement[] }
  'flock.listRange': { in: Range; out: FlockMovement[] }
  'flock.add': {
    in: { date: string; cageId: number; type: 'death' | 'removal' | 'addition'; quantity: number; reason: string | null; notes: string | null }
    out: number
  }
  'flock.transfer': { in: { date: string; fromCageId: number; toCageId: number; quantity: number; reason: string | null; notes: string | null }; out: string }
  'flock.delete': { in: WithReason; out: void }

  'feed.list': { in: { date: string; cageId?: number }; out: FeedRecord[] }
  'feed.suggestOpening': { in: { date: string; cageId: number; itemId: number }; out: number | null }
  'feed.save': {
    in: {
      expectedId: number | null
      date: string
      cageId: number
      itemId: number
      batchNo: string | null
      openingStock: number | null
      issued: number
      returned: number
      wasted: number
      measuredConsumption: number | null
      closingStock: number | null
      notes: string | null
    }
    out: number
  }
  'feed.delete': { in: WithReason; out: void }

  'water.list': { in: DateArg; out: WaterRecord[] }
  'water.suggestOpening': { in: { date: string; cageId: number }; out: number | null }
  'water.save': {
    in: {
      expectedId: number | null
      date: string
      cageId: number
      method: 'meter' | 'manual'
      openingReading: number | null
      closingReading: number | null
      litres: number | null
      meterReset: boolean
      correctionReason: string | null
      notes: string | null
    }
    out: number
  }
  'water.delete': { in: WithReason; out: void }

  'medicine.treatments': { in: Range; out: Treatment[] }
  'medicine.addTreatment': {
    in: {
      date: string
      cageId: number | null
      itemId: number
      batchId: number | null
      quantity: number
      administeredAt: string | null
      reason: string
      prescribedBy: string | null
      notes: string | null
    }
    out: number
  }
  'medicine.deleteTreatment': { in: WithReason; out: void }
  'feeding.schedules': { in: void; out: FeedingSchedule[] }
  'feeding.saveSchedule': { in: Omit<FeedingSchedule, 'cageName' | 'itemName' | 'id'> & { id: number | null }; out: number }
  'feeding.status': { in: { date: string }; out: FeedingSlot[] }
  'feeding.markFed': { in: { scheduleId: number; date: string; fedAt: string; note: string | null }; out: void }
  /** Cages whose eggs are under a withdrawal period on the date */
  'medicine.withdrawals': { in: { date: string }; out: Withdrawal[] }
  'medicine.healthEvents': { in: Range; out: HealthEvent[] }
  'medicine.addHealthEvent': {
    in: {
      date: string
      cageId: number | null
      eventTime: string | null
      category: string
      severity: 'low' | 'medium' | 'high'
      description: string
      actionTaken: string | null
    }
    out: number
  }
  'medicine.deleteHealthEvent': { in: WithReason; out: void }

  'inventory.items': { in: { category?: InventoryCategory }; out: InventoryItem[] }
  'inventory.createItem': { in: ItemInputDto; out: number }
  'inventory.updateItem': { in: { id: number; item: ItemInputDto }; out: void }
  'inventory.balances': { in: { category?: InventoryCategory; warehouseId?: number | null }; out: InventoryBalance[] }
  'inventory.batches': { in: { itemId?: number; onlyInStock?: boolean; warehouseId?: number | null }; out: InventoryBatch[] }
  'inventory.txns': {
    in: { itemId?: number; category?: InventoryCategory; from?: string; to?: string; limit?: number; warehouseId?: number | null }
    out: InventoryTxn[]
  }
  'inventory.record': {
    in: {
      itemId: number
      type: TxnType
      quantity: number
      date: string
      batchNo: string | null
      expiryDate: string | null
      unitCost: number | null
      supplier: string | null
      reference: string | null
      notes: string | null
      cageId: number | null
      warehouseId?: number | null
    }
    out: number
  }

  'analytics.dashboard': { in: DateArg; out: DashboardData }
  'analytics.series': { in: Range; out: DailySeriesPoint[] }
  'analytics.comparison': { in: { from: string; to: string }; out: CageComparisonRow[] }

  'audit.list': { in: { from?: string; to?: string; entity?: string; search?: string; limit?: number }; out: AuditEntry[] }

  'reports.preview': { in: ReportSpec; out: { title: string; html: string } }
  /** The printable report (A4 landscape); the browser prints it or saves it as PDF. Recorded in the report history. */
  'reports.print': { in: ReportSpec; out: { title: string; html: string } }
  'reports.recent': { in: void; out: { id: number; kind: ReportKind; periodStart: string; periodEnd: string; format: 'pdf' | 'xlsx'; generatedAt: string }[] }

  'duties.mine': { in: { date: string }; out: DutyTask[] }
  /** The cages a user looks after (null = all cages). What they may do comes from their role. */
  'users.setCages': { in: { id: number; cages: number[] | null }; out: void }

  'parties.list': { in: { kind: 'supplier' | 'customer' }; out: Party[] }
  'parties.saveSupplier': { in: PartyDto; out: number }
  'parties.saveCustomer': { in: PartyDto; out: number }
  'purchases.list': { in: { from: string; to: string }; out: GoodsReceipt[] }
  'purchases.create': { in: ReceiptDto; out: { id: number; grnNo: string; status: 'submitted' | 'posted' } }
  'purchases.approve': { in: { id: number }; out: void }
  'purchases.reject': { in: { id: number; reason: string }; out: void }
  'purchases.orders': { in: { openOnly?: boolean }; out: PurchaseOrder[] }
  'purchases.createOrder': { in: PurchaseOrderInput; out: { id: number; poNo: string } }
  'purchases.closeOrder': { in: { id: number; status: 'closed' | 'cancelled'; reason: string }; out: void }

  // ---- Stores (warehouses), transfers and stock counts ----
  'stores.list': { in: { includeInactive?: boolean }; out: Warehouse[] }
  'stores.save': { in: { id: number | null; code: string; name: string; active: boolean; notes: string | null }; out: number }
  'stores.balances': { in: { warehouseId?: number | null; category?: InventoryCategory }; out: StoreBalance[] }
  'stores.transfer': { in: TransferInput; out: string }
  'stores.count': { in: StockCountInput; out: number }
  'stores.counts': { in: { from: string; to: string }; out: StockCountRow[] }
  /** Stock movements in the farm's stores, newest first, one page at a time */
  'stores.movements': {
    in: { from: string; to: string; warehouseId?: number | null; itemId?: number | null; type?: string | null; page: number; pageSize?: number }
    out: MovementPage
  }
  /** Every active farm of the organization side by side, with totals (closed days only) */
  'overview.organization': { in: { from: string; to: string }; out: OrganizationOverview }

  // ---- Tasks ----
  'tasks.list': { in: { from: string; to: string; mineOnly?: boolean }; out: TaskRow[] }
  'tasks.get': { in: { id: number }; out: TaskRow & { events: TaskEvent[] } }
  'tasks.save': { in: TaskInput; out: number }
  'tasks.action': { in: { id: number; action: 'start' | 'complete' | 'verify' | 'cancel' | 'comment' | 'stop_series'; note: string | null }; out: void }
  'tasks.report': { in: { from: string; to: string; by: 'week' | 'month' }; out: TaskReportRow[] }
  /** People and teams (roles) a task can be assigned to */
  'tasks.assignees': { in: void; out: { users: { id: number; name: string }[]; roles: { id: number; name: string }[] } }
  'purchases.cancel': { in: { id: number; reason: string }; out: void }
  'purchases.series': { in: { from: string; to: string }; out: PurchasesDay[] }
  'sales.stock': { in: void; out: EggStock & { outstanding: number } }
  'sales.list': { in: { from: string; to: string; customerId?: number | null; unpaidOnly?: boolean }; out: EggDispatch[] }
  'sales.dispatch': { in: DispatchDto; out: { id: number; dispatchNo: string } }
  'sales.addPayment': {
    in: { dispatchId: number; date: string; amount: number; method: 'cash' | 'bank' | 'cheque' | 'other'; reference: string | null }
    out: void
  }
  'sales.cancel': { in: { id: number; reason: string }; out: void }
  'sales.adjust': { in: { date: string; grade: 'good' | 'cracked'; quantity: number; reason: string }; out: number }
  'sales.adjustments': { in: { from: string; to: string }; out: EggStoreAdjustment[] }
  'sales.series': { in: { from: string; to: string }; out: SalesDay[] }
  'supply.flow': { in: { from: string; to: string }; out: FlowSummary }

  'admin.dbInfo': { in: void; out: DbInfo }
  'admin.checkDb': { in: void; out: { ok: boolean; message: string } }
  'admin.optimize': { in: void; out: DbInfo }
  'admin.activity': { in: { from: string; to: string }; out: ActivitySummary }

  'backup.list': { in: void; out: BackupInfo[] }
  'backup.create': { in: void; out: BackupInfo }
  /** Restores a backup uploaded to /api/backup/upload (which returns the token after checking the file). */
  'backup.restore': { in: { token: string }; out: void }

  // ---- Super Admin console (platform accounts only; never shows farm records) ----
  'platform.status': { in: void; out: PlatformStatus }
  'platform.login': { in: { email: string; password: string }; out: PlatformUser }
  'platform.logout': { in: void; out: void }
  'platform.metrics': { in: void; out: PlatformMetrics }
  'platform.organizations': { in: void; out: OrgSummary[] }
  'platform.createOrganization': {
    in: {
      name: string
      location: string
      timezone: string
      language: Language
      adminEmail: string
      adminName: string
      adminPassword: string
      planId: number
      trialDays: number
    }
    out: { id: number; code: string; recoveryCode: string }
  }
  'platform.setOrganizationStatus': { in: { id: number; status: 'active' | 'suspended' | 'archived'; reason: string }; out: void }
  'platform.plans': { in: void; out: Plan[] }
  'platform.savePlan': { in: Omit<Plan, 'id'> & { id: number | null }; out: number }
  'platform.setSubscription': { in: SubscriptionChange; out: void }
  /** Installed version, release notes, release history and restore tests (read-only: releases are deployed by CI/CD) */
  'platform.releases': { in: void; out: PlatformReleases }
}

export type ApiMethod = keyof Api
export type ApiIn<M extends ApiMethod> = Api[M]['in']
export type ApiOut<M extends ApiMethod> = Api[M]['out']

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; code: string; params: Record<string, string | number> }

/** A backup file uploaded for restoring, after the server has checked it. */
export type UploadedBackup = BackupFileCheck & { token: string }

/**
 * Whether each request only reads data. After any 'write' succeeds, open screens reload their
 * data; reads never trigger a reload (a read marked as a write would reload forever).
 * Typed as a complete record, so a new request cannot be added without classifying it.
 */
export const API_KIND: Record<ApiMethod, 'read' | 'write'> = {
  'app.status': 'read',
  'app.setLanguage': 'write',
  'setup.complete': 'write',
  'demo.enter': 'write',
  'demo.exit': 'write',
  'demo.reset': 'write',
  'auth.login': 'write',
  'auth.logout': 'write',
  'auth.changePassword': 'write',
  'auth.signup': 'write',
  'auth.resetWithCode': 'write',
  'auth.newRecoveryCode': 'write',
  'users.list': 'read',
  'users.create': 'write',
  'users.approve': 'write',
  'users.reject': 'write',
  'users.newRecoveryCode': 'write',
  'users.update': 'write',
  'users.resetPassword': 'write',
  'users.setCages': 'write',
  'roles.list': 'read',
  'roles.save': 'write',
  'roles.archive': 'write',
  'settings.get': 'read',
  'settings.save': 'write',
  'cages.list': 'read',
  'cages.create': 'write',
  'cages.update': 'write',
  'farms.list': 'read',
  'farms.save': 'write',
  'farms.setStatus': 'write',
  'farms.switch': 'write',
  'houses.list': 'read',
  'houses.save': 'write',
  'flocks.list': 'read',
  'flocks.get': 'read',
  'flocks.save': 'write',
  'flocks.place': 'write',
  'flocks.endPlacement': 'write',
  'flocks.close': 'write',
  'flocks.series': 'read',
  'flocks.reminders': 'read',
  'flocks.saveReminder': 'write',
  'flocks.dueReminders': 'read',
  'flocks.markReminder': 'write',
  'days.preview': 'read',
  'days.start': 'write',
  'days.overview': 'read',
  'days.list': 'read',
  'days.latest': 'read',
  'days.correctOpening': 'write',
  'days.confirmMortality': 'write',
  'days.confirmIssue': 'write',
  'days.revokeConfirmation': 'write',
  'days.saveComment': 'write',
  'days.close': 'write',
  'days.startAmendment': 'write',
  'days.finishAmendment': 'write',
  'days.amendments': 'read',
  'eggs.list': 'read',
  'eggs.save': 'write',
  'eggs.delete': 'write',
  'flock.list': 'read',
  'flock.listRange': 'read',
  'flock.add': 'write',
  'flock.transfer': 'write',
  'flock.delete': 'write',
  'feed.list': 'read',
  'feed.suggestOpening': 'read',
  'feed.save': 'write',
  'feed.delete': 'write',
  'water.list': 'read',
  'water.suggestOpening': 'read',
  'water.save': 'write',
  'water.delete': 'write',
  'medicine.treatments': 'read',
  'medicine.addTreatment': 'write',
  'medicine.deleteTreatment': 'write',
  'feeding.schedules': 'read',
  'feeding.saveSchedule': 'write',
  'feeding.status': 'read',
  'feeding.markFed': 'write',
  'medicine.withdrawals': 'read',
  'medicine.healthEvents': 'read',
  'medicine.addHealthEvent': 'write',
  'medicine.deleteHealthEvent': 'write',
  'inventory.items': 'read',
  'inventory.createItem': 'write',
  'inventory.updateItem': 'write',
  'inventory.balances': 'read',
  'inventory.batches': 'read',
  'inventory.txns': 'read',
  'inventory.record': 'write',
  'analytics.dashboard': 'read',
  'analytics.series': 'read',
  'analytics.comparison': 'read',
  'audit.list': 'read',
  'reports.preview': 'read',
  'reports.print': 'read',
  'reports.recent': 'read',
  'duties.mine': 'read',
  'parties.list': 'read',
  'parties.saveSupplier': 'write',
  'parties.saveCustomer': 'write',
  'purchases.list': 'read',
  'purchases.create': 'write',
  'purchases.approve': 'write',
  'purchases.reject': 'write',
  'purchases.orders': 'read',
  'purchases.createOrder': 'write',
  'purchases.closeOrder': 'write',
  'stores.list': 'read',
  'stores.save': 'write',
  'stores.balances': 'read',
  'stores.transfer': 'write',
  'stores.count': 'write',
  'stores.counts': 'read',
  'stores.movements': 'read',
  'overview.organization': 'read',
  'tasks.list': 'read',
  'tasks.get': 'read',
  'tasks.save': 'write',
  'tasks.action': 'write',
  'tasks.report': 'read',
  'tasks.assignees': 'read',
  'purchases.cancel': 'write',
  'purchases.series': 'read',
  'sales.stock': 'read',
  'sales.list': 'read',
  'sales.dispatch': 'write',
  'sales.addPayment': 'write',
  'sales.cancel': 'write',
  'sales.adjust': 'write',
  'sales.adjustments': 'read',
  'sales.series': 'read',
  'supply.flow': 'read',
  'admin.dbInfo': 'read',
  'admin.checkDb': 'read',
  'admin.optimize': 'read',
  'admin.activity': 'read',
  'backup.list': 'read',
  'backup.create': 'write',
  'backup.restore': 'write',
  'platform.status': 'read',
  'platform.login': 'write',
  'platform.logout': 'write',
  'platform.metrics': 'read',
  'platform.organizations': 'read',
  'platform.createOrganization': 'write',
  'platform.setOrganizationStatus': 'write',
  'platform.plans': 'read',
  'platform.savePlan': 'write',
  'platform.setSubscription': 'write',
  'platform.releases': 'read'
}
