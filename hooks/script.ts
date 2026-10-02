// Scenes the buddy scripts: actors with frames of ASCII art, moved by small
// math expressions of time, with speech, particle swarms and a faint backdrop.
// The expressions run in an interpreter of their own that knows arithmetic and
// a handful of functions, so a script can move things and nothing else.

import {
  CLEAR,
  cleanBackground,
  cleanText,
  clamp,
  dim,
  encode,
  hash,
  mix,
  paintBackground,
  parseHex,
  type Background,
  type Rgb,
} from './effects'
import { ARMS, CLAWD_H, CLAWD_ORANGE, CLAWD_W, LOOK, clawdAnchors, clawdPixels, type Anchors, type Arm, type ClawdLook, type Eyes, type Pose } from './clawd'
import { obj, parseProgram, type Program } from './lang'
import {
  DEFAULT_CAMERA,
  DEFAULT_FOG,
  DEFAULT_LIGHT,
  SX,
  SY,
  box,
  claimPixel,
  composite,
  createFrame,
  cylinder,
  drawLine,
  drawMesh,
  drawPoint,
  plane,
  project,
  resolve,
  sphere,
  type Camera,
  type Fog,
  type Frame,
  type Light,
  type Mesh,
  type Transform,
  type View,
} from './render3d'

type Env = { t: number; w: number; h: number; k: number; n: number }
type Expr = (env: Env) => number

const fract = (v: number) => v - Math.floor(v)
const mod = (a: number, b: number) => (b === 0 ? 0 : ((a % b) + b) % b)

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  abs: Math.abs,
  min: (...v) => Math.min(...v),
  max: (...v) => Math.max(...v),
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sqrt: v => Math.sqrt(Math.max(0, v)),
  pow: Math.pow,
  exp: Math.exp,
  sign: Math.sign,
  mod,
  fract,
  clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v)),
  lerp: (a, b, k) => a + (b - a) * k,
  // 0 up to 1 and back down over each unit of x.
  tri: v => 1 - Math.abs(2 * fract(v) - 1),
  // A steady pseudo-random number in [0, 1) for each x.
  rand: v => hash(v, 17),
  step: (edge, v) => (v >= edge ? 1 : 0),
  // 1 while lo <= v < hi.
  between: (v, lo, hi) => (v >= lo && v < hi ? 1 : 0),
  // 0 below a, 1 above b, eased in between.
  smoothstep: (a, b, v) => {
    const k = Math.min(1, Math.max(0, b === a ? (v >= b ? 1 : 0) : (v - a) / (b - a)))

    return k * k * (3 - 2 * k)
  },
  atan2: Math.atan2,
  hypot: (...v) => Math.hypot(...v),
  // Smooth wandering noise in [0, 1) along x.
  noise: v => {
    const i = Math.floor(v)
    const k = fract(v)

    return hash(i, 17) + (hash(i + 1, 17) - hash(i, 17)) * k * k * (3 - 2 * k)
  },
}

const VARIABLES = new Set(['t', 'w', 'h', 'k', 'n'])

// Compiles an expression to a function of the scene's variables; anything it
// cannot read compiles to a constant 0 rather than failing the scene.
export function compile(source: string): Expr {
  const tokens = source.slice(0, 240).match(/\d+\.?\d*|\.\d+|[a-z_]+|[-+*/%^(),]/gi) ?? []
  let at = 0
  const peek = () => tokens[at]
  const take = () => tokens[at++]
  type Node = Expr

  function primary(): Node {
    const token = take()
    if (token === undefined) throw new Error('end')
    if (token === '(') {
      const inner = sum()
      if (take() !== ')') throw new Error(')')

      return inner
    }
    if (token === '-') {
      const inner = power()

      return env => -inner(env)
    }
    if (token === '+') return power()
    if (/^[\d.]/.test(token)) {
      const value = Number(token)

      return () => value
    }
    const name = token.toLowerCase()
    if (name === 'pi') return () => Math.PI
    if (VARIABLES.has(name)) return env => env[name as keyof Env]
    const fn = FUNCTIONS[name]
    if (!fn || take() !== '(') throw new Error(name)
    const args: Node[] = []
    if (peek() !== ')') {
      args.push(sum())
      while (peek() === ',') {
        take()
        args.push(sum())
      }
    }
    if (take() !== ')') throw new Error(')')

    return env => fn(...args.map(arg => arg(env)))
  }
  function power(): Node {
    const base = primary()
    if (peek() !== '^') return base
    take()
    const exponent = power()

    return env => Math.pow(base(env), exponent(env))
  }
  function product(): Node {
    let left = power()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = take()
      const right = power()
      const l = left
      left = op === '*' ? env => l(env) * right(env) : op === '/' ? env => l(env) / right(env) : env => mod(l(env), right(env))
    }

    return left
  }
  function sum(): Node {
    let left = product()
    while (peek() === '+' || peek() === '-') {
      const op = take()
      const right = product()
      const l = left
      left = op === '+' ? env => l(env) + right(env) : env => l(env) - right(env)
    }

    return left
  }
  try {
    const expr = sum()
    if (at !== tokens.length) return () => 0

    return env => {
      const v = expr(env)

      return Number.isFinite(v) ? v : 0
    }
  } catch {
    return () => 0
  }
}

export type Actor = {
  // A sprite of the script's own frames, or Clawd, whom the stage draws.
  kind: 'sprite' | 'clawd'
  frames: string[][]
  fps: number
  x: Expr
  y: Expr
  color: string
  say: string
  // When the speech shows: seconds into the scene.
  sayAt: number
  // Drawn only while this is above 0; always when absent.
  show?: Expr
  // Which frame shows (wrapped to the frame count); by fps when absent.
  frame?: Expr
}

export type Swarm = { glyphs: string[]; count: number; x: Expr; y: Expr; color: string }

// A scene's own code: a program with a frame(t, dt) function that draws on
// the strip every frame, its state kept between frames.
export type Code = {
  program?: Program
  isStarted: boolean
  lastT: number
  // Why the code stopped (or never parsed), for the narrator to hear.
  error?: string
  // Whether the narrator has heard about the error.
  isReported?: boolean
  // When each line the code has Clawd say first showed, for the typing.
  said: Map<string, number>
  // Where each line's bubble sat last, so it does not hop about.
  bubblesAt: Map<string, { x: number; y: number }>
  // The 3D settings, kept between frames once the code sets them.
  cam?: Camera
  light?: Light
  fog?: Fog
}

