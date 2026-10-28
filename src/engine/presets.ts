import { generateCube, clamp01, type Cube } from './lut'
import { luma, rgbToHsl, hslToRgb, type RGB } from './color'
import {
  makeLayer, type Layer, type AdjustmentKind, type GradientStop,
  type BrightnessContrastParams, type CurvesParams, type HueSaturationParams,
  type ColorBalanceParams, type SelectiveColorParams, type VibranceParams,
  type PhotoFilterParams, type GradientMapParams, type ChannelMixerParams,
  type BlackWhiteParams, type LevelsParams, type ColorLookupParams,
} from '../state/types'

// ---------------------------------------------------------------------------
// Photo Filter presets — Photoshop's stock lens filters.
// ---------------------------------------------------------------------------

export const PHOTO_FILTERS: { name: string; color: RGB }[] = [
  { name: 'Warming Filter (85)', color: [0.929, 0.596, 0.212] },
  { name: 'Warming Filter (LBA)', color: [0.925, 0.635, 0.267] },
  { name: 'Warming Filter (81)', color: [0.918, 0.694, 0.412] },
  { name: 'Cooling Filter (80)', color: [0.0, 0.435, 0.898] },
  { name: 'Cooling Filter (LBB)', color: [0.0, 0.365, 0.827] },
  { name: 'Cooling Filter (82)', color: [0.443, 0.729, 0.898] },
  { name: 'Red', color: [0.917, 0.098, 0.098] },
  { name: 'Orange', color: [0.929, 0.451, 0.008] },
  { name: 'Yellow', color: [0.929, 0.784, 0.008] },
  { name: 'Green', color: [0.098, 0.769, 0.239] },
  { name: 'Cyan', color: [0.016, 0.749, 0.937] },
  { name: 'Blue', color: [0.114, 0.259, 0.925] },
  { name: 'Violet', color: [0.573, 0.161, 0.882] },
  { name: 'Magenta', color: [0.878, 0.129, 0.729] },
  { name: 'Sepia', color: [0.675, 0.518, 0.318] },
  { name: 'Deep Red', color: [0.898, 0.0, 0.0] },
  { name: 'Deep Blue', color: [0.0, 0.020, 0.784] },
  { name: 'Deep Emerald', color: [0.0, 0.6, 0.0] },
  { name: 'Deep Yellow', color: [0.929, 0.678, 0.0] },
  { name: 'Underwater', color: [0.0, 0.757, 0.694] },
]

// ---------------------------------------------------------------------------
// Gradient Map ramps
// ---------------------------------------------------------------------------

const stop = (t: number, hex: RGB): GradientStop => ({ t, color: hex })

export const GRADIENT_PRESETS: { name: string; stops: GradientStop[] }[] = [
  { name: 'Black to White', stops: [stop(0, [0, 0, 0]), stop(1, [1, 1, 1])] },
  { name: 'Sepia', stops: [stop(0, [0.09, 0.05, 0.02]), stop(0.5, [0.58, 0.43, 0.26]), stop(1, [1, 0.96, 0.87])] },
  { name: 'Cyanotype', stops: [stop(0, [0.02, 0.06, 0.16]), stop(0.5, [0.16, 0.38, 0.6]), stop(1, [0.87, 0.95, 1])] },
  { name: 'Teal → Orange', stops: [stop(0, [0.02, 0.13, 0.17]), stop(0.5, [0.35, 0.42, 0.42]), stop(1, [1, 0.78, 0.5])] },
  { name: 'Purple Haze', stops: [stop(0, [0.08, 0.02, 0.16]), stop(0.5, [0.51, 0.25, 0.55]), stop(1, [1, 0.87, 0.72])] },
  { name: 'Duotone Blue/Pink', stops: [stop(0, [0.04, 0.09, 0.35]), stop(1, [1, 0.45, 0.62])] },
  { name: 'Infrared', stops: [stop(0, [0, 0, 0.12]), stop(0.35, [0.62, 0, 0.45]), stop(0.7, [1, 0.42, 0]), stop(1, [1, 1, 0.7])] },
  { name: 'Matte Fade', stops: [stop(0, [0.16, 0.16, 0.19]), stop(0.5, [0.5, 0.5, 0.5]), stop(1, [0.93, 0.92, 0.88])] },
]

// ---------------------------------------------------------------------------
// Channel Mixer presets (Photoshop's monochrome filter set)
// ---------------------------------------------------------------------------

