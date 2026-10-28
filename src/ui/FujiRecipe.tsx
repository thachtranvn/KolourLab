import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { Slider, Segmented, Select } from './controls'
import {
  DEFAULT_FUJI_RECIPE, FUJI_FILMS, buildFujiRecipe, randomFujiRecipe,
  type FujiDynamicRange, type FujiFilmId, type FujiGrainSize,
  type FujiRecipe, type FujiStrength,
} from '../engine/fuji'

const STRENGTHS: FujiStrength[] = ['OFF', 'WEAK', 'STRONG']
const DR_OPTS: { value: FujiDynamicRange; label: string }[] = [
  { value: 'DR100%', label: 'DR100%' },
  { value: 'DR200%', label: 'DR200%' },
  { value: 'DR400%', label: 'DR400%' },
]

/**
 * Live Fuji Image Quality panel. Every change recompiles into ordinary
 * adjustment layers via loadRecipe, so the result is a normal stack you can
 * keep editing after leaving the panel.
 */
export function FujiRecipePanel({ onClose }: { onClose: () => void }) {
  const loadRecipe = useStore((s) => s.loadRecipe)
  const pushHistory = useStore((s) => s.pushHistory)
  const hasImage = useStore((s) => s.image !== null)
  const [recipe, setRecipe] = useState<FujiRecipe>({ ...DEFAULT_FUJI_RECIPE })
  // Seeded on first effect so opening the panel (and React Strict Mode's
  // double-invoke) never wipes an existing stack — only user edits apply.
  const appliedKey = useRef<string | null>(null)

  const patch = (partial: Partial<FujiRecipe>) => {
    setRecipe((r) => ({ ...r, ...partial }))
  }

  useEffect(() => {
    if (!hasImage) return
    const key = JSON.stringify(recipe)
    if (appliedKey.current === null) {
      appliedKey.current = key
      return
    }
    if (appliedKey.current === key) return
    appliedKey.current = key
    loadRecipe(buildFujiRecipe(recipe), { history: false })
  }, [recipe, hasImage, loadRecipe])

  const commit = (next: FujiRecipe) => {
    pushHistory()
    setRecipe(next)
  }

  const film = FUJI_FILMS.find((f) => f.id === recipe.film) ?? FUJI_FILMS[0]

  return (
    <div className="fuji-panel">
      <div className="fuji-panel-head">
        <div>
          <div className="fuji-kicker">Fuji Recipe</div>
          <div className="fuji-title">{film.name}</div>
        </div>
        <button className="btn small" onClick={onClose} title="Close">✕</button>
      </div>

      <p className="hint fuji-disclaimer">
        Relative simulation of the Image Quality menu — not a Fujifilm JPEG.
        Applying replaces the current layer stack.
      </p>

      <div className="fuji-scroll">
        <div className="fuji-group">
          <div className="fuji-group-title">01 · Film Simulation</div>
          <Select
            label="Film"
            value={recipe.film}
            options={FUJI_FILMS.map((f) => ({ value: f.id, label: f.name }))}
            onChange={(v) => setRecipe((r) => ({ ...r, film: v as FujiFilmId }))}
          />
          <p className="hint">{film.hint}</p>
        </div>

        <div className="fuji-group">
          <div className="fuji-group-title">02 · Colour &amp; grain</div>
          <div className="fuji-row-label">Grain Effect</div>
          <Segmented
            value={recipe.grain}
            options={STRENGTHS.map((v) => ({ value: v, label: v }))}
            onChange={(v) => commit({ ...recipe, grain: v })}
          />
          <div className="fuji-row-label">Grain size</div>
          <Segmented
            value={recipe.grainSize}
            options={([
              { value: 'SMALL' as FujiGrainSize, label: 'SMALL' },
              { value: 'LARGE' as FujiGrainSize, label: 'LARGE' },
            ])}
            onChange={(v) => commit({ ...recipe, grainSize: v })}
          />
          <div className="fuji-row-label">Color Chrome</div>
          <Segmented
            value={recipe.chrome}
            options={STRENGTHS.map((v) => ({ value: v, label: v }))}
            onChange={(v) => commit({ ...recipe, chrome: v })}
          />
          <div className="fuji-row-label">Color Chrome FX Blue</div>
          <Segmented
            value={recipe.blue}
            options={STRENGTHS.map((v) => ({ value: v, label: v }))}
            onChange={(v) => commit({ ...recipe, blue: v })}
          />
          <Slider label="Color" value={recipe.color} min={-4} max={4} step={1}
            onChange={(v) => patch({ color: v })} />
        </div>

        <div className="fuji-group">
          <div className="fuji-group-title">03 · Light</div>
          <div className="fuji-row-label">Dynamic Range</div>
          <Segmented
            value={recipe.dr}
            options={DR_OPTS}
            onChange={(v) => commit({ ...recipe, dr: v })}
          />
          <Slider label="Highlight" value={recipe.highlight} min={-2} max={4} step={1}
            onChange={(v) => patch({ highlight: v })} />
          <Slider label="Shadow" value={recipe.shadow} min={-2} max={4} step={1}
            onChange={(v) => patch({ shadow: v })} />
        </div>

        <div className="fuji-group">
          <div className="fuji-group-title">04 · Detail</div>
          <Slider label="Sharpness" value={recipe.sharpness} min={-4} max={4} step={1}
            onChange={(v) => patch({ sharpness: v })} />
          <Slider label="Clarity" value={recipe.clarity} min={-5} max={5} step={1}
            onChange={(v) => patch({ clarity: v })} />
          <Slider label="Noise Reduction" value={recipe.nr} min={-4} max={4} step={1}
            onChange={(v) => patch({ nr: v })} />
        </div>

        <div className="fuji-group">
          <div className="fuji-group-title">05 · White Balance</div>
          <Slider label="Kelvin" value={recipe.kelvin} min={2500} max={10000} step={100}
            suffix="K" neutral={5500}
            onChange={(v) => patch({ kelvin: v })} />
          <Slider label="WB Shift · Red" value={recipe.r} min={-9} max={9} step={1}
            onChange={(v) => patch({ r: v })} />
          <Slider label="WB Shift · Blue" value={recipe.b} min={-9} max={9} step={1}
            onChange={(v) => patch({ b: v })} />
        </div>
      </div>

      <div className="fuji-actions">
        <button
          className="btn small"
          disabled={!hasImage}
          onClick={() => commit({ ...DEFAULT_FUJI_RECIPE })}
        >
          Reset
        </button>
        <button
          className="btn small"
          disabled={!hasImage}
          onClick={() => commit(randomFujiRecipe())}
        >
          Random
        </button>
        <button
          className="btn small primary"
          disabled={!hasImage}
          onClick={() => {
            loadRecipe(buildFujiRecipe(recipe))
            onClose()
          }}
        >
          Apply &amp; close
        </button>
      </div>
    </div>
  )
}