export type Script = {
  background: Background
  actors: Actor[]
  swarms: Swarm[]
  code?: Code
}

// The fuel the code's setup and each frame may burn: statements, loop turns
// and calls. A frame over budget stops the code, not the strip.
const SETUP_FUEL = 1_000_000
const FRAME_FUEL = 150_000

function cleanCode(raw: unknown): Code | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const code: Code = { isStarted: false, lastT: 0, said: new Map(), bubblesAt: new Map() }
  try {
    code.program = parseProgram(raw.slice(0, 20_000))
  } catch (e) {
    code.error = e instanceof Error ? e.message : String(e)
  }

  return code
}

// For the quarter blocks U+2596 to U+259F, which halves (1 top, 2 bottom)
// hold ink: ▖▗▘▙▚▛▜▝▞▟.
const QUARTER_HALVES = [2, 2, 1, 3, 3, 3, 3, 1, 3, 3]

// Characters a sprite may hold: what one terminal cell draws at one width.
const DRAWABLE = /[\x21-\x7e¡-ÿ←-⇿─-◿⠀-⣿★☆♥♦♣♠♪♫☺☻✓✗✦✧]/

const glyphsOf = (line: string) => [...line].map(c => (c === ' ' || DRAWABLE.test(c) ? c : ' '))

const isColor = (c: unknown): c is string => typeof c === 'string' && /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim())

export function cleanScript(raw: unknown): Script | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const s = raw as Record<string, unknown>
  const background = cleanBackground(s.background)
  if (!background) return undefined
  const actors: Actor[] = (Array.isArray(s.actors) ? s.actors : []).slice(0, 20).flatMap(a => {
    if (typeof a !== 'object' || a === null) return []
    const o = a as Record<string, unknown>
    const kind = o.kind === 'clawd' ? 'clawd' : 'sprite'
    const frames = (Array.isArray(o.frames) ? o.frames : [])
      .filter((f): f is string => typeof f === 'string')
      .slice(0, 12)
      .map(f => f.split('\n').slice(0, 9).map(line => glyphsOf(line.slice(0, 80)).join('')))
    if (kind === 'sprite' && frames.length === 0) return []

    return [
      {
        kind,
        frames: kind === 'clawd' ? [CLAWD_BOX] : frames,
        fps: clamp(typeof o.fps === 'number' ? o.fps : 4, 0, 20),
        x: compile(typeof o.x === 'string' ? o.x : '0'),
        y: compile(typeof o.y === 'string' ? o.y : '0'),
        color: isColor(o.color) ? o.color : '#d97757',
        say: cleanText(typeof o.say === 'string' ? o.say : '', 70),
        sayAt: clamp(typeof o.sayAt === 'number' ? o.sayAt : 0.5, 0, 30),
        show: typeof o.show === 'string' && o.show.trim() ? compile(o.show) : undefined,
        frame: typeof o.frame === 'string' && o.frame.trim() ? compile(o.frame) : undefined,
      },
    ]
  })
  const swarms: Swarm[] = (Array.isArray(s.particles) ? s.particles : []).slice(0, 6).flatMap(p => {
    if (typeof p !== 'object' || p === null) return []
    const o = p as Record<string, unknown>
    const glyphs = glyphsOf(typeof o.glyphs === 'string' ? o.glyphs : '*').filter(c => c !== ' ').slice(0, 16)

    return [
      {
        glyphs: glyphs.length > 0 ? glyphs : ['*'],
        count: Math.round(clamp(typeof o.count === 'number' ? o.count : 10, 0, 120)),
        x: compile(typeof o.x === 'string' ? o.x : 'rand(k)*w'),
        y: compile(typeof o.y === 'string' ? o.y : 'rand(k+7)*h'),
        color: isColor(o.color) ? o.color : '#ffffff',
      },
    ]
  })

  return { background, actors, swarms, code: cleanCode(s.code) }
}

// For layout Clawd fills a 14 by 4 cell box (its 8 pixel rows).
const CLAWD_BOX = Array.from({ length: CLAWD_H / 2 }, () => '█'.repeat(CLAWD_W))

// What the scene's code draws through: set while its frame runs.
type Canvas = {
  cols: number
  rows: number
  code: Code
  put: (col: number, row: number, char: string, color: Rgb, back?: Rgb) => void
  clear: (col: number, row: number) => void
  // Marks a fill as under way: its cells do not count as drawn on.
  fill: (on: boolean) => void
  // One pixel: a column and a pixel row (two to a cell).
  pixel: (col: number, py: number, color: Rgb) => void
  // Clawd with its top-left at a column and a pixel row; where things attach.
  clawd: (x: number, py: number, look: ClawdLook, scaleTo?: number, depth?: number) => Anchors
  say: (text: string, x: number, y: number, color: Rgb) => void
  // The frame's 3D world, made on first use.
  scene3d: () => { frame: Frame; view: View; light: Light; fog: Fog }
}
let canvas: Canvas | undefined

// A color from the code: 0xRRGGBB, "#rrggbb" or "#rgb".
const colorOf = (c: unknown, fallback: Rgb = [255, 255, 255]): Rgb =>
  typeof c === 'number' && Number.isFinite(c) ? [(c >> 16) & 255, (c >> 8) & 255, c & 255] : isColor(c) ? parseHex(c) : fallback
