import { applyLook } from './presets'
import type { RGB } from './color'

/** Edge length in device pixels — enough for a 56px chip at 2×, still tiny. */
const THUMB_PX = 96
/** JPEG quality — thumbs are ~3–6 KB each. */
const JPEG_Q = 0.72

export type LookThumbMap = {
  /** Unprocessed cover crop of the current photo. */
  original: string
  /** preset name → object URL */
  looks: Record<string, string>
}

/**
 * Center-crop the source to a square and draw it into `size`×`size`.
 * Uses the interactive preview bitmap so we never touch full-res pixels.
 */
function coverSquare(
  source: CanvasImageSource,
  size: number,
): { canvas: HTMLCanvasElement; pixels: ImageData } {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const sw = 'width' in source ? Number(source.width) : size
  const sh = 'height' in source ? Number(source.height) : size
  const side = Math.min(sw, sh)
  const sx = (sw - side) / 2
  const sy = (sh - side) / 2
  ctx.drawImage(source as CanvasImageSource, sx, sy, side, side, 0, 0, size, size)
  return { canvas, pixels: ctx.getImageData(0, 0, size, size) }
}

function toJpegUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('look thumb encode failed'))
          return
        }
        resolve(URL.createObjectURL(blob))
      },
      'image/jpeg',
      JPEG_Q,
    )
  })
}

function applyLookToPixels(src: ImageData, name: string): ImageData {
  const out = new ImageData(src.width, src.height)
  const s = src.data
  const d = out.data
  const rgb: RGB = [0, 0, 0]
  for (let i = 0; i < s.length; i += 4) {
    rgb[0] = s[i] / 255
    rgb[1] = s[i + 1] / 255
    rgb[2] = s[i + 2] / 255
    const [r, g, b] = applyLook(name, rgb)
    d[i] = Math.round(r * 255)
    d[i + 1] = Math.round(g * 255)
    d[i + 2] = Math.round(b * 255)
    d[i + 3] = s[i + 3]
  }
  return out
}

function yieldFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

/** Drop every object URL in a previous thumb map. */
export function revokeLookThumbs(map: LookThumbMap | null): void {
  if (!map) return
  URL.revokeObjectURL(map.original)
  for (const url of Object.values(map.looks)) URL.revokeObjectURL(url)
}

/**
 * Bake tiny JPEG thumbnails of the current photo under each Look.
 * Yields one frame between presets so the main UI stays responsive.
 * Call `revokeLookThumbs` when the image changes or the consumer unmounts.
 */
export async function buildLookThumbs(
  source: CanvasImageSource,
  presets: readonly string[],
  signal?: AbortSignal,
): Promise<LookThumbMap> {
  const { canvas, pixels } = coverSquare(source, THUMB_PX)
  const ctx = canvas.getContext('2d')!

  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const original = await toJpegUrl(canvas)

  const looks: Record<string, string> = {}
  for (const name of presets) {
    if (signal?.aborted) {
      revokeLookThumbs({ original, looks })
      throw new DOMException('aborted', 'AbortError')
    }
    ctx.putImageData(applyLookToPixels(pixels, name), 0, 0)
    looks[name] = await toJpegUrl(canvas)
    await yieldFrame()
  }
  return { original, looks }
}
