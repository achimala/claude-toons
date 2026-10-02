// A small 3D renderer for scene code. The world is sampled at a finer grid
// than the cells (2 across and 4 down per cell, so the samples are square),
// each sample is lit with a smoothly interpolated normal, and each cell is
// then drawn from its samples: a cell a surface covers whole is a solid cell
// in the lit color, a cell covered in part is the block glyph that matches
// which quarters are covered (so edges come out anti-aliased), and a mesh
// drawn `ascii` is instead the glyph whose density matches its brightness,
// the classic terminal look, which suits curved things.

import type { Rgb } from './effects'

export type Vec3 = [number, number, number]

// Triangles over shared vertices: verts is x, y, z per vertex; faces is
// three vertex indices per triangle.
export type Mesh = { verts: number[]; faces: number[] }

// `fov` is the angle the strip shows across, in degrees (see NOMINAL_COLS).
export type Camera = { eye: Vec3; target: Vec3; fov: number }
export type Light = { dir: Vec3; ambient: number }
export type Fog = { near: number; far: number; color: Rgb }

export type Transform = {
  at: Vec3
  // Rotations in radians, applied about x, then y, then z.
  rot: Vec3
  scale: Vec3
}

export type Style = { color: Rgb; wire: boolean; unlit: boolean; ascii?: boolean }

export const DEFAULT_CAMERA: Camera = { eye: [0, 2.5, 9], target: [0, 1, 0], fov: 90 }
export const DEFAULT_LIGHT: Light = { dir: [0.4, 1, 0.6], ambient: 0.25 }
export const DEFAULT_FOG: Fog = { near: 8, far: 40, color: [0, 0, 0] }

// The strip is wide and only 9 rows tall, so the field of view is the
// angle across it, measured over this many columns whatever the terminal's
// width: things stay the same size on a wider terminal, which shows more.
const NOMINAL_COLS = 120

// Samples per cell, across and down.
export const SX = 2
export const SY = 4

// Nothing nearer than this draws: the near plane, where geometry that
// crosses behind the camera is cut.
const NEAR = 0.05

// The most triangles one frame draws, over every mesh.
export const MOST_TRIANGLES = 20_000

// A frame's samples: depth, the lit color, and what owns each (nothing, a
// surface, or a sprite drawn in cells that the glyphs must leave alone).
export type Frame = {
  cols: number
  rows: number
  w: number
  h: number
  depth: Float32Array
  color: Float32Array
  owner: Uint8Array
  // Cells with surface samples drawn since the last composite.
  dirty: Uint8Array
  triangles: number
}

export const createFrame = (cols: number, rows: number): Frame => {
  const w = cols * SX
  const h = rows * SY

  return {
    cols,
    rows,
    w,
    h,
    depth: new Float32Array(w * h).fill(Infinity),
    color: new Float32Array(w * h * 3),
    owner: new Uint8Array(w * h),
    dirty: new Uint8Array(cols * rows),
    triangles: 0,
  }
}

const SURFACE = 1
const SPRITE = 2
const ASCII = 3
const isSurface = (owner: number) => owner === SURFACE || owner === ASCII

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1

  return [a[0] / l, a[1] / l, a[2] / l]
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth = (lo: number, hi: number, v: number) => {
  const k = clamp01(hi === lo ? (v >= hi ? 1 : 0) : (v - lo) / (hi - lo))

  return k * k * (3 - 2 * k)
}

// ---------------------------------------------------------------- camera

export type View = { eye: Vec3; right: Vec3; up: Vec3; forward: Vec3; f: number; w: number; h: number }

export function resolve(cam: Camera, w: number, h: number): View {
  const forward = norm(sub(cam.target, cam.eye))
  const worldUp: Vec3 = Math.abs(forward[1]) > 0.99 ? [0, 0, -1] : [0, 1, 0]
  const right = norm(cross(forward, worldUp))
  const up = cross(right, forward)
  const fov = (Math.max(10, Math.min(170, cam.fov)) * Math.PI) / 180
  // The focal length in samples: pixels over the nominal width, times the
  // samples per column.
  const f = ((NOMINAL_COLS / 2) * SX) / Math.tan(fov / 2)

  return { eye: cam.eye, right, up, forward, f, w, h }
}

