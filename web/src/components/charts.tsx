/**
 * 看板用的轻量 SVG 图表（不引图表库）。规则：细线条、4px 圆角数据端、发丝网格线、
 * 文字一律用文字色（不用数据色）、悬停提示；好评 / 差评配色经过色盲校验（#3B4FA0 / #B85A40）。
 */
import React, { useLayoutEffect, useRef, useState } from 'react'

export const C_GOOD = '#3B4FA0'
export const C_BAD = '#B85A40'
const C_GRID = '#EFEAE4'
const C_AXIS = '#9A969C'
const C_TEXT2 = '#57545B'

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref as React.RefObject<HTMLDivElement>, w]
}

/** 刻度：取整到 1 / 2 / 5 × 10^n */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw
  const out: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1000) / 1000)
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step)
  return out
}

const fmt = (n: number): string => (Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(0)}K` : n.toLocaleString('zh-CN'))

interface TipState { x: number; y: number; title: string; rows: Array<{ color?: string; label: string; value: string }> }

const Tooltip: React.FC<{ tip: TipState | null; width: number }> = ({ tip, width }) => {
  if (!tip) return null
  const left = Math.min(Math.max(tip.x + 12, 0), Math.max(0, width - 180))
  return (
    <div className="chart-tip" style={{ left, top: Math.max(0, tip.y - 10) }}>
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="chart-tip-row">
          {r.color && <i style={{ background: r.color }} />}
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  )
}

export const Legend: React.FC<{ items: Array<{ color: string; label: string; line?: boolean }> }> = ({ items }) => (
  <div className="chart-legend">
    {items.map((i) => (
      <span key={i.label}><i className={i.line ? 'line' : ''} style={{ background: i.color }} />{i.label}</span>
    ))}
  </div>
)

// ─── 折线（单序列，面积淡色）+ 十字线 ─────────────────────────────

export const LineChart: React.FC<{
  data: Array<{ label: string; value: number }>
  color?: string
  height?: number
  valueName: string
  formatX?: (label: string) => string
}> = ({ data, color = C_GOOD, height = 220, valueName, formatX = (s) => s }) => {
  const [ref, w] = useWidth()
  const [tip, setTip] = useState<TipState | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 44, r: 16, t: 12, b: 28 }
  const iw = Math.max(0, w - pad.l - pad.r)
  const ih = height - pad.t - pad.b
  const ticks = niceTicks(Math.max(1, ...data.map((d) => d.value)))
  const top = ticks[ticks.length - 1]
  const x = (i: number): number => pad.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw)
  const y = (v: number): number => pad.t + ih - (v / top) * ih
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.value)}`).join(' ')
  const area = data.length ? `${path} L${x(data.length - 1)},${y(0)} L${x(0)},${y(0)} Z` : ''
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(iw / 64))))

  const onMove = (e: React.PointerEvent<SVGRectElement>): void => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    const i = data.length <= 1 ? 0 : Math.round(((px - pad.l) / iw) * (data.length - 1))
    const idx = Math.max(0, Math.min(data.length - 1, i))
    setHover(idx)
    setTip({ x: x(idx), y: y(data[idx].value), title: formatX(data[idx].label), rows: [{ color, label: valueName, value: fmt(data[idx].value) }] })
  }

  return (
    <div ref={ref} className="chart-box" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={`${valueName}趋势`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke={C_GRID} strokeWidth={1} />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={C_AXIS}>{fmt(t)}</text>
            </g>
          ))}
          {data.map((d, i) => i % every === 0 && (
            <text key={d.label} x={x(i)} y={height - 8} textAnchor="middle" fontSize={11} fill={C_AXIS}>{formatX(d.label)}</text>
          ))}
          <path d={area} fill={color} opacity={0.1} />
          <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== null && data[hover] && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke={C_AXIS} strokeWidth={1} />
              <circle cx={x(hover)} cy={y(data[hover].value)} r={4} fill={color} stroke="#fff" strokeWidth={2} />
            </>
          )}
          <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent"
            onPointerMove={onMove} onPointerLeave={() => { setTip(null); setHover(null) }} />
        </svg>
      )}
      <Tooltip tip={tip} width={w} />
    </div>
  )
}

// ─── 每日好评 / 差评：上下分开的柱（好评向上、差评向下） ─────────────

