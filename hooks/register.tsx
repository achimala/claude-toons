import type { EngineInterface, Register } from 'claude-code'

import {
  GAP_MS,
  MODELS,
  MODEL_NAMES,
  PACES,
  addTokens,
  costOf,
  emptyStats,
  isModel,
  isPace,
  money,
  spendKey,
  summarizeCost,
  type Model,
  type Pace,
  type Spend,
  type Stats,
  type Window,
} from './cost'
import { URL, createThread, type Narration } from './narrator'
import { cleanScript, stage, type Script } from './script'

const PLUGIN = 'toons'
const ROWS = 9
// How long the band takes to rise to its full height when the spinner shows.
const GROW_MS = 700
// How long the log may stay quiet mid-turn before a "still going" line.
const QUIET_MS = 20_000
// The settings pane, and the slash command that toggles the cartoons or opens it.
const PANE = 'toons'
const COMMAND = 'toons'

// The buddy waking up, until its first scene arrives.
const FIRST = cleanScript({
  background: { effect: 'plasma', palette: ['#5a2416', '#b4532f', '#d97757', '#f5c4a8'], speed: 0.6, intensity: 0.3 },
  actors: [{ kind: 'clawd', frames: [], fps: 0, x: 'max(w*0.45, w - t*14)', y: '3', color: '#d97757', say: '', sayAt: 0 }],
  particles: [{ glyphs: '·∘°', count: 12, x: 'rand(k)*w', y: 'mod(rand(k+3)*h - t*(0.5+rand(k+5)), h)', color: '#d97757' }],
}) as Script

// The arguments worth narrating, per tool, cut to a line.
const ARGS = ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'subagent_type'] as const

