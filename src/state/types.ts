// ---------------------------------------------------------------------------
// Adjustment layer model.
//
// The document is a stack of non-destructive adjustment layers rendered bottom
// -> top by the WebGL pipeline. Every layer type owns a `params` shape and the
// renderer has one shader pass per type.
// ---------------------------------------------------------------------------

export type AdjustmentKind =
  | 'brightnessContrast'
  | 'levels'
  | 'curves'
  | 'exposure'
  | 'vibrance'
  | 'hueSaturation'
  | 'colorBalance'
  | 'selectiveColor'
  | 'replaceColor'
  | 'blackWhite'
  | 'channelMixer'
  | 'photoFilter'
  | 'gradientMap'
  | 'colorLookup'
  | 'solidColor'
  | 'whiteBalance'
  | 'highlightsShadows'
  | 'clarity'
  | 'sharpness'
  | 'grain'
  | 'noiseReduction'
  | 'colorChrome'

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'colorDodge'
  | 'colorBurn'
  | 'darken'
  | 'lighten'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'

export const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight',
  'colorDodge', 'colorBurn', 'darken', 'lighten', 'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity',
]

// --- per-kind parameter shapes --------------------------------------------

export interface BrightnessContrastParams {
  brightness: number // -150..150
  contrast: number // -50..100
  legacy: boolean
}

export interface LevelsChannel {
  inBlack: number // 0..255
  inWhite: number // 0..255
  gamma: number // 0.10..9.99
  outBlack: number // 0..255
  outWhite: number // 0..255
}
export interface LevelsParams {
  rgb: LevelsChannel
  r: LevelsChannel
  g: LevelsChannel
  b: LevelsChannel
}

/** Curve control points in 0..1 space, sorted by x. */
export type CurvePoints = { x: number; y: number }[]
export interface CurvesParams {
  rgb: CurvePoints
  r: CurvePoints
  g: CurvePoints
  b: CurvePoints
}

export interface ExposureParams {
  exposure: number // -5..5 stops
  offset: number // -0.5..0.5
  gamma: number // 0.1..9.99
}

export interface VibranceParams {
  vibrance: number // -100..100
  saturation: number // -100..100
}

export interface HSLBand {
  hue: number // -180..180
  saturation: number // -100..100
  lightness: number // -100..100
}
export type HueRangeKey = 'master' | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'
export interface HueSaturationParams {
  bands: Record<HueRangeKey, HSLBand>
  colorize: boolean
  colorizeHue: number // 0..360
  colorizeSaturation: number // 0..100
  colorizeLightness: number // -100..100
}

export type ToneRange = 'shadows' | 'midtones' | 'highlights'
export interface ColorBalanceParams {
  /** each triple is [cyan..red, magenta..green, yellow..blue] in -100..100 */
  shadows: [number, number, number]
  midtones: [number, number, number]
  highlights: [number, number, number]
  preserveLuminosity: boolean
}

export type SelectiveColorKey =
  | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'
  | 'whites' | 'neutrals' | 'blacks'
/** [cyan, magenta, yellow, black] each -100..100 */
export type CMYK = [number, number, number, number]
export interface SelectiveColorParams {
  colors: Record<SelectiveColorKey, CMYK>
  relative: boolean
}

export interface ReplaceColorParams {
  /** target colour picked from the image, 0..1 rgb */
  target: [number, number, number]
  fuzziness: number // 0..200
  hue: number // -180..180
  saturation: number // -100..100
  lightness: number // -100..100
  showMask: boolean
}

export interface BlackWhiteParams {
  reds: number
  yellows: number
  greens: number
  cyans: number
  blues: number
  magentas: number
  tint: boolean
  tintColor: [number, number, number]
}

export interface ChannelMixerParams {
  /** rows: output R/G/B; cols: source R/G/B contribution in -200..200 */
  r: [number, number, number]
  g: [number, number, number]
  b: [number, number, number]
  constants: [number, number, number] // -200..200
  monochrome: boolean
  /** used when monochrome is on */
  gray: [number, number, number]
  grayConstant: number
}

export interface PhotoFilterParams {
  color: [number, number, number]
  density: number // 0..100
  preserveLuminosity: boolean
  presetName: string
}

export interface GradientStop {
  /** 0..1 position along the ramp */
  t: number
  color: [number, number, number]
}
export interface GradientMapParams {
  stops: GradientStop[]
  reverse: boolean
}

