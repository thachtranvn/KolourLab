import {
  VERT, COPY_FRAG, PRESENT_FRAG, MASK_FRAG, BRUSH_VERT, BRUSH_FRAG, buildFragment,
} from './glsl'
import { bakeCurveLUT, bakeGradientLUT, type Cube } from './lut'
import { getPresetCube, getCustomCube } from './presets'
import {
  BLEND_MODES, SEGMENTED_MASKS, isSegmentedMask,
  type AdjustmentKind, type BrushStroke, type Layer, type Mask,
} from '../state/types'
import { SEGMENT_CLASSES } from './segment'
import type {
  BrightnessContrastParams, LevelsParams, CurvesParams, ExposureParams, VibranceParams,
  HueSaturationParams, ColorBalanceParams, SelectiveColorParams, ReplaceColorParams,
  BlackWhiteParams, ChannelMixerParams, PhotoFilterParams, GradientMapParams,
  ColorLookupParams, SolidColorParams, WhiteBalanceParams, SelectiveColorKey, HueRangeKey,
  HighlightsShadowsParams, ClarityParams, SharpnessParams, GrainParams,
  NoiseReductionParams, ColorChromeParams,
} from '../state/types'

// ---------------------------------------------------------------------------
// GL plumbing
// ---------------------------------------------------------------------------

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return sh
}

function link(
  gl: WebGL2RenderingContext,
  fragSrc: string,
  vertSrc = VERT,
  attribs: string[] = ['a_pos'],
): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc)
  const p = gl.createProgram()!
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name))
  gl.linkProgram(p)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p)
    gl.deleteProgram(p)
    throw new Error(`Program link failed: ${log}`)
  }
  return p
}

class Program {
  private locs = new Map<string, WebGLUniformLocation | null>()
  constructor(readonly gl: WebGL2RenderingContext, readonly handle: WebGLProgram) {}
  loc(name: string): WebGLUniformLocation | null {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.handle, name))
    return this.locs.get(name)!
  }
  use() { this.gl.useProgram(this.handle) }
  f(n: string, v: number) { this.gl.uniform1f(this.loc(n), v) }
  fv(n: string, v: Float32Array | number[]) { this.gl.uniform1fv(this.loc(n), v) }
  i(n: string, v: number) { this.gl.uniform1i(this.loc(n), v) }
  b(n: string, v: boolean) { this.gl.uniform1i(this.loc(n), v ? 1 : 0) }
  v2(n: string, x: number, y: number) { this.gl.uniform2f(this.loc(n), x, y) }
  v3(n: string, x: number, y: number, z: number) { this.gl.uniform3f(this.loc(n), x, y, z) }
  v3v(n: string, v: Float32Array | number[]) { this.gl.uniform3fv(this.loc(n), v) }
  v4v(n: string, v: Float32Array | number[]) { this.gl.uniform4fv(this.loc(n), v) }
}

interface Target {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
  w: number
  h: number
}

export interface Histogram {
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  luma: Uint32Array
  max: number
}

const HIST_SIZE = 320

/** Texture units. Unit 0 always holds the pass input. */
const LUT_UNIT = 1
const CUBE_UNIT = 2
const MASK_UNIT = 3
const SEG_UNIT = 4
/** Unit the mask pass reads baked brush strokes from. */
const BAKED_UNIT = 1

const MASK_KIND_ID: Record<Mask['kind'], number> = {
  none: 0, linear: 1, radial: 2, luminance: 3, colorRange: 4, brush: 5,
  // every segmented kind runs the same shader branch and differs only by which
  // class bits it selects
  subject: 6, background: 6, faceSkin: 6, bodySkin: 6, skin: 6, hair: 6, clothes: 6,
  lips: 6, eyes: 6, eyebrows: 6, iris: 6,
}

/**
 * Which class ids a segmented mask selects, as a bitmask the shader can test in
 * one operation. Non-segmented kinds select nothing, which is inert because
 * they never reach that branch.
 */
function segClassBits(kind: Mask['kind']): number {
  if (!isSegmentedMask(kind)) return 0
  let bits = 0
  for (const name of SEGMENTED_MASKS[kind]) {
    const i = SEGMENT_CLASSES.indexOf(name)
    if (i >= 0) bits |= 1 << i
  }
  return bits
}

/** Photoshop's default brush spacing: a dab every 25% of the diameter. */
const DAB_SPACING = 0.25
const MAX_DABS_PER_STROKE = 20000

interface Baked {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
  signature: string
}

/** Cheap identity for a stroke list — changes whenever the strokes do. */
function strokeSignature(strokes: BrushStroke[]): string {
  return strokes.map((s) => `${s.mode}:${s.size}:${s.hardness}:${s.flow}:${s.points.length}`).join('|')
}

// ---------------------------------------------------------------------------

export class Renderer {
  readonly gl: WebGL2RenderingContext
  private quad: WebGLVertexArrayObject
  private brushVao: WebGLVertexArrayObject
  private instanceBuf: WebGLBuffer
  private programs = new Map<string, Program>()
  private copyProg: Program
  private presentProg: Program
  private maskProg: Program
  private brushProg: Program
  private floatOk: boolean