const packRgb = (r: number, g: number, b: number) =>
  (clamp(Math.round(r), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255)
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
// One drawable character, or undefined.
const charOf = (c: unknown) => {
  const first = [...String(c ?? '')][0]

  return first === ' ' || (first && DRAWABLE.test(first)) ? first : undefined
}

// The functions the scene's code draws with.
const API = {
  put: (x: unknown, y: unknown, ch: unknown, color?: unknown, bg?: unknown) => {
    const char = charOf(ch)
    if (char) canvas?.put(Math.round(num(x)), Math.round(num(y)), char, colorOf(color), bg === undefined ? undefined : colorOf(bg))
  },
  text: (x: unknown, y: unknown, str: unknown, color?: unknown, bg?: unknown) => {
    const col = Math.round(num(x))
    const row = Math.round(num(y))
    ;[...String(str ?? '')].slice(0, 400).forEach((c, i) => API.put(col + i, row, charOf(c) ?? ' ', color, bg))
  },
  // Multi-line art, solid inside its outline like a sprite actor.
  sprite: (x: unknown, y: unknown, art: unknown, color?: unknown, bg?: unknown) => {
    const col = Math.round(num(x))
    const row = Math.round(num(y))
    String(art ?? '').split('\n').slice(0, 40).forEach((line, dy) => {
      const chars = [...line.slice(0, 300)]
      const start = chars.findIndex(c => c !== ' ')
      if (start < 0) return
      const end = line.trimEnd().length
      for (let dx = start; dx < end; dx++) {
        const c = charOf(chars[dx]) ?? ' '
        if (c === ' ' && bg === undefined) canvas?.clear(col + dx, row + dy)
        else API.put(col + dx, row + dy, c, color, bg)
      }
    })
  },
  fill: (x: unknown, y: unknown, w: unknown, h: unknown, ch?: unknown, color?: unknown, bg?: unknown) => {
    const x0 = Math.round(num(x))
    const y0 = Math.round(num(y))
    canvas?.fill(true)
    for (let row = y0; row < y0 + Math.min(60, Math.round(num(h))); row++) {
      for (let col = x0; col < x0 + Math.min(400, Math.round(num(w))); col++) API.put(col, row, ch ?? ' ', color, bg)
    }
    canvas?.fill(false)
  },
  line: (x0: unknown, y0: unknown, x1: unknown, y1: unknown, ch?: unknown, color?: unknown) => {
    const ax = num(x0)
    const ay = num(y0)
    const steps = Math.min(800, Math.ceil(Math.max(Math.abs(num(x1) - ax), Math.abs(num(y1) - ay))) || 0)
    for (let i = 0; i <= steps; i++) {
      const k = steps === 0 ? 0 : i / steps
      API.put(ax + (num(x1) - ax) * k, ay + (num(y1) - ay) * k, ch ?? '*', color)
    }
  },
  // A circle of radius r rows, twice as wide in columns so it looks round.
  circle: (cx: unknown, cy: unknown, r: unknown, ch?: unknown, color?: unknown) => {
    const radius = Math.min(100, Math.abs(num(r)))
    const steps = Math.max(8, Math.ceil(radius * 12))
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      API.put(num(cx) + Math.cos(a) * radius * 2, num(cy) + Math.sin(a) * radius, ch ?? 'o', color)
    }
  },
  disc: (cx: unknown, cy: unknown, r: unknown, ch?: unknown, color?: unknown, bg?: unknown) => {
    const radius = Math.min(60, Math.abs(num(r)))
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      for (let dx = -Math.ceil(radius * 2); dx <= Math.ceil(radius * 2); dx++) {
        if ((dx / 2) ** 2 + dy ** 2 <= radius ** 2) API.put(Math.round(num(cx)) + dx, Math.round(num(cy)) + dy, ch ?? '█', color, bg)
      }
    }
  },
  // Clawd at x, y (top-left; y in rows, halves allowed), with either the
  // short form (facing, stride, blink, color) or an options object.
  clawd: (x: unknown, y: unknown, facing?: unknown, stride?: unknown, blink?: unknown, color?: unknown) => {
    const look = lookOf(facing, stride, blink, color)

    return anchorsOut(canvas?.clawd(Math.round(num(x)), Math.round(num(y) * 2), look), Math.round(num(x)), Math.round(num(y) * 2))
  },
  pixel: (x: unknown, py: unknown, color?: unknown) => {
    canvas?.pixel(Math.round(num(x)), Math.round(num(py)), colorOf(color))
  },
  // Pixel art: lines of characters, each mapped to a color by the palette
  // ("." and " " are transparent; an unmapped character is white).
  pixels: (x: unknown, py: unknown, art: unknown, palette?: unknown) => {
    const col = Math.round(num(x))
    const row = Math.round(num(py))
    const map = typeof palette === 'object' && palette !== null ? (palette as Record<string, unknown>) : {}
    String(art ?? '').split('\n').slice(0, 80).forEach((line, dy) => {
      ;[...line.slice(0, 300)].forEach((c, dx) => {
        if (c === ' ' || c === '.') return
        canvas?.pixel(col + dx, row + dy, colorOf(map[c]))
      })
    })
  },
  // The 3D world: a camera (eye, target, vertical field of view in degrees),
  // one light (the direction toward it, and ambient 0 to 1), and fog that
  // fades things out between two depths. Each keeps until set again.
  camera: (ex: unknown, ey: unknown, ez: unknown, tx?: unknown, ty?: unknown, tz?: unknown, fov?: unknown) => {
    if (canvas) canvas.code.cam = { eye: [num(ex), num(ey, 2.5), num(ez, 9)], target: [num(tx), num(ty, 1), num(tz)], fov: num(fov, 90) }
  },
  light: (dx: unknown, dy: unknown, dz: unknown, ambient?: unknown) => {
    if (canvas) canvas.code.light = { dir: [num(dx, 0.4), num(dy, 1), num(dz, 0.6)], ambient: clamp(num(ambient, 0.35)) }
  },
  fog: (near: unknown, far: unknown, color?: unknown) => {
    if (canvas) canvas.code.fog = { near: num(near, 8), far: Math.max(num(near, 8) + 0.01, num(far, 40)), color: colorOf(color, [0, 0, 0]) }
  },
  box: (w: unknown, h: unknown, d: unknown) => meshOut(box(num(w, 1), num(h, 1), num(d, 1))),
  sphere: (r: unknown, segments?: unknown) => meshOut(sphere(num(r, 1), num(segments, 8))),
  cylinder: (r: unknown, h: unknown, segments?: unknown) => meshOut(cylinder(num(r, 1), num(r, 1), num(h, 1), num(segments, 8))),
  cone: (r: unknown, h: unknown, segments?: unknown) => meshOut(cylinder(num(r, 1), 0, num(h, 1), num(segments, 8))),
  plane: (w: unknown, d: unknown) => meshOut(plane(num(w, 1), num(d, 1))),
  // Draws a mesh placed by its options: x, y, z; rx, ry, rz (radians);
  // scale (one number or [sx, sy, sz]); color; wire (edges only); unlit.
  mesh3d: (mesh: unknown, options?: unknown) => {
    if (!canvas) return
    const m = meshIn(mesh)
    if (!m) return
    const o = (typeof options === 'object' && options !== null ? options : {}) as Record<string, unknown>
    const sc = Array.isArray(o.scale) ? o.scale.map(v => num(v, 1)) : [num(o.scale, 1), num(o.scale, 1), num(o.scale, 1)]
    const t: Transform = {
      at: [num(o.x), num(o.y), num(o.z)],
      rot: [num(o.rx), num(o.ry), num(o.rz)],
      scale: [sc[0] ?? 1, sc[1] ?? 1, sc[2] ?? 1],
    }
    const { frame, view, light, fog } = canvas.scene3d()
    drawMesh(frame, view, light, fog, m, t, { color: colorOf(o.color), wire: Boolean(o.wire), unlit: Boolean(o.unlit), ascii: Boolean(o.ascii) })
  },
  line3d: (x0: unknown, y0: unknown, z0: unknown, x1: unknown, y1: unknown, z1: unknown, color?: unknown) => {
    if (!canvas) return
    const { frame, view, fog } = canvas.scene3d()
    drawLine(frame, view, fog, [num(x0), num(y0), num(z0)], [num(x1), num(y1), num(z1)], colorOf(color))
  },
  point3d: (x: unknown, y: unknown, z: unknown, color?: unknown) => {
    if (!canvas) return
    const { frame, view, fog } = canvas.scene3d()
    drawPoint(frame, view, fog, [num(x), num(y), num(z)], colorOf(color))
  },
  // Where a world point lands: x and y in cells, px and py in pixels, its
  // depth, and the pixels one world unit covers there; null behind the camera.
  project: (x: unknown, y: unknown, z: unknown) => {
    if (!canvas) return null
    const { view } = canvas.scene3d()
    const p = project(view, [num(x), num(y), num(z)])

    return p
      ? obj({ x: Math.round(p.x / SX), y: Math.round(p.y / SY), px: Math.round(p.x / SX), py: Math.round(p.y / (SY / 2)), depth: p.depth, scale: view.f / p.depth / SX })
      : null
  },
  // Clawd standing at a world point (its feet there), facing the camera,
  // sized by distance: `size` is its height in world units (1 by default).
  // Takes the same options as clawd, and returns the same anchors, or null
  // when it is behind the camera.
  clawd3d: (x: unknown, y: unknown, z: unknown, options?: unknown) => {
    if (!canvas) return null
    const { view } = canvas.scene3d()
    const p = project(view, [num(x), num(y), num(z)])
    if (!p) return null
    const o = (typeof options === 'object' && options !== null ? options : {}) as Record<string, unknown>
    const look = lookOf(o)
    // Its height in pixel rows (two samples each), from its height in units,
    // never more than most of the strip: Clawd is small in a big world.
    const most = canvas.rows * 2 * 0.7
    const pixelsTall = Math.min(most, (num(o.size, 0.9) * view.f) / p.depth / (SY / 2))
    const s = Math.max(0.15, Math.min(6, pixelsTall / CLAWD_H))
    const w = Math.round(CLAWD_W * s)
    const h = Math.round(CLAWD_H * s)
    const left = Math.round(p.x / SX - w / 2)
    const top = Math.round(p.y / (SY / 2) - h)
    const anchors = canvas.clawd(left, top, look, s, p.depth)

    return anchorsOut(anchors, left, top)
  },
  // A speech bubble pointing at x, y.
  say: (text: unknown, x: unknown, y: unknown, color?: unknown) => {
    const line = cleanText(String(text ?? ''), 70)
    if (line) canvas?.say(line, Math.round(num(x)), Math.round(num(y)), colorOf(color, [217, 119, 87]))
  },
  rgb: (r: unknown, g: unknown, b: unknown) => packRgb(num(r), num(g), num(b)),
  // Hue in degrees, saturation and lightness 0 to 1.
  hsl: (hue: unknown, sat: unknown, light: unknown) => {
    const hh = (((num(hue) % 360) + 360) % 360) / 60
    const ss = clamp(num(sat))
    const ll = clamp(num(light))
    const c = (1 - Math.abs(2 * ll - 1)) * ss
    const x = c * (1 - Math.abs((hh % 2) - 1))
    const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
    const m = ll - c / 2

    return packRgb((r + m) * 255, (g + m) * 255, (b + m) * 255)
  },
  mix: (a: unknown, b: unknown, k: unknown) => {
    const [r, g, bb] = mix(colorOf(a), colorOf(b), clamp(num(k)))

    return packRgb(r, g, bb)
  },
}

