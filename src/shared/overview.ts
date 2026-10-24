/**
 * The organization overview: the same figures for every farm over one period, and their totals.
 *
 * Definitions (closed days only, so a day still being recorded never distorts a figure):
 * - birds now: the latest day's closing count of the farm's cages (their starting counts before any day)
 * - bird-days: the sum over closed days of (opening + closing hens) ÷ 2
 * - laying rate: eggs collected ÷ bird-days × 100
 * - mortality: deaths ÷ hens at the opening of the first closed day of the period × 100
 * - feed per bird per day: feed consumed (kg) × 1000 ÷ bird-days, in grams
 * - culls: birds removed (sold or culled) in the period
 */
export interface FarmOverviewRow {
  farmId: number
  farmName: string
  closedDays: number
  /** Days in the period that were started but not closed (not counted) */
  openDays: number
  birdsNow: number
  eggs: number
  layingPct: number | null
  deaths: number
  culls: number
  mortalityPct: number | null
  feedKg: number
  waterLitres: number
  feedPerBirdG: number | null
  activeFlocks: number
  tasksDue: number
  tasksOverdue: number
  remindersDue: number
  lowStockItems: number
  expiringBatches: number
}

export interface OrganizationOverview {
  from: string
  to: string
  farms: FarmOverviewRow[]
  totals: Omit<FarmOverviewRow, 'farmId' | 'farmName'>
  /** Eggs per closed day for each farm (null where the farm had no closed day) */
  trend: { date: string; [farmId: string]: number | string | null }[]
  stockAlerts: { farmName: string; warehouseName: string; item: string; balance: number; unit: string; kind: 'low' | 'reorder' }[]
  expiring: { farmName: string; item: string; batchNo: string; expiryDate: string; daysToExpiry: number; balance: number; unit: string }[]
  reminders: { farmName: string; flockCode: string; title: string; atWeek: number; state: 'due' | 'overdue'; dueOn: string }[]
  recentReceipts: { grnNo: string; date: string; supplier: string | null; store: string; status: string; total: number }[]
  recentMovements: { date: string; store: string; item: string; type: string; quantity: number; unit: string; by: string | null }[]
}

export interface MovementPage {
  rows: {
    id: number
    date: string
    store: string
    counterpart: string | null
    item: string
    batchNo: string | null
    type: string
    quantity: number
    unit: string
    reference: string | null
    notes: string | null
    by: string | null
  }[]
  total: number
  page: number
  pageSize: number
}

/** CSV downloads (Excel opens them; UTF-8 with BOM so Sinhala text shows correctly). */
export const CSV_KINDS = ['organization', 'production', 'movements', 'receipts', 'tasks'] as const
export type CsvKind = (typeof CSV_KINDS)[number]
