import { test, expect, mock } from 'claude-code/testing'

import { createThread } from './narrator'
import { cleanScript, compile, stage } from './script'

test('the spinner keeps the engine line and draws the buddy under it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>Sauteing…</Text>
  })
  const ui = await $.ui.mount({
    plugin: 'spinner-oracle',
    surface: 'terminal',
    component: 'Spinner',
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
  })
  expect(await ui.find({ type: 'Text', text: /Sauteing/ })).toBeDefined()
  expect(await ui.find({ key: 'oracle' })).toBeDefined()
  await ui.unmount()
})

test('expressions do arithmetic and functions, and nothing else', async () => {
  const env = { t: 2, w: 100, h: 8, k: 3, n: 10 }
  expect(compile('mod(t*8, w+20) - 20')(env)).toBe(-4)
  expect(compile('2^3 + -1')(env)).toBe(7)
  expect(compile('max(1, k, 2) * 10 % 7')(env)).toBe(2)
  expect(compile('constructor')(env)).toBe(0)
  expect(compile('alert(1)')(env)).toBe(0)
  expect(compile('1/0')(env)).toBe(0)
  expect(compile('(1 + 2')(env)).toBe(0)
})

test('a script from the model is cleaned into one the raster can draw', async () => {
  const script = cleanScript({
    background: { effect: 'lava', palette: ['#300', 'nope', '#f40'], speed: 9, intensity: 0.5 },
    actors: [
      { kind: 'sprite', frames: ['(o_o) 🔥', '(^_^)'], fps: 2, x: 't*3', y: '2', color: '#fc0', say: 'tests are green — finally', sayAt: 0.5 },
      { kind: 'clawd', frames: [], fps: 0, x: 't*5', y: '3', color: '#d97757', say: '', sayAt: 0 },
    ],
    particles: [{ glyphs: '~*', count: 999, x: 'rand(k)*w', y: 'k', color: '#0f0' }],
  })
  expect(script?.background.speed).toBe(4)
  expect(script?.actors[0]?.frames[0]).toEqual(['(o_o)  '])
  expect(script?.actors[1]?.kind).toBe('clawd')
  expect(script?.actors[0]?.say).toBe('tests are green - finally')
  expect(script?.swarms[0]?.count).toBe(120)
  expect(cleanScript({ background: { effect: 'teleport', palette: ['#000', '#fff'] } })).toBeUndefined()
})

test('a scene renders a full frame at every point of its life', async () => {
  const script = cleanScript({
    background: { effect: 'fireworks', palette: ['#d97757', '#fff'], speed: 1, intensity: 1 },
    actors: [
      { kind: 'sprite', frames: ['[^_^]'], fps: 0, x: 'w-3', y: '-2', color: '#fff', say: 'way off the edge', sayAt: 0 },
      { kind: 'clawd', frames: [], fps: 0, x: 'mod(t*9, w)', y: '4', color: '#d97757', say: 'walking and talking at once', sayAt: 0 },
    ],
    particles: [],
  })
  for (const since of [0, 300, 900, 5000]) {
    const cells = script && stage({ cols: 30, rows: 8, t: 12.3, script, since, reveal: since / 1000 })
    expect(cells?.length).toBe(30 * 8 * 16)
    expect(script?.actors[1]?.kind).toBe('clawd')
  }
})

test('the thread is one append-only conversation, cached and on Sonnet 5.5', async () => {
  const thread = createThread('claude-sonnet-5-5')
  const scene = { background: { effect: 'rain', palette: ['#0a0', '#0f0'], speed: 1, intensity: 0.5 }, actors: [{ kind: 'clawd', frames: [], fps: 0, x: '3', y: '3', color: '#d97757', say: 'reading', sayAt: 0 }], particles: [] }
  const reply = JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(scene) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 60, output_tokens: 50 },
  })
  thread.ask('[task] fix the login bug')
  const first = JSON.parse(thread.request('bearer').body)
  expect(first.model).toBe('claude-sonnet-5-5')
  expect(first.cache_control).toEqual({ type: 'ephemeral' })
  expect(first.system[0].text).toContain('You are Claude Code')
  expect(first.system[1].cache_control).toEqual({ type: 'ephemeral' })
  expect(thread.accept(reply).script?.actors[0]?.say).toBe('reading')
  thread.ask('+4s Read src/auth.ts')
  const second = JSON.parse(thread.request('bearer').body)
  expect(second.messages.length).toBe(3)
  expect(second.messages.slice(0, 2)).toEqual(first.messages.concat([{ role: 'assistant', content: JSON.parse(reply).content }]))
  expect(thread.isFallbackRefused(400, 'fallbacks: not supported')).toBe(true)
  expect(JSON.parse(thread.request('api-key').body).fallbacks).toBeUndefined()
  expect(thread.abandon()).toBe('+4s Read src/auth.ts')
})

