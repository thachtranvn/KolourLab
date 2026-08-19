# Colour Lab

A browser photo colour editor with Photoshop's adjustment toolkit — from basic
brightness to 3D LUTs. Non-destructive adjustment layers, rendered in real time
on the GPU. Everything stays on your machine; no image is ever uploaded.

```bash
npm install
npm run dev      # http://localhost:5180
npm run build
```

## Adjustments

Each one is an **adjustment layer**: reorder it, rename it, toggle it off, change
its opacity, or give it a blend mode. Layers render bottom to top.

**Light & contrast**
| Tool | What it does |
| --- | --- |
| Brightness/Contrast | Fast overall adjustment. Default algorithm protects highlights and shadows; a Legacy toggle gives the old linear (clipping) behaviour. |
| Levels | Black point, gamma and white point per channel, plus output range, with a live histogram and a 0.1%-clip Auto button. |
| Curves | Monotone-cubic spline over RGB or any single channel, drawn over the histogram, with Black/Grey/White eyedroppers, black and white point handles, an input/output readout, and a channel wash showing which way adds which colour. Click to add points, drag to shape, double-click to delete. Includes contrast/matte/negative presets. |
| Exposure | Stops of linear exposure, plus offset and gamma correction. |

**Colour & hue**
| Tool | What it does |
| --- | --- |
| White Balance | Temperature and Tint — the two axes a light source moves along. Right warms, right greens. Scaling happens in linear light, and the eyedropper solves both sliders from one neutral you click. |
| Vibrance | Saturation weighted toward muted colours, easing off around skin-tone hues. |
| Hue/Saturation | Hue, saturation and lightness for the master image or any of the six colour ranges (full strength within 30° of the band centre, feathered to 60°). Includes Colorize. |
| Color Balance | Cyan–Red, Magenta–Green and Yellow–Blue for shadows, midtones and highlights independently, with Preserve Luminosity. |
| Selective Color | CMYK tuning of one colour family at a time — reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks — in Relative or Absolute mode. |
| Replace Color | Sample a colour with the eyedropper, set fuzziness, and shift its hue/saturation/lightness. Toggle the mask to see the selection. |
| Solid Colour | A flat colour painted into an area with a brush mask. Starts in Colour blend, so it changes hue while keeping the underlying shading — how lips, eyes and clothing get recoloured. |

**Advanced**
| Tool | What it does |
| --- | --- |
| Black & White | Six colour-response sliders driving the monochrome conversion, with optional tint. |
| Channel Mixer | Full 3×3 source mix plus constants, and a monochrome mode with Photoshop's filter presets. |
| Photo Filter | Warming/cooling lens filters and 20 stock colours, with density and Preserve Luminosity. |
| Gradient Map | Maps luminance onto an editable colour ramp. Double-click the ramp to add stops. |
| Color Lookup | 3D LUTs. Twelve built-in film looks, plus any Adobe/IRIDAS `.cube` file (size 2–64). |

## Layer thumbnails

Each layer row shows the photo **as of that layer**, rendered by the same
pipeline. Hover a thumbnail to hide just that layer in the preview, so you can
see exactly what it contributes — it never touches the document or undo history.

The set is produced by re-running the stack at thumbnail size into one wide
atlas and reading that back once, rather than tapping the preview pipeline per
layer. A pass over ~4k pixels is far cheaper than the GPU stall of reading a
preview-sized buffer, and one readback beats N. Recomputation is debounced;
twelve rapid edits on a twelve-layer stack produce no long tasks.

## Masks

Any adjustment layer can be restricted to part of the image. Pick a mask type in
the layer's **Mask** section; **Overlay** shows the protected area in red,
**Mask** shows the raw coverage map.

| Type | Use it for |
| --- | --- |
| Linear gradient | Skies, foreground falloff — angle, position and transition length |
| Radial gradient | Faces and subjects — position, radius, aspect, rotation |
| Luminance range | "Only the shadows" / "only the highlights", with a live histogram |
| Colour range | Target one colour, sampled with the eyedropper |
| Brush | Paint exactly where the adjustment lands |

All of them add **Feather**, **Density** and **Invert**.

**To paint a mask:** select a layer → **Mask → Type → Brush** → drag on the photo.
Choosing Brush drops you straight into painting; the adjustment starts hidden
everywhere (the photo turns red) and you paint it back in.