// A point in the camera's frame: across, up, and its depth ahead.
type ViewPoint = { r: number; u: number; d: number }

const toView = (view: View, p: Vec3): ViewPoint => {
  const d = sub(p, view.eye)

  return { r: dot(d, view.right), u: dot(d, view.up), d: dot(d, view.forward) }
}

// On the sample grid; `x` and `y` in samples.
export type Projected = { x: number; y: number; depth: number }

const toScreen = (view: View, v: ViewPoint): Projected => ({
  x: (v.r * view.f) / v.d + view.w / 2,
  y: view.h / 2 - (v.u * view.f) / v.d,
  depth: v.d,
})

// A world point on the sample grid, or undefined behind the camera.
export function project(view: View, p: Vec3): Projected | undefined {
  const v = toView(view, p)

  return v.d < NEAR ? undefined : toScreen(view, v)
}

// The part of a polygon in front of the near plane (Sutherland-Hodgman
// against one plane), each vertex carrying its attributes along.
type Vertex = { v: ViewPoint; p: Vec3; n: Vec3 }

function clipNear(poly: Vertex[]): Vertex[] {
  if (poly.every(x => x.v.d >= NEAR)) return poly
  const out: Vertex[] = []
  const mixv = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const aIn = a.v.d >= NEAR
    const bIn = b.v.d >= NEAR
    if (aIn) out.push(a)
    if (aIn !== bIn) {
      const k = (NEAR - a.v.d) / (b.v.d - a.v.d)
      out.push({
        v: { r: a.v.r + (b.v.r - a.v.r) * k, u: a.v.u + (b.v.u - a.v.u) * k, d: NEAR },
        p: mixv(a.p, b.p, k),
        n: mixv(a.n, b.n, k),
      })
    }
  }

  return out
}

// ---------------------------------------------------------------- meshes

export function transformPoint(t: Transform, p: Vec3): Vec3 {
  const [x, y, z] = rotate(t.rot, [p[0] * t.scale[0], p[1] * t.scale[1], p[2] * t.scale[2]])

  return [x + t.at[0], y + t.at[1], z + t.at[2]]
}

function rotate(rot: Vec3, p: Vec3): Vec3 {
  let [x, y, z] = p
  const [rx, ry, rz] = rot
  if (rx) {
    const c = Math.cos(rx)
    const s = Math.sin(rx)
    ;[y, z] = [y * c - z * s, y * s + z * c]
  }
  if (ry) {
    const c = Math.cos(ry)
    const s = Math.sin(ry)
    ;[x, z] = [x * c + z * s, -x * s + z * c]
  }
  if (rz) {
    const c = Math.cos(rz)
    const s = Math.sin(rz)
    ;[x, y] = [x * c - y * s, x * s + y * c]
  }

  return [x, y, z]
}

// A mesh with a normal for each corner of each face: faces meeting at a
// gentle angle share smoothed normals (a sphere looks round), faces meeting
// at a crease keep their own (a cube stays sharp).
type Prepared = { faceNormals: Vec3[]; cornerNormals: Vec3[] }
const prepared = new WeakMap<Mesh, Prepared>()
const CREASE = Math.cos((50 * Math.PI) / 180)

