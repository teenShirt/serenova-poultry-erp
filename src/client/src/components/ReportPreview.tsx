import { useEffect, useState } from 'react'
import { FileSpreadsheet, FileText, Printer, X } from 'lucide-react'
import type { ReportSpec } from '@shared/api'
import { call, download, excelReportUrl, printHtml } from '../lib/api'
import { useApp } from '../lib/app'

/**
 * Shows a report exactly as it will print on an A4 sheet, with Print and Save PDF (both through
 * the browser's print dialog, where "Save as PDF" is one of the printers) and Download Excel.
 */
export function ReportPreview({ spec, onClose }: { spec: ReportSpec; onClose: () => void }) {
  const { t, toast, fail, can, hasModule } = useApp()
  const [doc, setDoc] = useState<{ title: string; html: string } | null>(null)
  const [busy, setBusy] = useState<'print' | null>(null)

  useEffect(() => {
    let alive = true
    call('reports.preview', spec)
      .then((d) => alive && setDoc(d))
      .catch((e) => {
        fail(e)
        onClose()
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(spec)])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        void print()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const print = async (asPdf = false) => {
    if (busy) return
    setBusy('print')
    try {
      const r = await call('reports.print', spec)
      if (asPdf) toast('info', t('rep.pdfHint'))
      await printHtml(r.html, r.title)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overlay preview-overlay" role="dialog" aria-modal="true" aria-label={t('rep.preview')}>
      <div className="preview">
        <div className="preview-bar">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="preview-kicker">{t('rep.preview')}</div>
            <div className="preview-title">{doc?.title ?? t('rep.loadingPreview')}</div>
          </div>
          <button className="btn primary big" onClick={() => print()} disabled={!doc || busy !== null} title="Ctrl+P">
            <Printer size={20} />
            {t('rep.print')}
          </button>
          <button className="btn" onClick={() => print(true)} disabled={!doc || busy !== null}>
            <FileText size={18} /> PDF
          </button>
          {can('reports.export') && hasModule('exports') && (
            <button className="btn" onClick={() => download(excelReportUrl(spec))} disabled={!doc}>
              <FileSpreadsheet size={18} /> Excel
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X size={22} />
          </button>
        </div>
        <div className="preview-hint">{t('rep.printHint')}</div>
        <div className="preview-desk">
          {doc ? (
            <iframe className="preview-paper" title={doc.title} sandbox="" srcDoc={doc.html} />
          ) : (
            <div className="preview-paper preview-loading">{t('rep.loadingPreview')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