export const CHANNEL_MIXER_PRESETS: { name: string; gray: [number, number, number]; constant: number }[] = [
  { name: 'Black & White Infrared', gray: [-70, 200, -30], constant: 0 },
  { name: 'Black & White with Blue Filter', gray: [0, 0, 100], constant: 0 },
  { name: 'Black & White with Green Filter', gray: [0, 100, 0], constant: 0 },
  { name: 'Black & White with Orange Filter', gray: [50, 50, 0], constant: 0 },
  { name: 'Black & White with Red Filter', gray: [100, 0, 0], constant: 0 },
  { name: 'Black & White with Yellow Filter', gray: [34, 66, 0], constant: 0 },
]

// ---------------------------------------------------------------------------
// Curve shape presets
// ---------------------------------------------------------------------------

export const CURVE_PRESETS: { name: string; points: { x: number; y: number }[] }[] = [
  { name: 'Linear', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  { name: 'Medium Contrast (S)', points: [{ x: 0, y: 0 }, { x: 0.25, y: 0.19 }, { x: 0.75, y: 0.81 }, { x: 1, y: 1 }] },
  { name: 'Strong Contrast (S)', points: [{ x: 0, y: 0 }, { x: 0.25, y: 0.13 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.87 }, { x: 1, y: 1 }] },
  { name: 'Lighter', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.62 }, { x: 1, y: 1 }] },
  { name: 'Darker', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.38 }, { x: 1, y: 1 }] },
  { name: 'Matte / Faded', points: [{ x: 0, y: 0.09 }, { x: 0.5, y: 0.52 }, { x: 1, y: 0.95 }] },
  { name: 'Negative', points: [{ x: 0, y: 1 }, { x: 1, y: 0 }] },
]

// ---------------------------------------------------------------------------
// Built-in 3D LUTs, generated procedurally so no binary assets are needed.
// ---------------------------------------------------------------------------

const mixv = (a: number, b: number, t: number) => a + (b - a) * t
const sat = (c: RGB, s: number): RGB => {
  const l = luma(c)
  return [l + (c[0] - l) * s, l + (c[1] - l) * s, l + (c[2] - l) * s]
}
const contrastS = (c: RGB, amt: number): RGB =>
  c.map((v) => clamp01(mixv(v, v * v * (3 - 2 * v), amt))) as RGB
const gammaOp = (c: RGB, g: number): RGB => c.map((v) => Math.pow(clamp01(v), g)) as RGB
const gain = (c: RGB, m: RGB): RGB => [c[0] * m[0], c[1] * m[1], c[2] * m[2]]
const lift = (c: RGB, o: RGB): RGB => [c[0] + o[0], c[1] + o[1], c[2] + o[2]]

/** Push shadows toward one colour and highlights toward another. */
function splitTone(c: RGB, shadow: RGB, high: RGB, amount: number): RGB {
  const l = luma(c)
  const sw = Math.pow(1 - l, 2) * amount
  const hw = Math.pow(l, 2) * amount
  return [
    clamp01(c[0] + (shadow[0] - 0.5) * sw + (high[0] - 0.5) * hw),
    clamp01(c[1] + (shadow[1] - 0.5) * sw + (high[1] - 0.5) * hw),
    clamp01(c[2] + (shadow[2] - 0.5) * sw + (high[2] - 0.5) * hw),
  ]
}

type LookFn = (c: RGB) => RGB

