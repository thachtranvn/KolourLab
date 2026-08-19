import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../state/store'
import { ADJUSTMENT_META, BLEND_MODES, MASK_META, type AdjustmentKind, type BlendMode } from '../state/types'
import { LOOK_PRESETS } from '../engine/presets'
import { FIXES } from '../engine/fixes'
import { AdjustmentPanel } from './panels'
import { MaskPanel } from './MaskPanel'
import { Slider } from './controls'

const GROUP_ORDER = ['Light & Contrast', 'Colour & Hue', 'Advanced'] as const

const blendLabel = (b: BlendMode) =>
  b.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

/**
 * The tool picker. Rendered in a portal and positioned against the viewport,
 * not the sidebar — anchoring it inside a scrolling container used to push it
 * off-screen, taking the last few tools with it.
 */
function AddMenu({ anchor, onClose, onFix }: { anchor: HTMLElement; onClose: () => void; onFix: (id: string) => void }) {
  const addLayer = useStore((s) => s.addLayer)
  const applyLook = useStore((s) => s.applyLook)
  const hasImage = useStore((s) => s.image !== null)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const [tab, setTab] = useState<'fixes' | 'tools' | 'looks'>('tools')
  const kinds = Object.keys(ADJUSTMENT_META) as AdjustmentKind[]
  const suggestions = useStore((s) => s.suggestions)
  const confidenceOf = (id: string) => suggestions.find((s) => s.id === id)?.confidence ?? 0

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.getBoundingClientRect()
      const width = 300
      const margin = 10
      const below = window.innerHeight - a.bottom - margin
      const above = a.top - margin
      // open downward when there is room, otherwise flip up
      const openDown = below >= 260 || below >= above
      setPos({
        left: Math.max(margin, Math.min(a.right - width, window.innerWidth - width - margin)),
        top: openDown ? a.bottom + 6 : Math.max(margin, a.top - 6 - Math.min(above, 520)),
        maxHeight: Math.max(200, Math.min(520, openDown ? below : above)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  // close on outside click or Escape — never on mouse-leave, which made the
  // menu impossible to scroll
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
    <div
      className="add-menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
    >
      <div className="add-tabs">
        <button className={tab === 'fixes' ? 'active' : ''} onClick={() => setTab('fixes')}>
          Fixes{suggestions.some((s) => s.confidence >= 0.6) ? ' ●' : ''}
        </button>
        <button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>Adjustments</button>
        <button className={tab === 'looks' ? 'active' : ''} onClick={() => setTab('looks')}>Looks</button>
      </div>

      <div className="add-scroll">
        {tab === 'fixes' && (
          <div className="add-group">
            {FIXES.map((f) => {
              const c = confidenceOf(f.id)
              return (
                <button key={f.id} disabled={!hasImage} onClick={() => { onFix(f.id); onClose() }}>
                  <span className="add-name">
                    {f.name}
                    {c > 0 && <span className="confidence">{Math.round(c * 100)}% match</span>}
                  </span>
                  <span className="add-hint">
                    {suggestions.find((s) => s.id === f.id)?.explanation ?? f.description}
                  </span>
                </button>
              )
            })}
            <p className="hint">
              A fix measures the photo and configures itself, so the same one works
              on any image — unlike a look, which stores fixed values.
            </p>
          </div>
        )}

        {tab === 'tools' && GROUP_ORDER.map((group) => (
          <div key={group} className="add-group">
            <div className="add-group-title">{group}</div>
            {kinds.filter((k) => ADJUSTMENT_META[k].group === group).map((k) => (
              <button key={k} onClick={() => { addLayer(k); onClose() }}>
                <span className="add-name">{ADJUSTMENT_META[k].label}</span>
                <span className="add-hint">{ADJUSTMENT_META[k].hint}</span>
              </button>
            ))}
          </div>
        ))}

        {tab === 'looks' && (
          <div className="add-group">
            {LOOK_PRESETS.map((l) => (
              <button key={l.name} disabled={!hasImage} onClick={() => { applyLook(l.build()); onClose() }}>
                <span className="add-name">{l.name}</span>
                <span className="add-hint">{l.description}</span>
              </button>
            ))}
            <p className="hint">Looks add a ready-made stack of layers you can then tweak or delete.</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * The photo as of this layer, rendered by the same pipeline. Hovering hides
 * that one layer in the preview so you can see exactly what it contributes.
 */
function LayerThumb({ data, layerId }: { data?: ImageData; layerId: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const setPeek = useStore((s) => s.setPeek)
  const peek = useStore((s) => s.peek)

  useEffect(() => {
    const cv = ref.current
    if (!cv || !data) return
    if (cv.width !== data.width || cv.height !== data.height) {
      cv.width = data.width
      cv.height = data.height
    }
    cv.getContext('2d')?.putImageData(data, 0, 0)
  }, [data])

  return (
    <span
      className={`layer-thumb ${peek === layerId ? 'peeking' : ''}`}
      title="Hover to see the photo without this layer"
      onMouseEnter={() => setPeek(layerId)}
      onMouseLeave={() => setPeek(null)}
      onClick={(e) => e.stopPropagation()}
    >
      <canvas ref={ref} />
    </span>
  )
}

export function LayerStack({ onFix, thumbs }: { onFix: (id: string) => void; thumbs: ImageData[] }) {
  const layers = useStore((s) => s.layers)
  const selectedId = useStore((s) => s.selectedId)
  const selectLayer = useStore((s) => s.selectLayer)
  const setLayerProp = useStore((s) => s.setLayerProp)
  const removeLayer = useStore((s) => s.removeLayer)
  const duplicateLayer = useStore((s) => s.duplicateLayer)
  const moveLayer = useStore((s) => s.moveLayer)
  const resetLayer = useStore((s) => s.resetLayer)
  const clearLayers = useStore((s) => s.clearLayers)
  const pushHistory = useStore((s) => s.pushHistory)
  const hasImage = useStore((s) => s.image !== null)
  const [menuOpen, setMenuOpen] = useState(false)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const selectedRowRef = useRef<HTMLDivElement>(null)

  const selected = layers.find((l) => l.id === selectedId) ?? null

  // the list is height-capped, so keep the selected row in view
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])
  // topmost layer renders last, so show the stack in reverse
  const display = [...layers].reverse()

  return (
    <div className="stack-panel">
      <div className="stack-head">
        <span>Layers{layers.length > 0 && ` · ${layers.length}`}</span>
        <div className="stack-head-actions">
          <button className="btn small" disabled={!layers.length} onClick={clearLayers}>Clear</button>
          <button
            ref={addBtnRef}
            className="btn small primary"
            disabled={!hasImage}
            onClick={() => setMenuOpen((v) => !v)}
          >
            + Add
          </button>
          {menuOpen && addBtnRef.current && (
            <AddMenu anchor={addBtnRef.current} onClose={() => setMenuOpen(false)} onFix={onFix} />
          )}
        </div>
      </div>

      <div className="layer-list">
        {display.length === 0 && (
          <p className="empty-note">
            No adjustments yet. Use <strong>+ Add</strong> for a single tool, or
            the Looks tab to start from a ready-made stack.
          </p>
        )}
        {display.map((l, row) => (
          <div
            key={l.id}
            ref={l.id === selectedId ? selectedRowRef : undefined}
            className={`layer ${l.id === selectedId ? 'sel' : ''} ${l.enabled ? '' : 'off'}`}
            onClick={() => selectLayer(l.id)}
          >
            <button
              className="eye"
              title={l.enabled ? 'Hide this adjustment' : 'Show this adjustment'}
              onClick={(e) => { e.stopPropagation(); pushHistory(); setLayerProp(l.id, { enabled: !l.enabled }) }}
            >
              {l.enabled ? '●' : '○'}
            </button>
            <LayerThumb layerId={l.id} data={thumbs[layers.length - 1 - row]} />
            <div className="layer-main">
              <input
                className="layer-name"
                value={l.name}
                onFocus={pushHistory}
                onChange={(e) => setLayerProp(l.id, { name: e.target.value })}
                onClick={(e) => e.stopPropagation()}
              />
              <span className="layer-meta">
                {ADJUSTMENT_META[l.kind].label}
                {l.blend !== 'normal' && ` · ${blendLabel(l.blend)}`}
                {l.opacity !== 100 && ` · ${l.opacity}%`}
                {l.mask.kind !== 'none' && (
                  <span className="mask-badge" title={MASK_META[l.mask.kind].label}>
                    ◑ {l.mask.kind === 'brush' ? `${l.mask.strokes.length}` : MASK_META[l.mask.kind].label.split(' ')[0]}
                  </span>
                )}
              </span>
            </div>
            <div className="layer-actions">
              <button title="Move up" onClick={(e) => { e.stopPropagation(); moveLayer(l.id, 1) }}>↑</button>
              <button title="Move down" onClick={(e) => { e.stopPropagation(); moveLayer(l.id, -1) }}>↓</button>
              <button title="Duplicate" onClick={(e) => { e.stopPropagation(); duplicateLayer(l.id) }}>⧉</button>
              <button title="Delete" onClick={(e) => { e.stopPropagation(); removeLayer(l.id) }}>✕</button>
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <div className="props" key={selected.id}>
          {/* Blend and opacity are per-layer plumbing, not the point of the
              panel — one dense row instead of a section with two full rows,
              so the adjustment's own controls start near the top. */}
          <div className="props-head">
            <span>{ADJUSTMENT_META[selected.kind].label}</span>
            <div className="props-head-meta">
              <select
                value={selected.blend}
                title="Blend mode"
                onChange={(e) => {
                  pushHistory()
                  setLayerProp(selected.id, { blend: e.target.value as BlendMode })
                }}
              >
                {BLEND_MODES.map((b) => <option key={b} value={b}>{blendLabel(b)}</option>)}
              </select>
              <button className="btn small" onClick={() => resetLayer(selected.id)}>Reset</button>
            </div>
          </div>
          <div className="props-opacity">
            <Slider
              compact
              label="Opacity"
              value={selected.opacity}
              min={0}
              max={100}
              neutral={100}
              onChange={(v) => setLayerProp(selected.id, { opacity: v })}
            />
          </div>
          <MaskPanel layer={selected} />
          <AdjustmentPanel layer={selected} />
        </div>
      )}

      {!selected && layers.length > 0 && (
        <p className="empty-note">Select a layer to edit its settings.</p>
      )}
    </div>
  )
}
