import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { dayReport, periodReport } from '../src/server/reports/model'
import { renderHtml, renderXlsx } from '../src/server/reports/render'
import { closeDay, confirmIssue, confirmMortality, getOverview, isBlocking, startDay } from '../src/server/services/days'
import { saveEggs } from '../src/server/services/eggs'
import { makeFarm } from './helpers'

async function farmWithClosedDay() {
  const f = await makeFarm()
  f.setNow(new Date('2026-03-10T10:00:00Z'))
  await startDay(f.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
  for (const c of f.cageIds)
    await saveEggs(f.worker, { date: '2026-03-09', cageId: c, session: 'morning', collectedAt: '08:00', good: 600, damaged: 5, rejected: 1, notes: null }, null)
  await confirmMortality(f.worker, '2026-03-09', f.cageIds)
  for (const i of (await getOverview(f.admin, '2026-03-09')).issues.filter(isBlocking))
    await confirmIssue(f.admin, '2026-03-09', i.cageId, i.key, 'Evening collection not recorded')
  await closeDay(f.admin, '2026-03-09', 'Reviewed')
  return f
}

describe('reports', () => {
  it('end-of-day report contains reconciled figures and the approved incomplete items', async () => {
    const f = await farmWithClosedDay()
    const m = await dayReport(f.admin, '2026-03-09', 'day_close', 'en', false)
    const html = renderHtml(m, 'en')
    expect(m.title).toBe('End-of-Day Report')
    expect(html).toContain('Test Farm')
    expect(html).toContain('10,000') // opening hens
    expect(html).toContain('6,060') // eggs: 10 × 606
    expect(html).toContain('Evening collection not recorded') // approved incomplete reason
    expect(html).toContain('Egg collection missing: Evening')
    expect(html).not.toContain('This day is not closed')
  })

  it('start-of-day report lists opening balances and pending tasks in Sinhala', async () => {
    const f = await makeFarm()
    await startDay(f.worker, { date: '2026-03-09', corrections: [], acknowledgeWarnings: false })
    const m = await dayReport(f.admin, '2026-03-09', 'day_open', 'si', false)
    const html = renderHtml(m, 'si')
    expect(m.title).toBe('දින ආරම්භක වාර්තාව')
    expect(html).toContain('ආරම්භක කිකිළි ශේෂ')
    expect(html).toContain('Layer Mash')
    expect(html).toContain('මරණ තවම තහවුරු කර නැත') // pending: mortality not confirmed
  })

  it('demo reports are clearly marked', async () => {
    const f = await makeFarm()
    const html = renderHtml(await periodReport(f.admin, '2026-03-01', '2026-03-09', 'en', true), 'en')
    expect(html).toContain('DEMONSTRATION DATA')
  })

  it('period report exports to a valid Excel workbook', async () => {
    const f = await farmWithClosedDay()
    const buf = await renderXlsx(await periodReport(f.admin, '2026-03-03', '2026-03-09', 'si', false), 'si')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    const ws = wb.worksheets[0]
    const text = ws.getSheetValues().flat().map(String).join(' ')
    expect(text).toContain('ගොවිපළ සාරාංශ වාර්තාව')
    expect(text).toContain('2026-03-09')
    expect(text).toContain('6060')
  })
})

describe('print and preview requests', () => {
  it('accept a day or a period and reject anything else', async () => {
    const { schemas } = await import('../src/server/schemas')
    const s = schemas['reports.print']
    expect(s.safeParse({ kind: 'day_close', date: '2026-03-09' }).success).toBe(true)
    expect(s.safeParse({ kind: 'period', from: '2026-03-01', to: '2026-03-09' }).success).toBe(true)
    expect(s.safeParse({ kind: 'period', date: '2026-03-09' }).success).toBe(false)
    expect(s.safeParse({ kind: 'day_open', date: '2026-02-30' }).success).toBe(false)
    expect(s.safeParse({ kind: 'invoice', date: '2026-03-09' }).success).toBe(false)
  })

  it('printed reports carry page numbers and the farm name in the page footer', async () => {
    const f = await farmWithClosedDay()
    const html = renderHtml(await dayReport(f.admin, '2026-03-09', 'day_close', 'si', false), 'si')
    expect(html).toContain('counter(page)')
    expect(html).toContain('පිටුව')
    expect(html).toContain('@bottom-left { content: "Test Farm')
  })
})
