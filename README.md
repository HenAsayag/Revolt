# Bloomfield RC

Toy RC-car racing inside Bloomfield Stadium (Tel Aviv). Vite + TypeScript + three.js + Rapier.
The stadium is the Bloomfield 2019 Blender model (converted to `public/models/`); cars, track
pieces and textures are procedural.

## Run

```bash
npm install
npm run dev        # http://localhost:5180
```

Other scripts: `npm run typecheck`, `npm run build`, `npm run sim` (headless handling tests).

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake-reverse | W S / ↑ ↓ | RT / LT |
| Steer | A D / ← → | left stick |
| Handbrake | Space | A |
| Use pickup | Shift / E | B / X |
| Reset car | R | Y |
| Camera (chase / bumper) | C | Back |
| Restart race | Enter | Start |
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

Stunt points: air time, LOOP BONUS, GOAL, DRIFT BOOST (hold a slide, release it cleanly).
Yellow chevron pads are boosts; braking cancels a boost.

## Layout

```
src/
  main.ts                 boot (loads Rapier wasm, starts Game)
  game/Game.ts            fixed-step loop (120 Hz physics, interpolated rendering), wiring
  core/Input.ts           keyboard + gamepad → DriveInput / one-shot actions
  physics/Physics.ts      world creation, static collider helpers
  vehicle/CarConfig.ts    ALL handling tunables (SI units)
  vehicle/RaycastCar.ts   raycast-suspension car on a Rapier rigid body
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
    trackData.ts          ← EDIT THE TRACK HERE: spline control points + features by world position
    Track.ts              sampled closed spline: frames, width, projection, grid slots
    TrackBuilder.ts       water barriers, kickers, start line/gantry/grid, features → pieces
    TrackPieces.ts        plywood decks, the loop + A-frames, ramps, glide slabs, walls, boost pads
    Cones.ts              knock-over cones (dynamic bodies + one InstancedMesh)
    Footballs.ts          footballs with goal-seeking kicks and goal detection
  race/RaceManager.ts     checkpoints, lap timing, standings, wrong way, safe respawns
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
6. AI
7. Pickups
8. Menus, audio, polish, performance
