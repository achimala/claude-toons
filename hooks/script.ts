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
import { parseProgram, type Program } from './lang'

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
  const code: Code = { isStarted: false, lastT: 0, said: new Map() }
  try {
    code.program = parseProgram(raw.slice(0, 20_000))
  } catch (e) {
    code.error = e instanceof Error ? e.message : String(e)
  }

  return code
}

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

// Clawd in pixel art, two pixels to a cell's height: B body, A arm, E eye.
// Its four legs are drawn per pose, down to a ground line at pixel row 6. For
// layout it fills a 14 by 4 cell box.
const CLAWD = [
  '..BBBBBBBBBB..',
  '..BBEBBBBEBB..',
  'AABBEBBBBEBBAA',
  '..BBBBBBBBBB..',
  '..BBBBBBBBBB..',
]
const CLAWD_W = 14
const CLAWD_BOX = Array.from({ length: 4 }, () => '█'.repeat(CLAWD_W))
const LEGS = [3, 5, 8, 10]
const GROUND = 6
const EYE: Rgb = [42, 22, 16]

// `stride` is the walk frame, 0 to 3, or -1 standing.
type Pose = { stride: number; facing: number; isBlinking: boolean }

// Clawd's pixels for a pose, in one flat color. Walking is a four-frame trot:
// legs straight with the body up a pixel, then the body down with one pair of
// feet lifted off the ground, straight again, then the other pair lifted.
// Planted feet stay on the ground line; the legs stretch to meet the body.
function clawdPixels(pose: Pose, base: Rgb) {
  const pixels: { x: number; y: number; c: Rgb }[] = []
  // Eyes go on last, so a body pixel never covers one that looked aside.
  const eyes: { x: number; y: number; c: Rgb }[] = []
  const isUp = pose.stride === 0 || pose.stride === 2
  const lift = isUp ? -1 : 0
  CLAWD.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === '.') return
      pixels.push({ x, y: y + lift, c: base })
      if (c === 'E' && !(pose.isBlinking && y === 1)) eyes.push({ x: x + pose.facing, y: y + lift, c: EYE })
    }),
  )
  const top = CLAWD.length + lift
  LEGS.forEach((x, i) => {
    const isFirstPair = i === 0 || i === 2
    const isLifted = (pose.stride === 1 && isFirstPair) || (pose.stride === 3 && !isFirstPair)
    for (let y = top; y <= (isLifted ? GROUND - 1 : GROUND); y++) pixels.push({ x, y, c: base })
  })

  return [...pixels, ...eyes]
}

