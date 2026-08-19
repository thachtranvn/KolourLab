import { useRef, useState } from 'react'
import { useStore } from '../state/store'
import {
  Slider, Toggle, Select, Segmented, ColorField, HistogramView,
  CurveEditor, GradientEditor, useHistogram,
} from './controls'
import {
  PHOTO_FILTERS, GRADIENT_PRESETS, CHANNEL_MIXER_PRESETS, CURVE_PRESETS,
  LUT_PRESET_NAMES, registerCustomCube, listCustomCubes,
} from '../engine/presets'
import { parseCube, clamp } from '../engine/lut'
import { WB_GAIN } from '../engine/glsl'
import { colourlab } from '../api'
import type {
  Layer, CurvePoints, BrightnessContrastParams, LevelsParams, LevelsChannel, CurvesParams,
  ExposureParams, VibranceParams, HueSaturationParams, HueRangeKey,
  ColorBalanceParams, ToneRange, SelectiveColorParams, SelectiveColorKey, CMYK,
  ReplaceColorParams, BlackWhiteParams, ChannelMixerParams, PhotoFilterParams,
  GradientMapParams, ColorLookupParams, SolidColorParams, WhiteBalanceParams,
} from '../state/types'

function usePatch(id: string) {
  const update = useStore((s) => s.updateParams)
  return (patch: object) => update(id, patch)
}

// ---------------------------------------------------------------------------

