/**
 * Fuji-style Image Quality recipe → KolourLab layer stack.
 *
 * The controls mirror Fujifilm's JPEG menu (and the fuji.mdd.io.vn lab). This
 * is a relative simulation — Film Simulation is a procedural LUT, not a camera
 * JPEG — so a recipe that looks right here will not match a body 1:1. A Look
 * stores fixed values; rebuilding from this recipe is how you get a stack you
 * can then tweak as ordinary layers.
 */

import {
  makeLayer, type Layer, type VibranceParams, type WhiteBalanceParams,
  type ColorLookupParams, type HighlightsShadowsParams, type ClarityParams,
  type SharpnessParams, type GrainParams, type NoiseReductionParams,
  type ColorChromeParams,
} from '../state/types'

export type FujiStrength = 'OFF' | 'WEAK' | 'STRONG'
export type FujiGrainSize = 'SMALL' | 'LARGE'
export type FujiDynamicRange = 'DR100%' | 'DR200%' | 'DR400%'

export type FujiFilmId =
  | 'provia' | 'astia' | 'velvia' | 'chrome' | 'negative'
  | 'prohi' | 'prostd' | 'eterna' | 'bleach' | 'acros' | 'mono'
  | 'nostalgic' | 'reala'

export interface FujiFilm {
  id: FujiFilmId
  /** Menu name as printed on the camera */
  name: string
  hint: string
  /** LUT preset key in LOOK_FNS / getPresetCube */
  lut: string
}

/** The thirteen film simulations the Fuji lab exposes. */
export const FUJI_FILMS: FujiFilm[] = [
  { id: 'provia', name: 'PROVIA', hint: 'Balanced, everyday colour', lut: 'Fuji · PROVIA' },
  { id: 'astia', name: 'ASTIA', hint: 'Soft, gentle skin', lut: 'Fuji · ASTIA' },
  { id: 'velvia', name: 'VELVIA', hint: 'Vivid nature', lut: 'Fuji · VELVIA' },
  { id: 'chrome', name: 'CLASSIC CHROME', hint: 'Muted, classic', lut: 'Fuji · Classic Chrome' },
  { id: 'negative', name: 'CLASSIC NEGATIVE', hint: 'Punchy negative contrast', lut: 'Fuji · Classic Negative' },
  { id: 'prohi', name: 'PRO Neg. Hi', hint: 'Portrait, higher contrast', lut: 'Fuji · PRO Neg Hi' },
  { id: 'prostd', name: 'PRO Neg. Std', hint: 'Portrait, soft transitions', lut: 'Fuji · PRO Neg Std' },
  { id: 'eterna', name: 'ETERNA', hint: 'Cinematic, low saturation', lut: 'Fuji · ETERNA' },
  { id: 'bleach', name: 'ETERNA BLEACH BYPASS', hint: 'Desaturated, hard contrast', lut: 'Fuji · Bleach Bypass' },
  { id: 'acros', name: 'ACROS', hint: 'Deep monochrome', lut: 'Fuji · ACROS' },
  { id: 'mono', name: 'MONOCHROME', hint: 'Plain black & white', lut: 'Fuji · Monochrome' },
  { id: 'nostalgic', name: 'NOSTALGIC NEG.', hint: 'Warm, nostalgic', lut: 'Fuji · Nostalgic Neg' },
  { id: 'reala', name: 'REALA ACE', hint: 'Natural with depth', lut: 'Fuji · Reala ACE' },
]

export interface FujiRecipe {
  film: FujiFilmId
  grain: FujiStrength
  grainSize: FujiGrainSize
  chrome: FujiStrength
  blue: FujiStrength
  /** −4…+4 */
  color: number
  dr: FujiDynamicRange
  /** −4…+4 */
  sharpness: number
  /** −5…+5 */
  clarity: number
  /** −2…+4 */
  highlight: number
  /** −2…+4 */
  shadow: number
  /** −4…+4 */
  nr: number
  /** 2500…10000 */
  kelvin: number
  /** WB shift R −9…+9 */
  r: number
  /** WB shift B −9…+9 */
  b: number
}

export const DEFAULT_FUJI_RECIPE: FujiRecipe = {
  film: 'provia',
  grain: 'OFF',
  grainSize: 'SMALL',
  chrome: 'OFF',
  blue: 'OFF',
  color: 0,
  dr: 'DR100%',
  sharpness: 0,
  clarity: 0,
  highlight: 0,
  shadow: 0,
  nr: 0,
  kelvin: 5500,
  r: 0,
  b: 0,
}

const STRENGTH: Record<FujiStrength, number> = { OFF: 0, WEAK: 40, STRONG: 75 }

