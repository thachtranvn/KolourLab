import { createContext, useContext } from 'react'
import { useStore } from '../state/store'
import { Slider, Toggle, Select, Segmented, ColorField, Section, HistogramView } from './controls'
import {
  MASK_META, SEGMENTED_MASKS, isSegmentedMask, needsFaceRegions,
  type Layer, type Mask, type MaskKind, type SegmentedMaskKind,
} from '../state/types'
import { peekSegmentation, isSegmenting, isSegmentingFaces, type SegmentClass } from '../engine/segment'

const KIND_OPTIONS = (Object.keys(MASK_META) as MaskKind[]).map((k) => ({
  value: k, label: MASK_META[k].label,
}))

/**
 * Progress of the segmentation passes, published by App.
 *
 * The segment module keeps its state in module scope, which React cannot
 * subscribe to — reading it directly meant the panel only refreshed when
 * something else happened to re-render it, so "Looking for people…" usually
 * never appeared and a failure left the panel showing the wrong thing entirely.
 */
export const SegmentContext = createContext<{ epoch: number; error: string | null }>({
  epoch: 0, error: null,
})

/**
 * How much of the frame this mask actually claims.
 *
 * Without it, a mask that found nobody is indistinguishable from one that is
 * simply subtle — both just look like an adjustment that did nothing.
 */
function SegmentStatus({ kind }: { kind: SegmentedMaskKind }) {
  const image = useStore((s) => s.image)
  const { error } = useContext(SegmentContext)   // re-renders as the passes progress
  if (!image) return null
  if (error) return <p className="hint warn">Could not run the subject finder.</p>
  if (isSegmenting(image.preview)) return <p className="hint">Looking for people…</p>
  if (isSegmentingFaces(image.preview)) return <p className="hint">Finding facial features…</p>

  const seg = peekSegmentation(image.preview)
  if (!seg) return <p className="hint">Runs once per photo, on first use.</p>
  // a face-region mask is still empty until the landmark pass has painted it
  if (needsFaceRegions(kind) && !seg.faceRegions) {
    return <p className="hint">Runs once per photo, on first use.</p>
  }

  const pct = SEGMENTED_MASKS[kind]
    .reduce((sum, c) => sum + (seg.coverage[c as SegmentClass] ?? 0), 0) * 100
  return (
    <p className="hint">
      {pct < 0.5
        ? `No ${MASK_META[kind].label.toLowerCase()} found in this photo.`
        : `Covers ${pct.toFixed(0)}% of the frame.`}
    </p>
  )
}

function BrushControls({ layer }: { layer: Layer }) {
  const brush = useStore((s) => s.brush)
  const setBrush = useStore((s) => s.setBrush)
  const painting = useStore((s) => s.painting)
  const setPainting = useStore((s) => s.setPainting)
  const setMaskView = useStore((s) => s.setMaskView)
  const updateMask = useStore((s) => s.updateMask)
  const pushHistory = useStore((s) => s.pushHistory)
  const strokes = layer.mask.strokes

  return (
    <>
      {strokes.length === 0 && (
        <p className="callout">
          This adjustment is hidden everywhere. Drag on the photo to paint it in.
        </p>
      )}

      <button
        className={`btn wide ${painting ? 'primary' : ''}`}
        onClick={() => {
          const next = !painting
          setPainting(next)
          if (next) setMaskView(1)
        }}
      >
        {painting ? '● Painting — click to stop' : '✎ Start painting'}
      </button>

      <Segmented
        value={brush.erase ? 'erase' : 'add'}
        onChange={(m) => setBrush({ erase: m === 'erase' })}
        options={[{ value: 'add', label: 'Reveal' }, { value: 'erase', label: 'Hide' }]}
      />
      <Slider label="Size" value={Math.round(brush.size * 100)} min={1} max={100} suffix="%" neutral={12}
        onChange={(v) => setBrush({ size: v / 100 })} />
      <Slider label="Hardness" value={Math.round(brush.hardness * 100)} min={0} max={100} suffix="%" neutral={50}
        onChange={(v) => setBrush({ hardness: v / 100 })} />
      <Slider label="Flow" value={Math.round(brush.flow * 100)} min={1} max={100} suffix="%" neutral={100}
        onChange={(v) => setBrush({ flow: v / 100 })} />

      <div className="row-between">
        <span className="hint">{strokes.length} stroke{strokes.length === 1 ? '' : 's'}</span>
        <button className="btn small" disabled={!strokes.length}
          onClick={() => { pushHistory(); updateMask(layer.id, { strokes: [] }) }}>
          Clear strokes
        </button>
      </div>
      <p className="hint">
        Reveal paints the adjustment in, Hide takes it away. Each stroke is stored
        separately, so ⌘Z steps back one stroke at a time. Hold ⌥ to temporarily
        invert the brush; <kbd>[</kbd> and <kbd>]</kbd> resize it.
      </p>
    </>
  )
}