export const DivergingColumns: React.FC<{
  data: Array<{ label: string; up: number; down: number }>
  upName: string
  downName: string
  height?: number
  formatX?: (label: string) => string
}> = ({ data, upName, downName, height = 220, formatX = (s) => s }) => {
  const [ref, w] = useWidth()
  const [tip, setTip] = useState<TipState | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 44, r: 16, t: 12, b: 28 }
  const iw = Math.max(0, w - pad.l - pad.r)
  const ih = height - pad.t - pad.b
  const maxUp = Math.max(1, ...data.map((d) => d.up))
  const maxDown = Math.max(1, ...data.map((d) => d.down))
  const ticksUp = niceTicks(maxUp, 3)
  const ticksDown = niceTicks(maxDown, 2)
  const topUp = ticksUp[ticksUp.length - 1]
  const topDown = ticksDown[ticksDown.length - 1]
  // 上下两段按各自最大值占比分高度，刻度单位一致（同一根轴，0 在中间）
  const unit = ih / (topUp + topDown)
  const zero = pad.t + topUp * unit
  const band = data.length ? iw / data.length : iw
  const bw = Math.max(2, Math.min(24, band - 4))
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(iw / 64))))
  const r = Math.min(4, bw / 2)

  /** 圆角只在数据端，基线端是直角 */
  const colPath = (cx: number, v: number, up: boolean): string => {
    if (v <= 0) return ''
    const h = v * unit
    const x0 = cx - bw / 2
    const x1 = cx + bw / 2
    const rr = Math.min(r, h)
    if (up) {
      const yTop = zero - h
      return `M${x0},${zero} L${x0},${yTop + rr} Q${x0},${yTop} ${x0 + rr},${yTop} L${x1 - rr},${yTop} Q${x1},${yTop} ${x1},${yTop + rr} L${x1},${zero} Z`
    }
    const yBot = zero + h
    return `M${x0},${zero} L${x0},${yBot - rr} Q${x0},${yBot} ${x0 + rr},${yBot} L${x1 - rr},${yBot} Q${x1},${yBot} ${x1},${yBot - rr} L${x1},${zero} Z`
  }

  return (
    <div ref={ref} className="chart-box" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={`${upName}与${downName}`}>
          {ticksUp.map((t) => (
            <g key={`u${t}`}>
              <line x1={pad.l} x2={w - pad.r} y1={zero - t * unit} y2={zero - t * unit} stroke={C_GRID} />
              <text x={pad.l - 8} y={zero - t * unit} dy="0.32em" textAnchor="end" fontSize={11} fill={C_AXIS}>{t}</text>
            </g>
          ))}
          {/* 差评一侧通常很矮：只标最大那一档，而且离 0 线够远（≥ 12px）才标，免得刻度字叠在一起 */}
          {ticksDown.slice(-1).filter((t) => t > 0 && t * unit >= 12).map((t) => (
            <g key={`d${t}`}>
              <line x1={pad.l} x2={w - pad.r} y1={zero + t * unit} y2={zero + t * unit} stroke={C_GRID} />
              <text x={pad.l - 8} y={zero + t * unit} dy="0.32em" textAnchor="end" fontSize={11} fill={C_AXIS}>{t}</text>
            </g>
          ))}
          <line x1={pad.l} x2={w - pad.r} y1={zero} y2={zero} stroke={C_AXIS} strokeWidth={1} />
          {data.map((d, i) => {
            const cx = pad.l + band * i + band / 2
            const dim = hover !== null && hover !== i
            return (
              <g key={d.label} opacity={dim ? 0.55 : 1}>
                <path d={colPath(cx, d.up, true)} fill={C_GOOD} />
                <path d={colPath(cx, d.down, false)} fill={C_BAD} />
                {i % every === 0 && <text x={cx} y={height - 8} textAnchor="middle" fontSize={11} fill={C_AXIS}>{formatX(d.label)}</text>}
                <rect
                  x={pad.l + band * i} y={pad.t} width={band} height={ih} fill="transparent"
                  onPointerEnter={() => {
                    setHover(i)
                    setTip({ x: cx, y: zero - d.up * unit, title: formatX(d.label), rows: [
                      { color: C_GOOD, label: upName, value: String(d.up) },
                      { color: C_BAD, label: downName, value: String(d.down) }
                    ] })
                  }}
                  onPointerLeave={() => { setHover(null); setTip(null) }}
                />
              </g>
            )
          })}
        </svg>
      )}
      <Tooltip tip={tip} width={w} />
    </div>
  )
}

// ─── 按客服：左差评、右好评的横向对比条 ───────────────────────────

