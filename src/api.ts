/**
 * window.colourlab — the programmatic surface.
 *
 * The document is already JSON, so automation should write the document rather
 * than drive the UI. Two calls do what a dozen DOM-scraping ones used to:
 * `measure()` answers questions with numbers instead of screenshots, and
 * `apply()` sets the whole stack at once.
 *
 *   await colourlab.open('/photo.jpg')
 *   await colourlab.measure({ channels: true, source: 'original' })
 *   await colourlab.apply([{ kind: 'channelMixer', params: { b: [0, 100, 0] } }])
 *   await colourlab.measure({ patches: { cheek: [150, 150] } })
 *   await colourlab.export()
 */
import { useStore } from './state/store'
import { makeBitmaps } from './engine/loadImage'
import { computeMeasurements, type Measurements } from './engine/measure'
import { getFix, rankFixes, FIXES } from './engine/fixes'
import {
  makeLayer, defaultParams, defaultMask, ADJUSTMENT_META, MASK_META, BLEND_MODES,
  isSegmentedMask, needsFaceRegions,
  type AdjustmentKind, type Layer, type Mask,
} from './state/types'
import {
  DEFAULT_FUJI_RECIPE, FUJI_FILMS, buildFujiRecipe,
  type FujiRecipe,
} from './engine/fuji'
import {
  ensureSegmentation, ensureFaceRegions, peekSegmentation, forgetSegmentation,
  SEGMENT_CLASSES, personCoverage,
} from './engine/segment'
import type { Renderer } from './engine/renderer'

// --- wiring ----------------------------------------------------------------

const hooks: { renderer: Renderer | null } = { renderer: null }
let waiters: (() => void)[] = []
let framePending = false

export function setApiRenderer(r: Renderer | null) {
  hooks.renderer = r
  // A different renderer owns different textures: after a context loss the new
  // one has no segmentation at all, so the upload record has to go with the old
  // one. Leaving it set made every segmented mask sample the inert placeholder
  // and cover nothing, permanently — the guard kept reporting it as uploaded.
  uploaded = null
  // Nothing will present a frame without a renderer, so anything still flagged
  // as pending would make settle() wait out its whole timeout.
  if (!r) { framePending = false; releaseWaiters() }
}

/** Called by the render loop when it schedules a frame. */
export function markRenderPending() { framePending = true }

/**
 * Mark a frame pending the instant the document changes.
 *
 * The render effect also marks it, but React runs effects after paint — so
 * between a mutation and that effect there is a window where the canvas is
 * stale yet nothing is flagged. settle() would return immediately there and
 * hand back the previous frame's pixels, which silently fed stale
 * measurements into fix()'s refine pass.
 *
 * The slices below mirror the render effect's dependencies; any of them
 * changing guarantees that effect runs, so the flag always gets cleared.
 */
useStore.subscribe((s, prev) => {
  // With no renderer no frame is coming, and re-arming the flag here would
  // strand every later settle() on its timeout.
  if (!hooks.renderer) return
  if (
    s.layers !== prev.layers ||
    s.image !== prev.image ||
    s.zoom !== prev.zoom ||
    s.pan !== prev.pan ||
    s.compare !== prev.compare ||
    s.split !== prev.split ||
    s.maskView !== prev.maskView ||
    s.selectedId !== prev.selectedId ||
    s.surround !== prev.surround
  ) framePending = true
})

function releaseWaiters() {
  const pending = waiters
  waiters = []
  pending.forEach((fn) => fn())
}

/** Called by the render loop once a frame has been presented. */
export function notifyRendered() {
  framePending = false
  releaseWaiters()
}

/**
 * Release anything waiting on a frame that will never arrive — the context was
 * lost mid-render. Callers then fail fast on the missing renderer instead of
 * hanging until the timeout.
 */
export function abortPendingFrames() {
  framePending = false
  releaseWaiters()
}