The brush paints with Reveal / Hide (hold ⌥ to flip), `[` and `]` resize it, and
each stroke is a separate undo step. Strokes are stored as *vector paths*, not
raster data — so undo is exact, masks cost almost nothing in the document, and
they travel inside saved recipes.

## Working with it

- **Open image** or drag a file onto the canvas. **Sample** loads a synthetic test
  image with skin tones, a colour checker and a neutral ramp.
- **+ Add** opens the tool picker, with **Adjustments** and **Looks** tabs. A look
  appends a ready-made stack of layers you can then tweak.
- **Split** shows a draggable before/after divider; holding **X** shows the original.
- **Save recipe** exports the layer stack as JSON so a grade can be reapplied to
  another photo. (Custom `.cube` files are referenced by name and must be
  reloaded.)
- **Export PNG/JPEG** re-runs the whole stack at full resolution.

Shortcuts: `⌘Z`/`⇧⌘Z` undo/redo · `\` split view · `X` hold for original ·
`0` fit · `1` 100% · `+`/`−` zoom · `H` histogram · `[`/`]` brush size ·
`Tab` hide all panels · `Esc` cancel painting or the eyedropper.

## Design rule

**Nothing on screen may out-colour the photograph.**

The entire interface is a true neutral — every grey is R=G=B, with no tint.
Selection, focus and emphasis are carried by lightness, weight and a marker
rail, never by hue. The only chromatic pixels the app is allowed to draw are:

- the photograph
- gradients that *are* the information: slider tracks (Cyan↔Red, the hue ramp)
  and the curve editor's channel wash with its Red/Cyan corner labels, which
  say which way a channel curve adds which colour
- the RGB histogram, colour swatches, and the red mask overlay
- error text, the one deliberate exception — and only as text, never a fill

If you add UI, keep the rule. There is a check for it in `src/styles.css`'s
header comment, and the palette has no chromatic variables to reach for.

The photo sits on a flat mat, not a checkerboard — checkerboard means
transparency, which is not what surrounds an opaque photograph. Four backdrops
are offered; **18% Grey** is the real 18%-reflectance reference (linear 0.18 →
sRGB `#767676`, not the `#808080` usually mislabelled middle grey). A neutral
mid-grey surround is what ISO 3664 recommends for judging colour, because a
dark surround makes an image read lighter and more contrasty than it is.

`Tab` hides every panel so only the photograph is left.

## Fixes

A **Look** stores fixed values and travels as a style. A **Fix** stores a
*procedure*: it measures the photo and configures itself, so the same fix is
correct on any image. Saving a colour-cast repair as a Look would wreck the next
photo, because `Channel Mixer: Blue ← Green 100%` describes one image's damage,
not a look.

Opening a photo diagnoses it. When the evidence is strong the app offers the
repair without being asked:

> **Remove colour cast** — The blue channel tops out at 78 of 255, so it cannot
> make a neutral highlight.  `[ Fix it ]  [ Not now ]`

Fixes also live in the **+ Add → Fixes** tab with a match score, and on the API
as `suggest()` / `fix(id)`.

**Auto tone** sets the black and white points from the luma clip points and
places the midtones with a gamma, all through a *single* shared Levels channel —
per-channel points would shift colour, which is the other fix's job. A flat
image measuring 80–183 with an average of 139 opens out to 1–246 at 124, while
its white-point spread stays at 0: tone changed, colour untouched. A
well-exposed photo scores 0.05 and is left alone.

**Remove colour cast** detects the defect from the **white-point spread** — how
far apart the channels' practical maximums are — rather than from their means. A
sunset is legitimately orange but its highlights stay neutral, so a mean-based
test flags every warm photo; the sample landscape has a mean spread of 15.3 and
is correctly left alone. Where a channel is only mildly compressed it is
amplified with Levels; where it is too crushed for that to be anything but noise
amplification, structure is borrowed from the healthiest channel and mixed with
what real signal remains. A second pass then measures the result and neutralises
any residue via per-channel black and white points — never by pulling channel
*means* together, which would grey out skin and foliage.

Adding a fix means implementing `appliesTo`, `explain`, `build` and optionally
`refine` in `src/engine/fixes.ts`. They are typed functions rather than a stored
DSL: safe, fast, and no interpreter to maintain.

