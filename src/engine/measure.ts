/**
 * Image statistics, shared by the automation API and the Fix registry.
 *
 * These are deliberately cheap, whole-image numbers. They exist so decisions
 * about a photo can be made from measurements rather than from looking at it.
 */

export interface ChannelStat {
  min: number
  max: number
  mean: number
  /** value below which 0.1% of pixels fall — the practical black point */
  clipLo: number
  /** value above which 0.1% of pixels sit — the practical white point */
  clipHi: number
}

export type ChannelKey = 'r' | 'g' | 'b'

export interface Measurements {
  size: [number, number]
  sampledAt: [number, number]
  channels: Record<ChannelKey, ChannelStat>
  /** Rec.601 luma, for tonal decisions that must not shift colour */
  luma: ChannelStat
  cast: {
    weakest: ChannelKey
    strongest: ChannelKey
    /** difference between the highest and lowest channel mean */
    meanSpread: number
    /** how far apart the channels' white points are — the cast signal */
    whitePointSpread: number
    weakestMax: number
    /**
     * True when a channel cannot reach the top of the range at all, which is
     * what a destroyed channel looks like as opposed to a lighting cast.
     */
    looksLikeChannelDamage: boolean
  }
}

const round = (n: number, p = 1) => Math.round(n * 10 ** p) / 10 ** p

/** Reduce a 256-bin histogram to the statistics everything else works from. */
function statFromHist(hist: Uint32Array, n: number): ChannelStat {
  let sum = 0, min = 255, max = 0
  for (let v = 0; v < 256; v++) {
    const c = hist[v]
    if (!c) continue
    sum += v * c
    if (v < min) min = v
    if (v > max) max = v
  }
  const clip = n * 0.001
  let acc = 0, clipLo = 0, clipHi = 255
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > clip) { clipLo = i; break } }
  acc = 0
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > clip) { clipHi = i; break } }
  return { min, max, mean: round(sum / n), clipLo, clipHi }
}

export function channelStat(data: Uint8ClampedArray, offset: number): ChannelStat {
  const hist = new Uint32Array(256)
  let n = 0
  for (let i = offset; i < data.length; i += 4) { hist[data[i]]++; n++ }
  return statFromHist(hist, n)
}

export function computeMeasurements(
  data: Uint8ClampedArray,
  sampledAt: [number, number],
  size: [number, number],
): Measurements {
  // One walk fills all four histograms. Four separate passes over a megapixel
  // buffer was the same work done four times.
  const hr = new Uint32Array(256), hg = new Uint32Array(256)
  const hb = new Uint32Array(256), hl = new Uint32Array(256)
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    hr[r]++; hg[g]++; hb[b]++
    hl[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++
    n++
  }
  const channels = {
    r: statFromHist(hr, n),
    g: statFromHist(hg, n),
    b: statFromHist(hb, n),
  }
  const luma = statFromHist(hl, n)
  const keys: ChannelKey[] = ['r', 'g', 'b']
  const means = keys.map((k) => [k, channels[k].mean] as const)
  const weakest = means.reduce((a, b) => (b[1] < a[1] ? b : a))
  const strongest = means.reduce((a, b) => (b[1] > a[1] ? b : a))
  const his = keys.map((k) => channels[k].clipHi)

  return {
    size,
    sampledAt,
    channels,
    luma,
    cast: {
      weakest: weakest[0],
      strongest: strongest[0],
      meanSpread: round(strongest[1] - weakest[1]),
      whitePointSpread: Math.max(...his) - Math.min(...his),
      weakestMax: channels[weakest[0]].max,
      looksLikeChannelDamage: Math.min(...his) < 200,
    },
  }
}
