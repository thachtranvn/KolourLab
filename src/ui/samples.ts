/**
 * Built-in test photos — real frames so colour / tone / grain tools can be
 * exercised without opening a file. Served from public/samples/.
 */

export interface SamplePhoto {
  id: string
  /** Short label for the picker */
  name: string
  /** What this frame is good for exercising */
  hint: string
  /** URL under the Vite public root */
  url: string
}

export const SAMPLE_PHOTOS: SamplePhoto[] = [
  {
    id: 'night-street',
    name: 'Night street',
    hint: 'Deep shadows, mixed warm/cool lights',
    url: '/samples/night-street.jpg',
  },
  {
    id: 'day-street',
    name: 'Day street',
    hint: 'Bright daylight, greens and sky',
    url: '/samples/day-street.jpg',
  },
  {
    id: 'autumn-road',
    name: 'Autumn road',
    hint: 'Warm foliage vs cool water',
    url: '/samples/autumn-road.jpg',
  },
  {
    id: 'teal-shore',
    name: 'Teal shore',
    hint: 'Teal water, autumn forest',
    url: '/samples/teal-shore.jpg',
  },
]