function describe(input: Record<string, unknown>) {
  const parts = ARGS.map(key => input[key])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map(v => v.replace(/\s+/g, ' ').slice(0, 100))

  return parts.length > 0 ? ` \`${parts.join(' | ')}\`` : ''
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

// Stats as stored, made safe to add to.
function cleanStats(raw: unknown): Stats {
  const stats = emptyStats()
  if (typeof raw !== 'object' || raw === null) return stats
  const r = raw as { buddy?: Record<string, unknown>; main?: unknown }
  const spend = (v: unknown): Spend | undefined => {
    const s = v as Partial<Spend> | null
    if (!s || typeof s !== 'object' || typeof s.usd !== 'number' || typeof s.scenes !== 'number' || typeof s.activeMs !== 'number') return undefined

    return { usd: s.usd, scenes: s.scenes, activeMs: s.activeMs }
  }
  for (const [key, v] of Object.entries(r.buddy ?? {})) {
    const s = spend(v)
    if (s) stats.buddy[key] = s
  }
  stats.main = spend(r.main) ?? stats.main

  return stats
}

// Everything the buddy keeps for the session.
type Buddy = {
  model: Model
  pace: Pace
  thread: ReturnType<typeof createThread>
  // The log of what happened since the last scene, and when the turn began.
  pending: string[]
  startedAt: number
  lastCall: number
  loggedAt: number
  isTurn: boolean
  isAsking: boolean
  isAnimating: boolean
  // The last trouble toasted, so the same again is not.
  error?: string
  // The scene playing, the one fading out, and when the scene arrived.
  scene: Script
  previous?: Script
  sceneAt: number
  // The spinner being drawn on, its width, when it showed, and the rows the
  // band was last drawn with.
  spinner?: string
  cols: number
  shownAt: number
  drawnRows: number
  // Whether the session's login refused these requests: no more are made.
  isRefused: boolean
  // Tool calls running now with when each began, and the spinner's phase.
  running: Map<number, { what: string; at: number }>
  callCount: number
  phase: string
  phaseAt: number
  // No request before this time: a rate limit's or a failure's wait, and how
  // many requests in a row have failed.
  calmUntil: number
  failures: number
  // Whether the cartoons show (kept across sessions), and what they and
  // Claude's own work have spent, for the settings pane's estimates.
  isShown: boolean
  stats: Stats
  sessionUsd: number
  sessionScenes: number
  isSubscription: boolean
  windows: Window[]
  // The last scene code error reported to the narrator, for the settings pane.
  lastTrouble?: string
  // The turn's start and the session's cost then, and when working time with
  // the cartoons showing was last added up.
  turnAt: number
  turnCostAt: number
  accruedAt: number
}

function createBuddy(model: Model, pace: Pace, isThinking: boolean): Buddy {
  return {
    model,
    pace,
    thread: createThread(model, { isThinking }),
    pending: [],
    startedAt: 0,
    lastCall: 0,
    loggedAt: 0,
    isTurn: false,
    isAsking: false,
    isAnimating: false,
    scene: FIRST,
    sceneAt: 0,
    cols: 60,
    shownAt: 0,
    drawnRows: 1,
    isRefused: false,
    running: new Map(),
    callCount: 0,
    phase: '',
    phaseAt: 0,
    calmUntil: 0,
    failures: 0,
    isShown: true,
    stats: emptyStats(),
    sessionUsd: 0,
    sessionScenes: 0,
    isSubscription: false,
    windows: [],
    turnAt: 0,
    turnCostAt: 0,
    accruedAt: 0,
  }
}

const rowsAt = (b: Buddy, at: number) => {
  const grown = clamp01((at - b.shownAt) / GROW_MS)

  return Math.max(1, Math.ceil(ROWS * (1 - Math.pow(1 - grown, 3))))
}

const frameAt = (b: Buddy, at: number, rows: number) =>
  stage({
    cols: b.cols,
    rows,
    t: at / 1000,
    script: b.scene,
    previous: b.previous,
    since: at - b.sceneAt,
    reveal: clamp01((at - b.shownAt) / (GROW_MS * 1.6)),
  })

const stamp = (b: Buddy, at: number) => `+${Math.round((at - b.startedAt) / 1000)}s`

// Logs a line for the next scene; while the cartoons are hidden nothing is
// logged, so nothing is sent.
function note(b: Buddy, at: number, line: string) {
  if (!b.isShown) return
  b.pending.push(`${stamp(b, at)} ${line}`)
  b.loggedAt = at
}

const bucket = (b: Buddy) => (b.stats.buddy[spendKey(b.model, b.pace)] ??= { usd: 0, scenes: 0, activeMs: 0 })

// Adds up Claude's working time with the cartoons showing.
function accrue(b: Buddy, now: number) {
  if (b.isTurn && b.isShown && b.accruedAt > 0) bucket(b).activeMs += Math.max(0, now - b.accruedAt)
  b.accruedAt = now
}

// One scene request, on the session's own credential and nothing else: on a
// subscription it counts toward the plan's limits, never a separate bill. If
// the login refuses (no credential, 401, 403), the cartoons stop asking for
// the rest of the session rather than looking for another way to pay.
async function requestScene($: EngineInterface, b: Buddy): Promise<Narration> {
  const auth = await $.session.authorize()
  let response: { ok: boolean; status: number; text: string; headers: Record<string, string> } | undefined
  if (auth) {
    response = await $.http.fetch(URL, { method: 'POST', auth: auth.handle, ...b.thread.request(auth.kind) })
    if (b.thread.isFallbackRefused(response.status, response.text)) {
      response = await $.http.fetch(URL, { method: 'POST', auth: auth.handle, ...b.thread.request(auth.kind) })
    }
  }
  if (!response || response.status === 401 || response.status === 403) {
    b.thread.abandon()
    b.isRefused = true

    return { error: "this session's login can't make the requests the cartoons need, so they are off for this session" }
  }
  if (response.ok) {
    b.failures = 0

    return b.thread.accept(response.text)
  }
  b.pending.unshift(b.thread.abandon().replace(/^\[strip [^\]]*\]\n/, ''))
  // A rate limit waits as long as it asks; any other failure waits a little
  // longer each time it repeats.
  b.failures += 1
  const wait = response.status === 429 ? Number(response.headers['retry-after'] ?? 20) : Math.min(120, 5 * 2 ** (b.failures - 1))
  b.calmUntil = (await $.clock.now()) + Math.max(5, Math.min(120, wait || 20)) * 1000

  return { error: `API ${response.status}: ${response.text.replace(/\s+/g, ' ').slice(0, 140)}` }
}

