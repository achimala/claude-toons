// A library of ready-made scenes, one for each kind of thing Claude does,
// dealt for free while the work is routine, so the director is asked only
// when something worth a new picture happens.

import { SCENES, type Stock } from './scenes'

export const PHASES = ['thinking', 'searching', 'reading', 'editing', 'testing', 'building', 'running', 'git', 'web', 'agents', 'writing'] as const
export type Phase = (typeof PHASES)[number]
export const isPhase = (v: unknown): v is Phase => PHASES.includes(v as Phase)

// What a scene of each phase is about, for whoever generates one.
export const ABOUT: Record<Phase, string> = {
  thinking: 'Claude is thinking: working out what to do next, weighing options, puzzling over a problem',
  searching: 'Claude is searching the codebase: grepping for a pattern, globbing for files, hunting for where something is defined',
  reading: 'Claude is reading code: going through files to understand how they work',
  editing: 'Claude is editing code: writing and changing files, making the fix',
  testing: 'Claude is running the tests and waiting to see if they pass',
  building: 'Claude is building or installing: a compile, a bundle, a package install that takes a while',
  running: 'Claude is running a command in the shell and waiting for it',
  git: 'Claude is working with git: committing, branching, looking at history or a diff',
  web: 'Claude is fetching a web page or searching the web for an answer',
  agents: 'Claude has sent out subagents to work on parts of the task in parallel and is waiting for them',
  writing: 'Claude is writing its reply to the developer, the work done',
}

// The phase a line of the log belongs to, if it names one: a tool starting,
// or the spinner turning to thinking or writing.
export function phaseOf(line: string): Phase | undefined {
  if (/\[Claude is thinking\]/.test(line)) return 'thinking'
  if (/\[Claude is writing the reply\]/.test(line)) return 'writing'
  const m = /-> started (\w+)(?: `([^`]*)`)?/.exec(line)
  if (!m) return undefined
  const tool = m[1] ?? ''
  const args = m[2] ?? ''
  if (/^(Read|NotebookRead)$/.test(tool)) return 'reading'
  if (/^(Grep|Glob|LS|Explore)$/.test(tool)) return 'searching'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'editing'
  if (/^(WebFetch|WebSearch)$/.test(tool) || /^mcp__/.test(tool)) return 'web'
  if (/^(Agent|Task|Workflow)$/.test(tool)) return 'agents'
  if (tool === 'Bash') {
    if (/\b(test|tests|jest|vitest|pytest|mocha|spec|rspec|go test|cargo test)\b/.test(args)) return 'testing'
    if (/\b(build|tsc|make|cargo (build|check)|compile|webpack|vite|bundle|install|npm ci|yarn|pnpm|pip|poetry|gradle|mvn|xcodebuild)\b/.test(args)) return 'building'
    if (/\b(git|gh)\b/.test(args)) return 'git'

    return 'running'
  }

  return undefined
}

// How long a scene keeps the strip before a stock scene may replace it: at
// least DWELL_MS (a fresh scene from the director, LIVE_DWELL_MS, since it
// was paid for and is about this moment), then when the work turns to a new
// phase, or after STOCK_MS in any case. A scene whose code broke goes at once.
export const DWELL_MS = 20_000
export const LIVE_DWELL_MS = 45_000
export const STOCK_MS = 60_000

export function isStockDue(scene: { age: number; isBroken: boolean; isLive: boolean; isNewPhase: boolean }) {
  if (scene.isBroken) return true
  if (scene.age < (scene.isLive ? LIVE_DWELL_MS : DWELL_MS)) return false

  return scene.isNewPhase || scene.age >= STOCK_MS
}

// Whether a line of the log is news worth a scene of its own from the
// director: the task, a failure, the end of the turn, a scene that broke.
export const isInteresting = (line: string) => /^\[task\] |^\+\d+s <- (failed|denied)|^\[turn finished\]|^\[your last scene's code/.test(line)

// The thing Claude last touched, short enough to label a prop: a file's
// name, or the head of a command.
export function whatOf(line: string): string | undefined {
  const m = /-> started \w+ `([^`|]*)/.exec(line)
  if (!m) return undefined
  const arg = m[1]?.trim() ?? ''
  if (!arg) return undefined
  const name = /^[\w./-]+$/.test(arg) && arg.includes('/') ? arg.slice(arg.lastIndexOf('/') + 1) : arg.split(' ').slice(0, 2).join(' ')

  return name.replace(/["\\]/g, '').slice(0, 20) || undefined
}

export const STYLES = ['3D', 'pixel art', 'text art'] as const
export type Style = (typeof STYLES)[number]

// How a scene is really drawn, by what its code calls: the style it was
// dealt is a request the model may not have honored.
export function styleOf(scene: unknown): Style {
  const code = JSON.stringify(scene)
  if (/\b(camera|mesh3d|clawd3d|line3d)\(/.test(code)) return '3D'
  if (/\bpixels?\(/.test(code)) return 'pixel art'

  return 'text art'
}

// The stock, dealt like cards: each phase has a shuffled deck of its scenes
// in the styles allowed, and a scene comes around again only once the rest
// of its deck has been dealt.
export type Dealer = { styles: readonly string[]; decks: Map<Phase, Stock[]> }

export const createDealer = (styles: readonly string[]): Dealer => ({ styles, decks: new Map() })

// A scene for a phase, as the raw object the director would have answered,
// with "{what}" in it filled in. Nothing when the stock has none for the
// phase in the styles allowed.
export function deal(dealer: Dealer, phase: Phase, what: string | undefined, random: () => number = Math.random): { concept: string; raw: unknown } | undefined {
  let deck = dealer.decks.get(phase)
  if (!deck || deck.length === 0) {
    deck = SCENES.filter(s => s.phase === phase && dealer.styles.includes(s.style)).sort(() => random() - 0.5)
    dealer.decks.set(phase, deck)
  }
  const pick = deck.pop()
  if (!pick) return undefined
  const filled = JSON.stringify(pick.scene).split('{what}').join(JSON.stringify(what ?? 'the code').slice(1, -1))

  return { concept: pick.concept, raw: JSON.parse(filled) }
}

// The brief a generator adds to the director's prompt for one stock scene.
export function brief(phase: Phase, world: string, cols: number) {
  return [
    `[strip ${cols}x9]`,
    `[task] (unknown: this is a ready-made scene)`,
    `This scene goes into a library of ready-made scenes, dealt whenever ${ABOUT[phase]}. No more news will come while it plays, for a minute or two, so it has to tell its own story: something happens, and keeps happening, in this world, about this kind of work. Clawd has a voice here; what it says and when is yours. The real file or command is not known: write {what} wherever a label or a line would name it, and it is filled in when the scene is dealt (up to 20 characters).`,
    `[world: ${world}]`,
  ].join('\n')
}
