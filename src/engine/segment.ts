/**
 * Subject and skin masks, from MediaPipe's selfie multiclass segmenter.
 *
 * Three decisions here were measured rather than assumed (see docs/masking.md):
 *
 * - The model works at 256x256 internally whatever it is handed. Feeding it a
 *   4240x3016 canvas produced a mask identical to the 530x377 one — coverage
 *   matched every class to 0.1% — and cost 12ms instead of 140ms. So it runs on
 *   the preview bitmap, never the full-resolution image.
 * - Everything is lazy. The runtime and weights are ~28MB against a 90KB app,
 *   so nothing is fetched until someone actually asks for one of these masks.
 * - The result is cached per image, not per layer. A segmentation is derived
 *   from the photograph, so ten layers masking different body parts share one
 *   inference — and no layer has to hold a bitmap, which keeps undo's deep
 *   clone cheap and the document free of binary data.
 */

export { SEGMENT_CLASSES, type SegmentClass } from './classes'
import { SEGMENT_CLASSES, SEGMENTER_CLASS_COUNT, type SegmentClass } from './classes'
import { paintFaceRegions } from './landmarks'

const VERSION = '1.0.1'
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite'

export interface Segmentation {
  /** one class id per pixel, row-major, top-down like every other texture here */
  data: Uint8Array
  width: number
  height: number
  /** fraction of the frame each class claims, 0..1 — drives "no person found" */
  coverage: Record<SegmentClass, number>
  /** whether the landmark pass has painted lips, eyes and brows into `data` */
  faceRegions: boolean
  /** how many faces the landmark pass found, once it has run */
  faces: number
}

type Segmenter = {
  segment(src: TexImageSource): { categoryMask?: { width: number; height: number; getAsUint8Array(): Uint8Array } }
  close(): void
}

let segmenterPromise: Promise<Segmenter> | null = null

/** Loaded once and kept — reloading the model per photo would cost 16MB again. */
async function getSegmenter(): Promise<Segmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      // dynamic so the MediaPipe glue lands in its own chunk and never touches
      // the initial load
      const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
      return (await ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      })) as unknown as Segmenter
    })().catch((e) => {
      segmenterPromise = null // let a later attempt retry rather than wedge
      throw e
    })
  }
  return segmenterPromise
}

let cache: { source: TexImageSource; result: Segmentation } | null = null
let inFlight: { source: TexImageSource; promise: Promise<Segmentation> } | null = null

/**
 * Remember failures as well as successes.
 *
 * Nothing here caches a rejection, and the loader nulls its promise on error so
 * a later attempt can retry. The React effect that drives this re-runs on every
 * layer change — so offline, dragging one slider with a segmented mask selected
 * would fire a fresh ~28MB model fetch per frame, each one rejecting. Hold the
 * failure for a while instead, and let a later attempt through once it expires.
 */
const RETRY_AFTER_MS = 30_000
let failure: { source: TexImageSource; at: number; error: unknown } | null = null

/**
 * Bumped by forgetSegmentation(). An inference that was already running writes
 * its result back only if nothing has been discarded since it started —
 * otherwise it would repopulate the cache with the very result the caller threw
 * away. Clearing the in-flight slot alone cannot prevent that; the async body
 * holds its own reference and runs to completion regardless.
 */
let generation = 0

/** Track an in-flight promise without letting its rejection escape unhandled. */
function trackInFlight(
  slot: 'base' | 'faces',
  source: TexImageSource,
  promise: Promise<Segmentation>,
) {
  const entry = { source, promise }
  if (slot === 'base') inFlight = entry
  else facesInFlight = entry
  const clear = () => {
    if (slot === 'base') { if (inFlight?.promise === promise) inFlight = null }
    else if (facesInFlight?.promise === promise) facesInFlight = null
  }
  // then(clear, clear) rather than finally(): finally returns a *new* promise
  // that rejects too, and nobody awaits it, so a failed fetch surfaced as an
  // uncaught rejection — once per retry.
  promise.then(clear, (e) => { clear(); failure = { source, at: Date.now(), error: e } })
}

