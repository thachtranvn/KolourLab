/**
 * Lips, eyes, eyebrows and irises, from MediaPipe's Face Landmarker.
 *
 * The segmenter has no classes for these — it stops at face skin — so they come
 * from 478 landmark points instead, whose outlines are rasterised into the *same*
 * class-id map the segmenter fills. That is the whole trick: a landmark region is
 * just another class id, so it reuses the mask shader, the texture upload, the
 * bitmask selection and the per-image cache without adding anything.
 *
 * Painting order matters and encodes the anatomy: eyes are filled before irises,
 * so an iris overwrites the eye beneath it and `eyes` ends up meaning sclera —
 * which is the split Lightroom offers, and the one you want for whitening eyes
 * without touching their colour. Likewise lips overwrite face skin, so
 * `faceSkin` stops including the mouth.
 */
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { CLASS_ID, type SegmentClass } from './classes'

/** Not exported by the package, though its statics are typed with it. */
interface Connection { start: number; end: number }

const VERSION = '1.0.1'
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task'

/** Portraits here are one to three people; asking for more only costs time. */
const MAX_FACES = 3

type Landmarker = {
  detect(src: TexImageSource): { faceLandmarks: NormalizedLandmark[][] }
  close(): void
}

let landmarkerPromise: Promise<{ landmarker: Landmarker; groups: RegionGroup[] }> | null = null

interface RegionGroup {
  klass: SegmentClass
  connections: Connection[][]
}

async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, FaceLandmarker } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
      const landmarker = (await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'IMAGE',
        numFaces: MAX_FACES,
      })) as unknown as Landmarker

      // Order is the painting order: later regions sit on top of earlier ones.
      const groups: RegionGroup[] = [
        { klass: 'eyebrows', connections: [FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW] },
        { klass: 'lips', connections: [FaceLandmarker.FACE_LANDMARKS_LIPS] },
        { klass: 'eyes', connections: [FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE] },
        { klass: 'iris', connections: [FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS] },
      ]
      return { landmarker, groups }
    })().catch((e) => { landmarkerPromise = null; throw e })
  }
  return landmarkerPromise
}

/**
 * Walk a connection list into closed rings of point indices.
 *
 * MediaPipe hands out these features as unordered edge pairs, not polygons, and
 * some of them are more than one ring — the lips are an outer and an inner
 * contour. Filling those two with an even-odd rule leaves the mouth opening
 * empty, which is what "lips" should mean.
 */
function ringsFrom(connections: Connection[]): number[][] {
  const out: number[][] = []
  const edges = connections.map((c) => [c.start, c.end] as [number, number])
  const used = new Array(edges.length).fill(false)
  const from = new Map<number, number[]>()
  edges.forEach(([s], i) => {
    const list = from.get(s)
    if (list) list.push(i)
    else from.set(s, [i])
  })

  for (let seed = 0; seed < edges.length; seed++) {
    if (used[seed]) continue
    const ring: number[] = []
    let edge = seed
    // follow edges until the ring closes or runs out
    for (let guard = 0; guard < edges.length + 1; guard++) {
      used[edge] = true
      const [s, e] = edges[edge]
      ring.push(s)
      const next = (from.get(e) ?? []).find((i) => !used[i])
      if (next === undefined) { ring.push(e); break }
      edge = next
    }
    if (ring.length >= 3) out.push(ring)
  }
  return out
}

/**
 * Even-odd scanline fill of a set of rings, straight into the class map.
 *
 * Only the rings' bounding box is touched, so painting a pair of irises across a
 * 2400x1639 map costs nothing worth measuring.
 */
function fillRings(
  map: Uint8Array, w: number, h: number,
  rings: number[][], pts: NormalizedLandmark[], value: number,
) {
  const polys = rings.map((ring) => ring.map((i) => {
    const p = pts[i]
    return p ? [p.x * w, p.y * h] as [number, number] : null
  }).filter(Boolean) as [number, number][])

  let minY = Infinity, maxY = -Infinity
  for (const poly of polys) for (const [, y] of poly) {
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!isFinite(minY)) return 0

  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(h - 1, Math.ceil(maxY))
  let painted = 0
  const xs: number[] = []

  for (let y = y0; y <= y1; y++) {
    xs.length = 0
    const cy = y + 0.5
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i]
        const [bx, by] = poly[(i + 1) % poly.length]
        if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
          xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax))
        }
      }
    }
    if (xs.length < 2) continue
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const sx = Math.max(0, Math.ceil(xs[k] - 0.5))
      const ex = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5))
      for (let x = sx; x <= ex; x++) { map[y * w + x] = value; painted++ }
    }
  }
  return painted
}

/**
 * Detect faces and paint their features into an existing class map, in place.
 * Returns how many faces were found and how much of the frame each feature took.
 */
export async function paintFaceRegions(map: Uint8Array, w: number, h: number, source: TexImageSource) {
  const { landmarker, groups } = await getLandmarker()
  const res = landmarker.detect(source)
  const faces = res.faceLandmarks ?? []

  const painted: Partial<Record<SegmentClass, number>> = {}
  for (const group of groups) {
    let count = 0
    for (const pts of faces) {
      for (const connections of group.connections) {
        count += fillRings(map, w, h, ringsFrom(connections), pts, CLASS_ID[group.klass])
      }
    }
    painted[group.klass] = count / map.length
  }
  return { faces: faces.length, painted }
}