export interface ColorLookupParams {
  /** name of a built-in LUT; ignored while customId is set */
  preset: string
  /**
   * Key into the custom-cube registry. The cube data itself lives outside the
   * document so undo snapshots stay cheap to clone.
   */
  customId: string | null
  customName: string
  amount: number // 0..100 blend of the LUT
}

/**
 * A flat colour. On its own it would cover the frame, so it exists to be
 * painted into an area with a brush mask — Photoshop's Solid Color fill layer,
 * and the way you tint lips, eyes or a garment without touching pixels.
 */
export interface SolidColorParams {
  color: [number, number, number]
}

/**
 * The two axes a lighting cast actually moves along: blue<->yellow and
 * green<->magenta. Oriented like every raw editor — right is warmer, right is
 * greener.
 */
export interface WhiteBalanceParams {
  /** -100 cool/blue .. +100 warm/yellow */
  temperature: number
  /** -100 magenta .. +100 green */
  tint: number
  preserveLuminosity: boolean
}

/** Lift or crush the ends of the tone scale — Fuji Highlight / Shadow. */
export interface HighlightsShadowsParams {
  /** -100 darken .. +100 brighten the bright end */
  highlights: number
  /** -100 crush .. +100 lift the dark end */
  shadows: number
}

/** Midtone local contrast (unsharp on a soft neighbourhood). */
export interface ClarityParams {
  amount: number // -100..100
}

/** Fine-detail unsharp mask. */
export interface SharpnessParams {
  amount: number // -100..100
}

/** Aesthetic film grain — not sensor noise. */
export interface GrainParams {
  amount: number // 0..100
  /** 0 = fine, 100 = coarse clumps */
  size: number
}

/**
 * Positive softens fine noise toward a neighbourhood average; negative adds
 * grain-like texture. Coarse approximation of in-camera High ISO NR.
 */
export interface NoiseReductionParams {
  amount: number // -100..100
}

/**
 * Deepen already-saturated colours without a global saturation push, plus a
 * blue-only variant (Fuji Color Chrome / Color Chrome FX Blue).
 */
export interface ColorChromeParams {
  /** 0..100 — reds, oranges, yellows, greens */
  amount: number
  /** 0..100 — blue-dominant pixels only */
  blue: number
}

export type ParamsFor<K extends AdjustmentKind> =
  K extends 'brightnessContrast' ? BrightnessContrastParams :
  K extends 'levels' ? LevelsParams :
  K extends 'curves' ? CurvesParams :
  K extends 'exposure' ? ExposureParams :
  K extends 'vibrance' ? VibranceParams :
  K extends 'hueSaturation' ? HueSaturationParams :
  K extends 'colorBalance' ? ColorBalanceParams :
  K extends 'selectiveColor' ? SelectiveColorParams :
  K extends 'replaceColor' ? ReplaceColorParams :
  K extends 'blackWhite' ? BlackWhiteParams :
  K extends 'channelMixer' ? ChannelMixerParams :
  K extends 'photoFilter' ? PhotoFilterParams :
  K extends 'gradientMap' ? GradientMapParams :
  K extends 'colorLookup' ? ColorLookupParams :
  K extends 'solidColor' ? SolidColorParams :
  K extends 'whiteBalance' ? WhiteBalanceParams :
  K extends 'highlightsShadows' ? HighlightsShadowsParams :
  K extends 'clarity' ? ClarityParams :
  K extends 'sharpness' ? SharpnessParams :
  K extends 'grain' ? GrainParams :
  K extends 'noiseReduction' ? NoiseReductionParams :
  K extends 'colorChrome' ? ColorChromeParams :
  never

// ---------------------------------------------------------------------------
// Layer masks — restrict an adjustment to part of the image.
//
// Every mask kind except 'brush' is purely parametric, so it costs nothing to
// store and undoes for free. Brush masks are kept as *stroke lists* rather than
// raster data for the same reason: the renderer bakes them into a texture and
// caches it, but the document stays small and JSON-serialisable.
// ---------------------------------------------------------------------------

export type MaskKind =
  | 'none' | 'linear' | 'radial' | 'luminance' | 'colorRange' | 'brush'
  // found by segmenting the photo rather than described by numbers
  | 'subject' | 'background' | 'faceSkin' | 'bodySkin' | 'skin' | 'hair' | 'clothes'
  // the same, but needing the face-landmark pass on top
  | 'lips' | 'eyes' | 'eyebrows' | 'iris'

