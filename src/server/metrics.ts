import type { NextFunction, Request, Response } from 'express'

/**
 * Prometheus metrics without extra dependencies. Served on its own port (METRICS_PORT) so the
 * public site never exposes them; Kubernetes scrapes that port from inside the cluster.
 */
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

interface Hist {
  counts: number[]
  sum: number
  count: number
}

const requests = new Map<string, number>()
const durations = new Map<string, Hist>()

function esc(v: string) {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function labels(obj: Record<string, string>) {
  return (
    '{' +
    Object.entries(obj)
      .map(([k, v]) => `${k}="${esc(v)}"`)
      .join(',') +
    '}'
  )
}

/** Route label from Express's matched pattern, so ids in URLs never create new series. */
function routeOf(req: Request): string {
  const r = (req.route as { path?: string } | undefined)?.path
  if (typeof r === 'string') return req.baseUrl + r
  return req.path.startsWith('/assets/') ? '/assets' : 'other'
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const route = routeOf(req)
    const seconds = Number(process.hrtime.bigint() - start) / 1e9
    const reqKey = labels({ method: req.method, route, status: String(res.statusCode) })
    requests.set(reqKey, (requests.get(reqKey) ?? 0) + 1)
    const durKey = labels({ method: req.method, route })
    let h = durations.get(durKey)
    if (!h) durations.set(durKey, (h = { counts: BUCKETS.map(() => 0), sum: 0, count: 0 }))
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.counts[i]++
    })
    h.sum += seconds
    h.count++
  })
  next()
}

export interface Snapshot {
  version: string
  release: string | null
  environment: string
  /** 1 when the database answers and is at this release's schema */
  ready: number
}

export function renderMetrics(s: Snapshot): string {
  const out: string[] = []
  const mem = process.memoryUsage()
  out.push('# HELP pfm_app_info Running release.', '# TYPE pfm_app_info gauge')
  out.push(`pfm_app_info${labels({ version: s.version, release: s.release ?? '', environment: s.environment })} 1`)
  out.push('# HELP pfm_ready Database reachable and at the expected schema.', '# TYPE pfm_ready gauge', `pfm_ready ${s.ready}`)
  out.push(
    '# HELP process_uptime_seconds Seconds since the process started.',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${process.uptime().toFixed(0)}`
  )
  out.push('# HELP process_resident_memory_bytes Resident memory.', '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`)
  out.push('# HELP nodejs_heap_used_bytes V8 heap in use.', '# TYPE nodejs_heap_used_bytes gauge', `nodejs_heap_used_bytes ${mem.heapUsed}`)
  out.push('# HELP pfm_http_requests_total HTTP requests by route and status.', '# TYPE pfm_http_requests_total counter')
  for (const [k, v] of requests) out.push(`pfm_http_requests_total${k} ${v}`)
  out.push('# HELP pfm_http_request_duration_seconds HTTP request latency.', '# TYPE pfm_http_request_duration_seconds histogram')
  for (const [k, h] of durations) {
    const base = k.slice(0, -1)
    BUCKETS.forEach((b, i) => out.push(`pfm_http_request_duration_seconds_bucket${base},le="${b}"} ${h.counts[i]}`))
    out.push(`pfm_http_request_duration_seconds_bucket${base},le="+Inf"} ${h.count}`)
    out.push(`pfm_http_request_duration_seconds_sum${k} ${h.sum}`)
    out.push(`pfm_http_request_duration_seconds_count${k} ${h.count}`)
  }
  return out.join('\n') + '\n'
}

/** Test helper: forget recorded requests. */
export function resetMetrics() {
  requests.clear()
  durations.clear()
}
