import { test, expect } from 'claude-code/testing'

import { parseProgram, ScriptError } from './lang'
import { cleanScript, stage } from './script'

// Runs source and returns what its result() function answers.
const run = (source: string, budget = 1_000_000) => {
  const program = parseProgram(source)
  program.start({}, budget)

  return program.call('result', [], {}, budget)
}

test('the language runs ordinary JavaScript', () => {
  expect(run('function result() { let s = 0; for (let i = 0; i < 10; i++) { if (i % 2) continue; s += i } return s }')).toBe(20)
  expect(run('const f = (a, b = 2) => a * b; function result() { return [f(3), f(3, 3)] }')).toEqual([6, 9])
  expect(run('function result() { const xs = Array.from({length: 5}, (_, i) => i * i); return xs.filter(x => x > 3).map(x => x + 1).reduce((a, b) => a + b, 0) }')).toBe(32)
  expect(run('let p = {x: 1, y: 2}; function result() { const {x, y} = p; const [a, , c] = [7, 8, 9]; return `${x + y}:${a}${c}` }')).toBe('3:79')
  expect(run('function result() { let n = 0; for (const k in {a: 1, b: 2}) n++; for (const ch of "hey") n++; let i = 0; while (true) { if (++i > 4) break } return n + i }')).toBe(10)
  expect(run('function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) } function result() { return fib(15) }')).toBe(610)
  expect(run('let count = 0; const inc = () => { count += 1; return count }; function result() { inc(); inc(); return [count, Math.max(...[3, 9, 2]), "a-b".split("-"), [3, 1, 2].sort((a, b) => a - b), {...{a: 1}, b: 2}.b] }')).toEqual([2, 9, ['a', 'b'], [1, 2, 3], 2])
  expect(run('function result() { const g = new Array(3).fill(0); g[1] = 5; return g }')).toEqual([0, 5, 0])
})

test('the language state persists between frames', () => {
  const program = parseProgram('let x = 0; function frame(t, dt) { x += dt; return x }')
  program.start({}, 1000)
  program.call('frame', [0, 0.5], {}, 1000)
  expect(program.call('frame', [0, 0.25], {}, 1000)).toBe(0.75)
})

test('the language reaches nothing outside itself', () => {
  expect(run('function result() { return [].constructor }')).toBeUndefined()
  expect(run('function result() { return ({}).constructor }')).toBeUndefined()
  expect(run('function result() { return "x".constructor }')).toBeUndefined()
  expect(run('function result() { return Math.max.constructor }')).toBeUndefined()
  expect(run('function result() { return [].map.call }')).toBeUndefined()
  expect(run('function result() { return typeof globalThis }')).toBe('undefined')
  expect(() => run('function result() { return globalThis.process }')).toThrow(ScriptError)
  expect(() => run('function result() { return eval("1") }')).toThrow(ScriptError)
})

test('a runaway program stops with an error instead of hanging', () => {
  expect(() => run('function result() { while (true) {} }', 10_000)).toThrow('took too long')
  expect(() => run('function f() { return f() } function result() { return f() }', 10_000_000)).toThrow(ScriptError)
  expect(() => run('function result() { let a = []; for (;;) a.push(1, 2, 3, 4, 5, 6, 7, 8) }', 10_000_000)).toThrow(ScriptError)
  expect(() => parseProgram('let x = ;')).toThrow(ScriptError)
})

const SCENE = { background: { effect: 'starfield', palette: ['#fff', '#88f'], speed: 1, intensity: 0 }, actors: [], particles: [] }
const decode = (cells: string) => new Uint32Array(Uint8Array.from(atob(cells), c => c.charCodeAt(0)).buffer)
const charAt = (words: Uint32Array, cols: number, x: number, y: number) => String.fromCodePoint(words[(y * cols + x) * 3] ?? 0x20)

test('scene code draws every frame, keeps its state, and can draw Clawd talking', () => {
  const script = cleanScript({
    ...SCENE,
    code: 'let n = 0\nfunction frame(t, dt) { n++; text(0, 0, `n${n}`, "#fff"); put(w - 1, h - 1, "@", rgb(255, 0, 0)); clawd(10, 4, 1, 0, false); say("hello there", 17, 4) }',
  })
  expect(script?.code?.error).toBeUndefined()
  let words = new Uint32Array()
  for (const since of [0, 50, 2000]) words = decode(script ? stage({ cols: 40, rows: 9, t: 0, script, since, reveal: 1 }) : '')
  expect(charAt(words, 40, 0, 0) + charAt(words, 40, 1, 0)).toBe('n3')
  expect(charAt(words, 40, 39, 8)).toBe('@')
  expect(words[(8 * 40 + 39) * 3 + 1]).toBe(0xff0000)
  expect(['▀', '▄']).toContain(charAt(words, 40, 12, 5))
  const row = (y: number) => Array.from({ length: 40 }, (_, x) => charAt(words, 40, x, y)).join('')
  expect([0, 1, 2].map(row).join('\n')).toContain('hello there')
})

test('scene code that breaks stops, says why, and the rest still draws', () => {
  const script = cleanScript({ ...SCENE, code: 'function frame() { nope() }' })
  const cells = script && stage({ cols: 20, rows: 4, t: 0, script, since: 100, reveal: 1 })
  expect(cells?.length).toBeGreaterThan(0)
  expect(script?.code?.error).toContain('nope is not defined')
  expect(cleanScript({ ...SCENE, code: 'let = 3' })?.code?.error).toBeDefined()
  expect(cleanScript({ ...SCENE, code: '' })?.code).toBeUndefined()
})