/**
 * The segmented kinds and the class each selects. `subject` and `skin` are
 * unions, so they carry a list; the rest name one class.
 *
 * These are stored as *requests*, never as pixels: a segmentation describes one
 * photograph, so a recipe that carried the bitmap would be meaningless on the
 * next image, and the layer array is deep-cloned on every undo.
 */
export const SEGMENTED_MASKS = {
  subject:    ['hair', 'body-skin', 'face-skin', 'clothes', 'accessories', 'eyebrows', 'lips', 'eyes', 'iris'],
  background: ['background'],
  faceSkin:   ['face-skin'],
  bodySkin:   ['body-skin'],
  skin:       ['face-skin', 'body-skin'],
  hair:       ['hair'],
  clothes:    ['clothes'],
  lips:       ['lips'],
  eyes:       ['eyes'],
  eyebrows:   ['eyebrows'],
  iris:       ['iris'],
} as const

export type SegmentedMaskKind = keyof typeof SEGMENTED_MASKS

export const isSegmentedMask = (k: MaskKind): k is SegmentedMaskKind =>
  k in SEGMENTED_MASKS

/**
 * Kinds that need the face-landmark pass as well as the segmenter. Kept as data
 * rather than a name test so adding a region cannot forget to declare it.
 *
 * The four region kinds obviously need it. `faceSkin`, `skin` and `hair` are
 * here for a subtler reason: the pass paints lips, eyes, brows and irises *over*
 * the classes beneath them, so those three cover different pixels depending on
 * whether it has run. Without this, the same recipe on the same photo rendered
 * differently according to what happened earlier in the session — which breaks
 * the portability the whole recipe model rests on. Always running it makes
 * `faceSkin` mean "face skin with the features carved out", which is also what
 * Lightroom's Face Skin means.
 *
 * `subject`, `background`, `bodySkin` and `clothes` stay out: they either list
 * every region class already or lie outside the area the pass paints, so their
 * coverage is the same either way and they should not drag down a second model.
 */
export const FACE_REGION_MASKS = ['lips', 'eyes', 'eyebrows', 'iris', 'faceSkin', 'skin', 'hair'] as const

export const needsFaceRegions = (k: MaskKind): boolean =>
  (FACE_REGION_MASKS as readonly string[]).includes(k)

export const MASK_META: Record<MaskKind, { label: string; hint: string }> = {
  none:       { label: 'No mask (whole image)', hint: 'The adjustment applies everywhere' },
  linear:     { label: 'Linear gradient',       hint: 'Fade the adjustment across the frame — skies, vignettes' },
  radial:     { label: 'Radial gradient',       hint: 'Confine the adjustment to an oval — faces, subjects' },
  luminance:  { label: 'Luminance range',       hint: 'Target only shadows, midtones or highlights' },
  colorRange: { label: 'Colour range',          hint: 'Target one colour, like Replace Color but as a mask' },
  brush:      { label: 'Brush',                 hint: 'Paint exactly where the adjustment lands' },
  subject:    { label: 'Subject',               hint: 'Everyone in the photo, found automatically' },
  background: { label: 'Background',            hint: 'Everything behind the people' },
  faceSkin:   { label: 'Face skin',             hint: 'Facial skin only — not hair, lips or eyes' },
  bodySkin:   { label: 'Body skin',             hint: 'Neck, shoulders, arms' },
  skin:       { label: 'All skin',              hint: 'Face and body skin together' },
  hair:       { label: 'Hair',                  hint: 'Hair only' },
  clothes:    { label: 'Clothes',               hint: 'Clothing only' },
  lips:       { label: 'Lips',                  hint: 'The lips, excluding the mouth opening' },
  eyes:       { label: 'Eye whites',            hint: 'The sclera, without the iris' },
  eyebrows:   { label: 'Eyebrows',              hint: 'Both eyebrows' },
  iris:       { label: 'Iris',                  hint: 'The coloured part of the eye' },
}

export interface BrushStroke {
  mode: 'add' | 'erase'
  /** brush diameter as a fraction of the image's long edge */
  size: number
  hardness: number // 0..1
  flow: number // 0..1
  /** flat [x0,y0,x1,y1,…] in normalised image coordinates */
  points: number[]
}

export interface Mask {
  kind: MaskKind
  invert: boolean
  /** overall strength of the mask, 0..100 */
  density: number
  /** softens the mask edge, 0..100 */
  feather: number

  // linear / radial
  center: [number, number] // normalised image coords
  angle: number // degrees
  /**
   * Transition length (linear) or radius (radial), as a **percentage** of the
   * image, 1..200 — the renderer divides by 100. Not a 0..1 fraction, despite
   * the brush's own `size` next door being exactly that. It runs past 100 so a
   * radial can still cover the corners of a wide frame.
   */
  size: number
  aspect: number // radial only, percent: 100 is circular