function BrightnessContrastPanel({ layer }: { layer: Layer }) {
  const p = layer.params as BrightnessContrastParams
  const patch = usePatch(layer.id)
  return (
    <>
      <Slider label="Brightness" value={p.brightness} min={-150} max={150}
        onChange={(v) => patch({ brightness: v })} />
      <Slider label="Contrast" value={p.contrast} min={-50} max={100}
        onChange={(v) => patch({ contrast: v })} />
      <Toggle label="Use Legacy (linear) algorithm" checked={p.legacy}
        onChange={(v) => patch({ legacy: v })} />
      <p className="hint">
        The default algorithm protects highlights and shadows; Legacy shifts every
        tone equally and clips much sooner.
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------

function LevelsPanel({ layer }: { layer: Layer }) {
  const p = layer.params as LevelsParams
  const patch = usePatch(layer.id)
  const pushHistory = useStore((s) => s.pushHistory)
  const hist = useHistogram()
  const [ch, setCh] = useState<'rgb' | 'r' | 'g' | 'b'>('rgb')
  const c = p[ch]

  const set = (v: Partial<LevelsChannel>) => patch({ [ch]: { ...c, ...v } })

  const auto = () => {
    if (!hist) return
    const data = ch === 'rgb' ? hist.luma : ch === 'r' ? hist.r : ch === 'g' ? hist.g : hist.b
    const total = data.reduce((a, b) => a + b, 0)
    const clip = total * 0.001
    let acc = 0, lo = 0, hi = 255
    for (let i = 0; i < 256; i++) { acc += data[i]; if (acc > clip) { lo = i; break } }
    acc = 0
    for (let i = 255; i >= 0; i--) { acc += data[i]; if (acc > clip) { hi = i; break } }
    pushHistory()
    set({ inBlack: lo, inWhite: Math.max(lo + 1, hi) })
  }

  return (
    <>
      <Segmented value={ch} onChange={setCh} options={[
        { value: 'rgb', label: 'RGB' }, { value: 'r', label: 'Red' },
        { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' },
      ]} />
      <HistogramView channel={ch === 'rgb' ? 'all' : ch} height={96} />
      <div className="sub-label">Input Levels</div>
      <Slider label="Black point" value={c.inBlack} min={0} max={254} neutral={0}
        onChange={(v) => set({ inBlack: Math.min(v, c.inWhite - 1) })} />
      <Slider label="Gamma (midtones)" value={c.gamma} min={0.1} max={9.99} step={0.01} neutral={1}
        onChange={(v) => set({ gamma: v })} />
      <Slider label="White point" value={c.inWhite} min={1} max={255} neutral={255}
        onChange={(v) => set({ inWhite: Math.max(v, c.inBlack + 1) })} />
      <div className="sub-label">Output Levels</div>
      <Slider label="Output black" value={c.outBlack} min={0} max={255} neutral={0}
        onChange={(v) => set({ outBlack: v })} />
      <Slider label="Output white" value={c.outWhite} min={0} max={255} neutral={255}
        onChange={(v) => set({ outWhite: v })} />
      <button className="btn" onClick={auto}>Auto (clip 0.1%)</button>
    </>
  )
}

// ---------------------------------------------------------------------------

type DropperKind = 'black' | 'grey' | 'white'

const DROPPERS: { kind: DropperKind; label: string; hint: string }[] = [
  { kind: 'black', label: 'Black', hint: 'Click something that should be pure black' },
  { kind: 'grey', label: 'Grey', hint: 'Click something that should be neutral grey' },
  { kind: 'white', label: 'White', hint: 'Click something that should be pure white' },
]

/** Move a channel's end point, or place a midpoint, without crossing neighbours. */
function withPoint(curve: CurvePoints, x: number, y: number, where: 'first' | 'last' | 'mid'): CurvePoints {
  const pts = [...curve].sort((a, b) => a.x - b.x)
  if (where === 'first') {
    const hi = pts.length > 1 ? pts[1].x - 0.004 : 1
    return [{ x: clamp(x, 0, Math.max(hi, 0)), y }, ...pts.slice(1)]
  }
  if (where === 'last') {
    const lo = pts.length > 1 ? pts[pts.length - 2].x + 0.004 : 0
    return [...pts.slice(0, -1), { x: clamp(x, Math.min(lo, 1), 1), y }]
  }
  // a midpoint replaces any existing point close to the same input
  const kept = pts.filter((q, i) => i === 0 || i === pts.length - 1 || Math.abs(q.x - x) > 0.02)
  const lo = kept[0].x + 0.004
  const hi = kept[kept.length - 1].x - 0.004
  if (lo >= hi) return pts
  return [...kept, { x: clamp(x, lo, hi), y: clamp(y, 0, 1) }].sort((a, b) => a.x - b.x)
}

function CurvesPanel({ layer }: { layer: Layer }) {
  const p = layer.params as CurvesParams
  const patch = usePatch(layer.id)
  const pushHistory = useStore((s) => s.pushHistory)
  const picking = useStore((s) => s.picking)
  const setPicking = useStore((s) => s.setPicking)
  const setPainting = useStore((s) => s.setPainting)
  const [ch, setCh] = useState<'rgb' | 'r' | 'g' | 'b'>('rgb')
  // Ownership is by identity: the store holds one picker callback, so this
  // control is armed only while *its own* callback is the live one. A plain
  // flag made every other eyedropper on screen look like this one, and
  // pressing the button then cancelled someone else's pick.
  const mineRef = useRef<((rgb: [number, number, number], uv: [number, number]) => void) | null>(null)
  const armedRef = useRef<DropperKind | null>(null)
  const armed = picking && picking === mineRef.current ? armedRef.current : null

  const armDropper = (kind: DropperKind) => {
    if (armed === kind) { setPicking(null); return }
    // Viewer tests painting before picking, so a brush-masked layer would keep
    // painting instead of sampling.
    setPainting(false)
    armedRef.current = kind
    const mine = (_rgb: [number, number, number], uv: [number, number]) => {
      // Disarm no matter what: sampleLayerInput throws if the layer is gone or
      // the GL context is lost, and leaving the picker armed strands the whole
      // viewer in eyedropper mode.
      let s: [number, number, number] | null = null
      try {
        // Sample what this layer receives, not the finished render — otherwise
        // the curve's own effect is folded back into its own correction.
        s = colourlab.sampleLayerInput(layer.id, uv[0], uv[1])
      } catch (err) {
        // The layer went away, or the context did. There is nothing left to
        // correct, and rethrowing here escapes into React's event handler.
        console.warn('Eyedropper could not sample:', err)
      } finally {
        setPicking(null)
      }
      if (!s) return
      pushHistory()
      const target = (s[0] + s[1] + s[2]) / 3
      const next: Partial<CurvesParams> = {}
      ;(['r', 'g', 'b'] as const).forEach((c, i) => {
        const v = s[i]
        if (kind === 'black') next[c] = withPoint(p[c], v, 0, 'first')
        else if (kind === 'white') next[c] = withPoint(p[c], v, 1, 'last')
        else next[c] = withPoint(p[c], v, target, 'mid')
      })
      patch(next)
    }
    mineRef.current = mine
    setPicking(mine)
  }

  return (
    <>
      <Segmented value={ch} onChange={setCh} options={[
        { value: 'rgb', label: 'RGB' }, { value: 'r', label: 'Red' },
        { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' },
      ]} />

      <div className="dropper-row">
        {DROPPERS.map((d) => (
          <button
            key={d.kind}
            className={`btn small ${armed === d.kind ? 'primary' : ''}`}
            title={d.hint}
            onClick={() => armDropper(d.kind)}
          >
            ⌖ {d.label}
          </button>
        ))}
      </div>
      <CurveEditor channel={ch} points={p[ch]} onChange={(pts) => patch({ [ch]: pts })} />
      <Select
        label="Preset"
        value=""
        options={[{ value: '', label: 'Apply a preset…' },
          ...CURVE_PRESETS.map((c) => ({ value: c.name, label: c.name }))]}
        onChange={(name) => {
          const preset = CURVE_PRESETS.find((c) => c.name === name)
          if (preset) patch({ [ch]: preset.points.map((pt) => ({ ...pt })) })
        }}
      />
      <button className="btn" onClick={() => { pushHistory(); patch({ [ch]: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }) }}>
        Reset {ch.toUpperCase()} channel
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------

function ExposurePanel({ layer }: { layer: Layer }) {
  const p = layer.params as ExposureParams
  const patch = usePatch(layer.id)
  return (
    <>
      <Slider label="Exposure" value={p.exposure} min={-5} max={5} step={0.01} suffix="stops"
        onChange={(v) => patch({ exposure: v })} />
      <Slider label="Offset" value={p.offset} min={-0.5} max={0.5} step={0.001}
        onChange={(v) => patch({ offset: v })} />
      <Slider label="Gamma Correction" value={p.gamma} min={0.1} max={9.99} step={0.01} neutral={1}
        onChange={(v) => patch({ gamma: v })} />
      <p className="hint">Exposure scales linear light; Offset lifts or crushes shadows.</p>
    </>
  )
}

// ---------------------------------------------------------------------------

function VibrancePanel({ layer }: { layer: Layer }) {
  const p = layer.params as VibranceParams
  const patch = usePatch(layer.id)
  return (
    <>
      <Slider label="Vibrance" value={p.vibrance} min={-100} max={100}
        onChange={(v) => patch({ vibrance: v })} />
      <Slider label="Saturation" value={p.saturation} min={-100} max={100}
        onChange={(v) => patch({ saturation: v })} />
      <p className="hint">Vibrance pushes muted colours harder and eases off around skin tones.</p>
    </>
  )
}

// ---------------------------------------------------------------------------

const HUE_RANGES: { value: HueRangeKey; label: string }[] = [
  { value: 'master', label: 'Master' }, { value: 'reds', label: 'Reds' },
  { value: 'yellows', label: 'Yellows' }, { value: 'greens', label: 'Greens' },
  { value: 'cyans', label: 'Cyans' }, { value: 'blues', label: 'Blues' },
  { value: 'magentas', label: 'Magentas' },
]

function HueSaturationPanel({ layer }: { layer: Layer }) {
  const p = layer.params as HueSaturationParams
  const patch = usePatch(layer.id)
  const [range, setRange] = useState<HueRangeKey>('master')
  const band = p.bands[range]
  const set = (v: Partial<typeof band>) => patch({ bands: { ...p.bands, [range]: { ...band, ...v } } })

  const hueRamp = '#ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000'

  return (
    <>
      <Select label="Range" value={range} options={HUE_RANGES} onChange={setRange} />
      {p.colorize ? (
        <>
          <Slider label="Hue" value={p.colorizeHue} min={0} max={360} neutral={0}
            accent={hueRamp} onChange={(v) => patch({ colorizeHue: v })} />
          <Slider label="Saturation" value={p.colorizeSaturation} min={0} max={100} neutral={25}
            onChange={(v) => patch({ colorizeSaturation: v })} />
          <Slider label="Lightness" value={p.colorizeLightness} min={-100} max={100}
            onChange={(v) => patch({ colorizeLightness: v })} />
        </>
      ) : (
        <>
          <Slider label="Hue" value={band.hue} min={-180} max={180} accent={hueRamp}
            onChange={(v) => set({ hue: v })} />
          <Slider label="Saturation" value={band.saturation} min={-100} max={100}
            onChange={(v) => set({ saturation: v })} />
          <Slider label="Lightness" value={band.lightness} min={-100} max={100}
            onChange={(v) => set({ lightness: v })} />
        </>
      )}
      <Toggle label="Colorize (force a single hue)" checked={p.colorize}
        onChange={(v) => patch({ colorize: v })} />
      {!p.colorize && range !== 'master' && (
        <p className="hint">
          Edits are strongest within 30° of the {range.slice(0, -1)} hue and fade out by 60°.
        </p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

const TONE_RANGES: { value: ToneRange; label: string }[] = [
  { value: 'shadows', label: 'Shadows' },
  { value: 'midtones', label: 'Midtones' },
  { value: 'highlights', label: 'Highlights' },
]

function ColorBalancePanel({ layer }: { layer: Layer }) {
  const p = layer.params as ColorBalanceParams
  const patch = usePatch(layer.id)
  const [tone, setTone] = useState<ToneRange>('midtones')
  const v = p[tone]
  const set = (i: number, val: number) => {
    const next = [...v] as [number, number, number]
    next[i] = val
    patch({ [tone]: next })
  }
  return (
    <>
      <Segmented value={tone} onChange={setTone} options={TONE_RANGES} />
      <Slider label="Cyan → Red" value={v[0]} min={-100} max={100}
        accent="#22d3ee, #7b7b7b, #ef4444" onChange={(x) => set(0, x)} />
      <Slider label="Magenta → Green" value={v[1]} min={-100} max={100}
        accent="#e879f9, #7b7b7b, #4ade80" onChange={(x) => set(1, x)} />
      <Slider label="Yellow → Blue" value={v[2]} min={-100} max={100}
        accent="#facc15, #7b7b7b, #60a5fa" onChange={(x) => set(2, x)} />
      <Toggle label="Preserve Luminosity" checked={p.preserveLuminosity}
        onChange={(x) => patch({ preserveLuminosity: x })} />
    </>
  )
}

// ---------------------------------------------------------------------------

const SC_KEYS: { value: SelectiveColorKey; label: string }[] = [
  { value: 'reds', label: 'Reds' }, { value: 'yellows', label: 'Yellows' },
  { value: 'greens', label: 'Greens' }, { value: 'cyans', label: 'Cyans' },
  { value: 'blues', label: 'Blues' }, { value: 'magentas', label: 'Magentas' },
  { value: 'whites', label: 'Whites' }, { value: 'neutrals', label: 'Neutrals' },
  { value: 'blacks', label: 'Blacks' },
]

function SelectiveColorPanel({ layer }: { layer: Layer }) {
  const p = layer.params as SelectiveColorParams
  const patch = usePatch(layer.id)
  const [key, setKey] = useState<SelectiveColorKey>('reds')
  const v = p.colors[key]
  const set = (i: number, val: number) => {
    const next = [...v] as CMYK
    next[i] = val
    patch({ colors: { ...p.colors, [key]: next } })
  }
  const touched = SC_KEYS.filter((k) => p.colors[k.value].some((x) => x !== 0)).map((k) => k.value)

  return (
    <>
      <Select label="Colors" value={key} options={SC_KEYS} onChange={setKey} />
      <Slider label="Cyan" value={v[0]} min={-100} max={100} suffix="%"
        accent="#f87171, #7b7b7b, #22d3ee" onChange={(x) => set(0, x)} />
      <Slider label="Magenta" value={v[1]} min={-100} max={100} suffix="%"
        accent="#4ade80, #7b7b7b, #e879f9" onChange={(x) => set(1, x)} />
      <Slider label="Yellow" value={v[2]} min={-100} max={100} suffix="%"
        accent="#60a5fa, #7b7b7b, #facc15" onChange={(x) => set(2, x)} />
      <Slider label="Black" value={v[3]} min={-100} max={100} suffix="%"
        accent="#ffffff, #7b7b7b, #000000" onChange={(x) => set(3, x)} />
      <Segmented value={p.relative ? 'rel' : 'abs'}
        onChange={(m) => patch({ relative: m === 'rel' })}
        options={[{ value: 'rel', label: 'Relative' }, { value: 'abs', label: 'Absolute' }]} />
      <p className="hint">
        Relative changes each colour by a percentage of what is already there — subtle
        and safe. Absolute adds a flat amount and bites much harder.
      </p>
      {touched.length > 0 && (
        <p className="hint">Edited: {touched.join(', ')}</p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

function ReplaceColorPanel({ layer }: { layer: Layer }) {
  const p = layer.params as ReplaceColorParams
  const patch = usePatch(layer.id)
  const hueRamp = '#ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000'
  return (
    <>
      <ColorField label="Target colour" value={p.target} eyedropper
        onChange={(c) => patch({ target: c })} />
      <Slider label="Fuzziness" value={p.fuzziness} min={0} max={200} neutral={40}
        onChange={(v) => patch({ fuzziness: v })} />
      <Toggle label="Show selection mask" checked={p.showMask}
        onChange={(v) => patch({ showMask: v })} />
      <div className="sub-label">Replacement</div>
      <Slider label="Hue" value={p.hue} min={-180} max={180} accent={hueRamp}
        onChange={(v) => patch({ hue: v })} />
      <Slider label="Saturation" value={p.saturation} min={-100} max={100}
        onChange={(v) => patch({ saturation: v })} />
      <Slider label="Lightness" value={p.lightness} min={-100} max={100}
        onChange={(v) => patch({ lightness: v })} />
      <p className="hint">
        Click the ⌖ button, then click the image to sample a colour. Turn on the mask
        to see exactly what fuzziness is selecting.
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------

function BlackWhitePanel({ layer }: { layer: Layer }) {
  const p = layer.params as BlackWhiteParams
  const patch = usePatch(layer.id)
  return (
    <>
      <Slider label="Reds" value={p.reds} min={-200} max={300} suffix="%" neutral={40}
        onChange={(v) => patch({ reds: v })} />
      <Slider label="Yellows" value={p.yellows} min={-200} max={300} suffix="%" neutral={60}
        onChange={(v) => patch({ yellows: v })} />
      <Slider label="Greens" value={p.greens} min={-200} max={300} suffix="%" neutral={40}
        onChange={(v) => patch({ greens: v })} />
      <Slider label="Cyans" value={p.cyans} min={-200} max={300} suffix="%" neutral={60}
        onChange={(v) => patch({ cyans: v })} />
      <Slider label="Blues" value={p.blues} min={-200} max={300} suffix="%" neutral={20}
        onChange={(v) => patch({ blues: v })} />
      <Slider label="Magentas" value={p.magentas} min={-200} max={300} suffix="%" neutral={80}
        onChange={(v) => patch({ magentas: v })} />
      <Toggle label="Tint" checked={p.tint} onChange={(v) => patch({ tint: v })} />
      {p.tint && <ColorField label="Tint colour" value={p.tintColor}
        onChange={(c) => patch({ tintColor: c })} />}
    </>
  )
}

// ---------------------------------------------------------------------------

function ChannelMixerPanel({ layer }: { layer: Layer }) {
  const p = layer.params as ChannelMixerParams
  const patch = usePatch(layer.id)
  const [out, setOut] = useState<'r' | 'g' | 'b'>('r')

  if (p.monochrome) {
    const total = p.gray[0] + p.gray[1] + p.gray[2]
    return (
      <>
        <Toggle label="Monochrome" checked onChange={(v) => patch({ monochrome: v })} />
        <Select label="Preset" value=""
          options={[{ value: '', label: 'Apply a preset…' },
            ...CHANNEL_MIXER_PRESETS.map((x) => ({ value: x.name, label: x.name }))]}
          onChange={(name) => {
            const preset = CHANNEL_MIXER_PRESETS.find((x) => x.name === name)
            if (preset) patch({ gray: [...preset.gray], grayConstant: preset.constant })
          }} />
        {(['Red', 'Green', 'Blue'] as const).map((label, i) => (
          <Slider key={label} label={`${label} source`} value={p.gray[i]} min={-200} max={200} suffix="%"
            onChange={(v) => { const g = [...p.gray] as [number, number, number]; g[i] = v; patch({ gray: g }) }} />
        ))}
        <Slider label="Constant" value={p.grayConstant} min={-200} max={200} suffix="%"
          onChange={(v) => patch({ grayConstant: v })} />
        <p className={`hint ${Math.abs(total - 100) > 5 ? 'warn' : ''}`}>Total: {total}% (100% keeps overall brightness)</p>
      </>
    )
  }

  const row = p[out]
  const total = row[0] + row[1] + row[2]
  const setRow = (i: number, v: number) => {
    const next = [...row] as [number, number, number]
    next[i] = v
    patch({ [out]: next })
  }

  return (
    <>
      <Toggle label="Monochrome" checked={false} onChange={(v) => patch({ monochrome: v })} />
      <Segmented value={out} onChange={setOut} options={[
        { value: 'r', label: 'Output Red' }, { value: 'g', label: 'Output Green' }, { value: 'b', label: 'Output Blue' },
      ]} />
      {(['Red', 'Green', 'Blue'] as const).map((label, i) => (
        <Slider key={label} label={`${label} source`} value={row[i]} min={-200} max={200} suffix="%"
          neutral={(out === 'r' && i === 0) || (out === 'g' && i === 1) || (out === 'b' && i === 2) ? 100 : 0}
          onChange={(v) => setRow(i, v)} />
      ))}
      <Slider label="Constant" value={p.constants[['r', 'g', 'b'].indexOf(out)]} min={-200} max={200} suffix="%"
        onChange={(v) => {
          const c = [...p.constants] as [number, number, number]
          c[['r', 'g', 'b'].indexOf(out)] = v
          patch({ constants: c })
        }} />
      <p className={`hint ${Math.abs(total - 100) > 5 ? 'warn' : ''}`}>Total: {total}%</p>
    </>
  )
}

// ---------------------------------------------------------------------------

function PhotoFilterPanel({ layer }: { layer: Layer }) {
  const p = layer.params as PhotoFilterParams
  const patch = usePatch(layer.id)
  return (
    <>
      <Select label="Filter" value={p.presetName}
        options={PHOTO_FILTERS.map((f) => ({ value: f.name, label: f.name }))}
        onChange={(name) => {
          const f = PHOTO_FILTERS.find((x) => x.name === name)
          if (f) patch({ presetName: name, color: [...f.color] })
        }} />
      <ColorField label="Colour" value={p.color}
        onChange={(c) => patch({ color: c, presetName: 'Custom' })} />
      <Slider label="Density" value={p.density} min={0} max={100} suffix="%" neutral={25}
        onChange={(v) => patch({ density: v })} />
      <Toggle label="Preserve Luminosity" checked={p.preserveLuminosity}
        onChange={(v) => patch({ preserveLuminosity: v })} />
    </>
  )
}

// ---------------------------------------------------------------------------

function GradientMapPanel({ layer }: { layer: Layer }) {
  const p = layer.params as GradientMapParams
  const patch = usePatch(layer.id)
  return (
    <>
      <Select label="Preset" value=""
        options={[{ value: '', label: 'Apply a ramp…' },
          ...GRADIENT_PRESETS.map((g) => ({ value: g.name, label: g.name }))]}
        onChange={(name) => {
          const g = GRADIENT_PRESETS.find((x) => x.name === name)
          if (g) patch({ stops: g.stops.map((s) => ({ t: s.t, color: [...s.color] })) })
        }} />
      <GradientEditor stops={p.stops} onChange={(s) => patch({ stops: s })} />
      <Toggle label="Reverse" checked={p.reverse} onChange={(v) => patch({ reverse: v })} />
      <p className="hint">
        Shadows take the left end of the ramp, highlights the right. Lower the layer
        opacity or switch its blend mode to Color for a subtler tone.
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------

function ColorLookupPanel({ layer }: { layer: Layer }) {
  const p = layer.params as ColorLookupParams
  const patch = usePatch(layer.id)
  const pushHistory = useStore((s) => s.pushHistory)
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [, force] = useState(0)

  const loadCube = async (file: File) => {
    setError(null)
    try {
      const cube = parseCube(await file.text())
      const id = registerCustomCube(file.name.replace(/\.cube$/i, ''), cube)
      pushHistory()
      patch({ customId: id, customName: file.name.replace(/\.cube$/i, '') })
      force((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that .cube file.')
    }
  }

  const customs = listCustomCubes()

  return (
    <>
      <Select label="LUT" value={p.customId ?? p.preset}
        options={[
          ...LUT_PRESET_NAMES.map((n) => ({ value: n, label: n })),
          ...customs.map((c) => ({ value: c.id, label: `${c.name} (${c.size}³, loaded)` })),
        ]}
        onChange={(v) => {
          if (customs.some((c) => c.id === v)) {
            patch({ customId: v, customName: customs.find((c) => c.id === v)!.name })
          } else {
            patch({ customId: null, customName: '', preset: v })
          }
        }} />
      <Slider label="Amount" value={p.amount} min={0} max={100} suffix="%" neutral={100}
        onChange={(v) => patch({ amount: v })} />
      <input ref={fileRef} type="file" accept=".cube" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) loadCube(f); e.target.value = '' }} />
      <button className="btn" onClick={() => fileRef.current?.click()}>Load .cube file…</button>
      {error && <p className="hint warn">{error}</p>}
      <p className="hint">
        Built-in looks are generated as 33³ cubes. Any Adobe/IRIDAS 3D .cube file
        (size 2–64) can be loaded on top.
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------

/**
 * Solve the shader's gain model for the settings that make `s` neutral.
 *
 * The gains are exponential, so taking logs turns the balance conditions
 *   gainR * R == gainG * G == gainB * B
 * into two linear equations in temperature and tint. Adding them cancels
 * temperature and leaves tint; subtracting them does the reverse. Exact, no
 * iteration, and it inverts the shader rather than approximating it.
 */
function solveWhiteBalance(s: [number, number, number]) {
  const { temp: kT, tintGreen: kG, tintCross: kX } = WB_GAIN
  const lin = s.map((v) => Math.pow(Math.max(v, 1 / 255), 2.2)) as [number, number, number]
  const [R, G, B] = lin
  const lr = Math.log(G / Math.max(R, 1e-6))
  const lb = Math.log(G / Math.max(B, 1e-6))

  const tint = -(lr + lb) / (2 * (kX + kG))
  const temperature = (lr - lb) / (2 * kT)
  return {
    temperature: Math.round(clamp(temperature, -1, 1) * 100),
    tint: Math.round(clamp(tint, -1, 1) * 100),
  }
}

function WhiteBalancePanel({ layer }: { layer: Layer }) {
  const p = layer.params as WhiteBalanceParams
  const patch = usePatch(layer.id)
  const pushHistory = useStore((s) => s.pushHistory)
  const picking = useStore((s) => s.picking)
  const setPicking = useStore((s) => s.setPicking)
  const setPainting = useStore((s) => s.setPainting)
  // armed only while this panel's own callback is the live picker — see the
  // note on the curve droppers.
  const mineRef = useRef<((rgb: [number, number, number], uv: [number, number]) => void) | null>(null)
  const armed = picking !== null && picking === mineRef.current

  const pickNeutral = () => {
    if (armed) { setPicking(null); return }
    setPainting(false)
    const mine = (_rgb: [number, number, number], uv: [number, number]) => {
      let sample: [number, number, number] | null = null
      try {
        sample = colourlab.sampleLayerInput(layer.id, uv[0], uv[1])
      } catch (err) {
        console.warn('White balance could not sample:', err)
      } finally {
        setPicking(null)
      }
      if (!sample) return
      pushHistory()
      patch(solveWhiteBalance(sample))
    }
    mineRef.current = mine
    setPicking(mine)
  }

  return (
    <>
      <button className={`btn wide ${armed ? 'primary' : ''}`} onClick={pickNeutral}>
        {armed ? '● Click something neutral…' : '⌖ Set from a neutral'}
      </button>
      <Slider label="Temperature" value={p.temperature} min={-100} max={100}
        accent="#4f7dff, #8a8a8a, #f2d63f"
        onChange={(v) => patch({ temperature: v })} />
      <Slider label="Tint" value={p.tint} min={-100} max={100}
        accent="#e152e1, #8a8a8a, #3ee06f"
        onChange={(v) => patch({ tint: v })} />
      <Toggle label="Preserve Luminosity" checked={p.preserveLuminosity}
        onChange={(v) => patch({ preserveLuminosity: v })} />
      <p className="hint">
        Right warms the photo, left cools it; Tint runs magenta to green. These
        are the two axes a light source actually moves along, which is why they
        can neutralise almost any cast between them. Scaling happens in linear
        light, so highlights stay clean.
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------

function SolidColorPanel({ layer }: { layer: Layer }) {
  const p = layer.params as SolidColorParams
  const patch = usePatch(layer.id)
  const painted = layer.mask.kind === 'brush' && layer.mask.strokes.length > 0
  return (
    <>
      <ColorField label="Colour" value={p.color} eyedropper
        onChange={(c) => patch({ color: c })} />
      <p className="hint">
        {painted
          ? 'Lower the layer opacity for a subtler tint, or switch the blend mode — Colour keeps the original luminosity, Soft Light adds depth.'
          : 'Paint it in with the brush mask above. In Colour blend it changes hue while keeping the underlying shading, which is how lips, eyes and clothing get recoloured.'}
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------

const PANELS: Record<Layer['kind'], (props: { layer: Layer }) => JSX.Element> = {
  brightnessContrast: BrightnessContrastPanel,
  levels: LevelsPanel,
  curves: CurvesPanel,
  exposure: ExposurePanel,
  vibrance: VibrancePanel,
  hueSaturation: HueSaturationPanel,
  colorBalance: ColorBalancePanel,
  selectiveColor: SelectiveColorPanel,
  replaceColor: ReplaceColorPanel,
  blackWhite: BlackWhitePanel,
  channelMixer: ChannelMixerPanel,
  photoFilter: PhotoFilterPanel,
  gradientMap: GradientMapPanel,
  colorLookup: ColorLookupPanel,
  solidColor: SolidColorPanel,
  whiteBalance: WhiteBalancePanel,
}

export function AdjustmentPanel({ layer }: { layer: Layer }) {
  const Panel = PANELS[layer.kind]
  // No header here: the panel is already titled by the layer name above it, and
  // a second "Properties" bar only pushed the real controls further down.
  return <div className="section-body adjustment-body"><Panel layer={layer} /></div>
}
