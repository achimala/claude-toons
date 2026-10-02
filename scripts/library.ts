// Fills the stock of ready-made scenes (hooks/scenes.ts) by asking a model
// through the Codex CLI for one scene at a time, checking each one draws,
// and keeping the ones that do.
//
//   bun scripts/library.ts [--per N] [--phases a,b] [--style S] [--jobs N] [--model M] [--anthropic]
//
// --per is how many scenes each phase should end up with (default 6); with
// --style (3D, pixel art, text art) it counts and asks for scenes really
// drawn in that style, since a model may not draw in the style it is dealt. The
// model is asked through the Codex CLI (its default model, or --model), or
// with --anthropic through the Anthropic API with ANTHROPIC_API_KEY (the
// director's prompt and settings, on --model or Opus 5.5). --per counts
// scenes from this source only, so stocks from several models can be mixed.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PHASES, STYLES, brief, styleOf, type Phase, type Style } from '../hooks/library'
import { SCHEMA, STYLE_SETS, SYSTEM, URL as API, WORLDS, createThread } from '../hooks/narrator'
import { isModel } from '../hooks/cost'
import { SCENES, type Stock } from '../hooks/scenes'
import { cleanScript, stage } from '../hooks/script'

const args = process.argv.slice(2)
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)

  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
const per = Number(opt('per', '6'))
const jobs = Number(opt('jobs', '4'))
const isAnthropic = args.includes('--anthropic')
const model = opt('model', isAnthropic ? 'claude-opus-5-5' : '')
const source = isAnthropic ? model : `codex:${model || 'default'}`
const style = opt('style', '')
if (style && !(STYLES as readonly string[]).includes(style)) throw new Error(`style must be one of ${STYLES.join(', ')}`)
const phases = opt('phases', PHASES.join(',')).split(',').filter((p): p is Phase => (PHASES as readonly string[]).includes(p))
const OUT = new URL('../hooks/scenes.ts', import.meta.url).pathname

// Whether a raw scene draws without error for a couple of minutes, at two
// widths, with the placeholder filled.
function check(raw: unknown): string | undefined {
  const filled = JSON.parse(JSON.stringify(raw).split('{what}').join('auth.ts')) as unknown
  for (const cols of [80, 140]) {
    const script = cleanScript(filled)
    if (!script) return 'not a scene'
    if (!script.code && script.actors.length === 0) return 'nothing to draw'
    for (const since of [0, 100, 500, 1000, 5000, 30_000, 90_000, 150_000]) {
      stage({ cols, rows: 9, t: since / 1000, script, since, reveal: 1 })
      if (script.code?.error) return `code stopped at ${since / 1000}s: ${script.code.error}`
    }
  }

  return undefined
}

// One scene from the Anthropic API, as the plugin itself would ask for it.
async function askAnthropic(phase: Phase, world: string, style: string): Promise<unknown | string> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return 'ANTHROPIC_API_KEY is not set'
  if (!isModel(model)) return `${model} is not a director model`
  const thread = createThread(model, { styles: 'mix' })
  thread.ask(brief(phase, world, style, 120))
  const { headers, body } = thread.request('api-key')
  const response = await fetch(API, { method: 'POST', headers: { ...headers, 'x-api-key': key }, body })
  if (!response.ok) return `API ${response.status}: ${(await response.text()).slice(0, 200)}`
  const reply = (await response.json()) as { content?: { type: string; text?: string }[]; usage?: Record<string, number> }
  const u = reply.usage ?? {}
  console.log(`  usage: in ${u.input_tokens ?? 0}, cached ${u.cache_read_input_tokens ?? 0}, written ${u.cache_creation_input_tokens ?? 0}, out ${u.output_tokens ?? 0}`)
  const text = reply.content?.find(b => b.type === 'text')?.text
  try {
    return JSON.parse(text ?? '')
  } catch {
    return 'no JSON answer'
  }
}

