import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore, surroundValue } from '../state/store'
import type { Renderer } from '../engine/renderer'
import { cssRgb } from '../engine/color'
import { HistogramView } from './controls'
import { SAMPLE_PHOTOS } from './samples'

/** Duration of discrete view tweens (double-tap to fit). */
const VIEW_TWEEN_MS = 340
/** Hold still this long on the photo to peek the unedited original. */
const HOLD_ORIGINAL_MS = 500

/** setPointerCapture throws if the pointer is already gone; never let that kill the gesture. */
function capture(e: React.PointerEvent) {
  try {
    (e.currentTarget as Element).setPointerCapture(e.pointerId)
  } catch {
    /* the gesture still works without capture */
  }
}

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement>
  rendererRef: React.RefObject<Renderer | null>
  onFiles: (files: FileList) => void
  onApplyFix: (id: string) => void
  onLoadSample: (url: string, name: string) => void
}

/** Only offer a repair when the evidence is strong; a nag is worse than nothing. */
const SUGGEST_THRESHOLD = 0.6

export function Viewer({ canvasRef, rendererRef, onFiles, onApplyFix, onLoadSample }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const image = useStore((s) => s.image)
  const zoom = useStore((s) => s.zoom)
  const pan = useStore((s) => s.pan)
  const compare = useStore((s) => s.compare)
  const split = useStore((s) => s.split)
  const picking = useStore((s) => s.picking)
  const setZoom = useStore((s) => s.setZoom)
  const setPan = useStore((s) => s.setPan)
  const setView = useStore((s) => s.setView)
  const setFitZoom = useStore((s) => s.setFitZoom)
  const setSplit = useStore((s) => s.setSplit)
  const setCompare = useStore((s) => s.setCompare)

  const paintMode = useStore((s) => s.painting)
  const brush = useStore((s) => s.brush)
  const selectedId = useStore((s) => s.selectedId)
  const brushLayer = useStore((s) =>
    s.layers.find((l) => l.id === s.selectedId && l.mask.kind === 'brush') ?? null)
  /** only actually paint when the selected layer has a brush mask to paint into */
  const painting = paintMode && brushLayer !== null
  const addStroke = useStore((s) => s.addStroke)
  const extendStroke = useStore((s) => s.extendStroke)

  const suggestions = useStore((s) => s.suggestions)
  const dismissed = useStore((s) => s.dismissed)
  const dismissFix = useStore((s) => s.dismissFix)
  const layerCount = useStore((s) => s.layers.length)
  const suggestion = suggestions.find(
    (s) => s.confidence >= SUGGEST_THRESHOLD && !dismissed.includes(s.id))

  const [dragOver, setDragOver] = useState(false)
  const [hoverColor, setHoverColor] = useState<[number, number, number] | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const dragState = useRef<{ x: number; y: number; pan: [number, number] } | null>(null)
  const splitDrag = useRef(false)
  const strokeRef = useRef(false)
  /** Active pointers for pinch-zoom (pointerId → client coords). */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{
    startDist: number
    startZoom: number
    startPan: [number, number]
    startMid: [number, number]
  } | null>(null)
  /** Double-tap → fit. Tracks a short stationary tap sequence. */
  const tapRef = useRef<{
    downX: number
    downY: number
    moved: boolean
    wasPinch: boolean
    lastAt: number
    lastX: number
    lastY: number
  }>({ downX: 0, downY: 0, moved: false, wasPinch: false, lastAt: 0, lastX: 0, lastY: 0 })
  /** Hold-still peek of the original (compare mode 2). */
  const holdTimer = useRef(0)
  const holdOriginal = useRef(false)
  // Live view during a gesture — avoid stale React closures and coalesce
  // setState so pinch does not queue a store write per touchmove.
  const viewRef = useRef({ zoom, pan })
  const pendingView = useRef<{ zoom: number; pan: [number, number] } | null>(null)
  const viewRaf = useRef(0)
  const animRaf = useRef(0)

  const cancelViewAnim = useCallback(() => {
    if (animRaf.current) {
      cancelAnimationFrame(animRaf.current)
      animRaf.current = 0
    }
  }, [])

  // Keep viewRef in sync with the store when nothing is driving it locally
  // (gestures / fit animation own the ref while they run).
  if (!animRaf.current && !viewRaf.current && !dragState.current && !pinchRef.current) {
    viewRef.current = { zoom, pan }
  }

  const commitView = useCallback((nextZoom: number, nextPan: [number, number]) => {
    cancelViewAnim()
    const z = Math.min(16, Math.max(0.02, nextZoom))
    pendingView.current = { zoom: z, pan: nextPan }
    viewRef.current = { zoom: z, pan: nextPan }
    if (viewRaf.current) return
    viewRaf.current = requestAnimationFrame(() => {
      viewRaf.current = 0
      const v = pendingView.current
      if (!v) return
      setView(v.zoom, v.pan)
    })
  }, [setView, cancelViewAnim])

  /** Draw the current view straight to the canvas — skips the React hop. */
  const presentView = useCallback((z: number, p: [number, number]) => {
    const r = rendererRef.current
    if (!r?.hasImage) return
    const s = useStore.getState()
    r.present({
      zoom: z,
      pan: p,
      compare: s.compare,
      split: s.split,
      maskMode: s.maskView,
      surround: surroundValue(s.surround),
    })
  }, [rendererRef])

  /**
   * Ease zoom/pan to a target. Used for discrete jumps (double-tap fit);
   * live pinch/drag/wheel stay on commitView so they track the finger 1:1.
   * Presents every frame directly — going through setState alone used to
   * retrigger a full layer-stack render and the tween collapsed to one jump.
   */
  const animateView = useCallback((nextZoom: number, nextPan: [number, number], ms = VIEW_TWEEN_MS) => {
    cancelViewAnim()
    if (viewRaf.current) {
      cancelAnimationFrame(viewRaf.current)
      viewRaf.current = 0
    }
    const z0 = viewRef.current.zoom
    const p0: [number, number] = [viewRef.current.pan[0], viewRef.current.pan[1]]
    const z1 = Math.min(16, Math.max(0.02, nextZoom))
    const p1: [number, number] = [nextPan[0], nextPan[1]]
    if (Math.abs(z0 - z1) < 1e-4
      && Math.abs(p0[0] - p1[0]) < 0.5
      && Math.abs(p0[1] - p1[1]) < 0.5) {
      viewRef.current = { zoom: z1, pan: p1 }
      setView(z1, p1)
      presentView(z1, p1)
      return
    }
    const t0 = performance.now()
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / ms)
      const e = 1 - (1 - u) ** 3 // ease-out cubic
      const z = z0 + (z1 - z0) * e
      const pan: [number, number] = [
        p0[0] + (p1[0] - p0[0]) * e,
        p0[1] + (p1[1] - p0[1]) * e,
      ]
      viewRef.current = { zoom: z, pan }
      pendingView.current = { zoom: z, pan }
      // GPU first so the motion is visible even if React coalesces setState.
      presentView(z, pan)
      setView(z, pan)
      if (u < 1) animRaf.current = requestAnimationFrame(step)
      else {
        animRaf.current = 0
        viewRef.current = { zoom: z1, pan: p1 }
        pendingView.current = { zoom: z1, pan: p1 }
        presentView(z1, p1)
        setView(z1, p1)
      }
    }
    animRaf.current = requestAnimationFrame(step)
  }, [setView, cancelViewAnim, presentView])

  /** Reset zoom/pan to the fitted mat — double-tap / double-click. */
  const resetToFit = useCallback(() => {
    tapRef.current.lastAt = 0
    animateView(useStore.getState().fitZoom, [0, 0])
  }, [animateView])

  const clearHoldOriginal = useCallback(() => {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = 0
    }
    if (holdOriginal.current) {
      holdOriginal.current = false
      setCompare(0)
    }
  }, [setCompare])

  useEffect(() => () => {
    if (viewRaf.current) cancelAnimationFrame(viewRaf.current)
    if (animRaf.current) cancelAnimationFrame(animRaf.current)
    if (holdTimer.current) window.clearTimeout(holdTimer.current)
  }, [])

  // Fit the image whenever it changes or the viewport resizes.
  const fit = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap || !image) return
    // Edge-to-edge: fill the viewer on the limiting axis (no mat inset).
    const z = Math.min(wrap.clientWidth / image.width, wrap.clientHeight / image.height)
    setFitZoom(z)
    return z
  }, [image, setFitZoom])

  useEffect(() => {
    const z = fit()
    if (z) { setZoom(z); setPan([0, 0]) }
  }, [image, fit, setZoom, setPan])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => {
      const z = fit()
      // If the viewer was showing the whole photo, keep showing the whole
      // photo when the panels come and go. A manual zoom is left alone.
      const s = useStore.getState()
      if (z && Math.abs(s.zoom - s.fitZoom) < 0.002) s.setZoom(z)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [fit])

  /** Canvas client coords -> image-space uv, in top-down orientation. */
  const toImageUV = (clientX: number, clientY: number): [number, number] | null => {
    const r = rendererRef.current
    const canvas = canvasRef.current
    if (!r || !canvas || !r.hasImage) return null
    const rect = canvas.getBoundingClientRect()
    const dpr = canvas.width / rect.width
    const px = (clientX - rect.left) * dpr
    const py = (clientY - rect.top) * dpr
    const zoomEff = zoom * (r.fullSize[0] / r.previewSize[0]) * dpr
    const cx = px - canvas.width / 2 - pan[0] * dpr
    const cy = py - canvas.height / 2 - pan[1] * dpr
    const ix = cx / zoomEff + r.previewSize[0] / 2
    const iy = cy / zoomEff + r.previewSize[1] / 2
    const u = ix / r.previewSize[0]
    const v = iy / r.previewSize[1]
    if (u < 0 || u > 1 || v < 0 || v > 1) return null
    return [u, v]
  }

  const beginPinch = (wrap: HTMLElement) => {
    const pts = [...pointers.current.values()]
    if (pts.length < 2) return
    const [a, b] = pts
    const rect = wrap.getBoundingClientRect()
    const midX = (a.x + b.x) / 2
    const midY = (a.y + b.y) / 2
    const dx = a.x - b.x
    const dy = a.y - b.y
    const dist = Math.hypot(dx, dy)
    if (dist < 8) return
    const { zoom: z, pan: p } = viewRef.current
    pinchRef.current = {
      startDist: dist,
      startZoom: z,
      startPan: [p[0], p[1]],
      startMid: [midX - rect.left - rect.width / 2, midY - rect.top - rect.height / 2],
    }
    dragState.current = null
    strokeRef.current = false
    tapRef.current.wasPinch = true
    tapRef.current.lastAt = 0
    clearHoldOriginal()
  }

  const onPointerDown = (e: React.PointerEvent) => {
    // Overlay controls live inside the viewer, and calling setPointerCapture
    // here would redirect the pointerup away from them so their click never
    // fires. Let those handle their own events.
    if ((e.target as HTMLElement).closest?.('.viewer-ui')) return
    if (!image) return
    // Take over from a running fit tween the moment the user touches.
    cancelViewAnim()
    clearHoldOriginal()

    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // Two fingers: pinch / pan the photo. Never paint or split-drag.
    if (pointers.current.size >= 2) {
      capture(e)
      beginPinch(e.currentTarget as HTMLElement)
      return
    }

    // Painting takes priority over panning; hold Space (or middle-drag) to pan.
    if (painting && selectedId && e.button === 0 && !e.shiftKey) {
      const uv = toImageUV(e.clientX, e.clientY)
      if (uv) {
        strokeRef.current = true
        addStroke(selectedId, {
          mode: (brush.erase ? !e.altKey : e.altKey) ? 'erase' : 'add',
          size: brush.size,
          hardness: brush.hardness,
          flow: brush.flow,
          points: [uv[0], uv[1]],
        })
        capture(e)
        return
      }
    }

    if (picking) {
      const uv = toImageUV(e.clientX, e.clientY)
      const c = uv && rendererRef.current?.pick(uv[0], uv[1])
      if (c && uv) picking(c, uv)
      return
    }
    if (compare === 1) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      // ~44px touch target so the hairline is easy to grab on a phone.
      const hit = Math.max(0.06, 44 / rect.width)
      if (Math.abs(x - split) < hit) {
        splitDrag.current = true
        capture(e)
        return
      }
    }
    const { pan: p } = viewRef.current
    dragState.current = { x: e.clientX, y: e.clientY, pan: [p[0], p[1]] }
    tapRef.current.downX = e.clientX
    tapRef.current.downY = e.clientY
    tapRef.current.moved = false
    tapRef.current.wasPinch = false
    // Hold still 1s → peek original. Cancelled if the finger moves or a
    // second finger joins. Replaces the native long-press select/callout.
    if (!painting && !picking) {
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = 0
        if (tapRef.current.moved || tapRef.current.wasPinch) return
        if (pointers.current.size !== 1) return
        holdOriginal.current = true
        dragState.current = null
        setCompare(2)
      }, HOLD_ORIGINAL_MS)
    }
    capture(e)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    if (painting) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
    }

    // Pinch: scale about the gesture midpoint, and let the midpoint drag pan.
    if (pinchRef.current && pointers.current.size >= 2) {
      const pts = [...pointers.current.values()]
      const [a, b] = pts
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const midX = (a.x + b.x) / 2 - rect.left - rect.width / 2
      const midY = (a.y + b.y) / 2 - rect.top - rect.height / 2
      const g = pinchRef.current
      if (dist >= 8 && g.startDist >= 8) {
        const next = Math.min(16, Math.max(0.02, g.startZoom * (dist / g.startDist)))
        const k = next / g.startZoom
        const mx = g.startMid[0] - g.startPan[0]
        const my = g.startMid[1] - g.startPan[1]
        commitView(next, [
          g.startPan[0] - mx * (k - 1) + (midX - g.startMid[0]),
          g.startPan[1] - my * (k - 1) + (midY - g.startMid[1]),
        ])
      }
      return
    }

    if (strokeRef.current && selectedId) {
      const uv = toImageUV(e.clientX, e.clientY)
      if (uv) extendStroke(selectedId, uv[0], uv[1])
      return
    }
    if (splitDrag.current) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setSplit((e.clientX - rect.left) / rect.width)
      return
    }
    // Peeking the original — stay put until release.
    if (holdOriginal.current) return

    const d = dragState.current
    if (d) {
      if (!tapRef.current.moved) {
        const moved = Math.hypot(e.clientX - tapRef.current.downX, e.clientY - tapRef.current.downY)
        if (moved > 12) {
          tapRef.current.moved = true
          if (holdTimer.current) {
            window.clearTimeout(holdTimer.current)
            holdTimer.current = 0
          }
        }
      }
      commitView(viewRef.current.zoom, [
        d.pan[0] + (e.clientX - d.x),
        d.pan[1] + (e.clientY - d.y),
      ])
      return
    }
    if (picking) {
      const uv = toImageUV(e.clientX, e.clientY)
      setHoverColor(uv ? rendererRef.current?.pick(uv[0], uv[1]) ?? null : null)
    }
  }

  const endDrag = (e?: React.PointerEvent) => {
    if (e) pointers.current.delete(e.pointerId)
    else pointers.current.clear()

    if (pointers.current.size >= 2 && wrapRef.current) {
      beginPinch(wrapRef.current)
      return
    }
    if (pointers.current.size === 1) {
      // Dropped out of a pinch into one finger — continue as a pan.
      pinchRef.current = null
      const [pt] = pointers.current.values()
      const { pan: p } = viewRef.current
      dragState.current = { x: pt.x, y: pt.y, pan: [p[0], p[1]] }
      tapRef.current.wasPinch = true
      return
    }

    // Held long enough to peek original — release restores the edit, no tap.
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = 0
    }
    if (holdOriginal.current) {
      holdOriginal.current = false
      setCompare(0)
      tapRef.current.lastAt = 0
      dragState.current = null
      splitDrag.current = false
      strokeRef.current = false
      pinchRef.current = null
      return
    }

    // Double-tap to fit: two quick, nearly stationary taps with one finger.
    const tap = tapRef.current
    const canTap = !!e && !tap.moved && !tap.wasPinch && !strokeRef.current
      && !splitDrag.current && !painting && !picking && !!image
    if (canTap) {
      const now = performance.now()
      const dt = now - tap.lastAt
      const dist = Math.hypot(e.clientX - tap.lastX, e.clientY - tap.lastY)
      if (dt > 0 && dt < 320 && dist < 48) {
        resetToFit()
      } else {
        tap.lastAt = now
        tap.lastX = e.clientX
        tap.lastY = e.clientY
      }
    } else {
      tap.lastAt = 0
    }

    dragState.current = null
    splitDrag.current = false
    strokeRef.current = false
    pinchRef.current = null
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!image) return
    const canvas = canvasRef.current
    if (!canvas) return
    cancelViewAnim()
    const rect = canvas.getBoundingClientRect()
    const { zoom: z, pan: p } = viewRef.current
    // keep the point under the cursor anchored while zooming
    const mx = e.clientX - rect.left - rect.width / 2 - p[0]
    const my = e.clientY - rect.top - rect.height / 2 - p[1]
    const factor = Math.exp(-e.deltaY * 0.0015)
    const next = Math.min(16, Math.max(0.02, z * factor))
    const k = next / z
    commitView(next, [p[0] - mx * (k - 1), p[1] - my * (k - 1)])
  }

  return (
    <div
      className={`viewer ${dragOver ? 'drag-over' : ''} ${picking ? 'picking' : ''} ${painting ? 'painting' : ''}`}
      ref={wrapRef}
      onPointerLeave={() => setCursor(null)}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files)
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest?.('.viewer-ui')) return
        if (!image || painting || picking) return
        e.preventDefault()
        resetToFit()
      }}
      onWheel={onWheel}
    >
      <canvas ref={canvasRef} className="gl-canvas" />

      {!image && (
        <div className="empty">
          <div className="empty-card">
            <h2>Drop a photo to begin</h2>
            <p>JPEG, PNG, WebP or AVIF. Everything runs locally on your GPU — nothing is uploaded.</p>
            <div className="sample-strip" role="list">
              {SAMPLE_PHOTOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="listitem"
                  className="sample-thumb"
                  title={s.hint}
                  onClick={(e) => { e.stopPropagation(); onLoadSample(s.url, `${s.id}.jpg`) }}
                >
                  <img src={s.url} alt="" />
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {suggestion && image && layerCount === 0 && !painting && (
        <div className="suggestion viewer-ui">
          <div className="suggestion-text">
            <strong>{suggestion.name}</strong>
            <span>{suggestion.explanation}</span>
          </div>
          <div className="suggestion-actions">
            <button className="btn small primary" onClick={() => onApplyFix(suggestion.id)}>Fix it</button>
            <button className="btn small" onClick={() => dismissFix(suggestion.id)}>Not now</button>
          </div>
        </div>
      )}

      {painting && cursor && image && (
        <div
          className="brush-cursor"
          style={{
            left: cursor.x,
            top: cursor.y,
            // brush size is a fraction of the image's long edge, in image pixels
            width: brush.size * Math.max(image.width, image.height) * zoom,
            height: brush.size * Math.max(image.width, image.height) * zoom,
          }}
        />
      )}

      {painting && (
        <div className="pick-hud">
          Drag to paint the mask · ⌥ inverts the brush · Shift-drag or scroll to navigate
        </div>
      )}

      {picking && (
        <div className="pick-hud">
          {hoverColor && <span className="swatch" style={{ background: cssRgb(hoverColor) }} />}
          Click the image to sample a colour · Esc to cancel
        </div>
      )}

      {image && compare === 1 && (
        <div className="split-labels">
          <span className="before">Before</span>
          <span className="after">After</span>
        </div>
      )}

      {image && compare === 0 && !painting && !picking && (
        <div className="mini-hist" aria-hidden>
          <HistogramView height={36} />
        </div>
      )}
    </div>
  )
}
