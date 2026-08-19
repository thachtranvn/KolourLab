import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import type { Renderer } from '../engine/renderer'
import { cssRgb } from '../engine/color'

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
}

/** Only offer a repair when the evidence is strong; a nag is worse than nothing. */
const SUGGEST_THRESHOLD = 0.6

export function Viewer({ canvasRef, rendererRef, onFiles, onApplyFix }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const image = useStore((s) => s.image)
  const zoom = useStore((s) => s.zoom)
  const pan = useStore((s) => s.pan)
  const compare = useStore((s) => s.compare)
  const split = useStore((s) => s.split)
  const picking = useStore((s) => s.picking)
  const setZoom = useStore((s) => s.setZoom)
  const setPan = useStore((s) => s.setPan)
  const setFitZoom = useStore((s) => s.setFitZoom)
  const setSplit = useStore((s) => s.setSplit)

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

  // Fit the image whenever it changes or the viewport resizes.
  const fit = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap || !image) return
    // leave a mat around the photo rather than crowding it to the edges
    const z = Math.min(wrap.clientWidth / image.width, wrap.clientHeight / image.height) * 0.9
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

  const onPointerDown = (e: React.PointerEvent) => {
    // Overlay controls live inside the viewer, and calling setPointerCapture
    // here would redirect the pointerup away from them so their click never
    // fires. Let those handle their own events.
    if ((e.target as HTMLElement).closest?.('.viewer-ui')) return
    if (!image) return

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
      if (Math.abs(x - split) < 0.03) {
        splitDrag.current = true
        capture(e)
        return
      }
    }
    dragState.current = { x: e.clientX, y: e.clientY, pan: [...pan] as [number, number] }
    capture(e)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (painting) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
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
    const d = dragState.current
    if (d) {
      setPan([d.pan[0] + (e.clientX - d.x), d.pan[1] + (e.clientY - d.y)])
      return
    }
    if (picking) {
      const uv = toImageUV(e.clientX, e.clientY)
      setHoverColor(uv ? rendererRef.current?.pick(uv[0], uv[1]) ?? null : null)
    }
  }

  const endDrag = () => {
    dragState.current = null
    splitDrag.current = false
    strokeRef.current = false
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!image) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    // keep the point under the cursor anchored while zooming
    const mx = e.clientX - rect.left - rect.width / 2 - pan[0]
    const my = e.clientY - rect.top - rect.height / 2 - pan[1]
    const factor = Math.exp(-e.deltaY * 0.0015)
    const next = Math.min(16, Math.max(0.02, zoom * factor))
    const k = next / zoom
    setZoom(next)
    setPan([pan[0] - mx * (k - 1), pan[1] - my * (k - 1)])
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
      onWheel={onWheel}
    >
      <canvas ref={canvasRef} className="gl-canvas" />

      {!image && (
        <div className="empty">
          <div className="empty-card">
            <h2>Drop a photo to begin</h2>
            <p>JPEG, PNG, WebP or AVIF. Everything runs locally on your GPU — nothing is uploaded.</p>
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
          <span style={{ left: 0, width: `${split * 100}%` }}>Before</span>
          <span style={{ left: `${split * 100}%`, right: 0 }}>After</span>
        </div>
      )}
    </div>
  )
}
