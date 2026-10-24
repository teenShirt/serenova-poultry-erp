import type { ReactNode } from 'react'
import { useApp } from '../lib/app'

/** A small trend line drawn to scale; missing days are skipped, not drawn as zero. */
export function Sparkline({
  values,
  color = '#2a78d6',
  width = 110,
  height = 34
}: {
  values: (number | null)[]
  color?: string
  width?: number
  height?: number
}) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null && Number.isFinite(p.v))
  if (pts.length < 2) return <svg className="spark" width={width} height={height} aria-hidden="true" />
  const min = Math.min(...pts.map((p) => p.v))
  const max = Math.max(...pts.map((p) => p.v))
  const span = max - min || 1
  const x = (i: number) => 2 + (i / Math.max(1, values.length - 1)) * (width - 4)
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6)
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={`${d} L${x(last.i).toFixed(1)},${height} L${x(pts[0].i).toFixed(1)},${height} Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.i)} cy={y(last.v)} r={3} fill={color} />
    </svg>
  )
}

/** KPI tile: value, optional change against the previous value, and a trend line. */
export function Kpi({
  icon,
  label,
  value,
  sub,
  trend,
  color,
  change,
  goodWhenUp = true,
  tone
}: {
  icon?: ReactNode
  label: string
  value: ReactNode
  sub?: ReactNode
  trend?: (number | null)[]
  color?: string
  change?: number | null
  goodWhenUp?: boolean
  tone?: 'warn' | 'bad'
}) {
  const { num } = useApp()
  const dir = change === null || change === undefined || change === 0 ? null : change > 0 ? 'up' : 'down'
  const good = dir === null ? null : (dir === 'up') === goodWhenUp
  return (
    <div className={`card stat kpi ${tone ?? ''}`}>
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="kpi-row">
        <div className="stat-value">{value}</div>
        {trend && <Sparkline values={trend} color={color} />}
      </div>
      <div className="row" style={{ gap: 8 }}>
        {dir && (
          <span className={`delta ${good ? 'up' : 'down'}`}>
            {dir === 'up' ? '▲' : '▼'} {num(Math.abs(change!), 1)}%
          </span>
        )}
        {sub !== undefined && <span className="stat-sub">{sub}</span>}
      </div>
    </div>
  )
}
