import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { findLayer, paramsOf, setLook, setParam } from '../state/editSession'
import { Slider } from './controls'
import { FUJI_FILMS } from '../engine/fuji'
import { LUT_PRESET_NAMES } from '../engine/presets'
import { buildLookThumbs, revokeLookThumbs, type LookThumbMap } from '../engine/lookThumbs'
import type {
  BrightnessContrastParams, ColorChromeParams, ColorLookupParams,
  GrainParams, HighlightsShadowsParams, VibranceParams, WhiteBalanceParams,
  ClarityParams, SharpnessParams, NoiseReductionParams,
} from '../state/types'

type DockTab = 'looks' | 'basic' | 'effects'

/** Creative LUTs that are not Fuji film sims — keep the strip short. */
const CREATIVE_LOOKS = LUT_PRESET_NAMES.filter((n) => !n.startsWith('Fuji ·')).slice(0, 10)

/** Preset keys shown in the Looks strip — one thumb each. */
const LOOK_PRESET_KEYS = [
  ...FUJI_FILMS.map((f) => f.lut),
  ...CREATIVE_LOOKS,
] as const

/**
 * VSCO-style bottom dock: Looks / Basic / Effects. Writes into singleton
 * layers via editSession — the layer stack stays invisible on mobile.
 */
