import { addDays, daysBetween } from './dates'

/**
 * Flocks (batches) and their age. Shared by the server and the browser.
 *
 * Age convention: the hatch date is day 0. Age in days = calendar days since the hatch date
 * (in the farm's time zone); age in weeks = completed weeks (days ÷ 7, rounded down). So a flock
 * hatched on 1 January is 0 days old that day, 7 days / 1 week old on 8 January.
 */
export interface FlockAge {
  days: number
  weeks: number
  /** Days into the current week (0–6) */
  dayOfWeek: number
}

export function flockAge(hatchDate: string, on: string): FlockAge {
  const days = Math.max(0, daysBetween(hatchDate, on))
  return { days, weeks: Math.floor(days / 7), dayOfWeek: days % 7 }
}

/** The hatch date for birds that were `ageDays` old when they arrived. */
export function hatchDateFromArrival(arrivalDate: string, ageDays: number): string {
  return addDays(arrivalDate, -ageDays)
}

/** A production stage starts at an age in completed weeks and lasts until the next stage starts. */
export interface ProductionStage {
  name: string
  fromWeek: number
}

/**
 * Starting stages for a new organization, to be adjusted to the breed's management guide in
 * Settings. Names of these defaults are translated (stage.<name>); names typed by users are shown as typed.
 */
export const DEFAULT_STAGES: ProductionStage[] = [
  { name: 'brooding', fromWeek: 0 },
  { name: 'growing', fromWeek: 6 },
  { name: 'pre_lay', fromWeek: 16 },
  { name: 'laying', fromWeek: 18 }
]

export function stageFor(stages: ProductionStage[], weeks: number): ProductionStage | null {
  let found: ProductionStage | null = null
  for (const s of [...stages].sort((a, b) => a.fromWeek - b.fromWeek)) if (weeks >= s.fromWeek) found = s
  return found
}

export type FlockSource = 'hatched' | 'purchased'

export interface FlockInput {
  id: number | null
  code: string
  breed: string | null
  source: FlockSource
  /** The hatch date when known; otherwise give the age on arrival */
  hatchDate: string | null
  arrivalDate: string
  ageOnArrivalDays: number | null
  initialCount: number
  notes: string | null
}

export interface FlockPlacement {
  id: number
  cageId: number
  cageCode: string
  cageName: string
  houseName: string | null
  fromDate: string
  toDate: string | null
}

export interface FlockSummary {
  id: number
  code: string
  breed: string | null
  source: FlockSource
  hatchDate: string
  hatchDateEstimated: boolean
  arrivalDate: string
  initialCount: number
  status: 'active' | 'closed'
  closedOn: string | null
  closeReason: string | null
  notes: string | null
  /** Age today (or on the closing date) */
  age: FlockAge
  stage: string | null
  /** Hens now in the flock's cages (from the latest day's closing counts) */
  currentHens: number
  /** Deaths recorded in the flock's cages while it was there */
  deaths: number
  cages: FlockPlacement[]
}

export interface ReminderRow {
  id: number
  atWeek: number
  title: string
  instructions: string | null
  active: boolean
}

export interface ReminderDue {
  flockId: number
  flockCode: string
  reminderId: number
  atWeek: number
  title: string
  instructions: string | null
  /** due: the flock is in this week of age now; overdue: past it and not marked */
  state: 'upcoming' | 'due' | 'overdue' | 'done' | 'skipped'
  dueOn: string
  doneAt: string | null
  doneBy: string | null
  note: string | null
}

export interface FlockDetail extends FlockSummary {
  placements: FlockPlacement[]
  reminders: ReminderDue[]
  treatments: { date: string; cageCode: string; item: string; quantity: number; unit: string; reason: string | null; prescribedBy: string | null }[]
}

export interface FarmRow {
  id: number
  code: string
  name: string
  location: string | null
  status: 'active' | 'archived'
  cages: number
  activeFlocks: number
  current: boolean
}

export interface HouseRow {
  id: number
  code: string
  name: string
  active: boolean
  sortOrder: number
  notes: string | null
  cages: number
}