// Asks for a scene whenever there is news, at most once per the pace's gap,
// while a turn runs and the cartoons show.
function ask($: EngineInterface, b: Buddy) {
  if (b.isAsking) return
  b.isAsking = true
  const gapMs = GAP_MS[b.pace]
  void (async () => {
    while (b.isTurn && b.isShown && !b.isRefused) {
      const now = await $.clock.now()
      // A quiet stretch mid-turn is news too: what is still going on. The
      // scene animates on its own, so one such beat per two paces is plenty.
      const quiet = Math.max(QUIET_MS, gapMs * 2)
      if (b.pending.length === 0 && now - b.loggedAt >= quiet && now - b.lastCall >= quiet) {
        const oldest = [...b.running.values()].sort((x, y) => x.at - y.at)[0]
        if (oldest) note(b, now, `still running ${oldest.what} (${Math.round((now - oldest.at) / 1000)}s so far)`)
        else if (b.phase) note(b, now, `still ${b.phase} (${Math.round((now - b.phaseAt) / 1000)}s so far)`)
        else b.loggedAt = now
      }
      if (b.pending.length > 0 && now - b.lastCall >= gapMs && now >= b.calmUntil) {
        b.lastCall = now
        // A scene whose code broke is news for the narrator, once.
        const broken = b.scene.code?.error && !b.scene.code.isReported ? b.scene.code : undefined
        if (broken) {
          broken.isReported = true
          b.lastTrouble = broken.error
        }
        const activity = [...(broken ? [`[your last scene's code stopped: ${broken.error?.slice(0, 200)}]`] : []), ...b.pending].join('\n')
        b.pending = []
        b.thread.ask(`[strip ${b.cols}x${ROWS}]\n${activity}`)
        const told = await requestScene($, b)
        if (told.spent) {
          const usd = costOf(b.model, told.spent)
          const spend = bucket(b)
          spend.usd += usd
          spend.scenes += 1
          addTokens(spend, told.spent)
          b.sessionUsd += usd
          b.sessionScenes += 1
          await $.store.set('stats', b.stats).catch(() => {})
        }
        if (told.script) {
          b.previous = b.scene
          b.scene = told.script
          b.sceneAt = await $.clock.now()
          b.error = undefined
        } else {
          if (told.error && told.error !== b.error) $.ui.toast(`toons: ${told.error}`)
          b.error = told.error
        }
        $.ui.invalidate('ui.render')
      }
      await $.clock.sleep(400)
    }
    b.isAsking = false
  })().catch(() => {
    // The module unloaded mid-wait (a reload): the next load asks afresh.
    b.isAsking = false
  })
}

// Shows or hides the cartoons; hidden, nothing is asked for or drawn.
async function toggle($: EngineInterface, b: Buddy, show: boolean) {
  const now = await $.clock.now()
  accrue(b, now)
  b.isShown = show
  await $.store.set('isShown', show).catch(() => {})
  if (show && b.isTurn) {
    // The narrator missed what happened while hidden: it starts fresh.
    note(b, now, '[the developer switched the cartoons on]')
    ask($, b)
  }
  if (!show) b.pending = []
  $.ui.invalidate('ui.render')
}

// Reads the session's cost and its plan's windows, if it has any.
async function readPlan($: EngineInterface, b: Buddy) {
  const usage = await $.session.usage()
  b.isSubscription = usage.rateLimits.length > 0
  b.windows = usage.rateLimits

  return usage.cost?.usd ?? 0
}

// Changes one of the plugin's settings as /config would; the engine then
// reloads the plugin with it. The row's key is the plugin's name (or its
// name@inline when loaded from a folder), a dot, and the field.
async function setOption($: EngineInterface, field: string, value: string) {
  const rows = await $.config.list()
  const row = rows.find(r => r.key.startsWith(PLUGIN) && r.key.endsWith(`.${field}`))
  const { deny } = await $.config.set({ key: row?.key ?? `${PLUGIN}.${field}`, value })
  if (deny) $.ui.toast(`toons: could not change ${field}: ${deny}`)
}

// Paints the scene at about 20 frames a second while the spinner shows, each
// frame once the last one landed.
function animate($: EngineInterface, b: Buddy) {
  if (b.isAnimating) return
  b.isAnimating = true
  void (async () => {
    while (b.spinner && b.isShown) {
      const at = await $.clock.now()
      // While it grows, each new height is a redraw; frames keep painting at
      // the height drawn until it lands.
      if (rowsAt(b, at) !== b.drawnRows) $.ui.invalidate('ui.render')
      const frame = frameAt(b, at, b.drawnRows)
      await $.ui.blit({ requestId: b.spinner, key: 'oracle', cells: frame, columns: b.cols, rows: b.drawnRows }).catch(() => {})
      await $.clock.sleep(50)
    }
    b.isAnimating = false
  })().catch(() => {
    b.isAnimating = false
  })
}

