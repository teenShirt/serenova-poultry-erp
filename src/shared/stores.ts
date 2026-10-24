import type { InventoryCategory, TxnType } from './types'

/** Stores, purchase orders, receipts, transfers and stock counts. Shared by the server and the browser. */

/** Movement types a user records directly; transfers, counts and reversals have their own screens. */
export const MANUAL_TXN_TYPES = [
  'opening',
  'purchase',
  'receipt',
  'issue',
  'usage',
  'return',
  'adjustment',
  'wastage',
  'expired'
] as const satisfies readonly TxnType[]

export interface Warehouse {
  id: number
  farmId: number
  farmName: string
  code: string
  name: string
  isMain: boolean
  active: boolean
  notes: string | null
}

export interface StoreBalance {
  itemId: number
  itemName: string
  category: InventoryCategory
  sku: string | null
  unit: string
  warehouseId: number
  warehouseName: string
  balance: number
  /** Weighted average cost of what was bought (null when no purchase had a cost) */
  avgCost: number | null
  value: number | null
  lowStockThreshold: number | null
  reorderLevel: number | null
  isLow: boolean
  needsReorder: boolean
}

export interface PurchaseOrderLine {
  id: number
  itemId: number
  itemName: string
  unit: string
  quantity: number
  unitCost: number | null
  /** Accepted into stock on posted receipts so far */
  received: number
}

export interface PurchaseOrder {
  id: number
  poNo: string
  orderDate: string
  expectedDate: string | null
  supplierId: number
  supplierName: string
  warehouseId: number
  warehouseName: string
  /** open, partly received, received (computed from posted receipts), closed or cancelled */
  status: 'open' | 'partial' | 'received' | 'closed' | 'cancelled'
  notes: string | null
  createdBy: string | null
  createdAt: string
  lines: PurchaseOrderLine[]
  total: number
}

export interface PurchaseOrderInput {
  orderDate: string
  expectedDate: string | null
  supplierId: number
  warehouseId: number
  notes: string | null
  lines: { itemId: number; quantity: number; unitCost: number | null }[]
}

export interface ReceiptLineInput {
  itemId: number
  /** The purchase-order line this delivers against */
  poLineId: number | null
  /** Delivered quantity; accepted = delivered − rejected − damaged */
  quantity: number
  rejectedQty: number
  damagedQty: number
  rejectReason: string | null
  unitCost: number | null
  batchNo: string | null
  expiryDate: string | null
}

export interface TransferInput {
  date: string
  fromWarehouseId: number
  toWarehouseId: number
  notes: string | null
  lines: { itemId: number; batchNo: string | null; quantity: number }[]
}

export interface StockCountInput {
  warehouseId: number
  date: string
  notes: string | null
  /** Counted quantity for each item (and batch) counted; items not listed are not changed */
  lines: { itemId: number; batchId: number | null; countedQty: number }[]
}

export interface StockCountRow {
  id: number
  date: string
  warehouseName: string
  countedBy: string | null
  notes: string | null
  lines: { itemName: string; unit: string; batchNo: string | null; systemQty: number; countedQty: number; difference: number }[]
}

// ---------------------------------------------------------------- tasks

export const TASK_CATEGORIES = ['feeding', 'cleaning', 'vaccination', 'egg_collection', 'stock_count', 'inspection', 'water_system', 'other'] as const
export type TaskCategory = (typeof TASK_CATEGORIES)[number]
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'verified' | 'cancelled'
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly'

export interface TaskInput {
  /** For a one-time task; recurring tasks are edited through their series */
  id: number | null
  title: string
  category: TaskCategory
  priority: TaskPriority
  instructions: string | null
  completionCriteria: string | null
  farmId: number | null
  houseId: number | null
  /** A person, or a team (everyone with that role) */
  assigneeUserId: number | null
  assigneeRoleId: number | null
  startDate: string
  dueDate: string
  recurrence: Recurrence
  /** Last date of a recurring task (none = no end) */
  untilDate: string | null
}

export interface TaskRow {
  id: number
  seriesId: number | null
  recurrence: Recurrence
  title: string
  category: TaskCategory
  priority: TaskPriority
  instructions: string | null
  completionCriteria: string | null
  farmId: number | null
  farmName: string | null
  houseId: number | null
  houseName: string | null
  assigneeUserId: number | null
  assigneeName: string | null
  assigneeRoleId: number | null
  assigneeRoleName: string | null
  startDate: string
  dueDate: string
  status: TaskStatus
  /** Past its due date and not finished */
  overdue: boolean
  /** The signed-in user may start or complete it */
  mine: boolean
  createdBy: string | null
  completedBy: string | null
  completedAt: string | null
  verifiedBy: string | null
  verifiedAt: string | null
}

export interface TaskEvent {
  at: string
  user: string | null
  action: string
  note: string | null
}

export interface TaskReportRow {
  /** First day of the week or month */
  period: string
  total: number
  completedOnTime: number
  completedLate: number
  verified: number
  open: number
  overdue: number
  cancelled: number
}
