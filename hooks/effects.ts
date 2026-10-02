// Procedural effects for the spinner: each one a field from a pixel to a
// value in [0, 1], mapped through the scene's palette and packed into a
// Raster's cells (upper half blocks, two pixels a row).

export const EFFECTS = [
  'plasma', 'fire', 'starfield', 'rain', 'tunnel', 'lava', 'glitch', 'aurora', 'waves', 'pulse', 'fireworks',
] as const
export type Effect = (typeof EFFECTS)[number]

// The ambient layer behind a scene: one effect, faint and see-through.
export type Background = {
  effect: Effect
  palette: string[]
  speed: number
  intensity: number
}

type Field = (x: number, y: number, t: number, w: number, h: number) => number

const fract = (v: number) => v - Math.floor(v)
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const hash = (x: number, y: number) => fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453)

function noise(x: number, y: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = hash(ix, iy)
  const b = hash(ix + 1, iy)
  const c = hash(ix, iy + 1)
  const d = hash(ix + 1, iy + 1)

  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

// Cells are about twice as tall as wide, so x distances count half.
const polar = (x: number, y: number, w: number, h: number) => {
  const dx = (x - w / 2) * 0.5
  const dy = y - h / 2

  return { r: Math.hypot(dx, dy), a: Math.atan2(dy, dx) }
}

const FIELDS: Record<Effect, Field> = {
  plasma: (x, y, t) =>
    (Math.sin(x * 0.08 + t) + Math.sin(y * 0.3 + t * 1.3) + Math.sin((x + y) * 0.05 + t * 0.7) +
      Math.sin(Math.hypot(x * 0.5, y) * 0.2 - t)) / 8 + 0.5,
  fire: (x, y, t, _w, h) => clamp(noise(x * 0.15, y * 0.45 + t * 3) * 1.5 * Math.pow(y / h, 1.3) + noise(x * 0.4, t * 5) * 0.15 * (y / h)),
  starfield: (x, y, t, w, h) => {
    const { r, a } = polar(x, y, w, h)
    const ray = Math.floor((a + Math.PI) * 24)
    const z = fract(hash(ray, 3) + t * 0.25)
    const reach = Math.hypot(w * 0.25, h * 0.5)

    return clamp(Math.exp(-Math.abs(r - z * reach) * 1.2) * z * 1.6)
  },
  rain: (x, y, t, _w, h) => {
    const head = fract(hash(x, 2) + t * (0.3 + hash(x, 1) * 0.5)) * (h + 12)
    const d = head - y

    return d >= 0 && d < 10 ? 1 - d / 10 : hash(x, Math.floor(y + t * 4)) * 0.08
  },
  tunnel: (x, y, t, w, h) => {
    const { r, a } = polar(x, y, w, h)

    return 0.5 + 0.5 * Math.sin(30 / (r + 2) + t * 4) * Math.cos(a * 3 + t)
  },
  lava: (x, y, t, w, h) => {
    let sum = 0
    for (let i = 0; i < 6; i++) {
      const bx = (0.5 + 0.45 * Math.sin(t * (0.3 + i * 0.11) + i * 2.1)) * w
      const by = (0.5 + 0.45 * Math.cos(t * (0.4 + i * 0.07) + i * 1.3)) * h
      sum += 6 / (Math.hypot((x - bx) * 0.5, y - by) + 0.5)
    }

    return clamp((sum - 2.2) / 2)
  },
  glitch: (x, y, t) => {
    const frame = Math.floor(t * 9)
    const shift = hash(Math.floor(y / 2), frame) > 0.75 ? Math.floor(hash(y, frame) * 24) : 0
    const block = hash(Math.floor((x + shift) / 5), Math.floor(y / 3) + frame * 7)

    return block > 0.6 ? block : 0.5 + 0.5 * Math.sin((x + shift) * 0.1 + t * 2) * 0.4
  },
  aurora: (x, y, t, _w, h) => {
    const center = h * (0.45 + 0.25 * Math.sin(x * 0.04 + t * 0.6) + 0.12 * Math.sin(x * 0.11 - t * 1.4))
    const band = (y - center) / (2.5 + 3 * noise(x * 0.05, t * 0.5))

    return clamp(Math.exp(-band * band) * (0.6 + 0.4 * noise(x * 0.2, t * 2)))
  },
  waves: (x, y, t, _w, h) => {
    const surface = h * (0.5 + 0.3 * Math.sin(x * 0.09 - t * 2) * Math.sin(x * 0.023 + t * 0.7))

    return y > surface ? clamp(0.55 + 0.45 * Math.sin(x * 0.2 + y * 0.6 - t * 3)) : 0.1 * noise(x * 0.1, y * 0.3 + t)
  },
  pulse: (x, y, t, w, h) => {
    const { r } = polar(x, y, w, h)
    const ring = fract(t * 0.6) * Math.hypot(w * 0.25, h * 0.5)

    return clamp(Math.exp(-Math.abs(r - ring) * 0.6) + 0.15 * Math.sin(r * 0.5 - t * 3))
  },
  fireworks: (x, y, t, w, h) => {
    let v = 0
    for (let k = 0; k < 4; k++) {
      const cycle = Math.floor(t / 1.6 + k * 0.37)
      const age = fract(t / 1.6 + k * 0.37)
      const cx = hash(k, cycle) * w
      const cy = (0.2 + hash(cycle, k) * 0.6) * h
      const r = Math.hypot((x - cx) * 0.5, y - cy)
      const sparkle = hash(Math.floor(Math.atan2(y - cy, x - cx) * 6), cycle) > 0.4 ? 1 : 0.3
      v += Math.exp(-Math.abs(r - age * 14) * 1.3) * (1 - age) * sparkle
    }

    return clamp(v)
  },
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m || m[1] === undefined) return [128, 128, 128]
  const s = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]

  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

