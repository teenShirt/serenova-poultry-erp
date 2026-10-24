import { useState } from 'react'
import { FileDown } from 'lucide-react'
import type { CsvKind } from '@shared/overview'
import { ApiError } from '../lib/api'
import { useApp } from '../lib/app'

export function csvUrl(kind: CsvKind, params: { from: string; to: string; warehouseId?: number | null }) {
  const q = new URLSearchParams({ from: params.from, to: params.to })
  if (params.warehouseId) q.set('warehouseId', String(params.warehouseId))
  return `/api/export/${kind}?${q.toString()}`
}

/**
 * Downloads a CSV file. The file is fetched first, so a refusal (no permission, a plan without
 * exports) shows as a message instead of a broken download.
 */
export function CsvButton({ kind, from, to, warehouseId }: { kind: CsvKind; from: string; to: string; warehouseId?: number | null }) {
  const { t, can, hasModule, fail } = useApp()
  const [busy, setBusy] = useState(false)
  if (!can('reports.export') || !hasModule('exports')) return null
  return (
    <button
      className="btn"
      disabled={busy}
      title={t('ov.csvHint')}
      onClick={async () => {
        setBusy(true)
        try {
          const r = await fetch(csvUrl(kind, { from, to, warehouseId }), { credentials: 'same-origin' })
          if (!r.ok) {
            const body = (await r.json().catch(() => null)) as { code?: string; params?: Record<string, string | number> } | null
            throw new ApiError(body?.code ?? 'unknown', body?.params ?? {})
          }
          const name = /filename="?([^";]+)"?/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? `${kind}.csv`
          const url = URL.createObjectURL(await r.blob())
          const a = document.createElement('a')
          a.href = url
          a.download = name
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 10_000)
        } catch (e) {
          fail(e)
        } finally {
          setBusy(false)
        }
      }}
    >
      <FileDown size={17} /> CSV
    </button>
  )
}
