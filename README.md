# spinner-buddy

A Claude Code plugin that draws a little animated cartoon of what Claude is
doing, right under the "thinking" spinner, while it works. Clawd, the Claude
Code mascot, stars in every scene: running tests becomes a castle siege, a bug
hunt becomes a safari, a long build becomes a rocket on the pad. A separate
Claude model watches the tool calls and directs a new scene every few seconds.

## Install

You need the Claude Code CLI with plugin hook modules available. They are an
early-access feature; spinner-buddy was built on version 2.1.287.

1. Clone the repo:

   ```sh
   git clone https://github.com/<owner>/spinner-buddy ~/src/spinner-buddy
   ```

2. Try it for one session:

   ```sh
   claude --plugin-dir ~/src/spinner-buddy
   ```

   Give Claude any task; the cartoons appear under the spinner while it works.

3. To load it in every session, add the folder to the `env` block of
   `~/.claude/settings.json`, then restart Claude Code:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/src/spinner-buddy"
     }
   }
   ```

   Use the full path. To load several plugin folders, separate them with `:`
   (`;` on Windows).

To update, `git pull` in the folder; a running session reloads the plugin when
its files change. To uninstall, remove the folder from
`CLAUDE_CODE_PLUGIN_DIRS` (or stop passing `--plugin-dir`) and delete it.

**Nothing shows up?** Run `claude --debug` and look for a `spinner-buddy` line.
A line saying hook modules are turned off means your Claude Code doesn't have
the feature enabled yet; any other line names what went wrong. Cartoons only
appear while Claude is working, and only in the terminal.

## Controls

- `/cartoons` shows or hides the cartoons, even while Claude is working.
  `/cartoons on` and `/cartoons off` set it outright. The choice is remembered
  across sessions. While hidden, no scenes are requested, so they cost nothing.
- `/cartoons settings` opens a pane to pick the director model and how often a
  new scene is requested, with an estimate of what that costs. The same two
  settings are also in `/config`.

## What it costs

Each scene is one request to the director model, made with your Claude Code
session's own credentials and nothing else. On a subscription, that counts
toward your plan's usage limits like any other Claude use; if the session itself
runs on an API key, it is billed to that key. If the session's login can't make
the requests, the cartoons switch off for the session. They never fall back to
another key from your environment.

Rough API-price estimates for an hour of Claude working continuously:

| New scene | Haiku 4.5 | Sonnet 5.5 (default) | Opus 5.5 |
|---|---|---|---|
| as fast as possible | ~$7.50 | ~$8.50 | ~$9.50 |
| every 15 seconds (default) | ~$2.50 | ~$5 | ~$9 |
| every 30 seconds | ~$1.25 | ~$2.50 | ~$4.50 |
| every minute | ~$0.65 | ~$1.25 | ~$2.25 |

Most of a scene's cost is the scene itself: a thousand or so tokens of ASCII
art and code at output prices. The conversation history behind it is read
from the prompt cache at a tenth of the input price, so it adds little.
"As fast as possible" costs about the same on Haiku and Sonnet because Haiku
answers faster and so draws more scenes an hour; at a fixed pace it is half
the price.

Nothing is spent while Claude is idle or the cartoons are hidden.
`/cartoons settings` replaces these estimates with what you have actually
spent, once there is enough of it. It also compares that with what Claude's
own work costs, which is the clearest guide to how much of a subscription's
limits the cartoons take up.

## How it works

- **Watching:** a `tool.call` hook logs each tool Claude runs (command, file,
  pattern, and whether it failed); `prompt.submit` and `turn.complete` mark
  the turn's edges.
- **Directing:** whenever there is news, the log goes to the director model in one
  conversation for the session, so each request reads the earlier ones from the
  prompt cache. The conversation is cut back periodically so a long session
  never outgrows the context window. Sonnet answers a scene as JSON
  (structured outputs).
- **Scenes:** a scene is a faint backdrop effect, particle swarms, actors
  (frames of ASCII art moved by math expressions of time, like
  `x = "mod(t*8, w+20) - 20"`), and optionally a program.
- **Code:** a scene can carry a real program in a JavaScript-like language,
  interpreted by `hooks/lang.ts`. It has closures, loops, arrays and objects,
  destructuring, template literals, `switch`, Math, and the common array and
  string methods. The top level runs once as setup; `frame(t, dt)` redraws
  every frame, and state persists between frames. It draws with `put`, `text`,
  `sprite`, `fill`, `line`, `circle` and `disc` in any foreground and
  background color, `clawd()` for the mascot and `say()` for a speech bubble.
  That is what makes physics, simulations, shaders, morphs and 3D wireframes
  possible.
- **Sandbox:** plugins have no `eval`, and the code comes from a model reading
  your repo, so it runs in the interpreter alone: it can reach nothing but its
  own values and the drawing calls. Every step burns fuel (1M for setup, 150k
  per frame), so a runaway loop stops the scene, not the terminal. An error is
  reported back to the model so it can fix the mistake.
- **Variety:** each scene names its concept. Each request lists the last six to
  avoid and deals a random world (deep sea, wild west, cooking show... 50 in
  all) for the next scene. A "still running" update continues the current
  scene instead of starting a new one.
- **Drawing:** a `ui.render` hook on `Spinner` keeps the engine's own spinner
  line and adds a `Raster` (a grid of colored cells) under it, repainted at
  about 20 fps with `$.ui.blit`. Empty cells show the terminal's own background,
  so the scene floats on the terminal.

## Files

- `hooks/register.tsx`: the hooks: watching, asking for scenes, drawing, the
  `/cartoons` command and settings pane.
- `hooks/cost.ts`: prices, cost estimates and how they are described.
- `hooks/narrator.ts`: the conversation with the model and its prompt.
- `hooks/script.ts`: the scene renderer, the expression interpreter and the
  drawing calls scene code uses.
- `hooks/lang.ts`: the scene-code interpreter.
- `hooks/effects.ts`: the backdrop effects.

## Development

`claude plugin test .` runs the tests; `claude plugin validate .` checks the
manifest and hooks. Once Claude Code has loaded the plugin, it writes types to
`.claude-plugin/types/`, and `tsc -p .` type-checks it.

Two things learned along the way:

- A render hook can wrap the engine's own drawing: `await next(e)` returns
  `{ type: 'engine', ref }`, which goes inside your tree.
- `$` is never passed to helpers; keep helper modules pure and spell `$` calls
  at the call site.

## License

MIT. See [LICENSE](LICENSE).
