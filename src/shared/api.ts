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
  Role,
  SessionUser,
  StartDayPreview,
  Treatment,
  TxnType,
  UserRow,
  ActivitySummary,
  DbInfo,
  Duty,
  DutyTask,
  EggDispatch,
  EggStock,
  EggStoreAdjustment,
  FlowSummary,
  GoodsReceipt,
  Party,
  PurchasesDay,
  SalesDay,
  WaterRecord
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
}

export interface ItemInputDto {
  category: InventoryCategory
  name: string
  unit: string
  lowStockThreshold: number | null
  active: boolean
  notes: string | null
}

export interface SetupDto {
  farmName: string
  farmLocation: string
  timezone: string
  language: Language
  startDate: string
  cages: { code: string; name: string; initialHens: number; hasWaterMeter: boolean }[]
  admin: { username: string; displayName: string; password: string }
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
  lines: { itemId: number; quantity: number; unitCost: number | null; batchNo: string | null; expiryDate: string | null }[]
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
  'demo.enter': { in: void; out: { username: string; password: string } }
  'demo.exit': { in: void; out: void }
  'demo.reset': { in: void; out: void }

  'auth.login': { in: { username: string; password: string }; out: SessionUser }
  'auth.logout': { in: void; out: void }
  'auth.changePassword': { in: { current: string; next: string }; out: void }
  'auth.signup': { in: { username: string; displayName: string; password: string }; out: { recoveryCode: string } }
  'auth.resetWithCode': { in: { username: string; recoveryCode: string; newPassword: string }; out: { recoveryCode: string } }
  'auth.newRecoveryCode': { in: { password: string }; out: { recoveryCode: string } }
  'users.list': { in: void; out: UserRow[] }
  'users.create': { in: { username: string; displayName: string; password: string; role: Role }; out: { id: number; recoveryCode: string } }
  'users.approve': { in: { id: number; role: Role }; out: void }
  'users.reject': { in: { id: number }; out: void }
  'users.newRecoveryCode': { in: { id: number }; out: { recoveryCode: string } }
  'users.update': { in: { id: number; displayName: string; role: Role; active: boolean }; out: void }
  'users.resetPassword': { in: { id: number; password: string }; out: void }

  'settings.get': { in: void; out: FarmSettings }
  'settings.save': { in: Partial<FarmSettings>; out: FarmSettings }

  'cages.list': { in: { includeInactive?: boolean }; out: (Cage & { hasHistory: boolean })[] }
  'cages.create': { in: CageInputDto; out: number }
  'cages.update': { in: { id: number; cage: CageInputDto; reason: string | null }; out: void }

  'days.preview': { in: DateArg; out: StartDayPreview }
  'days.start': {
    in: { date: string; corrections: { cageId: number; opening: number; reason: string }[]; acknowledgeWarnings: boolean }
    out: DayOverview
  }
  'days.overview': { in: DateArg; out: DayOverview }
  'days.list': { in: { from: string; to: string }; out: { date: string; status: 'in_progress' | 'closed'; amendmentOpen: number; closedAt: string | null; amendments: number }[] }
  'days.latest': { in: void; out: { date: string; status: 'in_progress' | 'closed' } | null }
  'days.correctOpening': { in: { date: string; cageId: number; opening: number; reason: string }; out: void }
  'days.confirmMortality': { in: { date: string; cageIds: number[] }; out: void }
  'days.confirmIssue': { in: { date: string; cageId: number | null; key: string; reason: string }; out: void }
  'days.revokeConfirmation': { in: { date: string; cageId: number | null; key: string }; out: void }
  'days.saveComment': { in: { date: string; comment: string }; out: void }
  'days.close': { in: { date: string; comment: string | null }; out: { overview: DayOverview } }
  'days.startAmendment': { in: { date: string; reason: string }; out: void }
  'days.finishAmendment': { in: { date: string; comment: string | null }; out: DayOverview }
  'days.amendments': { in: DateArg; out: { id: number; reason: string; openedAt: string; closedAt: string | null; openedBy: string | null; closedBy: string | null }[] }

  'eggs.list': { in: { date: string; cageId?: number }; out: EggCollection[] }
  'eggs.save': {
    in: { expectedId: number | null; date: string; cageId: number; session: EggSession; collectedAt: string | null; good: number; damaged: number; rejected: number; notes: string | null }
    out: number
  }
  'eggs.delete': { in: WithReason; out: void }

  'flock.list': { in: { date: string; cageId?: number }; out: FlockMovement[] }
  'flock.listRange': { in: Range; out: FlockMovement[] }
  'flock.add': { in: { date: string; cageId: number; type: 'death' | 'removal' | 'addition'; quantity: number; reason: string | null; notes: string | null }; out: number }
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
    in: { date: string; cageId: number | null; itemId: number; batchId: number | null; quantity: number; administeredAt: string | null; reason: string; prescribedBy: string | null; notes: string | null }
    out: number
  }
  'medicine.deleteTreatment': { in: WithReason; out: void }
  'medicine.healthEvents': { in: Range; out: HealthEvent[] }
  'medicine.addHealthEvent': {
    in: { date: string; cageId: number | null; eventTime: string | null; category: string; severity: 'low' | 'medium' | 'high'; description: string; actionTaken: string | null }
    out: number
  }
  'medicine.deleteHealthEvent': { in: WithReason; out: void }

  'inventory.items': { in: { category?: InventoryCategory }; out: InventoryItem[] }
  'inventory.createItem': { in: ItemInputDto; out: number }
  'inventory.updateItem': { in: { id: number; item: ItemInputDto }; out: void }
  'inventory.balances': { in: { category?: InventoryCategory }; out: InventoryBalance[] }
  'inventory.batches': { in: { itemId?: number; onlyInStock?: boolean }; out: InventoryBatch[] }
  'inventory.txns': { in: { itemId?: number; category?: InventoryCategory; from?: string; to?: string; limit?: number }; out: InventoryTxn[] }
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
  'users.setDuties': { in: { id: number; duties: Duty[]; cages: number[] | null }; out: void }

  'parties.list': { in: { kind: 'supplier' | 'customer' }; out: Party[] }
  'parties.saveSupplier': { in: PartyDto; out: number }
  'parties.saveCustomer': { in: PartyDto; out: number }
  'purchases.list': { in: { from: string; to: string }; out: GoodsReceipt[] }
  'purchases.create': { in: ReceiptDto; out: { id: number; grnNo: string } }
  'purchases.cancel': { in: { id: number; reason: string }; out: void }
  'purchases.series': { in: { from: string; to: string }; out: PurchasesDay[] }
  'sales.stock': { in: void; out: EggStock & { outstanding: number } }
  'sales.list': { in: { from: string; to: string; customerId?: number | null; unpaidOnly?: boolean }; out: EggDispatch[] }
  'sales.dispatch': { in: DispatchDto; out: { id: number; dispatchNo: string } }
  'sales.addPayment': { in: { dispatchId: number; date: string; amount: number; method: 'cash' | 'bank' | 'cheque' | 'other'; reference: string | null }; out: void }
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
  'users.setDuties': 'write',
  'settings.get': 'read',
  'settings.save': 'write',
  'cages.list': 'read',
  'cages.create': 'write',
  'cages.update': 'write',
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
  'backup.restore': 'write'
}