function prepare(mesh: Mesh): Prepared {
  const done = prepared.get(mesh)
  if (done) return done
  const { verts, faces } = mesh
  const at = (i: number): Vec3 => [verts[i * 3] ?? 0, verts[i * 3 + 1] ?? 0, verts[i * 3 + 2] ?? 0]
  const count = Math.floor(faces.length / 3)
  const faceNormals: Vec3[] = []
  const around = new Map<number, number[]>()
  for (let f = 0; f < count; f++) {
    const [a, b, c] = [faces[f * 3]!, faces[f * 3 + 1]!, faces[f * 3 + 2]!]
    faceNormals.push(norm(cross(sub(at(b), at(a)), sub(at(c), at(a)))))
    for (const i of [a, b, c]) {
      const list = around.get(i) ?? []
      list.push(f)
      around.set(i, list)
    }
  }
  const cornerNormals: Vec3[] = []
  for (let f = 0; f < count; f++) {
    const mine = faceNormals[f]!
    for (let k = 0; k < 3; k++) {
      const i = faces[f * 3 + k]!
      const sum: Vec3 = [0, 0, 0]
      for (const g of around.get(i) ?? []) {
        const other = faceNormals[g]!
        if (dot(mine, other) >= CREASE) {
          sum[0] += other[0]
          sum[1] += other[1]
          sum[2] += other[2]
        }
      }
      cornerNormals.push(norm(sum))
    }
  }
  const result = { faceNormals, cornerNormals }
  prepared.set(mesh, result)

  return result
}

// ---------------------------------------------------------------- drawing

const fogged = (c: Rgb, fog: Fog, depth: number): Rgb => {
  const k = smooth(fog.near, fog.far, depth)

  return [c[0] + (fog.color[0] - c[0]) * k, c[1] + (fog.color[1] - c[1]) * k, c[2] + (fog.color[2] - c[2]) * k]
}

function plot(frame: Frame, x: number, y: number, depth: number, c: Rgb, owner = SURFACE) {
  const at = y * frame.w + x
  frame.depth[at] = depth
  frame.owner[at] = owner
  frame.color[at * 3] = c[0]
  frame.color[at * 3 + 1] = c[1]
  frame.color[at * 3 + 2] = c[2]
  frame.dirty[Math.floor(y / SY) * frame.cols + Math.floor(x / SX)] = 1
}

// Lights a point of a surface: ambient, diffuse by the normal against the
// light, and a small highlight where the light reflects toward the eye.
function lit(color: Rgb, n: Vec3, p: Vec3, view: View, l: Vec3, ambient: number): Rgb {
  const toEye = norm(sub(view.eye, p))
  // Two-sided: a face seen from behind shades as if it faced the eye.
  const nn: Vec3 = dot(n, toEye) < 0 ? [-n[0], -n[1], -n[2]] : n
  const diffuse = Math.max(0, dot(nn, l))
  const half = norm([l[0] + toEye[0], l[1] + toEye[1], l[2] + toEye[2]])
  const spec = Math.pow(Math.max(0, dot(nn, half)), 24) * 0.35
  const k = ambient + (1 - ambient) * diffuse

  return [Math.min(255, color[0] * k + 255 * spec), Math.min(255, color[1] * k + 255 * spec), Math.min(255, color[2] * k + 255 * spec)]
}

