# Performance findings

Measured 2026-08-13 on a 12-core desktop with a synthetic 12MP (4000×3000)
image, through `window.colourlab`. Reproduce with the snippet at the bottom.

## Where the time actually goes

| Operation | ms | Blocks the main thread? |
| --- | --- | --- |
| `open()` — decode + resize | 169 | No, `createImageBitmap` is off-thread |
| `apply()` — six layers | 27 | One frame |
| `measure()` at 1024px | 8 | Negligibly |
| `fix()` — 3 measurements + 2 applies | 53 | One frame each |
| `export()` PNG | 304 | **Yes** |
| `export()` JPEG | 151 | **Yes** |
| Undo deep-clone, stack with a 6000-point stroke | 0.7 | No |

## The biggest cost was a timeout, not computation

`measure()` originally took **312ms**, which looked like plausible GPU readback
cost. It was not. `settle()` waited for the next presented frame, but when
nothing had changed no frame was scheduled, so it sat until its 300ms timeout
expired.

The render loop now marks a frame pending when it schedules one, and `settle()`
returns immediately when the canvas already reflects the document.

- `measure()` 312ms → **8ms**
- `apply()` 82ms → **27ms**

Lesson worth keeping: profile before optimising. The instinct here was "the GPU
readback is slow, move it to a worker", and that would have been wasted work on
top of a bug.

### …and the first attempt at that fix broke correctness

Flagging "a frame is pending" from the render effect alone was not enough.
React runs effects *after* paint, so between a mutation and that effect there
is a window where the canvas is stale and nothing is flagged. `settle()`
returned immediately in that window and handed back the previous frame.

Nothing looked broken. What actually happened was that `fix()`'s refine pass
measured pre-repair pixels and wrote a Levels layer with `b.inWhite = 78` — the
*original* blue clip point — stretching blue 3.27× on top of an already-repaired
channel and pinning it at 255.

The store is now subscribed directly, so a frame is marked pending the instant
the document changes, synchronously, before React gets involved. The render
effect still marks it as a backstop.

Two things to take from this: a stale-pixel bug is invisible unless you assert
on numbers, and any change to `settle()` must be checked against `fix()`'s
refine values, not just against wall-clock timings.

## Do we need WASM / Rust?

**No, and not for a while.** WASM makes tight CPU numeric loops fast. This app
has almost none: all fourteen adjustments, masks and blending are GPU shaders.
Porting them to Rust would move work *onto* the CPU and be slower.

The only CPU-side numeric work is trivial or already native:

- Curve and gradient LUT baking — 256 samples, microseconds
- `generateCube(33)` — 36k evaluations, once per preset, cached
- Histogram / measurement loops — a few ms over ~1M pixels
- Undo cloning — 0.7ms even with a heavy brush stroke

WASM becomes the right answer when a real CPU algorithm arrives — denoise,
frequency separation, content-aware fill. Not before.

## Do we need Web Workers?

**Export is the only genuine main-thread block** (304ms for PNG at 12MP), and
its cost is a GPU→CPU sync stall plus native image encoding. A worker cannot
help with either unless the whole GL context moves off-thread via
**OffscreenCanvas** — which turns every renderer call into async message
passing. That is a large refactor for one hitch that already shows a progress
indicator. Not yet.

Cheap wins available any time, both pure data-in/typed-array-out:

- `.cube` parsing — up to 262k lines for a 64³ LUT
- Preset cube generation — 33³ evaluations

On mobile, export will be several seconds rather than 300ms, which is where the
OffscreenCanvas conversation becomes worth having.

## Reproducing

```js
const t = async (label, fn) => {
  const a = performance.now(); await fn()
  return { label, ms: Math.round(performance.now() - a) }
}
const cv = document.createElement('canvas')
cv.width = 4000; cv.height = 3000
cv.getContext('2d').fillRect(0, 0, 4000, 3000)

await t('open', () => colourlab.open(cv, 'big.png'))
await t('apply', () => colourlab.apply([{ kind: 'curves' }, { kind: 'vibrance' }]))
await t('measure', () => colourlab.measure({ channels: true }))
await t('export', () => colourlab.export({ download: false }))
```