/**
 * Resolve once the canvas reflects the current document.
 *
 * When no frame is pending the pixels are already current, so this returns
 * immediately — waiting for a frame that is never coming used to burn the
 * whole timeout, which made every measure() cost an extra 300ms.
 */
function settle(timeout = 2000): Promise<void> {
  if (!framePending) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done)
      resolve()
    }, timeout)
    waiters.push(done)
  })
}

function renderer(): Renderer {
  if (!hooks.renderer) {
    throw new Error('The graphics context is unavailable — it may still be starting or restoring.')
  }
  return hooks.renderer
}

/**
 * What is currently uploaded to the GPU, so a second segmented layer does not
 * re-upload the same 16MB-derived mask.
 *
 * Recording *which photo* is not enough — the landmark pass paints lips, eyes
 * and brows into the same array in place, so the same source can correspond to
 * two different class maps. Without the second field, running the face pass
 * after a plain `subject` mask left the earlier map on the GPU and every
 * face-region mask came out empty.
 */
let uploaded: { source: TexImageSource; faceRegions: boolean } | null = null

export function dropSegmentationUpload() {
  uploaded = null
}

/**
 * Make sure a segmented mask has something to sample before the stack renders.
 *
 * Segmentation is asynchronous and rendering is not, so this is the seam: any
 * path that can introduce one of these masks awaits it first. Until it resolves
 * the mask samples a 1x1 white texture, which selects no class and therefore
 * covers nothing — the adjustment is invisible rather than applied everywhere,
 * which is the safer way to be briefly wrong.
 *
 * Returns whether it uploaded, so a caller can decide to redraw.
 */
export async function ensureMasksReady(): Promise<boolean> {
  const state = useStore.getState()
  const img = state.image
  if (!img) return false

  const kinds = state.layers.map((l) => l.mask.kind)
  if (!kinds.some(isSegmentedMask)) return false
  const wantsFaces = kinds.some(needsFaceRegions)

  // Nothing to do only if what sits on the GPU already carries what is being
  // asked of it — the right photo *and*, for a face-region mask, the landmark
  // pass. Comparing against the cache instead would pass whenever the pass had
  // run at all, even though its result was never uploaded.
  if (uploaded && uploaded.source === img.preview && (!wantsFaces || uploaded.faceRegions)) return false

  // Runs on the preview, not the full image: the model works at 256x256 and
  // upsamples, so the full-resolution mask is identical and ten times dearer.
  const result = wantsFaces
    ? await ensureFaceRegions(img.preview)
    : await ensureSegmentation(img.preview)
  renderer().setSegmentation(result.data, result.width, result.height)
  uploaded = { source: img.preview, faceRegions: result.faceRegions }
  return true
}

// --- layer normalisation ---------------------------------------------------

export interface LayerSpec {
  kind: AdjustmentKind
  name?: string
  enabled?: boolean
  opacity?: number
  blend?: Layer['blend']
  params?: Record<string, unknown>
  mask?: Record<string, unknown>
}

const KINDS = Object.keys(ADJUSTMENT_META) as AdjustmentKind[]

const shapeOf = (v: unknown) =>
  Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v

/**
 * Describe an adjustment's parameters from its actual defaults, so this can
 * never drift from the code the way hand-written documentation does.
 */
function describeParams(kind: AdjustmentKind) {
  const d = defaultParams(kind) as unknown as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(d).map(([k, v]) => [k, { type: shapeOf(v), default: v }]),
  )
}