// Fills one triangle on the sample grid, interpolating depth (linear in
// 1/depth), world position and normal, lighting each sample.
function fillTriangle(frame: Frame, view: View, fog: Fog, l: Vec3, ambient: number, tri: [Vertex, Vertex, Vertex], style: Style) {
  const [A, B, C] = tri
  const a = toScreen(view, A.v)
  const b = toScreen(view, B.v)
  const c = toScreen(view, C.v)
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  if (Math.abs(area) < 1e-9) return
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)))
  const x1 = Math.min(frame.w - 1, Math.ceil(Math.max(a.x, b.x, c.x)))
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)))
  const y1 = Math.min(frame.h - 1, Math.ceil(Math.max(a.y, b.y, c.y)))
  if (x1 < x0 || y1 < y0) return
  const ia = 1 / a.depth
  const ib = 1 / b.depth
  const ic = 1 / c.depth
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5
      let wa = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area
      let wb = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area
      let wc = 1 - wa - wb
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue
      const depth = 1 / (wa * ia + wb * ib + wc * ic)
      const at = y * frame.w + x
      if (depth >= frame.depth[at]!) continue
      // Perspective-correct weights for the attributes.
      wa *= ia * depth
      wb *= ib * depth
      wc *= ic * depth
      let color = style.color
      if (!style.unlit) {
        const n = norm([
          wa * A.n[0] + wb * B.n[0] + wc * C.n[0],
          wa * A.n[1] + wb * B.n[1] + wc * C.n[1],
          wa * A.n[2] + wb * B.n[2] + wc * C.n[2],
        ])
        const p: Vec3 = [
          wa * A.p[0] + wb * B.p[0] + wc * C.p[0],
          wa * A.p[1] + wb * B.p[1] + wc * C.p[1],
          wa * A.p[2] + wb * B.p[2] + wc * C.p[2],
        ]
        color = lit(color, n, p, view, l, ambient)
      }
      plot(frame, x, y, depth, fogged(color, fog, depth), style.ascii ? ASCII : SURFACE)
    }
  }
}

// A line between two world points, a cell's width thick, cut at the near
// plane and depth tested along its length.
export function drawLine(frame: Frame, view: View, fog: Fog, p0: Vec3, p1: Vec3, color: Rgb) {
  const zero: Vec3 = [0, 0, 0]
  const ends = clipNear([
    { v: toView(view, p0), p: p0, n: zero },
    { v: toView(view, p1), p: p1, n: zero },
  ])
  if (ends.length < 2) return
  const a = toScreen(view, ends[0]!.v)
  const b = toScreen(view, ends[1]!.v)
  const steps = Math.min(1200, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))) || 1)
  for (let i = 0; i <= steps; i++) {
    const k = i / steps
    const x = Math.floor(a.x + (b.x - a.x) * k)
    const y = Math.floor(a.y + (b.y - a.y) * k)
    const depth = 1 / ((1 - k) / a.depth + k / b.depth)
    // A little nearer than the surface it lies on, so edges show on faces.
    dab(frame, x, y, depth - 0.03, fogged(color, fog, depth))
  }
}

export function drawPoint(frame: Frame, view: View, fog: Fog, p: Vec3, color: Rgb) {
  const a = project(view, p)
  if (!a) return
  dab(frame, Math.floor(a.x), Math.floor(a.y), a.depth, fogged(color, fog, a.depth))
}

// A 2 by 2 sample dab: what a line or a point needs to read as a glyph.
function dab(frame: Frame, x: number, y: number, depth: number, color: Rgb) {
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const sx = x + dx
      const sy = y + dy
      if (sx < 0 || sx >= frame.w || sy < 0 || sy >= frame.h) continue
      const at = sy * frame.w + sx
      if (depth >= frame.depth[at]!) continue
      plot(frame, sx, sy, depth, color)
    }
  }
}

// Draws a mesh placed by a transform: filled and lit, or as wire edges.
export function drawMesh(frame: Frame, view: View, light: Light, fog: Fog, mesh: Mesh, t: Transform, style: Style) {
  const { verts, faces } = mesh
  const { cornerNormals } = prepare(mesh)
  const n = Math.floor(verts.length / 3)
  const world: Vec3[] = []
  const eyed: ViewPoint[] = []
  for (let i = 0; i < n; i++) {
    const p = transformPoint(t, [verts[i * 3]!, verts[i * 3 + 1]!, verts[i * 3 + 2]!])
    world.push(p)
    eyed.push(toView(view, p))
  }
  const l = norm(light.dir)
  const faceCount = Math.floor(faces.length / 3)
  for (let f = 0; f < faceCount && frame.triangles < MOST_TRIANGLES; f++) {
    const ids = [faces[f * 3]!, faces[f * 3 + 1]!, faces[f * 3 + 2]!]
    const corners: Vertex[] = []
    for (let k = 0; k < 3; k++) {
      const v = eyed[ids[k]!]
      const p = world[ids[k]!]
      if (!v || !p) break
      corners.push({ v, p, n: rotate(t.rot, cornerNormals[f * 3 + k] ?? [0, 1, 0]) })
    }
    if (corners.length < 3) continue
    if (corners.every(c => c.v.d < NEAR)) continue
    frame.triangles += 1
    if (style.wire) {
      drawLine(frame, view, fog, corners[0]!.p, corners[1]!.p, style.color)
      drawLine(frame, view, fog, corners[1]!.p, corners[2]!.p, style.color)
      drawLine(frame, view, fog, corners[2]!.p, corners[0]!.p, style.color)
      continue
    }
    const poly = clipNear(corners)
    for (let j = 1; j + 1 < poly.length; j++) fillTriangle(frame, view, fog, l, light.ambient, [poly[0]!, poly[j]!, poly[j + 1]!], style)
  }
}