  // luminance
  lo: number // 0..255
  hi: number // 0..255

  // colour range
  target: [number, number, number]
  fuzziness: number // 0..200

  strokes: BrushStroke[]
}

export function defaultMask(): Mask {
  return {
    kind: 'none',
    invert: false,
    density: 100,
    feather: 0,
    center: [0.5, 0.5],
    angle: 90,
    size: 50,
    aspect: 100,
    lo: 0,
    hi: 128,
    target: [0.8, 0.5, 0.35],
    fuzziness: 60,
    strokes: [],
  }
}

export interface Layer<K extends AdjustmentKind = AdjustmentKind> {
  id: string
  kind: K
  name: string
  enabled: boolean
  opacity: number // 0..100
  blend: BlendMode
  params: ParamsFor<K>
  mask: Mask
}

export interface Doc {
  layers: Layer[]
  selectedId: string | null
}

// --- defaults --------------------------------------------------------------

const flatCurve = (): CurvePoints => [{ x: 0, y: 0 }, { x: 1, y: 1 }]
const flatLevels = (): LevelsChannel => ({
  inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255,
})
const flatBand = (): HSLBand => ({ hue: 0, saturation: 0, lightness: 0 })

export const ADJUSTMENT_META: Record<AdjustmentKind, { label: string; group: string; hint: string }> = {
  brightnessContrast: { label: 'Brightness/Contrast', group: 'Light & Contrast', hint: 'Quick overall brightness and contrast' },
  levels:             { label: 'Levels',              group: 'Light & Contrast', hint: 'Shadows / midtones / highlights via histogram' },
  curves:             { label: 'Curves',              group: 'Light & Contrast', hint: 'Precise tonal control with a curve' },
  exposure:           { label: 'Exposure',            group: 'Light & Contrast', hint: 'Stops of exposure, offset and gamma' },
  vibrance:           { label: 'Vibrance',            group: 'Colour & Hue',     hint: 'Smart saturation that protects skin tones' },
  hueSaturation:      { label: 'Hue/Saturation',      group: 'Colour & Hue',     hint: 'Shift hue, saturation and lightness per colour range' },
  colorBalance:       { label: 'Color Balance',       group: 'Colour & Hue',     hint: 'Push opposing colours in shadows/mids/highlights' },
  selectiveColor:     { label: 'Selective Color',     group: 'Colour & Hue',     hint: 'CMYK tuning of one colour family at a time' },
  replaceColor:       { label: 'Replace Color',       group: 'Colour & Hue',     hint: 'Pick a colour range and recolour it' },
  blackWhite:         { label: 'Black & White',       group: 'Advanced',         hint: 'Channel-weighted monochrome with optional tint' },
  channelMixer:       { label: 'Channel Mixer',       group: 'Advanced',         hint: 'Blend R/G/B source channels into each output' },
  photoFilter:        { label: 'Photo Filter',        group: 'Advanced',         hint: 'Simulate a warming or cooling lens filter' },
  gradientMap:        { label: 'Gradient Map',        group: 'Advanced',         hint: 'Map tones onto a colour ramp' },
  colorLookup:        { label: 'Color Lookup',        group: 'Advanced',         hint: 'Apply a 3D LUT / .cube film look' },
  solidColor:         { label: 'Solid Colour',        group: 'Colour & Hue',     hint: 'Paint a colour into an area — lips, eyes, a garment' },
  whiteBalance:       { label: 'White Balance',       group: 'Colour & Hue',     hint: 'Temperature and tint — the two axes of a lighting cast' },
  highlightsShadows:  { label: 'Highlights/Shadows',  group: 'Light & Contrast', hint: 'Brighten or crush the ends of the tone scale' },
  clarity:            { label: 'Clarity',             group: 'Detail',           hint: 'Midtone local contrast — punch or soft haze' },
  sharpness:          { label: 'Sharpness',           group: 'Detail',           hint: 'Fine-edge unsharp mask' },
  grain:              { label: 'Grain',               group: 'Detail',           hint: 'Aesthetic film grain, not sensor noise' },
  noiseReduction:     { label: 'Noise Reduction',     group: 'Detail',           hint: 'Soften fine noise, or add texture when negative' },
  colorChrome:        { label: 'Color Chrome',        group: 'Colour & Hue',     hint: 'Deepen saturated colours, with a blue-only mode' },
}