// What the scene's code draws through: set while its frame runs.
type Canvas = {
  put: (col: number, row: number, char: string, color: Rgb, back?: Rgb) => void
  clear: (col: number, row: number) => void
  clawd: (x: number, y: number, pose: Pose, color: Rgb) => void
  say: (text: string, x: number, y: number, color: Rgb) => void
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
    for (let row = y0; row < y0 + Math.min(60, Math.round(num(h))); row++) {
      for (let col = x0; col < x0 + Math.min(400, Math.round(num(w))); col++) API.put(col, row, ch ?? ' ', color, bg)
    }
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
  // Clawd at x, y (top-left of its 14x4 box); facing -1, 0 or 1; stride 0-3
  // while walking, -1 standing.
  clawd: (x: unknown, y: unknown, facing?: unknown, stride?: unknown, blink?: unknown, color?: unknown) => {
    canvas?.clawd(
      Math.round(num(x)),
      Math.round(num(y)),
      { stride: clamp(Math.round(num(stride, -1)), -1, 3), facing: Math.sign(num(facing)), isBlinking: Boolean(blink) },
      colorOf(color, [217, 119, 87]),
    )
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

type Bubble = { lines: string[]; x: number; y: number; wide: number; tall: number; base: Rgb; tail?: { col: number; row: number; char: string } }

// A bubble for code speech: above the point if it fits, else below, else
// beside it, typed out over `age` seconds.
function bubbleAt(text: string, px: number, py: number, base: Rgb, age: number, cols: number, rows: number): Bubble | undefined {
  const all = wrap(text, Math.max(10, Math.min(30, cols - 6)))
  const wide = Math.max(...all.map(line => line.length)) + 4
  const tall = all.length + 2
  if (wide > cols || tall > rows) return undefined
  let left = Math.floor((age * 1000) / BUBBLE_MS)
  const lines = all.map(line => {
    const part = line.slice(0, Math.max(0, left))
    left -= line.length + 1

    return part
  })
  const x = clamp(Math.round(px - wide / 2), 0, cols - wide)
  const tailCol = clamp(px, x + 2, x + wide - 3)
  if (py - tall >= 0) return { lines, x, y: py - tall, wide, tall, base, tail: { col: tailCol, row: py - 1, char: '┬' } }
  if (py + 1 + tall <= rows) return { lines, x, y: py + 1, wide, tall, base, tail: { col: tailCol, row: py + 1, char: '┴' } }
  const y = clamp(py - Math.floor(tall / 2), 0, rows - tall)
  const besideX = px + 2 + wide <= cols ? px + 2 : Math.max(0, px - 2 - wide)

  return {
    lines,
    x: besideX,
    y,
    wide,
    tall,
    base,
    tail: { col: besideX > px ? besideX : besideX + wide - 1, row: clamp(py, y + 1, y + tall - 2), char: besideX > px ? '┤' : '├' },
  }
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
type Placed = { actor: Actor; lines: string[]; x: number; y: number; width: number; alpha: number; pose?: Pose }

// Draws one frame of a script: backdrop, swarms, actors, then speech on top,
// with the backdrop cleared around everything that reads.
export function stage(frame: Stage): string {
  const { cols, rows, t, script, previous, since, reveal } = frame
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
      let pose: Pose | undefined
      if (actor.kind === 'clawd') {
        // Clawd steps as far as it has walked, one frame each 1.25 columns, so
        // its feet never slide; standing, it blinks now and then.
        const dx = x - actor.x({ ...env, t: sceneT - 0.12 })
        const isWalking = Math.abs(dx) >= 0.2
        pose = {
          stride: isWalking ? mod(Math.floor(x / 1.25), 4) : -1,
          facing: isWalking ? Math.sign(dx) : 0,
          isBlinking: !isWalking && hash(Math.floor(sceneT * 0.5), i) > 0.6 && fract(sceneT * 0.5) < 0.06,
        }
      }
      placed.push({ actor, lines, x: Math.round(x), y: Math.round(actor.y(env)), width, alpha, pose })
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
    // The text plus a border and a space of padding either side.
    const wide = Math.max(...all.map(line => line.length)) + 4
    const tall = all.length + 2
    const bottom = rows - 1
    // Every spot near the speaker, scored by how many sprite cells it would
    // cover and how far it strays; the last spot keeps its place unless a
    // clearly better one opens, so the bubble does not hop about.
    const cx = one.x + one.width / 2
    const cost = (x: number, y: number) => {
      let blocked = 0
      for (let row = y; row < y + tall; row++) {
        for (let col = x; col < x + wide; col++) if (covered[row * cols + col]) blocked += 1
      }
      const gap = y + tall <= one.y ? one.y - (y + tall) : y >= one.y + one.lines.length ? y - (one.y + one.lines.length) : 0
      const side = x + wide <= one.x ? one.x - (x + wide) : x >= one.x + one.width ? x - (one.x + one.width) : 0

      return blocked * 10 + Math.abs(x + wide / 2 - cx) * 0.08 + gap * 0.6 + side * 0.15
    }
    let best = { x: Math.max(0, Math.min(cols - wide, Math.round(cx - wide / 2))), y: Math.max(0, one.y - tall) }
    let bestCost = Infinity
    for (let y = 0; y + tall - 1 <= bottom; y++) {
      for (let x = Math.max(0, Math.round(cx) - 50); x <= Math.min(cols - wide, Math.round(cx) + 50); x += 2) {
        const c = cost(x, y)
        if (c < bestCost) {
          bestCost = c
          best = { x, y }
        }
      }
    }
    const last = lastBubble.get(actor)
    if (last && last.x <= cols - wide && last.y + tall - 1 <= bottom && cost(last.x, last.y) <= bestCost + 3) best = last
    lastBubble.set(actor, best)
    // The tail: a notch in the border on the side that faces the speaker.
    const { x, y } = best
    const outline = spans(one)
    const drawn = outline.flatMap((span, dy) => (span ? [{ ...span, row: one.y + dy }] : []))
    const sx0 = Math.min(...drawn.map(d => d.x0))
    const sx1 = Math.max(...drawn.map(d => d.x1))
    const sy0 = Math.min(...drawn.map(d => d.row))
    const sy1 = Math.max(...drawn.map(d => d.row))
    const tailCol = Math.max(x + 2, Math.min(x + wide - 3, Math.round(cx)))
    const tailRow = Math.max(y + 1, Math.min(y + tall - 2, Math.round((sy0 + sy1) / 2)))
    const tail =
      y + tall - 1 < sy0 ? { col: tailCol, row: y + tall - 1, char: '┬' }
      : y > sy1 ? { col: tailCol, row: y, char: '┴' }
      : x + wide - 1 < sx0 ? { col: x + wide - 1, row: tailRow, char: '├' }
      : x > sx1 ? { col: x, row: tailRow, char: '┤' }
      : undefined
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
  // Clawd: pixels gathered into cells, top and bottom half of each.
  const paintClawd = (x: number, y: number, pose: Pose, color: Rgb, isHidden?: (px: { x: number; y: number }) => boolean) => {
    const halves = new Map<number, { top?: Rgb; bottom?: Rgb }>()
    for (const px of clawdPixels(pose, color)) {
      const col = x + px.x
      const prow = y * 2 + px.y
      if (col < 0 || col >= cols || prow < 0 || prow >= rows * 2) continue
      if (isHidden?.(px)) continue
      const key = Math.floor(prow / 2) * cols + col
      const cell = halves.get(key) ?? {}
      if (prow % 2 === 0) cell.top = px.c
      else cell.bottom = px.c
      halves.set(key, cell)
    }
    for (const [key, cell] of halves) {
      const col = key % cols
      const row = Math.floor(key / cols)
      if (cell.top) put(col, row, '▀', cell.top, cell.bottom)
      else if (cell.bottom) put(col, row, '▄', cell.bottom)
    }
  }

  // The scene's code draws over the backdrop and swarms, under the actors.
  const code = script.code
  if (code?.program && !code.error) {
    const dt = code.isStarted ? clamp(sceneT - code.lastT, 0, 0.25) : 0
    code.lastT = sceneT
    const globals = { t: sceneT, dt, w: cols, h: rows }
    canvas = {
      put: (col, row, char, color, back) => put(col, row, char, color, back),
      clear: (col, row) => clear({ x0: col, y0: row, x1: col, y1: row }),
      clawd: (x, y, pose, color) => paintClawd(x, y, pose, color),
      say: (text, x, y, color) => {
        // A new line types out; one that only changed from a line already
        // typed (a live count, a timer) shows whole rather than restarting.
        let first = code.said.get(text)
        if (first === undefined) {
          const isTyped = (line: string, at: number) => (sceneT - at) * 1000 >= line.length * BUBBLE_MS
          first = [...code.said].some(([line, at]) => isTyped(line, at)) ? -Infinity : sceneT
          if (code.said.size >= 32) code.said.clear()
          code.said.set(text, first)
        }
        const bubble = bubbleAt(text, x, y, color, sceneT - first, cols, rows)
        if (bubble) bubbles.push(bubble)
      },
    }
    try {
      if (!code.isStarted) {
        code.isStarted = true
        code.program.start({ ...API, ...globals }, SETUP_FUEL)
      }
      code.program.call('frame', [sceneT, dt], globals, FRAME_FUEL)
    } catch (e) {
      code.error = e instanceof Error ? e.message : String(e)
    } finally {
      canvas = undefined
    }
  }

  // Actors back to front, each hiding what is behind its outline.
  placed.forEach((one, i) => {
    const color = parseHex(one.actor.color)
    if (one.pose) {
      paintClawd(one.x, one.y, one.pose, color, px => one.alpha < 1 && hash(px.x * 13 + px.y, Math.floor(since / 50) + i) > one.alpha)

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
  for (const b of bubbles) {
    const edge = mix(b.base, [255, 255, 255], 0.35)
    const fill = dim(b.base, 0.18)
    const ink = mix(b.base, [255, 255, 255], 0.85)
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
        if (char === ' ') put(col, row, ' ', ink, fill)
        else put(col, row, char, edge)
      }
    }
    if (b.tail) put(b.tail.col, b.tail.row, b.tail.char, edge)
    b.lines.forEach((line, dy) => [...line].forEach((c, dx) => put(b.x + 2 + dx, b.y + 1 + dy, c, ink, fill)))
  }

  return encode(words)
}
