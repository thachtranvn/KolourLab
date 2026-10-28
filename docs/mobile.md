# Mobile — direction

Not a port. The phone build is a different product that shares the engine.

## What shipped

**VSCO-style shell** at ≤900px width:

- Photo full-bleed above a bottom dock
- Three tabs: **Looks** (LUT / Fuji film sims), **Basic** (tone + colour), **Effects** (grain, clarity, chrome…)
- No layer list on the primary path — each control upserts a singleton adjustment layer under the hood
- Fix suggestion chip sits above the tabs when confidence is high
- Desktop keeps the sidebar + full layer stack for power users

## What the research supports

- Bottom sheets / docks sit in the **thumb zone**
  ([NN/g](https://www.nngroup.com/articles/bottom-sheet/),
  [LogRocket](https://blog.logrocket.com/ux-design/bottom-sheets-optimized-ux/))
- Photo on top, tools below is the proven shape
  ([Darkroom](https://darkroom.co/), VSCO, Snapseed)
- Gestures should be **accelerators, not the only path**
  ([TestParty](https://testparty.ai/blog/mobile-accessibility-patterns))

## Still open

1. **Memory.** Full-res plus preview plus two RGBA16F ping-pong targets is
   roughly 200MB on a 12MP photo; mobile Safari kills tabs near there. Needs a
   lower `PREVIEW_MAX` and probably RGBA8 targets. **Measure on a real device
   first.**
2. **Export cost.** 304ms at 12MP on desktop will be seconds on a phone — see
   `performance.md`.
3. **Photo-as-slider.** Select a parameter chip and drag on the photo (planned,
   not built).
4. **Masks / brush** stay desktop-only for now.