export function MaskPanel({ layer }: { layer: Layer }) {
  const updateMask = useStore((s) => s.updateMask)
  const resetMask = useStore((s) => s.resetMask)
  const pushHistory = useStore((s) => s.pushHistory)
  const maskView = useStore((s) => s.maskView)
  const setMaskView = useStore((s) => s.setMaskView)
  const setPainting = useStore((s) => s.setPainting)
  const m = layer.mask
  const set = (patch: Partial<Mask>) => updateMask(layer.id, patch)
  const active = m.kind !== 'none'

  const typeSelect = (
    <Select
      label="Mask"
      value={m.kind}
      options={KIND_OPTIONS}
      onChange={(k) => {
        pushHistory()
        set({ kind: k })
        setMaskView(k === 'none' ? 0 : 1)
        // choosing Brush means you want to paint — don't make it a second click
        setPainting(k === 'brush')
      }}
    />
  )

  // With no mask there is nothing to configure, so it stays a single row
  // rather than a section header plus a control plus an explanation.
  if (!active) return <div className="props-mask-row">{typeSelect}</div>

  return (
    <Section
      title="Mask"
      right={
        <button className="btn small" onClick={() => { setPainting(false); resetMask(layer.id) }}>Remove</button>
      }
    >
      {typeSelect}
      <p className="hint">{MASK_META[m.kind].hint}</p>

      {active && (
        <>
          <Segmented
            value={String(maskView) as '0' | '1' | '2'}
            onChange={(v) => setMaskView(Number(v) as 0 | 1 | 2)}
            options={[
              { value: '0', label: 'Hide' },
              { value: '1', label: 'Overlay' },
              { value: '2', label: 'Mask' },
            ]}
          />

          {m.kind === 'linear' && (
            <>
              <Slider label="Angle" value={m.angle} min={-180} max={180} suffix="°" neutral={90}
                onChange={(v) => set({ angle: v })} />
              <Slider label="Position X" value={Math.round(m.center[0] * 100)} min={0} max={100} suffix="%" neutral={50}
                onChange={(v) => set({ center: [v / 100, m.center[1]] })} />
              <Slider label="Position Y" value={Math.round(m.center[1] * 100)} min={0} max={100} suffix="%" neutral={50}
                onChange={(v) => set({ center: [m.center[0], v / 100] })} />
              <Slider label="Transition" value={m.size} min={1} max={200} suffix="%" neutral={50}
                onChange={(v) => set({ size: v })} />
            </>
          )}

          {m.kind === 'radial' && (
            <>
              <Slider label="Position X" value={Math.round(m.center[0] * 100)} min={0} max={100} suffix="%" neutral={50}
                onChange={(v) => set({ center: [v / 100, m.center[1]] })} />
              <Slider label="Position Y" value={Math.round(m.center[1] * 100)} min={0} max={100} suffix="%" neutral={50}
                onChange={(v) => set({ center: [m.center[0], v / 100] })} />
              <Slider label="Radius" value={m.size} min={1} max={200} suffix="%" neutral={50}
                onChange={(v) => set({ size: v })} />
              <Slider label="Aspect" value={m.aspect} min={10} max={400} suffix="%" neutral={100}
                onChange={(v) => set({ aspect: v })} />
              <Slider label="Angle" value={m.angle} min={-180} max={180} suffix="°" neutral={0}
                onChange={(v) => set({ angle: v })} />
            </>
          )}

          {m.kind === 'luminance' && (
            <>
              <HistogramView height={70} channel="luma" />
              <Slider label="From" value={m.lo} min={0} max={255} neutral={0}
                onChange={(v) => set({ lo: Math.min(v, m.hi - 1) })} />
              <Slider label="To" value={m.hi} min={0} max={255} neutral={255}
                onChange={(v) => set({ hi: Math.max(v, m.lo + 1) })} />
              <p className="hint">
                Shadows ≈ 0–100, midtones ≈ 60–190, highlights ≈ 160–255. Raise
                Feather to blend the edges of the range.
              </p>
            </>
          )}

          {m.kind === 'colorRange' && (
            <>
              <ColorField label="Target colour" value={m.target} eyedropper
                onChange={(c) => set({ target: c })} />
              <Slider label="Fuzziness" value={m.fuzziness} min={0} max={200} neutral={60}
                onChange={(v) => set({ fuzziness: v })} />
            </>
          )}

          {isSegmentedMask(m.kind) && <SegmentStatus kind={m.kind} />}

          {m.kind === 'brush' && <BrushControls layer={layer} />}

          <Slider label="Feather" value={m.feather} min={0} max={100} suffix="%" neutral={0}
            onChange={(v) => set({ feather: v })} />
          <Slider label="Density" value={m.density} min={0} max={100} suffix="%" neutral={100}
            onChange={(v) => set({ density: v })} />
          <Toggle label="Invert mask" checked={m.invert} onChange={(v) => set({ invert: v })} />
        </>
      )}
    </Section>
  )
}
