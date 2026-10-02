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
  for (let i = 0; i < 15; i++) {
    thread.ask(`[strip 80x9]\n+${i}s -> started Read \`f${i}.ts\``)
    thread.accept(scene(`scene ${i}`))
  }
  // Fifteen whole replies: not yet a full batch behind the last eight.
  expect(replies().every(m => m.content[0]?.text.includes('function frame'))).toBe(true)
  thread.ask('[strip 80x9]\n+16s -> started Read `g.ts`')
  thread.accept(scene('scene 15'))
  const after = replies()
  expect(after.length).toBe(16)
  // The oldest eight are concept lines now; the last eight are whole.
  expect(after.slice(0, 8).every(m => !m.content[0]?.text.includes('function frame') && m.content[0]?.text.includes('scene '))).toBe(true)
  expect(after.slice(8).every(m => m.content[0]?.text.includes('function frame'))).toBe(true)
  expect(after[0]?.content[0]?.text).toContain('scene 0')
  // Nothing more collapses until another batch has piled up.
  thread.ask('[strip 80x9]\n+17s -> started Read `h.ts`')
  thread.accept(scene('scene 16'))
  expect(replies().filter(m => m.content[0]?.text.includes('function frame')).length).toBe(9)
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
