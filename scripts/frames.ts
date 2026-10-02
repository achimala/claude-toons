// Prints the frames of a stock scene as JSON, for scripts/gif.py to draw:
//
//   bun scripts/frames.ts <number> [--seconds N] [--fps N] [--cols N]

import { SCENES } from '../hooks/scenes'
import { cleanScript, stage } from '../hooks/script'

const args = process.argv.slice(2)
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`)

  return i >= 0 ? Number(args[i + 1] ?? fallback) : fallback
}
const index = Number(args.find(a => /^\d+$/.test(a)) ?? -1)
const stock = SCENES[index]
if (!stock) {
  console.error(`no scene ${index}; ${SCENES.length} in stock`)
  process.exit(1)
}
const seconds = opt('seconds', 12)
const fps = opt('fps', 10)
const cols = opt('cols', 100)
const script = cleanScript(JSON.parse(JSON.stringify(stock.scene).split('{what}').join('auth.ts')))
if (!script) process.exit(1)
const frames: string[] = []
for (let n = 0; n < seconds * fps; n++) {
  const since = (n * 1000) / fps
  frames.push(stage({ cols, rows: 9, t: since / 1000, script, since, reveal: 1 }))
}
console.log(JSON.stringify({ index, cols, rows: 9, fps, title: `#${index} ${stock.phase} · ${stock.world} · ${stock.style} · ${stock.source}`, concept: stock.concept, error: script.code?.error, frames }))
