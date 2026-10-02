// Plays stock scenes in the terminal, with the plugin's own renderer, to
// judge them by eye:
//
//   bun scripts/play.ts [phase|number|all] [--seconds N] [--source S]
//
// With a phase, each of its scenes plays in turn; with a number, that one
// scene; "all" (the default) plays every scene. --source keeps to scenes
// from one model ("codex" or "claude" match by prefix). Each plays for N seconds
// (default 12). Ctrl-C stops. The concept of each scene is printed above it.

import { CLEAR } from '../hooks/effects'
import { PHASES, type Phase } from '../hooks/library'
import { SCENES } from '../hooks/scenes'
import { cleanScript, stage } from '../hooks/script'

const args = process.argv.slice(2)
const pick = args.find(a => !a.startsWith('--')) ?? 'all'
const secondsAt = args.indexOf('--seconds')
const seconds = secondsAt >= 0 ? Number(args[secondsAt + 1] ?? 12) : 12
const sourceAt = args.indexOf('--source')
const from = sourceAt >= 0 ? (args[sourceAt + 1] ?? '') : ''
const pool = SCENES.filter(s => s.source.startsWith(from))
const chosen = /^\d+$/.test(pick) ? [SCENES[Number(pick)]].filter(Boolean) : pick === 'all' ? pool : pool.filter(s => s.phase === pick)
if (chosen.length === 0) {
  console.log(`nothing to play; phases: ${PHASES.join(', ')}; ${SCENES.length} scenes`)
  process.exit(1)
}
const ROWS = 9
const cols = Math.max(20, Math.min(220, (process.stdout.columns ?? 100) - 2))
const decode = (cells: string) => new Uint32Array(Uint8Array.from(atob(cells), c => c.charCodeAt(0)).buffer)
const color = (c: number, isBack: boolean) => (c === CLEAR ? `\x1b[${isBack ? 49 : 39}m` : `\x1b[${isBack ? 48 : 38};2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m`)
const draw = (words: Uint32Array) => {
  const lines: string[] = []
  for (let row = 0; row < ROWS; row++) {
    let line = ''
    let fg = -1
    let bg = -1
    for (let col = 0; col < cols; col++) {
      const at = (row * cols + col) * 3
      const ch = words[at] ?? 0x20
      const f = words[at + 1] ?? CLEAR
      const b = words[at + 2] ?? CLEAR
      if (f !== fg) line += color(f, false)
      if (b !== bg) line += color(b, true)
      fg = f
      bg = b
      line += String.fromCodePoint(ch || 0x20)
    }
    lines.push(`${line}\x1b[0m`)
  }

  return lines.join('\n')
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

process.stdout.write('\x1b[?25l')
process.on('SIGINT', () => {
  process.stdout.write('\x1b[?25h\n')
  process.exit(0)
})
for (const stock of chosen) {
  const index = SCENES.indexOf(stock)
  const raw = JSON.parse(JSON.stringify(stock.scene).split('{what}').join('auth.ts')) as unknown
  const script = cleanScript(raw)
  if (!script) continue
  process.stdout.write(`\x1b[2J\x1b[H\x1b[1m#${index} ${stock.phase as Phase} · ${stock.world} · ${stock.style} · ${stock.source}\x1b[0m\n${stock.concept}\n\n`)
  const began = Date.now()
  while (Date.now() - began < seconds * 1000) {
    const since = Date.now() - began
    const cells = stage({ cols, rows: ROWS, t: since / 1000, script, since, reveal: 1 })
    process.stdout.write(`\x1b[4H${draw(decode(cells))}`)
    if (script.code?.error) {
      process.stdout.write(`\n\x1b[31m${script.code.error}\x1b[0m`)
      await sleep(1500)
      break
    }
    await sleep(50)
  }
}
process.stdout.write('\x1b[?25h\n')
