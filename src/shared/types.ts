import type { FeedMethod, MortalityDenominator, ProductionDenominator } from './calc'

export type Role = 'admin' | 'operator'
export type Language = 'en' | 'si'

/**
 * Duties an administrator can give a user. Administrators always have all of them, plus the
 * admin-only tasks (closing days, amendments, settings, users, cages, stock adjustments).
 */
export const DUTIES = ['start_day', 'eggs', 'feed', 'water', 'flock', 'medicine', 'inventory', 'purchases', 'sales', 'reports', 'backup'] as const
export type Duty = (typeof DUTIES)[number]

export interface SessionUser {
  id: number
  /** Short name within the organization, shown in the audit history */
  username: string
  /** Sign-in name, unique across the platform */
  email: string
  displayName: string
  role: Role
  /** What this user may do (all duties for administrators) */
  duties?: Duty[]
  /** Cages this user looks after; null = all cages */
  cages?: number[] | null
}

export interface UserRow extends Omit<SessionUser, 'email'> {
  /** null for an account from before email sign-in: it cannot sign in until an administrator sets one */
  email: string | null
  duties: Duty[]
  cages: number[] | null
  active: boolean
  /** Signed up by themselves and waiting for an administrator */
  pending: boolean
  hasRecoveryCode: boolean
  createdAt: string
  lastLoginAt: string | null
}

export const EGG_SESSIONS = ['morning', 'midday', 'evening', 'extra'] as const
export type EggSession = (typeof EGG_SESSIONS)[number]

export const FLOCK_TYPES = ['death', 'removal', 'addition', 'transfer_in', 'transfer_out'] as const
export type FlockType = (typeof FLOCK_TYPES)[number]

export const INVENTORY_CATEGORIES = ['feed', 'medicine', 'supply'] as const
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number]

export const TXN_TYPES = [
  'opening',
  'purchase',
  'receipt',
  'issue',
  'usage',
  'return',
  'adjustment',
  'wastage',
  'expired'
] as const
export type TxnType = (typeof TXN_TYPES)[number]

export interface FarmSettings {
  farmName: string
  farmLocation: string
  timezone: string
  language: Language
  productionDenominator: ProductionDenominator
  mortalityDenominator: MortalityDenominator
  expectedEggSessions: EggSession[]
  productionDropPct: number
  baselineDays: number
  mortalityAlertPct: number
  waterChangePct: number
  medicineExpiryWarnDays: number
  medicineUnits: string[]
  backupEnabled: boolean
  backupIntervalHours: number
  backupRetention: number
  backupFolder: string | null
  /** People may request an account from the sign-in screen (an administrator must approve it) */
  allowSignup: boolean
  /** Look for a new version on start-up and every 6 hours (needs internet) */
  autoCheckUpdates: boolean
  /** Currency shown on sales and purchases */
  currency: string
  setupComplete: boolean
}

export interface Cage {
  id: number
  code: string
  name: string
  initialHens: number
  capacity: number | null
  hasWaterMeter: boolean
  active: boolean
  sortOrder: number
  notes: string | null
}

export type DayStatus = 'not_started' | 'in_progress' | 'ready_to_close' | 'closed'

export interface MovementTotals {
  deaths: number
  removals: number
  additions: number
  transfersIn: number
  transfersOut: number
}

export interface CageDaySummary {
  cageId: number
  code: string
  name: string
  carried: number
  adjustment: number
  adjustmentReason: string | null
  opening: number
  movements: MovementTotals
  closing: number
  avgHens: number
  eggs: { good: number; damaged: number; rejected: number; collected: number; saleable: number; sessions: EggSession[] }
  productionPct: number | null
  feed: { consumption: number | null; isEstimate: boolean; issued: number; wasted: number; records: number; hasError: boolean }
  water: { litres: number | null; recorded: boolean }
  medicineUses: number
  mortalityPct: number | null
  mortalityConfirmed: boolean
}

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface DayIssue {
  /** Unique within a day+cage; used to store a confirmation */
  key: string
  code: string
  severity: IssueSeverity
  cageId: number | null
  params: Record<string, string | number>
  /** Can be accepted with a recorded reason (otherwise it must be fixed) */
  confirmable: boolean
  confirmation: { reason: string; by: string; at: string } | null
}

export interface DayTotals {
  opening: number
  closing: number
  avgHens: number
  movements: MovementTotals
  eggs: { good: number; damaged: number; rejected: number; collected: number; saleable: number }
  productionPct: number | null
  feedKg: number | null
  feedIsEstimate: boolean
  waterLitres: number | null
  medicineUses: number
  mortalityPct: number | null
}