// Clawd's look from a call's arguments: an options object, or the short
// form's facing, stride, blink and color.
function lookOf(facing: unknown, stride?: unknown, blink?: unknown, color?: unknown): ClawdLook {
  if (typeof facing === 'object' && facing !== null) {
    const o = facing as Record<string, unknown>
    const poses: Pose[] = ['stand', 'walk', 'jump', 'sit']
    const eyes: Eyes[] = ['open', 'closed', 'wide']
    const strideIn = num(o.stride, -1)
    const pose = poses.includes(o.pose as Pose) ? (o.pose as Pose) : strideIn >= 0 ? 'walk' : 'stand'
    const lookIn = (typeof o.look === 'object' && o.look !== null ? o.look : {}) as Record<string, unknown>
    // arms: one pose for both, or {left, right}.
    const armOf = (v: unknown, fallback: Arm): Arm => (ARMS.includes(v as Arm) ? (v as Arm) : fallback)
    const armsIn = o.arms
    const arms =
      typeof armsIn === 'object' && armsIn !== null
        ? { left: armOf((armsIn as Record<string, unknown>).left, 'up'), right: armOf((armsIn as Record<string, unknown>).right, 'up') }
        : { left: armOf(armsIn, 'up'), right: armOf(armsIn, 'up') }

    return {
      pose,
      arms,
      stride: Math.round(Math.max(0, strideIn)),
      facing: Math.sign(num(o.facing)),
      eyes: eyes.includes(o.eyes as Eyes) ? (o.eyes as Eyes) : 'open',
      look: { x: num(lookIn.x, num(o.lookX)), y: num(lookIn.y, num(o.lookY)) },
      isBlinking: Boolean(o.blink),
      color: colorOf(o.color, CLAWD_ORANGE),
      eyeColor: colorOf(o.eyeColor, LOOK.eyeColor),
      scale: clamp(Math.round(num(o.scale, 1)), 1, 4),
    }
  }
  const strideIn = Math.round(num(stride, -1))

  return {
    ...LOOK,
    pose: strideIn >= 0 ? 'walk' : 'stand',
    stride: Math.max(0, strideIn),
    facing: Math.sign(num(facing)),
    isBlinking: Boolean(blink),
    color: colorOf(color, CLAWD_ORANGE),
  }
}