const METHODS = [
  { call: 'open(src, name?)', src: 'url | File | Blob | Canvas', returns: '{ name, width, height, suggestions }' },
  { call: 'measure(spec?)', spec: '{ channels?, patches?, clipping?, source?, maxSize? }', returns: 'channel stats, cast summary, named probes' },
  { call: 'apply(layers, opts?)', spec: '[{ kind, params?, opacity?, blend?, mask? }], { replace = true }', returns: '{ layers }' },
  { call: 'patch(indexOrId, params)', returns: '{ id, kind }' },
  { call: 'suggest(opts?)', returns: 'fixes this photo needs, most confident first' },
  { call: 'fix(id, opts?)', returns: 'measures, repairs, re-measures, refines' },
  { call: 'catalogue()', returns: 'every registered fix' },
  { call: 'doc() / layers()', returns: 'the recipe JSON / a compact listing' },
  { call: 'image()', returns: '{ name, width, height } of the loaded photo, or null' },
  { call: 'segment(opts?)', spec: '{ force?, faces? }', returns: 'what the segmenter found, as % of frame — check before using a segmented mask. faces:true also finds lips, eyes and brows' },
  { call: 'export(opts?)', spec: "{ format: 'png' | 'jpeg', quality?, download?, as? }", returns: '{ w, h, bytes }' },
  { call: 'reset()', returns: 'clears every layer' },
  { call: 'fuji(recipe?, opts?)', spec: 'partial Fuji Image Quality recipe → layer stack; { replace = true }', returns: '{ layers, recipe }' },
  { call: 'help(topic?)', spec: "topic: an adjustment kind, 'masks', 'fuji', or 'methods'", returns: 'this' },
]

/**
 * Mask fields carry mixed units, and nothing else in the API advertises that.
 * `center` is a 0..1 fraction while `size` beside it is a percentage, which is
 * easy to get wrong from the outside and renders an empty mask rather than an
 * error — so state the unit on every field.
 */
const MASK_FIELDS: Record<string, string> = {
  kind: `one of ${Object.keys(MASK_META).join(' | ')}`,
  invert: 'boolean — swap covered and uncovered',
  density: '0..100 percent — overall strength',
  feather: '0..100 percent — edge softness',
  center: '[x, y] as 0..1 fractions of width and height (linear, radial)',
  angle: 'degrees (linear, radial)',
  size: '1..200 PERCENT — radius (radial) or transition length (linear). Not a 0..1 fraction.',
  aspect: '10..400 percent — radial only; 100 is circular',
  lo: '0..255 luminance floor (luminance)',
  hi: '0..255 luminance ceiling (luminance)',
  target: '[r, g, b] as 0..1 — the colour to select (colorRange)',
  fuzziness: '0..200 — how far from the target to reach (colorRange)',
  strokes: 'brush only — vector strokes; never pixel data',
}

const EXAMPLE = [
  "await colourlab.open('/photo.jpg')",
  "await colourlab.measure({ channels: true, source: 'original' })  // diagnose first",
  "await colourlab.fix('remove-color-cast')                          // or repair automatically",
  "await colourlab.apply([{ kind: 'vibrance', params: { vibrance: 16 } }], { replace: false })",
  "await colourlab.measure({ patches: { cheek: [150, 150] } })      // verify with numbers",
  "await colourlab.export({ format: 'jpeg' })",
].join('\n')

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Merge one level into nested parameter groups, so a caller can write
 * `colors: { reds: [...] }` or `rgb: { inBlack: 8 }` without restating every
 * sibling. Replacing them wholesale would leave the shader reading undefined.
 */
function mergeParams(base: Record<string, unknown>, given: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(given)) {
    const prev = base[key]
    out[key] = isPlainObject(prev) && isPlainObject(value) ? { ...prev, ...value } : value
  }
  return out
}

/**
 * Reject unknown keys and wrong types up front. Without this a typo'd
 * parameter name is silently ignored and a wrong type reaches the shader as
 * NaN, which renders black — both of which are miserable to debug remotely.
 */