const LOOK_FNS: Record<string, LookFn> = {
  'Teal & Orange': (c) => {
    let o = contrastS(c, 0.35)
    o = splitTone(o, [0.25, 0.55, 0.62], [0.72, 0.56, 0.36], 0.75)
    return sat(o, 1.12)
  },
  'Warm Contrast': (c) => {
    let o = contrastS(c, 0.4)
    o = gain(o, [1.06, 1.0, 0.93])
    return sat(o, 1.08)
  },
  'Cool Cinema': (c) => {
    let o = contrastS(c, 0.3)
    o = lift(o, [-0.01, 0.0, 0.03])
    o = gain(o, [0.95, 0.99, 1.08])
    return sat(o, 0.95)
  },
  'Bleach Bypass': (c) => {
    const o = contrastS(c, 0.7)
    return sat(o, 0.35)
  },
  'Vintage Film': (c) => {
    let o = gammaOp(c, 0.92)
    o = lift(o, [0.055, 0.045, 0.03])
    o = gain(o, [1.02, 0.99, 0.95])
    o = splitTone(o, [0.45, 0.52, 0.5], [0.62, 0.56, 0.44], 0.5)
    return sat(o, 0.88)
  },
  'Cross Process': (c) => [
    clamp01(Math.pow(c[0], 0.85) * 1.05),
    clamp01(mixv(c[1], c[1] * c[1] * (3 - 2 * c[1]), 0.6)),
    clamp01(Math.pow(c[2], 1.25) + 0.06),
  ],
  'Moody Forest': (c) => {
    let o = gammaOp(c, 1.12)
    o = splitTone(o, [0.35, 0.5, 0.45], [0.55, 0.58, 0.5], 0.6)
    const h = rgbToHsl(o)
    // pull yellows toward green
    if (h[0] > 0.08 && h[0] < 0.28) h[0] = mixv(h[0], 0.29, 0.35)
    return sat(hslToRgb(h), 0.85)
  },
  'Golden Hour': (c) => {
    let o = gain(c, [1.09, 1.01, 0.88])
    o = lift(o, [0.02, 0.005, -0.01])
    o = contrastS(o, 0.2)
    return sat(o, 1.1)
  },
  'Night from Day': (c) => {
    let o = gammaOp(c, 1.7)
    o = gain(o, [0.72, 0.86, 1.2])
    return sat(o, 0.7)
  },
  'Faded Matte': (c) => {
    let o = gain(c, [0.9, 0.9, 0.92])
    o = lift(o, [0.09, 0.09, 0.1])
    return sat(o, 0.82)
  },
  'Sepia': (c) => {
    const l = luma(c)
    return [clamp01(l * 1.07 + 0.07), clamp01(l * 0.94 + 0.03), clamp01(l * 0.74)]
  },
  'High Key B&W': (c) => {
    const l = clamp01(Math.pow(luma(c), 0.8) * 1.08)
    const v = clamp01(mixv(l, l * l * (3 - 2 * l), 0.45))
    return [v, v, v]
  },

  // Fuji film simulations — relative character only, not camera JPEGs.
  // Each is {sat, contrast, warm} expanded into a 3D LUT the Color Lookup pass
  // can apply; the Fuji recipe panel addresses them by these exact names.
  'Fuji · PROVIA': (c) => sat(contrastS(c, 0.05), 1.0),
  'Fuji · ASTIA': (c) => {
    let o = sat(c, 0.88)
    o = contrastS(o, -0.07)
    return gain(o, [1.02, 1.0, 0.97])
  },
  'Fuji · VELVIA': (c) => {
    let o = sat(c, 1.25)
    o = contrastS(o, 0.18)
    return gain(o, [1.03, 1.0, 0.96])
  },
  'Fuji · Classic Chrome': (c) => {
    let o = sat(c, 0.78)
    o = contrastS(o, 0.14)
    o = splitTone(o, [0.42, 0.48, 0.48], [0.58, 0.54, 0.48], 0.35)
    return gain(o, [1.02, 1.0, 0.96])
  },
  'Fuji · Classic Negative': (c) => {
    let o = sat(c, 0.9)
    o = contrastS(o, 0.28)
    return gain(o, [0.99, 1.0, 1.02])
  },
  'Fuji · PRO Neg Hi': (c) => {
    let o = sat(c, 0.9)
    o = contrastS(o, 0.14)
    return gain(o, [1.01, 1.0, 0.98])
  },
  'Fuji · PRO Neg Std': (c) => {
    let o = sat(c, 0.84)
    o = contrastS(o, -0.08)
    return gain(o, [1.03, 1.0, 0.96])
  },
  'Fuji · ETERNA': (c) => {
    let o = sat(c, 0.75)
    o = contrastS(o, -0.1)
    o = lift(o, [0.01, 0.01, 0.015])
    return o
  },
  'Fuji · Bleach Bypass': (c) => sat(contrastS(c, 0.35), 0.52),
  'Fuji · ACROS': (c) => {
    const l = clamp01(mixv(luma(c), luma(c) * luma(c) * (3 - 2 * luma(c)), 0.2) * 1.02)
    return [l, l, l]
  },
  'Fuji · Monochrome': (c) => {
    const l = luma(c)
    return [l, l, l]
  },
  'Fuji · Nostalgic Neg': (c) => {
    let o = sat(c, 0.89)
    o = contrastS(o, 0.04)
    o = gain(o, [1.06, 1.01, 0.92])
    o = lift(o, [0.02, 0.01, 0.0])
    return o
  },
  'Fuji · Reala ACE': (c) => {
    let o = sat(c, 0.98)
    o = contrastS(o, 0.12)
    return gain(o, [1.02, 1.0, 0.97])
  },
}

export const LUT_PRESET_NAMES = Object.keys(LOOK_FNS)

/** Apply a named Look to one sRGB colour — same function the LUT cube is baked from. */
export function applyLook(name: string, c: RGB): RGB {
  const fn = LOOK_FNS[name]
  return fn ? fn(c) : c
}

