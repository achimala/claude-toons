// What the cartoons cost: API prices per model, what a scene typically
// spends, and an hour of Claude working with cartoons on, put next to what
// Claude's own work costs so the number means something on a subscription.

export const MODELS = ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const
export type Model = (typeof MODELS)[number]

export const MODEL_NAMES: Record<Model, string> = {
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
}

export const PACES = ['as fast as possible', 'every 15 seconds', 'every 30 seconds', 'every minute'] as const
export type Pace = (typeof PACES)[number]

// The least time between two scene requests, per pace.
export const GAP_MS: Record<Pace, number> = {
  'as fast as possible': 1500,
  'every 15 seconds': 15_000,
  'every 30 seconds': 30_000,
  'every minute': 60_000,
}

export const isModel = (v: unknown): v is Model => MODELS.includes(v as Model)
export const isPace = (v: unknown): v is Pace => PACES.includes(v as Pace)

export type CallUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

// US dollars per million tokens, at Anthropic's API list prices.
const PRICES: Record<Model, CallUsage> = {
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
}

export const costOf = (model: Model, u: CallUsage) => {
  const p = PRICES[model]

  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6
}

// Seconds a scene takes to come back, per model, Sonnet's measured at about
// 9 (a request waits for the last one, so "as fast as possible" is bounded by
// it). A faster model draws more scenes an hour at that pace, so Haiku's
// hourly cost there lands near Sonnet's despite costing half per scene.
const LATENCY_S: Record<Model, number> = { 'claude-haiku-4-5': 5, 'claude-sonnet-5-5': 9, 'claude-opus-5-5': 14 }

// A typical scene's tokens on Sonnet 5.5 (measured at about 1.7 cents a
// scene): the cached conversation read back, what each exchange adds to it,
// and the scene itself. The scene's own tokens are most of the cost.
const TYPICAL: CallUsage = { input: 300, output: 1100, cacheRead: 30_000, cacheWrite: 1500 }

export const scenesPerHour = (model: Model, pace: Pace) => 3600 / Math.max(GAP_MS[pace] / 1000, LATENCY_S[model])

// What one model and pace has spent, and over how much of Claude's working
// time with the cartoons showing.
export type Spend = { usd: number; scenes: number; activeMs: number; tokens?: CallUsage }

export const addTokens = (spend: Spend, u: CallUsage) => {
  const t = (spend.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  t.input += u.input
  t.output += u.output
  t.cacheRead += u.cacheRead
  t.cacheWrite += u.cacheWrite
}
export type Stats = { buddy: Record<string, Spend>; main: Spend }

export const emptyStats = (): Stats => ({ buddy: {}, main: { usd: 0, scenes: 0, activeMs: 0 } })
export const spendKey = (model: Model, pace: Pace) => `${model}|${pace}`

// Measured figures count once they cover this much working time.
const ENOUGH_MS = 10 * 60_000

// Dollars per hour of Claude working, measured where there is enough of it.
const hourly = (spend: Spend | undefined) => (spend && spend.activeMs >= ENOUGH_MS ? spend.usd / (spend.activeMs / 3_600_000) : undefined)

export function estimate(stats: Stats, model: Model, pace: Pace) {
  const measured = hourly(stats.buddy[spendKey(model, pace)])
  const spend = stats.buddy[spendKey(model, pace)]

  return {
    usd: measured ?? scenesPerHour(model, pace) * costOf(model, TYPICAL),
    scenes: measured !== undefined && spend ? spend.scenes / (spend.activeMs / 3_600_000) : scenesPerHour(model, pace),
    measuredMinutes: measured !== undefined && spend ? Math.round(spend.activeMs / 60_000) : undefined,
  }
}

// Dollars as a person reads them: cents under a dollar, then fewer digits.
export const money = (usd: number) => (usd < 0.995 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd < 9.95 ? 2 : 0)}`)

export type Window = { kind: string; percentUsed: number }

export type CostSummary = {
  // An hour of Claude working with the cartoons on, at this model and pace.
  hour: { usd: number; scenes: number; measuredMinutes?: number }
  // The same hour against Claude's own work, once that has been measured:
  // the share it adds, and the minutes of Claude's own work it equals.
  vsClaude?: { claudeUsd: number; percent: number; minutes: number }
  // What a scene spends, from the tokens measured so far at this model (any
  // pace), with the share of its cost that is the scene itself (output).
  perScene?: { usd: number; output: number; cacheRead: number; outputShare: number }
  // An hour at this pace on each model.
  models: { model: Model; name: string; usd: number; scenes: number }[]
  // The plan's windows, where the session has any.
  windows: { label: string; percent: number }[]
}

export function summarizeCost(args: { stats: Stats; model: Model; pace: Pace; windows: Window[] }): CostSummary {
  const { stats, model, pace, windows } = args
  const hour = estimate(stats, model, pace)
  const claudeUsd = hourly(stats.main)
  const share = claudeUsd ? hour.usd / claudeUsd : undefined
  // Every scene on this model, whatever the pace.
  const mine = Object.entries(stats.buddy)
    .filter(([key, s]) => key.startsWith(`${model}|`) && s.tokens)
    .map(([, s]) => s)
  const scenes = mine.reduce((n, s) => n + s.scenes, 0)
  const tokens = mine.reduce(
    (sum, s) => ({
      input: sum.input + (s.tokens?.input ?? 0),
      output: sum.output + (s.tokens?.output ?? 0),
      cacheRead: sum.cacheRead + (s.tokens?.cacheRead ?? 0),
      cacheWrite: sum.cacheWrite + (s.tokens?.cacheWrite ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )
  const usd = costOf(model, tokens)
  const outputUsd = costOf(model, { ...tokens, input: 0, cacheRead: 0, cacheWrite: 0 })

  return {
    hour,
    perScene:
      scenes >= 5
        ? { usd: usd / scenes, output: tokens.output / scenes, cacheRead: tokens.cacheRead / scenes, outputShare: usd > 0 ? outputUsd / usd : 0 }
        : undefined,
    vsClaude:
      claudeUsd && share !== undefined
        ? { claudeUsd, percent: Math.max(1, Math.round(share * 100)), minutes: Math.max(1, Math.round(share * 60)) }
        : undefined,
    models: MODELS.map(m => ({ model: m, name: MODEL_NAMES[m], usd: estimate(stats, m, pace).usd, scenes: estimate(stats, m, pace).scenes })),
    windows: windows
      .filter(w => w.kind === 'five_hour' || w.kind === 'seven_day')
      .map(w => ({ label: w.kind === 'five_hour' ? '5-hour' : 'weekly', percent: w.percentUsed })),
  }
}
