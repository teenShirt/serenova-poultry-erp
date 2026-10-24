import { API_KIND, type ApiIn, type ApiMethod, type ApiOut, type ApiResponse, type UploadedBackup } from '@shared/api'
import type { ReportSpec } from '@shared/api'

export class ApiError extends Error {
  constructor(
    public code: string,
    public params: Record<string, string | number>
  ) {
    super(code)
  }
}

type Listener = () => void
const listeners = new Set<Listener>()

/** Called after any successful write so open screens (dashboard, charts) refresh from the database. */
export function onDataChanged(l: Listener) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The header the server requires on data-changing requests (protects against cross-site requests). */
const HEADERS = { 'X-Requested-With': 'pfm' }

async function readResponse<T>(res: Response): Promise<ApiResponse<T>> {
  try {
    return (await res.json()) as ApiResponse<T>
  } catch {
    return { ok: false, code: 'server_unreachable', params: { status: res.status } }
  }
}

/** Calls one named API method on the server. The server validates the input and checks the user's permissions. */
export async function call<M extends ApiMethod>(method: M, ...args: ApiIn<M> extends void ? [] : [ApiIn<M>]): Promise<ApiOut<M>> {
  let res: Response
  try {
    res = await fetch(`/api/call/${method}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: args[0] ?? undefined })
    })
  } catch {
    throw new ApiError('server_unreachable', { status: 0 })
  }
  const out = await readResponse<ApiOut<M>>(res)
  if (!out.ok) throw new ApiError(out.code, out.params)
  if (API_KIND[method] === 'write') {
    for (const l of listeners) l()
  }
  return out.data
}

/** Link that downloads a report as an Excel workbook. */
export function excelReportUrl(spec: ReportSpec) {
  return `/api/reports/download?spec=${encodeURIComponent(JSON.stringify(spec))}`
}

export function backupDownloadUrl(id: number) {
  return `/api/backup/download/${id}`
}

/** Starts a download in the browser without leaving the page. */
export function download(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Sends a backup file to the server, which checks it and returns a one-time token for restoring it. */
export async function uploadBackup(file: File): Promise<UploadedBackup> {
  let res: Response
  try {
    res = await fetch(`/api/backup/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...HEADERS, 'Content-Type': 'application/octet-stream' },
      body: file
    })
  } catch {
    throw new ApiError('server_unreachable', { status: 0 })
  }
  const out = await readResponse<UploadedBackup>(res)
  if (!out.ok) throw new ApiError(out.code, out.params)
  return out.data
}

/**
 * Prints a report page (A4 landscape) through the browser's print dialog, where it can also be
 * saved as a PDF. The page is loaded into a hidden frame so the app stays as it is.
 */
export function printHtml(html: string, title: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    frame.setAttribute('aria-hidden', 'true')
    frame.srcdoc = html.replace(/<title>[^<]*<\/title>|<\/head>/i, (m) => (m.toLowerCase() === '</head>' ? `<title>${escapeHtml(title)}</title></head>` : `<title>${escapeHtml(title)}</title>`))
    frame.onload = () => {
      const w = frame.contentWindow
      const done = () => {
        setTimeout(() => frame.remove(), 1000)
        resolve()
      }
      if (!w) return done()
      w.addEventListener('afterprint', done, { once: true })
      w.focus()
      w.print()
      // Some browsers do not fire afterprint; never leave the frame behind.
      setTimeout(done, 60_000)
    }
    document.body.appendChild(frame)
  })
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