// Claims a sprite's pixel (a column and a pixel row, two to a cell) at a
// depth: true when it is nearer than what is there, in which case the
// glyphs leave that pixel to the sprite.
export function claimPixel(frame: Frame, col: number, py: number, depth: number) {
  const x0 = col * SX
  const y0 = py * (SY / 2)
  if (x0 < 0 || x0 >= frame.w || y0 < 0 || y0 >= frame.h) return false
  let nearest = Infinity
  for (let dy = 0; dy < SY / 2; dy++) for (let dx = 0; dx < SX; dx++) nearest = Math.min(nearest, frame.depth[(y0 + dy) * frame.w + x0 + dx]!)
  if (depth >= nearest) return false
  for (let dy = 0; dy < SY / 2; dy++) {
    for (let dx = 0; dx < SX; dx++) {
      const at = (y0 + dy) * frame.w + x0 + dx
      frame.depth[at] = depth
      frame.owner[at] = SPRITE
    }
  }

  return true
}

// ---------------------------------------------------------------- glyphs

// Glyphs by brightness, sparse to dense, for `ascii` meshes.
const RAMP = [...' .,:;-=+*#%@']

// The block glyph for each set of covered quarters: bit 1 top-left, 2
// top-right, 4 bottom-left, 8 bottom-right.
const QUARTERS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']

// How far a sample's depth must jump from a neighbor's to count as an edge
// (as a share of its depth), and how much the farther side darkens there:
// a dark rim on the far side of every overlap, so shapes read as separate.
const EDGE = 0.06
const RIM = 0.45

// Two groups closer than this (squared distance over the channels: about
// 20 levels each) are one color: the cell stays solid rather than split.
const ALIKE = 20 * 20 * 3

