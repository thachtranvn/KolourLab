import type { CurvePoints, GradientStop } from '../state/types'

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// ---------------------------------------------------------------------------
// Monotone cubic Hermite (PCHIP). Photoshop's curve overshoots slightly on
// steep control points; the monotone variant never inverts the tone order,
// which matters far more than matching that quirk.
// ---------------------------------------------------------------------------

export function sampleCurve(points: CurvePoints, x: number): number {
  const p = [...points].sort((a, b) => a.x - b.x)
  const n = p.length
  if (n === 0) return x
  if (n === 1) return clamp01(p[0].y)
  if (x <= p[0].x) return clamp01(p[0].y)
  if (x >= p[n - 1].x) return clamp01(p[n - 1].y)

  // secant slopes
  const dx: number[] = [], dy: number[] = [], m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(p[i + 1].x - p[i].x)
    dy.push(p[i + 1].y - p[i].y)
    m.push(dx[i] === 0 ? 0 : dy[i] / dx[i])
  }

  // tangents, Fritsch-Carlson limited
  const t: number[] = new Array(n)
  t[0] = m[0]
  t[n - 1] = m[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t[i] = 0
    else {
      const w1 = 2 * dx[i] + dx[i - 1]
      const w2 = dx[i] + 2 * dx[i - 1]
      t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i])
    }
  }
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0 }
  }

  let i = 0
  while (i < n - 2 && x > p[i + 1].x) i++
  const h = dx[i]
  const s = (x - p[i].x) / h
  const s2 = s * s, s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h10 = s3 - 2 * s2 + s
  const h01 = -2 * s3 + 3 * s2
  const h11 = s3 - s2
  return clamp01(h00 * p[i].y + h10 * h * t[i] + h01 * p[i + 1].y + h11 * h * t[i + 1])
}

/** Bake curves into an RGBA 256x1 lookup: master(channel(x)) per channel. */
export function bakeCurveLUT(
  rgb: CurvePoints, r: CurvePoints, g: CurvePoints, b: CurvePoints,
): Uint8Array {
  const out = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    out[i * 4 + 0] = Math.round(sampleCurve(rgb, sampleCurve(r, x)) * 255)
    out[i * 4 + 1] = Math.round(sampleCurve(rgb, sampleCurve(g, x)) * 255)
    out[i * 4 + 2] = Math.round(sampleCurve(rgb, sampleCurve(b, x)) * 255)
    out[i * 4 + 3] = 255
  }
  return out
}

/** Bake gradient stops into an RGBA 256x1 ramp. */
export function bakeGradientLUT(stops: GradientStop[], reverse: boolean): Uint8Array {
  const s = [...stops].sort((a, b) => a.t - b.t)
  const out = new Uint8Array(256 * 4)
  if (s.length === 0) return out
  for (let i = 0; i < 256; i++) {
    let t = i / 255
    if (reverse) t = 1 - t
    let c: [number, number, number]
    if (t <= s[0].t) c = s[0].color
    else if (t >= s[s.length - 1].t) c = s[s.length - 1].color
    else {
      let k = 0
      while (k < s.length - 2 && t > s[k + 1].t) k++
      const span = s[k + 1].t - s[k].t
      const f = span === 0 ? 0 : (t - s[k].t) / span
      c = [
        s[k].color[0] + (s[k + 1].color[0] - s[k].color[0]) * f,
        s[k].color[1] + (s[k + 1].color[1] - s[k].color[1]) * f,
        s[k].color[2] + (s[k + 1].color[2] - s[k].color[2]) * f,
      ]
    }
    out[i * 4 + 0] = Math.round(clamp01(c[0]) * 255)
    out[i * 4 + 1] = Math.round(clamp01(c[1]) * 255)
    out[i * 4 + 2] = Math.round(clamp01(c[2]) * 255)
    out[i * 4 + 3] = 255
  }
  return out
}

// ---------------------------------------------------------------------------
// 3D LUTs
// ---------------------------------------------------------------------------

export interface Cube {
  size: number
  /** size^3 * 3 floats, R varying fastest (Adobe .cube order) */
  data: Float32Array
}

/** Parse an Adobe/IRIDAS .cube file. Throws with a readable message on bad input. */
export function parseCube(text: string): Cube {
  let size = 0
  let domainMin = [0, 0, 0]
  let domainMax = [1, 1, 1]
  const values: number[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const upper = line.toUpperCase()
    if (upper.startsWith('TITLE')) continue
    if (upper.startsWith('LUT_1D_SIZE')) throw new Error('1D .cube files are not supported — use a 3D LUT.')
    if (upper.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue }
    if (upper.startsWith('DOMAIN_MIN')) { domainMin = line.split(/\s+/).slice(1, 4).map(Number); continue }
    if (upper.startsWith('DOMAIN_MAX')) { domainMax = line.split(/\s+/).slice(1, 4).map(Number); continue }
    const nums = line.split(/\s+/).map(Number)
    if (nums.length >= 3 && nums.every((n) => Number.isFinite(n))) values.push(nums[0], nums[1], nums[2])
  }

  if (!size || !Number.isFinite(size)) throw new Error('Missing LUT_3D_SIZE.')
  if (size < 2 || size > 64) throw new Error(`Unsupported LUT size ${size} (expected 2–64).`)
  const expected = size * size * size * 3
  if (values.length !== expected) {
    throw new Error(`Expected ${expected / 3} entries for a ${size}³ LUT, found ${values.length / 3}.`)
  }

  const data = new Float32Array(expected)
  for (let i = 0; i < expected; i++) {
    const axis = i % 3
    const span = domainMax[axis] - domainMin[axis]
    data[i] = span === 0 ? 0 : clamp01((values[i] - domainMin[axis]) / span)
  }
  return { size, data }
}

/** Build a cube by evaluating a per-colour function over the identity grid. */
export function generateCube(size: number, fn: (rgb: [number, number, number]) => [number, number, number]): Cube {
  const data = new Float32Array(size * size * size * 3)
  let i = 0
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const out = fn([ri / (size - 1), gi / (size - 1), bi / (size - 1)])
        data[i++] = clamp01(out[0])
        data[i++] = clamp01(out[1])
        data[i++] = clamp01(out[2])
      }
    }
  }
  return { size, data }
}