async function generate(phase: Phase, world: string, style: string): Promise<Stock | string> {
  const raw = isAnthropic ? await askAnthropic(phase, world, style) : await askCodex(phase, world, style)
  if (typeof raw === 'string') return raw
  const trouble = check(raw)
  if (trouble) return trouble
  const concept = (raw as { concept?: unknown }).concept
  if (typeof concept !== 'string' || !concept.trim()) return 'no concept'
  if (!JSON.stringify(raw).includes('function frame')) return 'no code: would run out of motion'
  if (!/say\(/.test(JSON.stringify(raw))) return 'Clawd says nothing'
  // A newline escaped twice draws as a literal backslash-n.
  if (JSON.stringify(raw).includes('\\\\\\\\n')) return 'a newline escaped twice'

  const drawn = styleOf(raw)
  if (style && drawn !== style) return `drawn as ${drawn}, not ${style}`

  return { phase, world, style: drawn, concept: concept.trim().slice(0, 140), source, scene: raw }
}

async function askCodex(phase: Phase, world: string, style: string): Promise<unknown | string> {
  const dir = await mkdtemp(join(tmpdir(), 'toons-'))
  try {
    const schemaPath = join(dir, 'schema.json')
    const outPath = join(dir, 'out.json')
    await writeFile(schemaPath, JSON.stringify(SCHEMA))
    const prompt = `${SYSTEM}\n\n---\n\nThe message from the plugin follows. Answer with the scene as JSON only.\n\n${brief(phase, world, style, 120)}`
    const flags = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, '--output-schema', schemaPath, '-o', outPath, ...(model ? ['-m', model] : []), '-']
    const code = await new Promise<number>(resolve => {
      const child = spawn('codex', flags, { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('close', resolve)
      child.on('error', () => resolve(-1))
      child.stdin.end(prompt)
    })
    if (code !== 0) return `codex exited ${code}`
    try {
      return JSON.parse(await readFile(outPath, 'utf8')) as unknown
    } catch {
      return 'no JSON answer'
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function save(stock: Stock[]) {
  const body = stock.map(s => `  ${JSON.stringify(s)},`).join('\n')
  await writeFile(
    OUT,
    `// The stock of ready-made scenes, written by scripts/library.ts. Do not edit
// by hand: run the script to add scenes.

import type { Phase } from './library'

export type Stock = { phase: Phase; world: string; style: string; concept: string; source: string; scene: unknown }

export const SCENES: Stock[] = [
${body}
]
`,
  )
}

const stock = [...SCENES]
const wanted: Phase[] = []
for (const phase of phases) for (let n = stock.filter(s => s.phase === phase && s.source === source && (!style || s.style === style)).length; n < per; n++) wanted.push(phase)
console.log(`${stock.length} in stock; ${wanted.length} to make from ${source}, ${jobs} at a time`)
const styles = STYLE_SETS.mix
let made = 0
let failed = 0
const worker = async (most = Infinity) => {
  for (let n = 0; n < most; n++) {
    const phase = wanted.shift()
    if (!phase) return
    const used = stock.filter(s => s.phase === phase).map(s => s.world)
    const open = WORLDS.filter(w => !used.includes(w))
    const world = (open.length > 0 ? open : WORLDS)[Math.floor(Math.random() * (open.length > 0 ? open : WORLDS).length)] as string
    const dealt = (style || styles[Math.floor(Math.random() * styles.length)]) as Style
    const got = await generate(phase, world, dealt)
    if (typeof got === 'string') {
      failed += 1
      console.log(`  ${phase} / ${world} / ${dealt}: ${got}`)
      // One more try for this phase, with another world and style.
      if (failed <= wanted.length + 20) wanted.push(phase)
      continue
    }
    stock.push(got)
    made += 1
    console.log(`+ ${phase} / ${world} / ${got.style}: ${got.concept}`)
    await save(stock)
  }
}
// The first scene goes alone, so the prompt is in the cache before the rest
// fan out and read it.
await worker(1)
await Promise.all(Array.from({ length: jobs }, () => worker()))
console.log(`made ${made}, failed ${failed}; ${stock.length} in stock`)
