import type { Register } from 'claude-code'

import { URL, createThread, type Narration } from './narrator'
import { cleanScript, stage, type Script } from './script'

const ROWS = 9
// The least time between two scenes: the next is asked for as soon as the
// last one lands, if anything has happened since.
const GAP_MS = 1500
// How long the band takes to rise to its full height when the spinner shows.
const GROW_MS = 700
// How long the log may stay quiet mid-turn before a "still going" line.
const QUIET_MS = 10_000

// Where each request's credential and status are written, outside the mod's
// folder so writing it never reloads the mod.
const LEDGER = '/tmp/spinner-buddy-auth.log'

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

export const register: Register = on => {
  const thread = createThread()
  let pending: string[] = []
  let startedAt = 0
  let lastCall = 0
  let isTurn = false
  let isAsking = false
  let isAnimating = false
  let error: string | undefined
  let scene = FIRST
  let previous: Script | undefined
  let sceneAt = 0
  let spinner: string | undefined
  let cols = 60
  // When the spinner showed, and the rows the band was last drawn with.
  let shownAt = 0
  let drawnRows = 1
  const grown = (at: number) => clamp01((at - shownAt) / GROW_MS)
  const rowsAt = (at: number) => Math.max(1, Math.ceil(ROWS * (1 - Math.pow(1 - grown(at), 3))))
  const frameAt = (at: number, rows: number) =>
    stage({
      cols,
      rows,
      t: at / 1000,
      script: scene,
      previous,
      since: at - sceneAt,
      reveal: clamp01((at - shownAt) / (GROW_MS * 1.6)),
    })
  // Whether ANTHROPIC_API_KEY has stood in for the login yet (for one toast),
  // and the recent requests' credentials, written to LEDGER.
  let usedKey = false
  // What is under way: tool calls running now, with when each began, and the
  // spinner's last phase, for the log's start, finish and "still" lines.
  const running = new Map<number, { what: string; at: number }>()
  let callCount = 0
  let phase = ''
  let phaseAt = 0
  let loggedAt = 0
  const stamp = (at: number) => `+${Math.round((at - startedAt) / 1000)}s`
  const note = (at: number, line: string) => {
    pending.push(`${stamp(at)} ${line}`)
    loggedAt = at
  }
  let ledger: string[] = []
  // No request before this time: a rate limit's or a failure's wait, and how
  // many requests in a row have failed.
  let calmUntil = 0
  let failures = 0

  on('prompt.submit', async ($, e, next) => {
    startedAt = await $.clock.now()
    pending.push(`[task] ${e.text.replace(/\s+/g, ' ').slice(0, 400)}`)
    loggedAt = startedAt
    phase = ''
    running.clear()
    isTurn = true
    // Asks for a scene as soon as there is news, then at most every GAP_MS.
    void (async () => {
      if (isAsking) return
      isAsking = true
      while (isTurn) {
        const now = await $.clock.now()
        // A quiet stretch mid-turn is news too: what is still going on.
        if (pending.length === 0 && now - loggedAt >= QUIET_MS && now - lastCall >= QUIET_MS) {
          const oldest = [...running.values()].sort((a, b) => a.at - b.at)[0]
          if (oldest) note(now, `still running ${oldest.what} (${Math.round((now - oldest.at) / 1000)}s so far)`)
          else if (phase) note(now, `still ${phase} (${Math.round((now - phaseAt) / 1000)}s so far)`)
          else loggedAt = now
        }
        if (pending.length > 0 && now - lastCall >= GAP_MS && now >= calmUntil) {
          lastCall = now
          // A scene whose code broke is news for the narrator, once.
          const broken = scene.code?.error && !scene.code.isReported ? scene.code : undefined
          if (broken) broken.isReported = true
          const activity = [...(broken ? [`[your last scene's code stopped: ${broken.error?.slice(0, 200)}]`] : []), ...pending].join('\n')
          pending = []
          thread.ask(`[strip ${cols}x${ROWS}]\n${activity}`)
          let told: Narration
          // The session's own login first, every time: on a subscription that
          // is what the call bills. ANTHROPIC_API_KEY stands in only when the
          // login refuses direct calls outright (401 or 403), never for a rate
          // limit, which is waited out on the login.
          const auth = await $.session.authorize()
          const usage = await $.session.usage()
          const plan = usage.rateLimits.length > 0 ? 'subscription' : 'no subscription windows'
          let via = auth ? (auth.kind === 'bearer' ? 'session login (OAuth)' : 'session API key') : 'none'
          let response: { ok: boolean; status: number; text: string; headers: Record<string, string> } | undefined
          if (auth) {
            response = await $.http.fetch(URL, { method: 'POST', auth: auth.handle, ...thread.request(auth.kind) })
            if (thread.isFallbackRefused(response.status, response.text)) {
              response = await $.http.fetch(URL, { method: 'POST', auth: auth.handle, ...thread.request(auth.kind) })
            }
          }
          if (!response || response.status === 401 || response.status === 403) {
            const refused = response ? `${response.status} ${response.text.replace(/\s+/g, ' ').slice(0, 200)}` : 'no login'
            const key = await $.env.get('ANTHROPIC_API_KEY')
            if (key) {
              if (!usedKey) $.ui.toast('spinner buddy: your login refused the call, so it is using ANTHROPIC_API_KEY')
              usedKey = true
              via = `ANTHROPIC_API_KEY (login refused: ${refused})`
              const sent = thread.request('api-key')
              response = await $.http.fetch(URL, { method: 'POST', body: sent.body, headers: { ...sent.headers, 'x-api-key': key } })
            }
          }
          if (!response) {
            thread.abandon()
            told = { error: 'no Anthropic credential in this session' }
          } else if (response.ok) {
            failures = 0
            told = thread.accept(response.text)
          } else {
            pending.unshift(thread.abandon().replace(/^\[strip [^\]]*\]\n/, ''))
            // A rate limit waits as long as it asks; any other failure waits a
            // little longer each time it repeats, instead of retrying every
            // GAP_MS.
            failures += 1
            const wait = response.status === 429 ? Number(response.headers['retry-after'] ?? 20) : Math.min(120, 5 * 2 ** (failures - 1))
            calmUntil = (await $.clock.now()) + Math.max(5, Math.min(120, wait || 20)) * 1000
            told = { error: `API ${response.status}: ${response.text.replace(/\s+/g, ' ').slice(0, 140)}` }
          }
          // Which credential paid for each request, for the developer to check.
          const read = response?.ok ? /"cache_read_input_tokens":\s*(\d+)/.exec(response.text)?.[1] ?? 0 : 0
          const stamp = new Date(await $.clock.now()).toISOString()
          ledger = [...ledger, `${stamp} plan=${plan} via=${via} status=${response?.status ?? '-'} cacheRead=${read}${told.error ? ` error=${told.error}` : ''}`].slice(-60)
          await $.fs.write(LEDGER, `${ledger.join('\n')}\n`).catch(() => {})
          if (told.script) {
            previous = scene
            scene = told.script
            sceneAt = await $.clock.now()
            error = undefined
          } else {
            // A new kind of trouble is worth one toast; the same again is not.
            if (told.error && told.error !== error) $.ui.toast(`spinner buddy: ${told.error}`)
            error = told.error
          }
          $.ui.invalidate('ui.render')
        }
        await $.clock.sleep(400)
      }
      isAsking = false
    })().catch(() => {
      // The module unloaded mid-wait (a reload): the next load asks afresh.
      isAsking = false
    })

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const what = `${e.tool}${describe(e as unknown as Record<string, unknown>)}`
    const id = (callCount += 1)
    const began = await $.clock.now()
    if (isTurn) {
      running.set(id, { what, at: began })
      note(began, `-> started ${what}`)
    }
    const ran = await next(e)
    running.delete(id)
    if (isTurn) {
      const at = await $.clock.now()
      const took = Math.round((at - began) / 1000)
      const how = ran.deny !== undefined ? 'denied' : ran.isError ? `failed: ${(ran.text ?? '').replace(/\s+/g, ' ').slice(0, 120)}` : 'done'
      note(at, `<- ${how} after ${took}s: ${what}`)
    }

    return ran
  })

  on('turn.complete', ($, e, next) => {
    isTurn = false
    spinner = undefined
    pending.push('[turn finished]')

    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const spinnerLine = await next(e)
    // The spinner knows when Claude turns to thinking or to writing its reply.
    const nextPhase = e.props.mode === 'thinking' ? 'thinking' : e.props.mode === 'responding' ? 'writing the reply' : ''
    if (isTurn && nextPhase && nextPhase !== phase) {
      const at = await $.clock.now()
      phase = nextPhase
      phaseAt = at
      note(at, `[Claude is ${nextPhase}]`)
    } else if (!nextPhase) {
      phase = ''
    }
    const { Box, Raster } = $.ui.resolve(e)
    const now = await $.clock.now()
    if (spinner !== e.requestId) shownAt = now
    spinner = e.requestId
    // A little narrower than the screen, so the spinner's indent never clips it.
    cols = Math.max(20, Math.min(220, (e.viewport?.columns ?? 80) - 6))
    drawnRows = rowsAt(now)
    const cells = frameAt(now, drawnRows)
    // Paints the scene at about 20 frames a second while the spinner shows,
    // each frame once the last one landed.
    if (!isAnimating) {
      isAnimating = true
      if (sceneAt === 0) sceneAt = now
      void (async () => {
        while (spinner) {
          const at = await $.clock.now()
          // While it grows, each new height is a redraw; frames keep painting
          // at the height drawn until it lands.
          if (rowsAt(at) !== drawnRows) $.ui.invalidate('ui.render')
          const frame = frameAt(at, drawnRows)
          await $.ui.blit({ requestId: spinner, key: 'oracle', cells: frame, columns: cols, rows: drawnRows }).catch(() => {})
          await $.clock.sleep(50)
        }
        isAnimating = false
      })().catch(() => {
        isAnimating = false
      })
    }
    return (
      <Box flexDirection="column">
        {spinnerLine}
        <Raster key="oracle" columns={cols} rows={drawnRows} cells={cells} />
      </Box>
    )
  })
}
