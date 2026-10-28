/**
 * VSCO-style editing talks in controls, not layers. Under the hood each
 * control still owns one adjustment layer of a given kind — find or create
 * that singleton, then patch it. Multi-layer Looks (LOOK_PRESETS) bypass
 * this and use applyLook / loadRecipe instead.
 *
 * Creating a missing singleton does not push history — callers that need a
 * snapshot (Slider pointer-down, discrete Look tap) push first.
 */

import { useStore } from './store'
import {
  defaultParams, makeLayer,
  type AdjustmentKind, type ColorLookupParams, type Layer, type ParamsFor,
} from './types'

/** First layer of this kind in the stack, if any. */
export function findLayer(kind: AdjustmentKind, layers?: Layer[]): Layer | undefined {
  const list = layers ?? useStore.getState().layers
  return list.find((l) => l.kind === kind)
}

/**
 * Return the singleton layer for `kind`, creating it (no history) if needed.
 */
export function ensureLayer(kind: AdjustmentKind): Layer {
  const store = useStore.getState()
  const existing = findLayer(kind, store.layers)
  if (existing) {
    if (store.selectedId !== existing.id) store.selectLayer(existing.id)
    return existing
  }
  const layer = makeLayer(kind)
  useStore.setState((s) => ({
    layers: [...s.layers, layer],
    selectedId: layer.id,
    future: [],
  }))
  return layer
}

/** Merge params onto the singleton for `kind`, creating it if absent. */
export function setParam(kind: AdjustmentKind, patch: object): void {
  const layer = ensureLayer(kind)
  useStore.getState().updateParams(layer.id, patch)
}

/**
 * Point the Color Lookup singleton at a named built-in LUT. Pass amount
 * 0..100; omit to leave the current amount (default 100 on create).
 */
export function setLook(preset: string, amount?: number): void {
  const layer = ensureLayer('colorLookup')
  const cur = layer.params as ColorLookupParams
  useStore.getState().updateParams(layer.id, {
    preset,
    customId: null,
    customName: '',
    amount: amount ?? cur.amount ?? 100,
  } satisfies Partial<ColorLookupParams>)
}

/** Live params if the layer exists, otherwise the kind's defaults (no create). */
export function paramsOf<K extends AdjustmentKind>(kind: K): ParamsFor<K> {
  const layer = findLayer(kind)
  return (layer ? layer.params : defaultParams(kind)) as ParamsFor<K>
}
