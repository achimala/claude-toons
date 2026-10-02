import { test, expect } from 'claude-code/testing'

import { cleanScript, stage } from './script'

const SCENE = { background: { effect: 'starfield', palette: ['#fff', '#88f'], speed: 1, intensity: 0 }, actors: [], particles: [] }
const decode = (cells: string) => new Uint32Array(Uint8Array.from(atob(cells), c => c.charCodeAt(0)).buffer)
const render = (code: string, cols = 80, since = 100) => {
  const script = cleanScript({ ...SCENE, code })
  if (!script) throw new Error('bad script')

  return { words: decode(stage({ cols, rows: 9, t: 0, script, since, reveal: 1 })), cols, error: script.code?.error }
}
// Cells whose foreground or background is a shade of Clawd's orange (lit or
// in shadow), and cells holding its eye color.
const isOrange = (c: number) => {
  const r = (c >> 16) & 255
  const g = (c >> 8) & 255
  const b = c & 255

  return r > 60 && r > g + 20 && g > b
}
const EYE = 0x2a1610
const cells = (words: Uint32Array, cols: number, test: (c: number) => boolean) => {
  const found: { x: number; y: number }[] = []
  for (let y = 0; y < 9; y++) for (let x = 0; x < cols; x++) if (test(words[(y * cols + x) * 3 + 1]!) || test(words[(y * cols + x) * 3 + 2]!)) found.push({ x, y })

  return found
}

test('Clawd in 3D is lit, with both eyes whole, at any distance', () => {
  for (const z of [0, -6, 4]) {
    const { words, cols, error } = render(`function frame(){ light(1, 0.5, 0.5, 0.3); clawd3d(0, 0, ${z}) }`)
    expect(error).toBeUndefined()
    const body = cells(words, cols, isOrange)
    expect(body.length).toBeGreaterThan(8)
    // Lit from the right, its sides differ in shade.
    expect(new Set(body.map(c => words[(c.y * cols + c.x) * 3 + 1])).size).toBeGreaterThan(1)
    const eyes = cells(words, cols, c => c === EYE)
    expect(new Set(eyes.map(e => e.x)).size).toBeGreaterThanOrEqual(2)
  }
})

test('a Clawd near the camera stands on the bottom edge instead of falling out of view', () => {
  const { words, cols } = render('function frame(){ clawd3d(0, 0, 5) }')
  const body = cells(words, cols, isOrange)
  expect(body.length).toBeGreaterThan(30)
  expect(Math.max(...body.map(c => c.y))).toBe(8)
  expect(Math.min(...body.map(c => c.y))).toBeGreaterThanOrEqual(2)
})

test('clawd3d returns anchors on the solid, and null behind the camera', () => {
  const { words, cols, error } = render('let a; function frame(){ a = clawd3d(0, 0, 0); text(0, 0, a ? `${a.top.row} ${a.feet.row} ${a.eyes.w}` : "none"); text(0, 1, clawd3d(0, 0, 20) === null ? "behind" : "seen") }')
  expect(error).toBeUndefined()
  const line = (y: number) => Array.from({ length: cols }, (_, x) => String.fromCodePoint(words[(y * cols + x) * 3]! || 32)).join('')
  const [top, feet] = line(0).split(' ').map(Number)
  expect(top).toBeLessThan(feet!)
  expect(line(1).startsWith('behind')).toBe(true)
})

test('rain drawn cell by cell does not push a speech bubble around', () => {
  // The bubble types out from its first frame, so the scene is staged twice.
  const where = (extra: string) => {
    const script = cleanScript({ ...SCENE, code: `function frame(){ ${extra} clawd(30, 4); say("hi there friend", 37, 4) }` })
    if (!script) throw new Error('bad script')
    const cols = 80
    stage({ cols, rows: 9, t: 0, script, since: 100, reveal: 1 })
    const words = decode(stage({ cols, rows: 9, t: 5, script, since: 5000, reveal: 1 }))
    const at = Array.from({ length: 9 * cols }, (_, i) => (words[i * 3] === 'f'.codePointAt(0) ? i : -1)).filter(i => i >= 0)
    expect(at.length).toBeGreaterThan(0)

    return JSON.stringify(at)
  }
  const rain = 'for (let k = 0; k < 60; k++) put((k * 7) % w, k % h, "|", "#6fa8dc");'
  expect(where(rain)).toBe(where(''))
  // A label, drawn as a run of cells, still is kept clear of.
  expect(where('text(28, 1, "src/auth.ts", "#fff");')).not.toBe(where(''))
})

test('drawing far off the strip, or for too long, stops the scene instead of the terminal', () => {
  const far = render('function frame(){ clawd(1e16, 0) }')
  expect(far.error).toBeUndefined()
  const slow = render('function frame(){ for (let i = 0; i < 400; i++) fill(-100, -20, 1e9, 1e9, " ", null, "#333") }')
  expect(slow.error).toContain('took more than')
})

test('a blank actor still speaks, and a long word in a bubble is kept whole across lines', () => {
  const script = cleanScript({ ...SCENE, actors: [{ kind: 'sprite', frames: ['   \n   '], fps: 0, x: '20', y: '3', color: '#fff', say: 'supercalifragilisticexpialidocious yes', sayAt: 0 }] })
  if (!script) throw new Error('bad script')
  const cols = 80
  const words = decode(stage({ cols, rows: 9, t: 0, script, since: 20_000, reveal: 1 }))
  const text = Array.from({ length: 9 * cols }, (_, i) => String.fromCodePoint(words[i * 3]! || 32)).join('')
  expect(text).toContain('supercalifragilisticexpialidoc')
  expect(text).toContain('ious')
})

test('a new code scene dissolves in cell by cell over the one before it', () => {
  const paint = (hex: string) => cleanScript({ ...SCENE, code: `function frame(){ fill(0, 0, w, h, ' ', null, '${hex}') }` })
  const previous = paint('#ff0000')
  const script = paint('#0000ff')
  if (!previous || !script) throw new Error('bad script')
  const count = (since: number) => {
    const words = decode(stage({ cols: 60, rows: 9, t: 0, script, previous, since, previousSince: since + 4000, reveal: 1 }))
    let red = 0
    let blue = 0
    let empty = 0
    for (let i = 0; i < 60 * 9; i++) {
      const c = words[i * 3 + 2]
      if (c === 0xff0000) red += 1
      else if (c === 0x0000ff) blue += 1
      else empty += 1
    }

    return { red, blue, empty }
  }
  // Just after the switch: the old scene, whole.
  expect(count(0)).toMatchObject({ red: 540, blue: 0, empty: 0 })
  // Halfway: a mix, with no cell left out.
  const mid = count(250)
  expect(mid.red).toBeGreaterThan(150)
  expect(mid.blue).toBeGreaterThan(150)
  expect(mid.empty).toBe(0)
  // Done: the new scene alone, and the old one's code no longer runs.
  expect(count(600)).toMatchObject({ red: 0, blue: 540, empty: 0 })
})