## Automation API

`window.colourlab` is the programmatic surface. The document is already JSON, so
automation writes the document rather than driving the UI — and `measure()`
answers questions with numbers instead of screenshots.

**It describes itself**, so nothing has to be memorised or kept in sync by hand:

```js
colourlab.help()            // overview, methods, adjustment kinds, fixes, an example
colourlab.help('methods')   // full signatures
colourlab.help('curves')    // one adjustment's parameters and defaults
```

Parameter listings are generated from the real defaults, so they cannot drift
from the code. The app also logs a one-line pointer to `help()` on boot, and
errors name the valid options — `apply` with a bad kind lists all fourteen and
tells you to call `help(kind)`. Agents working in the repo should read
`CLAUDE.md`.

```js
await colourlab.open('/photo.jpg')

// diagnose before touching anything
await colourlab.measure({ channels: true, source: 'original' })
// → cast: { weakest: 'b', weakestMax: 107, looksLikeChannelDamage: true }

// the whole stack in one call; terse specs are filled out with defaults
await colourlab.apply([
  { kind: 'channelMixer', params: { b: [0, 100, 0] } },
  { kind: 'selectiveColor', params: { colors: { reds: [-5, -3, 8, -2] } } },
  { kind: 'vibrance', params: { vibrance: 16 } },
])

// verify against numbers, not an eyeball
await colourlab.measure({ patches: { cheek: [150, 150] }, clipping: true })
// → cheek: { rgb: [155,108,102], rg: 1.44, gb: 1.06 }   // skin wants R>G>B

await colourlab.export({ format: 'jpeg', quality: 0.92 })
```

| Method | Returns |
| --- | --- |
| `open(url \| File \| Blob)` | `{ name, width, height }` |
| `doc()` / `layers()` | the recipe JSON / a compact listing |
| `apply(layers, { replace })` | replaces or appends the stack |
| `patch(indexOrId, params)` | tweak one layer without resending the rest |
| `measure(spec)` | channel stats, cast summary, clipping, named patches |
| `sampleLayerInput(indexOrId, u, v)` | the colour a layer receives as input, at normalised top-down coords |
| `export({ format, quality, as })` | `{ w, h, bytes }`, downloads by default |
| `reset()` | clears every layer |

Specs are terse: name the `kind` and only the params you care about — the rest
come from that adjustment's defaults, and nested groups like `colors` or `rgb`
merge one level deep. Unknown parameter names, wrong types and non-finite
numbers are rejected with a message naming the valid keys, because silently
ignoring them renders black and is miserable to debug remotely.

`measure()` reports `patches` in **source pixel coordinates** and gives `rg`/`gb`
ratios alongside raw RGB; healthy skin runs R > G > B, so both should exceed 1.

## How it works

`src/engine/` holds the rendering core. Each adjustment is one WebGL2 fragment
shader (`glsl.ts`); `renderer.ts` runs the layer stack as a chain of full-screen
passes through ping-pong framebuffers, so adding a layer costs one more pass
rather than a re-render from scratch.

A masked layer costs one extra pass: the mask is generated into a single-channel
buffer against that layer's *input*, then multiplied into the layer's opacity.
Brush strokes are baked into a full-resolution `R8` texture with instanced dabs
(one draw call per stroke) and re-baked only when the stroke list changes.

Three details worth knowing if you extend it:

- Adjustments operate on **gamma-encoded sRGB values**, which is what Photoshop's
  Image > Adjustments do. Exposure is the exception and linearises internally.
- Editing is done at a **preview resolution** (long edge ≤ 2400px) for
  responsiveness; export re-runs the identical shader chain against the
  full-resolution texture, regenerating masks at that size.
- Anything binary stays **out of the document**. Undo snapshots the layer array
  with a deep clone, so LUT cubes live in a registry keyed by id and brush masks
  are stored as strokes rather than pixels.

Curves and gradient ramps are baked on the CPU into 256×1 lookup textures and
cached per layer; LUT cubes become 3D textures sampled with hardware trilinear
filtering. Unit 0 always holds a pass's input — lookups bind to units 1 and 2.

`src/state/` is the document model (layer types, defaults, undo history) and
`src/ui/` is the React interface.
