import { test, expect } from 'claude-code/testing'

import { parseProgram, ScriptError } from './lang'
import { box, prepare } from './render3d'
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

test('work the host does on one step still ends by the clock', () => {
  // Copying a huge object and reading a long string as a number burn almost
  // no fuel; the frame's time budget stops them instead.
  const timed = (source: string) => {
    const program = parseProgram(source)
    program.start({}, 1_000_000, 2000)
    const began = performance.now()
    expect(() => program.call('frame', [], {}, 150_000, 40)).toThrow('took too long')
    expect(performance.now() - began).toBeLessThan(1000)
  }
  timed('const o = {}; for (let i = 0; i < 50000; i++) o["k" + i] = i; function frame() { for (let i = 0; i < 30000; i++) { const c = {...o} } }')
  timed('const o = {}; for (let i = 0; i < 50000; i++) o["k" + i] = i; function frame() { for (let i = 0; i < 30000; i++) for (const k in o) break }')
  timed('const a = "1".repeat(100000); function frame() { let n = 0; for (let i = 0; i < 1e6; i++) n += +a; return n }')
  timed('const a = "1".repeat(100000); function frame() { let n = 0; for (let i = 0; i < 1e6; i++) n += parseInt(a); return n }')
})

test('objects coerce as in JavaScript, ?.5 is a ternary, and methods see this', () => {
  expect(run('function result() { const o = {}; return [o == 1, o < 1, o - 1, isNaN(o), [{a: 2}, {a: 1}].sort().length, o == o, o == {}] }')).toEqual([false, false, NaN, true, 2, true, false])
  expect(run('function result() { const o = {}; const k = {}; o[k] = 3; return o["[object Object]"] }')).toBe(3)
  expect(run('function result() { const t = 1; return t > 0 ? .5 : .25 }')).toBe(0.5)
  expect(run('function result() { const t = 1; return t>0?.5:.25 }')).toBe(0.5)
  expect(run('function result() { const o = {x: 4, f() { return this.x }, g() { return [1].map(() => this.x)[0] }}; return [o.f(), o.g(), o?.f()] }')).toEqual([4, 4, 4])
  expect(() => run('function result() { const o = {}; return typeof o.a.b }')).toThrow(ScriptError)
  expect(run('function result() { return typeof nothingHere }')).toBe('undefined')
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

test('a mesh that is legal but absurd is drawn or stopped within the frame budget', () => {
  const timed = (code: string) => {
    const script = cleanScript({ ...SCENE, code })
    const began = performance.now()
    const cells = script && stage({ cols: 80, rows: 9, t: 0, script, since: 100, reveal: 1 })
    expect(cells?.length).toBeGreaterThan(0)
    expect(performance.now() - began).toBeLessThan(600)

    // Drawn whole, or stopped at the frame's deadline: either, but never a hang.
    return script?.code?.error ?? 'took more than'
  }
  // 20,000 faces on three vertices: preparing it was quadratic in the faces around a vertex.
  expect(timed('function frame() { const f = Array(60000).fill(0); for (let i = 0; i < 60000; i += 3) { f[i + 1] = 1; f[i + 2] = 2 } mesh3d({verts: [0,0,0, 1,0,0, 0,1,0], faces: f}) }')).toContain('took more than')
  // One polygon of 99,999 indices fans into as many triangles.
  expect(timed('const big = Array(99999).fill(0); for (let i = 0; i < 99999; i++) big[i] = i % 3; function frame() { mesh3d({verts: [0,0,0, 1,0,0, 0,1,0], faces: Array(20).fill(big)}) }')).toContain('took more than')
  // Thousands of triangles each covering the whole strip, each nearer than the last.
  expect(timed('function frame() { const v = [], f = []; for (let i = 0; i < 6000; i++) { const z = 8 - i * 0.001; v.push(-100,-100,z, 100,-100,z, 0,100,z); f.push(i*3, i*3+1, i*3+2) } mesh3d({verts: v, faces: f}) }')).toContain('took more than')
  // A corner at infinity owns nothing.
  expect(timed('function frame() { mesh3d(box(1e308, 1e308, 1e308)); mesh3d(box(1, 1, 1), {z: -3}) }')).toBe('took more than')
  // Loops of clawd() and say() count against the frame's time.
  expect(timed('function frame() { for (let i = 0; i < 60000; i++) clawd(10, 2, {scale: 4}) }')).toContain('too long')
  expect(timed('function frame() { for (let i = 0; i < 70000; i++) say("hello there", 10, 4) }')).toContain('too long')
})

test('primitives are shared by their arguments, and text from objects does not break the scene', () => {
  const shared = cleanScript({ ...SCENE, code: 'function frame() { if (sphere(1, 48) !== sphere(1, 48) || box(1, 2, 3) === box(1, 2, 4)) nope() }' })
  stage({ cols: 40, rows: 9, t: 0, script: shared!, since: 100, reveal: 1 })
  expect(shared?.code?.error).toBeUndefined()
  const script = cleanScript({ ...SCENE, code: 'function frame() { text(0, 0, {a: 1}); say({a: 1}, 0, 0); text(0, 1, [{a: 1}, 2]); put(0, 2, {}) }' })
  stage({ cols: 40, rows: 9, t: 0, script: script!, since: 100, reveal: 1 })
  expect(script?.code?.error).toBeUndefined()
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

test('a nearer mesh drawn after clawd3d covers it, and a farther one does not', () => {
  const render = (z: number) => {
    const script = cleanScript({ ...SCENE, code: `function frame() { clawd3d(0, 0, 0, {size: 1.5}); mesh3d(box(6, 3, 0.2), {y: 1.5, z: ${z}, color: "#ffffff"}) }` })
    const words = decode(script ? stage({ cols: 120, rows: 9, t: 0, script, since: 100, reveal: 1 }) : '')
    // Clawd is lit, so any shade of its orange counts.
    const isOrange = (c: number | undefined) => {
      if (c === undefined) return false
      const r = (c >> 16) & 255
      const g = (c >> 8) & 255
      const b = c & 255

      return r > 60 && r > g + 20 && g > b
    }
    let orange = 0
    for (let y = 0; y < 9; y++) for (let x = 0; x < 120; x++) if (isOrange(colorAt(words, 120, x, y)) || isOrange(backAt(words, 120, x, y))) orange += 1

    return orange
  }
  expect(render(4)).toBe(0)
  expect(render(-4)).toBeGreaterThan(20)
})

// A scene staged at the usual size, and the cells of one color in it.
const staged = (code: string) => {
  const script = cleanScript({ ...SCENE, code })
  expect(script?.code?.error).toBeUndefined()

  return decode(script ? stage({ cols: 120, rows: 9, t: 0, script, since: 100, reveal: 1 }) : '')
}
const cellsOf = (words: Uint32Array, color: number) => {
  const found: [number, number][] = []
  for (let y = 0; y < 9; y++) for (let x = 0; x < 120; x++) if (colorAt(words, 120, x, y) === color || backAt(words, 120, x, y) === color) found.push([x, y])

  return found
}

test('a plain floor receding to the horizon gets no rim band', () => {
  // Unlit and unfogged, so every cell the floor covers is exactly its color;
  // a rim would darken the far rows to 45%.
  const words = staged('function frame() { fog(1000, 2000); mesh3d(plane(200, 200), {color: "#cccccc", unlit: true}) }')
  const rim = Math.round(0xcc * 0.45)
  expect(cellsOf(words, (rim << 16) | (rim << 8) | rim)).toEqual([])
  const floor = cellsOf(words, 0xcccccc)
  expect(floor.length).toBeGreaterThan(400)
  expect(floor.some(([, y]) => y <= 2)).toBe(true)
  // The rim still marks a nearer slab in front of a farther one.
  const over = staged('function frame() { fog(1000, 2000); mesh3d(box(4, 4, 0.2), {x: 1.5, y: 1, z: -4, color: "#cccccc", unlit: true}); mesh3d(box(2, 2, 0.2), {x: -0.5, y: 1, color: "#cccccc", unlit: true}) }')
  expect(cellsOf(over, (rim << 16) | (rim << 8) | rim).length).toBeGreaterThan(3)
})

test('a wire box draws its twelve edges, with no diagonal across a face', () => {
  expect(prepare(box(1, 1, 1)).edges.length).toBe(24)
  // Seen head-on, the front face's center cell holds no edge.
  const words = staged('function frame() { fog(1000, 2000); camera(0, 1, 9, 0, 1, 0); mesh3d(box(4, 4, 4), {y: 1, wire: true, color: "#ffffff"}) }')
  const wire = cellsOf(words, 0xffffff)
  // Four vertical edges cross the strip (each one or two columns wide, as
  // its dabs fall); the rest of the box is above and below the strip.
  expect(wire.length).toBeGreaterThanOrEqual(36)
  expect(wire.length).toBeLessThanOrEqual(72)
  expect(wire.filter(([x]) => x > 50 && x < 70)).toEqual([])
})

test('a line cut at the near plane is drawn without gaps', () => {
  const words = staged('function frame() { fog(1000, 2000); line3d(6, 0, 20, 6, 0, -40, "#ffffff") }')
  const line = cellsOf(words, 0xffffff)
  expect(line.length).toBeGreaterThan(40)
  // Each row's cells run unbroken, and each row's run touches the next.
  const runs = Array.from({ length: 9 }, (_, y) => line.filter(([, row]) => row === y).map(([x]) => x))
  const drawn = runs.filter(r => r.length > 0)
  expect(drawn.length).toBeGreaterThan(6)
  for (const run of drawn) expect(Math.max(...run) - Math.min(...run) + 1).toBe(run.length)
  for (let i = 0; i + 1 < drawn.length; i++) {
    expect(Math.min(...drawn[i + 1]!)).toBeLessThanOrEqual(Math.max(...drawn[i]!) + 1)
    expect(Math.max(...drawn[i + 1]!)).toBeGreaterThanOrEqual(Math.min(...drawn[i]!) - 1)
  }
})

test('a pixel drawn over a quarter-block edge keeps the other half', () => {
  const script = cleanScript({ ...SCENE, code: 'function frame() { put(0, 0, "▘", "#ff0000"); pixel(0, 1, "#00ff00") }' })
  const words = decode(script ? stage({ cols: 2, rows: 1, t: 0, script, since: 100, reveal: 1 }) : '')
  expect(charAt(words, 2, 0, 0)).toBe('▀')
  expect(colorAt(words, 2, 0, 0)).toBe(0xff0000)
  expect(backAt(words, 2, 0, 0)).toBe(0x00ff00)
})