const cubeCache = new Map<string, Cube>()

export function getPresetCube(name: string): Cube {
  const cached = cubeCache.get(name)
  if (cached) return cached
  const fn = LOOK_FNS[name] ?? ((c: RGB) => c)
  const cube = generateCube(33, fn)
  cubeCache.set(name, cube)
  return cube
}

// User-loaded .cube files live here rather than in the document, so undo
// snapshots stay small — layers only reference them by id.
const customCubes = new Map<string, { cube: Cube; name: string }>()
let customSeq = 0

export function registerCustomCube(name: string, cube: Cube): string {
  const id = `cube${++customSeq}`
  customCubes.set(id, { cube, name })
  return id
}

export function getCustomCube(id: string): Cube | null {
  return customCubes.get(id)?.cube ?? null
}

export function listCustomCubes(): { id: string; name: string; size: number }[] {
  return [...customCubes.entries()].map(([id, v]) => ({ id, name: v.name, size: v.cube.size }))
}

// ---------------------------------------------------------------------------
// Full-stack "look" presets: ready-made multi-layer recipes.
// ---------------------------------------------------------------------------

function build<K extends AdjustmentKind>(kind: K, name: string, patch: object, extra?: Partial<Layer>): Layer {
  const l = makeLayer(kind)
  l.name = name
  Object.assign(l.params as object, patch)
  return Object.assign(l, extra)
}

