// A small 3D renderer for scene code: meshes in a world with a camera, one
// directional light and distance fog, rasterized into a grid of pixels (two
// to a cell) with a depth buffer. Flat shading: each triangle takes one
// color, lit by how squarely it faces the light and faded by how far it is,
// which is what reads as depth on a canvas this small.

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

export const DEFAULT_CAMERA: Camera = { eye: [0, 2.5, 9], target: [0, 1, 0], fov: 90 }

// The strip is wide and only 18 pixels tall, so the field of view is the
// angle across it, measured over this many columns whatever the terminal's
// width: things stay the same size on a wider terminal, which shows more.
const NOMINAL_COLS = 120
export const DEFAULT_LIGHT: Light = { dir: [0.4, 1, 0.6], ambient: 0.35 }
export const DEFAULT_FOG: Fog = { near: 8, far: 40, color: [0, 0, 0] }

// Where the pixels go: the depth of each is kept for the frame.
export type Target = {
  w: number
  h: number
  depth: Float32Array
  plot: (x: number, y: number, c: Rgb) => void
}

export const createDepth = (w: number, h: number) => new Float32Array(w * h).fill(Infinity)

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

// The camera resolved for a target: its axes, and the focal length that
// turns view-space positions into pixels.
export type View = {
  eye: Vec3
  right: Vec3
  up: Vec3
  forward: Vec3
  f: number
  w: number
  h: number
}

export function resolve(cam: Camera, w: number, h: number): View {
  const forward = norm(sub(cam.target, cam.eye))
  const worldUp: Vec3 = Math.abs(forward[1]) > 0.99 ? [0, 0, -1] : [0, 1, 0]
  const right = norm(cross(forward, worldUp))
  const up = cross(right, forward)
  const fov = (Math.max(10, Math.min(170, cam.fov)) * Math.PI) / 180

  return { eye: cam.eye, right, up, forward, f: NOMINAL_COLS / 2 / Math.tan(fov / 2), w, h }
}

export type Projected = { x: number; y: number; depth: number }

// A world point on the pixel grid, or undefined behind the camera.
export function project(view: View, p: Vec3): Projected | undefined {
  const d = sub(p, view.eye)
  const depth = dot(d, view.forward)
  if (depth < 0.05) return undefined
  const x = (dot(d, view.right) * view.f) / depth + view.w / 2
  const y = view.h / 2 - (dot(d, view.up) * view.f) / depth

  return { x, y, depth }
}

// The world position of a model-space point.
export function transformPoint(t: Transform, p: Vec3): Vec3 {
  let [x, y, z] = [p[0] * t.scale[0], p[1] * t.scale[1], p[2] * t.scale[2]]
  const [rx, ry, rz] = t.rot
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

  return [x + t.at[0], y + t.at[1], z + t.at[2]]
}

const shadeOf = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]
const fogged = (c: Rgb, fog: Fog, depth: number): Rgb => {
  const k = smooth(fog.near, fog.far, depth)

  return [c[0] + (fog.color[0] - c[0]) * k, c[1] + (fog.color[1] - c[1]) * k, c[2] + (fog.color[2] - c[2]) * k]
}

export type Style = { color: Rgb; wire: boolean; unlit: boolean }

// Fills one triangle given on the pixel grid with per-vertex depth, depth
// tested, each pixel fogged by its depth.
function fillTriangle(target: Target, fog: Fog, a: Projected, b: Projected, c: Projected, color: Rgb) {
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  if (Math.abs(area) < 1e-6) return
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)))
  const x1 = Math.min(target.w - 1, Math.ceil(Math.max(a.x, b.x, c.x)))
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)))
  const y1 = Math.min(target.h - 1, Math.ceil(Math.max(a.y, b.y, c.y)))
  if (x1 < x0 || y1 < y0) return
  // Depth interpolates linearly in 1/depth across the screen.
  const ia = 1 / a.depth
  const ib = 1 / b.depth
  const ic = 1 / c.depth
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5
      const wa = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area
      const wb = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area
      const wc = 1 - wa - wb
      if (wa < 0 || wb < 0 || wc < 0) continue
      const depth = 1 / (wa * ia + wb * ib + wc * ic)
      const at = y * target.w + x
      if (depth >= target.depth[at]!) continue
      target.depth[at] = depth
      target.plot(x, y, fogged(color, fog, depth))
    }
  }
}

