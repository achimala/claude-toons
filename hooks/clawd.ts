// Clawd, the mascot, in pixel art: a rounded orange block with two eyes and
// four little feet, 14 pixels wide and 8 tall at scale 1, which is 4 rows of
// cells (two pixels to a cell). Scenes draw it with a pose, a facing, eyes,
// a color and a scale, and get back where its head, sides and feet are, so
// they can hang a hat on it or put a prop in its hand.

import type { Rgb } from './effects'

export const CLAWD_W = 14
export const CLAWD_H = 8

// The body: B is the body, E an eye (its resting place, 1 wide and 2 tall).
// The claws are drawn per pose beside it.
const BODY = [
  '..BBBBBBBBBB..',
  '..BBBBBBBBBB..',
  '.BBBEBBBBBEBB.',
  '.BBBEBBBBBEBB.',
  '.BBBBBBBBBBBB.',
  '..BBBBBBBBBB..',
]

export type Arm = 'up' | 'out' | 'down'
export const ARMS: Arm[] = ['up', 'out', 'down']

// A claw's pixels for each pose, for the left side (x from the body's left
// edge at 1, so 0 is just outside it); the right side mirrors them. Each
// ends at its tip, where things are held.
const CLAWS: Record<Arm, { pixels: [number, number][]; tip: [number, number] }> = {
  up: { pixels: [[0, 1], [0, 2]], tip: [0, 0] },
  out: { pixels: [[-1, 2], [0, 2]], tip: [-2, 2] },
  down: { pixels: [[0, 3], [0, 4]], tip: [0, 5] },
}
const BODY_H = BODY.length
// The feet: two pairs under the body, each foot a pixel wide and two tall.
const FEET = [3, 5, 8, 10]
const EYES = [4, 9]
const EYE_ROW = 2

export const CLAWD_ORANGE: Rgb = [217, 119, 87]
const EYE_DARK: Rgb = [42, 22, 16]

export type Pose = 'stand' | 'walk' | 'jump' | 'sit'
export type Eyes = 'open' | 'closed' | 'wide'

export type ClawdLook = {
  pose: Pose
  // Which walk frame (0 to 3) while walking: a step cycle, so a walker's
  // feet match its travel when this comes from its x.
  stride: number
  // -1 left, 0 ahead, 1 right: where the eyes look, and which way the feet
  // swing.
  facing: number
  eyes: Eyes
  // The eyes shifted from where they rest, in pixels: a glance.
  look: { x: number; y: number }
  isBlinking: boolean
  color: Rgb
  eyeColor: Rgb
  // Whole pixels per pixel: 1 is 14x8, 2 is 28x16.
  scale: number
  // Where each claw is held.
  arms: { left: Arm; right: Arm }
}

export const LOOK: ClawdLook = {
  pose: 'stand',
  stride: 0,
  facing: 0,
  eyes: 'open',
  look: { x: 0, y: 0 },
  isBlinking: false,
  color: CLAWD_ORANGE,
  eyeColor: EYE_DARK,
  scale: 1,
  arms: { left: 'up', right: 'up' },
}

export type Pixel = { x: number; y: number; c: Rgb }

// Where things attach, in pixels from the sprite's top-left: above the head,
// at either side, at the feet, and at the eyes.
export type Anchors = {
  w: number
  h: number
  top: { x: number; y: number }
  left: { x: number; y: number }
  right: { x: number; y: number }
  feet: { x: number; y: number }
  eyes: { x: number; y: number; w: number }
}