export const LOOK_PRESETS: { name: string; description: string; build: () => Layer[] }[] = [
  {
    name: 'Cinematic Teal & Orange',
    description: 'Cool shadows, warm skin, punchy contrast',
    build: () => [
      build('curves', 'Contrast Curve', {
        rgb: [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.82 }, { x: 1, y: 1 }],
      } satisfies Partial<CurvesParams>),
      build('colorBalance', 'Split Tone', {
        shadows: [-18, -4, 22], midtones: [4, 0, -4], highlights: [12, 2, -16],
        preserveLuminosity: true,
      } satisfies ColorBalanceParams),
      build('selectiveColor', 'Skin Warmth', {
        colors: {
          reds: [-8, 4, 12, 0], yellows: [-10, 0, 14, 0], greens: [0, 0, 0, 0],
          cyans: [12, 0, -8, 0], blues: [16, 4, -12, 0], magentas: [0, 0, 0, 0],
          whites: [0, 0, 0, 0], neutrals: [0, 0, 0, 0], blacks: [0, 0, 0, 4],
        },
        relative: true,
      } satisfies SelectiveColorParams),
      build('vibrance', 'Vibrance', { vibrance: 22, saturation: -4 } satisfies VibranceParams),
    ],
  },
  {
    name: 'Portrait Skin Glow',
    description: 'Soft contrast, clean skin tones, gentle warmth',
    build: () => [
      build('brightnessContrast', 'Lift', { brightness: 8, contrast: 12, legacy: false } satisfies BrightnessContrastParams),
      build('selectiveColor', 'Skin', {
        colors: {
          reds: [-6, -4, 6, -2], yellows: [-8, -2, 8, -2], greens: [0, 0, 0, 0],
          cyans: [0, 0, 0, 0], blues: [0, 0, 0, 0], magentas: [0, -4, 0, 0],
          whites: [0, 0, -4, 0], neutrals: [0, 0, 2, 0], blacks: [0, 0, 0, 0],
        },
        relative: true,
      } satisfies SelectiveColorParams),
      build('photoFilter', 'Warmth', {
        color: [0.918, 0.694, 0.412], density: 14, preserveLuminosity: true,
        presetName: 'Warming Filter (81)',
      } satisfies PhotoFilterParams),
      build('vibrance', 'Vibrance', { vibrance: 18, saturation: 0 } satisfies VibranceParams),
    ],
  },
  {
    name: 'Faded Film',
    description: 'Lifted blacks, muted colour, warm highlights',
    build: () => [
      build('curves', 'Matte Curve', {
        rgb: [{ x: 0, y: 0.085 }, { x: 0.5, y: 0.52 }, { x: 1, y: 0.95 }],
        b: [{ x: 0, y: 0.05 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.94 }],
      } satisfies Partial<CurvesParams>),
      build('hueSaturation', 'Desaturate', {
        bands: {
          master: { hue: 0, saturation: -18, lightness: 0 },
          reds: { hue: 0, saturation: 0, lightness: 0 },
          yellows: { hue: -4, saturation: -6, lightness: 0 },
          greens: { hue: 0, saturation: -14, lightness: 0 },
          cyans: { hue: 0, saturation: 0, lightness: 0 },
          blues: { hue: 0, saturation: -8, lightness: 0 },
          magentas: { hue: 0, saturation: 0, lightness: 0 },
        },
      } satisfies Partial<HueSaturationParams>),
      build('photoFilter', 'Sepia Wash', {
        color: [0.675, 0.518, 0.318], density: 18, preserveLuminosity: true, presetName: 'Sepia',
      } satisfies PhotoFilterParams),
    ],
  },
  {
    name: 'Punchy Landscape',
    description: 'Deep skies, rich foliage, strong micro-contrast',
    build: () => [
      build('levels', 'Expand Tones', {
        rgb: { inBlack: 8, inWhite: 247, gamma: 1.0, outBlack: 0, outWhite: 255 },
      } satisfies Partial<LevelsParams>),
      build('curves', 'Contrast', {
        rgb: [{ x: 0, y: 0 }, { x: 0.25, y: 0.15 }, { x: 0.75, y: 0.85 }, { x: 1, y: 1 }],
      } satisfies Partial<CurvesParams>),
      build('selectiveColor', 'Sky & Foliage', {
        colors: {
          reds: [0, 0, 0, 0], yellows: [-12, 0, 18, 4], greens: [-20, 0, 22, 6],
          cyans: [24, -6, -10, 8], blues: [18, 0, -14, 6], magentas: [0, 0, 0, 0],
          whites: [0, 0, 0, 0], neutrals: [0, 0, 0, 2], blacks: [0, 0, 0, 4],
        },
        relative: true,
      } satisfies SelectiveColorParams),
      build('vibrance', 'Vibrance', { vibrance: 30, saturation: 4 } satisfies VibranceParams),
    ],
  },
  {
    name: 'Moody Black & White',
    description: 'Red-filter monochrome with a deep contrast curve',
    build: () => [
      build('blackWhite', 'Monochrome', {
        reds: 68, yellows: 78, greens: 34, cyans: 44, blues: 14, magentas: 62,
        tint: false, tintColor: [0.85, 0.72, 0.55],
      } satisfies BlackWhiteParams),
      build('curves', 'Deep Contrast', {
        rgb: [{ x: 0, y: 0 }, { x: 0.22, y: 0.11 }, { x: 0.5, y: 0.5 }, { x: 0.78, y: 0.89 }, { x: 1, y: 1 }],
      } satisfies Partial<CurvesParams>),
    ],
  },
  {
    name: 'Duotone Poster',
    description: 'Gradient-mapped two-colour graphic look',
    build: () => [
      build('brightnessContrast', 'Contrast', { brightness: 0, contrast: 30, legacy: false } satisfies BrightnessContrastParams),
      build('gradientMap', 'Duotone', {
        stops: GRADIENT_PRESETS.find((g) => g.name === 'Duotone Blue/Pink')!.stops,
        reverse: false,
      } satisfies GradientMapParams, { opacity: 88 }),
    ],
  },
  {
    name: 'Infrared Fantasy',
    description: 'Channel-swapped foliage with a surreal palette',
    build: () => [
      build('channelMixer', 'Swap Channels', {
        r: [20, 90, 0], g: [90, 10, 0], b: [0, 10, 100], constants: [0, 0, 0],
        monochrome: false, gray: [40, 40, 20], grayConstant: 0,
      } satisfies ChannelMixerParams),
      build('hueSaturation', 'Boost', {
        bands: {
          master: { hue: 0, saturation: 12, lightness: 0 },
          reds: { hue: 0, saturation: 0, lightness: 0 },
          yellows: { hue: 0, saturation: 0, lightness: 0 },
          greens: { hue: 0, saturation: 0, lightness: 0 },
          cyans: { hue: 0, saturation: 0, lightness: 0 },
          blues: { hue: 0, saturation: 0, lightness: 0 },
          magentas: { hue: 0, saturation: 0, lightness: 0 },
        },
      } satisfies Partial<HueSaturationParams>),
      build('curves', 'Lift', {
        rgb: [{ x: 0, y: 0.03 }, { x: 0.5, y: 0.54 }, { x: 1, y: 1 }],
      } satisfies Partial<CurvesParams>),
    ],
  },
  {
    name: 'Night from Day',
    description: 'Cool, dark day-for-night conversion',
    build: () => [
      build('colorLookup', 'Night LUT', {
        preset: 'Night from Day', customId: null, customName: '', amount: 85,
      } satisfies ColorLookupParams),
      build('levels', 'Crush', {
        rgb: { inBlack: 0, inWhite: 255, gamma: 0.85, outBlack: 4, outWhite: 226 },
      } satisfies Partial<LevelsParams>),
    ],
  },
]