// Anchors as the code reads them: absolute pixel positions.
function anchorsOut(a: Anchors | undefined, left: number, top: number) {
  if (!a) return null
  const at = (p: { x: number; y: number }) => obj({ x: left + p.x, py: top + p.y, row: Math.floor((top + p.y) / 2) })

  return obj({
    x: left,
    py: top,
    row: Math.floor(top / 2),
    w: a.w,
    h: a.h,
    top: at(a.top),
    left: at(a.left),
    right: at(a.right),
    feet: at(a.feet),
    eyes: obj({ ...at(a.eyes), w: a.eyes.w }),
  })
}

const meshOut = (m: Mesh) => obj({ verts: m.verts, faces: m.faces })

// A mesh as the code gives it: verts flat, faces flat triangles or lists of
// indices (polygons, fanned into triangles).
function meshIn(raw: unknown): Mesh | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.verts) || !Array.isArray(o.faces)) return undefined
  const verts = o.verts.slice(0, 60_000).map(v => num(v))
  const faces: number[] = []
  const count = Math.floor(verts.length / 3)
  const index = (v: unknown) => {
    const i = Math.round(num(v, -1))

    return i >= 0 && i < count ? i : -1
  }
  if (o.faces.every(f => Array.isArray(f))) {
    for (const poly of o.faces.slice(0, 20_000) as unknown[][]) {
      const ids = poly.map(index)
      if (ids.some(i => i < 0)) continue
      for (let i = 1; i + 1 < ids.length; i++) faces.push(ids[0]!, ids[i]!, ids[i + 1]!)
    }
  } else {
    const ids = o.faces.slice(0, 60_000).map(index)
    for (let i = 0; i + 2 < ids.length; i += 3) if (ids[i]! >= 0 && ids[i + 1]! >= 0 && ids[i + 2]! >= 0) faces.push(ids[i]!, ids[i + 1]!, ids[i + 2]!)
  }

  return { verts, faces }
}

type Bubble = { lines: string[]; x: number; y: number; wide: number; tall: number; base: Rgb; tail?: { col: number; row: number; char: string } }

// A bubble's text as typed out so far, and its size.
function typedBubble(text: string, age: number, cols: number) {
  const all = wrap(text, Math.max(10, Math.min(30, cols - 6)))
  let left = Math.floor((age * 1000) / BUBBLE_MS)
  const lines = all.map(line => {
    const part = line.slice(0, Math.max(0, left))
    left -= line.length + 1

    return part
  })

  return { lines, wide: Math.max(...all.map(line => line.length)) + 4, tall: all.length + 2 }
}

// Where a bubble goes: the clearest spot near its speaker, scored by how
// many drawn cells it would cover and how far it strays from the speaker's
// box; the last spot keeps its place unless a clearly better one opens, so
// the bubble does not hop about. The tail notches the border on the side
// that faces the speaker.
function placeBubble(args: { speaker: Box; wide: number; tall: number; cols: number; rows: number; covered: Uint8Array; last?: { x: number; y: number } }) {
  const { speaker, wide, tall, cols, rows, covered, last } = args
  const bottom = rows - 1
  const cx = (speaker.x0 + speaker.x1 + 1) / 2
  const cost = (x: number, y: number) => {
    let blocked = 0
    for (let row = y; row < y + tall; row++) {
      for (let col = x; col < x + wide; col++) if (covered[row * cols + col]) blocked += 1
    }
    const gap = y + tall <= speaker.y0 ? speaker.y0 - (y + tall) : y > speaker.y1 ? y - speaker.y1 - 1 : 0
    const side = x + wide <= speaker.x0 ? speaker.x0 - (x + wide) : x > speaker.x1 ? x - speaker.x1 - 1 : 0

    return blocked * 10 + Math.abs(x + wide / 2 - cx) * 0.08 + gap * 0.6 + side * 0.15
  }
  let best = { x: Math.max(0, Math.min(cols - wide, Math.round(cx - wide / 2))), y: Math.max(0, speaker.y0 - tall) }
  let bestCost = Infinity
  const lo = Math.max(0, Math.round(cx) - 50)
  const hi = Math.min(cols - wide, Math.round(cx) + 50)
  for (let y = 0; y + tall - 1 <= bottom; y++) {
    // Every other column, and both bounds.
    for (let x = lo; x <= hi + 1; x += 2) {
      const xx = Math.min(x, hi)
      const c = cost(xx, y)
      if (c < bestCost) {
        bestCost = c
        best = { x: xx, y }
      }
    }
  }
  if (last && last.x >= 0 && last.x <= cols - wide && last.y >= 0 && last.y + tall - 1 <= bottom && cost(last.x, last.y) <= bestCost + 3) best = last
  const { x, y } = best
  const tailCol = Math.max(x + 2, Math.min(x + wide - 3, Math.round(cx)))
  const tailRow = Math.max(y + 1, Math.min(y + tall - 2, Math.round((speaker.y0 + speaker.y1) / 2)))
  const tail =
    y + tall - 1 < speaker.y0 ? { col: tailCol, row: y + tall - 1, char: '┬' }
    : y > speaker.y1 ? { col: tailCol, row: y, char: '┴' }
    : x + wide - 1 < speaker.x0 ? { col: x + wide - 1, row: tailRow, char: '├' }
    : x > speaker.x1 ? { col: x, row: tailRow, char: '┤' }
    : undefined
  // The bubble's cells count as drawn for the next bubble.
  for (let row = y; row < y + tall; row++) for (let col = x; col < x + wide; col++) covered[row * cols + col] = 1

  return { x, y, tail }
}

export type Stage = {
  cols: number
  rows: number
  // The buddy's clock, in seconds: the backdrop's.
  t: number
  script: Script
  previous?: Script
  // Milliseconds since this script arrived: its actors' clock.
  since: number
  reveal: number
}

