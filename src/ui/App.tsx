import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Renderer, type Histogram } from '../engine/renderer'
import { useStore, surroundValue, SURROUNDS } from '../state/store'
import { HistogramContext, HistogramView } from './controls'
import { Viewer } from './Viewer'
import { LayerStack } from './LayerStack'
import { SegmentContext } from './MaskPanel'
import { makeSampleImage } from './sample'
import { colourlab, setApiRenderer, notifyRendered, markRenderPending, abortPendingFrames, ensureMasksReady } from '../api'
import type { Layer } from '../state/types'

/**
 * Overflow for secondary chrome. The topbar stays one row — Open, undo/redo,
 * hold-to-compare, Export — and everything else lives behind ⋯.
 */
function MoreMenu({
  anchor, onClose, onSample, onExportPng, onImportRecipe, onExportRecipe,
}: {
  anchor: HTMLElement
  onClose: () => void
  onSample: () => void
  onExportPng: () => void
  onImportRecipe: () => void
  onExportRecipe: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const image = useStore((s) => s.image)
  const layers = useStore((s) => s.layers)
  const zoom = useStore((s) => s.zoom)
  const compare = useStore((s) => s.compare)
  const surround = useStore((s) => s.surround)
  const showHistogram = useStore((s) => s.showHistogram)
  const setCompare = useStore((s) => s.setCompare)
  const setZoom = useStore((s) => s.setZoom)
  const zoomToFit = useStore((s) => s.zoomToFit)
  const setSurround = useStore((s) => s.setSurround)
  const toggleHistogram = useStore((s) => s.toggleHistogram)

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.getBoundingClientRect()
      const width = 260
      const left = Math.max(8, Math.min(a.right - width, window.innerWidth - width - 8))
      const top = Math.min(a.bottom + 6, window.innerHeight - 8)
      setPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])

  if (!pos) return null

  return createPortal(
    <div className="more-menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu">
      <button type="button" role="menuitem" onClick={() => { onSample(); onClose() }}>
        Load sample image
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!image}
        className={compare === 1 ? 'active' : ''}
        onClick={() => { setCompare(compare === 1 ? 0 : 1); onClose() }}
      >
        {compare === 1 ? 'Exit split view' : 'Split before / after'}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!image}
        onClick={() => { toggleHistogram(); onClose() }}
      >
        {showHistogram ? 'Hide histogram' : 'Show histogram'}
      </button>

      <div className="more-sep" />
      <div className="more-label">Zoom</div>
      <div className="more-row">
        <button type="button" disabled={!image} onClick={() => setZoom(zoom / 1.25)} aria-label="Zoom out">−</button>
        <button type="button" disabled={!image} onClick={() => { zoomToFit(); onClose() }}>
          {Math.round(zoom * 100)}% · Fit
        </button>
        <button type="button" disabled={!image} onClick={() => setZoom(zoom * 1.25)} aria-label="Zoom in">+</button>
      </div>

      <div className="more-sep" />
      <div className="more-label">Backdrop</div>
      <div className="more-row surround">
        {SURROUNDS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`swatch-btn ${surround === s.key ? 'active' : ''}`}
            style={{ background: `rgb(${Math.round(s.value * 255)},${Math.round(s.value * 255)},${Math.round(s.value * 255)})` }}
            title={`${s.label} — ${s.hint}`}
            onClick={() => setSurround(s.key)}
          />
        ))}
      </div>

      <div className="more-sep" />
      <button type="button" role="menuitem" onClick={() => { onImportRecipe(); onClose() }}>
        Import recipe…
      </button>
      <button type="button" role="menuitem" disabled={!layers.length} onClick={() => { onExportRecipe(); onClose() }}>
        Save recipe
      </button>
      <button type="button" role="menuitem" disabled={!image} onClick={() => { onExportPng(); onClose() }}>
        Export PNG
      </button>
    </div>,
    document.body,
  )
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recipeRef = useRef<HTMLInputElement>(null)
  const rafRef = useRef(0)
  const histTimer = useRef<number | undefined>(undefined)
  const thumbTimer = useRef<number | undefined>(undefined)

  const [ready, setReady] = useState(false)
  const [glError, setGlError] = useState<string | null>(null)
  const [hist, setHist] = useState<Histogram | null>(null)
  const [thumbs, setThumbs] = useState<ImageData[]>([])
  // bumped when a segmentation pass starts or finishes, to retrigger the render
  // loop and to let the mask panel re-read the pass flags
  const [segEpoch, setSegEpoch] = useState(0)
  const [segError, setSegError] = useState<string | null>(null)
  const segStatus = useMemo(() => ({ epoch: segEpoch, error: segError }), [segEpoch, segError])
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [contextLost, setContextLost] = useState(false)
  const [glEpoch, setGlEpoch] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreBtnRef = useRef<HTMLButtonElement>(null)

  const image = useStore((s) => s.image)
  const layers = useStore((s) => s.layers)
  const zoom = useStore((s) => s.zoom)
  const pan = useStore((s) => s.pan)
  const compare = useStore((s) => s.compare)
  const split = useStore((s) => s.split)
  const selectedId = useStore((s) => s.selectedId)
  const maskView = useStore((s) => s.maskView)
  const peek = useStore((s) => s.peek)
  const painting = useStore((s) => s.painting)
  const brush = useStore((s) => s.brush)
  const setBrush = useStore((s) => s.setBrush)
  const setPainting = useStore((s) => s.setPainting)
  const surround = useStore((s) => s.surround)
  const chromeHidden = useStore((s) => s.chromeHidden)
  const toggleChrome = useStore((s) => s.toggleChrome)
  const surroundLevel = surroundValue(surround)
  const showHistogram = useStore((s) => s.showHistogram)
  const setCompare = useStore((s) => s.setCompare)
  const setZoom = useStore((s) => s.setZoom)
  const zoomToFit = useStore((s) => s.zoomToFit)
  const toggleHistogram = useStore((s) => s.toggleHistogram)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const setPicking = useStore((s) => s.setPicking)
  const loadRecipe = useStore((s) => s.loadRecipe)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600)
  }, [])

  // --- boot, and recover from context loss --------------------------------
  //
  // Browsers drop WebGL contexts freely — on mobile it happens just from
  // backgrounding the tab. Every GPU resource is derived: the source bitmaps
  // live in the document, and LUTs, cubes and baked brush masks regenerate
  // from their parameters. So recovery is a rebuild, and nothing is lost.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const start = () => {
      try {
        const r = new Renderer(canvas)
        rendererRef.current = r
        setApiRenderer(r)
        window.colourlab = colourlab
        const img = useStore.getState().image
        if (img) r.setImage(img.full, img.preview)
        setContextLost(false)
        setReady(true)
        // force the render loop to run against the new context
        setGlEpoch((n) => n + 1)
      } catch (e) {
        setGlError(e instanceof Error ? e.message : String(e))
      }
    }

    const onLost = (e: Event) => {
      // Without preventDefault the browser never fires a restore.
      e.preventDefault()
      // Its GL objects are already gone; deleting them would be meaningless.
      rendererRef.current = null
      setApiRenderer(null)
      abortPendingFrames()
      setContextLost(true)
    }

    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', start)
    start()
    console.info(
      '%cColour Lab%c automation ready — call %ccolourlab.help()%c for the full surface.',
      'font-weight:600', '', 'font-family:monospace', '',
    )

    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', start)
      rendererRef.current?.dispose()
      rendererRef.current = null
      setApiRenderer(null)
    }
  }, [])

  // --- image loading ------------------------------------------------------
  const loadSource = useCallback(async (source: Blob | HTMLCanvasElement, name: string) => {
    if (!rendererRef.current) return
    setBusy('Loading image…')
    try {
      // one path for every entry point, so the diagnosis always runs
      await colourlab.open(source, name)
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not read that image.')
    } finally {
      setBusy(null)
    }
  }, [flash])

  const applyFix = useCallback(async (id: string) => {
    setBusy('Measuring…')
    try {
      const res = await colourlab.fix(id)
      flash(res.applied ? `${res.explanation}` : 'Nothing to fix.')
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not apply that fix.')
    } finally {
      setBusy(null)
    }
  }, [flash])

  const onFiles = useCallback((files: FileList) => {
    const file = Array.from(files).find((f) => f.type.startsWith('image/'))
    if (!file) { flash('That file is not an image.'); return }
    loadSource(file, file.name)
  }, [loadSource, flash])

  // A hovered row can vanish under the cursor — undo, delete, a recipe load —
  // and React fires no mouseleave for a node that was removed. A stale peek id
  // both freezes thumbnail regeneration and hides a layer whose row still
  // claims to be enabled, so drop it as soon as the layer is gone.
  useEffect(() => {
    if (peek && !layers.some((l) => l.id === peek)) useStore.getState().setPeek(null)
  }, [layers, peek])

  // --- render loop --------------------------------------------------------
  useEffect(() => {
    if (!ready) return
    // Tell the API a frame is on its way, so anything waiting on current
    // pixels knows to wait — and, just as importantly, knows when not to.
    markRenderPending()
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const r = rendererRef.current
      if (!r) return
      r.pruneCaches(new Set(layers.map((l) => l.id)))
      r.maskViewLayerId = maskView ? selectedId : null
      // hovering a thumbnail switches that layer off in the preview only
      const shown = peek
        ? layers.map((l) => (l.id === peek ? { ...l, enabled: false } : l))
        : layers
      r.render(shown)
      r.present({ zoom, pan, compare, split, maskMode: maskView, surround: surroundLevel })
      notifyRendered()

      window.clearTimeout(histTimer.current)
      histTimer.current = window.setTimeout(() => {
        setHist(rendererRef.current?.histogram() ?? null)
      }, 90)
    })
    return () => cancelAnimationFrame(rafRef.current)
  }, [ready, glEpoch, segEpoch, layers, image, zoom, pan, compare, split, maskView, selectedId, surroundLevel, peek])

  // A segmented mask needs an inference before it can sample anything, and the
  // render loop is synchronous. Run it beside the loop and bump an epoch when
  // it lands, which redraws with the mask populated.
  // glEpoch matters as much as the other three: a restored context brings a new
  // renderer holding no segmentation, so this has to run again and re-upload.
  useEffect(() => {
    if (!ready || !image) return
    let cancelled = false
    // Bump on the way in as well as out: the inference flags live in module
    // scope, so this epoch is the only thing that tells the mask panel to look
    // at them again and show that a pass is running.
    setSegEpoch((n) => n + 1)
    ensureMasksReady()
      .then(() => {
        if (cancelled) return
        setSegError(null)                       // a later success clears an earlier failure
        setSegEpoch((n) => n + 1)
      })
      .catch((e) => { if (!cancelled) setSegError(String((e as Error)?.message ?? e)) })
    return () => { cancelled = true }
  }, [ready, glEpoch, image, layers])

  // Thumbnails depend only on the stack and the photo — not on pan, zoom,
  // compare, split, mask view or selection. Regenerating them from the render
  // loop meant a GPU readback on every pan. A peek must not recompute them
  // either, or the row under the cursor blinks to its own hidden state.
  useEffect(() => {
    if (!ready || peek) return
    window.clearTimeout(thumbTimer.current)
    thumbTimer.current = window.setTimeout(() => {
      setThumbs(rendererRef.current?.renderThumbnails(layers) ?? [])
    }, 140)
    return () => window.clearTimeout(thumbTimer.current)
  }, [ready, glEpoch, layers, image, peek])

  // Redraw on viewport resize (the canvas backing store changes size).
  useEffect(() => {
    const onResize = () => {
      const r = rendererRef.current
      if (r) r.present({ zoom, pan, compare, split, maskMode: maskView, surround: surroundLevel })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [zoom, pan, compare, split, maskView, surroundLevel])

  // --- export -------------------------------------------------------------
  const exportImage = useCallback(async (type: 'image/png' | 'image/jpeg') => {
    const r = rendererRef.current
    if (!r || !image) return
    setBusy('Rendering at full resolution…')
    // let the busy state paint before the synchronous GPU readback
    await new Promise((res) => setTimeout(res, 30))
    try {
      const out = r.renderFullResolution(layers)
      if (!out) { flash('Nothing to export.'); return }
      const cv = document.createElement('canvas')
      cv.width = out.w
      cv.height = out.h
      cv.getContext('2d')!.putImageData(new ImageData(out.data, out.w, out.h), 0, 0)
      const blob = await new Promise<Blob | null>((res) =>
        cv.toBlob(res, type, type === 'image/jpeg' ? 0.92 : undefined))
      if (!blob) { flash('Export failed.'); return }
      const base = image.name.replace(/\.[^.]+$/, '') || 'photo'
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${base}-edited.${type === 'image/png' ? 'png' : 'jpg'}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
      flash(`Exported ${out.w}×${out.h}`)
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }, [image, layers, flash])

  const exportRecipe = useCallback(() => {
    const json = JSON.stringify({ app: 'aiphoto', version: 1, layers }, null, 2)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    a.download = 'colour-recipe.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }, [layers])

  const importRecipe = useCallback(async (file: File) => {
    try {
      const data = JSON.parse(await file.text())
      if (!Array.isArray(data?.layers)) throw new Error('Not a recipe file.')
      loadRecipe(data.layers as Layer[])
      flash(`Loaded ${data.layers.length} layers`)
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not read that recipe.')
    }
  }, [loadRecipe, flash])

  // --- keyboard -----------------------------------------------------------
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPicking(null); setPainting(false); return }
      if (isTyping(e.target)) return
      if (e.key === 'Tab') { e.preventDefault(); toggleChrome(); return }
      if (painting) {
        if (e.key === '[') { setBrush({ size: Math.max(0.01, brush.size / 1.2) }); return }
        if (e.key === ']') { setBrush({ size: Math.min(1, brush.size * 1.2) }); return }
      }
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
        return
      }
      if (mod) return
      switch (e.key) {
        case '\\': setCompare(compare === 1 ? 0 : 1); break
        case 'x': if (!e.repeat) setCompare(2); break
        case '0': zoomToFit(); break
        case '1': setZoom(1); break
        case '=': case '+': setZoom(zoom * 1.25); break
        case '-': setZoom(zoom / 1.25); break
        case 'h': toggleHistogram(); break
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'x' && !isTyping(e.target)) setCompare(0)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [compare, zoom, setCompare, setZoom, zoomToFit, toggleHistogram, undo, redo, setPicking,
      painting, brush.size, setBrush, setPainting, toggleChrome])

  if (glError) {
    return (
      <div className="fatal">
        <h1>WebGL2 is required</h1>
        <p>{glError}</p>
        <p>Try a recent version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.</p>
      </div>
    )
  }

  return (
    <HistogramContext.Provider value={hist}>
      <div className={`app ${chromeHidden ? 'chrome-hidden' : ''}`}>
        <header className="topbar">
          <div className="brand" title="Colour Lab">
            <span className="logo">◐</span>
            <span className="brand-name">Colour Lab</span>
          </div>

          <input ref={fileRef} type="file" accept="image/*" hidden
            onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = '' }} />
          <input ref={recipeRef} type="file" accept="application/json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importRecipe(f); e.target.value = '' }} />

          <div className="topbar-group">
            <button className="btn" onClick={() => fileRef.current?.click()} title="Open image">
              Open
            </button>
            <button className="btn icon" onClick={undo} title="Undo (⌘Z)" aria-label="Undo">↶</button>
            <button className="btn icon" onClick={redo} title="Redo (⇧⌘Z)" aria-label="Redo">↷</button>
            <button
              className={`btn ${compare === 2 ? 'active' : ''}`}
              disabled={!image}
              onPointerDown={(e) => { e.preventDefault(); setCompare(2) }}
              onPointerUp={() => setCompare(0)}
              onPointerCancel={() => setCompare(0)}
              onPointerLeave={() => compare === 2 && setCompare(0)}
              title="Hold to see the original (X)"
            >
              Before
            </button>
          </div>

          <div className="topbar-spacer" />

          <div className="topbar-group">
            <button
              className="btn primary"
              disabled={!image}
              onClick={() => exportImage('image/jpeg')}
              title="Export JPEG"
            >
              Export
            </button>
            <button
              ref={moreBtnRef}
              className={`btn icon ${moreOpen ? 'active' : ''}`}
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              title="More"
              onClick={() => setMoreOpen((v) => !v)}
            >
              ⋯
            </button>
            {moreOpen && moreBtnRef.current && (
              <MoreMenu
                anchor={moreBtnRef.current}
                onClose={() => setMoreOpen(false)}
                onSample={() => { void loadSource(makeSampleImage(), 'sample.png') }}
                onExportPng={() => { void exportImage('image/png') }}
                onImportRecipe={() => recipeRef.current?.click()}
                onExportRecipe={exportRecipe}
              />
            )}
          </div>
        </header>

        <main className="main">
          <Viewer canvasRef={canvasRef} rendererRef={rendererRef} onFiles={onFiles} onApplyFix={applyFix} />

          <aside className="sidebar">
            {showHistogram && (
              <div className="hist-panel">
                <div className="hist-head">
                  <span>Histogram</span>
                  <button className="icon-btn" onClick={toggleHistogram} title="Hide histogram (H)">−</button>
                </div>
                <HistogramView height={84} />
                {image && (
                  <div className="image-info">
                    {image.name} · {image.width}×{image.height}
                  </div>
                )}
              </div>
            )}
            {!showHistogram && (
              <button className="btn wide" onClick={toggleHistogram}>Show histogram</button>
            )}
            {segError && (
              // The model is fetched on demand, so this is usually "you are
              // offline" — say so rather than leaving the mask mysteriously empty.
              <p className="hint warn">Could not load the subject finder: {segError}</p>
            )}
            <SegmentContext.Provider value={segStatus}>
              <LayerStack onFix={applyFix} thumbs={thumbs} />
            </SegmentContext.Provider>
          </aside>
        </main>

        {contextLost && (
          <div className="busy">Graphics context lost — restoring your edits…</div>
        )}
        {busy && !contextLost && <div className="busy">{busy}</div>}
        {toast && <div className="toast">{toast}</div>}
        {chromeHidden && <div className="chrome-hint">Tab to bring the panels back</div>}
      </div>
    </HistogramContext.Provider>
  )
}
