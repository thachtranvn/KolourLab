/**
 * A synthetic test image so the tools can be tried without opening a file.
 * It deliberately contains a wide hue spread, skin tones, a neutral ramp and
 * clipped highlights — the things the colour tools are meant to act on.
 */
export function makeSampleImage(): HTMLCanvasElement {
  const W = 1600, H = 1000
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const c = cv.getContext('2d')!

  // sky
  const sky = c.createLinearGradient(0, 0, 0, H * 0.62)
  sky.addColorStop(0, '#1b3b6f')
  sky.addColorStop(0.45, '#5e86b8')
  sky.addColorStop(0.8, '#e0a35c')
  sky.addColorStop(1, '#f6d9a0')
  c.fillStyle = sky
  c.fillRect(0, 0, W, H * 0.62)

  // sun with a soft bloom (blows out the highlights)
  const sun = c.createRadialGradient(W * 0.72, H * 0.42, 4, W * 0.72, H * 0.42, 190)
  sun.addColorStop(0, 'rgba(255,255,250,1)')
  sun.addColorStop(0.25, 'rgba(255,236,190,0.95)')
  sun.addColorStop(1, 'rgba(255,200,120,0)')
  c.fillStyle = sun
  c.fillRect(W * 0.42, H * 0.12, 620, 620)

  // distant ridge
  c.fillStyle = '#6b7f93'
  c.beginPath()
  c.moveTo(0, H * 0.6)
  for (let x = 0; x <= W; x += 40) {
    c.lineTo(x, H * 0.6 - 90 * Math.abs(Math.sin(x * 0.0031)) - 30 * Math.sin(x * 0.011))
  }
  c.lineTo(W, H * 0.66)
  c.lineTo(0, H * 0.66)
  c.fill()

  // near ridge
  c.fillStyle = '#3d5a4a'
  c.beginPath()
  c.moveTo(0, H * 0.66)
  for (let x = 0; x <= W; x += 30) {
    c.lineTo(x, H * 0.66 - 70 * Math.abs(Math.sin(x * 0.0047 + 1.2)))
  }
  c.lineTo(W, H)
  c.lineTo(0, H)
  c.fill()

  // water
  const water = c.createLinearGradient(0, H * 0.72, 0, H)
  water.addColorStop(0, '#2c4f63')
  water.addColorStop(1, '#14212e')
  c.fillStyle = water
  c.fillRect(0, H * 0.72, W, H * 0.28)
  c.globalAlpha = 0.25
  c.strokeStyle = '#d8b98a'
  c.lineWidth = 3
  for (let y = H * 0.74; y < H; y += 16) {
    c.beginPath()
    c.moveTo(W * 0.62 - (y - H * 0.74) * 0.5, y)
    c.lineTo(W * 0.82 + (y - H * 0.74) * 0.5, y)
    c.stroke()
  }
  c.globalAlpha = 1

  // foliage blobs (saturated greens/yellows for Selective Color and Hue/Sat)
  const greens = ['#2f6b32', '#457f28', '#6a9b2f', '#8fae35', '#244f2b']
  for (let i = 0; i < 26; i++) {
    const x = (i * 137) % W
    const y = H * 0.68 + ((i * 61) % Math.round(H * 0.28))
    c.fillStyle = greens[i % greens.length]
    c.beginPath()
    c.ellipse(x, y, 60 + (i % 5) * 16, 26 + (i % 3) * 10, i * 0.4, 0, Math.PI * 2)
    c.fill()
  }

  // skin-tone swatches
  const skins = ['#f2d3b8', '#e0b48c', '#c68a5f', '#9d6641', '#6f4530']
  skins.forEach((s, i) => {
    c.fillStyle = s
    c.fillRect(60 + i * 96, 70, 88, 88)
  })

  // colour checker
  const chips = [
    '#d43d3d', '#e07f2a', '#e8c93a', '#5aa93c', '#2f9c8f',
    '#2f6fc4', '#5b46b5', '#a83ba0', '#d3538a', '#7a5c3e',
  ]
  chips.forEach((s, i) => {
    c.fillStyle = s
    c.fillRect(60 + i * 68, H - 190, 60, 60)
  })

  // neutral ramp (shows banding, gradient maps and levels clearly)
  for (let i = 0; i < 16; i++) {
    const v = Math.round((i / 15) * 255)
    c.fillStyle = `rgb(${v},${v},${v})`
    c.fillRect(60 + i * 42, H - 110, 40, 60)
  }

  return cv
}
