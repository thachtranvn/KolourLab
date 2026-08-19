/** Long edge used for the interactive preview; export always uses the original. */
export const PREVIEW_MAX = 2400

/**
 * Decode a source into a full-resolution bitmap plus a downscaled preview,
 * respecting the GPU's texture limit.
 */
export async function makeBitmaps(source: Blob | HTMLCanvasElement, maxTexture: number) {
  let full = source instanceof Blob
    ? await createImageBitmap(source, { imageOrientation: 'from-image' })
    : await createImageBitmap(source)

  const biggest = Math.max(full.width, full.height)
  if (biggest > maxTexture) {
    const k = maxTexture / biggest
    const next = await createImageBitmap(full, {
      resizeWidth: Math.round(full.width * k),
      resizeHeight: Math.round(full.height * k),
      resizeQuality: 'high',
    })
    full.close()
    full = next
  }

  const scale = Math.min(1, PREVIEW_MAX / Math.max(full.width, full.height))
  const preview = scale < 1
    ? await createImageBitmap(full, {
        resizeWidth: Math.round(full.width * scale),
        resizeHeight: Math.round(full.height * scale),
        resizeQuality: 'high',
      })
    : full
  return { full, preview }
}