export const DivergingBars: React.FC<{
  rows: Array<{ key: string | number; label: string; left: number; right: number; muted?: boolean }>
  leftName: string
  rightName: string
}> = ({ rows, leftName, rightName }) => {
  const [ref, w] = useWidth()
  const [tip, setTip] = useState<TipState | null>(null)
  const rowH = 30
  const labelW = 96
  const valueW = 34
  const height = rows.length * rowH + 8
  const maxL = Math.max(1, ...rows.map((r) => r.left))
  const maxR = Math.max(1, ...rows.map((r) => r.right))
  const plot = Math.max(0, w - labelW - valueW * 2)
  // 两侧按各自最大值分宽度，同一单位
  const unit = plot / (maxL + maxR)
  const zero = labelW + valueW + maxL * unit
  const bh = 16

  const bar = (x0: number, len: number, y0: number, toLeft: boolean): string => {
    if (len <= 0) return ''
    const rr = Math.min(4, len)
    if (toLeft) {
      const xe = x0 - len
      return `M${x0},${y0} L${xe + rr},${y0} Q${xe},${y0} ${xe},${y0 + rr} L${xe},${y0 + bh - rr} Q${xe},${y0 + bh} ${xe + rr},${y0 + bh} L${x0},${y0 + bh} Z`
    }
    const xe = x0 + len
    return `M${x0},${y0} L${xe - rr},${y0} Q${xe},${y0} ${xe},${y0 + rr} L${xe},${y0 + bh - rr} Q${xe},${y0 + bh} ${xe - rr},${y0 + bh} L${x0},${y0 + bh} Z`
  }

  return (
    <div ref={ref} className="chart-box" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={`按客服的${leftName}与${rightName}`}>
          <line x1={zero} x2={zero} y1={0} y2={height} stroke={C_AXIS} strokeWidth={1} />
          {rows.map((r, i) => {
            const y0 = i * rowH + (rowH - bh) / 2 + 4
            const lw = r.left * unit
            const rw = r.right * unit
            return (
              <g key={r.key} opacity={r.muted ? 0.5 : 1}>
                <text x={labelW - 8} y={y0 + bh / 2} dy="0.32em" textAnchor="end" fontSize={12} fill={C_TEXT2}>{r.label}</text>
                <path d={bar(zero - 1, lw, y0, true)} fill={C_BAD} />
                <path d={bar(zero + 1, rw, y0, false)} fill={C_GOOD} />
                {r.left > 0 && <text x={zero - lw - 6} y={y0 + bh / 2} dy="0.32em" textAnchor="end" fontSize={11} fill={C_TEXT2}>{r.left}</text>}
                <text x={zero + rw + 6} y={y0 + bh / 2} dy="0.32em" fontSize={11} fill={C_TEXT2}>{r.right}</text>
                <rect x={0} y={i * rowH + 4} width={w} height={rowH} fill="transparent"
                  onPointerEnter={() => setTip({ x: zero, y: y0, title: r.label, rows: [
                    { color: C_GOOD, label: rightName, value: String(r.right) },
                    { color: C_BAD, label: leftName, value: String(r.left) }
                  ] })}
                  onPointerLeave={() => setTip(null)} />
              </g>
            )
          })}
        </svg>
      )}
      <Tooltip tip={tip} width={w} />
    </div>
  )
}

// ─── 单色横向条（有序类别，如 AI 评级） ───────────────────────────

export const HBars: React.FC<{ rows: Array<{ label: string; value: number }>; color?: string; valueName: string }> = ({ rows, color = C_GOOD, valueName }) => {
  const [ref, w] = useWidth()
  const rowH = 30
  const labelW = 64
  const height = rows.length * rowH + 4
  const max = Math.max(1, ...rows.map((r) => r.value))
  const plot = Math.max(0, w - labelW - 84)
  const total = rows.reduce((s, r) => s + r.value, 0)
  return (
    <div ref={ref} className="chart-box" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={valueName}>
          <line x1={labelW} x2={labelW} y1={0} y2={height} stroke={C_AXIS} />
          {rows.map((r, i) => {
            const y0 = i * rowH + 7
            const len = (r.value / max) * plot
            const rr = Math.min(4, len)
            const d = len > 0
              ? `M${labelW},${y0} L${labelW + len - rr},${y0} Q${labelW + len},${y0} ${labelW + len},${y0 + rr} L${labelW + len},${y0 + 16 - rr} Q${labelW + len},${y0 + 16} ${labelW + len - rr},${y0 + 16} L${labelW},${y0 + 16} Z`
              : ''
            return (
              <g key={r.label}>
                <title>{`${r.label}：${r.value}（${total ? Math.round((r.value / total) * 100) : 0}%）`}</title>
                <text x={labelW - 8} y={y0 + 8} dy="0.32em" textAnchor="end" fontSize={12} fill={C_TEXT2}>{r.label}</text>
                <path d={d} fill={color} />
                <text x={labelW + len + 6} y={y0 + 8} dy="0.32em" fontSize={11} fill={C_TEXT2}>
                  {r.value}{total ? `（${Math.round((r.value / total) * 100)}%）` : ''}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}
