# Segmented masks

Subject and skin masks come from MediaPipe's `selfie_multiclass_256x256`
segmenter. The model returns one class id per pixel, from six classes:

```
0 background   1 hair   2 body-skin   3 face-skin   4 clothes   5 accessories
```

`SEGMENTED_MASKS` in `src/state/types.ts` maps each mask kind onto the classes
it selects. Two are unions — `subject` is everything that is not background,
`skin` is face plus body — so selection is a bitmask and one shader test covers
both cases.

## What was measured before building it

On the reference portrait (530×377), all on GPU:

| | size | cold | warm | what it gives |
| --- | --- | --- | --- | --- |
| `selfie_segmenter` | 0.25 MB | 99 ms | 6 ms | person / background |
| `selfie_multiclass` | 16.4 MB | 244 ms | 12 ms | + hair, face skin, body skin, clothes |
| multiclass on CPU | — | 214 ms | 175 ms | identical output |

The multiclass model was chosen because face skin is the mask that matters for
portraits, and 12 ms is not a cost worth optimising.

**Resolution buys nothing.** Handed a 4240×3016 canvas, the model produced a
mask identical to the 530×377 one — coverage matched every class to within
0.1% — because it works at 256×256 internally and upsamples. It cost 140 ms
instead of 12 ms. So segmentation runs on the *preview* bitmap, never the full
image, and the mask is scaled up in the shader.

Both models agreed on the person: 72.1% vs 73.8% of frame, with 0.9% and 0.7%
of foreground pixels on a boundary — a crisp matte either way.

## Where the pieces live

- `src/engine/segment.ts` — loading, inference, the per-image cache
- `MASK_FRAG` in `glsl.ts` — kind 6, `segAt()` and `segBlurred()`
- `renderer.setSegmentation()` — uploads class ids to `SEG_UNIT`
- `ensureMasksReady()` in `api.ts` — the async seam

## Things that will bite

**Class ids must never be interpolated.** The segmentation texture is sampled
`NEAREST`. Linear filtering would blend class 1 against class 3 and produce a
phantom class 2 along every boundary — a hair mask would grow a body-skin
outline. Feather is applied afterwards, by averaging class *matches*.

**Segmentation is async; rendering is not.** Any path that can introduce one of
these masks awaits `ensureMasksReady()` first. Until it resolves the shader
samples a 1×1 white texture, whose decoded class is out of range, so the mask
covers nothing — the adjustment is invisible rather than global, which is the
safer way to be briefly wrong.

**The result is cached per image, not per layer.** Ten layers masking different
body parts share one inference, and no layer holds a bitmap — which is what
keeps undo's deep clone cheap and honours "binary data stays out of the
document". A segmentation describes one photograph, so what a layer stores is
the *request* (`mask.kind`), never the pixels.

**The model is fetched on first use**, from Google's CDN, and cached by the
browser. ~28 MB including the WASM runtime, against a 94 KB app — so nothing is
loaded until someone actually asks for one of these masks, and the MediaPipe
glue is a separate lazy chunk. The photo itself still never leaves the machine.

## How it did on 19 real photos

A folder of scanned film snapshots (3614×2468), not studio portraits. Roughly
two thirds were read correctly, and the failures fall into three groups.

**Correct.** An empty office and a cat both returned 0% person — the right
answer, not a failure. Wide travel shots where a person occupies 5–7% of the
frame reported 5–7%, which is also right; a small subject is not a missed one.
A well-lit boy at 38% person / 4.1% face / 17.8% clothes was accurate.

**Missed entirely.** Small, distant people — two boats on a river — came back
0%. This is the model's documented limit: it is trained for a subject within
about 2m of the camera. Worse, an airport terminal full of people, including a
man occupying maybe 15% of the frame, also returned 0%; a crowd at middle
distance is outside what a *selfie* segmenter is for.

**Misclassified.** Two failures worth knowing, both confirmed by rendering the
mask and looking at where it landed rather than trusting the percentages:

- A very dark frame (a child lit by fairy lights) returned 41% *clothes* and 0%
  face-skin. The person was found; the parts were not.
- An orange top was labelled `face-skin` — 10.8% of the frame, in a photo shot
  from behind where no face is visible at all. Skin-toned fabric fools it. The
  same photo got `bodySkin` right on the actual shoulder.

**Tone-normalising first does not help.** The obvious fix for the dark frame —
brighten before segmenting — was tested and makes it strictly worse:
46.6% person as shot, 2.7% at 1.8x, 0% at 2.6x. Do not add it.

The practical consequence is that `segment()` should be called before offering
these masks, and low or zero person coverage should be surfaced rather than
producing a mask that silently covers nothing or the wrong thing. The mask panel
shows the covered fraction for exactly this reason.

## Facial features come from a second model

The segmenter has no classes for lips, eyes or eyebrows, so those come from Face
Landmarker's 478 points. Its outlines are rasterised into the *same* class map,
continuing the same numbering — a landmark region is just another class id, so it
reuses the shader, the upload, the bitmask selection and the cache without adding
anything.

Two details encode anatomy rather than convenience:

- **Painting order.** Eyes are filled before irises, so an iris overwrites the eye
  beneath it and `eyes` ends up meaning sclera — the same split Lightroom offers,
  and the one you want to whiten eyes without changing their colour. Lips
  overwrite face skin, so `faceSkin` stops including the mouth.
- **Even-odd fill.** MediaPipe hands out these features as unordered edge pairs,
  and the lips are *two* rings, outer and inner. Filling both with an even-odd
  rule leaves the mouth opening empty, which is what "lips" should mean. Measured:
  a probe on the lip recolours, a probe in the opening does not.

It is a separate model (~3.7MB) and a separate call, so a `subject` mask does not
drag down a face model it will never look at. `subject` lists the face-region
classes so it stays correct once they are painted, but it covers those pixels
either way — they are face skin until then.

Verified on the reference portrait: eyebrows, then eyes, then lips, in that
vertical order, with `face-skin` dropping 24.6% to 21.7% as the features took
their pixels. Same ordering on a real snapshot from the test folder.

## Not covered

Teeth. The landmark set has no tooth contour; the inner lip ring is the mouth
opening, which contains teeth, tongue and shadow together.

`face-skin` merges every face in the frame into one class. For photos with more
than one person, "this person's face" is not expressible yet — the landmark pass
does return up to three faces separately, so the raw material is there, but the
class map flattens them.