  /** full-resolution source, and a downscaled copy used for interactive edits */
  private fullTex: WebGLTexture | null = null
  private previewTex: WebGLTexture | null = null
  fullSize: [number, number] = [0, 0]
  previewSize: [number, number] = [0, 0]

  private ping: Target | null = null
  private pong: Target | null = null
  private histTarget: Target | null = null
  private lastResult: WebGLTexture | null = null

  private lutCache = new Map<string, { tex: WebGLTexture; key: string }>()
  private cubeCache = new Map<string, { tex: WebGLTexture; key: string; size: number }>()
  private bakedCache = new Map<string, Baked>()

  private maskTarget: Target | null = null
  private maskView: Target | null = null
  /** layer whose mask should be copied out for the on-canvas overlay */
  maskViewLayerId: string | null = null
  private whiteTex: WebGLTexture | null = null
  /** class ids from the segmenter, one byte per pixel; null until one is run */
  private segTex: WebGLTexture | null = null

  /** CPU copy of the preview pixels, for the eyedropper */
  private pickData: ImageData | null = null

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('WebGL2 is not available in this browser.')
    this.gl = gl
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float')

    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    this.quad = vao

    // Unit quad + per-dab instance attributes for the brush.
    const bvao = gl.createVertexArray()!
    gl.bindVertexArray(bvao)
    const quadBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.instanceBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(1, 1)
    gl.bindVertexArray(null)
    this.brushVao = bvao

    this.copyProg = new Program(gl, link(gl, COPY_FRAG))
    this.presentProg = new Program(gl, link(gl, PRESENT_FRAG))
    this.maskProg = new Program(gl, link(gl, MASK_FRAG))
    this.brushProg = new Program(gl, link(gl, BRUSH_FRAG, BRUSH_VERT, ['a_pos', 'a_dab']))

