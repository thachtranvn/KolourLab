# Where we diverge from Photoshop

The app aims to match Photoshop's Image > Adjustments. Running the yellow-cast
tutorial operation by operation, against the settings read off its own
screenshots, found two places where we do not. Neither is fixed yet.

Method: apply the tutorial's exact settings to its own source file, and compare
against its published stage screenshots at matching relative probe points.

## Read tutorial screenshots with suspicion

They are captures of the Photoshop window, not exported files. Photoshop draws
through a monitor profile, so a screen grab is colour-converted and then
re-compressed — lighter and more saturated than the document.

The proof is their own stage 2, which contains no tonal edit at all, only a
channel paste: the real source file measures **9.17%** black clipping, their
screenshot of it measures **0.43%**, and every later stage sits between 0.17%
and 0.48%. Shadows do not un-crush themselves by being copied.

Sampling a 16×12 grid and bucketing their values against ours recovers the
transform — a smooth per-channel curve, red lifted about +11, green and blue
pulled down about 7 and 10, black lifted from 0 to ~18:

| ours | → their R | → their G | → their B |
| --- | --- | --- | --- |
| 32 | 41 | 25 | 22 |
| 64 | 74 | 56 | 52 |
| 96 | 109 | 90 | 85 |
| 160 | 168 | 159 | 156 |

Rebuilt as a Curves layer and applied to our own render, it reproduces their
screenshot to within one or two levels on every probe. So compare *changes
between their stages*, which survive a fixed transform. Never absolute values.

A consequence worth remembering when following any tutorial: its author chose
every setting while looking at that rendition. Copy the moves, re-derive the
amounts by measuring.

## Curves lifts too much — high confidence

Photoshop: RGB composite, one control point, input 79 → output 113.

Take *their* stage-3 image, apply *our* curve with that control point, and
compare against *their* stage-4 image. Same pixels in, same point:

    ours    mean 88 → 109   (+21)
    theirs  mean 88 → 103   (+15)

Our curve passes through the control point exactly — a synthetic 256-wide ramp
confirms 79 → 113 — so the error is the spline *between* points. On the same
ramp we map 128 → 159, where a natural cubic spline through the same three
points gives 166. We match neither Photoshop nor the textbook curve.

This one is measured on their own pixels, so the display transform does not
affect it.

To verify a fix, build the ramp again: a 256×32 canvas whose column *x* has
value *x*, open it, apply the curve, and read the transfer at known inputs.

## Color Balance is about 2.3x too strong — moderate confidence

Photoshop: Midtones, red 0 / green +18 / blue +7, Preserve Luminosity on.

Both pushed into their screenshot space so the deltas are comparable:

| probe | our Δ | their Δ |
| --- | --- | --- |
| cheek | R−3, G **+9**, B+2 | R−6, G **+4**, B−2 |
| background | R **−12**, G **+12**, B−2 | R **−3**, G **+5**, B 0 |

The slider scaling is correct — `renderer.ts` divides by 100, so +18 arrives as
0.18, and the uniforms are documented −1..1. The amplitude lives in the shader:

```glsl
const float a = 0.25, b = 0.333, scale = 0.7;   // COLOR_BALANCE, glsl.ts
```

Solving `scale` from each probe independently gives **0.29** (background) and
**0.31** (cheek) — two unrelated probes converging on ~0.30 against the current
0.70.

Treat that as an estimate, not a constant. It is derived *through* the
reverse-engineered display transform, unlike the Curves figure. The red column
also disagrees in direction between probes, which suggests Preserve Luminosity
redistributes the untouched channels differently from Photoshop's — so the
single `scale` may not be the whole story.

Confirming it properly needs a reference rendered by Photoshop itself and
exported, not screenshotted.

## Not a divergence

**Layer stacking.** Photoshop composites each adjustment over the result below
it, and so do we. Chained behind the channel mixer, Color Balance sees blue =
77; applied to the untouched original it would see blue = 14. We measure 77.

**The channel paste.** Copying green into blue means blue equals green, and our
`channelMixer` with `b = [0, 100, 0]` produces exactly that — cheek G:B lands on
1.00. Their screenshot reads 1.06 only because of the transform above.

## What the tutorial needs that we cannot do

Its noise reduction and its Topaz smoothing pass both sample neighbouring
pixels. Every adjustment here is a per-pixel `adjust(vec3 c)`, so there is no
blur, no noise reduction and no frequency separation. That is the single
missing capability behind the remaining visual gap — and why lifting this
photo's shadows hard exposes JPEG blocks that those two steps exist to hide.
