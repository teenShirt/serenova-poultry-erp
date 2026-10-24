import type { ApiMethod } from './api'
import type { Duty } from './types'

/**
 * Everything a role can allow, as `module.action`. Organization roles are made of these.
 * Viewing records is open to every member of the organization; these control what they may do.
 */
export const PERMISSIONS = [
  'day.start',
  'day.backfill',
  'day.correct_opening',
  'day.approve_issues',
  'day.comment',
  'day.close',
  'day.amend',
  'eggs.record',
  'feed.record',
  'water.record',
  'water.meter_reset',
  'flock.record',
  'medicine.record',
  'inventory.record',
  'inventory.adjust',
  'inventory.manage_items',
  'purchases.record',
  'purchases.cancel',
  'sales.record',
  'sales.cancel',
  'sales.adjust_store',
  'cages.manage',
  'reports.view',
  'reports.export',
  'backup.create',
  'backup.restore',
  'users.manage',
  'roles.manage',
  'settings.manage',
  'audit.view',
  'database.manage'
] as const
export type Permission = (typeof PERMISSIONS)[number]

/** How the permissions are grouped on the role screen. */
export const PERMISSION_GROUPS: { key: string; permissions: Permission[] }[] = [
  { key: 'day', permissions: ['day.start', 'day.backfill', 'day.correct_opening', 'day.approve_issues', 'day.comment', 'day.close', 'day.amend'] },
  { key: 'records', permissions: ['eggs.record', 'feed.record', 'water.record', 'water.meter_reset', 'flock.record', 'medicine.record'] },
  { key: 'stores', permissions: ['inventory.record', 'inventory.adjust', 'inventory.manage_items', 'purchases.record', 'purchases.cancel'] },
  { key: 'sales', permissions: ['sales.record', 'sales.cancel', 'sales.adjust_store'] },
  { key: 'reports', permissions: ['reports.view', 'reports.export', 'audit.view'] },
  { key: 'admin', permissions: ['cages.manage', 'users.manage', 'roles.manage', 'settings.manage', 'backup.create', 'backup.restore', 'database.manage'] }
]

/**
 * The permission each request needs. Requests not listed only need a signed-in member of the
 * organization (reading, and actions on one's own account). Some services check further
 * permissions for particular cases (e.g. a stock adjustment, or a back-dated day).
 */
export const PERMISSION_FOR_METHOD: Partial<Record<ApiMethod, Permission>> = {
  'users.list': 'users.manage',
  'users.create': 'users.manage',
  'users.update': 'users.manage',
  'users.resetPassword': 'users.manage',
  'users.approve': 'users.manage',
  'users.reject': 'users.manage',
  'users.newRecoveryCode': 'users.manage',
  'users.setCages': 'users.manage',
  'roles.list': 'users.manage',
  'roles.save': 'roles.manage',
  'roles.archive': 'roles.manage',
  'settings.save': 'settings.manage',
  'cages.create': 'cages.manage',
  'cages.update': 'cages.manage',
  'days.start': 'day.start',
  'days.correctOpening': 'day.correct_opening',
  'days.confirmMortality': 'flock.record',
  'days.confirmIssue': 'day.approve_issues',
  'days.revokeConfirmation': 'day.approve_issues',
  'days.saveComment': 'day.comment',
  'days.close': 'day.close',
  'days.startAmendment': 'day.amend',
  'days.finishAmendment': 'day.amend',
  'eggs.save': 'eggs.record',
  'eggs.delete': 'eggs.record',
  'feed.save': 'feed.record',
  'feed.delete': 'feed.record',
  'water.save': 'water.record',
  'water.delete': 'water.record',
  'flock.add': 'flock.record',
  'flock.transfer': 'flock.record',
  'flock.delete': 'flock.record',
  'medicine.addTreatment': 'medicine.record',
  'medicine.deleteTreatment': 'medicine.record',
  'medicine.addHealthEvent': 'medicine.record',
  'medicine.deleteHealthEvent': 'medicine.record',
  'inventory.createItem': 'inventory.manage_items',
  'inventory.updateItem': 'inventory.manage_items',
  'inventory.record': 'inventory.record',
  'parties.saveSupplier': 'purchases.record',
  'purchases.create': 'purchases.record',
  'purchases.cancel': 'purchases.cancel',
  'parties.saveCustomer': 'sales.record',
  'sales.dispatch': 'sales.record',
  'sales.addPayment': 'sales.record',
  'sales.cancel': 'sales.cancel',
  'sales.adjust': 'sales.adjust_store',
  'reports.preview': 'reports.view',
  'reports.print': 'reports.view',
  'audit.list': 'audit.view',
  'admin.dbInfo': 'database.manage',
  'admin.checkDb': 'database.manage',
  'admin.optimize': 'database.manage',
  'admin.activity': 'audit.view',
  'backup.create': 'backup.create',
  'backup.restore': 'backup.restore'
}

/**
 * The jobs shown under "My duties today", derived from what the user's role allows.
 * (Before roles existed, these duties were assigned to each user directly.)
 */
export const DUTY_PERMISSION: Record<Duty, Permission> = {
  start_day: 'day.start',
  eggs: 'eggs.record',
  feed: 'feed.record',
  water: 'water.record',
  flock: 'flock.record',
  medicine: 'medicine.record',
  inventory: 'inventory.record',
  purchases: 'purchases.record',
  sales: 'sales.record',
  reports: 'reports.view',
  backup: 'backup.create'
}

/** Suggested roles an organization can start from (they are copied and can be changed). */
export const ROLE_TEMPLATES: { key: string; permissions: Permission[] }[] = [
  {
    key: 'farm_manager',
    permissions: PERMISSIONS.filter((p) => !['users.manage', 'roles.manage', 'settings.manage', 'backup.restore', 'database.manage'].includes(p))
  },
  { key: 'farm_supervisor', permissions: ['day.start', 'day.approve_issues', 'day.comment', 'eggs.record', 'feed.record', 'water.record', 'flock.record', 'medicine.record', 'reports.view'] },
  { key: 'poultry_technician', permissions: ['day.start', 'eggs.record', 'feed.record', 'water.record', 'flock.record'] },
  { key: 'veterinarian', permissions: ['medicine.record', 'flock.record', 'reports.view'] },
  { key: 'storekeeper', permissions: ['inventory.record', 'inventory.adjust', 'inventory.manage_items', 'purchases.record', 'feed.record', 'reports.view'] },
  { key: 'purchasing_officer', permissions: ['purchases.record', 'purchases.cancel', 'inventory.record', 'reports.view', 'reports.export'] },
  { key: 'accountant', permissions: ['sales.record', 'sales.cancel', 'reports.view', 'reports.export', 'audit.view'] },
  { key: 'report_viewer', permissions: ['reports.view', 'reports.export'] },
  { key: 'general_employee', permissions: ['eggs.record', 'feed.record', 'water.record'] }
]
