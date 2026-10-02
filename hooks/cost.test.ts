import { test, expect } from 'claude-code/testing'

import { costOf, emptyStats, estimate, money, scenesPerHour, spendKey, summarizeCost } from './cost'

const cents = (v: number) => Math.round(v * 100) / 100

test('a call costs what its tokens cost at list prices', () => {
  expect(cents(costOf('claude-sonnet-5-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }))).toBe(14.7)
  expect(cents(costOf('claude-haiku-4-5', { input: 0, output: 1e6, cacheRead: 0, cacheWrite: 0 }))).toBe(5)
})

test('the pace bounds scenes per hour, and so does how fast the model answers', () => {
  expect(scenesPerHour('claude-sonnet-5-5', 'every minute')).toBe(60)
  expect(scenesPerHour('claude-sonnet-5-5', 'as fast as possible')).toBeLessThan(scenesPerHour('claude-haiku-4-5', 'as fast as possible'))
  const stats = emptyStats()
  expect(estimate(stats, 'claude-haiku-4-5', 'every 15 seconds').usd).toBeLessThan(estimate(stats, 'claude-opus-5-5', 'every 15 seconds').usd)
})

test('measured spend replaces the estimate once it covers enough working time', () => {
  const stats = emptyStats()
  stats.buddy[spendKey('claude-sonnet-5-5', 'every 30 seconds')] = { usd: 2, scenes: 100, activeMs: 30 * 60_000 }
  const mine = estimate(stats, 'claude-sonnet-5-5', 'every 30 seconds')
  expect(cents(mine.usd)).toBe(4)
  expect(cents(mine.scenes)).toBe(200)
  expect(mine.measuredMinutes).toBe(30)
})

test("the cost is put against Claude's own work and the plan", () => {
  const stats = emptyStats()
  stats.buddy[spendKey('claude-sonnet-5-5', 'every 15 seconds')] = { usd: 3, scenes: 240, activeMs: 60 * 60_000 }
  stats.main = { usd: 20, scenes: 12, activeMs: 60 * 60_000 }
  const cost = summarizeCost({ stats, model: 'claude-sonnet-5-5', pace: 'every 15 seconds', windows: [{ kind: 'five_hour', percentUsed: 34 }, { kind: 'spend_limit', percentUsed: 5 }] })
  expect(money(cost.hour.usd)).toBe('$3.00')
  expect(cost.hour.measuredMinutes).toBe(60)
  // 240 scenes for $3 against $20 an hour: one scene is 2.25 seconds of Claude.
  expect(cost.claude?.usd).toBe(20)
  expect(cents(cost.claude?.sceneSeconds ?? 0)).toBe(2.25)
  expect(cost.models.map(m => m.name)).toEqual(['Haiku 4.5', 'Sonnet 5.5', 'Opus 5.5'])
  expect(cost.windows).toEqual([{ label: '5-hour', percent: 34 }])
  expect(summarizeCost({ stats: emptyStats(), model: 'claude-haiku-4-5', pace: 'every minute', windows: [] }).claude).toBeUndefined()
})