    // 1x1 white, bound wherever a mask sampler must stay inert
    this.whiteTex = this.makeTexture()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]))
  }

  /**
   * Upload a segmentation's class ids for the segmented mask kinds to sample.
   *
   * NEAREST filtering is not optional: these are class *ids*, and linear
   * filtering would blend class 1 against class 3 and produce a phantom class 2
   * along every boundary. The mask shader softens the edge afterwards, by
   * averaging class *matches* rather than ids.
   */
  setSegmentation(data: Uint8Array, w: number, h: number) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + SEG_UNIT)
    if (!this.segTex) this.segTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.segTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    // creating or uploading binds to the active unit, so restore the pass input
    gl.activeTexture(gl.TEXTURE0)
  }

  get hasSegmentation() { return this.segTex !== null }

  private progFor(kind: AdjustmentKind): Program {
    let p = this.programs.get(kind)
    if (!p) {
      p = new Program(this.gl, link(this.gl, buildFragment(kind)))
      this.programs.set(kind, p)
    }
    return p
  }

  // --- resources ----------------------------------------------------------

  private makeTexture(): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private makeTarget(w: number, h: number, float: boolean): Target {
    const gl = this.gl
    const tex = this.makeTexture()
    const useFloat = float && this.floatOk
    gl.texImage2D(
      gl.TEXTURE_2D, 0, useFloat ? gl.RGBA16F : gl.RGBA8, w, h, 0,
      gl.RGBA, useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null,
    )
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { fbo, tex, w, h }
  }

  private freeTarget(t: Target | null) {
    if (!t) return
    this.gl.deleteFramebuffer(t.fbo)
    this.gl.deleteTexture(t.tex)
  }

  private ensureTargets(w: number, h: number) {
    if (this.ping && this.ping.w === w && this.ping.h === h) return
    this.freeTarget(this.ping)
    this.freeTarget(this.pong)
    this.ping = this.makeTarget(w, h, true)
    this.pong = this.makeTarget(w, h, true)
  }

  /** Upload a full-resolution bitmap plus an interactive-resolution preview. */
  setImage(full: ImageBitmap, preview: ImageBitmap) {
    const gl = this.gl
    // NB: UNPACK_FLIP_Y_WEBGL is invalid for ImageBitmap uploads, so every
    // texture and framebuffer here is top-down. Only present() flips.
    if (this.fullTex) gl.deleteTexture(this.fullTex)
    if (this.previewTex) gl.deleteTexture(this.previewTex)

    this.fullTex = this.makeTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.fullTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, full)
    this.fullSize = [full.width, full.height]

    this.previewTex = this.makeTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.previewTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, preview)
    this.previewSize = [preview.width, preview.height]

    // CPU snapshot of the preview for eyedropper sampling
    const c = document.createElement('canvas')
    c.width = preview.width
    c.height = preview.height
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(preview, 0, 0)
    this.pickData = ctx.getImageData(0, 0, preview.width, preview.height)

    this.ensureTargets(preview.width, preview.height)
    this.lastResult = this.previewTex
  }

  get hasImage() { return this.previewTex !== null }
  get originalTexture() { return this.previewTex }

  /** Drop the current photo so the canvas returns to an empty mat. */
  clearImage() {
    const gl = this.gl
    if (this.fullTex) { gl.deleteTexture(this.fullTex); this.fullTex = null }
    if (this.previewTex) { gl.deleteTexture(this.previewTex); this.previewTex = null }
    this.fullSize = [0, 0]
    this.previewSize = [0, 0]
    this.pickData = null
    this.lastResult = null
    this.freeTarget(this.ping); this.ping = null
    this.freeTarget(this.pong); this.pong = null
  }

  /** Sample the untouched source colour at image-space coordinates (0..1). */
  pick(u: number, v: number): [number, number, number] | null {
    const d = this.pickData
    if (!d) return null
    const x = Math.min(d.width - 1, Math.max(0, Math.round(u * (d.width - 1))))
    const y = Math.min(d.height - 1, Math.max(0, Math.round(v * (d.height - 1))))
    const i = (y * d.width + x) * 4
    return [d.data[i] / 255, d.data[i + 1] / 255, d.data[i + 2] / 255]
  }

  // --- LUT resources ------------------------------------------------------

  /**
   * Binds the layer's 1D lookup on unit LUT_UNIT and returns it. Selecting the
   * unit first matters: creating or uploading a texture binds it to whatever
   * unit is active, which would otherwise clobber the source image on unit 0.
   */
  private lutTexture(id: string, key: string, build: () => Uint8Array): WebGLTexture {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + LUT_UNIT)
    const cached = this.lutCache.get(id)
    if (cached && cached.key === key) {
      gl.bindTexture(gl.TEXTURE_2D, cached.tex)
      return cached.tex
    }
    const tex = cached?.tex ?? this.makeTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, build())
    this.lutCache.set(id, { tex, key })
    return tex
  }

  /** Same contract as lutTexture, on CUBE_UNIT with a 3D target. */
  private cubeTexture(id: string, key: string, cube: Cube): { tex: WebGLTexture; size: number } {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + CUBE_UNIT)
    const cached = this.cubeCache.get(id)
    if (cached && cached.key === key) {
      gl.bindTexture(gl.TEXTURE_3D, cached.tex)
      return { tex: cached.tex, size: cached.size }
    }
    const tex = cached?.tex ?? gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    const n = cube.size
    const rgba = new Uint8Array(n * n * n * 4)
    for (let i = 0, j = 0; i < n * n * n; i++) {
      rgba[i * 4 + 0] = Math.round(cube.data[j++] * 255)
      rgba[i * 4 + 1] = Math.round(cube.data[j++] * 255)
      rgba[i * 4 + 2] = Math.round(cube.data[j++] * 255)
      rgba[i * 4 + 3] = 255
    }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
    this.cubeCache.set(id, { tex, key, size: n })
    return { tex, size: n }
  }

  /** Drop cached GPU resources for layers that no longer exist. */
  pruneCaches(liveIds: Set<string>) {
    for (const [id, v] of this.lutCache) {
      if (!liveIds.has(id)) { this.gl.deleteTexture(v.tex); this.lutCache.delete(id) }
    }
    for (const [id, v] of this.cubeCache) {
      if (!liveIds.has(id)) { this.gl.deleteTexture(v.tex); this.cubeCache.delete(id) }
    }
    for (const [id, v] of this.bakedCache) {
      if (!liveIds.has(id)) {
        this.gl.deleteTexture(v.tex)
        this.gl.deleteFramebuffer(v.fbo)
        this.bakedCache.delete(id)
      }
    }
  }

  // --- brush strokes ------------------------------------------------------

  /** Walk a stroke's polyline and emit evenly spaced dabs. */
  private dabsFor(stroke: BrushStroke, w: number, h: number): Float32Array {
    const long = Math.max(w, h)
    const radiusPx = Math.max(0.5, (stroke.size * long) / 2)
    const rx = radiusPx / w
    const spacing = Math.max(radiusPx * DAB_SPACING, 0.75)
    const pts = stroke.points
    const out: number[] = []

    const push = (x: number, y: number) => {
      if (out.length / 4 < MAX_DABS_PER_STROKE) out.push(x, y, rx, stroke.flow)
    }

    if (pts.length < 4) {
      if (pts.length >= 2) push(pts[0], pts[1])
    } else {
      let carry = 0
      push(pts[0], pts[1])
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const x0 = pts[i] * w, y0 = pts[i + 1] * h
        const x1 = pts[i + 2] * w, y1 = pts[i + 3] * h
        const seg = Math.hypot(x1 - x0, y1 - y0)
        if (seg <= 1e-6) continue
        let d = spacing - carry
        while (d <= seg) {
          const t = d / seg
          push((x0 + (x1 - x0) * t) / w, (y0 + (y1 - y0) * t) / h)
          d += spacing
        }
        carry = (carry + seg) % spacing
      }
    }
    return new Float32Array(out)
  }

  /**
   * Rebuild a layer's brush mask raster from its stroke list. Strokes are the
   * source of truth, so undo is just "render one fewer stroke".
   */
  private bakedTexture(layer: Layer): WebGLTexture {
    const gl = this.gl
    const [w, h] = this.fullSize
    const signature = strokeSignature(layer.mask.strokes)
    let baked = this.bakedCache.get(layer.id)

    if (baked && baked.w === w && baked.h === h && baked.signature === signature) return baked.tex

    if (!baked || baked.w !== w || baked.h !== h) {
      if (baked) { gl.deleteTexture(baked.tex); gl.deleteFramebuffer(baked.fbo) }
      gl.activeTexture(gl.TEXTURE0 + BAKED_UNIT)
      const tex = this.makeTexture()
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null)
      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      baked = { tex, fbo, w, h, signature: '' }
      this.bakedCache.set(layer.id, baked)
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, baked.fbo)
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const prog = this.brushProg
    prog.use()
    prog.f('u_aspect', w / h)
    gl.bindVertexArray(this.brushVao)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)

    for (const stroke of layer.mask.strokes) {
      const dabs = this.dabsFor(stroke, w, h)
      if (!dabs.length) continue
      gl.blendEquation(stroke.mode === 'erase' ? gl.MIN : gl.MAX)
      prog.f('u_hardness', stroke.hardness)
      prog.b('u_erase', stroke.mode === 'erase')
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf)
      gl.bufferData(gl.ARRAY_BUFFER, dabs, gl.DYNAMIC_DRAW)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, dabs.length / 4)
    }

    gl.blendEquation(gl.FUNC_ADD)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    baked.signature = signature
    return baked.tex
  }

  // --- masks --------------------------------------------------------------

  private ensureMaskTargets(w: number, h: number) {
    if (this.maskTarget && this.maskTarget.w === w && this.maskTarget.h === h) return
    this.freeTarget(this.maskTarget)
    this.maskTarget = this.makeTarget(w, h, false)
  }

  /** Render a layer's mask into maskTarget and return it, or null if unmasked. */
  private renderMask(layer: Layer, srcTex: WebGLTexture, w: number, h: number): Target | null {
    const m = layer.mask
    if (m.kind === 'none') return null
    // A brush mask with no strokes stays empty rather than falling back to
    // "no mask" — otherwise the effect covers everything until the first
    // stroke, then suddenly collapses to just that stroke.

    const gl = this.gl
    const target = (this.maskTarget && this.maskTarget.w === w && this.maskTarget.h === h)
      ? this.maskTarget
      : (this.ensureMaskTargets(w, h), this.maskTarget!)

    // bake first: it binds its own framebuffer and would clobber ours
    const baked = m.kind === 'brush' ? this.bakedTexture(layer) : this.whiteTex!

    const prog = this.maskProg
    prog.use()
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, w, h)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    prog.i('u_src', 0)
    gl.activeTexture(gl.TEXTURE0 + BAKED_UNIT)
    gl.bindTexture(gl.TEXTURE_2D, baked)
    prog.i('u_baked', BAKED_UNIT)

    gl.activeTexture(gl.TEXTURE0 + SEG_UNIT)
    gl.bindTexture(gl.TEXTURE_2D, this.segTex ?? this.whiteTex!)
    prog.i('u_seg', SEG_UNIT)
    prog.i('u_segMask', segClassBits(m.kind))
    prog.b('u_segReady', this.segTex !== null)

    prog.i('u_kind', MASK_KIND_ID[m.kind])
    prog.b('u_invert', m.invert)
    prog.f('u_density', m.density / 100)
    prog.f('u_feather', m.feather / 100)
    prog.v2('u_center', m.center[0], m.center[1])
    prog.f('u_angle', (m.angle * Math.PI) / 180)
    prog.f('u_size', m.size / 100)
    prog.f('u_aspect', m.aspect / 100)
    prog.v2('u_range', m.lo / 255, m.hi / 255)
    prog.v3('u_target', m.target[0], m.target[1], m.target[2])
    prog.f('u_fuzz', (m.fuzziness / 200) * 1.6 + 0.004)
    prog.v2('u_texel', 1 / w, 1 / h)

    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return target
  }

  private copyInto(src: WebGLTexture, dst: Target) {
    const gl = this.gl
    this.copyProg.use()
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
    gl.viewport(0, 0, dst.w, dst.h)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src)
    this.copyProg.i('u_tex', 0)
    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  // --- the pipeline -------------------------------------------------------

  private drawQuad() {
    const gl = this.gl
    gl.bindVertexArray(this.quad)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }

  private runPass(layer: Layer, srcTex: WebGLTexture, dst: Target) {
    const gl = this.gl

    // The mask pass reads srcTex too, so it has to happen before we bind for
    // the adjustment itself.
    const mask = this.renderMask(layer, srcTex, dst.w, dst.h)
    if (mask && layer.id === this.maskViewLayerId) {
      if (!this.maskView || this.maskView.w !== dst.w || this.maskView.h !== dst.h) {
        this.freeTarget(this.maskView)
        this.maskView = this.makeTarget(dst.w, dst.h, false)
      }
      this.copyInto(mask.tex, this.maskView)
    }

    const prog = this.progFor(layer.kind)
    prog.use()

    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
    gl.viewport(0, 0, dst.w, dst.h)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    prog.i('u_src', 0)
    prog.f('u_opacity', layer.opacity / 100)
    prog.i('u_blend', Math.max(0, BLEND_MODES.indexOf(layer.blend)))

    gl.activeTexture(gl.TEXTURE0 + MASK_UNIT)
    gl.bindTexture(gl.TEXTURE_2D, mask ? mask.tex : this.whiteTex!)
    prog.i('u_mask', MASK_UNIT)
    prog.b('u_useMask', mask !== null)
    // Neighbourhood adjustments (clarity, sharpness, grain, NR) sample by texel.
    // Harmless for the rest — unused uniforms are ignored.
    prog.v2('u_texel', 1 / dst.w, 1 / dst.h)

    this.setParamUniforms(prog, layer)
    this.drawQuad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Chain every enabled layer from srcTex through the two ping-pong targets. */
  private runStack(layers: Layer[], srcTex: WebGLTexture, a: Target, b: Target): WebGLTexture {
    let src = srcTex
    let t1 = a, t2 = b
    for (const layer of layers.filter((l) => l.enabled && l.opacity > 0)) {
      this.runPass(layer, src, t1)
      src = t1.tex
      const t = t1; t1 = t2; t2 = t
    }
    return src
  }

  private setParamUniforms(prog: Program, layer: Layer) {
    switch (layer.kind) {
      case 'brightnessContrast': {
        const p = layer.params as BrightnessContrastParams
        prog.f('u_brightness', p.brightness / 150)
        prog.f('u_contrast', p.contrast >= 0 ? p.contrast / 100 : p.contrast / 50)
        prog.b('u_legacy', p.legacy)
        break
      }
      case 'levels': {
        const p = layer.params as LevelsParams
        prog.v3('u_inBlack', p.r.inBlack / 255, p.g.inBlack / 255, p.b.inBlack / 255)
        prog.v3('u_inWhite', p.r.inWhite / 255, p.g.inWhite / 255, p.b.inWhite / 255)
        prog.v3('u_gamma', p.r.gamma, p.g.gamma, p.b.gamma)
        prog.v3('u_outBlack', p.r.outBlack / 255, p.g.outBlack / 255, p.b.outBlack / 255)
        prog.v3('u_outWhite', p.r.outWhite / 255, p.g.outWhite / 255, p.b.outWhite / 255)
        prog.f('u_mInBlack', p.rgb.inBlack / 255)
        prog.f('u_mInWhite', p.rgb.inWhite / 255)
        prog.f('u_mGamma', p.rgb.gamma)
        prog.f('u_mOutBlack', p.rgb.outBlack / 255)
        prog.f('u_mOutWhite', p.rgb.outWhite / 255)
        break
      }
      case 'curves': {
        const p = layer.params as CurvesParams
        this.lutTexture(layer.id, JSON.stringify(p), () => bakeCurveLUT(p.rgb, p.r, p.g, p.b))
        prog.i('u_lut', LUT_UNIT)
        break
      }
      case 'exposure': {
        const p = layer.params as ExposureParams
        prog.f('u_exposure', p.exposure)
        prog.f('u_offset', p.offset)
        prog.f('u_gammaC', p.gamma)
        break
      }
      case 'vibrance': {
        const p = layer.params as VibranceParams
        prog.f('u_vibrance', p.vibrance / 100)
        prog.f('u_saturation', p.saturation / 100)
        break
      }
      case 'hueSaturation': {
        const p = layer.params as HueSaturationParams
        const m = p.bands.master
        prog.v3('u_master', m.hue / 360, m.saturation / 100, m.lightness / 100)
        const order: HueRangeKey[] = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']
        const arr = new Float32Array(18)
        order.forEach((k, i) => {
          const b = p.bands[k]
          arr[i * 3 + 0] = b.hue / 360
          arr[i * 3 + 1] = b.saturation / 100
          arr[i * 3 + 2] = b.lightness / 100
        })
        prog.v3v('u_bands', arr)
        prog.b('u_colorize', p.colorize)
        prog.v3('u_colorizeHSL', p.colorizeHue / 360, p.colorizeSaturation / 100, p.colorizeLightness / 100)
        break
      }
      case 'colorBalance': {
        const p = layer.params as ColorBalanceParams
        prog.v3('u_shadows', p.shadows[0] / 100, p.shadows[1] / 100, p.shadows[2] / 100)
        prog.v3('u_midtones', p.midtones[0] / 100, p.midtones[1] / 100, p.midtones[2] / 100)
        prog.v3('u_highlights', p.highlights[0] / 100, p.highlights[1] / 100, p.highlights[2] / 100)
        prog.b('u_preserveLum', p.preserveLuminosity)
        break
      }
      case 'selectiveColor': {
        const p = layer.params as SelectiveColorParams
        const order: SelectiveColorKey[] = [
          'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks',
        ]
        const arr = new Float32Array(36)
        order.forEach((k, i) => {
          const v = p.colors[k]
          for (let j = 0; j < 4; j++) arr[i * 4 + j] = v[j] / 100
        })
        prog.v4v('u_sc', arr)
        prog.b('u_relative', p.relative)
        break
      }
      case 'replaceColor': {
        const p = layer.params as ReplaceColorParams
        prog.v3('u_target', p.target[0], p.target[1], p.target[2])
        prog.f('u_fuzz', (p.fuzziness / 200) * 1.6 + 0.004)
        prog.v3('u_shift', p.hue / 360, p.saturation / 100, p.lightness / 100)
        prog.b('u_showMask', p.showMask)
        break
      }
      case 'blackWhite': {
        const p = layer.params as BlackWhiteParams
        prog.fv('u_w', [p.reds, p.yellows, p.greens, p.cyans, p.blues, p.magentas].map((v) => v / 100))
        prog.b('u_tint', p.tint)
        prog.v3('u_tintColor', p.tintColor[0], p.tintColor[1], p.tintColor[2])
        break
      }
      case 'channelMixer': {
        const p = layer.params as ChannelMixerParams
        prog.v3('u_mr', p.r[0] / 100, p.r[1] / 100, p.r[2] / 100)
        prog.v3('u_mg', p.g[0] / 100, p.g[1] / 100, p.g[2] / 100)
        prog.v3('u_mb', p.b[0] / 100, p.b[1] / 100, p.b[2] / 100)
        prog.v3('u_const', p.constants[0] / 100, p.constants[1] / 100, p.constants[2] / 100)
        prog.b('u_mono', p.monochrome)
        prog.v3('u_gray', p.gray[0] / 100, p.gray[1] / 100, p.gray[2] / 100)
        prog.f('u_grayConst', p.grayConstant / 100)
        break
      }
      case 'photoFilter': {
        const p = layer.params as PhotoFilterParams
        prog.v3('u_color', p.color[0], p.color[1], p.color[2])
        prog.f('u_density', p.density / 100)
        prog.b('u_preserveLum', p.preserveLuminosity)
        break
      }
      case 'gradientMap': {
        const p = layer.params as GradientMapParams
        this.lutTexture(layer.id, JSON.stringify(p), () => bakeGradientLUT(p.stops, p.reverse))
        prog.i('u_lut', LUT_UNIT)
        break
      }
      case 'whiteBalance': {
        const p = layer.params as WhiteBalanceParams
        prog.f('u_temp', p.temperature / 100)
        prog.f('u_tint', p.tint / 100)
        prog.b('u_preserveLum', p.preserveLuminosity)
        break
      }
      case 'solidColor': {
        const p = layer.params as SolidColorParams
        prog.v3('u_color', p.color[0], p.color[1], p.color[2])
        break
      }
      case 'colorLookup': {
        const p = layer.params as ColorLookupParams
        const custom = p.customId ? getCustomCube(p.customId) : null
        const cube: Cube = custom ?? getPresetCube(p.preset)
        const key = custom ? `custom:${p.customId}` : `preset:${p.preset}`
        const { size } = this.cubeTexture(layer.id, key, cube)
        prog.i('u_cube', CUBE_UNIT)
        prog.f('u_lutSize', size)
        prog.f('u_amount', p.amount / 100)
        break
      }
      case 'highlightsShadows': {
        const p = layer.params as HighlightsShadowsParams
        prog.f('u_highlights', p.highlights / 100)
        prog.f('u_shadows', p.shadows / 100)
        break
      }
      case 'clarity': {
        const p = layer.params as ClarityParams
        prog.f('u_amount', p.amount / 100)
        break
      }
      case 'sharpness': {
        const p = layer.params as SharpnessParams
        prog.f('u_amount', p.amount / 100)
        break
      }
      case 'grain': {
        const p = layer.params as GrainParams
        prog.f('u_amount', p.amount / 100)
        prog.f('u_size', p.size / 100)
        break
      }
      case 'noiseReduction': {
        const p = layer.params as NoiseReductionParams
        prog.f('u_amount', p.amount / 100)
        break
      }
      case 'colorChrome': {
        const p = layer.params as ColorChromeParams
        prog.f('u_amount', p.amount / 100)
        prog.f('u_blue', p.blue / 100)
        break
      }
      default: {
        const _exhaustive: never = layer.kind
        void _exhaustive
      }
    }
  }

  /** Run the whole stack at preview resolution. Returns the resulting texture. */
  render(layers: Layer[]): WebGLTexture | null {
    if (!this.previewTex) return null
    const [w, h] = this.previewSize
    this.ensureTargets(w, h)
    this.lastResult = this.runStack(layers, this.previewTex, this.ping!, this.pong!)
    return this.lastResult
  }

  /** Draw the last render onto the visible canvas. */
  present(opts: {
    zoom: number
    pan: [number, number]
    compare: 0 | 1 | 2
    split: number
    maskMode?: 0 | 1 | 2
    /** sRGB value of the mat the photo sits on */
    surround?: number
  }) {
    const gl = this.gl
    const canvas = this.canvas
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const ch = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }

    const surround = opts.surround ?? 0.06
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, cw, ch)
    gl.clearColor(surround, surround, surround, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!this.previewTex || !this.lastResult) return

    const p = this.presentProg
    p.use()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.lastResult)
    p.i('u_result', 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.previewTex)
    p.i('u_original', 1)
    p.v2('u_canvasSize', cw, ch)
    p.v2('u_imageSize', this.previewSize[0], this.previewSize[1])
    // zoom is expressed against the full image, so rescale to preview pixels
    const previewScale = this.fullSize[0] / this.previewSize[0]
    p.f('u_zoom', opts.zoom * previewScale * dpr)
    p.v2('u_pan', opts.pan[0] * dpr, opts.pan[1] * dpr)
    p.i('u_compare', opts.compare)
    p.f('u_split', opts.split)
    p.v3('u_surround', surround, surround, surround)

    const maskMode = this.maskView && opts.maskMode ? opts.maskMode : 0
    gl.activeTexture(gl.TEXTURE0 + MASK_UNIT)
    gl.bindTexture(gl.TEXTURE_2D, maskMode ? this.maskView!.tex : this.whiteTex!)
    p.i('u_maskView', MASK_UNIT)
    p.i('u_maskMode', maskMode)

    this.drawQuad()
  }

  // --- analysis -----------------------------------------------------------

  /** Histogram of the current result, sampled from a small resolved copy. */
  histogram(): Histogram | null {
    const gl = this.gl
    if (!this.lastResult) return null

    const [pw, ph] = this.previewSize
    const scale = Math.min(1, HIST_SIZE / Math.max(pw, ph))
    const w = Math.max(1, Math.round(pw * scale))
    const h = Math.max(1, Math.round(ph * scale))
    if (!this.histTarget || this.histTarget.w !== w || this.histTarget.h !== h) {
      this.freeTarget(this.histTarget)
      this.histTarget = this.makeTarget(w, h, false)
    }

    this.copyProg.use()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histTarget.fbo)
    gl.viewport(0, 0, w, h)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.lastResult)
    this.copyProg.i('u_tex', 0)
    this.drawQuad()

    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const r = new Uint32Array(256), g = new Uint32Array(256)
    const b = new Uint32Array(256), l = new Uint32Array(256)
    for (let i = 0; i < px.length; i += 4) {
      r[px[i]]++
      g[px[i + 1]]++
      b[px[i + 2]]++
      l[Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])]++
    }
    let max = 1
    for (let i = 0; i < 256; i++) max = Math.max(max, r[i], g[i], b[i], l[i])
    return { r, g, b, luma: l, max }
  }

  /**
   * The colour at (u, v) after running `layers` — used by the curve
   * eyedroppers, which must see what their layer receives as input, not the
   * untouched original. Uses its own targets so the displayed frame is not
   * disturbed. Coordinates are normalised and top-down.
   */
  samplePixel(layers: Layer[], u: number, v: number): [number, number, number] | null {
    const gl = this.gl
    if (!this.previewTex) return null
    const [w, h] = this.previewSize

    const a = this.makeTarget(w, h, true)
    const b = this.makeTarget(w, h, true)
    const out8 = this.makeTarget(w, h, false)
    const previewMask = this.maskTarget
    this.maskTarget = null
    const savedMaskView = this.maskViewLayerId
    this.maskViewLayerId = null

    try {
      const src = this.runStack(layers, this.previewTex, a, b)
      this.copyProg.use()
      gl.bindFramebuffer(gl.FRAMEBUFFER, out8.fbo)
      gl.viewport(0, 0, w, h)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      this.copyProg.i('u_tex', 0)
      this.drawQuad()

      const x = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))))
      const y = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))))
      const px = new Uint8Array(4)
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return [px[0] / 255, px[1] / 255, px[2] / 255]
    } finally {
      this.freeTarget(a)
      this.freeTarget(b)
      this.freeTarget(out8)
      this.freeTarget(this.maskTarget)
      this.maskTarget = previewMask
      this.maskViewLayerId = savedMaskView
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  /**
   * One thumbnail per layer, showing the photo as of that layer.
   *
   * Re-runs the stack at thumbnail size rather than tapping the preview
   * pipeline: a pass over ~5k pixels is far cheaper than the GPU stall of
   * reading back a preview-sized buffer. Every stage is blitted into one wide
   * atlas so the whole set costs a single readPixels instead of one per layer.
   */
  renderThumbnails(layers: Layer[], longEdge = 72): ImageData[] {
    const gl = this.gl
    if (!this.previewTex || layers.length === 0) return []

    const [pw, ph] = this.previewSize
    const scale = longEdge / Math.max(pw, ph)
    const w = Math.max(1, Math.round(pw * scale))
    const h = Math.max(1, Math.round(ph * scale))
    const n = layers.length

    const a = this.makeTarget(w, h, true)
    const b = this.makeTarget(w, h, true)
    const atlas = this.makeTarget(w * n, h, false)
    // masks must be generated at thumbnail size; keep the preview's target
    const previewMask = this.maskTarget
    this.maskTarget = null
    const savedMaskView = this.maskViewLayerId
    this.maskViewLayerId = null

    try {
      let src: WebGLTexture = this.previewTex
      let t1 = a, t2 = b
      for (let i = 0; i < n; i++) {
        const layer = layers[i]
        if (layer.enabled && layer.opacity > 0) {
          this.runPass(layer, src, t1)
          src = t1.tex
          const t = t1; t1 = t2; t2 = t
        }
        // a disabled layer simply repeats the previous stage
        this.copyProg.use()
        gl.bindFramebuffer(gl.FRAMEBUFFER, atlas.fbo)
        gl.viewport(i * w, 0, w, h)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, src)
        this.copyProg.i('u_tex', 0)
        this.drawQuad()
      }

      const strip = new Uint8ClampedArray(new ArrayBuffer(w * n * h * 4))
      gl.bindFramebuffer(gl.FRAMEBUFFER, atlas.fbo)
      gl.readPixels(0, 0, w * n, h, gl.RGBA, gl.UNSIGNED_BYTE, strip)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)

      const stride = w * n * 4
      return layers.map((_, i) => {
        const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4))
        for (let y = 0; y < h; y++) {
          const from = y * stride + i * w * 4
          out.set(strip.subarray(from, from + w * 4), y * w * 4)
        }
        return new ImageData(out, w, h)
      })
    } finally {
      this.freeTarget(a)
      this.freeTarget(b)
      this.freeTarget(atlas)
      this.freeTarget(this.maskTarget)
      this.maskTarget = previewMask
      this.maskViewLayerId = savedMaskView
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  /**
   * Resolve the current result (or the untouched source) into 8-bit pixels,
   * scaled to fit `max`. This is what measurement reads instead of the caller
   * having to export a file and decode it again.
   */
  readPixels(which: 'result' | 'original', max = 1024):
  { data: Uint8ClampedArray<ArrayBuffer>; w: number; h: number } | null {
    const gl = this.gl
    const tex = which === 'original' ? this.previewTex : this.lastResult
    if (!tex) return null

    const [pw, ph] = this.previewSize
    const scale = Math.min(1, max / Math.max(pw, ph))
    const w = Math.max(1, Math.round(pw * scale))
    const h = Math.max(1, Math.round(ph * scale))

    const target = this.makeTarget(w, h, false)
    try {
      this.copyProg.use()
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
      gl.viewport(0, 0, w, h)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      this.copyProg.i('u_tex', 0)
      this.drawQuad()

      const data = new Uint8ClampedArray(new ArrayBuffer(w * h * 4))
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return { data, w, h }
    } finally {
      this.freeTarget(target)
    }
  }

  // --- export -------------------------------------------------------------

  /** Re-run the stack at full resolution and return the pixels, top-down. */
  renderFullResolution(layers: Layer[]): { data: Uint8ClampedArray<ArrayBuffer>; w: number; h: number } | null {
    const gl = this.gl
    if (!this.fullTex) return null
    const [w, h] = this.fullSize

    const a = this.makeTarget(w, h, true)
    const b = this.makeTarget(w, h, true)
    const out8 = this.makeTarget(w, h, false)
    // masks must be regenerated at export resolution
    const previewMask = this.maskTarget
    this.maskTarget = null
    const savedMaskView = this.maskViewLayerId
    this.maskViewLayerId = null
    try {
      const src = this.runStack(layers, this.fullTex, a, b)

      this.copyProg.use()
      gl.bindFramebuffer(gl.FRAMEBUFFER, out8.fbo)
      gl.viewport(0, 0, w, h)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      this.copyProg.i('u_tex', 0)
      this.drawQuad()

      // readPixels row 0 is the framebuffer's first row, which is the top of
      // the image here, so the buffer is already in ImageData order.
      const px = new Uint8ClampedArray(new ArrayBuffer(w * h * 4))
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return { data: px, w, h }
    } finally {
      this.freeTarget(a)
      this.freeTarget(b)
      this.freeTarget(out8)
      this.freeTarget(this.maskTarget)
      this.maskTarget = previewMask
      this.maskViewLayerId = savedMaskView
      // the shared preview targets were never touched, but the viewport was
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  dispose() {
    const gl = this.gl
    this.freeTarget(this.ping)
    this.freeTarget(this.pong)
    this.freeTarget(this.histTarget)
    this.freeTarget(this.maskTarget)
    this.freeTarget(this.maskView)
    if (this.fullTex) gl.deleteTexture(this.fullTex)
    if (this.previewTex) gl.deleteTexture(this.previewTex)
    if (this.whiteTex) gl.deleteTexture(this.whiteTex)
    if (this.segTex) gl.deleteTexture(this.segTex)
    for (const v of this.lutCache.values()) gl.deleteTexture(v.tex)
    for (const v of this.cubeCache.values()) gl.deleteTexture(v.tex)
    for (const v of this.bakedCache.values()) {
      gl.deleteTexture(v.tex)
      gl.deleteFramebuffer(v.fbo)
    }
    for (const p of this.programs.values()) gl.deleteProgram(p.handle)
    gl.deleteProgram(this.copyProg.handle)
    gl.deleteProgram(this.presentProg.handle)
    gl.deleteProgram(this.maskProg.handle)
    gl.deleteProgram(this.brushProg.handle)
    gl.deleteVertexArray(this.quad)
    gl.deleteVertexArray(this.brushVao)
    gl.deleteBuffer(this.instanceBuf)
  }
}
