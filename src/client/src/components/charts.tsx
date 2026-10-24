import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useApp } from '../lib/app'
import { Card, Empty } from './ui'

/** Categorical slots in fixed order (validated reference palette). Colour follows the series, never its rank. */
export const SERIES = {
  blue: '#2a78d6',
  orange: '#eb6834',
  aqua: '#1baf7a',
  yellow: '#eda100',
  red: '#e34948'
}
const GRID = '#e1e0d9'
const AXIS = '#898781'

export interface SeriesDef {
  key: string
  label: string
  color: string
}

function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span key={s.key}>
          <i style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}

function Tip({ active, payload, label, series, unit, digits, labelFormat }: { active?: boolean; payload?: { dataKey: string; value: number | null }[]; label?: string; series: SeriesDef[]; unit?: string; digits: number; labelFormat: (l: string) => string }) {
  const { num, t } = useApp()
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tip">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{labelFormat(String(label))}</div>
      {series.map((s) => {
        const p = payload.find((x) => x.dataKey === s.key)
        return (
          <div key={s.key} className="tip-row">
            <i style={{ background: s.color }} />
            <span>{s.label}:</span>
            <strong>{p?.value === null || p?.value === undefined ? t('common.unknown') : `${num(p.value, digits)}${unit ? ' ' + unit : ''}`}</strong>
          </div>
        )
      })}
    </div>
  )
}

/** Daily time series. Missing days are null and drawn as gaps, never as zero. */
export function TimeChart({
  title,
  data,
  series,
  kind = 'line',
  unit,
  digits = 0,
  height = 260,
  note,
  yDomain
}: {
  title: string
  data: readonly object[]
  series: SeriesDef[]
  kind?: 'line' | 'bar' | 'stacked'
  unit?: string
  digits?: number
  height?: number
  note?: ReactNode
  yDomain?: [number | 'auto', number | 'auto']
}) {
  const { date, num, t } = useApp()
  const rows = data as Record<string, unknown>[]
  const hasData = rows.some((d) => series.some((s) => d[s.key] !== null && d[s.key] !== undefined && d[s.key] !== 0))
  const short = (d: string) => date(d, { month: 'short', day: 'numeric' })
  const long = (d: string) => date(d, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
  const axisProps = { stroke: AXIS, tickLine: false, axisLine: { stroke: '#c3c2b7' }, fontSize: 12 }
  return (
    <Card title={<h3>{title}</h3>} actions={<Legend series={series} />} className="chart-card">
      {!hasData ? (
        <Empty text={t('common.noData')} />
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {kind === 'line' ? (
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={short} {...axisProps} minTickGap={24} />
              <YAxis {...axisProps} allowDecimals={digits > 0} width={52} tickFormatter={(v) => num(v, digits > 1 ? 1 : 0)} domain={yDomain ?? ['auto', 'auto']} />
              <Tooltip content={<Tip series={series} unit={unit} digits={digits} labelFormat={long} />} cursor={{ stroke: AXIS, strokeDasharray: '3 3' }} />
              {series.map((s) => (
                <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={data.length <= 31 ? { r: 3, strokeWidth: 0, fill: s.color } : false} activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} />
              ))}
            </LineChart>
          ) : (
            <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap={data.length > 40 ? 1 : '20%'}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={short} {...axisProps} minTickGap={24} />
              <YAxis {...axisProps} allowDecimals={digits > 0} width={52} tickFormatter={(v) => num(v, 0)} />
              <Tooltip content={<Tip series={series} unit={unit} digits={digits} labelFormat={long} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  fill={s.color}
                  stackId={kind === 'stacked' ? 'a' : undefined}
                  radius={kind === 'stacked' ? (i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]) : [4, 4, 0, 0]}
                  stroke="#fff"
                  strokeWidth={kind === 'stacked' ? 1 : 0}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      )}
      {note && <div className="muted small">{note}</div>}
    </Card>
  )
}

/** Comparison between cages: one bar per cage, one hue (identity is the label, not the colour). */
export function CageBars({ title, data: input, valueKey, label, unit, digits = 0, color = SERIES.blue, height = 260 }: { title: string; data: readonly object[]; valueKey: string; label: string; unit?: string; digits?: number; color?: string; height?: number }) {
  const { num, t } = useApp()
  const series = [{ key: valueKey, label, color }]
  const data = input as Record<string, unknown>[]
  const hasData = data.some((d) => typeof d[valueKey] === 'number' && (d[valueKey] as number) !== 0)
  const axisProps = { stroke: AXIS, tickLine: false, axisLine: { stroke: '#c3c2b7' }, fontSize: 12 }
  return (
    <Card title={<h3>{title}</h3>} className="chart-card">
      {!hasData ? (
        <Empty text={t('common.noData')} />
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="name" {...axisProps} interval={0} tick={{ fontSize: 11 }} />
            <YAxis {...axisProps} width={52} tickFormatter={(v) => num(v, 0)} />
            <Tooltip content={<Tip series={series} unit={unit} digits={digits} labelFormat={(l) => l} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Bar dataKey={valueKey} fill={color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  )
}

export function RangePicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  const { t } = useApp()
  return (
    <div className="seg">
      {[7, 30, 90].map((d) => (
        <button key={d} className={days === d ? 'on' : ''} onClick={() => onChange(d)}>
          {t('common.last' + d)}
        </button>
      ))}
    </div>
  )
}
