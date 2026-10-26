import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Histogram } from '../engine/renderer'
import { useStore } from '../state/store'
import { rgbToHex, hexToRgb, cssRgb, type RGB } from '../engine/color'
import { sampleCurve, clamp } from '../engine/lut'
import type { CurvePoints, GradientStop } from '../state/types'

export const HistogramContext = createContext<Histogram | null>(null)
export const useHistogram = () => useContext(HistogramContext)

// ---------------------------------------------------------------------------

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section">
      <div className="section-head">
        <span>{title}</span>
        {right}
      </div>
      <div className="section-body">{children}</div>
    </div>
  )
}

export function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  /** value that counts as "no change"; shown as a tick and restored on reset */
  neutral?: number
  onChange: (v: number) => void
  accent?: string
  /** label, track and value on one line — for secondary controls */
  compact?: boolean
}) {
  const { label, value, min, max, step = 1, suffix = '', neutral = 0, onChange, accent, compact } = props
  const pushHistory = useStore((s) => s.pushHistory)
  const [text, setText] = useState<string | null>(null)

  const pct = ((value - min) / (max - min)) * 100
  const neutralPct = ((clamp(neutral, min, max) - min) / (max - min)) * 100

  const numberField = (
    <input
      className="num"
      value={text ?? String(Math.round(value * 100) / 100)}
      onChange={(e) => {
        setText(e.target.value)
        const n = parseFloat(e.target.value)
        if (Number.isFinite(n)) onChange(clamp(n, min, max))
      }}
      onFocus={pushHistory}
      onBlur={() => setText(null)}
    />
  )

  return (
    <div className={`slider ${compact ? 'compact' : ''}`}>
      {compact ? <label>{label}</label> : (
        <div className="slider-top">
          <label>{label}</label>
          {numberField}
          {suffix && <span className="suffix">{suffix}</span>}
        </div>
      )}
      <div className="slider-track-wrap">
        <div className="slider-neutral" style={{ left: `${neutralPct}%` }} />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onPointerDown={pushHistory}
          onKeyDown={(e) => { if (e.key.startsWith('Arrow')) pushHistory() }}
          onDoubleClick={() => { pushHistory(); onChange(neutral) }}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{
            // Colour-meaning tracks keep their gradient; plain ones fill from
            // the neutral point out to the current value, so you can read how
            // far you have pushed a slider and in which direction.
            background: accent
              ? `linear-gradient(to right, ${accent})`
              : `linear-gradient(to right,`
                + ` transparent ${Math.min(pct, neutralPct)}%,`
                + ` var(--fill) ${Math.min(pct, neutralPct)}%,`
                + ` var(--fill) ${Math.max(pct, neutralPct)}%,`
                + ` transparent ${Math.max(pct, neutralPct)}%)`,
          }}
        />
      </div>
      {compact && numberField}
    </div>
  )
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const pushHistory = useStore((s) => s.pushHistory)
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => { pushHistory(); onChange(e.target.checked) }}
      />
      <span>{label}</span>
    </label>
  )
}

