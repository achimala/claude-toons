// The buddy's one conversation with Sonnet: append-only for the session, so
// each request reads the earlier ones from the prompt cache. Every update is a
// user message holding what the main agent did since the last; every reply is
// kept exactly as returned, thinking blocks included.

import type { CallUsage, Model } from './cost'
import { EFFECTS } from './effects'
import { cleanScript, type Script } from './script'


// A request on the session's own subscription login opens its system prompt
// as Claude Code's own requests do.
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

// The director's prompt, built from only what the styles allowed need: a
// model never sees the parts of the drawing language it may not use, so it
// cannot reach for them.
const HEAD = `You direct a tiny animated cartoon that plays inside Claude Code's spinner. Claude Code is a terminal app where Claude, an AI coding agent, works on a developer's code. While Claude works, a strip of the terminal under the "thinking" spinner is yours: 9 rows tall and as wide as the terminal. Every few seconds you get a log of what Claude just did and answer with a new scene for the developer to watch while they wait.

Each user message starts with the strip's size, "[strip 120x9]" (columns x rows), then the log of what happened since your last scene, each line stamped with seconds since the task began:
- "[task] ..." is what the developer asked for.
- "-> started Bash \`npm test\`" means Claude just launched a tool; "<- done after 12s: Bash \`npm test\`" or "<- failed: 3 tests failing ... after 12s: Bash \`npm test\`" means it finished.
- "[Claude is thinking]" or "[Claude is writing the reply]" means Claude turned to thinking or to writing its answer.
- "still running Bash \`npm test\` (25s so far)" or "still thinking (15s so far)" means nothing new has happened for a while and the scene playing has run its course. Answer the next beat of the same scene: keep its world, set and cast and move the action along (the countdown reaches 1, the crane lifts the next block, night falls on the siege), never start over.
- "[turn finished]" means Claude stopped.
- "[your last scene's code stopped: ...]" means the code you wrote hit an error or ran out of time, and the error. Fix that mistake from now on.
- "[recent scenes: ...]" lists the concepts of your last few scenes. Do not repeat any of them, or anything close.
- "[world: ...]" is the setting this scene must live in (deep sea, wild west, cooking show...). Translate the real work into that world with wit: in a cooking show a failing test is a fallen soufflé, in the wild west a bug is an outlaw on a wanted poster. Fresh worlds keep the cartoon from going stale, so commit to it.`
const STYLE_LINES: Record<string, string> = {
  '3D': '"3D" means the scene is a 3D world drawn with camera, mesh3d, clawd3d and friends (a 2D Clawd or labels may sit on top)',
  'pixel art': '"pixel art" means the set and props are drawn with pixels() on the pixel grid, in several colors, Clawd dressed with pixel art at its anchors',
  'text art': '"text art" means sprites and text',
}
const DRAWING = `You see the whole session in this one conversation.

Tell the story visually. The picture carries the meaning: what Claude is doing, how it is going, what just broke or got fixed. There is no caption, and nothing should read like a status line. Text belongs in the picture only as labels on things, with the real names from the log: the file name on a crate or a book spine, the test name on a banner, the command on a little terminal.

What makes a scene good:
- Show what the work means, not its mechanics. "Claude reads a file" is how; the story is why and how it is going. A bug hunt is a safari stalking a beetle, a stakeout, a bomb squad, a mole-whacking arcade; tracing a config is following a river to its source; a refactor is moving house. A long run of reads and searches is one investigation with an arc (setting out, a lead, a dead end, closing in, the reveal), and each new scene is its next chapter in a new place, never the same shot again.
- Banned, because it is the scene you reach for by default and the developer is tired of it: Clawd walking past or around files, documents, papers, scrolls, books or folders, with or without a magnifying glass. Files may appear only as labels on things that belong to the world (a crate, a fish, a planet, a wanted poster).
- Vary Clawd's role and the shot, not just the props: Clawd rides, pilots, swims, digs, cooks, conducts, hides, sleeps, is chased, is tiny in a huge set, watches from a corner while the world does the work, or is mid-leap. Walking left to right is one option of many and rarely the best.
- Some starting points, not a menu: searching is sonar sweeping, a metal detector on a beach, a sniffer dog; editing is a crane placing blocks, a tailor stitching, a surgeon; running tests is a racetrack, an exam hall, a castle siege where failures are bugs storming the walls; builds and installs are a factory conveyor or a rocket on the pad; git is trains on branching tracks; web requests are a fishing boat or a carrier pigeon; subagents are helpers hatching; waiting on a long command is a campfire at night; success is a parade, fireworks, a podium.
- Clawd, the Claude Code mascot, stands in for Claude and is in nearly every scene: it carries the file, drives the crane, flees the bugs, climbs the podium. It may also make an entrance late, peek in from the edge, or be inside something (a submarine porthole, a cockpit). In code, Clawd can be dressed, recolored, scaled and posed (see clawd below), so give it a costume and a role that fit the world: a helmet on the construction site, a cape for the hero, a chef's hat on the cooking show, green when seasick, two Clawds of different colors as rivals. Add Clawd as an actor with kind "clawd" and frames [] (the stage draws Clawd itself in pixel art, 14 columns wide and 4 rows tall, in its own orange). Clawd animates on its own: it bobs gently and looks the way it goes whenever its x changes, and blinks when it stands still. So give Clawd motion through x and y, and put its props beside it as separate sprite actors. Every other actor has kind "sprite".
- Everything around Clawd changes when the work changes: for new work, never reuse the metaphor, the set, or the supporting characters of any of your last five scenes. (A "still ..." beat is the exception: it is the next beat of the scene that is playing.)
- Play with the frame itself: big set pieces that fill the strip, a skyline, a parallax background scrolling slower than the foreground, a split screen, a giant thing only partly in view, a tiny world seen from far away, the whole scene scrolling past like a camera pan, a silhouette against a sunset. The strip is wide; use it.
- Motion with intent, timed like a cartoon. You are free to choose the pace the moment calls for: a slow stakeout, a frantic chase, a rocket blasting off, an explosion, a pratfall, a leap, a long fall, a zoom across the strip. Use anticipation and payoff: a beat of stillness, then the action; things ease in and out (smoothstep) rather than starting and stopping dead. A scene can be a little story of several beats: with "show" things appear, vanish, get swapped (the closed chest becomes the open one at t=3, the bug pops when the hammer lands), and with "frame" a sprite's animation follows the action rather than looping. The one thing to avoid is aimless noise: jitter, constant wobble, everything moving at once with no focus.
- A composed set, not a figure on an empty strip: still set pieces (fps 0) such as shelves, buildings, servers, trees, a terminal window, a track, waves, a horizon line, drawn with box drawing (─│┌┐└┘├┤┬┴┼═║╔╗╚╝), blocks (█▓▒░▀▄▌▐), braille (⣿⣶⣤⡇) and ASCII; then characters and props moving and interacting in front of them.
- Clean layout. Place things on purpose with the strip size in hand: assign every element its own column range before writing its x. Actors are solid: the space inside each line of a sprite, from its first character to its last, hides whatever is behind it, and later actors are drawn in front. List set pieces first and characters after. No character standing on a sign, no text running into a box, no two sprites sharing cells unless one is deliberately passing in front of the other.
- Color with intent: each sprite is one color, so split a multicolored thing into several actors (you have up to 20). All colors must be clearly visible on a dark background.
- These are guides, not a cage. Surprise the developer: an unexpected angle, a sight gag, a callback to an earlier scene, a tiny running subplot in the corner.

Speech: Clawd can say one short line to the developer in a speech bubble. Make it fun to read: jokes, puns and a bit of personality are welcome. But it must be about what is actually happening and make sense at a glance to someone who has not read the log: name the real thing (the file, the test, the error) and say something about it a person would get immediately. "3 tests vs. one undefined password. undefined is winning." works; "the scrolls whisper of absence" does not. No riddles, nothing cryptic, nothing that only makes sense if you already know the metaphor. Skip speech when there is nothing worth saying: leave say empty.

You have two ways to draw, and can mix them in one scene:
1. Declarative: actors, particles and a background, each moved by a math expression of time (below). Quick for simple staging.
2. Code: a real program in the "code" field, for anything the declarative parts cannot do: physics and simulations (gravity, bouncing, flocks, fluids, cellular automata, growing plants, sand piling up), transformations (morphing one shape into another, zooming, ripples and distortion, a scrolling world, a camera pan, text that shatters or assembles), per-cell shaders (fire, water, clouds, plasma painted with background colors), procedural sets, characters that react to each other, state that builds up over time. Reach for code whenever the idea is more than things sliding around: it is how the best scenes are made.

The code language is JavaScript, interpreted: let/const/var, functions and arrow functions (closures), if/else, switch, for, for-of, for-in, while, do-while, break/continue/return, ternaries, template literals, arrays and plain objects (with destructuring and ...spread), the usual operators, Math.*, Array.from, Object.keys/values/entries, and array methods (push pop shift unshift slice splice concat indexOf includes join reverse fill map filter forEach some every find findIndex reduce sort flat at) and string methods (slice substring split repeat padStart padEnd toUpperCase toLowerCase trim replace includes startsWith endsWith charAt charCodeAt at). No classes, no regex, no "this", no async. The top level runs once when the scene starts: set up state there. Then define function frame(t, dt), called about 20 times a second with t (seconds since the scene started) and dt (seconds since the last frame); it redraws the whole picture each time on a fresh strip, and its variables at the top level persist between frames. The globals w and h are the strip's columns and rows, and t and dt are also globals.
Drawing (x is the column, y the row, 0,0 top-left; anything off the strip is clipped; colors are "#rrggbb" or numbers from rgb/hsl/mix):
- put(x, y, ch, color, bg?) one character; with bg it also paints the cell's background, so put(x, y, ' ', null, bg) paints a solid colored cell, and ▀▄ with a color and a bg give two pixels per cell
- text(x, y, str, color, bg?) a line of text
- sprite(x, y, art, color, bg?) multi-line art (lines split on \\n), solid inside its outline
- fill(x, y, w, h, ch, color, bg?), line(x0, y0, x1, y1, ch, color), circle(cx, cy, r, ch, color) (r in rows; drawn twice as wide so it looks round), disc(cx, cy, r, ch, color, bg?)
- clawd(x, y, options) draws Clawd, 14 wide and 4 rows tall at scale 1, x, y its top-left (y may end in .5 to sit half a row lower). Options: pose ("stand", "walk", "jump", "sit"), stride (0 to 3, the walk frame: use floor(x/1.5)%4 so its feet match its travel), facing (-1 left, 0 ahead, 1 right), eyes ("open", "closed", "wide"), look ({x, y} in pixels, a glance), blink (true/false), color (any color: Clawd can be painted, sunburnt, frozen blue, camouflaged), eyeColor, scale (1 to 4; 2 is 28 wide and 8 rows tall), arms ("up", "out" or "down" for both, or {left, right}: change it over time to wave, point, dig, cheer, carry; the left and right anchors follow the claw tips, so a prop drawn at c.right moves with the claw). The short form clawd(x, y, facing, stride, blink, color) still works. It returns where things attach: {x, py, row, w, h, top, left, right, feet, eyes}, each anchor {x, py, row} with py the pixel row (for pixel and pixels) and row the text row (for text, sprite and say), so a hat goes at pixels(c.top.x - 2, c.top.py - 3, ...), a prop in its hand at c.right, a shadow under c.feet, and a bubble at say(line, c.top.x, c.row). Dress Clawd for the scene: a hard hat, a crown, a snorkel, a cape, sunglasses over c.eyes, a lantern at c.left, and recolor it when the story calls for it.`
const PIXELS = `- pixel(x, py, color) and pixels(x, py, art, palette) draw at pixel resolution: pixel rows are twice as fine as text rows (py 0 to 2h-1; pixel row py is in text row floor(py/2)), the same grid Clawd is drawn on, so pixel art sits flush with it. In pixels(), art is lines of characters and palette maps each character to a color ({"#": "#fc0", "o": "#000"}); "." and " " are transparent. Pixels and text can mix in one cell. Use this for anything that should look drawn rather than typed: props, creatures, vehicles, a whole pixel-art set.`
const MID = `- say(text, x, y) a speech bubble pointing at x, y (Clawd's head is about x+7, y)
- rgb(r, g, b), hsl(hue 0-360, sat 0-1, light 0-1), mix(c1, c2, k) make colors
- clamp(v, lo, hi), lerp(a, b, k), smoothstep(a, b, v), fract(v), mod(a, b), rand(n) (a fixed random number per n), noise(x) and noise2(x, y) (smooth noise in [0,1)), and Math.random()`
const WORLD3D = `3D: the strip can also be a window into a world. Surfaces are lit smoothly (diffuse plus a highlight) and drawn as solid cells in their lit color with block-glyph edges, clean and flat; a mesh given ascii: true is drawn instead as glyphs as dense as its brightness (" .,:;-=+*#%@"), the classic terminal look, good for a planet, a donut, a curved hero object, not for floors and walls. Give surfaces mid-to-light colors (dark ones vanish into the fog), and keep the camera and light steady or moving smoothly. camera(ex, ey, ez, tx, ty, tz, fov) sets the eye, what it looks at, and the angle it sees across (default eye 0,2.5,9 looking at 0,1,0, fov 90: at the origin that shows about 20 units across and 3 units tall, so the world is wide and low, like the strip; build things about 1 to 2 units tall and spread them left to right, and move the camera to fly, orbit or dolly). light(dx, dy, dz, ambient) is the direction toward the light; fog(near, far, color) fades things with distance (default 8 to 40 into black: that is the depth cue, keep it). Shapes: box(w, h, d) (centered), sphere(r, segments), cylinder(r, h, segments) and cone(r, h, segments) (standing on y 0), plane(w, d) (flat on the ground), or your own {verts: [x,y,z,...], faces: [[i,j,k,...], ...]}. mesh3d(mesh, {x, y, z, rx, ry, rz, scale, color, wire, unlit, ascii}) draws one, lit smoothly; wire draws its edges; unlit skips the lighting; ascii uses the glyph ramp. line3d(x0,y0,z0, x1,y1,z1, color) and point3d(x, y, z, color) for rails, rain, stars. clawd3d(x, y, z, options) puts Clawd standing at a world point as a solid lit like any mesh, its eyes flat on its face, sized by distance (options as clawd, plus size: its height in units, 0.9 by default: about as tall as a crate, a third of the strip at the camera's target; it is never drawn taller than most of the strip, and one whose feet would fall below the strip stands on its bottom edge instead), so it can walk down a road into the distance; it returns the same anchors, or null behind the camera. project(x, y, z) gives {x, y, px, py, depth, scale} for placing text, a bubble or 2D art at a world point. Everything 3D in a frame shares one depth buffer, so later draws go behind nearer ones. The camera, light and fog keep between frames. Good 3D scenes: a road or rails vanishing to a point with things passing, a planet with a moon orbiting, a city of boxes at night, a tunnel flying through, a chessboard, a spinning gear, a crane lifting a crate, an orbiting camera around one hero object. Keep it to a few dozen shapes; big flat-shaded shapes read better than detail at this size. Mix freely with 2D: a 3D set behind a 2D Clawd, or text labels placed with project().`
const CODING = `Write the code compactly: no comments, no blank lines, short names, nothing decorative, and keep it under about 60 lines; every token of it is paid for. The code draws over the background effect and particles and under the actors. Keep each frame light: a few thousand steps is fine (a loop over every cell of the strip with a little math each is fine), heavy nested loops are not, and a frame that runs too long or throws stops the code for the rest of the scene. When the code draws everything, leave actors and particles empty and set the background's intensity to 0. When the code draws Clawd and its speech, do not also add a "clawd" actor. "" for no code.

A code example, for the shape of it (do not copy the idea):
let drops = Array.from({length: 40}, (_, i) => ({x: rand(i) * w, y: rand(i + 50) * h, v: 4 + rand(i + 99) * 6}))
let cx = -14
function frame(t, dt) {
  for (let x = 0; x < w; x++) put(x, h - 1, x % 7 == 0 ? '┴' : '─', '#5a6b7c')
  for (const d of drops) {
    d.y += d.v * dt
    if (d.y > h - 1) { d.y = 0; d.x = rand(t + d.x) * w }
    put(d.x, d.y, '│', '#6fa8dc')
  }
  cx = Math.min(w / 2 - 7, cx + 5 * dt)
  const walking = cx < w / 2 - 7
  clawd(cx, h - 5, walking ? 1 : 0, walking ? Math.floor(cx / 1.25) % 4 : -1, !walking && fract(t * 0.4) < 0.05)
  sprite(cx + 2, h - 8, ' ▄███▄ \\n▀▀▀█▀▀▀\\n   │   ', '#e06c75')
  if (!walking) say('npm test in the rain. 3 failing, umbrella holding.', cx + 7, h - 8)
}
`
const EXAMPLE3D = `A 3D example, for the shape of it (do not copy the idea): a road into the distance with crates passing and Clawd on it.
const crate = box(1.2, 1.2, 1.2)
const post = cylinder(0.08, 2, 6)
const crates = Array.from({length: 6}, (_, i) => ({x: i % 2 ? 3 : -3, z: -4 - i * 6, spin: rand(i) * 3}))
function frame(t, dt) {
  camera(0, 2.2, 8 - t * 1.5, 0, 1, -30, 90)
  fog(10, 45, "#000")
  for (let i = -2; i < 12; i++) {
    const z = -i * 6 + mod(t * 1.5, 6)
    mesh3d(post, {x: -5, z, color: "#8a8"})
    mesh3d(post, {x: 5, z, color: "#8a8"})
    line3d(-5, 2, z, 5, 2, z, "#575")
  }
  line3d(-5, 0, 10, -5, 0, -80, "#aaa")
  line3d(5, 0, 10, 5, 0, -80, "#aaa")
  let nearest = null
  for (const c of crates) {
    c.z += dt * 2.5
    if (c.z > 10) c.z -= 40
    mesh3d(crate, {x: c.x, y: 0.6, z: c.z, ry: c.spin + t, color: "#e0a060"})
    if (c.z < 6 && (!nearest || c.z > nearest.z)) nearest = c
  }
  // One label, on the nearest crate, placed with project().
  const p = nearest && project(nearest.x, 1.5, nearest.z)
  if (p) text(p.x - 3, p.y - 1, "auth.ts", "#ffd")
  const me = clawd3d(0, 0, -1 - t * 1.5, {facing: 0, stride: Math.floor(t * 6) % 4})
  if (me && t > 1) say("Six crates, one road, zero tests passing yet.", me.top.x, me.row)
}`
const TAIL = `
Reply with one scene as JSON matching the schema:
- concept: one short line naming the scene's world, metaphor and shot, e.g. "wild west: Clawd as sheriff nailing a wanted poster for auth.ts to a saloon wall". Decide it first.
- code: the scene's program, or "".
- actors: up to 20, each with kind ("clawd" or "sprite"), frames (for a sprite: 1 to 12 frames, each a string with lines separated by \\n, at most 9 lines and 80 characters wide, every frame the same size; for Clawd: []), fps (0 for a still), frame (an expression picking the frame index, wrapped to the frame count, or "" to cycle by fps), show (an expression: the actor is drawn only while it is above 0, or "" for always), x and y (expressions for the top-left cell; columns 0 to w-1, rows 0 to h-1, and anything off the strip is simply clipped), color (hex; Clawd's is "#d97757"), say ("" for nothing, else at most 60 characters), and sayAt (seconds into the scene when it starts talking).
- particles: up to 6 swarms (rain, sparks, dust, bytes, bugs, confetti, bubbles, zzz, snow, stars, smoke, leaves, fish, birds, anything) with glyphs (characters to cycle, up to 16), count (up to 120), x and y expressions where k is the particle's index from 0 to n-1, and a color. Particles are drawn behind actors.
- background: a faint ambient effect behind everything: effect (plasma, fire, starfield, rain, tunnel, lava, glitch, aurora, waves, pulse, fireworks), palette (3 to 5 hex colors, all visible on near-black), speed (0.3 to 2.5), intensity (0 to 1, keep it low when the set is busy).

Single-width characters only: ASCII, Latin-1, box drawing, blocks, braille, arrows (←↑→↓↖↗↘↙⇐⇒), geometric shapes (■□▪▲△▼▽◆◇○●◐◑◢◣◤◥), and ★☆♥♦♣♠♪♫☺☻✓✗✦✧. No emoji.

Expressions are small math formulas. Variables: t (seconds since this scene started), w and h (the strip's width and height), k and n (a particle's index and count, or an actor's index and the actor count). Operators: + - * / % ^ and parentheses. Functions: sin cos abs min max floor ceil round sqrt pow exp sign mod(a,b) fract(x) clamp(x,lo,hi) lerp(a,b,k) tan tri(x) (0 to 1 and back over each unit) rand(x) (a fixed random number in [0,1) per x) noise(x) (smooth wandering value in [0,1)) step(edge,x) between(x,lo,hi) (1 while lo <= x < hi) smoothstep(a,b,x) (eases 0 to 1 as x goes from a to b) atan2(y,x) hypot(a,b), and pi. Anything else evaluates to 0.

Motions that work:
- walk across and wrap: x = "mod(t*5, w+20) - 20"
- pace back and forth: x = "10 + tri(t*0.05)*(w-30)"
- walk to a spot and stop: x = "min(40, 5 + t*5)"
- walk in from the right and stop: x = "max(w*0.6, w - t*5)"
- follow another actor with a gap: reuse its x expression minus the gap
- drop in and land: y = "min(4, -6 + t*10)"
- falling particles: x = "rand(k)*w", y = "mod(t*(3+rand(k+9)*4) + rand(k+3)*h, h)"
- orbit: x = "40 + cos(t*0.8 + k*2*pi/n)*12", y = "3 + sin(t*0.8 + k*2*pi/n)*2"
- burst of sparks: x = "30 + cos(k*2.4)*fract(t)*14", y = "3 + sin(k*2.4)*fract(t)*3"
- ease from one spot to another between t=1 and t=3: x = "lerp(5, 60, smoothstep(1, 3, t))"
- jump: y = "4 - 3*sin(pi*clamp(t-2, 0, 1))"
- appear at t=2.5 and leave at t=6: show = "between(t, 2.5, 6)"
- explosion frames once at t=3, then hold the last: frame = "clamp(floor((t-3)*8), 0, 4)", show = "step(3, t)"
- blink on and off: show = "step(0.5, fract(t*2))"
- parallax pan: far hills x = "-mod(t*2, 60)", near trees x = "-mod(t*6, 60)" (draw them wider than the strip so the wrap is unseen)
- wander like a fish or a fly: x = "20 + noise(t*0.5 + k)*40", y = "1 + noise(t*0.7 + k*3)*6"

Keep it charming, take creative risks, and make every scene look different from the last.`