// Draws the cells drawn on since the last composite. Each cell's four
// quarters (two samples each) are split into two groups by color, and the
// cell is the quarter-block glyph of that split with a color for each
// group, so a cell can hold an edge, or a gradient, with two colors.
export function composite(frame: Frame, put: (col: number, row: number, char: string, color: Rgb, back?: Rgb) => void) {
  const per = SX * SY
  const half = SY / 2
  for (let row = 0; row < frame.rows; row++) {
    for (let col = 0; col < frame.cols; col++) {
      const cell = row * frame.cols + col
      if (!frame.dirty[cell]) continue
      frame.dirty[cell] = 0
      // Per quarter: samples covered, their summed color; and the cell's.
      const qCount = [0, 0, 0, 0]
      const qSum: Rgb[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
      let covered = 0
      let sprite = 0
      let ascii = 0
      const sum: Rgb = [0, 0, 0]
      for (let dy = 0; dy < SY; dy++) {
        for (let dx = 0; dx < SX; dx++) {
          const x = col * SX + dx
          const y = row * SY + dy
          const at = y * frame.w + x
          const owner = frame.owner[at]!
          if (owner === SPRITE) sprite += 1
          if (!isSurface(owner)) continue
          if (owner === ASCII) ascii += 1
          const c = rimmed(frame, x, y, at)
          const q = (dy < half ? 0 : 2) + (dx < SX / 2 ? 0 : 1)
          qCount[q] = (qCount[q] ?? 0) + 1
          qSum[q]![0] += c[0]
          qSum[q]![1] += c[1]
          qSum[q]![2] += c[2]
          covered += 1
          sum[0] += c[0]
          sum[1] += c[1]
          sum[2] += c[2]
        }
      }
      // A cell a sprite holds is the sprite's, unless a surface drawn since
      // covers more of it (something passing in front of Clawd).
      if (covered === 0 || sprite >= covered) continue
      const mean: Rgb = [sum[0] / covered, sum[1] / covered, sum[2] / covered]
      const coverage = covered / per
      if (ascii > 0) {
        // The classic look: a glyph as dense as the brightness, thinned by
        // coverage, in ink that keeps the hue, over a dark tint when solid.
        // Mid-tones lean toward the denser glyphs (a gamma of 0.6).
        const brightness = (0.299 * mean[0] + 0.587 * mean[1] + 0.114 * mean[2]) / 255
        const level = Math.min(RAMP.length - 1, Math.round(Math.pow(brightness, 0.6) * coverage * (RAMP.length - 1)))
        const back: Rgb | undefined = coverage >= 0.5 ? [mean[0] * 0.18, mean[1] * 0.18, mean[2] * 0.18] : undefined
        put(col, row, RAMP[Math.max(1, level)] ?? '.', lift(mean), back)
        continue
      }
      const qMean: (Rgb | undefined)[] = qCount.map((n, q) => (n > 0 ? [qSum[q]![0] / n, qSum[q]![1] / n, qSum[q]![2] / n] : undefined))
      const onMask = qMean.reduce((m, c, q) => (c ? m | (1 << q) : m), 0)
      // The split of the covered quarters into two color groups that keeps
      // each group most alike; the uncovered quarters always sit in the
      // second group, which draws as the background.
      let best = onMask
      let bestCost = Infinity
      for (let mask = 1; mask <= onMask; mask++) {
        if ((mask & onMask) !== mask) continue
        const a = groupMean(qMean, mask)
        const b = groupMean(qMean, onMask & ~mask)
        let cost = 0
        for (let q = 0; q < 4; q++) {
          const c = qMean[q]
          if (!c) continue
          const g = mask & (1 << q) ? a : b
          cost += g ? dist(c, g) : 0
        }
        if (cost < bestCost - 1e-9) {
          bestCost = cost
          best = mask
        }
      }
      const fg = groupMean(qMean, best) ?? mean
      const rest = onMask & ~best
      const bg = groupMean(qMean, rest)
      if (onMask === 15 && (best === 15 || (bg && dist(fg, bg) < ALIKE))) {
        // Four quarters of much the same color: a solid cell.
        put(col, row, ' ', mean, mean)
      } else if (best === 15) {
        // Four quarters of one color: a solid cell.
        put(col, row, ' ', fg, fg)
      } else if (bg && bitCount(rest) > bitCount(~onMask & 15)) {
        // The second group covers more than the uncovered part: two colors.
        put(col, row, QUARTERS[best] ?? '█', fg, bg)
      } else {
        put(col, row, QUARTERS[best] ?? '█', fg)
      }
    }
  }
}

// A sample's color, darkened where its depth jumps away from a neighbor's
// to the left or above (the far side of an overlap).
function rimmed(frame: Frame, x: number, y: number, at: number): Rgb {
  const c: Rgb = [frame.color[at * 3]!, frame.color[at * 3 + 1]!, frame.color[at * 3 + 2]!]
  const d = frame.depth[at]!
  let isRim = false
  for (const n of [x > 0 ? at - 1 : -1, y > 0 ? at - frame.w : -1, x + 1 < frame.w ? at + 1 : -1, y + 1 < frame.h ? at + frame.w : -1]) {
    if (n < 0 || !isSurface(frame.owner[n]!)) continue
    if (d - frame.depth[n]! > EDGE * d) isRim = true
  }

  return isRim ? [c[0] * RIM, c[1] * RIM, c[2] * RIM] : c
}

const bitCount = (m: number) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1))