test('new work gets a fresh world and the recent concepts; a quiet beat continues', async () => {
  const thread = createThread('claude-sonnet-5-5')
  const answer = (concept: string) =>
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ concept, background: { effect: 'rain', palette: ['#0a0', '#0f0'], speed: 1, intensity: 0.5 }, actors: [], particles: [] }) }],
      stop_reason: 'end_turn',
    })
  thread.ask('[strip 80x9]\n[task] find bugs', () => 0.3)
  const first = JSON.parse(thread.request('bearer').body).messages[0].content as string
  expect(first).toMatch(/\n\[world: .+\]$/)
  expect(first).not.toContain('[recent scenes')
  thread.accept(answer('deep sea: Clawd in a bathysphere'))
  thread.ask('[strip 80x9]\n+3s -> started Read `src/a.ts`')
  const second = JSON.parse(thread.request('bearer').body).messages[2].content as string
  expect(second).toContain('[recent scenes: deep sea: Clawd in a bathysphere]')
  expect(second.match(/\[world: (.+)\]/)?.[1]).not.toBe(first.match(/\[world: (.+)\]/)?.[1])
  expect(thread.abandon()).toBe('[strip 80x9]\n+3s -> started Read `src/a.ts`')
  thread.ask('[strip 80x9]\n+20s still running Bash `npm test` (12s so far)')
  const quiet = JSON.parse(thread.request('bearer').body).messages[2].content as string
  expect(quiet).toContain('[continue: deep sea: Clawd in a bathysphere]')
  expect(quiet).not.toContain('[world:')
})

test('actors can come and go with show, and pick their frame by expression', async () => {
  const script = cleanScript({
    background: { effect: 'starfield', palette: ['#fff', '#88f'], speed: 1, intensity: 0 },
    actors: [{ kind: 'sprite', frames: ['A', 'B', 'C'], fps: 0, frame: 'floor(t)', show: 'between(t, 1, 3)', x: '0', y: '0', color: '#fff', say: '', sayAt: 0 }],
    particles: [],
  })
  expect(compile('smoothstep(0, 2, 1)')({ t: 0, w: 0, h: 0, k: 0, n: 0 })).toBe(0.5)
  const glyphAt = (since: number) => {
    const cells = script && stage({ cols: 4, rows: 2, t: 0, script, since, reveal: 1 })
    const words = new Uint32Array(Uint8Array.from(atob(cells ?? ''), c => c.charCodeAt(0)).buffer)

    return String.fromCodePoint(words[0] ?? 0x20)
  }
  expect(glyphAt(500)).toBe(' ')
  expect(glyphAt(1500)).toBe('B')
  expect(glyphAt(2500)).toBe('C')
  expect(glyphAt(3500)).toBe(' ')
})

test('a long session cuts the thread back but keeps the task, and survives a garbled reply', async () => {
  const thread = createThread('claude-sonnet-5-5')
  const reply = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ concept: 'c', code: '', background: { effect: 'rain', palette: ['#0a0', '#0f0'], speed: 1, intensity: 0.5 }, actors: [], particles: [] }) }], stop_reason: 'end_turn' })
  thread.ask('[strip 80x9]\n[task] hunt the bugs')
  thread.accept(reply)
  for (let i = 0; i < 40; i++) {
    thread.ask(`[strip 80x9]\n+${i}s -> started Read \`f${i}.ts\``)
    thread.accept(reply)
  }
  const messages = JSON.parse(thread.request('bearer').body).messages as { role: string; content: unknown }[]
  expect(messages.length).toBeLessThan(60)
  expect(messages[0]?.role).toBe('user')
  expect(String(messages[0]?.content)).toContain('[task] hunt the bugs')
  thread.ask('[strip 80x9]\n+50s -> started Grep `TODO`')
  const before = JSON.parse(thread.request('bearer').body).messages.length
  expect(thread.accept('<html>bad gateway</html>').error).toBeDefined()
  expect(JSON.parse(thread.request('bearer').body).messages.length).toBe(before - 1)
})