function validateParams(kind: AdjustmentKind, base: object, given: Record<string, unknown>) {
  const valid = Object.keys(base)
  // Shapes come from the kind's defaults, never from the layer's current
  // values: patch() passes live params, and once colorLookup.customId holds a
  // string, checking against it made the field impossible to clear again.
  const defaults = defaultParams(kind) as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(given)) {
    if (!valid.includes(key)) {
      throw new Error(`${kind}: unknown parameter "${key}". Valid: ${valid.join(', ')}`)
    }
    const want = shapeOf(defaults[key])
    const got = shapeOf(value)
    // A null default says nothing about the type a value may take —
    // colorLookup.customId defaults to null and holds a string once a .cube is
    // loaded, so type-checking against it would reject the document doc()
    // itself produced.
    if (want === 'null' || got === 'null') continue
    if (want !== got) {
      throw new Error(`${kind}.${key}: expected ${want}, got ${got}`)
    }
    if (got === 'number' && !Number.isFinite(value)) {
      throw new Error(`${kind}.${key}: ${String(value)} is not a finite number`)
    }
    if (got === 'array' && (value as unknown[]).some((n) => typeof n === 'number' && !Number.isFinite(n))) {
      throw new Error(`${kind}.${key}: array contains a non-finite number`)
    }
  }
}

/**
 * Masks were merged in unchecked while params were validated exhaustively. An
 * unrecognised kind then reached the document, and the next paint dereferenced
 * MASK_META[kind].label and took down the React tree.
 */
function normalizeMask(base: Mask, given: Record<string, unknown> | undefined): Mask {
  if (!given) return base
  const validKinds = Object.keys(MASK_META)
  for (const [key, value] of Object.entries(given)) {
    if (!(key in base)) {
      throw new Error(`mask: unknown field "${key}". Valid: ${Object.keys(base).join(', ')}`)
    }
    if (key === 'kind') {
      if (!validKinds.includes(String(value))) {
        throw new Error(`mask.kind: unknown "${String(value)}". Valid: ${validKinds.join(', ')}`)
      }
      continue
    }
    const want = shapeOf((base as unknown as Record<string, unknown>)[key])
    const got = shapeOf(value)
    if (want !== got) throw new Error(`mask.${key}: expected ${want}, got ${got}`)
  }
  return { ...base, ...given } as Mask
}

/**
 * Fill a terse spec out into a full layer. Callers only need to name the kind
 * and the parameters they actually care about.
 */
function normalizeLayer(spec: LayerSpec | Layer): Layer {
  if (!spec || typeof spec !== 'object' || !('kind' in spec)) {
    throw new Error('Each layer needs a "kind".')
  }
  if (!KINDS.includes(spec.kind)) {
    throw new Error(
      `Unknown layer kind "${spec.kind}". Valid kinds: ${KINDS.join(', ')}. ` +
      'Call colourlab.help(kind) for its parameters.',
    )
  }
  const base = makeLayer(spec.kind)

  const s = spec as LayerSpec & { id?: string }
  const given = (s.params ?? {}) as Record<string, unknown>
  validateParams(spec.kind, base.params as object, given)

  // Fall back to the layer makeLayer() would have produced, not to hardcoded
  // values — some kinds set their own defaults (Solid Colour starts in Colour
  // blend behind a brush mask), and those must survive this path too.
  return {
    ...base,
    id: s.id ?? base.id,
    name: s.name ?? base.name,
    enabled: s.enabled ?? base.enabled,
    opacity: s.opacity ?? base.opacity,
    blend: s.blend ?? base.blend,
    params: mergeParams(
      base.params as unknown as Record<string, unknown>, given,
    ) as unknown as Layer['params'],
    mask: normalizeMask(base.mask, s.mask),
  }
}

// --- measurement -----------------------------------------------------------

export interface MeasureSpec {
  /** per-channel min/max/mean and 0.1% clip points, plus a cast summary */
  channels?: boolean
  /** named probes in full-image pixel coordinates */
  patches?: Record<string, [number, number]>
  /** size of the square averaged around each patch, in source pixels */
  patchSize?: number
  /** percentage of crushed/blown pixels */
  clipping?: boolean
  /** measure the untouched source instead of the edited result */
  source?: 'result' | 'original'
  /** longest edge to sample at; smaller is faster, default 1024 */
  maxSize?: number
}

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p

/** Read the current pixels and reduce them to the shared statistics. */
function snapshot(source: 'result' | 'original', maxSize = 1024): Measurements {
  const r = renderer()
  const read = r.readPixels(source, maxSize)
  if (!read) throw new Error('No image is open.')
  return computeMeasurements(read.data, [read.w, read.h], r.fullSize)
}

