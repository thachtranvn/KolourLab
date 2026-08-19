import { create } from 'zustand'
import {
  makeLayer, defaultMask,
  type AdjustmentKind, type BrushStroke, type Layer, type Mask,
} from './types'

export interface ImageInfo {
  full: ImageBitmap
  preview: ImageBitmap
  name: string
  width: number
  height: number
}

interface Snapshot {
  layers: Layer[]
  selectedId: string | null
}

export type CompareMode = 0 | 1 | 2
/** 0 off, 1 red overlay, 2 mask only */
export type MaskViewMode = 0 | 1 | 2

/**
 * Backdrops the photo can be matted against, as sRGB-encoded values.
 *
 * "18% Grey" is the real thing: an 18% reflectance grey card is 0.18 *linear*
 * luminance, which encodes to sRGB 0.4626 (#767676) — not the #808080 that
 * usually gets called middle grey. A neutral mid-grey surround is what ISO 3664
 * recommends for judging colour, because a dark surround makes everything look
 * lighter and more contrasty than it is.
 */
export const SURROUNDS = [
  { key: 'charcoal', label: 'Charcoal', value: 0.06, hint: 'Easy on the eyes; the default' },
  { key: 'black', label: 'Black', value: 0.0, hint: 'Maximum drama, least accurate' },
  { key: 'grey18', label: '18% Grey', value: 0.4626, hint: 'Neutral reference for judging colour' },
  { key: 'white', label: 'White', value: 0.93, hint: 'How it reads on a printed page' },
] as const

export type SurroundKey = typeof SURROUNDS[number]['key']

export interface Suggestion {
  id: string
  name: string
  description: string
  confidence: number
  explanation: string
}

export interface BrushSettings {
  size: number // fraction of the image's long edge
  hardness: number // 0..1
  flow: number // 0..1
  erase: boolean
}

interface State {
  image: ImageInfo | null
  layers: Layer[]
  selectedId: string | null

  past: Snapshot[]
  future: Snapshot[]

  zoom: number
  fitZoom: number
  pan: [number, number]
  compare: CompareMode
  split: number
  showHistogram: boolean
  /** set while an eyedropper is armed; receives the picked colour */
  picking: ((rgb: [number, number, number], uv: [number, number]) => void) | null

  /** layer temporarily switched off by hovering its thumbnail; never in history */
  peek: string | null

  /** fixes this photo would benefit from, refreshed when an image is opened */
  suggestions: Suggestion[]
  /** fix ids the user has waved away for this image */
  dismissed: string[]

  maskView: MaskViewMode
  /** true while the brush is the active viewer tool */
  painting: boolean
  brush: BrushSettings
  surround: SurroundKey
  /** Tab hides every panel so only the photograph is left */
  chromeHidden: boolean

  setImage: (info: ImageInfo) => void
  addLayer: (kind: AdjustmentKind) => void
  removeLayer: (id: string) => void
  duplicateLayer: (id: string) => void
  moveLayer: (id: string, dir: -1 | 1) => void
  selectLayer: (id: string | null) => void
  setLayerProp: (id: string, patch: Partial<Pick<Layer, 'enabled' | 'opacity' | 'blend' | 'name'>>) => void
  updateParams: (id: string, patch: object) => void
  updateMask: (id: string, patch: Partial<Mask>) => void
  resetMask: (id: string) => void
  /** append a finished brush stroke to the layer's mask */
  addStroke: (id: string, stroke: BrushStroke) => void
  /** extend the stroke currently being drawn, without touching history */
  extendStroke: (id: string, x: number, y: number) => void
  resetLayer: (id: string) => void
  applyLook: (layers: Layer[], opts?: { history?: boolean }) => void
  clearLayers: () => void
  loadRecipe: (layers: Layer[], opts?: { history?: boolean }) => void

  pushHistory: () => void
  undo: () => void
  redo: () => void