// A line between two world points, depth tested along its length.
export function drawLine(target: Target, view: View, fog: Fog, p0: Vec3, p1: Vec3, color: Rgb) {
  const a = project(view, p0)
  const b = project(view, p1)
  if (!a || !b) return
  const steps = Math.min(600, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))) || 1)
  for (let i = 0; i <= steps; i++) {
    const k = i / steps
    const x = Math.floor(a.x + (b.x - a.x) * k)
    const y = Math.floor(a.y + (b.y - a.y) * k)
    if (x < 0 || x >= target.w || y < 0 || y >= target.h) continue
    const depth = 1 / ((1 - k) / a.depth + k / b.depth)
    const at = y * target.w + x
    // A little nearer than the surface it lies on, so edges show on faces.
    if (depth - 0.02 >= target.depth[at]!) continue
    target.depth[at] = depth - 0.02
    target.plot(x, y, fogged(color, fog, depth))
  }
}

export function drawPoint(target: Target, view: View, fog: Fog, p: Vec3, color: Rgb) {
  const a = project(view, p)
  if (!a) return
  const x = Math.floor(a.x)
  const y = Math.floor(a.y)
  if (x < 0 || x >= target.w || y < 0 || y >= target.h) return
  const at = y * target.w + x
  if (a.depth >= target.depth[at]!) return
  target.depth[at] = a.depth
  target.plot(x, y, fogged(color, fog, a.depth))
}

// The most triangles one frame draws, over every mesh.
export const MOST_TRIANGLES = 20_000

// Draws a mesh placed by a transform: filled and lit, or as wire edges.
// Returns the triangles drawn, for the frame's budget.
export function drawMesh(target: Target, view: View, light: Light, fog: Fog, mesh: Mesh, t: Transform, style: Style, budget: number) {
  const { verts, faces } = mesh
  const n = Math.floor(verts.length / 3)
  const world: Vec3[] = []
  const screen: (Projected | undefined)[] = []
  for (let i = 0; i < n; i++) {
    const p = transformPoint(t, [verts[i * 3]!, verts[i * 3 + 1]!, verts[i * 3 + 2]!])
    world.push(p)
    screen.push(project(view, p))
  }
  const l = norm(light.dir)
  let drawn = 0
  for (let i = 0; i + 2 < faces.length && drawn < budget; i += 3) {
    const [ia, ib, ic] = [faces[i]!, faces[i + 1]!, faces[i + 2]!]
    const a = screen[ia]
    const b = screen[ib]
    const c = screen[ic]
    const pa = world[ia]
    const pb = world[ib]
    const pc = world[ic]
    if (!a || !b || !c || !pa || !pb || !pc) continue
    drawn += 1
    if (style.wire) {
      drawLine(target, view, fog, pa, pb, style.color)
      drawLine(target, view, fog, pb, pc, style.color)
      drawLine(target, view, fog, pc, pa, style.color)
      continue
    }
    let color = style.color
    if (!style.unlit) {
      // Lit from either side, so a mesh wound inside out still shades.
      const normal = norm(cross(sub(pb, pa), sub(pc, pa)))
      const k = light.ambient + (1 - light.ambient) * Math.abs(dot(normal, l))
      color = shadeOf(color, k)
    }
    fillTriangle(target, fog, a, b, c, color)
  }

  return drawn
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
export function sphere(r: number, segments = 8): Mesh {
  const seg = Math.max(3, Math.min(32, Math.round(segments)))
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
export function cylinder(rBottom: number, rTop: number, h: number, segments = 8): Mesh {
  const seg = Math.max(3, Math.min(32, Math.round(segments)))
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
