# Mobile — direction

Not a port. The phone build is a different product that shares the engine.

Today's interface is aggressively desktop-shaped: a 336px sidebar (most of a
phone's width), hover-revealed layer actions, right-click to delete curve
points, 5px drag targets, and six keyboard shortcuts.

## What the research supports

- Bottom sheets work because they sit in the **thumb zone**
  ([NN/g](https://www.nngroup.com/articles/bottom-sheet/),
  [LogRocket](https://blog.logrocket.com/ux-design/bottom-sheets-optimized-ux/))
- Gestures should be **accelerators, not the only path** — fast for experts,
  undiscoverable for everyone else
  ([TestParty](https://testparty.ai/blog/mobile-accessibility-patterns))
- Photo on top, tools below is the proven shape
  ([Darkroom](https://darkroom.co/))

## Direction

**The photo becomes the slider.** Rather than shrinking the panel, select a
parameter as a chip and then drag *anywhere on the photo* to change it. The
whole screen becomes the control, so touch precision stops mattering, and the
photo stays visible while you judge it — the opposite of a panel covering the
thing you are trying to see.

**Unambiguous gesture ownership.** One finger adjusts or paints. Two fingers
always pan and zoom. Long-press shows the original. This also settles a
conflict that already exists on desktop, where painting and panning both want a
one-finger drag.

**Derive simple controls from powerful ones.** Ship Blacks / Shadows /
Highlights / Whites as the default tone control, writing into the existing
Curves layer — same engine, no new shader, because a curve is only four points.
The full curve editor stays behind "Advanced". This is how Lightroom mobile
works.

**Fixes are the hero.** Nobody assembles a six-layer stack on a phone.
"Remove colour cast → Fix it" is the primary mobile interaction. The suggestion
banner is arguably a mobile feature that happens to also work on desktop.

**Demote the layer stack** to an advanced drawer. Photo, suggestion, and a
bottom sheet of looks and adjustments is the whole first screen.

## Blockers, in order

1. **WebGL context loss.** Mobile browsers drop contexts aggressively when a
   tab is backgrounded. Handled as of the context-restore work — the document
   and the source bitmaps survive, and all GPU state is rebuilt from them.
   Everything else here depends on this.
2. **Memory.** Full-res plus preview plus two RGBA16F ping-pong targets is
   roughly 200MB on a 12MP photo; mobile Safari kills tabs near there. Needs a
   lower `PREVIEW_MAX` and probably RGBA8 targets. **Do not tune this blind —
   measure on a real device first**, because the sensible-looking heuristics
   (`deviceMemory`, coarse pointer) are guesses.
3. **Export cost.** 304ms at 12MP on desktop will be seconds on a phone. This
   is where OffscreenCanvas earns its refactor; see `performance.md`.
4. **No hover, no right-click, no keyboard.** Layer actions, curve point
   deletion, and every shortcut need touch equivalents.