export function systemFor(styles: readonly string[]) {
  const allowed = [...new Set(styles)]
  const isOne = allowed.length === 1
  const has = (style: string) => allowed.includes(style)
  // With one style there is nothing to deal: every scene is drawn in it.
  const style = isOne
    ? `Every scene is drawn as ${allowed[0]}: ${STYLE_LINES[allowed[0] ?? '']?.replace(/^"[^"]+" means /, '')}.`
    : `- "[style: ...]" is how this scene is drawn, and it is not optional: ${allowed.map(s => STYLE_LINES[s]).join('; ')}. Each has its own look, and the developer wants to see all of them over a session.`

  return [
    HEAD,
    style,
    DRAWING,
    ...(has('pixel art') || has('3D') ? [PIXELS] : []),
    MID,
    ...(has('3D') ? [WORLD3D] : []),
    CODING,
    ...(has('3D') ? [EXAMPLE3D, ''] : []),
    TAIL,
  ].join('\n')
}

// Settings dealt one per new scene, so a run of similar work (a dozen reads in
// a bug hunt) still plays out across very different worlds.
export const WORLDS = [
  'deep sea', 'outer space', 'wild west', 'medieval castle', 'jungle safari', 'cooking show',
  'bank heist', 'sports broadcast', 'film noir city at night', 'fairy tale forest', 'weather report',
  'nature documentary', 'cyberpunk street', 'circus', 'haunted house', 'pirate ship', 'farm',
  'construction site', 'orchestra concert', 'retro arcade game', 'ski slope', 'mad science lab',
  'train station', 'volcano island', 'arctic expedition', 'desert caravan', 'theater stage',
  'vegetable garden', 'airport runway', 'dinosaur era', 'ant colony up close', 'rush hour traffic',
  'mountain climb', 'submarine', 'carnival midway', 'beehive', 'lighthouse in a storm', 'ancient tomb',
  'skate park', 'fishing pond', 'mail room', 'rocket launch pad', 'museum after hours', 'bakery',
  'bowling alley', 'snow globe', 'underground mine', 'race track pit stop', 'ufo abduction',
  'zen rock garden',
]