export function MobileDock({ onFix }: { onFix: (id: string) => void }) {
  const [tab, setTab] = useState<DockTab>('looks')
  const hasImage = useStore((s) => s.image !== null)
  const preview = useStore((s) => s.image?.preview ?? null)
  const layers = useStore((s) => s.layers)
  const pushHistory = useStore((s) => s.pushHistory)
  const suggestions = useStore((s) => s.suggestions)
  const dismissed = useStore((s) => s.dismissed)
  const dismissFix = useStore((s) => s.dismissFix)
  // Bake once per photo at the dock level so tab switches keep the URLs.
  const thumbs = useLookThumbs(preview, LOOK_PRESET_KEYS)

  // Re-read when layers change so sliders stay live.
  void layers

  const suggestion = suggestions.find(
    (s) => s.confidence >= 0.6 && !dismissed.includes(s.id),
  )

  // Full-bleed empty state belongs to the viewer — don't split the screen.
  if (!hasImage) return null

  return (
    <div className="mobile-dock">
      {suggestion && layers.length === 0 && (
        <div className="dock-fix">
          <div className="dock-fix-text">
            <strong>{suggestion.name}</strong>
            <span>{suggestion.explanation}</span>
          </div>
          <div className="dock-fix-actions">
            <button type="button" className="btn small primary" onClick={() => onFix(suggestion.id)}>
              Fix it
            </button>
            <button type="button" className="btn small" onClick={() => dismissFix(suggestion.id)}>
              Not now
            </button>
          </div>
        </div>
      )}

      <div className="dock-body">
        {tab === 'looks' && <LooksPanel pushHistory={pushHistory} thumbs={thumbs} />}
        {tab === 'basic' && <BasicPanel />}
        {tab === 'effects' && <EffectsPanel />}
      </div>

      <nav className="dock-tabs" aria-label="Edit tools">
        {([
          ['looks', 'Looks'],
          ['basic', 'Basic'],
          ['effects', 'Effects'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}

function LooksPanel({
  pushHistory,
  thumbs,
}: {
  pushHistory: () => void
  thumbs: LookThumbMap | null
}) {
  const lut = paramsOf('colorLookup') as ColorLookupParams
  const active = findLayer('colorLookup') ? lut.preset : null

  const pick = (preset: string) => {
    pushHistory()
    setLook(preset, lut.amount || 100)
  }

  return (
    <div className="dock-panel">
      <div className="look-strip" role="listbox" aria-label="Looks">
        <button
          type="button"
          role="option"
          className={`look-chip ${!active ? 'active' : ''}`}
          aria-selected={!active}
          onClick={() => {
            const layer = findLayer('colorLookup')
            if (!layer) return
            pushHistory()
            useStore.getState().removeLayer(layer.id)
          }}
        >
          <LookSwatch src={thumbs?.original} empty />
          <span className="look-name">None</span>
        </button>
        {FUJI_FILMS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="option"
            className={`look-chip ${active === f.lut ? 'active' : ''}`}
            aria-selected={active === f.lut}
            title={f.hint}
            onClick={() => pick(f.lut)}
          >
            <LookSwatch src={thumbs?.looks[f.lut]} />
            <span className="look-name">{f.name}</span>
          </button>
        ))}
        {CREATIVE_LOOKS.map((name) => (
          <button
            key={name}
            type="button"
            role="option"
            className={`look-chip ${active === name ? 'active' : ''}`}
            aria-selected={active === name}
            onClick={() => pick(name)}
          >
            <LookSwatch src={thumbs?.looks[name]} />
            <span className="look-name">{name.replace(/^Fuji · /, '')}</span>
          </button>
        ))}
      </div>
      {active && (
        <Slider
          label="Strength"
          value={lut.amount}
          min={0}
          max={100}
          neutral={100}
          onChange={(v) => setParam('colorLookup', { amount: v })}
        />
      )}
    </div>
  )
}

/** Photo thumb for a Look chip — falls back to a neutral tile while baking. */
function LookSwatch({ src, empty }: { src?: string; empty?: boolean }) {
  return (
    <span className={`look-swatch ${empty && !src ? 'none' : ''} ${src ? 'photo' : ''}`}>
      {src && <img src={src} alt="" draggable={false} />}
    </span>
  )
}

/**
 * Bake Look previews off the current photo; revoke URLs when the image
 * changes so we do not retain blob memory across opens.
 */
function useLookThumbs(
  preview: ImageBitmap | null,
  presets: readonly string[],
): LookThumbMap | null {
  const [thumbs, setThumbs] = useState<LookThumbMap | null>(null)
  // Stable key so identical arrays do not retrigger the effect.
  const presetKey = useMemo(() => presets.join('\0'), [presets])

  useEffect(() => {
    if (!preview) {
      setThumbs((prev) => {
        revokeLookThumbs(prev)
        return null
      })
      return
    }
    const ac = new AbortController()
    buildLookThumbs(preview, presets, ac.signal)
      .then((map) => {
        if (ac.signal.aborted) {
          revokeLookThumbs(map)
          return
        }
        setThumbs((prev) => {
          revokeLookThumbs(prev)
          return map
        })
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.warn('look thumbs failed', err)
      })
    return () => {
      ac.abort()
      setThumbs((prev) => {
        revokeLookThumbs(prev)
        return null
      })
    }
    // presets identity is captured via presetKey; list itself is module-const.
  }, [preview, presetKey, presets])

  return thumbs
}

function BasicPanel() {
  const bc = paramsOf('brightnessContrast') as BrightnessContrastParams
  const hs = paramsOf('highlightsShadows') as HighlightsShadowsParams
  const wb = paramsOf('whiteBalance') as WhiteBalanceParams
  const vib = paramsOf('vibrance') as VibranceParams

  return (
    <div className="dock-panel dock-sliders">
      <Slider label="Brightness" value={bc.brightness} min={-150} max={150}
        onChange={(v) => setParam('brightnessContrast', { brightness: v, contrast: bc.contrast, legacy: bc.legacy })} />
      <Slider label="Contrast" value={bc.contrast} min={-50} max={100}
        onChange={(v) => setParam('brightnessContrast', { brightness: bc.brightness, contrast: v, legacy: bc.legacy })} />
      <Slider label="Highlights" value={hs.highlights} min={-100} max={100}
        onChange={(v) => setParam('highlightsShadows', { highlights: v, shadows: hs.shadows })} />
      <Slider label="Shadows" value={hs.shadows} min={-100} max={100}
        onChange={(v) => setParam('highlightsShadows', { highlights: hs.highlights, shadows: v })} />
      <Slider label="Temp" value={wb.temperature} min={-100} max={100}
        accent="#4f7dff, #8a8a8a, #f2d63f"
        onChange={(v) => setParam('whiteBalance', { temperature: v, tint: wb.tint, preserveLuminosity: wb.preserveLuminosity })} />
      <Slider label="Tint" value={wb.tint} min={-100} max={100}
        accent="#e152e1, #8a8a8a, #3ee06f"
        onChange={(v) => setParam('whiteBalance', { temperature: wb.temperature, tint: v, preserveLuminosity: wb.preserveLuminosity })} />
      <Slider label="Vibrance" value={vib.vibrance} min={-100} max={100}
        onChange={(v) => setParam('vibrance', { vibrance: v, saturation: vib.saturation })} />
      <Slider label="Saturation" value={vib.saturation} min={-100} max={100}
        onChange={(v) => setParam('vibrance', { vibrance: vib.vibrance, saturation: v })} />
    </div>
  )
}

function EffectsPanel() {
  const grain = paramsOf('grain') as GrainParams
  const clarity = paramsOf('clarity') as ClarityParams
  const sharp = paramsOf('sharpness') as SharpnessParams
  const chrome = paramsOf('colorChrome') as ColorChromeParams
  const nr = paramsOf('noiseReduction') as NoiseReductionParams

  return (
    <div className="dock-panel dock-sliders">
      <Slider label="Grain" value={grain.amount} min={0} max={100}
        onChange={(v) => setParam('grain', { amount: v, size: grain.size })} />
      <Slider label="Grain size" value={grain.size} min={0} max={100}
        onChange={(v) => setParam('grain', { amount: grain.amount, size: v })} />
      <Slider label="Clarity" value={clarity.amount} min={-100} max={100}
        onChange={(v) => setParam('clarity', { amount: v })} />
      <Slider label="Sharpness" value={sharp.amount} min={-100} max={100}
        onChange={(v) => setParam('sharpness', { amount: v })} />
      <Slider label="Color Chrome" value={chrome.amount} min={0} max={100}
        onChange={(v) => setParam('colorChrome', { amount: v, blue: chrome.blue })} />
      <Slider label="FX Blue" value={chrome.blue} min={0} max={100}
        onChange={(v) => setParam('colorChrome', { amount: chrome.amount, blue: v })} />
      <Slider label="Noise Reduction" value={nr.amount} min={-100} max={100}
        onChange={(v) => setParam('noiseReduction', { amount: v })} />
    </div>
  )
}
