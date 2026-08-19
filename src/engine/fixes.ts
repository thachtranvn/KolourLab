/**
 * Fixes: adjustments whose parameters are derived from the photo.
 *
 * A Look stores fixed values and is portable as a style. A Fix stores a
 * *procedure* — it measures the image and configures itself, so it can be
 * applied to any photo and still be right. Saving the colour-cast repair from
 * one portrait as a Look would wreck the next photo, because
 * "Channel Mixer: Blue <- Green 100%" describes that image's damage, not a look.
 */
import type { LayerSpec } from '../api'
import type { ChannelKey, Measurements } from './measure'

export interface Fix {
  id: string
  name: string
  description: string
  /** 0..1 — how strongly this photo needs it. Drives suggestions and ranking. */
  appliesTo(m: Measurements): number
  /** one sentence naming the evidence, shown to the user */
  explain(m: Measurements): string
  /** the repair, built from the measurements */
  build(m: Measurements): LayerSpec[]
  /**
   * Optional second pass, built from measurements taken *after* build() has
   * been applied — the same measure/act/measure loop a person would use.
   */
  refine?(after: Measurements): LayerSpec[]
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const KEYS: ChannelKey[] = ['r', 'g', 'b']
const NAME: Record<ChannelKey, string> = { r: 'red', g: 'green', b: 'blue' }
const INDEX: Record<ChannelKey, 0 | 1 | 2> = { r: 0, g: 1, b: 2 }

/** How far a channel has to be amplified to reach the top of the range. */
const stretchFor = (clipHi: number) => Math.min(255 / Math.max(clipHi, 1), 4)

/** The healthiest channel to borrow structure from; green correlates best with luminance. */
function donorFor(m: Measurements, weak: ChannelKey): ChannelKey {
  const candidates = KEYS.filter((k) => k !== weak)
  return candidates.reduce((a, b) => {
    const d = m.channels[b].clipHi - m.channels[a].clipHi
    if (d > 4) return b
    if (d < -4) return a
    return a === 'g' ? a : b === 'g' ? b : a
  })
}

const removeColorCast: Fix = {
  id: 'remove-color-cast',
  name: 'Remove colour cast',
  description: 'Rebuilds a channel that cannot reach full range, then neutralises what is left',

  appliesTo(m) {
    // White-point spread, not mean spread: a sunset is legitimately orange but
    // its highlights stay neutral, whereas a cast tints them too. Using means
    // here would flag every warm photo.
    return clamp01((m.cast.whitePointSpread - 20) / 120)
  },

  explain(m) {
    const weak = weakestByWhitePoint(m)
    const hi = m.channels[weak].clipHi
    return m.cast.looksLikeChannelDamage
      ? `The ${NAME[weak]} channel tops out at ${hi} of 255, so it cannot make a neutral highlight.`
      : `The channel white points differ by ${m.cast.whitePointSpread}, which tints the highlights.`
  },

  build(m) {
    const weak = weakestByWhitePoint(m)
    const donor = donorFor(m, weak)
    const stretch = stretchFor(m.channels[weak].clipHi)
    // How much to borrow from the donor. A mildly compressed channel can just
    // be amplified; a badly crushed one has too little real signal left, and
    // amplifying it alone would only magnify noise and JPEG chroma blocks.
    const donorWeight = clamp((stretch - 1.5) / 2, 0, 0.95)

    if (donorWeight < 0.05) {
      // Pure amplification is just a white point move; say so in the layer.
      return [{
        kind: 'levels',
        name: `Restore ${NAME[weak]}`,
        params: {
          [weak]: { inBlack: m.channels[weak].clipLo, inWhite: m.channels[weak].clipHi },
        },
      }]
    }

    const coeff: [number, number, number] = [0, 0, 0]
    coeff[INDEX[donor]] = Math.round(100 * donorWeight)
    coeff[INDEX[weak]] = Math.round(100 * (1 - donorWeight) * stretch)
    return [{
      kind: 'channelMixer',
      name: `Rebuild ${NAME[weak]}`,
      params: { [weak]: coeff.map((c) => clamp(c, -200, 200)) },
    }]
  },

  refine(after) {
    // Whatever cast survives the repair shows up as the channels' black and
    // white points still disagreeing. Correcting those is a white balance on
    // the extremes, which is far safer than pulling the channel *means*
    // together — that would grey out skin, foliage and anything else legitimately
    // coloured.
    const his = KEYS.map((k) => after.channels[k].clipHi)
    const los = KEYS.map((k) => after.channels[k].clipLo)
    const hiSpread = Math.max(...his) - Math.min(...his)
    const loSpread = Math.max(...los) - Math.min(...los)
    if (hiSpread < 6 && loSpread < 6) return []

    const params: Record<string, { inBlack: number; inWhite: number }> = {}
    for (const k of KEYS) {
      params[k] = { inBlack: after.channels[k].clipLo, inWhite: after.channels[k].clipHi }
    }
    return [{ kind: 'levels', name: 'Neutralise', params }]
  },
}

/** The channel least able to reach a neutral highlight. */
function weakestByWhitePoint(m: Measurements): ChannelKey {
  return KEYS.reduce((a, b) => (m.channels[b].clipHi < m.channels[a].clipHi ? b : a))
}

/** Where a well-exposed photo's average tone tends to sit, in 0..255. */
const TONE_TARGET = 118

const autoTone: Fix = {
  id: 'auto-tone',
  name: 'Auto tone',
  description: 'Sets the black and white points and places the midtones',

  appliesTo(m) {
    const l = m.luma
    // range the photo never uses, plus how far its average sits from where a
    // well-exposed one lands
    const unused = (l.clipLo + (255 - l.clipHi)) / 255
    const meanOff = Math.abs(l.mean - TONE_TARGET) / TONE_TARGET
    return clamp01(Math.max(unused * 2.5, meanOff * 0.8))
  },

  explain(m) {
    const plan = tonePlan(m)
    const parts: string[] = []
    if (plan.lo !== 0 || plan.hi !== 255) parts.push(`tones only span ${plan.lo}–${plan.hi} of 0–255`)
    if (plan.gamma !== 1) {
      parts.push(`the average sits at ${Math.round(m.luma.mean)} rather than about ${TONE_TARGET}`)
    }
    return parts.length ? `The ${parts.join(', and ')}.` : 'Tones are already well placed.'
  },

  build(m) {
    const plan = tonePlan(m)
    // One shared black and white point across all channels: per-channel points
    // would change the colour, which is remove-color-cast's job, not this one.
    if (!plan.changes) return []
    return [{
      kind: 'levels',
      name: 'Auto tone',
      params: { rgb: { inBlack: plan.lo, inWhite: plan.hi, gamma: plan.gamma } },
    }]
  },
}

/**
 * What Auto tone would do, computed once so explain() and build() can never
 * disagree — they used separate thresholds, and the fix could announce that
 * tones were already well placed in the same breath as correcting them.
 */
function tonePlan(m: Measurements) {
  const l = m.luma
  const lo = l.clipLo
  const hi = Math.max(l.clipHi, lo + 1)

  // Where the average lands once the ends are stretched out, and the gamma
  // that would carry it to the target. The shader raises to 1/gamma.
  const stretched = (l.mean - lo) / (hi - lo)
  let gamma = 1
  if (stretched > 0.02 && stretched < 0.98) {
    gamma = Math.log(stretched) / Math.log(TONE_TARGET / 255)
  }
  gamma = clamp(Math.round(gamma * 100) / 100, 0.55, 1.8)
  return { lo, hi, gamma, changes: lo !== 0 || hi !== 255 || gamma !== 1 }
}

export const FIXES: Fix[] = [removeColorCast, autoTone]

export const getFix = (id: string) => FIXES.find((f) => f.id === id)

/** Fixes this photo would benefit from, most confident first. */
export function rankFixes(m: Measurements) {
  return FIXES
    .map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      confidence: Math.round(f.appliesTo(m) * 100) / 100,
      explanation: f.explain(m),
    }))
    .filter((f) => f.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
}