const BUBBLE_MS = 32
// Where each speaker's bubble sat last frame.
const lastBubble = new WeakMap<Actor, { x: number; y: number }>()
const OLD_MS = 500

// Words wrapped to lines no wider than `width`.
function wrap(text: string, width: number) {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= width) {
      line = next
    } else {
      if (line) lines.push(line)
      line = word.slice(0, width)
    }
  }
  if (line) lines.push(line)

  return lines
}

type Box = { x0: number; y0: number; x1: number; y1: number }
type Placed = { actor: Actor; lines: string[]; x: number; y: number; width: number; alpha: number; look?: ClawdLook }

// Draws one frame of a script: backdrop, swarms, actors, then speech on top,
// with the backdrop cleared around everything that reads.
export function stage(frame: Stage): string {
  const { cols, rows, t, since, reveal } = frame
  // A scene whose code broke with nothing else to show keeps the last scene
  // on until the narrator's fixed one arrives.
  const isBlank = (s: Script) => Boolean(s.code?.error) && s.actors.length === 0 && s.swarms.length === 0
  const script = isBlank(frame.script) && frame.previous && !isBlank(frame.previous) ? frame.previous : frame.script
  const previous = script === frame.script ? frame.previous : undefined
  const words = new Uint32Array(cols * rows * 3)
  paintBackground(words, {
    cols,
    rows,
    t,
    background: script.background,
    previous: previous?.background,
    fade: clamp(since / 1500),
    reveal,
    strength: 0.4,
  })
  // Rows above the band's risen front stay empty while it grows in.
  const shown = (row: number) => row >= Math.floor(rows * (1 - clamp(reveal * 1.3)))
  const clear = (box: Box) => {
    for (let row = Math.max(0, box.y0); row <= Math.min(rows - 1, box.y1); row++) {
      for (let col = Math.max(0, box.x0); col <= Math.min(cols - 1, box.x1); col++) {
        const at = (row * cols + col) * 3
        words[at] = 0x20
        words[at + 1] = CLEAR
        words[at + 2] = CLEAR
      }
    }
  }
  const pack = (c: Rgb) => (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])
  const put = (col: number, row: number, char: string, color: Rgb, back?: Rgb) => {
    if (col < 0 || col >= cols || row < 0 || row >= rows || !shown(row)) return
    const at = (row * cols + col) * 3
    words[at] = char.codePointAt(0) ?? 0x20
    words[at + 1] = pack(color)
    words[at + 2] = back ? pack(back) : CLEAR
  }

  // Where every actor stands this frame, the outgoing scene's flickering out.
  const placed: Placed[] = []
  const scenes: [Script, number, number][] =
    previous && since < OLD_MS ? [[previous, since / 1000 + 30, 1 - since / OLD_MS], [script, since / 1000, 1]] : [[script, since / 1000, 1]]
  for (const [play, sceneT, alpha] of scenes) {
    play.actors.forEach((actor, i) => {
      const env = { t: sceneT, w: cols, h: rows, k: i, n: play.actors.length }
      if (actor.show && actor.show(env) <= 0) return
      const index = actor.frame ? Math.floor(actor.frame(env)) : Math.floor(sceneT * actor.fps)
      const lines = actor.frames[mod(index, actor.frames.length)] ?? []
      const width = Math.max(1, ...lines.map(line => line.trimEnd().length))
      const x = actor.x(env)
      let look: ClawdLook | undefined
      if (actor.kind === 'clawd') {
        // Clawd steps as far as it has walked, one frame each 1.5 columns, so
        // its feet never slide; standing, it blinks now and then.
        const dx = x - actor.x({ ...env, t: sceneT - 0.12 })
        const isWalking = Math.abs(dx) >= 0.2
        look = {
          ...LOOK,
          pose: isWalking ? 'walk' : 'stand',
          stride: isWalking ? mod(Math.floor(x / 1.5), 4) : 0,
          facing: isWalking ? Math.sign(dx) : 0,
          isBlinking: !isWalking && hash(Math.floor(sceneT * 0.5), i) > 0.6 && fract(sceneT * 0.5) < 0.06,
          color: parseHex(actor.color),
        }
      }
      placed.push({ actor, lines, x: Math.round(x), y: Math.round(actor.y(env)), width, alpha, look })
    })
  }

  // Each actor is solid inside its outline: on every line, the cells from its
  // first drawn character to its last hide whatever lies behind them.
  const spans = (one: Placed) =>
    one.lines.map(line => {
      const start = line.search(/\S/)

      return start < 0 ? undefined : { x0: one.x + start, x1: one.x + line.trimEnd().length - 1 }
    })
  const covered = new Uint8Array(cols * rows)
  for (const one of placed) {
    spans(one).forEach((span, dy) => {
      const row = one.y + dy
      if (!span || row < 0 || row >= rows) return
      for (let col = Math.max(0, span.x0); col <= Math.min(cols - 1, span.x1); col++) covered[row * cols + col] = 1
    })
  }

  // Speech: a bubble in the clearest spot near its speaker.
  const sceneT = since / 1000
  const bubbles: Bubble[] = []
  for (const one of placed) {
    const { actor } = one
    if (one.alpha < 1 || !actor.say || sceneT < actor.sayAt) continue
    const typed = Math.floor(((sceneT - actor.sayAt) * 1000) / BUBBLE_MS)
    const all = wrap(actor.say, Math.max(10, Math.min(30, cols - 6)))
    let left = typed
    const lines = all.map(line => {
      const part = line.slice(0, Math.max(0, left))
      left -= line.length + 1

      return part
    })
    // The text plus a border and a space of padding either side. A bubble
    // the strip cannot hold whole (while the band grows in) waits.
    const wide = Math.max(...all.map(line => line.length)) + 4
    const tall = all.length + 2
    if (tall > rows || wide > cols) continue
    const bottom = rows - 1
    const outline = spans(one)
    const drawn = outline.flatMap((span, dy) => (span ? [{ ...span, row: one.y + dy }] : []))
    const speaker: Box = {
      x0: Math.min(...drawn.map(d => d.x0)),
      x1: Math.max(...drawn.map(d => d.x1)),
      y0: Math.min(...drawn.map(d => d.row)),
      y1: Math.max(...drawn.map(d => d.row)),
    }
    const { x, y, tail } = placeBubble({ speaker, wide, tall, cols, rows, covered, last: lastBubble.get(actor) })
    lastBubble.set(actor, { x, y })
    bubbles.push({ lines, x, y, wide, tall, base: parseHex(actor.color), tail })
  }

  // Room to read: the backdrop gives way around the actors.
  for (const one of placed) {
    spans(one).forEach((span, dy) => span && clear({ x0: span.x0 - 1, y0: one.y + dy, x1: span.x1 + 1, y1: one.y + dy }))
  }

  // Swarms first, behind everything.
  for (const [play, playT, alpha] of scenes) {
    const env: Env = { t: playT, w: cols, h: rows, k: 0, n: 0 }
    for (const swarm of play.swarms) {
      const color = parseHex(swarm.color)
      for (let k = 0; k < swarm.count; k++) {
        if (alpha < 1 && hash(k, Math.floor(since / 60)) > alpha) continue
        const at = { ...env, k, n: swarm.count }
        const col = Math.round(swarm.x(at))
        const row = Math.round(swarm.y(at))
        put(col, row, swarm.glyphs[k % swarm.glyphs.length] ?? '*', color)
      }
    }
  }
  // One pixel, two to a cell: the cell keeps whatever its other half holds
  // (a backdrop pixel, an earlier pixel) and shows the new one in its half.
  const plotPixel = (col: number, py: number, color: Rgb) => {
    const row = Math.floor(py / 2)
    if (col < 0 || col >= cols || row < 0 || row >= rows || !shown(row)) return
    const at = (row * cols + col) * 3
    const ch = words[at]
    const fg = words[at + 1]!
    const bg = words[at + 2]!
    let top: number | undefined
    let bottom: number | undefined
    if (ch === 0x2580) {
      top = fg
      bottom = bg === CLEAR ? undefined : bg
    } else if (ch === 0x2584) {
      bottom = fg
      top = bg === CLEAR ? undefined : bg
    } else if (ch === 0x2588) {
      top = bottom = fg
    } else if (ch === 0x20 && bg !== CLEAR) {
      top = bottom = bg
    } else if (ch !== undefined && ch >= 0x2596 && ch <= 0x259f) {
      // A quarter-block edge from the 3D world: each half counts as the
      // glyph's color where the glyph has anything in it.
      const q = QUARTER_HALVES[ch - 0x2596] ?? 0
      if (q & 1) top = fg
      if (q & 2) bottom = fg
    }
    if (py % 2 === 0) top = pack(color)
    else bottom = pack(color)
    if (top !== undefined) {
      words[at] = 0x2580
      words[at + 1] = top
      words[at + 2] = bottom ?? CLEAR
    } else {
      words[at] = 0x2584
      words[at + 1] = bottom ?? CLEAR
      words[at + 2] = CLEAR
    }
  }

  // The cells the code has drawn characters and sprites on this frame (not
  // fills), and the last Clawd it drew: what its speech bubbles stay off.
  const inked = new Uint8Array(cols * rows)
  let isFilling = false
  const ink = (col: number, row: number) => {
    if (!isFilling && col >= 0 && col < cols && row >= 0 && row < rows) inked[row * cols + col] = 1
  }
  let lastClawd: Box | undefined

  // The frame's 3D samples, made when the code first draws in 3D, and drawn
  // as glyphs before any 2D drawing that follows, so that sits on top.
  let frame3d: Frame | undefined
  const frameOf = () => (frame3d ??= createFrame(cols, rows))
  const flush3d = () => {
    if (frame3d) composite(frame3d, put)
  }

  // Clawd at a column and a pixel row, its pixels scaled by `scaleTo` (any
  // factor, for a figure in the distance) and depth tested when in 3D.
  const paintClawd = (x: number, py: number, look: ClawdLook, scaleTo = 1, atDepth?: number, isHidden?: (px: { x: number; y: number }) => boolean) => {
    const pixels = clawdPixels(look)
    const s = look.scale
    if (scaleTo === 1) {
      for (const px of pixels) {
        if (isHidden?.(px)) continue
        plotPixel(x + px.x, py + px.y, px.c)
      }
    } else {
      // Nearest-neighbor over the sprite's box, which reaches a pixel past
      // each side for a claw held out.
      const reach = s
      const boxW = CLAWD_W * s + reach * 2
      const grid = new Map<number, Rgb>()
      for (const px of pixels) grid.set(px.y * boxW + px.x + reach, px.c)
      const w = Math.max(1, Math.round(boxW * scaleTo))
      const h = Math.max(1, Math.round(CLAWD_H * s * scaleTo))
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const sx = Math.min(boxW - 1, Math.floor(((dx + 0.5) / w) * boxW))
          const sy = Math.min(CLAWD_H * s - 1, Math.floor(((dy + 0.5) / h) * CLAWD_H * s))
          const c = grid.get(sy * boxW + sx)
          if (!c) continue
          const col = x + dx - Math.round(reach * scaleTo)
          const prow = py + dy
          if (atDepth !== undefined && !claimPixel(frameOf(), col, prow, atDepth)) continue
          plotPixel(col, prow, c)
        }
      }
    }
    const a = clawdAnchors(look)
    if (scaleTo === 1) return a
    const k = (p: { x: number; y: number }) => ({ x: Math.round(p.x * scaleTo), y: Math.round(p.y * scaleTo) })

    return { w: Math.round(a.w * scaleTo), h: Math.round(a.h * scaleTo), top: k(a.top), left: k(a.left), right: k(a.right), feet: k(a.feet), eyes: { ...k(a.eyes), w: Math.round(a.eyes.w * scaleTo) } }
  }

  // The scene's code draws over the backdrop and swarms, under the actors.
  const code = script.code
  if (code?.program && !code.error) {
    const dt = code.isStarted ? clamp(sceneT - code.lastT, 0, 0.25) : 0
    code.lastT = sceneT
    const globals = { t: sceneT, dt, w: cols, h: rows }
    let scene3d: { frame: Frame; view: View; light: Light; fog: Fog } | undefined
    canvas = {
      cols,
      rows,
      code,
      put: (col, row, char, color, back) => {
        flush3d()
        put(col, row, char, color, back)
        ink(col, row)
      },
      fill: (on: boolean) => {
        isFilling = on
      },
      clear: (col, row) => {
        flush3d()
        clear({ x0: col, y0: row, x1: col, y1: row })
      },
      pixel: (col, py, color) => {
        flush3d()
        plotPixel(col, py, color)
        ink(col, Math.floor(py / 2))
      },
      clawd: (x, py, look, scaleTo, atDepth) => {
        flush3d()
        const a = paintClawd(x, py, look, scaleTo, atDepth)
        lastClawd = { x0: x - 1, y0: Math.floor(py / 2), x1: x + a.w, y1: Math.floor((py + a.h - 1) / 2) }
        for (let row = lastClawd.y0; row <= lastClawd.y1; row++) for (let col = lastClawd.x0; col <= lastClawd.x1; col++) ink(col, row)

        return a
      },
      scene3d: () => {
        if (!scene3d) {
          scene3d = {
            frame: frameOf(),
            view: resolve(code.cam ?? DEFAULT_CAMERA, cols * SX, rows * SY),
            light: code.light ?? DEFAULT_LIGHT,
            fog: code.fog ?? DEFAULT_FOG,
          }
        }

        return scene3d
      },
      say: (text, x, y, color) => {
        flush3d()
        // A new line types out; one that only changed from a line already
        // typed (a live count, a timer) shows whole rather than restarting.
        let first = code.said.get(text)
        if (first === undefined) {
          const isTyped = (line: string, at: number) => (sceneT - at) * 1000 >= line.length * BUBBLE_MS
          first = [...code.said].some(([line, at]) => isTyped(line, at)) ? -Infinity : sceneT
          if (code.said.size >= 32) code.said.clear()
          code.said.set(text, first)
        }
        const { lines, wide, tall } = typedBubble(text, sceneT - first, cols)
        if (wide > cols || tall > rows) return
        // The speaker is the Clawd last drawn when the point is on or beside
        // it; otherwise the point itself.
        const near = lastClawd && x >= lastClawd.x0 - 2 && x <= lastClawd.x1 + 2 && y >= lastClawd.y0 - 1 && y <= lastClawd.y1 + 1
        const speaker: Box = near && lastClawd ? lastClawd : { x0: x, y0: y, x1: x, y1: y }
        const placed3 = placeBubble({ speaker, wide, tall, cols, rows, covered: inked, last: code.bubblesAt.get(text) })
        if (code.bubblesAt.size >= 32) code.bubblesAt.clear()
        code.bubblesAt.set(text, { x: placed3.x, y: placed3.y })
        bubbles.push({ lines, x: placed3.x, y: placed3.y, wide, tall, base: color, tail: placed3.tail })
      },
    }
    try {
      if (!code.isStarted) {
        code.isStarted = true
        code.program.start({ ...API, ...globals }, SETUP_FUEL)
      }
      code.program.call('frame', [sceneT, dt], globals, FRAME_FUEL)
      flush3d()
    } catch (e) {
      code.error = e instanceof Error ? e.message : String(e)
    } finally {
      canvas = undefined
    }
  }

  // Actors back to front, each hiding what is behind its outline.
  placed.forEach((one, i) => {
    const color = parseHex(one.actor.color)
    if (one.look) {
      paintClawd(one.x, one.y * 2, one.look, 1, undefined, px => one.alpha < 1 && hash(px.x * 13 + px.y, Math.floor(since / 50) + i) > one.alpha)

      return
    }
    const outline = spans(one)
    one.lines.forEach((line, dy) => {
      const span = outline[dy]
      if (!span) return
      if (one.alpha >= 1) clear({ x0: span.x0, y0: one.y + dy, x1: span.x1, y1: one.y + dy })
      ;[...line].forEach((c, dx) => {
        if (c === ' ') return
        if (one.alpha < 1 && hash(dx * 31 + dy, Math.floor(since / 50) + i) > one.alpha) return
        put(one.x + dx, one.y + dy, c, color)
      })
    })
  })
  // Speech on top of everything: a rounded box in the speaker's color, filled
  // with a dark tint of it so nothing behind shows through the words.
  // What a cell shows before a bubble goes over it: its background, a block
  // glyph's color, or nothing (the terminal's own).
  const unpack = (c: number): Rgb => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
  const underlying = (col: number, row: number): Rgb | undefined => {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return undefined
    const at = (row * cols + col) * 3
    const ch = words[at]
    const fg = words[at + 1]!
    const bg = words[at + 2]!
    if (bg !== CLEAR && ch === 0x20) return unpack(bg)
    const isBlock = ch === 0x2580 || ch === 0x2584 || ch === 0x2588
    if (isBlock && fg !== CLEAR) return bg !== CLEAR ? mix(unpack(fg), unpack(bg), 0.5) : unpack(fg)
    if (bg !== CLEAR) return unpack(bg)

    return undefined
  }
  for (const b of bubbles) {
    // Whole, never cut by the strip's edges.
    b.y = clamp(b.y, 0, Math.max(0, rows - b.tall))
    b.x = clamp(b.x, 0, Math.max(0, cols - b.wide))
    const edge = mix(b.base, [255, 255, 255], 0.35)
    const ink = mix(b.base, [255, 255, 255], 0.85)
    // The panel is see-through: over something it is that, darkened and
    // tinted; over nothing it is a dark tint of the speaker's color.
    const panel = (col: number, row: number): Rgb => {
      const under = underlying(col, row)

      return under ? mix(dim(under, 0.3), dim(b.base, 0.18), 0.35) : dim(b.base, 0.18)
    }
    const right = b.x + b.wide - 1
    const bottomRow = b.y + b.tall - 1
    for (let row = b.y; row <= bottomRow; row++) {
      for (let col = b.x; col <= right; col++) {
        const isTop = row === b.y
        const isBottom = row === bottomRow
        const isLeft = col === b.x
        const isRight = col === right
        const char =
          isTop && isLeft ? '╭' : isTop && isRight ? '╮' : isBottom && isLeft ? '╰' : isBottom && isRight ? '╯'
          : isTop || isBottom ? '─' : isLeft || isRight ? '│' : ' '
        put(col, row, char, char === ' ' ? ink : edge, panel(col, row))
      }
    }
    if (b.tail) put(b.tail.col, b.tail.row, b.tail.char, edge, panel(b.tail.col, b.tail.row))
    b.lines.forEach((line, dy) => [...line].forEach((c, dx) => put(b.x + 2 + dx, b.y + 1 + dy, c, ink, panel(b.x + 2 + dx, b.y + 1 + dy))))
  }

  return encode(words)
}