type Rgb = [number, number, number]

function shade(stops: Rgb[], v: number): Rgb {
  const p = clamp(v) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(p))
  const k = p - i
  const a = stops[i] ?? [0, 0, 0]
  const b = stops[i + 1] ?? a

  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

const pack = ([r, g, b]: Rgb) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
const dim = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const v = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += (B64[(v >> 18) & 63] ?? '') + (B64[(v >> 12) & 63] ?? '') + (B64[(v >> 6) & 63] ?? '') + (B64[v & 63] ?? '')
  }
  if (i < bytes.length) {
    const v = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += (B64[(v >> 18) & 63] ?? '') + (B64[(v >> 12) & 63] ?? '')
    out += i + 1 < bytes.length ? (B64[(v >> 6) & 63] ?? '') + '=' : '=='
  }

  return out
}

// The terminal's own color: what shows through wherever nothing is drawn.
export const CLEAR = 0x01000000

// A 4x4 ordered dither: a pixel of opacity a shows where a beats its cell, so
// a fade reads as a thinning pattern rather than a color against a background
// the oracle cannot know.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16)
const bayer = (x: number, y: number) => BAYER[(y & 3) * 4 + (x & 3)] ?? 0.5

export const smooth = (lo: number, hi: number, v: number) => {
  const k = clamp((v - lo) / (hi - lo))

  return k * k * (3 - 2 * k)
}

export type Paint = {
  cols: number
  rows: number
  t: number
  background: Background
  // The background being faded out, and how far the fade has gone (0 to 1).
  previous?: Background
  fade: number
  // How far the band has risen into view, 0 to 1, from the bottom up.
  reveal: number
  // How strongly the backdrop shows, 0 to 1: kept low behind a scene.
  strength: number
}

// Paints the backdrop into `words` (a Raster's cells): half blocks where the
// effect is dense enough, the terminal's own color everywhere else, thinning
// toward the band's edges and its rising front.
export function paintBackground(words: Uint32Array, paint: Paint) {
  const { cols, rows, t, background, previous, fade, reveal, strength } = paint
  const w = cols
  const h = rows * 2
  const stops = background.palette.map(parseHex)
  const oldStops = previous ? previous.palette.map(parseHex) : stops
  const pixel = (x: number, y: number): { c: Rgb; a: number } => {
    const v = FIELDS[background.effect](x, y, t * background.speed, w, h)
    let c = shade(stops, 0.15 + 0.85 * v)
    let a = smooth(0.2, 0.75, v) * (0.55 + 0.45 * background.intensity)
    if (previous && fade < 1) {
      const pv = FIELDS[previous.effect](x, y, t * previous.speed, w, h)
      c = mix(shade(oldStops, 0.15 + 0.85 * pv), c, fade)
      a = a * fade + smooth(0.2, 0.75, pv) * (0.55 + 0.45 * previous.intensity) * (1 - fade)
    }
    const edge = smooth(0, w * 0.14, Math.min(x, w - 1 - x)) * smooth(0, 2.5, Math.min(y + 0.5, h - 0.5 - y))
    const rise = (h - 1 - y) / Math.max(1, h - 1)
    const front = reveal * 1.35 - 0.3 * noise(x * 0.18, t * 1.5)
    a *= strength * edge * smooth(0, 0.25, front - rise)

    return { c, a }
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const at = (row * cols + col) * 3
      const top = pixel(col, row * 2)
      const bottom = pixel(col, row * 2 + 1)
      const isTop = top.a > bayer(col, row * 2)
      const isBottom = bottom.a > bayer(col, row * 2 + 1)
      words[at] = isTop || !isBottom ? (isTop ? 0x2580 : 0x20) : 0x2584
      words[at + 1] = isTop ? pack(top.c) : isBottom ? pack(bottom.c) : CLEAR
      words[at + 2] = isTop && isBottom ? pack(bottom.c) : CLEAR
    }
  }
}

export { parseHex, shade, mix, dim, hash, clamp, type Rgb }

export function encode(words: Uint32Array) {
  return base64(new Uint8Array(words.buffer))
}

export function cleanBackground(raw: unknown): Background | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const s = raw as Record<string, unknown>
  const effect = EFFECTS.find(name => name === s.effect)
  if (!effect) return undefined
  const palette = Array.isArray(s.palette)
    ? s.palette.filter((c): c is string => typeof c === 'string' && /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim())).slice(0, 6)
    : []
  if (palette.length < 2) return undefined

  return {
    effect,
    palette,
    speed: clamp(typeof s.speed === 'number' ? s.speed : 1, 0.1, 4),
    intensity: clamp(typeof s.intensity === 'number' ? s.intensity : 0.6),
  }
}

// Text the Raster can draw: one printable, single-width character a cell.
export function cleanText(text: string, most: number) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, most)
}
