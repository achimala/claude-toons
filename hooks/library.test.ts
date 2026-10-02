import { test, expect } from 'claude-code/testing'

import { PHASES, STYLES, createDealer, deal, isInteresting, phaseOf, styleOf, whatOf } from './library'
import { SCENES } from './scenes'
import { cleanScript, stage } from './script'

test('the log tells what Claude is doing, what it touched, and what is news', () => {
  expect(phaseOf('+3s -> started Read `src/auth.ts`')).toBe('reading')
  expect(phaseOf('+3s -> started Grep `TODO | src`')).toBe('searching')
  expect(phaseOf('+3s -> started Edit `src/auth.ts`')).toBe('editing')
  expect(phaseOf('+3s -> started Bash `npm test`')).toBe('testing')
  expect(phaseOf('+3s -> started Bash `cargo build --release`')).toBe('building')
  expect(phaseOf('+3s -> started Bash `git commit -m x`')).toBe('git')
  expect(phaseOf('+3s -> started Bash `ls -la`')).toBe('running')
  expect(phaseOf('+3s -> started WebFetch `https://x.y`')).toBe('web')
  expect(phaseOf('+3s -> started Agent `look for bugs | Explore`')).toBe('agents')
  expect(phaseOf('+3s [Claude is thinking]')).toBe('thinking')
  expect(phaseOf('+3s [Claude is writing the reply]')).toBe('writing')
  expect(phaseOf('+3s <- done after 2s: Bash `npm test`')).toBeUndefined()
  expect(whatOf('+3s -> started Read `src/auth.ts`')).toBe('auth.ts')
  expect(whatOf('+3s -> started Bash `npm test -- --watch`')).toBe('npm test')
  expect(whatOf('+3s -> started Bash `echo "hi" | cat`')).toBe('echo hi')
  expect(whatOf('+3s -> started Agent')).toBeUndefined()
  expect(isInteresting('[task] fix the build')).toBe(true)
  expect(isInteresting('+9s <- failed: 3 tests failing after 12s: Bash `npm test`')).toBe(true)
  expect(isInteresting('[turn finished]')).toBe(true)
  expect(isInteresting("[your last scene's code stopped: x is not defined]")).toBe(true)
  expect(isInteresting('+9s -> started Read `a.ts`')).toBe(false)
  expect(isInteresting('+9s <- done after 1s: Read `a.ts`')).toBe(false)
})

test('every stock scene draws for minutes without error, with the placeholder filled in', () => {
  expect(SCENES.length).toBeGreaterThan(0)
  for (const stock of SCENES) {
    expect(PHASES).toContain(stock.phase)
    expect(styleOf(stock.scene)).toBe(stock.style)
    const script = cleanScript(JSON.parse(JSON.stringify(stock.scene).split('{what}').join('auth.ts')))
    expect(script).toBeDefined()
    if (!script) continue
    for (const cols of [60, 120]) {
      for (const since of [0, 700, 5000, 45_000, 120_000]) stage({ cols, rows: 9, t: since / 1000, script, since, reveal: 1 })
    }
    expect(script.code?.error ?? `${stock.concept}: ok`).toBe(`${stock.concept}: ok`)
  }
})

test('a dealer deals each scene of a phase once before any comes around again, in the styles allowed', () => {
  const phase = SCENES[0]?.phase
  if (!phase) return
  const mine = SCENES.filter(s => s.phase === phase)
  const dealer = createDealer(STYLES)
  const dealt = mine.map(() => deal(dealer, phase, 'auth.ts')?.concept)
  expect(new Set(dealt).size).toBe(mine.length)
  expect(JSON.stringify(deal(dealer, phase, 'auth.ts')?.raw)).not.toContain('{what}')
  // Only the styles allowed are dealt.
  const flat = createDealer(['pixel art', 'text art'])
  for (let i = 0; i < 30; i++) {
    const got = deal(flat, 'testing', 'x')
    if (!got) break
    expect(styleOf(got.raw)).not.toBe('3D')
  }
  // A phase with nothing in the styles allowed deals nothing.
  expect(deal(createDealer([]), phase, 'x')).toBeUndefined()
})