// --- the API ---------------------------------------------------------------

export const colourlab = {
  version: 1,

  /** True once WebGL is up and an image can be opened. */
  get ready() { return hooks.renderer !== null },

  /**
   * The API describing itself. Tiered on purpose: the overview is small enough
   * to read cheaply, and details are fetched per topic rather than all at once.
   *
   *   help()                  overview + example
   *   help('methods')         full signatures
   *   help('curves')          one adjustment's parameters and defaults
   */
  help(topic?: string) {
    if (topic === 'methods') return { version: 1, methods: METHODS }

    if (topic === 'masks') {
      return {
        kinds: Object.fromEntries(
          Object.entries(MASK_META).map(([k, v]) => [k, v.hint]),
        ),
        fields: MASK_FIELDS,
        defaults: defaultMask(),
        note: 'Mixed units: center and target are 0..1, size and aspect are percentages.',
      }
    }

    if (topic === 'fuji') {
      return {
        what: 'Fuji-style Image Quality recipe. Compiles to ordinary adjustment layers.',
        note: 'Relative simulation — not a Fujifilm JPEG. A Look stores fixed values; this rebuilds a stack from camera-like controls.',
        defaults: DEFAULT_FUJI_RECIPE,
        films: FUJI_FILMS.map((f) => ({ id: f.id, name: f.name, hint: f.hint })),
        example: "await colourlab.fuji({ film: 'chrome', grain: 'WEAK', color: 1, clarity: 2 })",
      }
    }

    if (topic && KINDS.includes(topic as AdjustmentKind)) {
      const kind = topic as AdjustmentKind
      return {
        kind,
        label: ADJUSTMENT_META[kind].label,
        hint: ADJUSTMENT_META[kind].hint,
        params: describeParams(kind),
        note: 'Pass only the params you want to change; nested groups merge one level deep.',
      }
    }
    if (topic) {
      return { error: `No help for "${topic}".`, adjustments: KINDS, topics: ['methods', 'masks', 'fuji'] }
    }

    return {
      version: 1,
      what: 'Non-destructive photo colour editor. Write the document; do not drive the UI.',
      example: EXAMPLE,
      methods: METHODS.map((m) => m.call),
      adjustments: KINDS,
      fixes: FIXES.map((f) => f.id),
      blendModes: BLEND_MODES,
      maskKinds: Object.keys(MASK_META),
      more: "help('methods') for signatures, help('masks') for mask fields, help('fuji') for the Fuji recipe, help('<adjustment>') for its parameters",
    }
  },

  /**
   * Load an image and diagnose it. The diagnosis lives here rather than in the
   * UI so every entry point — file picker, drag and drop, automation — offers
   * the same repairs.
   */
  async open(src: string | Blob | File | HTMLCanvasElement, nameHint?: string) {
    const r = renderer()
    let source: Blob | HTMLCanvasElement
    let name = nameHint ?? 'image'
    if (typeof src === 'string') {
      source = await (await fetch(src)).blob()
      name = nameHint ?? (src.split('/').pop() || 'image')
    } else if (src instanceof Blob) {
      source = src
      name = nameHint ?? ((src as File).name || 'image')
    } else {
      source = src
    }

    const max = r.gl.getParameter(r.gl.MAX_TEXTURE_SIZE) as number
    const { full, preview } = await makeBitmaps(source, max)
    r.setImage(full, preview)
    // a new photo invalidates the old segmentation upload
    dropSegmentationUpload()
    useStore.getState().setImage({ full, preview, name, width: full.width, height: full.height })
    await settle()

    let suggestions: ReturnType<typeof rankFixes> = []
    try {
      suggestions = rankFixes(snapshot('original'))
      useStore.getState().setSuggestions(suggestions)
    } catch {
      /* a failed diagnosis must never stop the image from opening */
    }
    return { name, width: full.width, height: full.height, suggestions }
  },

  /** The current document, in the same shape as a saved recipe. */
  doc() {
    return { app: 'aiphoto', version: 1, layers: useStore.getState().layers }
  },

  /**
   * The loaded photo's name and pixel dimensions.
   *
   * Deliberately not part of doc(): that shape *is* the saved recipe, and a
   * recipe describes a treatment, not one photograph. Placing a mask needs the
   * dimensions though, and until now the only way to learn them was to run a
   * full measure().
   */
  image() {
    const img = useStore.getState().image
    if (!img) return null
    return { name: img.name, width: img.width, height: img.height }
  },

  /**
   * Segment the photo and report what was found, as fractions of the frame.
   *
   * Worth calling before reaching for a segmented mask: if `person` is near
   * zero there is nobody to mask, and a `faceSkin` layer would silently cover
   * nothing. The first call downloads the model, so it is slow once and instant
   * afterwards.
   */
  async segment(opts: { force?: boolean; faces?: boolean } = {}) {
    const img = useStore.getState().image
    if (!img) throw new Error('Open an image first.')
    // force has to drop the inference too, not just the upload — otherwise it
    // quietly returns the cached result and looks like a no-op
    if (opts.force) { forgetSegmentation(); dropSegmentationUpload() }

    const t0 = performance.now()
    const s = opts.faces
      ? await ensureFaceRegions(img.preview)
      : peekSegmentation(img.preview) ?? (await ensureSegmentation(img.preview))
    const cached = performance.now() - t0 < 2

    const coverage = Object.fromEntries(
      SEGMENT_CLASSES.map((c) => [c, +(s.coverage[c] * 100).toFixed(1)]),
    )
    return {
      size: [s.width, s.height],
      cached,
      person: +(personCoverage(s) * 100).toFixed(1),
      faces: s.faceRegions ? s.faces : 'not run — pass { faces: true }',
      coverage,
      masks: Object.keys(MASK_META).filter((k) => isSegmentedMask(k as never)),
    }
  },

  /** A compact listing — kinds and non-default settings only. */
  layers() {
    return useStore.getState().layers.map((l, i) => ({
      index: i, id: l.id, kind: l.kind, name: l.name,
      enabled: l.enabled, opacity: l.opacity, blend: l.blend,
      mask: l.mask.kind === 'none' ? undefined : l.mask.kind,
    }))
  },

  /**
   * Apply a Fuji Image Quality recipe. Controls match the camera menu
   * (film / grain / chrome / color / DR / sharpness / clarity / H&S / NR / WB)
   * and compile into ordinary layers — see help('fuji').
   */
  async fuji(partial: Partial<FujiRecipe> = {}, opts: { replace?: boolean; history?: boolean } = {}) {
    const recipe: FujiRecipe = { ...DEFAULT_FUJI_RECIPE, ...partial }
    const layers = buildFujiRecipe(recipe)
    const store = useStore.getState()
    if (opts.replace === false) store.applyLook(layers, { history: opts.history })
    else store.loadRecipe(layers, { history: opts.history })
    markRenderPending()
    await settle()
    return { layers: useStore.getState().layers.length, recipe }
  },

  /** Replace (default) or append to the stack. Accepts terse layer specs. */
  async apply(
    recipe: LayerSpec[] | { layers: LayerSpec[] },
    opts: { replace?: boolean; history?: boolean } = {},
  ) {
    const list = Array.isArray(recipe) ? recipe : recipe?.layers
    if (!Array.isArray(list)) throw new Error('apply() expects an array of layers, or { layers: [...] }.')
    const built = list.map(normalizeLayer)
    const store = useStore.getState()
    if (opts.replace === false) {
      // fresh ids so appended layers cannot collide with what is already there
      store.applyLook(built.map((l) => ({ ...l, id: makeLayer(l.kind).id })), { history: opts.history })
    } else {
      store.loadRecipe(built, { history: opts.history })
    }
    // A segmented mask has nothing to sample until its inference lands, so wait
    // for it here rather than returning a frame the caller would measure as
    // "the adjustment did nothing".
    if (await ensureMasksReady()) markRenderPending()
    await settle()
    return { layers: useStore.getState().layers.length }
  },

  /** Patch one layer's params, by index or id, without resending the stack. */
  async patch(ref: number | string, params: Record<string, unknown>) {
    const store = useStore.getState()
    const layer = typeof ref === 'number' ? store.layers[ref] : store.layers.find((l) => l.id === ref)
    if (!layer) throw new Error(`No layer ${JSON.stringify(ref)}.`)

    // The store's update is a one-level merge, so a nested group handed
    // straight to it would replace its siblings with nothing and send NaN to
    // the shader. Validate and deep-merge here exactly as apply() does, then
    // hand over a complete params object.
    const base = layer.params as unknown as Record<string, unknown>
    validateParams(layer.kind, base, params)
    store.pushHistory()
    store.updateParams(layer.id, mergeParams(base, params))
    if (await ensureMasksReady()) markRenderPending()
    await settle()
    return { id: layer.id, kind: layer.kind }
  },

  /**
   * The colour a layer receives as input, at normalised top-down coordinates.
   * What the curve eyedroppers sample: correcting against the final render
   * would fold that layer's own effect back into the correction.
   */
  sampleLayerInput(ref: number | string, u: number, v: number) {
    const layers = useStore.getState().layers
    const index = typeof ref === 'number' ? ref : layers.findIndex((l) => l.id === ref)
    if (index < 0) throw new Error(`No layer ${JSON.stringify(ref)}.`)
    return renderer().samplePixel(layers.slice(0, index), u, v)
  },

  /** Numbers about the rendered image — the replacement for eyeballing it. */
  async measure(spec: MeasureSpec = {}) {
    const r = renderer()
    await settle(300)
    const read = r.readPixels(spec.source === 'original' ? 'original' : 'result', spec.maxSize ?? 1024)
    if (!read) throw new Error('No image is open.')
    const { data, w, h } = read
    const [fullW, fullH] = r.fullSize
    const out: Record<string, unknown> = {
      source: spec.source ?? 'result',
      size: [fullW, fullH],
      sampledAt: [w, h],
    }

    if (spec.channels !== false) {
      const m = computeMeasurements(data, [w, h], [fullW, fullH])
      out.channels = m.channels
      out.luma = m.luma
      out.cast = m.cast
    }

    if (spec.clipping) {
      // Two different questions, so two different numbers. "All three at the
      // limit" is lost tone — the shadow or highlight is simply gone. "Any one
      // channel at the limit" is lost colour, which a saturated orange with no
      // blue in it has, while being nowhere near dark. Reporting only one of
      // them makes the other look like zero.
      let black = 0, blown = 0, chBlack = 0, chBlown = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2]
        if (r === 0 && g === 0 && b === 0) black++
        else if (r === 0 || g === 0 || b === 0) chBlack++
        if (r === 255 && g === 255 && b === 255) blown++
        else if (r === 255 || g === 255 || b === 255) chBlown++
      }
      const n = data.length / 4
      out.clipping = {
        blackPct: round((black / n) * 100),
        blownPct: round((blown / n) * 100),
        channelBlackPct: round((chBlack / n) * 100),
        channelBlownPct: round((chBlown / n) * 100),
      }
    }

    if (spec.patches) {
      const size = spec.patchSize ?? 7
      const patches: Record<string, unknown> = {}
      for (const [name, [px, py]] of Object.entries(spec.patches)) {
        // patch coords are in source pixels; map them onto the sampled buffer
        const cx = Math.round((px / fullW) * w)
        const cy = Math.round((py / fullH) * h)
        const half = size >> 1
        let sr = 0, sg = 0, sb = 0, n = 0
        for (let y = cy - half; y <= cy + half; y++) {
          if (y < 0 || y >= h) continue
          for (let x = cx - half; x <= cx + half; x++) {
            if (x < 0 || x >= w) continue
            const i = (y * w + x) * 4
            sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++
          }
        }
        if (!n) { patches[name] = null; continue }
        const rgb = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)]
        patches[name] = {
          rgb,
          // skin sanity: healthy skin runs R > G > B, so both ratios exceed 1
          rg: round(rgb[0] / Math.max(rgb[1], 1)),
          gb: round(rgb[1] / Math.max(rgb[2], 1)),
        }
      }
      out.patches = patches
    }

    return out
  },

  /**
   * Render at full resolution. Downloads by default; pass { as: 'dataUrl' }
   * only when the bytes are actually needed, since they are large.
   */
  async export(opts: { format?: 'png' | 'jpeg'; quality?: number; download?: boolean; as?: 'dataUrl' } = {}) {
    const r = renderer()
    const { image, layers } = useStore.getState()
    if (!image) throw new Error('No image is open.')
    const out = r.renderFullResolution(layers)
    if (!out) throw new Error('Nothing to export.')

    const cv = document.createElement('canvas')
    cv.width = out.w
    cv.height = out.h
    cv.getContext('2d')!.putImageData(new ImageData(out.data, out.w, out.h), 0, 0)
    const type = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png'
    const blob = await new Promise<Blob | null>((res) =>
      cv.toBlob(res, type, type === 'image/jpeg' ? (opts.quality ?? 0.92) : undefined))
    if (!blob) throw new Error('Encoding failed.')

    const result: Record<string, unknown> = { w: out.w, h: out.h, bytes: blob.size, type }
    if (opts.download !== false) {
      const base = image.name.replace(/\.[^.]+$/, '') || 'photo'
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${base}-edited.${opts.format === 'jpeg' ? 'jpg' : 'png'}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
      result.downloaded = a.download
    }
    if (opts.as === 'dataUrl') {
      result.dataUrl = await new Promise<string>((res) => {
        const fr = new FileReader()
        fr.onload = () => res(fr.result as string)
        fr.readAsDataURL(blob)
      })
    }
    return result
  },

  /** Every fix this photo would benefit from, most confident first. */
  async suggest(opts: { source?: 'result' | 'original' } = {}) {
    await settle(300)
    return rankFixes(snapshot(opts.source ?? 'result'))
  },

  /** All registered fixes, whether or not this photo needs them. */
  catalogue() {
    return FIXES.map((f) => ({ id: f.id, name: f.name, description: f.description }))
  },

  /**
   * Apply a fix. It measures, builds its repair, then measures again and adds
   * a refinement pass if anything is left over — the loop a person would run.
   */
  async fix(id: string, opts: { replace?: boolean } = {}) {
    const fix = getFix(id)
    if (!fix) throw new Error(`Unknown fix "${id}". Try: ${FIXES.map((f) => f.id).join(', ')}`)
    await settle(300)

    const before = snapshot(opts.replace ? 'original' : 'result')
    const built = fix.build(before)
    if (!built.length) return { id, applied: 0, layers: this.layers(), note: 'nothing to do' }

    // One snapshot for the whole repair: build and refine are two applies, and
    // undoing only the second would leave a half-corrected image.
    useStore.getState().pushHistory()
    await this.apply(built, { replace: opts.replace ?? false, history: false })

    let refined: LayerSpec[] = []
    let finalM = snapshot('result')
    if (fix.refine) {
      refined = fix.refine(finalM)
      // only re-read the pixels if the refinement actually changed them
      if (refined.length) {
        await this.apply(refined, { replace: false, history: false })
        finalM = snapshot('result')
      }
    }
    return {
      id,
      applied: built.length + refined.length,
      explanation: fix.explain(before),
      before: before.cast,
      after: finalM.cast,
      layers: this.layers(),
    }
  },

  async reset() {
    useStore.getState().clearLayers()
    await settle()
    return { layers: 0 }
  },
}

export type ColourLabApi = typeof colourlab

declare global {
  interface Window { colourlab: ColourLabApi }
}