export function defaultParams(kind: AdjustmentKind): ParamsFor<AdjustmentKind> {
  switch (kind) {
    case 'brightnessContrast':
      return { brightness: 0, contrast: 0, legacy: false } satisfies BrightnessContrastParams
    case 'levels':
      return { rgb: flatLevels(), r: flatLevels(), g: flatLevels(), b: flatLevels() } satisfies LevelsParams
    case 'curves':
      return { rgb: flatCurve(), r: flatCurve(), g: flatCurve(), b: flatCurve() } satisfies CurvesParams
    case 'exposure':
      return { exposure: 0, offset: 0, gamma: 1 } satisfies ExposureParams
    case 'vibrance':
      return { vibrance: 0, saturation: 0 } satisfies VibranceParams
    case 'hueSaturation':
      return {
        bands: {
          master: flatBand(), reds: flatBand(), yellows: flatBand(), greens: flatBand(),
          cyans: flatBand(), blues: flatBand(), magentas: flatBand(),
        },
        colorize: false, colorizeHue: 30, colorizeSaturation: 25, colorizeLightness: 0,
      } satisfies HueSaturationParams
    case 'colorBalance':
      return {
        shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0],
        preserveLuminosity: true,
      } satisfies ColorBalanceParams
    case 'selectiveColor':
      return {
        colors: {
          reds: [0, 0, 0, 0], yellows: [0, 0, 0, 0], greens: [0, 0, 0, 0],
          cyans: [0, 0, 0, 0], blues: [0, 0, 0, 0], magentas: [0, 0, 0, 0],
          whites: [0, 0, 0, 0], neutrals: [0, 0, 0, 0], blacks: [0, 0, 0, 0],
        },
        relative: true,
      } satisfies SelectiveColorParams
    case 'replaceColor':
      return {
        target: [0.8, 0.4, 0.3], fuzziness: 40,
        hue: 0, saturation: 0, lightness: 0, showMask: false,
      } satisfies ReplaceColorParams
    case 'blackWhite':
      return {
        reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80,
        tint: false, tintColor: [0.85, 0.72, 0.55],
      } satisfies BlackWhiteParams
    case 'channelMixer':
      return {
        r: [100, 0, 0], g: [0, 100, 0], b: [0, 0, 100],
        constants: [0, 0, 0],
        monochrome: false, gray: [40, 40, 20], grayConstant: 0,
      } satisfies ChannelMixerParams
    case 'photoFilter':
      return {
        color: [0.929, 0.596, 0.212], density: 25,
        preserveLuminosity: true, presetName: 'Warming Filter (85)',
      } satisfies PhotoFilterParams
    case 'gradientMap':
      return {
        stops: [
          { t: 0, color: [0, 0, 0] },
          { t: 1, color: [1, 1, 1] },
        ],
        reverse: false,
      } satisfies GradientMapParams
    case 'colorLookup':
      return {
        preset: 'Teal & Orange', customId: null, customName: '', amount: 100,
      } satisfies ColorLookupParams
    case 'solidColor':
      return { color: [0.85, 0.35, 0.42] } satisfies SolidColorParams
    case 'whiteBalance':
      return { temperature: 0, tint: 0, preserveLuminosity: true } satisfies WhiteBalanceParams
    case 'highlightsShadows':
      return { highlights: 0, shadows: 0 } satisfies HighlightsShadowsParams
    case 'clarity':
      return { amount: 0 } satisfies ClarityParams
    case 'sharpness':
      return { amount: 0 } satisfies SharpnessParams
    case 'grain':
      return { amount: 0, size: 35 } satisfies GrainParams
    case 'noiseReduction':
      return { amount: 0 } satisfies NoiseReductionParams
    case 'colorChrome':
      return { amount: 0, blue: 0 } satisfies ColorChromeParams
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

let counter = 0
export function makeLayer(kind: AdjustmentKind): Layer {
  counter += 1
  const layer: Layer = {
    id: `l${Date.now().toString(36)}${counter}`,
    kind,
    name: ADJUSTMENT_META[kind].label,
    enabled: true,
    opacity: 100,
    blend: 'normal',
    params: defaultParams(kind),
    mask: defaultMask(),
  }
  // A flat colour across the whole frame is never the intent. It starts with a
  // brush mask, so it appears only where painted, and in Colour blend so it
  // tints hue while leaving the underlying luminosity alone.
  if (kind === 'solidColor') {
    layer.blend = 'color'
    layer.mask.kind = 'brush'
  }
  return layer
}
