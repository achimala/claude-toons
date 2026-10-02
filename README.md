# spinner-buddy

A Claude Code plugin that draws a little animated cartoon of what Claude is
doing, right under the "thinking" spinner, while it works. Clawd, the Claude
Code mascot, stars in every scene: running tests becomes a castle siege, a bug
hunt becomes a safari, a long build becomes a rocket on the pad. A separate
Claude model watches the tool calls and directs a new scene every few seconds.

## Install

Clone this repo and load it as a plugin folder:

```sh
git clone <this repo> ~/src/spinner-buddy
claude --plugin-dir ~/src/spinner-buddy
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the
`env` block of `~/.claude/settings.json`.

The scenes are generated with your Claude Code session's own credentials. On a
subscription, the requests count against your plan's usage; with an API key,
they are billed to it.

## How it works

- **Watching:** a `tool.call` hook logs each tool Claude runs (command, file,
  pattern, and whether it failed); `prompt.submit` and `turn.complete` mark
  the turn's edges.
- **Directing:** whenever there is news, the log goes to Sonnet 5.5 in one
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

- `hooks/register.tsx`: the hooks: watching, asking for scenes, drawing.
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
