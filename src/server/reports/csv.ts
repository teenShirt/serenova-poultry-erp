import { translate } from '@shared/i18n'
import type { CsvKind } from '@shared/overview'
import type { Ctx } from '../context'
import { dailySeries } from '../services/analytics'
import { organizationOverview, movementsPage } from '../services/overview'
import { listReceipts } from '../services/purchases'
import { getSettings } from '../services/settings'
import { listTasks } from '../services/tasks'

type Cell = string | number | null | undefined

/**
 * One CSV cell. Text that a spreadsheet would read as a formula (=, +, -, @, tab, return) is
 * prefixed with an apostrophe, so an exported name can never run as a formula in Excel.
 */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  let s = v
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(header: string[], rows: Cell[][]): string {
  // UTF-8 byte-order mark: Excel then shows Sinhala text correctly.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** The rows of each CSV download (the signed-in user's organization, and the farm they work on). */
export async function buildCsv(ctx: Ctx, kind: CsvKind, from: string, to: string, f: { warehouseId?: number | null }): Promise<{ name: string; csv: string }> {
  const lang = (await getSettings(ctx)).language
  const t = (k: string) => translate(lang, k)
  const stem = `${kind}-${from}-${to}`
  switch (kind) {
    case 'organization': {
      const o = await organizationOverview(ctx, from, to)
      const cols: [string, (r: (typeof o.farms)[number]) => Cell][] = [
        ['ov.farm', (r) => r.farmName],
        ['ov.closedDays', (r) => r.closedDays],
        ['ov.birdsNow', (r) => r.birdsNow],
        ['ov.eggs', (r) => r.eggs],
        ['ov.layingPct', (r) => r.layingPct],
        ['ov.deaths', (r) => r.deaths],
        ['ov.culls', (r) => r.culls],
        ['ov.mortalityPct', (r) => r.mortalityPct],
        ['ov.feedKg', (r) => r.feedKg],
        ['ov.feedPerBird', (r) => r.feedPerBirdG],
        ['ov.waterL', (r) => r.waterLitres],
        ['ov.flocks', (r) => r.activeFlocks],
        ['ov.tasksOverdue', (r) => r.tasksOverdue],
        ['ov.lowStock', (r) => r.lowStockItems],
        ['ov.expiring', (r) => r.expiringBatches]
      ]
      return {
        name: stem,
        csv: toCsv(
          cols.map(([k]) => t(k)),
          o.farms.map((r) => cols.map(([, get]) => get(r)))
        )
      }
    }
    case 'production': {
      const s = await dailySeries(ctx, from, to)
      return {
        name: stem,
        csv: toCsv(
          [
            'common.date',
            'common.status',
            'ov.opening',
            'ov.closing',
            'ov.eggs',
            'ov.good',
            'ov.damaged',
            'ov.rejected',
            'ov.layingPct',
            'ov.deaths',
            'ov.culls',
            'ov.feedKg',
            'ov.feedPerBird',
            'ov.waterL'
          ].map(t),
          s.map((p) => [
            p.date,
            t('status.' + p.status),
            p.opening,
            p.closing,
            p.eggs,
            p.good,
            p.damaged,
            p.rejected,
            p.productionPct,
            p.deaths,
            p.removals,
            p.feedKg,
            p.feedPerHenG,
            p.waterLitres
          ])
        )
      }
    }
    case 'movements': {
      const rows: Cell[][] = []
      for (let page = 1; page <= 200; page++) {
        const p = await movementsPage(ctx, { from, to, warehouseId: f.warehouseId, page, pageSize: 500 })
        for (const r of p.rows)
          rows.push([r.date, r.store, r.counterpart, r.item, r.batchNo, t('txn.' + r.type), r.quantity, r.unit, r.reference, r.notes, r.by])
        if (p.page * p.pageSize >= p.total) break
      }
      return {
        name: stem,
        csv: toCsv(
          [
            'common.date',
            'stores.store',
            'ov.otherStore',
            'inv.item',
            'inv.batchNo',
            'ov.movement',
            'common.quantity',
            'common.unit',
            'ov.reference',
            'common.notes',
            'common.recordedBy'
          ].map(t),
          rows
        )
      }
    }
    case 'receipts': {
      const rows: Cell[][] = []
      for (const g of await listReceipts(ctx, from, to)) {
        for (const l of g.lines) {
          rows.push([
            g.grnNo,
            g.date,
            t('pur.status.' + g.status),
            g.supplierName,
            g.warehouseName,
            g.poNo,
            g.invoiceNo,
            l.itemName,
            l.batchNo,
            l.orderedQty,
            l.quantity,
            l.rejectedQty,
            l.damagedQty,
            l.quantity - l.rejectedQty - l.damagedQty,
            l.unit,
            l.unitCost
          ])
        }
      }
      return {
        name: stem,
        csv: toCsv(
          [
            'pur.grn',
            'common.date',
            'common.status',
            'pur.supplier',
            'stores.store',
            'po.no',
            'pur.invoice',
            'inv.item',
            'inv.batchNo',
            'ov.ordered',
            'pur.delivered',
            'pur.rejected',
            'pur.damaged',
            'ov.accepted',
            'common.unit',
            'inv.unitCost'
          ].map(t),
          rows
        )
      }
    }
    case 'tasks': {
      const rows = (await listTasks(ctx, { from, to })).map((x) => [
        x.dueDate,
        x.title,
        t('task.cat.' + x.category),
        t('task.prio.' + x.priority),
        x.assigneeName ?? x.assigneeRoleName,
        [x.farmName, x.houseName].filter(Boolean).join(' · ') || t('task.wholeOrg'),
        x.overdue ? t('task.overdue') : t('task.status.' + x.status),
        x.completedBy,
        x.completedAt,
        x.verifiedBy
      ])
      return {
        name: stem,
        csv: toCsv(
          [
            'task.due',
            'task.task',
            'task.category',
            'task.priority',
            'task.assignee',
            'task.where',
            'common.status',
            'ov.completedBy',
            'ov.completedAt',
            'ov.verifiedBy'
          ].map(t),
          rows
        )
      }
    }
  }
}