  setZoom: (z: number, anchor?: [number, number]) => void
  setFitZoom: (z: number) => void
  zoomToFit: () => void
  setPan: (p: [number, number]) => void
  setCompare: (c: CompareMode) => void
  setSplit: (s: number) => void
  toggleHistogram: () => void
  setPicking: (fn: ((rgb: [number, number, number], uv: [number, number]) => void) | null) => void
  setMaskView: (m: MaskViewMode) => void
  setPainting: (v: boolean) => void
  setBrush: (patch: Partial<BrushSettings>) => void
  setSurround: (s: SurroundKey) => void
  toggleChrome: () => void
  setSuggestions: (s: Suggestion[]) => void
  setPeek: (id: string | null) => void
  dismissFix: (id: string) => void
}

const snap = (s: State): Snapshot => ({
  layers: JSON.parse(JSON.stringify(s.layers)),
  selectedId: s.selectedId,
})

const HISTORY_LIMIT = 100

export const useStore = create<State>((set, get) => ({
  image: null,
  layers: [],
  selectedId: null,
  past: [],
  future: [],

  zoom: 1,
  fitZoom: 1,
  pan: [0, 0],
  compare: 0,
  split: 0.5,
  showHistogram: true,
  picking: null,
  maskView: 0,
  painting: false,
  brush: { size: 0.12, hardness: 0.5, flow: 1, erase: false },
  surround: 'charcoal',
  chromeHidden: false,
  suggestions: [],
  dismissed: [],
  peek: null,

  // a new photo gets a fresh diagnosis
  setImage: (info) => set({ image: info, pan: [0, 0], compare: 0, suggestions: [], dismissed: [] }),

  addLayer: (kind) => {
    const layer = makeLayer(kind)
    set((s) => ({
      past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
      future: [],
      // new layers go on top of the stack (rendered last)
      layers: [...s.layers, layer],
      selectedId: layer.id,
    }))
  },

  removeLayer: (id) => set((s) => {
    const idx = s.layers.findIndex((l) => l.id === id)
    if (idx < 0) return s
    const layers = s.layers.filter((l) => l.id !== id)
    const nextSel = layers[Math.min(idx, layers.length - 1)]?.id ?? null
    return {
      past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
      future: [],
      layers,
      selectedId: s.selectedId === id ? nextSel : s.selectedId,
    }
  }),

  duplicateLayer: (id) => set((s) => {
    const idx = s.layers.findIndex((l) => l.id === id)
    if (idx < 0) return s
    const copy = JSON.parse(JSON.stringify(s.layers[idx])) as Layer
    copy.id = `${id}-c${Math.random().toString(36).slice(2, 7)}`
    copy.name = `${copy.name} copy`
    const layers = [...s.layers]
    layers.splice(idx + 1, 0, copy)
    return {
      past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
      future: [],
      layers,
      selectedId: copy.id,
    }
  }),

  moveLayer: (id, dir) => set((s) => {
    const idx = s.layers.findIndex((l) => l.id === id)
    const to = idx + dir
    if (idx < 0 || to < 0 || to >= s.layers.length) return s
    const layers = [...s.layers]
    const [l] = layers.splice(idx, 1)
    layers.splice(to, 0, l)
    return { past: [...s.past, snap(s)].slice(-HISTORY_LIMIT), future: [], layers }
  }),

  selectLayer: (id) => set({ selectedId: id }),

  setLayerProp: (id, patch) => set((s) => ({
    layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
  })),

  updateParams: (id, patch) => set((s) => ({
    layers: s.layers.map((l) =>
      l.id === id ? { ...l, params: { ...(l.params as object), ...patch } as Layer['params'] } : l),
  })),

  updateMask: (id, patch) => set((s) => ({
    layers: s.layers.map((l) => (l.id === id ? { ...l, mask: { ...l.mask, ...patch } } : l)),
  })),

  resetMask: (id) => set((s) => ({
    past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
    future: [],
    layers: s.layers.map((l) => (l.id === id ? { ...l, mask: makeLayer(l.kind).mask } : l)),
  })),

  addStroke: (id, stroke) => set((s) => ({
    past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
    future: [],
    layers: s.layers.map((l) =>
      l.id === id ? { ...l, mask: { ...l.mask, strokes: [...l.mask.strokes, stroke] } } : l),
  })),

  extendStroke: (id, x, y) => set((s) => ({
    layers: s.layers.map((l) => {
      if (l.id !== id || l.mask.strokes.length === 0) return l
      const strokes = [...l.mask.strokes]
      const last = strokes[strokes.length - 1]
      strokes[strokes.length - 1] = { ...last, points: [...last.points, x, y] }
      return { ...l, mask: { ...l.mask, strokes } }
    }),
  })),

  // Reset to what makeLayer would have produced for this kind, not to blanket
  // defaults: some kinds set their own (Solid Colour lives in Colour blend).
  resetLayer: (id) => set((s) => ({
    past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
    future: [],
    layers: s.layers.map((l) => {
      if (l.id !== id) return l
      const base = makeLayer(l.kind)
      return { ...l, params: base.params, opacity: base.opacity, blend: base.blend }
    }),
  })),

  applyLook: (layers, opts = {}) => set((s) => ({
    // A multi-step operation such as fix() snapshots once itself, so that one
    // undo takes back the whole repair rather than half of it.
    past: opts.history === false ? s.past : [...s.past, snap(s)].slice(-HISTORY_LIMIT),
    // future is cleared either way: a new edit abandons the redo branch, and
    // keeping it would let redo jump to a state that no longer follows.
    future: [],
    layers: [...s.layers, ...layers],
    selectedId: layers[layers.length - 1]?.id ?? s.selectedId,
  })),

  clearLayers: () => set((s) => ({
    past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
    future: [],
    layers: [],
    selectedId: null,
  })),

  loadRecipe: (layers, opts = {}) => set((s) => {
    // Recipes written before masks existed have no mask field.
    const migrated = layers.map((l) => ({
      ...l,
      mask: { ...defaultMask(), ...(l.mask ?? {}) },
    }))
    return {
      past: opts.history === false ? s.past : [...s.past, snap(s)].slice(-HISTORY_LIMIT),
      future: [],
      layers: migrated,
      selectedId: migrated[migrated.length - 1]?.id ?? null,
    }
  }),

  pushHistory: () => set((s) => ({
    past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
    future: [],
  })),

  undo: () => {
    const s = get()
    const prev = s.past[s.past.length - 1]
    if (!prev) return
    set({
      past: s.past.slice(0, -1),
      future: [snap(s), ...s.future].slice(0, HISTORY_LIMIT),
      layers: prev.layers,
      selectedId: prev.selectedId,
    })
  },

  redo: () => {
    const s = get()
    const next = s.future[0]
    if (!next) return
    set({
      past: [...s.past, snap(s)].slice(-HISTORY_LIMIT),
      future: s.future.slice(1),
      layers: next.layers,
      selectedId: next.selectedId,
    })
  },

  setZoom: (z) => set({ zoom: Math.min(16, Math.max(0.02, z)) }),
  setFitZoom: (z) => set({ fitZoom: z }),
  zoomToFit: () => set((s) => ({ zoom: s.fitZoom, pan: [0, 0] })),
  setPan: (p) => set({ pan: p }),
  setCompare: (c) => set({ compare: c }),
  setSplit: (v) => set({ split: Math.min(1, Math.max(0, v)) }),
  toggleHistogram: () => set((s) => ({ showHistogram: !s.showHistogram })),
  setPicking: (fn) => set({ picking: fn }),
  setMaskView: (m) => set({ maskView: m }),
  setPainting: (v) => set({ painting: v }),
  setBrush: (patch) => set((s) => ({ brush: { ...s.brush, ...patch } })),
  setSurround: (v) => set({ surround: v }),
  toggleChrome: () => set((s) => ({ chromeHidden: !s.chromeHidden })),
  setSuggestions: (v) => set({ suggestions: v }),
  setPeek: (id) => set({ peek: id }),
  dismissFix: (id) => set((s) => ({ dismissed: [...s.dismissed, id] })),
}))

export const surroundValue = (key: SurroundKey) =>
  SURROUNDS.find((s) => s.key === key)?.value ?? 0.06