export const register: Register = (on, options) => {
  const settings = options as Record<string, unknown>
  const b = createBuddy(
    isModel(settings.model) ? settings.model : 'claude-sonnet-5-5',
    isPace(settings.pace) ? settings.pace : 'every 15 seconds',
    settings.thinking === 'on',
  )

  on('session.start', async ($, e, next) => {
    b.isShown = (await $.store.get('isShown')) !== false
    b.stats = cleanStats(await $.store.get('stats'))
    await $.command.register({
      name: COMMAND,
      description: 'Show or hide the cartoons under the spinner; "/toons settings" for the model, pace and cost',
      argumentHint: '[on|off|settings]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'settings') {
      await $.ui.open({ id: PANE, title: 'Toons', focus: true, closeOnEscape: true, rows: 22 })

      return { text: 'Toons settings opened.' }
    }
    await toggle($, b, arg === 'on' ? true : arg === 'off' ? false : !b.isShown)

    return {
      text: b.isShown
        ? `Cartoons on (${MODEL_NAMES[b.model]}, a new scene ${b.pace}). /toons settings shows what they cost.`
        : 'Cartoons off: no scenes are requested or drawn until you turn them back on with /toons.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    b.startedAt = now
    if (b.isShown) b.pending.push(`[task] ${e.text.replace(/\s+/g, ' ').slice(0, 400)}`)
    b.loggedAt = now
    b.phase = ''
    b.running.clear()
    b.isTurn = true
    b.turnAt = now
    b.accruedAt = now
    b.turnCostAt = await readPlan($, b)
    if (b.isShown) ask($, b)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const what = `${e.tool}${describe(e as unknown as Record<string, unknown>)}`
    const id = (b.callCount += 1)
    const began = await $.clock.now()
    if (b.isTurn) {
      b.running.set(id, { what, at: began })
      note(b, began, `-> started ${what}`)
    }
    const ran = await next(e)
    b.running.delete(id)
    if (b.isTurn) {
      const at = await $.clock.now()
      const took = Math.round((at - began) / 1000)
      const how = ran.deny !== undefined ? 'denied' : ran.isError ? `failed: ${(ran.text ?? '').replace(/\s+/g, ' ').slice(0, 120)}` : 'done'
      note(b, at, `<- ${how} after ${took}s: ${what}`)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    accrue(b, now)
    b.isTurn = false
    b.spinner = undefined
    if (b.isShown) b.pending.push('[turn finished]')
    // What Claude's own work cost this turn, against its working time: the
    // yardstick the settings pane measures the cartoons by.
    if (b.turnAt > 0) {
      const cost = await readPlan($, b)
      b.stats.main.usd += Math.max(0, cost - b.turnCostAt)
      b.stats.main.activeMs += now - b.turnAt
      b.stats.main.scenes += 1
      b.turnAt = 0
      await $.store.set('stats', b.stats).catch(() => {})
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await readPlan($, b)
    const cost = summarizeCost({ stats: b.stats, model: b.model, pace: b.pace, windows: b.windows })
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)

      return <Text>Cartoons cost about {money(cost.hour.usd)} per hour of Claude working. Change settings in the terminal.</Text>
    }
    const { Box, Text, Select } = $.ui.resolve(e)
    // A label and its value on one line, the labels in one column.
    const row = (label: string, value: string, note?: string) => (
      <Box flexDirection="row">
        <Box width={18}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text>{value}</Text>
        {note && <Text dimColor>{`  ${note}`}</Text>}
      </Box>
    )
    const heading = (text: string) => (
      <Box marginTop={1}>
        <Text bold color="#d97757">
          {text}
        </Text>
      </Box>
    )
    const cheapest = Math.min(...cost.models.map(m => m.usd))

    return (
      <Box flexDirection="column" paddingX={1}>
        <Select
          key="shown"
          label="Cartoons          "
          options={[{ value: 'shown' }, { value: 'hidden' }]}
          value={b.isShown ? 'shown' : 'hidden'}
          autoFocus
          onSelect={(value: string) => void toggle($, b, value === 'shown')}
        />
        <Select
          key="model"
          label="Director model    "
          options={MODELS.map(m => ({ value: m, label: MODEL_NAMES[m] }))}
          value={b.model}
          onSelect={(value: string) => void setOption($, 'model', value)}
        />
        <Select
          key="pace"
          label="New scene         "
          options={PACES.map(p => ({ value: p }))}
          value={b.pace}
          onSelect={(value: string) => void setOption($, 'pace', value)}
        />
        <Select
          key="thinking"
          label="Director thinks   "
          options={[{ value: 'off', label: 'off (cheaper)' }, { value: 'on' }]}
          value={b.thread.isThinking ? 'on' : 'off'}
          onSelect={(value: string) => void setOption($, 'thinking', value)}
        />
        <Text dimColor>Toggle any time with /toons, even while Claude works</Text>

        {heading('Per hour of Claude working')}
        {row(
          'Cost',
          `~${money(cost.hour.usd)}`,
          cost.hour.measuredMinutes !== undefined ? `measured over ${cost.hour.measuredMinutes} min` : 'estimate',
        )}
        {row('Scenes', `~${Math.round(cost.hour.scenes)}`)}
        {cost.perScene &&
          row(
            'Per scene',
            money(cost.perScene.usd),
            `${Math.round(cost.perScene.outputShare * 100)}% is the scene itself (~${Math.round(cost.perScene.output)} tokens); the rest is the cached history (~${Math.round(cost.perScene.cacheRead / 1000)}k tokens, mostly cache reads)`,
          )}
        {cost.vsClaude
          ? row('vs. Claude itself', `+${cost.vsClaude.percent}% usage`, `like ${cost.vsClaude.minutes} more min of Claude working`)
          : row('vs. Claude itself', 'not measured yet', 'after ~10 min of Claude working')}

        {heading('Each model at this pace')}
        {cost.models.map(m => (
          <Box flexDirection="row">
            <Box width={18}>
              <Text bold={m.model === b.model} dimColor={m.model !== b.model}>
                {m.model === b.model ? `> ${m.name}` : `  ${m.name}`}
              </Text>
            </Box>
            <Text bold={m.model === b.model} dimColor={m.model !== b.model}>{`~${money(m.usd)}/hr`}</Text>
            <Text dimColor>{`  ~${Math.round(m.scenes)} scenes${m.usd === cheapest ? ', cheapest' : ''}`}</Text>
          </Box>
        ))}

        {heading('Usage')}
        {cost.windows.length > 0 && row('Your plan', cost.windows.map(w => `${w.label} ${w.percent}%`).join(' · '))}
        {row('This session', `${b.sessionScenes} scenes · ${money(b.sessionUsd)}`)}
        {b.lastTrouble && row('Last scene error', b.lastTrouble.slice(0, 70), 'sent back to the director to fix')}

        <Box marginTop={1}>
          <Text dimColor>
            {b.isSubscription
              ? "On a subscription this isn't charged separately: it counts toward your plan's usage limits."
              : "Billed to this session's API key."}{' '}
            Hidden or idle: nothing.
          </Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const spinnerLine = await next(e)
    if (!b.isShown) {
      b.spinner = undefined

      return spinnerLine
    }
    const { Box, Raster } = $.ui.resolve(e)
    // The spinner knows when Claude turns to thinking or to writing its reply.
    const nextPhase = e.props.mode === 'thinking' ? 'thinking' : e.props.mode === 'responding' ? 'writing the reply' : ''
    if (b.isTurn && nextPhase && nextPhase !== b.phase) {
      const at = await $.clock.now()
      b.phase = nextPhase
      b.phaseAt = at
      note(b, at, `[Claude is ${nextPhase}]`)
    } else if (!nextPhase) {
      b.phase = ''
    }
    const now = await $.clock.now()
    if (b.spinner !== e.requestId) b.shownAt = now
    b.spinner = e.requestId
    // A little narrower than the screen, so the spinner's indent never clips it.
    b.cols = Math.max(20, Math.min(220, (e.viewport?.columns ?? 80) - 6))
    b.drawnRows = rowsAt(b, now)
    const cells = frameAt(b, now, b.drawnRows)
    if (b.sceneAt === 0) b.sceneAt = now
    animate($, b)

    return (
      <Box flexDirection="column">
        {spinnerLine}
        <Raster key="oracle" columns={b.cols} rows={b.drawnRows} cells={cells} />
      </Box>
    )
  })
}