/** A recent failure for this image that has not yet earned a retry. */
function heldFailure(source: TexImageSource): unknown | null {
  if (!failure || failure.source !== source) return null
  if (Date.now() - failure.at > RETRY_AFTER_MS) { failure = null; return null }
  return failure.error
}

/** The segmentation for this image if it has already been computed. */
export function peekSegmentation(source: TexImageSource): Segmentation | null {
  return cache && cache.source === source ? cache.result : null
}

export function isSegmenting(source: TexImageSource): boolean {
  return inFlight !== null && inFlight.source === source
}

/**
 * Segment an image, reusing the cached result when the same source comes back.
 * Concurrent callers share one inference rather than racing several.
 */
export function ensureSegmentation(source: TexImageSource): Promise<Segmentation> {
  const hit = peekSegmentation(source)
  if (hit) return Promise.resolve(hit)
  if (inFlight && inFlight.source === source) return inFlight.promise
  const held = heldFailure(source)
  if (held) return Promise.reject(held)

  const startedAt = generation
  const promise = (async () => {
    const segmenter = await getSegmenter()
    const res = segmenter.segment(source)
    const mask = res.categoryMask
    if (!mask) throw new Error('segmenter returned no category mask')

    const width = mask.width
    const height = mask.height
    // copy: MediaPipe reuses its own buffer for the next call
    const data = new Uint8Array(mask.getAsUint8Array())

    const result: Segmentation = {
      data, width, height, coverage: countCoverage(data), faceRegions: false, faces: 0,
    }
    if (generation === startedAt) cache = { source, result }
    return result
  })()

  trackInFlight('base', source, promise)
  return promise
}

function countCoverage(data: Uint8Array): Record<SegmentClass, number> {
  const counts = new Array(SEGMENT_CLASSES.length).fill(0)
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (v < counts.length) counts[v]++
  }
  return Object.fromEntries(
    SEGMENT_CLASSES.map((c, i) => [c, counts[i] / data.length]),
  ) as Record<SegmentClass, number>
}

let facesInFlight: { source: TexImageSource; promise: Promise<Segmentation> } | null = null

/**
 * Run the landmark pass and paint lips, eyes, eyebrows and irises into the class
 * map, on top of the segmenter's own classes.
 *
 * Separate from ensureSegmentation because it costs a second model: a `subject`
 * mask should not drag down a face model it will never look at. Once painted,
 * the map carries both, so the two masks share one texture.
 */
export function ensureFaceRegions(source: TexImageSource): Promise<Segmentation> {
  const hit = peekSegmentation(source)
  if (hit?.faceRegions) return Promise.resolve(hit)
  if (facesInFlight && facesInFlight.source === source) return facesInFlight.promise
  const held = heldFailure(source)
  if (held) return Promise.reject(held)

  const promise = (async () => {
    const base = await ensureSegmentation(source)
    if (base.faceRegions) return base
    const { faces } = await paintFaceRegions(base.data, base.width, base.height, source)
    base.faces = faces
    base.faceRegions = true
    base.coverage = countCoverage(base.data)   // lips now claim pixels face-skin used to
    return base
  })()

  trackInFlight('faces', source, promise)
  return promise
}

export const isSegmentingFaces = (source: TexImageSource) =>
  facesInFlight !== null && facesInFlight.source === source

export { SEGMENTER_CLASS_COUNT }

/** Everything that is not background. */
export function personCoverage(s: Segmentation): number {
  return 1 - s.coverage.background
}

/**
 * Discard everything known about the current image.
 *
 * The in-flight promises have to go too, not just the cache: an inference still
 * running would otherwise resolve and repopulate `cache` with exactly the result
 * the caller asked to throw away, and a `segment({ force: true })` issued
 * mid-flight would quietly return it — the no-op this flag exists to prevent.
 * Any promise already handed out still resolves; it simply no longer writes back.
 */
export function forgetSegmentation() {
  generation++
  cache = null
  inFlight = null
  facesInFlight = null
  failure = null
}
