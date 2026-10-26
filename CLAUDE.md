# Colour Lab — working notes

Browser photo colour editor. Non-destructive adjustment layers rendered as
WebGL2 shader passes. Everything runs locally; no image ever leaves the machine.

```bash
npm run dev      # http://localhost:5180
npm run build    # tsc -b && vite build
npx tsc --noEmit # typecheck alone
```

There are no unit tests. Changes are verified by driving the real app — see
**Verifying a change** below.

## Drive the app through the API, never the DOM

`window.colourlab` is the automation surface. The document is already JSON, so
write the document rather than clicking sliders. Scraping the UI by label text
is brittle and costs ~10× the tokens.

```js
colourlab.help()            // overview, method list, adjustment kinds, fixes
colourlab.help('methods')   // full signatures
colourlab.help('curves')    // one adjustment's parameters and defaults
```

A typical session:

```js
await colourlab.open('/photo.jpg')
await colourlab.measure({ channels: true, source: 'original' })   // diagnose
await colourlab.fix('remove-color-cast')                          // or apply([...])
await colourlab.measure({ patches: { cheek: [150, 150] } })       // verify
await colourlab.export({ format: 'jpeg' })
```

**Measure, don't look.** `measure()` returns numbers; screenshots cost far more
and are worse evidence. A grade that looked fine to the eye once measured
`gb 0.98` on skin — magenta, and wrong. Useful signals:

- `cast.whitePointSpread` — how far apart the channels' practical maximums are.
  This is the colour-cast detector. **Not** `meanSpread`: a sunset is
  legitimately orange while its highlights stay neutral.
- `patches[].rg` / `.gb` — skin needs R > G > B, so both should exceed 1.
- `clipping.blackPct` / `.blownPct` — tone that is simply gone (all three
  channels at the limit). `channelBlackPct` / `channelBlownPct` are the looser
  question, one channel at the limit, which a saturated colour can hit while
  being nowhere near dark. Pick the one that matches the question you are
  asking.

To load a local file, copy it into `public/` (Playwright is sandboxed to the
repo) and fetch it by URL. Delete it afterwards — `public/` is not committed.

## Further notes

- `docs/performance.md` — measured costs, why WASM is not the answer here, and
  when a worker would be
- `docs/masking.md` — the segmented masks: which model, why, and what bites
- `docs/photoshop-fidelity.md` — two measured divergences from Photoshop, and
  why tutorial screenshots are not a reference
- `docs/mobile.md` — the phone direction and its blockers

## Layout

| Path | What |
| --- | --- |
| `src/engine/glsl.ts` | every shader; one fragment body per adjustment |
| `src/engine/renderer.ts` | pass pipeline, ping-pong targets, masks, export |
| `src/engine/measure.ts` | image statistics shared by the API and Fixes |
| `src/engine/segment.ts` | subject/skin/hair masks from MediaPipe |
| `src/engine/fixes.ts` | adaptive repairs (measure → configure themselves) |
| `src/engine/presets.ts` | Looks (fixed values), LUTs, gradients |
| `src/state/types.ts` | the document model; **defaults live here** |
| `src/api.ts` | `window.colourlab` |
| `src/ui/` | React interface |

## Invariants — break these and things go subtly wrong

**Adjustments operate on gamma-encoded sRGB**, matching Photoshop's
Image > Adjustments. Two linearise internally because the physics demands it —
Exposure, and White Balance, which is illuminant scaling. Everything else stays
gamma-encoded; do not "fix" this by linearising the pipeline.

**Nothing on screen may out-colour the photograph.** All chrome is a true
neutral (R=G=B). Selection and emphasis use lightness and weight, never hue.
Colour is reserved for the photo, gradients that *are* the information (slider
tracks, the curve editor's channel wash and its Red/Cyan-style corner labels),
the histogram, colour swatches, the mask overlay, and error text. The palette
has no chromatic variables to reach for; keep it that way.

**Binary data stays out of the document.** Undo deep-clones the layer array, so
LUT cubes live in a registry keyed by id and brush masks are stored as *vector
strokes*, not pixels. Never put an ImageBitmap or a large array in a layer.

**Texture unit 0 always holds the pass input.** Creating or uploading a texture
binds it to the active unit, so lookups select their own unit first
(`LUT_UNIT`, `CUBE_UNIT`, `MASK_UNIT`). Getting this wrong silently renders the
lookup table across the whole frame.

**Textures are top-down.** `UNPACK_FLIP_Y_WEBGL` is invalid for `ImageBitmap`
uploads and is silently ignored; only the present pass flips.

**A Look is not a Fix.** A Look stores fixed values and travels as a style. A
Fix measures the photo and configures itself. Saving a colour-cast repair as a
Look would wreck the next photo.

## Verifying a change

Drive the real app and check numbers, not vibes:

1. `npx tsc --noEmit`, then `npm run build`.
2. Open the app, reproduce the exact failure the change addresses, and assert on
   a measurement or a DOM value.
3. Screenshot only when the question is genuinely visual (layout, a mask's
   shape). Never as a substitute for a measurement.

Known reference: the yellow-cast portrait repairs to `whitePointSpread 174 → 0`,
blue's ceiling `107 → 255`, skin at `cheek rg ≈ 1.4 / gb ≈ 1.05`.

Watch out for these:

- **Mask numbers carry mixed units.** `center` and `target` are 0..1 fractions;
  `size`, `aspect`, `density` and `feather` are percentages. Writing `size: 0.9`
  for "90%" gives you 0.9%, which renders a mask the size of a pixel and no
  error. `help('masks')` states the unit on every field — use it.

- **Editing a UI file with the page open** makes React Fast Refresh replace the
  canvas while the renderer keeps the old one — the canvas goes black. Reload;
  it is not a real bug.
- **`preserveDrawingBuffer` is false**, so `readPixels` on the default
  framebuffer returns garbage after compositing. Use `renderer.readPixels()`.

## Deploying

Vercel (Vite static). Authenticate with `npx vercel login`, then:

```bash
# Empty public/ first — Vite copies it into dist verbatim
npm run build
npx vercel --prod
```

Or link the GitHub repo in the Vercel dashboard for automatic deploys on push.
A static bundle — four files, no server, no build step on the host.

**Empty `public/` before building.** Vite copies it into `dist` verbatim, and
this is the same directory used to stage test photos for driving the app. A
deploy run mid-session would have published a personal photo and a third party's
watermarked tutorial screenshots. `find dist -type f` before deploying: it should
list `index.html` and the `assets/` bundle, nothing else.

First use of a segmented mask downloads ~28MB of runtime and weights from the
CDN. Measured on the deployed site that is **~30s cold**, then 1ms for the same
image and ~55ms for a fresh one once the browser has cached it. Nothing is
fetched until one of those masks is used, so the rest of the app is unaffected.

## Housekeeping

Clean up `public/`, `dist/`, `.playwright-mcp/` and stray screenshots before
committing. Commit messages explain *why*, and state what was verified.
