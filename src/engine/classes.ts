/**
 * The class ids a segmented mask can select.
 *
 * The first six come from the segmenter, in the order its model card defines —
 * do not reorder them, the ids are what the model emits. The rest are painted in
 * afterwards from face landmarks, which is why they continue the same numbering
 * rather than living in a separate map: one texture, one shader test.
 *
 * Kept in its own file so `segment.ts` and `landmarks.ts` can share it without
 * importing each other.
 */
export const SEGMENT_CLASSES = [
  // from selfie_multiclass_256x256
  'background', 'hair', 'body-skin', 'face-skin', 'clothes', 'accessories',
  // painted from Face Landmarker
  'eyebrows', 'lips', 'eyes', 'iris',
] as const

export type SegmentClass = (typeof SEGMENT_CLASSES)[number]

/** Classes the segmenter itself produces; anything above this is painted on. */
export const SEGMENTER_CLASS_COUNT = 6

export const CLASS_ID = Object.fromEntries(
  SEGMENT_CLASSES.map((c, i) => [c, i]),
) as Record<SegmentClass, number>

/** Whether a class only exists once face landmarks have been run. */
export const isFaceRegion = (c: SegmentClass) => CLASS_ID[c] >= SEGMENTER_CLASS_COUNT
