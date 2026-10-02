import { test, expect } from 'claude-code/testing'

import { createThread } from './narrator'

const scene = (concept: string) =>
  JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ concept, code: 'function frame() {}', background: { effect: 'rain', palette: ['#0a0', '#0f0'], speed: 1, intensity: 0.5 }, actors: [], particles: [] }) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
  })

test('older scenes collapse to their concept lines, a batch at a time, the latest kept whole', () => {
  const thread = createThread('claude-sonnet-5-5')
  const replies = () => (JSON.parse(thread.request('bearer').body).messages as { role: string; content: { text: string }[] }[]).filter(m => m.role === 'assistant')
  for (let i = 0; i < 11; i++) {
    thread.ask(`[strip 80x9]\n+${i}s -> started Read \`f${i}.ts\``)
    thread.accept(scene(`scene ${i}`))
  }
  // Eleven whole replies: not yet a full batch behind the last six.
  expect(replies().every(m => m.content[0]?.text.includes('function frame'))).toBe(true)
  thread.ask('[strip 80x9]\n+12s -> started Read `g.ts`')
  thread.accept(scene('scene 11'))
  const after = replies()
  expect(after.length).toBe(12)
  // The oldest six are concept lines now; the last six are whole.
  expect(after.slice(0, 6).every(m => !m.content[0]?.text.includes('function frame') && m.content[0]?.text.includes('scene '))).toBe(true)
  expect(after.slice(6).every(m => m.content[0]?.text.includes('function frame'))).toBe(true)
  expect(after[0]?.content[0]?.text).toContain('scene 0')
  // Nothing more collapses until another batch has piled up.
  thread.ask('[strip 80x9]\n+13s -> started Read `h.ts`')
  thread.accept(scene('scene 12'))
  expect(replies().filter(m => m.content[0]?.text.includes('function frame')).length).toBe(7)
})

test('the director skips thinking on Sonnet unless asked, and never on the models that cannot', () => {
  const body = (model: 'claude-haiku-4-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5', isThinking?: boolean) => {
    const thread = createThread(model, { isThinking })
    thread.ask('[task] x')

    return JSON.parse(thread.request('bearer').body) as { thinking?: { type: string }; output_config: { effort?: string } }
  }
  expect(body('claude-sonnet-5-5').thinking).toEqual({ type: 'between_tools' })
  expect(body('claude-sonnet-5-5', true).thinking).toBeUndefined()
  expect(body('claude-opus-5-5').thinking).toBeUndefined()
  expect(body('claude-haiku-4-5').thinking).toBeUndefined()
  expect(body('claude-haiku-4-5').output_config.effort).toBeUndefined()
})

test('a "still running" beat invites a continue reply, which keeps the scene', () => {
  const thread = createThread('claude-sonnet-5-5')
  thread.ask('[strip 80x9]\n[task] run the tests')
  thread.accept(scene('a siege'))
  thread.ask('[strip 80x9]\n+30s still running Bash `npm test` (30s so far)')
  const asked = JSON.parse(thread.request('bearer').body).messages.at(-1).content as string
  expect(asked).toContain('[playing: a siege; answer continue: true')
  const told = thread.accept(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ continue: true, concept: '', code: '', actors: [], particles: [], background: { effect: 'rain', palette: ['#0a0', '#0f0'], speed: 1, intensity: 0 } }) }], stop_reason: 'end_turn', usage: { output_tokens: 40 } }))
  expect(told.isContinued).toBe(true)
  expect(told.script).toBeUndefined()
  expect(told.spent?.output).toBe(40)
  // A continue reply adds no concept to the list of recent scenes.
  thread.ask('[strip 80x9]\n+40s -> started Read `a.ts`')
  expect(JSON.parse(thread.request('bearer').body).messages.at(-1).content).toContain('[recent scenes: a siege]')
})

test('the styles setting decides which style a new scene is dealt', () => {
  const dealt = (styles: 'mix' | '3D' | 'no 3D') => {
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const thread = createThread('claude-sonnet-5-5', { styles })
      thread.ask('[strip 80x9]\n[task] x', () => (i % 40) / 40)
      const content = JSON.parse(thread.request('bearer').body).messages[0].content as string
      seen.add(/\[style: ([^\]]+)\]/.exec(content)?.[1] ?? '')
    }

    return [...seen].sort()
  }
  expect(dealt('3D')).toEqual(['3D'])
  expect(dealt('no 3D')).toEqual(['pixel art', 'text art'])
  expect(dealt('mix')).toEqual(['3D', 'pixel art', 'text art'])
})

test('a quiet beat after a scene whose code broke asks for a new scene, not a continue', () => {
  const thread = createThread('claude-sonnet-5-5')
  thread.ask('[strip 80x9]\n[task] x')
  thread.accept(scene('a broken one'))
  thread.ask("[strip 80x9]\n[your last scene's code stopped: nope is not defined]\n+30s still running Bash `npm test` (30s so far)")
  const asked = JSON.parse(thread.request('bearer').body).messages.at(-1).content as string
  expect(asked).toContain('[world: ')
  expect(asked.includes('[playing: ')).toBe(false)
})