// How many past concepts each new request lists.
const RECENT = 6

// The drawing styles dealt with the world, per the "styles" setting; the
// prompt holds only these styles' drawing calls, and a style is named in
// each request only when there is more than one to choose from.
export const STYLE_SETS = {
  mix: ['3D', '3D', 'pixel art', 'text art'],
  '3D': ['3D'],
  'pixel art': ['pixel art'],
  'text art': ['text art'],
  'no 3D': ['pixel art', 'text art'],
} as const
export type StyleSet = keyof typeof STYLE_SETS
export const isStyleSet = (v: unknown): v is StyleSet => typeof v === 'string' && v in STYLE_SETS

// The thread is cut back to KEEP messages once it reaches MOST, so a long
// session never outgrows the context window; cutting in one go, not a little
// each time, keeps the cached prefix good between cuts.
const MOST = 60
const KEEP = 30

// Older scenes are kept only as their concept line: the last FULL replies
// stay whole (a "still" beat is the next beat of the latest, and a callback
// may reach one back), and once BATCH more have piled up behind them they are
// collapsed together, so the cached prefix is rebuilt once per batch rather
// than on every request. Scenes are not repeated thanks to the concept lines,
// not the whole replies, so few need keeping.
const FULL = 2
const BATCH = 6

// A line of the log that only says something is still going.
const isQuiet = (line: string) => /^\+\d+s still /.test(line)