test('switch works and each for (let ...) turn keeps its own variable', () => {
  expect(run('function result() { const out = []; for (const n of [1, 2, 3, 9]) { switch (n) { case 1: out.push("a"); break; case 2: case 3: out.push("bc"); break; default: out.push("z") } } return out }')).toEqual(['a', 'bc', 'bc', 'z'])
  expect(run('function result() { const fs = []; for (let i = 0; i < 3; i++) fs.push(() => i); return fs.map(f => f()) }')).toEqual([0, 1, 2])
  expect(run('function result() { let s = 0; for (let i = 0; i < 5; i++) { if (i == 3) break; s += i } return s }')).toBe(3)
})

test('a line that changes once typed shows whole instead of retyping every frame', () => {
  const script = cleanScript({ ...SCENE, code: 'function frame(t) { say(`${Math.floor(t * 10)} bugs left`, 20, 8) }' })
  let words = new Uint32Array()
  for (const since of [0, 1000, 1050]) words = decode(script ? stage({ cols: 40, rows: 9, t: 0, script, since, reveal: 1 }) : '')
  const rows = Array.from({ length: 9 }, (_, y) => Array.from({ length: 40 }, (_, x) => charAt(words, 40, x, y)).join('')).join('\n')
  expect(rows).toContain('10 bugs left')
})

test('colors must be 3 or 6 hex digits', () => {
  const script = cleanScript({ background: { effect: 'rain', palette: ['#abcd', '#123', '#456789'], speed: 1, intensity: 0 }, actors: [], particles: [] })
  expect(script?.background.palette).toEqual(['#123', '#456789'])
})

const colorAt = (words: Uint32Array, cols: number, x: number, y: number) => words[(y * cols + x) * 3 + 1]
const backAt = (words: Uint32Array, cols: number, x: number, y: number) => words[(y * cols + x) * 3 + 2]

test('pixels share a cell: two pixels in one cell become a half block with two colors', () => {
  const script = cleanScript({ ...SCENE, code: 'function frame() { pixel(0, 0, "#ff0000"); pixel(0, 1, "#0000ff"); pixel(1, 1, "#00ff00"); text(2, 0, "A", "#fff"); pixel(2, 1, "#00ff00") }' })
  const words = decode(script ? stage({ cols: 4, rows: 1, t: 0, script, since: 100, reveal: 1 }) : '')
  expect(charAt(words, 4, 0, 0)).toBe('▀')
  expect(colorAt(words, 4, 0, 0)).toBe(0xff0000)
  expect(backAt(words, 4, 0, 0)).toBe(0x0000ff)
  expect(charAt(words, 4, 1, 0)).toBe('▄')
  expect(colorAt(words, 4, 1, 0)).toBe(0x00ff00)
  // A pixel over text replaces the text in that cell.
  expect(charAt(words, 4, 2, 0)).toBe('▄')
})

test('clawd takes options, returns anchors, and wears what is drawn at them', () => {
  const script = cleanScript({
    ...SCENE,
    code: 'let c\nfunction frame() { c = clawd(10, 2, {scale: 2, color: "#00ff00", eyes: "wide", pose: "sit"}); pixels(c.top.x - 1, c.top.py - 1, "###", {"#": "#ffff00"}); text(0, 0, `${c.w} ${c.h} ${c.feet.py - c.py}`, "#fff") }',
  })
  const words = decode(script ? stage({ cols: 60, rows: 9, t: 0, script, since: 100, reveal: 1 }) : '')
  expect(script?.code?.error).toBeUndefined()
  const row = (y: number) => Array.from({ length: 60 }, (_, x) => charAt(words, 60, x, y)).join('')
  expect(row(0)).toContain('28 16 16')
  // The crown's yellow sits just above the green head.
  const rowsWith = (color: number) =>
    Array.from({ length: 9 }, (_, y) => y).filter(y => Array.from({ length: 60 }, (_, x) => colorAt(words, 60, x, y) === color || backAt(words, 60, x, y) === color).some(Boolean))
  const crown = rowsWith(0xffff00)
  const body = rowsWith(0x00ff00)
  expect(crown.length).toBe(1)
  expect(body.length).toBeGreaterThan(4)
  expect(crown[0]).toBe(Math.min(...body) - 1)
})

test('a 3D box shades, projects, and hides what is behind it', () => {
  const script = cleanScript({
    ...SCENE,
    code: [
      'const cube = box(2, 2, 2)',
      'function frame() {',
      '  mesh3d(cube, {y: 1, color: "#ffffff"})',
      '  mesh3d(box(2, 2, 2), {y: 1, z: -6, color: "#ff0000"})',
      '  const p = project(0, 1, 0)',
      '  const far = clawd3d(0, 0, -30, {size: 1})',
      '  const behind = clawd3d(0, 0, 20)',
      '  text(0, 0, `${p.x} ${p.y} ${Math.round(p.depth)} ${far ? far.h : "-"} ${behind === null}`, "#fff")',
      '}',
    ].join('\n'),
  })
  const words = decode(script ? stage({ cols: 120, rows: 9, t: 0, script, since: 100, reveal: 1 }) : '')
  expect(script?.code?.error).toBeUndefined()
  const row = (y: number) => Array.from({ length: 120 }, (_, x) => charAt(words, 120, x, y)).join('')
  // The origin lands mid-strip, a little over 9 units away; a far Clawd is a few pixels tall.
  expect(row(0)).toMatch(/^60 [45] 9 [2-4] true/)
  // The near cube covers the middle; its faces are shades of the same white, never red.
  let lit = 0
  for (let y = 2; y < 8; y++) {
    const c = colorAt(words, 120, 60, y) ?? 0
    const r = (c >> 16) & 255
    const g = (c >> 8) & 255
    if (c !== 0x01000000 && r === g && r > 40) lit += 1
  }
  expect(lit).toBeGreaterThan(2)
})
