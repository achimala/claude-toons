# claude-toons: notes for agents

How the plugin works, where things live, and how to work on it. The README is
for users: install and cost. Keep technical detail here.

## How it works

- **Watching.** A `tool.call` hook logs each tool Claude runs: command, file,
  pattern, and whether it failed. `prompt.submit` and `turn.complete` mark the
  turn's edges, and the spinner's mode tells when Claude turns to thinking or
  to writing its reply.
- **Ready-made scenes.** On by default. `hooks/library.ts` reads the log for
  what Claude is doing (thinking, searching, reading, editing, testing,
  building, running, git, web, agents, writing) and the file or command it
  last touched. Routine news deals a stock scene from `hooks/scenes.ts` for
  that phase, with `{what}` in it filled by the file or command. A new one is
  dealt when the phase changes, after 60 seconds on one scene, or after 90
  seconds of quiet. Each phase has a shuffled deck, so no scene repeats until
  the rest of its deck has played. Only scenes in the styles the setting
  allows are dealt; a scene's style is what its code really calls, not what
  it was asked for.
- **The director.** A model asked for a fresh scene. With ready-made scenes
  on, it is asked only for news worth it (the task, a failed or denied tool,
  a scene whose code broke, or a phase with no stock in the allowed styles),
  and at most once a minute. With them off, it is asked whenever there is
  news, at most once per the pace setting. The log goes to the director in
  one conversation per session, so each request reads the earlier ones from
  the prompt cache. Only the last two scenes stay whole in the thread; older
  ones collapse to their one-line concept, a batch of six at a time so the
  cached prefix is rebuilt rarely. The thread is cut to 30 messages at 60.
  The reply is a scene as JSON (structured outputs).
- **The prompt.** `systemFor()` in `hooks/narrator.ts` builds the director's
  prompt from only the drawing calls the allowed styles need: no 3D calls or
  3D example for "no 3D", no pixel calls for text art. A request names a style
  only when more than one is allowed. Keep the prompt about intent; don't add
  menus of jokes or formats, which make every scene the same.
- **Quiet stretches.** While nothing new happens, the scene keeps animating
  on its own and nothing is requested. After 90 seconds on one scene, a
  "still running" line asks for the scene's next beat, or deals a new stock
  scene when ready-made scenes are on.
- **Scenes.** A faint backdrop effect, particle swarms, actors (frames of
  ASCII art moved by math expressions of time, like
  `x = "mod(t*8, w+20) - 20"`), and optionally a program.
- **Code.** A scene can carry a program in a JavaScript-like language,
  interpreted by `hooks/lang.ts`: closures, loops, arrays and objects,
  destructuring, template literals, `switch`, Math, and the common array and
  string methods. The top level runs once; `frame(t, dt)` redraws every frame
  and state persists between frames. It draws with `put`, `text`, `sprite`,
  `fill`, `line`, `circle` and `disc` in any colors, `clawd()` for the mascot
  and `say()` for a speech bubble.
- **Pixels.** Cells hold two pixels each (upper and lower half blocks), and
  code draws on that grid with `pixel()` and `pixels()`. Clawd is drawn on the
  same grid, with poses, a walk cycle, eye states, claw poses, any color and
  up to 4x scale; `clawd()` returns anchors (head, claw tips, feet, eyes) for
  hats and props.
- **3D.** `hooks/render3d.ts`. The world is sampled at 2x4 points per cell,
  lit with smoothly interpolated normals, and each cell becomes the
  quarter-block glyph that best splits its samples into two colors. A dark
  rim marks depth jumps, and fog reads as depth. A mesh drawn `ascii` uses
  glyphs by brightness. `clawd3d()` stands Clawd at a world point as a lit
  solid with flat pixel-art eyes, both on one row, and `project()` maps a
  world point to the strip.
- **Sandbox.** Plugins have no `eval`, and scene code comes from a model
  reading the user's repo, so it runs in the interpreter alone and reaches
  nothing but its own values and the drawing calls. Every step burns fuel
  (1M for setup, 150k per frame) and a frame may run at most 80ms, so a
  runaway loop stops the scene, not the terminal. An error in a director
  scene is reported back so the director can fix it; a broken stock scene is
  replaced from the stock.
- **Drawing.** A `ui.render` hook on `Spinner` keeps the engine's spinner
  line and adds a `Raster` under it, repainted at about 20 fps with
  `$.ui.blit`. Empty cells show the terminal's background. A new scene
  dissolves in over the old one cell by cell for half a second, both
  programs running meanwhile.
- **Cost tracking.** Each director reply's usage is priced in `hooks/cost.ts`
  and saved per model and pace, with Claude's own cost per working hour
  beside it, for the settings pane.

## Files

- `hooks/register.tsx`: the hooks: watching, asking for and dealing scenes,
  drawing, the `/toons` command and settings pane.
- `hooks/narrator.ts`: the conversation with the director and its prompt.
- `hooks/library.ts`: phases from the log, the dealer, and the brief for
  generating stock scenes.
- `hooks/scenes.ts`: the stock. Generated; don't edit by hand.
- `hooks/script.ts`: the scene renderer and the drawing calls.
- `hooks/lang.ts`: the scene-code interpreter.
- `hooks/clawd.ts`: the mascot's pixel art, poses and anchors.
- `hooks/render3d.ts`: the 3D renderer.
- `hooks/effects.ts`: the backdrop effects.
- `hooks/cost.ts`: prices, estimates and how they are described.

## Scripts

- `bun scripts/library.ts` fills the stock. `--anthropic` uses the Anthropic
  API with `ANTHROPIC_API_KEY` (Opus 5.5 by default, about 4 cents a scene);
  without it, the Codex CLI. `--per N` is the target count per phase,
  `--phases a,b` limits the phases, and `--style S` asks for and counts one
  style. It keeps only scenes that draw for two simulated minutes at two
  widths without error and in which Clawd speaks. API runs cost real money:
  get the user's go-ahead first.
- `bun scripts/play.ts [phase|number] [--source S]` plays stock scenes in a
  terminal with the plugin's renderer.
- `bun scripts/frames.ts N | python3 scripts/gif.py out.gif` renders a stock
  scene to an animated GIF (needs Pillow).
- `docs/demo.gif` is the README demo, cut from a screen recording with
  ffmpeg.

## Development

`claude plugin test .` runs the tests and `claude plugin validate .` checks
the manifest and hooks. Once Claude Code has loaded the plugin, it writes
types to `.claude-plugin/types/`, and `tsc -p .` type-checks.

The test runner needs hook modules switched on in the running Claude Code.
When they're off, the tests that don't need the engine run under bun with a
preload that maps the test import:

```ts
// shim.ts
import { expect, mock, test } from 'bun:test'
mock.module('claude-code/testing', () => ({ test, expect }))
```

```sh
bun test --preload ./shim.ts hooks/narrator.test.ts hooks/library.test.ts hooks/scene.test.ts hooks/lang.test.ts hooks/interpreter.test.ts hooks/cost.test.ts
```

Things learned along the way:

- A render hook can wrap the engine's own drawing: `await next(e)` returns
  `{ type: 'engine', ref }`, which goes inside your tree.
- `$` is never passed to helpers; keep helper modules pure and spell `$`
  calls at the call site.
- `hooks/narrator.ts` exports `URL` (the API endpoint), which shadows the
  global `URL` in any script that imports it by that name.
