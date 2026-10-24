import ExcelJS from 'exceljs'
import { translate } from '@shared/i18n'
import type { Language } from '@shared/types'
import type { Cell, ReportModel } from './model'

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Text safe inside a CSS string ("…") such as an @page margin box. */
const cssString = (v: string) => v.replace(/[\\"<>]/g, ' ').replace(/[\r\n]+/g, ' ')

const cell = (v: Cell) => (v === null || v === '' ? '—' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v)

/** Printable A4 landscape HTML. Sinhala text is shaped by Chromium using the Windows Nirmala UI font. */
export function renderHtml(r: ReportModel, lang: Language): string {
  const body = r.sections
    .map((s) => {
      switch (s.kind) {
        case 'kv':
          return `<section><h2>${esc(s.heading)}</h2><table class="kv">${s.pairs
            .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
            .join('')}</table></section>`
        case 'table': {
          const align = (i: number) => (s.numeric?.[i] ? ' class="num"' : '')
          const row = (cells: Cell[], tag = 'td') => `<tr>${cells.map((c, i) => `<${tag}${align(i)}>${esc(cell(c))}</${tag}>`).join('')}</tr>`
          return `<section><h2>${esc(s.heading)}</h2><table class="grid"><thead><tr>${s.columns
            .map((c, i) => `<th${align(i)}>${esc(c)}</th>`)
            .join('')}</tr></thead><tbody>${s.rows.map((x) => row(x)).join('')}</tbody>${
            s.totals ? `<tfoot>${row(s.totals, 'th')}</tfoot>` : ''
          }</table></section>`
        }
        case 'list':
          return `<section><h2>${esc(s.heading)}</h2><ul class="${s.tone ?? ''}">${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></section>`
        case 'note':
          return `<p class="note ${s.tone}">${esc(s.text)}</p>`
        case 'signature':
          return `<section class="sig"><h2>${esc(s.heading)}</h2>${s.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</section>`
      }
    })
    .join('\n')
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(r.title)}</title>
<style>
  @page {
    size: A4 landscape;
    margin: 12mm 10mm 14mm;
    @bottom-left { content: "${cssString(r.farmName)} · ${cssString(r.title)}"; font-size: 8px; color: #5b6b62; }
    @bottom-right { content: "${cssString(translate(lang, 'report.page'))} " counter(page) " / " counter(pages); font-size: 8px; color: #5b6b62; }
  }
  @media screen { body { padding: 12mm 10mm; } }
  tr { break-inside: avoid; }
  h2 { break-after: avoid; }
  * { box-sizing: border-box; }
  body { font-family: "Nirmala UI", "Iskoola Pota", "Segoe UI", Arial, sans-serif; color: #1f2a24; font-size: 10.5px; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #2f7d4f; padding-bottom: 8px; margin-bottom: 10px; }
  header h1 { font-size: 20px; margin: 0; color: #1f5c39; }
  header .farm { font-size: 14px; font-weight: 600; }
  header .meta { text-align: right; color: #5b6b62; }
  .demo { background: #b42318; color: #fff; padding: 4px 8px; font-weight: 700; text-align: center; margin-bottom: 8px; }
  h2 { font-size: 12.5px; margin: 12px 0 5px; color: #1f5c39; border-left: 4px solid #2f7d4f; padding-left: 6px; }
  section { break-inside: avoid-page; }
  table { border-collapse: collapse; width: 100%; }
  table.kv { width: auto; min-width: 50%; }
  table.kv th { text-align: left; font-weight: 600; padding: 3px 14px 3px 0; color: #44544b; }
  table.kv td { padding: 3px 0; }
  table.grid th, table.grid td { border: 1px solid #cfd8d3; padding: 3px 5px; }
  table.grid thead th { background: #e8f2ec; font-weight: 600; text-align: left; }
  table.grid tfoot th { background: #f3f6f4; text-align: left; }
  table.grid .num { text-align: right; font-variant-numeric: tabular-nums; }
  table.grid tbody tr:nth-child(even) td { background: #fafcfb; }
  thead { display: table-header-group; }
  ul { margin: 2px 0 0 18px; padding: 0; }
  ul.warn li::marker { color: #b54708; }
  .note { padding: 6px 8px; border-radius: 4px; margin: 8px 0; }
  .note.warn { background: #fff4e5; border: 1px solid #f5c26b; }
  .note.info { background: #eef4f8; border: 1px solid #c4d6e4; }
  .sig p { margin: 6px 0; }
  footer { margin-top: 14px; color: #5b6b62; font-size: 9px; }
</style></head><body>
${r.isDemo ? `<div class="demo">${esc(translate(lang, 'report.demo'))}</div>` : ''}
<header><div><h1>${esc(r.title)}</h1><div class="farm">${esc(r.farmName)}</div></div>
<div class="meta"><div>${esc(r.subtitle)}</div><div>${esc(r.generated)}</div></div></header>
${body}
<footer>${esc(translate(lang, 'app.name'))}</footer>
</body></html>`
}

export async function renderXlsx(r: ReportModel, lang: Language): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = translate(lang, 'app.name')
  wb.created = new Date()
  const ws = wb.addWorksheet(r.title.slice(0, 31), { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } })
  const font = { name: 'Nirmala UI' }
  let row = 1
  const put = (values: Cell[], style: Partial<ExcelJS.Style> = {}) => {
    const r = ws.getRow(row++)
    values.forEach((v, i) => {
      const c = r.getCell(i + 1)
      c.value = v === null ? '' : v
      c.font = { ...font, ...(style.font ?? {}) }
      if (style.fill) c.fill = style.fill
      if (style.border) c.border = style.border
    })
    return r
  }
  if (r.isDemo) put([translate(lang, 'report.demo')], { font: { bold: true, color: { argb: 'FFB42318' } } })
  put([r.title], { font: { bold: true, size: 16, color: { argb: 'FF1F5C39' } } })
  put([r.farmName], { font: { bold: true, size: 12 } })
  put([r.subtitle])
  put([r.generated], { font: { italic: true, color: { argb: 'FF5B6B62' } } })
  row++
  const thin: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFCFD8D3' } },
    bottom: { style: 'thin', color: { argb: 'FFCFD8D3' } },
    left: { style: 'thin', color: { argb: 'FFCFD8D3' } },
    right: { style: 'thin', color: { argb: 'FFCFD8D3' } }
  }
  let maxCols = 2
  for (const s of r.sections) {
    if (s.kind === 'note') {
      put([s.text], { font: { italic: true, color: { argb: s.tone === 'warn' ? 'FFB54708' : 'FF44544B' } } })
      row++
      continue
    }
    put([s.heading], { font: { bold: true, size: 12, color: { argb: 'FF1F5C39' } } })
    if (s.kind === 'kv') for (const [k, v] of s.pairs) put([k, v], {})
    if (s.kind === 'list') for (const i of s.items) put(['•', i])
    if (s.kind === 'signature') for (const l of s.lines) put([l])
    if (s.kind === 'table') {
      maxCols = Math.max(maxCols, s.columns.length)
      put(s.columns, { font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F2EC' } }, border: thin })
      for (const x of s.rows) put(x, { border: thin })
      if (s.totals) put(s.totals, { font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F4' } }, border: thin })
    }
    row++
  }
  for (let i = 1; i <= maxCols; i++) ws.getColumn(i).width = i === 1 ? 26 : 13
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}