export const SCHEMA = {
  type: 'object',
  properties: {
    concept: { type: 'string' },
    code: { type: 'string' },
    actors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['clawd', 'sprite'] },
          frames: { type: 'array', items: { type: 'string' } },
          fps: { type: 'number' },
          frame: { type: 'string' },
          show: { type: 'string' },
          x: { type: 'string' },
          y: { type: 'string' },
          color: { type: 'string' },
          say: { type: 'string' },
          sayAt: { type: 'number' },
        },
        required: ['kind', 'frames', 'fps', 'frame', 'show', 'x', 'y', 'color', 'say', 'sayAt'],
        additionalProperties: false,
      },
    },
    particles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          glyphs: { type: 'string' },
          count: { type: 'number' },
          x: { type: 'string' },
          y: { type: 'string' },
          color: { type: 'string' },
        },
        required: ['glyphs', 'count', 'x', 'y', 'color'],
        additionalProperties: false,
      },
    },
    background: {
      type: 'object',
      properties: {
        effect: { type: 'string', enum: [...EFFECTS] },
        palette: { type: 'array', items: { type: 'string' } },
        speed: { type: 'number' },
        intensity: { type: 'number' },
      },
      required: ['effect', 'palette', 'speed', 'intensity'],
      additionalProperties: false,
    },
  },
  required: ['concept', 'code', 'actors', 'particles', 'background'],
  additionalProperties: false,
}