export interface DayOverview {
  date: string
  dayId: number | null
  status: DayStatus
  amendmentOpen: boolean
  openedAt: string | null
  openedBy: string | null
  closedAt: string | null
  closedBy: string | null
  managerComment: string | null
  cages: CageDaySummary[]
  totals: DayTotals
  issues: DayIssue[]
  previousDay: { date: string; status: DayStatus } | null
}

export interface StartDayPreview {
  date: string
  exists: boolean
  previous: { date: string; status: DayStatus } | null
  gapDays: number
  laterDayExists: boolean
  cages: { cageId: number; code: string; name: string; carried: number }[]
  inventory: InventoryBalance[]
  warnings: string[]
}

export interface EggCollection {
  id: number
  date: string
  cageId: number
  cageName: string
  session: EggSession
  collectedAt: string | null
  good: number
  damaged: number
  rejected: number
  notes: string | null
  recordedBy: string | null
  updatedAt: string
}

export interface FlockMovement {
  id: number
  date: string
  cageId: number
  cageName: string
  type: FlockType
  quantity: number
  reason: string | null
  notes: string | null
  transferRef: string | null
  counterpartCageId: number | null
  counterpartCageName: string | null
  recordedBy: string | null
  createdAt: string
}

export interface FeedRecord {
  id: number
  date: string
  cageId: number
  cageName: string
  itemId: number
  itemName: string
  batchNo: string | null
  openingStock: number | null
  issued: number
  returned: number
  wasted: number
  measuredConsumption: number | null
  closingStock: number | null
  consumption: number | null
  method: FeedMethod | null
  isEstimate: boolean
  error: string | null
  notes: string | null
  recordedBy: string | null
}

export interface WaterRecord {
  id: number
  date: string
  cageId: number
  cageName: string
  method: 'meter' | 'manual'
  openingReading: number | null
  closingReading: number | null
  litres: number | null
  meterReset: boolean
  correctionReason: string | null
  notes: string | null
  recordedBy: string | null
}

export interface InventoryItem {
  id: number
  category: InventoryCategory
  name: string
  unit: string
  lowStockThreshold: number | null
  active: boolean
  notes: string | null
}

export interface InventoryBalance extends InventoryItem {
  balance: number
  isLow: boolean
}

export interface InventoryBatch {
  id: number
  itemId: number
  itemName: string
  unit: string
  batchNo: string
  expiryDate: string | null
  balance: number
  daysToExpiry: number | null
}

export interface InventoryTxn {
  id: number
  itemId: number
  itemName: string
  unit: string
  batchNo: string | null
  txnDate: string
  cageName: string | null
  type: TxnType
  quantity: number
  unitCost: number | null
  supplier: string | null
  reference: string | null
  notes: string | null
  sourceType: string | null
  recordedBy: string | null
  createdAt: string
}

export interface Treatment {
  id: number
  date: string
  cageId: number | null
  cageName: string | null
  itemId: number
  itemName: string
  unit: string
  batchId: number | null
  batchNo: string | null
  expiryDate: string | null
  quantity: number
  administeredAt: string | null
  reason: string
  prescribedBy: string | null
  notes: string | null
  recordedBy: string | null
}

export interface HealthEvent {
  id: number
  date: string
  cageId: number | null
  cageName: string | null
  eventTime: string | null
  category: string
  severity: 'low' | 'medium' | 'high'
  description: string
  actionTaken: string | null
  recordedBy: string | null
}

export interface AuditEntry {
  id: number
  at: string
  username: string | null
  action: string
  entity: string
  entityId: number | null
  date: string | null
  reason: string | null
  details: string | null
}

export interface DailySeriesPoint {
  date: string
  status: DayStatus
  opening: number
  closing: number
  eggs: number
  good: number
  damaged: number
  rejected: number
  productionPct: number | null
  feedKg: number | null
  waterLitres: number | null
  deaths: number
  cumulativeDeaths: number
  mortalityPct: number | null
  feedPerHenG: number | null
}

export interface CageComparisonRow {
  cageId: number
  code: string
  name: string
  eggs: number
  good: number
  damaged: number
  rejected: number
  avgProductionPct: number | null
  feedKg: number | null
  waterLitres: number | null
  deaths: number
  closingHens: number | null
  mortalityPct: number | null
}

export interface Alert {
  code: string
  severity: IssueSeverity
  params: Record<string, string | number>
}