export function Select<T extends string>({ label, value, options, onChange }: {
  label?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  const pushHistory = useStore((s) => s.pushHistory)
  return (
    <div className="select-row">
      {label && <label>{label}</label>}
      <select value={value} onChange={(e) => { pushHistory(); onChange(e.target.value as T) }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: { value: T; label: string; color?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'active' : ''}
          style={o.color && o.value === value ? { color: o.color } : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Colour swatch with a hex field and an optional image eyedropper. */
export function ColorField({ label, value, onChange, eyedropper }: {
  label: string
  value: RGB
  onChange: (c: RGB) => void
  eyedropper?: boolean
}) {
  const pushHistory = useStore((s) => s.pushHistory)
  const picking = useStore((s) => s.picking)
  const setPicking = useStore((s) => s.setPicking)
  const [hex, setHex] = useState<string | null>(null)
  // Armed only while *this* field owns the picker. Treating any live picker as
  // ours meant a second eyedropper on screen looked armed, and pressing it
  // cancelled the first one's pick instead of starting its own.
  const mineRef = useRef<((rgb: RGB, uv: [number, number]) => void) | null>(null)
  const armed = picking !== null && picking === mineRef.current

  return (
    <div className="color-field">
      <label>{label}</label>
      <input
        type="color"
        value={rgbToHex(value)}
        onFocus={pushHistory}
        onChange={(e) => onChange(hexToRgb(e.target.value))}
      />
      <input
        className="hex"
        value={hex ?? rgbToHex(value)}
        onChange={(e) => {
          setHex(e.target.value)
          if (/^#?[\da-f]{6}$/i.test(e.target.value)) onChange(hexToRgb(e.target.value))
        }}
        onFocus={pushHistory}
        onBlur={() => setHex(null)}
      />
      {eyedropper && (
        <button
          className={`icon-btn ${armed ? 'armed' : ''}`}
          title="Pick a colour from the image"
          onClick={() => {
            if (armed) { setPicking(null); return }
            const mine = (c: RGB) => { pushHistory(); onChange(c); setPicking(null) }
            mineRef.current = mine
            setPicking(mine)
          }}
        >
          ⌖
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

export function HistogramView({ height = 90, channel = 'all' }: { height?: number; channel?: 'all' | 'r' | 'g' | 'b' | 'luma' }) {
  const hist = useHistogram()
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = cv.clientWidth, h = cv.clientHeight
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const x = Math.round((w * i) / 4) + 0.5
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
    }
    if (!hist) return

    const draw = (data: Uint32Array, fill: string) => {
      ctx.beginPath()
      ctx.moveTo(0, h)
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * w
        const y = h - Math.pow(data[i] / hist.max, 0.42) * h
        ctx.lineTo(x, y)
      }
      ctx.lineTo(w, h)
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()
    }

    if (channel === 'all') {
      ctx.globalCompositeOperation = 'lighter'
      draw(hist.r, 'rgba(255,64,64,0.55)')
      draw(hist.g, 'rgba(64,255,110,0.5)')
      draw(hist.b, 'rgba(80,120,255,0.6)')
      ctx.globalCompositeOperation = 'source-over'
    } else {
      const map = { r: [hist.r, 'rgba(255,90,90,0.75)'], g: [hist.g, 'rgba(90,230,130,0.7)'], b: [hist.b, 'rgba(110,150,255,0.8)'], luma: [hist.luma, 'rgba(230,232,238,0.65)'] } as const
      const [data, fill] = map[channel]
      draw(data as Uint32Array, fill as string)
    }
  }, [hist, channel, height])

  return <canvas ref={ref} className="histogram" style={{ height }} />
}

// ---------------------------------------------------------------------------
// Curve editor
// ---------------------------------------------------------------------------

const SIZE = 256
/** strip below the plot holding the black and white point handles */
const AXIS = 20
const VIEW_H = SIZE + AXIS
/** side padding so a handle sitting at x=0 or x=1 is not sliced in half */
const PAD = 8
const VIEW_W = SIZE + PAD * 2

/**
 * Pulling a channel curve up adds that channel; pulling it down adds its
 * complement. The wash and the two corner labels say so directly, instead of
 * leaving you to work it out. This is chromatic UI on purpose — the gradient
 * *is* the information, the same carve-out the Cyan/Red slider tracks use.
 */
const CHANNEL_TINT: Record<'r' | 'g' | 'b', { up: string; down: string; upLabel: string; downLabel: string }> = {
  r: { up: '#ff3b3b', down: '#00d8d8', upLabel: 'Red', downLabel: 'Cyan' },
  g: { up: '#3ee06f', down: '#e152e1', upLabel: 'Green', downLabel: 'Magenta' },
  b: { up: '#5a86ff', down: '#f2d63f', upLabel: 'Blue', downLabel: 'Yellow' },
}

export function CurveEditor({ points, onChange, channel }: {
  points: CurvePoints
  onChange: (p: CurvePoints) => void
  channel: 'rgb' | 'r' | 'g' | 'b'
}) {
  const pushHistory = useStore((s) => s.pushHistory)
  const hist = useHistogram()
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<number | null>(null)
  /** true once this gesture has pushed its undo snapshot */
  const pushedRef = useRef(false)
  /** offset from the pointer to the grabbed handle, so it does not jump */
  const grabRef = useRef({ dx: 0, dy: 0 })
  /**
   * The drag's own copy of the points. A pointermove can arrive before React
   * has re-rendered with the previous change, and reading the prop then would
   * silently discard it — most visibly by losing a just-created point.
   */
  const workingRef = useRef<CurvePoints | null>(null)
  /** dragging one of the black/white point handles on the axis strip */
  const axisRef = useRef<'black' | 'white' | null>(null)
  /** the point whose input/output values are shown */
  const [active, setActive] = useState(0)

  const toSvg = (p: { x: number; y: number }) => ({ cx: p.x * SIZE, cy: (1 - p.y) * SIZE })

  const fromEvent = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    // The SVG is padded sideways and taller than the plot, so map back through
    // the viewBox rather than assuming the element *is* the graph.
    const unitX = ((e.clientX - r.left) / r.width) * VIEW_W - PAD
    const plotH = r.height * (SIZE / VIEW_H)
    return {
      x: clamp(unitX / SIZE, 0, 1),
      y: clamp(1 - (e.clientY - r.top) / plotH, 0, 1),
    }
  }

  const sorted = [...points].sort((a, b) => a.x - b.x)

  const path = (() => {
    let d = ''
    for (let i = 0; i <= SIZE; i++) {
      const x = i / SIZE
      const y = sampleCurve(sorted, x)
      d += `${i === 0 ? 'M' : 'L'}${(x * SIZE).toFixed(2)},${((1 - y) * SIZE).toFixed(2)}`
    }
    return d
  })()

  const histPath = (() => {
    if (!hist) return ''
    const data = channel === 'rgb' ? hist.luma : channel === 'r' ? hist.r : channel === 'g' ? hist.g : hist.b
    let d = `M0,${SIZE}`
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * SIZE
      const y = SIZE - Math.pow(data[i] / hist.max, 0.42) * SIZE
      d += `L${x.toFixed(1)},${y.toFixed(1)}`
    }
    return `${d}L${SIZE},${SIZE}Z`
  })()

  const stroke = channel === 'rgb' ? '#ededed' : channel === 'r' ? '#ff6b6b' : channel === 'g' ? '#5ee08a' : '#6f95ff'

  /**
   * The SVG is wider and taller than the graph — side pads keep the end-point
   * handles whole and a strip below carries them. Presses out there must not
   * create points: fromEvent clamps, so a click on the strip would land a
   * control point at output 0 and crush every midtone to black.
   */
  const inPlot = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    const ux = ((e.clientX - r.left) / r.width) * VIEW_W - PAD
    const uy = ((e.clientY - r.top) / r.height) * VIEW_H
    return ux >= 0 && ux <= SIZE && uy >= 0 && uy <= SIZE
  }

  // Phones need a larger grab radius than a mouse cursor; 12px felt precise on
  // desktop and impossible with a thumb (docs/mobile.md: 5px drag targets).
  const hitPx = typeof window !== 'undefined'
    && window.matchMedia('(pointer: coarse), (max-width: 900px)').matches
    ? 28
    : 12
  const handleR = hitPx > 12 ? 8 : 5

  const onPointerDown = (e: React.PointerEvent) => {
    // right-click is the delete gesture; it must not start a drag
    if (e.button !== 0) return
    const pos = fromEvent(e)
    // grab the nearest handle when close, otherwise create one
    let nearest = -1
    let best = Infinity
    sorted.forEach((p, i) => {
      const d = Math.hypot((p.x - pos.x) * SIZE, (p.y - pos.y) * SIZE)
      if (d < best) { best = d; nearest = i }
    })

    // Only *creating* has to be confined to the plot. An end point sits on the
    // corner, so half of its circle is drawn out over the pad — rejecting those
    // presses outright made the visible half of the handle undraggable.
    if (best >= hitPx && !inPlot(e)) return

    if (best < hitPx) {
      // Snapshot lazily: a press that never turns into a drag must not land on
      // the undo stack, or clicking a handle fills it with identical entries.
      dragRef.current = nearest
      setActive(nearest)
      pushedRef.current = false
      workingRef.current = sorted
      // keep the handle where it is instead of teleporting it to the cursor
      grabRef.current = { dx: sorted[nearest].x - pos.x, dy: sorted[nearest].y - pos.y }
    } else {
      pushHistory()
      const point = { x: pos.x, y: pos.y }
      const next = [...sorted, point].sort((a, b) => a.x - b.x)
      dragRef.current = next.indexOf(point)
      setActive(next.indexOf(point))
      pushedRef.current = true
      workingRef.current = next
      grabRef.current = { dx: 0, dy: 0 }
      onChange(next)
    }
    // `?.` only guards a missing method — this throws when the pointer is
    // already gone, which would abort the handler mid-gesture.
    try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* fine without */ }
  }

  /** Drag a black/white point handle: moves that endpoint horizontally. */
  const onAxisDown = (which: 'black' | 'white') => (e: React.PointerEvent) => {
    e.stopPropagation()
    axisRef.current = which
    pushedRef.current = false
    workingRef.current = sorted
    setActive(which === 'black' ? 0 : sorted.length - 1)
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* fine without */ }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (axisRef.current) {
      const base = workingRef.current ?? sorted
      const last = base.length - 1
      const i = axisRef.current === 'black' ? 0 : last
      const lo = i === 0 ? 0 : Math.min(base[i - 1].x + 0.004, 1)
      const hi = i === last ? 1 : Math.max(base[i + 1].x - 0.004, 0)
      const x = lo <= hi ? clamp(fromEvent(e).x, lo, hi) : (lo + hi) / 2
      const next = [...base]
      next[i] = { x: clamp(x, 0, 1), y: base[i].y }
      if (!pushedRef.current) { pushHistory(); pushedRef.current = true }
      workingRef.current = next
      onChange(next)
      return
    }

    const i = dragRef.current
    const base = workingRef.current ?? sorted
    // The list can shrink under a live drag (a delete, or an undo from the
    // window-level shortcut), so re-check the index every move.
    if (i === null || i < 0 || i >= base.length) return

    const pos = fromEvent(e)
    const grab = grabRef.current
    const wanted = { x: pos.x + grab.dx, y: clamp(pos.y + grab.dy, 0, 1) }
    const next = [...base]
    const last = next.length - 1

    // Every point moves on both axes; none may cross its neighbours. Dragging
    // the end points inwards sets the black and white points, which is how you
    // clip an empty tail off the histogram. lo/hi are ordered before clamping
    // because neighbours closer together than the gap would otherwise invert
    // the range and push the point outside 0..1.
    const lo = i === 0 ? 0 : Math.min(next[i - 1].x + 0.004, 1)
    const hi = i === last ? 1 : Math.max(next[i + 1].x - 0.004, 0)
    const x = lo <= hi ? clamp(wanted.x, lo, hi) : (lo + hi) / 2

    if (!pushedRef.current) { pushHistory(); pushedRef.current = true }
    next[i] = { x: clamp(x, 0, 1), y: wanted.y }
    workingRef.current = next
    onChange(next)
  }

  const endDrag = () => {
    dragRef.current = null
    axisRef.current = null
    workingRef.current = null
  }

  const removePointAt = (i: number) => {
    if (sorted.length <= 2) return
    // end the gesture first: the index it holds is about to be wrong
    dragRef.current = null
    workingRef.current = null
    pushHistory()
    const next = sorted.filter((_, k) => k !== i)
    onChange(next)
    setActive(Math.min(i, next.length - 1))
  }

  const removePoint = (e: React.MouseEvent, i: number) => {
    e.preventDefault()
    e.stopPropagation()
    removePointAt(i)
  }

  const tint = channel === 'rgb' ? null : CHANNEL_TINT[channel]
  const first = sorted[0]
  const lastPt = sorted[sorted.length - 1]
  const activeIdx = Math.min(active, sorted.length - 1)
  const shown = sorted[activeIdx] ?? first
  const canDelete = sorted.length > 2

  return (
    <div className="curve-wrap">
      <svg
        ref={svgRef}
        viewBox={`${-PAD} 0 ${VIEW_W} ${VIEW_H}`}
        className="curve"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {tint && (
          <defs>
            <linearGradient id={`tint-${channel}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={tint.up} stopOpacity="0.22" />
              <stop offset="45%" stopColor={tint.up} stopOpacity="0.03" />
              <stop offset="55%" stopColor={tint.down} stopOpacity="0.03" />
              <stop offset="100%" stopColor={tint.down} stopOpacity="0.22" />
            </linearGradient>
          </defs>
        )}
        <rect width={SIZE} height={SIZE} fill="rgba(0,0,0,0.25)" />
        {tint && <rect width={SIZE} height={SIZE} fill={`url(#tint-${channel})`} />}
        {tint && (
          <g fontSize="11" fontWeight="600" opacity="0.75">
            <text x="8" y="18" fill={tint.up}>{tint.upLabel}</text>
            <text x={SIZE - 8} y={SIZE - 9} fill={tint.down} textAnchor="end">{tint.downLabel}</text>
          </g>
        )}
        {histPath && <path d={histPath} fill="rgba(255,255,255,0.13)" />}
        {[1, 2, 3].map((i) => (
          <g key={i} stroke="rgba(255,255,255,0.08)">
            <line x1={(SIZE * i) / 4} y1={0} x2={(SIZE * i) / 4} y2={SIZE} />
            <line x1={0} y1={(SIZE * i) / 4} x2={SIZE} y2={(SIZE * i) / 4} />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="rgba(255,255,255,0.16)" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={stroke} strokeWidth={1.75} />
        {sorted.map((p, i) => {
          const { cx, cy } = toSvg(p)
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={i === activeIdx ? handleR + 1 : handleR}
              fill={stroke}
              stroke={i === activeIdx ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.65)'}
              strokeWidth={1.5}
              onContextMenu={(e) => removePoint(e, i)}
              onDoubleClick={(e) => removePoint(e, i)}
            />
          )
        })}

        {/* Black and white point handles. They move the same end points you can
            already drag, but the corners are an awkward target — these sit on
            their own strip and are what people expect from Photoshop. */}
        <line x1={0} y1={SIZE + 1} x2={SIZE} y2={SIZE + 1} stroke="var(--line)" strokeWidth={1} />
        {([['black', first], ['white', lastPt]] as const).map(([which, p]) => (
          <g
            key={which}
            className="axis-handle"
            onPointerDown={onAxisDown(which)}
            transform={`translate(${p.x * SIZE} 0)`}
          >
            <rect x={-14} y={SIZE + 2} width={28} height={AXIS - 2} fill="transparent" />
            <path
              d={`M0,${SIZE + 3} L-7,${SIZE + 15} L7,${SIZE + 15} Z`}
              fill={which === 'black' ? '#111' : '#ededed'}
              stroke={which === 'black' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)'}
              strokeWidth={1}
            />
          </g>
        ))}
      </svg>

      <div className="curve-readout">
        <span>Input <b>{Math.round(shown.x * 255)}</b></span>
        <span>Output <b>{Math.round(shown.y * 255)}</b></span>
      </div>

      <button
        className="btn"
        disabled={!canDelete}
        onClick={() => removePointAt(activeIdx)}
        title={canDelete ? 'Delete the selected point' : 'Need at least two points'}
      >
        Delete selected point
      </button>

      <p className="hint">
        Tap the graph to add a point · drag to shape · delete with the button
        (or double-tap / right-click). The triangles below set black and white points.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gradient editor
// ---------------------------------------------------------------------------

export function GradientEditor({ stops, onChange }: {
  stops: GradientStop[]
  onChange: (s: GradientStop[]) => void
}) {
  const pushHistory = useStore((s) => s.pushHistory)
  const barRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState(0)
  const dragRef = useRef<number | null>(null)

  const sorted = [...stops].sort((a, b) => a.t - b.t)
  const css = `linear-gradient(to right, ${sorted.map((s) => `${cssRgb(s.color)} ${(s.t * 100).toFixed(1)}%`).join(', ')})`

  const posFromEvent = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1)
  }

  const sel = sorted[Math.min(selected, sorted.length - 1)]

  return (
    <div className="gradient-editor">
      <div
        className="gradient-bar"
        ref={barRef}
        style={{ background: css }}
        onDoubleClick={(e) => {
          const t = posFromEvent(e.clientX)
          pushHistory()
          // sample the ramp so the new stop starts where the user clicked
          let c: RGB = [0.5, 0.5, 0.5]
          if (sorted.length) {
            let k = 0
            while (k < sorted.length - 1 && sorted[k + 1].t < t) k++
            const a = sorted[k], b = sorted[Math.min(k + 1, sorted.length - 1)]
            const span = b.t - a.t
            const f = span <= 0 ? 0 : clamp((t - a.t) / span, 0, 1)
            c = [0, 1, 2].map((i) => a.color[i] + (b.color[i] - a.color[i]) * f) as RGB
          }
          const next = [...sorted, { t, color: c }].sort((x, y) => x.t - y.t)
          setSelected(next.findIndex((s) => s.t === t))
          onChange(next)
        }}
      />
      <div className="gradient-stops">
        {sorted.map((s, i) => (
          <button
            key={i}
            className={`gstop ${i === selected ? 'sel' : ''}`}
            style={{ left: `${s.t * 100}%`, background: cssRgb(s.color) }}
            onPointerDown={(e) => {
              setSelected(i)
              pushHistory()
              dragRef.current = i
              try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* fine without */ }
            }}
            onPointerMove={(e) => {
              if (dragRef.current !== i) return
              const t = posFromEvent(e.clientX)
              onChange(sorted.map((x, k) => (k === i ? { ...x, t } : x)))
            }}
            onPointerUp={() => { dragRef.current = null }}
          />
        ))}
      </div>
      {sel && (
        <div className="gradient-controls">
          <ColorField
            label={`Stop ${selected + 1}`}
            value={sel.color}
            onChange={(c) => onChange(sorted.map((x, k) => (k === selected ? { ...x, color: c } : x)))}
          />
          <div className="row">
            <Slider
              label="Position"
              value={Math.round(sel.t * 100)}
              min={0}
              max={100}
              suffix="%"
              neutral={50}
              onChange={(v) => onChange(sorted.map((x, k) => (k === selected ? { ...x, t: v / 100 } : x)))}
            />
            <button
              className="btn small"
              disabled={sorted.length <= 2}
              onClick={() => {
                pushHistory()
                onChange(sorted.filter((_, k) => k !== selected))
                setSelected(0)
              }}
            >
              Delete stop
            </button>
          </div>
        </div>
      )}
      <p className="hint">Double-click the ramp to add a stop · drag the handles to move them</p>
    </div>
  )
}