const dist = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

function groupMean(q: (Rgb | undefined)[], mask: number): Rgb | undefined {
  const sum: Rgb = [0, 0, 0]
  let n = 0
  for (let i = 0; i < 4; i++) {
    const c = q[i]
    if (!(mask & (1 << i)) || !c) continue
    sum[0] += c[0]
    sum[1] += c[1]
    sum[2] += c[2]
    n += 1
  }

  return n > 0 ? [sum[0] / n, sum[1] / n, sum[2] / n] : undefined
}

// Ink that stays visible: the color brightened toward its hue when dark.
function lift(c: Rgb): Rgb {
  const max = Math.max(c[0], c[1], c[2], 1)
  const k = Math.max(1, 90 / max)

  return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)]
}

// ---------------------------------------------------------------- shapes

const quad = (faces: number[], a: number, b: number, c: number, d: number) => faces.push(a, b, c, a, c, d)

// A box centered on the origin.
export function box(w: number, h: number, d: number): Mesh {
  const x = w / 2
  const y = h / 2
  const z = d / 2
  const verts = [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z]
  const faces: number[] = []
  quad(faces, 0, 1, 2, 3)
  quad(faces, 5, 4, 7, 6)
  quad(faces, 4, 0, 3, 7)
  quad(faces, 1, 5, 6, 2)
  quad(faces, 3, 2, 6, 7)
  quad(faces, 4, 5, 1, 0)

  return { verts, faces }
}

// A sphere of latitude rings and longitude segments.
export function sphere(r: number, segments = 12): Mesh {
  const seg = Math.max(3, Math.min(48, Math.round(segments)))
  const rings = Math.max(2, Math.round(seg / 2))
  const verts: number[] = []
  const faces: number[] = []
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI
    for (let j = 0; j < seg; j++) {
      const theta = (j / seg) * Math.PI * 2
      verts.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j
      const b = i * seg + ((j + 1) % seg)
      const c = (i + 1) * seg + ((j + 1) % seg)
      const d = (i + 1) * seg + j
      if (i > 0) faces.push(a, b, c)
      if (i < rings - 1) faces.push(a, c, d)
    }
  }

  return { verts, faces }
}

// A cylinder (or a cone when the top radius is 0) standing on the origin,
// its base at y 0 and its top at y h.
export function cylinder(rBottom: number, rTop: number, h: number, segments = 12): Mesh {
  const seg = Math.max(3, Math.min(48, Math.round(segments)))
  const verts: number[] = []
  const faces: number[] = []
  for (let j = 0; j < seg; j++) {
    const theta = (j / seg) * Math.PI * 2
    verts.push(rBottom * Math.cos(theta), 0, rBottom * Math.sin(theta))
    verts.push(rTop * Math.cos(theta), h, rTop * Math.sin(theta))
  }
  // The centers of the two caps.
  const cb = seg * 2
  const ct = seg * 2 + 1
  verts.push(0, 0, 0, 0, h, 0)
  for (let j = 0; j < seg; j++) {
    const a = j * 2
    const b = ((j + 1) % seg) * 2
    quad(faces, a, b, b + 1, a + 1)
    faces.push(cb, b, a)
    if (rTop > 0) faces.push(ct, a + 1, b + 1)
  }

  return { verts, faces }
}

// A flat rectangle on the ground (the x-z plane), centered on the origin.
export function plane(w: number, d: number): Mesh {
  const x = w / 2
  const z = d / 2

  return { verts: [-x, 0, -z, x, 0, -z, x, 0, z, -x, 0, z], faces: [0, 1, 2, 0, 2, 3] }
}