export interface DashboardData {
  date: string
  today: DayOverview
  inventory: { feedKg: number; medicineItems: number; lowStock: InventoryBalance[]; expiring: InventoryBatch[] }
  alerts: Alert[]
  isDemo: boolean
}

export interface BackupInfo {
  id: number
  kind: 'manual' | 'auto' | 'pre_restore' | 'pre_migration'
  path: string | null
  sizeBytes: number | null
  status: 'ok' | 'failed'
  message: string | null
  createdAt: string
}

export interface BackupFileCheck {
  path: string
  ok: boolean
  schemaVersion: number
  farmName: string | null
  lastDate: string | null
  dayCount: number
  error: string | null
}

export interface AppStatus {
  /** The platform has at least one organization (otherwise the first-run setup is shown) */
  setupComplete: boolean
  /** The signed-in user's organization and the farm they are working on */
  organization: { code: string; name: string } | null
  farm: { id: number; name: string } | null
  /** The first-run setup asks for the installation's setup key (SETUP_KEY on the server). */
  setupKeyRequired: boolean
  isDemo: boolean
  demoAvailable: boolean
  demoExists: boolean
  user: SessionUser | null
  settings: FarmSettings
  version: string
  /** Where the farm data is stored, e.g. "localhost:3306 / poultry_farm" */
  dataDir: string
  today: string
  backupWarning: string | null
  pendingSignups: number
}

export interface Party {
  id: number
  name: string
  phone: string | null
  address: string | null
  notes: string | null
  active: boolean
}

export interface GoodsReceiptLine {
  itemId: number
  itemName: string
  category: InventoryCategory
  unit: string
  batchNo: string | null
  expiryDate: string | null
  quantity: number
  unitCost: number | null
}

export interface GoodsReceipt {
  id: number
  grnNo: string
  date: string
  supplierId: number | null
  supplierName: string | null
  invoiceNo: string | null
  vehicle: string | null
  notes: string | null
  totalCost: number
  lines: GoodsReceiptLine[]
  recordedBy: string | null
  createdAt: string
}

export interface EggDispatch {
  id: number
  dispatchNo: string
  date: string
  customerId: number
  customerName: string
  goodQty: number
  goodPrice: number
  crackedQty: number
  crackedPrice: number
  amount: number
  amountPaid: number
  balance: number
  paymentStatus: 'paid' | 'partial' | 'unpaid'
  invoiceNo: string | null
  vehicle: string | null
  driver: string | null
  notes: string | null
  recordedBy: string | null
}

export interface EggStock {
  good: number
  cracked: number
}

export interface EggStoreAdjustment {
  id: number
  date: string
  grade: 'good' | 'cracked'
  quantity: number
  reason: string
  recordedBy: string | null
}

export interface SalesDay {
  date: string
  collectedGood: number
  collectedCracked: number
  dispatchedGood: number
  dispatchedCracked: number
  revenue: number
  received: number
  stockGood: number
  stockCracked: number
}

export interface PurchasesDay {
  date: string
  feedKg: number
  cost: number
  feedIssuedKg: number
  feedStockKg: number
}

export interface FlowSummary {
  from: string
  to: string
  feed: { openingKg: number; receivedKg: number; issuedKg: number; consumedKg: number | null; closingKg: number; purchaseCost: number }
  eggs: { collected: number; good: number; cracked: number; rejected: number; dispatchedGood: number; dispatchedCracked: number; openingGood: number; closingGood: number; openingCracked: number; closingCracked: number }
  money: { sales: number; received: number; outstanding: number; purchases: number }
  hens: { opening: number | null; closing: number | null; deaths: number }
  topCustomers: { name: string; eggs: number; amount: number }[]
  topSuppliers: { name: string; quantity: number; cost: number }[]
}

export interface DutyTask {
  key: string
  duty: Duty
  cageId: number | null
  cageName: string | null
  params: Record<string, string | number>
  done: boolean
}

export interface DbInfo {
  /** Where the data lives, e.g. "localhost:3306 / poultry_farm" */
  file: string
  sizeBytes: number
  schemaVersion: number
  /** e.g. "MySQL 8.4.2" */
  serverVersion: string
  tables: { name: string; rows: number }[]
  lastBackup: { status: string; createdAt: string; path: string | null } | null
  backupsOk30d: number
  lastCheck: { at: string; ok: boolean; message: string } | null
}

export interface ActivitySummary {
  byDay: { date: string; changes: number; logins: number; failedLogins: number }[]
  byUser: { username: string; changes: number; lastAt: string | null }[]
  byAction: { action: string; count: number }[]
}