/** Map a camera Kelvin setting (+ R/B shift) onto our temperature/tint axes. */
export function kelvinToWhiteBalance(kelvin: number, r: number, b: number): WhiteBalanceParams {
  // Camera WB Kelvin: higher K warms the JPEG (shade → 7000K). ±4500 K ≈ full throw.
  const temperature = Math.max(-100, Math.min(100,
    ((kelvin - 5500) / 45) + r * 6 - b * 5,
  ))
  const tint = Math.max(-100, Math.min(100, r * 2 - b * 3))
  return { temperature: Math.round(temperature), tint: Math.round(tint), preserveLuminosity: true }
}

function layer<K extends Layer['kind']>(
  kind: K,
  name: string,
  patch: object,
): Layer {
  const l = makeLayer(kind)
  l.name = name
  Object.assign(l.params as object, patch)
  return l
}

/**
 * Compile a Fuji recipe into ordinary adjustment layers. Identity controls are
 * omitted so the stack stays readable; PROVIA at defaults yields an empty list.
 */
export function buildFujiRecipe(recipe: FujiRecipe): Layer[] {
  const film = FUJI_FILMS.find((f) => f.id === recipe.film) ?? FUJI_FILMS[0]
  const out: Layer[] = []

  // Film simulation — always present; it is the character of the recipe.
  out.push(layer('colorLookup', `Fuji · ${film.name}`, {
    preset: film.lut, customId: null, customName: '', amount: 100,
  } satisfies ColorLookupParams))

  const wb = kelvinToWhiteBalance(recipe.kelvin, recipe.r, recipe.b)
  if (wb.temperature !== 0 || wb.tint !== 0) {
    out.push(layer('whiteBalance', 'Fuji · White Balance', wb))
  }

  if (recipe.color !== 0) {
    // One Fuji Color step ≈ 12 of our saturation units.
    out.push(layer('vibrance', 'Fuji · Color', {
      vibrance: Math.round(recipe.color * 6),
      saturation: Math.round(recipe.color * 10),
    } satisfies VibranceParams))
  }

  const chromeAmt = STRENGTH[recipe.chrome]
  const blueAmt = STRENGTH[recipe.blue]
  if (chromeAmt > 0 || blueAmt > 0) {
    out.push(layer('colorChrome', 'Fuji · Color Chrome', {
      amount: chromeAmt, blue: blueAmt,
    } satisfies ColorChromeParams))
  }

  let highlights = Math.round(recipe.highlight * 18)
  let shadows = Math.round(recipe.shadow * 18)
  // Dynamic Range compresses the bright end the way DR200/DR400 do in-camera.
  if (recipe.dr === 'DR200%') highlights -= 22
  if (recipe.dr === 'DR400%') highlights -= 40
  if (highlights !== 0 || shadows !== 0) {
    out.push(layer('highlightsShadows', 'Fuji · Highlight & Shadow', {
      highlights: Math.max(-100, Math.min(100, highlights)),
      shadows: Math.max(-100, Math.min(100, shadows)),
    } satisfies HighlightsShadowsParams))
  }

  if (recipe.clarity !== 0) {
    out.push(layer('clarity', 'Fuji · Clarity', {
      amount: Math.round(recipe.clarity * 16),
    } satisfies ClarityParams))
  }

  if (recipe.sharpness !== 0) {
    out.push(layer('sharpness', 'Fuji · Sharpness', {
      amount: Math.round(recipe.sharpness * 14),
    } satisfies SharpnessParams))
  }

  if (recipe.nr !== 0) {
    out.push(layer('noiseReduction', 'Fuji · Noise Reduction', {
      amount: Math.round(recipe.nr * 16),
    } satisfies NoiseReductionParams))
  }

  const grainAmt = STRENGTH[recipe.grain]
  if (grainAmt > 0) {
    out.push(layer('grain', 'Fuji · Grain', {
      amount: grainAmt,
      size: recipe.grainSize === 'LARGE' ? 70 : 30,
    } satisfies GrainParams))
  }

  return out
}

/** Randomise within sensible bounds — mirrors the lab's "Ngẫu hứng". */
export function randomFujiRecipe(): FujiRecipe {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!
  const strengths: FujiStrength[] = ['OFF', 'WEAK', 'STRONG']
  return {
    ...DEFAULT_FUJI_RECIPE,
    film: pick(FUJI_FILMS).id,
    grain: pick(strengths),
    grainSize: pick(['SMALL', 'LARGE'] as const),
    chrome: pick(strengths),
    blue: Math.random() < 0.5 ? 'OFF' : pick(strengths),
    color: Math.floor(Math.random() * 5) - 2,
    highlight: Math.floor(Math.random() * 5) - 2,
    shadow: Math.floor(Math.random() * 5) - 2,
    clarity: Math.floor(Math.random() * 5) - 2,
    sharpness: Math.floor(Math.random() * 5) - 2,
    kelvin: 4500 + Math.floor(Math.random() * 26) * 100,
    dr: pick(['DR100%', 'DR200%', 'DR400%'] as const),
  }
}
