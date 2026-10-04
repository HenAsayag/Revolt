# Bloomfield RC

Toy RC-car racing inside Bloomfield Stadium (Tel Aviv). Vite + TypeScript + three.js + Rapier.
**Play it:** https://henasayag.github.io/Revolt/ (desktop, gamepad or phone — turn it sideways).

You against 7 AI rivals over 1, 3 or 5 laps on three tracks:

- **Stadium Tour** (default, 4.4 m wide on the grass): the grid sits on a plywood deck high in the
  South stand, with a bollard slalom straight after the line; plunge down over the seats onto the
  pitch, dodge two spinning sweeper arms either side of the loop, slide through the mud on the
  north sweep, run past the goal, climb a curving ramp into the East stand, race a 90 m balcony over
  the crowd — and clear its gap jump, 7 m above the seats — then swing through the corner over the
  seats and back onto the South stand.
- **Stair Run**: the start line is the top step of a 47-step concrete staircase built into the East
  stand (the seats under it removed); bounce down it onto the pitch, sweep diagonally across the
  field past a sweeper arm, U-turn by the south goal, loop in front of the main stand, run past the
  north goal and climb back up the stand to a hairpin over the top rows.
- **Pitch Circuit** (the original): kicker, footballs, a ramp over the East stand, stair hops down an
  aisle, a ski jump and the loop.

Plus pickups (lightning boost, bouncy bomb, oil slick, electric pulse) and stunt
points. All sound — engines, crowd, effects and the chiptune loop — is synthesised in the browser.
The stadium is the Bloomfield 2019 Blender model (converted to `public/models/`); cars, track
pieces and textures are procedural.

## Run

```bash
npm install
npm run dev        # http://localhost:5180
```

Other scripts: `npm run typecheck`, `npm run build`, `npm run sim` (headless handling numbers:
acceleration, turning radius, drift, jumps, wall slides, ramps), `npm run deploy:pages` (build → `gh-pages` branch).
The game opens on a start screen (tap to start — this also unlocks audio; **Play fullscreen** where
the browser allows it) and a short fly-through of the stadium (any key / tap skips it).
**iPhone:** Safari can't make a web page fullscreen; use *Share → Add to Home Screen* and launch it
from the icon for a real fullscreen, landscape game (web-app manifest + icons in `public/`,
regenerate the icons with `node tools/make-icons.mjs`).

URL options: `?skip=1` (straight to the menu), `?touch=1` / `?touch=0` force the on-screen controls, `?quality=low|high`,
`?track=tour|stairs|classic`.

**Steering: Assisted** (default) follows the curve when you're not steering and eases you off the
walls; **Pro** is raw. **Opponents: Invisible** (default) — the AI still race and rank, but you can't
see or touch them and every item box is a lightning boost; **Visible** is the full pack with items.

### Handling