// The sprite's pixels at scale 1, body first and eyes last so a body pixel
// never covers an eye that glanced aside.
function pixelsAtOne(look: ClawdLook): Pixel[] {
  const body: Pixel[] = []
  const eyes: Pixel[] = []
  // Sitting, the body rests on the ground where the feet would be.
  const drop = look.pose === 'sit' ? CLAWD_H - BODY_H : 0
  BODY.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] !== '.') body.push({ x, y: y + drop, c: look.color })
  })
  for (const [px, py] of CLAWS[look.arms.left].pixels) body.push({ x: px, y: py + drop, c: look.color })
  for (const [px, py] of CLAWS[look.arms.right].pixels) body.push({ x: CLAWD_W - 1 - px, y: py + drop, c: look.color })
  const ex = Math.max(-1, Math.min(1, Math.round(look.look.x))) || look.facing
  const ey = Math.max(-1, Math.min(1, Math.round(look.look.y)))
  for (const x0 of EYES) {
    const x = x0 + ex
    const y = EYE_ROW + ey + drop
    if (look.eyes === 'closed' || look.isBlinking) {
      // A line where the eye's lower pixel was.
      eyes.push({ x, y: y + 1, c: look.eyeColor }, { x: x + (x0 === EYES[0] ? -1 : 1), y: y + 1, c: look.eyeColor })
    } else if (look.eyes === 'wide') {
      for (let dx = -1; dx <= 0; dx++) for (let dy = 0; dy <= 1; dy++) eyes.push({ x: x + dx, y: y + dy, c: look.eyeColor })
    } else {
      eyes.push({ x, y, c: look.eyeColor }, { x, y: y + 1, c: look.eyeColor })
    }
  }
  const feet: Pixel[] = []
  if (look.pose !== 'sit') {
    const top = BODY_H
    const ground = CLAWD_H - 1
    const dir = look.facing || 1
    FEET.forEach((x0, i) => {
      // The left pair and the right pair swing against each other.
      const isFront = i < 2
      let swing = 0
      let isLifted = false
      if (look.pose === 'walk') {
        // A four-beat step: the pairs swing past each other, and the pair
        // mid-swing is off the ground.
        const beat = ((Math.round(look.stride) % 4) + 4) % 4
        if (beat === 0) swing = isFront ? 1 : -1
        else if (beat === 2) swing = isFront ? -1 : 1
        else isLifted = beat === 1 ? !isFront : isFront
      } else if (look.pose === 'jump') {
        isLifted = true
      }
      const x = x0 + swing * dir
      for (let y = top; y <= (isLifted ? ground - 1 : ground); y++) feet.push({ x, y, c: look.color })
    })
  }
  // A claw held out reaches a pixel past the box on either side.
  const inside = (p: Pixel) => p.x >= -1 && p.x <= CLAWD_W && p.y >= 0 && p.y < CLAWD_H

  return [...body, ...feet, ...eyes].filter(inside)
}

// The sprite's pixels at its scale, each pixel of the small sprite drawn as
// a block of scale by scale.
export function clawdPixels(look: ClawdLook): Pixel[] {
  const scale = Math.max(1, Math.min(4, Math.round(look.scale)))
  const small = pixelsAtOne(look)
  if (scale === 1) return small
  const out: Pixel[] = []
  for (const p of small) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) out.push({ x: p.x * scale + dx, y: p.y * scale + dy, c: p.c })
  }

  return out
}

export function clawdAnchors(look: ClawdLook): Anchors {
  const s = Math.max(1, Math.min(4, Math.round(look.scale)))
  const drop = look.pose === 'sit' ? CLAWD_H - BODY_H : 0
  // The claws' tips, where things are held.
  const leftTip = CLAWS[look.arms.left].tip
  const rightTip = CLAWS[look.arms.right].tip

  return {
    w: CLAWD_W * s,
    h: CLAWD_H * s,
    top: { x: Math.floor((CLAWD_W / 2) * s), y: drop * s - 1 },
    left: { x: leftTip[0] * s - (s - 1), y: (leftTip[1] + drop) * s },
    right: { x: (CLAWD_W - 1 - rightTip[0]) * s + (s - 1), y: (rightTip[1] + drop) * s },
    feet: { x: Math.floor((CLAWD_W / 2) * s), y: CLAWD_H * s },
    eyes: { x: EYES[0]! * s, y: (EYE_ROW + drop) * s, w: (EYES[1]! - EYES[0]! + 1) * s },
  }
}