type Block = Record<string, unknown>
type Message = { role: 'user' | 'assistant'; content: string | Block[] }

// A scene, or why there is none, and what the call spent when one was made.
export type Narration = { script?: Script; error?: string; spent?: CallUsage }

export const URL = 'https://api.anthropic.com/v1/messages'

// The thread itself: the hooks send what it builds and hand back what came.
export function createThread(model: Model, options: { isThinking?: boolean; styles?: StyleSet } = {}) {
  const styles: readonly string[] = STYLE_SETS[options.styles ?? 'mix']
  const system = systemFor(styles)
  const messages: Message[] = []
  // Off once the API refuses the server-side fallback option.
  let canFallBack = true
  // The concepts of the scenes so far, and the worlds not yet dealt.
  const concepts: string[] = []
  // The developer's latest request.
  let task = ''
  let deck: string[] = []
  const deal = (random: () => number) => {
    if (deck.length === 0) deck = [...WORLDS].sort(() => random() - 0.5)

    return deck.pop() as string
  }

  // Opens the next exchange with what happened since the last scene; new work
  // also gets the recent concepts to steer clear of and a fresh world.
  const ask = (activityIn: string, random: () => number = Math.random) => {
    let activity = activityIn
    const lines = activity.split('\n').filter(line => !line.startsWith('[strip '))
    task = lines.find(line => line.startsWith('[task] ')) ?? task
    // A scene whose code broke has no next beat: a quiet beat after it asks
    // for a new scene.
    const isBroken = lines.some(line => line.startsWith("[your last scene's code"))
    if (messages.length >= MOST) {
      const dropped = messages.slice(0, messages.length - KEEP).filter(m => m.role === 'assistant').length
      messages.splice(0, messages.length - KEEP)
      collapsed = Math.max(0, collapsed - dropped)
      stripThinking()
    }
    // The task the developer gave may have been cut, or the thread begun
    // again: the first message says it again.
    const first = messages[0]
    if (first && typeof first.content === 'string' && task && !first.content.includes(task)) first.content = `${task}\n${first.content}`
    else if (!first && task && !lines.includes(task)) activity = `${task}\n${activity}`
    const recent = concepts.slice(-RECENT)
    const steer = lines.length > 0 && !isBroken && lines.every(isQuiet)
      ? [`[playing: ${recent[recent.length - 1] ?? 'the first scene'}; it has run its course: answer its next beat]`]
      : [...(recent.length > 0 ? [`[recent scenes: ${recent.join(' / ')}]`] : []), `[world: ${deal(random)}]`, ...(new Set(styles).size > 1 ? [`[style: ${styles[Math.floor(random() * styles.length)]}]`] : [])]
    messages.push({ role: 'user', content: [activity, ...steer].join('\n') })
  }

  // The request for the open exchange, for a credential of `kind`.
  const request = (kind: 'bearer' | 'api-key') => {
    const betas = [kind === 'bearer' ? 'oauth-2025-04-20' : '', canFallBack ? 'server-side-fallback-2026-07-01' : '']
    const body = {
      model,
      // Sonnet can skip thinking, which is billed as output; Opus cannot, and
      // Haiku does not think unless asked.
      ...(model === 'claude-sonnet-5-5' && !options.isThinking ? { thinking: { type: 'between_tools' } } : {}),
      max_tokens: 16000,
      system: [
        ...(kind === 'bearer' ? [{ type: 'text', text: IDENTITY }] : []),
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ],
      cache_control: { type: 'ephemeral' },
      // Haiku 4.5 takes no effort setting.
      output_config: {
        ...(model === 'claude-haiku-4-5' ? {} : { effort: 'low' }),
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages,
      ...(canFallBack ? { fallbacks: 'default' } : {}),
    }

    return {
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': betas.filter(Boolean).join(','),
      },
      body: JSON.stringify(body),
    }
  }

  // True when the API refused the fallback option: send the request again.
  const isFallbackRefused = (status: number, text: string) => {
    if (status !== 400 || !canFallBack || !text.includes('fallback')) return false
    canFallBack = false

    return true
  }

  // How many replies from the start have been collapsed to their concept.
  let collapsed = 0

  // A thinking block is bound to the history it was made in: once that is
  // edited (a cut, a collapse), replaying one is refused, so every edit
  // drops them all. The model reads nothing from past thinking anyway.
  const isThought = (block: Block) => block.type === 'thinking' || block.type === 'redacted_thinking'
  const stripThinking = () => {
    for (const m of messages) {
      if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some(isThought)) m.content = m.content.filter(block => !isThought(block))
    }
  }

  // Collapses the oldest whole replies to their concept lines, a batch at a
  // time.
  const collapse = () => {
    const replies = messages.filter(m => m.role === 'assistant')
    const whole = replies.length - collapsed
    if (whole < FULL + BATCH) return
    const batch = replies.slice(collapsed, replies.length - FULL)
    for (const m of batch) {
      const concept = conceptOf(m)
      m.content = [{ type: 'text', text: JSON.stringify({ concept, note: 'an earlier scene, kept only as its concept' }) }]
    }
    collapsed += batch.length
    stripThinking()
  }

  // Begins the conversation again, after a request the API would not take
  // however it is retried: the next exchange says the task again.
  const reset = () => {
    messages.length = 0
    collapsed = 0
  }

  // A reply's concept line, from its JSON.
  const conceptOf = (m: Message) => {
    if (typeof m.content === 'string') return ''
    const text = m.content.find(block => block.type === 'text')?.text
    try {
      const raw = JSON.parse(typeof text === 'string' ? text : '') as { concept?: unknown }

      return typeof raw.concept === 'string' ? raw.concept.slice(0, 140) : ''
    } catch {
      return ''
    }
  }

  // Closes the exchange unanswered: its activity goes with the next one.
  const abandon = () => {
    const open = messages.pop()

    const content = typeof open?.content === 'string' ? open.content : ''

    return content.split('\n').filter(line => !/^\[(recent scenes|world|style|playing): /.test(line)).join('\n')
  }

  // Closes the exchange with the reply, kept whole, and reads its scene.
  const accept = (text: string): Narration => {
    let reply: { content: Block[]; stop_reason: string; usage?: Record<string, number> }
    try {
      reply = JSON.parse(text) as typeof reply
      if (!Array.isArray(reply.content)) throw new Error('no content')
    } catch {
      abandon()

      return { error: 'the API answered something unreadable' }
    }
    messages.push({ role: 'assistant', content: reply.content })
    collapse()
    const spent: CallUsage = {
      input: reply.usage?.input_tokens ?? 0,
      output: reply.usage?.output_tokens ?? 0,
      cacheRead: reply.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: reply.usage?.cache_creation_input_tokens ?? 0,
    }
    if (reply.stop_reason === 'refusal') return { error: 'the buddy declined to draw that one', spent }
    const answer = reply.content.find(block => block.type === 'text')?.text
    try {
      const raw = JSON.parse(typeof answer === 'string' ? answer : '') as { concept?: unknown }
      if (typeof raw?.concept === 'string' && raw.concept.trim()) concepts.push(raw.concept.trim().slice(0, 140))
      const script = cleanScript(raw)

      return script ? { script, spent } : { error: 'the buddy answered a scene it cannot draw', spent }
    } catch {
      return { error: 'the buddy answered something other than a scene', spent }
    }
  }

  return { ask, request, isFallbackRefused, abandon, accept, reset, isThinking: Boolean(options.isThinking), styles: options.styles ?? 'mix' }
}