Kart-style and deterministic (`vehicle/ArcadeCar.ts`, tunables in `vehicle/CarConfig.ts`): the car is
a capsule that always sits on the surface under it (it can't flip; loops and banks just work), the
heading turns at a speed-dependent rate (1.75 m circle at walking pace, ~10 m at top speed), grip
bleeds off sideways speed, walls are glanced along instead of stopping you. Hold **DRIFT** (Space /
A) while steering at speed to slide; let go after a long drift for a mini-turbo.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake-reverse | W S / ↑ ↓ | RT / LT |
| Steer | A D / ← → | left stick |
| Handbrake | Space | A |
| Use pickup | Shift / E | B / X |
| Reset car | R | Y |
| Camera (chase / bumper) | C | Back |
| Pause (resume / restart / menu) | Esc / P | Start |
| Menus | arrows + Enter | d-pad / stick + A, B = back |
| Debug readout (+ checkpoints) | F3 or ` | — |

## The stadium model

`public/models/` is generated from `Bloomfield_2019.blend` by Blender 5.x:

```bash
blender -b Bloomfield_2019.blend --python tools/export_blend.py -- public/models
```

It turns the model so the pitch runs along X, drops what the game replaces (pitch turf and
markings, perimeter panels, the 1.8M-triangle seat shells), writes the 28,218 seat positions to
`seats.bin` (drawn as instanced low-poly seats), joins meshes per stand × material, exports a
Draco-compressed `bloomfield.glb` plus `bloomfield_collision.glb` (steps, aisles, rails…), and
surveys aisles/step profiles into `tools/stadium_info.json`.

## The lap

Pitch along X (north = +X, skyline side), West main stand at z < 0, East stand at z > 0:
start on the west touchline → kicker → sweep into the north box (**footballs: kick them in for a
GOAL**) → up a plywood ramp over the East stand seats → banked hairpin under the gallery → down a
real aisle (hops on every step) → ski-jump over the front glass and the ad boards → boost → the
orange **loop** on the halfway line → slalom → U-turn in front of the south goal.

Stunt points: air time, LOOP BONUS, GOAL, DRIFT BOOST (hold a slide, release it cleanly), item hits.
Rainbow boxes give one item (odds favour whoever is behind). Through the loop the car drives
itself — just hold the gas.
Yellow chevron pads are boosts; braking cancels a boost.

## Layout

```
src/
  main.ts                 boot (loads Rapier wasm, starts Game)
  game/Game.ts            fixed-step loop (120 Hz physics, interpolated rendering), wiring
  core/Input.ts           keyboard + gamepad → DriveInput / one-shot actions
  physics/Physics.ts      world creation, static collider helpers
  vehicle/CarConfig.ts    ALL handling tunables (SI units)
  vehicle/ArcadeCar.ts    kart-style car: surface-aligned capsule, heading/speed/grip model, drift
  vehicle/CarVisual.ts    CarVisual interface (swap in GLTF later) + liveries
  vehicle/ProceduralBuggy.ts  procedural toy buggy mesh
  camera/CameraRig.ts     spring-damped chase cam + bumper cam
  render/Environment.ts   sky dome, sun + shadow frustum that follows the player
  render/textures.ts      canvas-generated textures
  render/StrutBatch.ts    cylinders between point pairs → one InstancedMesh (truss, rails)
  world/LevelBuilder.ts   mesh + collider pairs (boxes, kicker wedges, bumps)
  world/stadium/
    layout.ts             stadium dimensions (matching the model)
    Stadium.ts            assembles everything
    StadiumModel.ts       loads the GLBs + seats.bin, tunes materials, builds colliders and seats
    Pitch.ts              striped grass, markings, goal colliders
    Boards.ts             red advertising boards (merged meshes + colliders)
    TvFeed.ts             broadcast camera → the model's LED screens
    Skyline.ts            Tel Aviv–style towers + low-rise city
  track/
    trackData.ts          ← the Pitch Circuit: spline control points + features by world position
    tourData.ts           ← the Stadium Tour (heights over the stands surveyed from the collision mesh)
    stairData.ts          ← the Stair Run (staircase, climb and hairpin between the East-stand aisles)
    tracks.ts             track registry (menu choice)
    Track.ts              sampled closed spline: frames, width, projection, grid slots
    TrackBuilder.ts       water barriers, kickers, start line/gantry/grid, features → pieces
    TrackPieces.ts        plywood decks, the loop + A-frames, ramps, glide slabs, walls, boost pads
    Cones.ts              knock-over cones (dynamic bodies + one InstancedMesh)
    Footballs.ts          footballs with goal-seeking kicks and goal detection
  race/RaceManager.ts     checkpoints, lap timing, standings, wrong way, safe respawns
  race/AIDriver.ts        rival drivers: lane pursuit, speed planning, rubber band, stuck recovery
  race/Items.ts           pickup boxes, the four items, AI item tactics
  audio/Sound.ts          Web Audio synthesis: engines, tyres, crowd, effects, music
  render/Particles.ts     pooled point-sprite particles (smoke, flames, sparks, confetti)
  ui/Menu.ts              title screen + pause menu, saved settings
  ui/Intro.ts             start gate (fullscreen / iPhone home-screen tip) + intro captions
  track/Obstacles.ts      sweeper arms (kinematic), mud, bollards
  dev/devTools.ts         window.__test (dev only): pilot + headless lap runner
  physics/groups.ts       collision groups (wheel rays skip cones; cars detect cones by sensor)
  ui/Hud.ts               DOM HUD
scripts/sim.ts            headless handling numbers (accel, braking, cornering, jumps)
```

World frame: pitch centre at the origin, touchlines along X, long stands at ±Z, goal ends at ±X,
skyline beyond +X. Scale: metres.

## Editing the track

`src/track/trackData.ts` holds the closed spline (`CONTROL_POINTS`, driven in list order) and
`FEATURES` (start, kickers, slalom, cone rows, barrier gaps, reserved zones). Features are anchored
by world `[x, z]` and snap to the spline, so reshaping the line drags them along. Press **F3** in game
to see the centre line and your distance along the track. The car is ~0.5 m long and tops out near 18 m/s (~41 mph) — real RC scale,
which is what makes the stadium feel enormous.

## Phases

1. ✅ Project setup, car on a flat plane with tuned physics
2. ✅ Stadium environment
3. ✅ Track spline, barriers, cones, ramps
4. ✅ Loop + staircase (+ the pitch as part of the track, footballs, boosts, drift boost)
5. ✅ Checkpoints, laps, positions, HUD (countdown, results, restart with Enter)
6. ✅ AI — 7 rivals with personalities, rubber band, item tactics
7. ✅ Pickups — lightning boost, bouncy bomb, oil slick, electric pulse
8. ✅ Menus (demo race behind the title, options, pause, results), synthesised audio, particles,
   camera shake, adaptive resolution to hold 60 fps
