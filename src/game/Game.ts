import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CameraRig, type CameraTarget } from '../camera/CameraRig';
import { Input, type DriveInput } from '../core/Input';
import { QUALITY } from '../core/quality';
import { createWorld, FIXED_DT } from '../physics/Physics';
import { createSky, SKY, SunLight } from '../render/Environment';
import { Hud } from '../ui/Hud';
import { DEFAULT_CAR } from '../vehicle/CarConfig';
import { LIVERIES, type CarVisual } from '../vehicle/CarVisual';
import { ProceduralBuggy } from '../vehicle/ProceduralBuggy';
import { RaycastCar } from '../vehicle/RaycastCar';
import { buildStadium, type Stadium } from '../world/stadium/Stadium';
import type { StadiumAssets } from '../world/stadium/StadiumModel';
import { Track } from '../track/Track';
import { buildTrack, type BuiltTrack } from '../track/TrackBuilder';
import { TRACKS, type TrackDef, type TrackId } from '../track/tracks';
import { setGroundProbe } from '../track/TrackPieces';
import { formatTime, ordinal, RaceManager, type RaceEvent, type RacerProgress } from '../race/RaceManager';
import { AI_ROSTER, AIDriver } from '../race/AIDriver';
import { aiWantsToUse, ITEM_NAMES, ItemWorld, PickupBoxes, rollItem, type ItemHit, type ItemKind } from '../race/Items';
import { Sound, type SfxName } from '../audio/Sound';
import { Particles } from '../render/Particles';
import { loadSettings, Menu, type Difficulty, type Settings } from '../ui/Menu';

const MPH = 2.23694;
/** Rival pace and rubber-band strength per difficulty. */
const DIFFICULTY: Record<Difficulty, { pace: number; band: number }> = {
  easy: { pace: 0.9, band: 1.6 },
  normal: { pace: 1, band: 1 },
  hard: { pace: 1.05, band: 0.5 },
};
/** Attract-mode demo race: effectively endless. */
const DEMO_LAPS = 99;
const CONFETTI = ['#ff4d4d', '#ffd21f', '#4dff88', '#4dc3ff', '#b36bff', '#ffffff'];
/** Grid slot the player starts from (0 = pole); the AI fill the rest. */
const PLAYER_SLOT = 5;
const MAX_STEPS_PER_FRAME = 8;
/** Extra acceleration toward the loop surface, m/s² (gravity alone would need ~12 m/s at the entry). */
const LOOP_STICK = 9;
/** Speed floor on the loop while holding the gas (m/s), and the push that keeps it (m/s²). */
const LOOP_MIN_SPEED = 9.5;
const LOOP_PUSH = 14;
/** Stand-deck speed cap: lateral acceleration it allows (m/s²) and the braking it may use (m/s²). */
const DECK_GRIP = 11;
const DECK_BRAKE = 12;
/** Extra acceleration toward raised plywood surfaces (m/s²). */
const DECK_STICK = 4;
/** Loop "rails": lateral pull gains (1/s², 1/s) and cap (m/s²). */
const RAIL_K = 30;
const RAIL_D = 8;
const RAIL_MAX = 16;
/** Smart-steering strength with hands off (0..1). */
const ASSIST = 0.55;
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _v2 = new THREE.Vector2();
const _col = new THREE.Color();
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const v3 = (t: { x: number; y: number; z: number }) => new THREE.Vector3(t.x, t.y, t.z);
/** Roulette spin before an item can be used, stunt points per item hit. */
const ITEM_ROLL_SECONDS = 0.9;
const ITEM_HIT_SCORE = 150;
const BOOST_PAD_SECONDS = 1.1;
/** Guide-rail assist gains in the stand section (rad/s² per rad, per rad/s, cap). */
const GUIDE_K = 22;
const GUIDE_D = 4;
const GUIDE_MAX = 45;

/** A car plus its look, its driver (AI or the player) and its race state. */
interface Racer {
  car: RaycastCar;
  visual: CarVisual;
  /** Null for the player. */
  ai: AIDriver | null;
  progress: RacerProgress;
  /** This frame's controls. */
  input: DriveInput;
  /** Last stair step index per axle (front, rear), for the stair hops. */
  stairStep: number[];
  /** How much the "rails" hold this car right now (0 = free, 1 = the loop). */
  rail: number;
  /** Item in the slot (one per car), the roulette time left before it's usable, and time held. */
  item: ItemKind | null;
  itemRoll: number;
  itemHeld: number;
  /** Smoothed motor speed for the engine sound, particle emission accumulators, last-frame state. */
  rev: number;
  fxSmoke: number;
  fxFlame: number;
  wasAir: number;
  prevSpeed: number;
  /** Interpolated render pose. */
  renderPos: THREE.Vector3;
  renderQuat: THREE.Quaternion;
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.03, 4000);
  readonly world: RAPIER.World;
  readonly input = new Input();
  readonly rig: CameraRig;
  readonly sun: SunLight;
  readonly hud: Hud;
  readonly racers: Racer[] = [];
  readonly player: Racer;
  private readonly sky: THREE.Mesh;
  readonly stadium: Stadium;
  readonly track: Track;
  readonly trackBuild: BuiltTrack;
  readonly trackDef: TrackDef;
  /** Last known nearest track sample for the player (search hint + respawn point). */
  private playerTrackIndex = -1;
  readonly race: RaceManager;
  private readonly playerProgress: RacerProgress;
  private readonly checkpointMarkers = new THREE.Group();

  /** Test hook: when set, replaces the player's input (used for headless checks). */
  autopilot: ((car: RaycastCar, t: number) => DriveInput) | null = null;
  simTime = 0;
  private accumulator = 0;
  private lastFrame = -1;
  private fps = 60;
  private raf = 0;
  private flippedFor = 0;
  /** Stunt score (air time, loop, goals, drift boosts). */
  score = 0;
  private loopProgress = 0;
  private loopShot: THREE.Vector3 | null = null;
  /** Who last kicked each football (goals only score for the player's kicks). */
  private readonly ballKicker = new Map<number, Racer>();
  private lastDriftBoosts = 0;
  private readonly events = new RAPIER.EventQueue(true);
  /** Collider handle → racer, to attribute collision events. */
  private readonly racerByCollider = new Map<number, Racer>();
  readonly pickups: PickupBoxes;
  readonly items: ItemWorld<Racer>;
  readonly sound = new Sound();
  readonly menu: Menu;
  /** 'menu' = title screen over an AI demo race; 'paused' freezes the race under the pause menu. */
  mode: 'menu' | 'race' | 'paused' = 'menu';
  private difficulty = DIFFICULTY.normal;
  /** Smart steering for the player (menu: Steering → Assisted). */
  assistOn = true;
  /** Drives the player's car in the demo race; the camera cuts between cars. */
  private readonly demoDriver: AIDriver;
  private demoFocus!: Racer;
  private demoCut = 0;
  private readonly smoke: Particles;
  private readonly glow: Particles;
  private readonly confetti: Particles;
  /** Adaptive resolution: target and current pixel ratio, and the 1 s check. */
  private readonly prTarget = Math.min(window.devicePixelRatio, QUALITY.pixelRatioCap);
  private pr = this.prTarget;
  private perfTimer = 0;
  private perfGood = 0;
  private readonly chase = { distance: 0, height: 0 };
  /** Dev/test counters: items used and hits landed, by kind (reset each race). */
  itemStats = { used: {} as Record<string, number>, hits: {} as Record<string, number> };

  constructor(canvas: HTMLCanvasElement, hudRoot: HTMLElement, assets: StadiumAssets) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: QUALITY.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatioCap));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Shadows are rendered once per frame for the main view; the TV feed reuses them.
    this.renderer.shadowMap.autoUpdate = false;

    this.scene.background = SKY.horizon.clone();
    this.scene.fog = new THREE.Fog(SKY.horizon.clone(), 300, 3200);
    this.sky = createSky();
    this.scene.add(this.sky);
    this.sun = new SunLight(this.scene, { mapSize: QUALITY.shadowMapSize });

    this.world = createWorld();
    this.stadium = buildStadium(this.scene, this.world, assets);
    // Which lap: the saved menu choice (or ?track=tour|classic).
    const urlTrack = new URLSearchParams(location.search).get('track') as TrackId | null;
    this.trackDef = TRACKS[urlTrack && urlTrack in TRACKS ? urlTrack : loadSettings().track];
    // Deck posts stand on whatever is below them (seat treads, the pitch): ask the stadium colliders.
    this.world.step();
    setGroundProbe((x, y, z) => {
      const hit = this.world.castRay({ origin: { x, y, z }, dir: { x: 0, y: -1, z: 0 } } as RAPIER.Ray, 40, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
      return hit ? y - hit.timeOfImpact : 0;
    });
    this.track = new Track(this.trackDef.points, 0.5, this.trackDef.width);
    this.trackBuild = buildTrack(this.scene, this.world, this.track, this.trackDef.features);
    if (this.trackBuild.loopSpan) {
      // Side-on to the loop, so the whole ring (and the car going round it) is in view.
      const [s0, s1] = this.trackBuild.loopSpan;
      const mid = this.track.sampleAt(s0 + this.track.forwardDistance(s0, s1) / 2); // top of the loop
      const entry = this.track.sampleAt(s0);
      this.loopShot = new THREE.Vector3(entry.pos.x, 0, mid.pos.z).addScaledVector(entry.right, 7.5);
      this.loopShot.y = 2.4;
    }
    const grid = this.track.gridSlots(this.trackBuild.startS, 8);
    // Player mid-grid; the AI fill the other slots (fastest nearest the front).
    this.player = this.addRacer(0, grid[PLAYER_SLOT].pos, grid[PLAYER_SLOT].yaw);
    const aiSlots = grid.map((_, i) => i).filter((i) => i !== PLAYER_SLOT);
    // AI keep to the centre line over the boost pads and through the loop.
    const centre: [number, number][] = this.trackBuild.pads.meshes.map((m) => {
      const s = this.track.project(m.position).s;
      return [s - 5, s + 1];
    });
    if (this.trackBuild.loopSpan) centre.push([this.trackBuild.loopSpan[0] - 8, this.trackBuild.loopSpan[1]]);
    AI_ROSTER.forEach((p, k) => {
      const slot = grid[aiSlots[k]];
      const r = this.addRacer(k + 1, slot.pos, slot.yaw);
      r.ai = new AIDriver(r.car, this.track, p, centre);
    });

    // One step so scene queries see the static colliders, then lay out the checkpoints.
    this.world.step();
    const noRespawn: [number, number][] = [];
    const stands = this.trackBuild.zones.stands;
    // Stuck anywhere on the stand section (ramp, deck, steps, ski jump, flight) → back to the ramp foot.
    if (stands) noRespawn.push([stands[0] - 2, stands[1] + 12]);
    // In (or just before) the loop → back before its boost pad so there's speed for another go.
    const loop = this.trackBuild.loopSpan;
    if (loop) noRespawn.push([loop[0] - 14, loop[1]]);
    this.race = new RaceManager(this.track, this.trackBuild.startS, 3, this.world, noRespawn);
    for (const r of this.racers) r.progress = this.race.addRacer(r.car, r.ai ? r.ai.p.name : 'YOU');
    this.playerProgress = this.player.progress;
    this.buildCheckpointMarkers();
    // Item boxes: rows across the flat, wide stretches (clear of jumps, cones, the loop and the stands).
    this.pickups = new PickupBoxes(this.scene, this.world, this.track, this.trackDef.pickups.map((p) => (typeof p === 'number' ? p : this.track.sAt(p))));
    this.items = new ItemWorld(this.scene, this.world, this.racers);
    const sightRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    this.rig = new CameraRig(this.camera, (from, to) => {
      const d = to.clone().sub(from);
      const len = d.length();
      if (len < 1e-3) return null;
      d.divideScalar(len);
      sightRay.origin = { x: from.x, y: from.y, z: from.z };
      sightRay.dir = { x: d.x, y: d.y, z: d.z };
      const hit = this.world.castRay(
        sightRay, len, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      );
      return hit ? hit.timeOfImpact / len : null;
    });
    this.hud = new Hud(hudRoot);
    this.hud.onResultAction = (a) => {
      this.sound.play('click');
      if (a === 'again') this.beginRace();
      else this.enterMenu();
    };

    const lowQ = QUALITY.name === 'low';
    this.smoke = new Particles(this.scene, lowQ ? 260 : 600, { soft: true });
    this.glow = new Particles(this.scene, lowQ ? 160 : 360, { additive: true, soft: true });
    this.confetti = new Particles(this.scene, 260, { soft: false });
    this.items.onFx = (kind, at, by) => this.onItemFx(kind, at, by);

    this.demoDriver = new AIDriver(this.player.car, this.track, { name: 'YOU', skill: 0.95, lane: 0.1, seed: 11 });
    this.chase.distance = this.rig.distance;
    this.chase.height = this.rig.height;
    this.menu = new Menu(document.body, {
      start: (st) => this.beginRace(st),
      resume: () => this.resume(),
      restart: () => this.beginRace(),
      quit: () => this.enterMenu(),
      changed: (st) => this.sound.setVolumes({ music: st.music, sfx: st.sfx }),
      click: () => this.sound.play('click'),
    });
    this.sound.setVolumes({ music: this.menu.settings.music, sfx: this.menu.settings.sfx });
    // Audio may only start from a user gesture.
    const unlock = () => this.sound.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'race' && this.race.phase !== 'finished') this.pause();
    });

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.enterMenu();
  }

  // ------------------------------------------------------------------------------------------
  // Modes

  /** Title screen over an endless AI demo race. */
  enterMenu(): void {
    this.mode = 'menu';
    document.body.classList.add('in-menu');
    document.body.classList.remove('paused');
    this.race.laps = DEMO_LAPS;
    this.difficulty = DIFFICULTY.normal;
    this.pickups.setEnabled(true);
    this.restartRace();
    this.race.skipCountdown();
    this.demoDriver.reset();
    this.cutDemoCamera();
    this.rig.distance = 2.3;
    this.rig.height = 0.85;
    this.menu.show('title');
    this.sound.setMusicMode('menu');
  }

  /** Start (or restart) a real race with the given settings. */
  beginRace(st: Settings = this.menu.settings): void {
    this.mode = 'race';
    document.body.classList.remove('in-menu', 'paused');
    this.menu.hide();
    this.race.laps = st.laps;
    this.difficulty = DIFFICULTY[st.difficulty];
    this.assistOn = st.assist;
    this.pickups.setEnabled(st.items);
    this.rig.distance = this.chase.distance;
    this.rig.height = this.chase.height;
    this.restartRace();
    this.demoDriver.reset();
    this.sound.setMusicMode('race');
  }

  pause(): void {
    if (this.mode !== 'race') return;
    this.mode = 'paused';
    document.body.classList.add('paused');
    this.menu.show('pause');
    this.sound.quiet();
    this.sound.setMusicMode('menu');
  }

  resume(): void {
    if (this.mode !== 'paused') return;
    this.mode = 'race';
    document.body.classList.remove('paused');
    this.menu.hide();
    this.sound.setMusicMode('race');
  }

  /** The car the camera (and the engine sound) follows. */
  private focusRacer(): Racer {
    return this.mode === 'menu' ? this.demoFocus : this.player;
  }

  private cutDemoCamera(): void {
    const pick = this.racers[Math.floor(Math.random() * this.racers.length)];
    this.demoFocus = pick === this.demoFocus ? this.racers[(this.racers.indexOf(pick) + 1) % this.racers.length] : pick;
    this.demoCut = 6 + Math.random() * 3;
    this.rig.snap();
  }

  private trackIndexOf(r: Racer): number {
    if (r === this.player) return this.playerTrackIndex;
    return r.ai ? r.ai.hint : -1;
  }

  /** Distance attenuation and stereo pan for a sound at `pos`, heard from the camera. */
  private spatial(pos: THREE.Vector3, near = 4): { gain: number; pan: number } {
    _tmp.subVectors(pos, this.camera.position);
    const d = _tmp.length();
    const right = _tmp2.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    return { gain: 1 / (1 + (d / near) ** 2), pan: d > 0.01 ? (_tmp.dot(right) / d) * 0.7 : 0 };
  }

  private sfx(name: SfxName, pos?: THREE.Vector3, gain = 1): void {
    if (this.mode === 'paused') return;
    const menuScale = this.mode === 'menu' ? 0.4 : 1;
    if (!pos) {
      this.sound.play(name, { gain: gain * menuScale });
      return;
    }
    const sp = this.spatial(pos);
    this.sound.play(name, { gain: gain * sp.gain * menuScale, pan: sp.pan });
  }

  private addRacer(liveryIndex: number, pos: THREE.Vector3, yaw: number): Racer {
    const car = new RaycastCar(this.world, DEFAULT_CAR, pos, yaw);
    const visual = new ProceduralBuggy(DEFAULT_CAR, LIVERIES[liveryIndex % LIVERIES.length]);
    this.scene.add(visual.root);
    const racer: Racer = {
      car, visual, ai: null, progress: null!, input: { throttle: 0, steer: 0, handbrake: true }, stairStep: [-1, -1], rail: 0, item: null, itemRoll: 0, itemHeld: 0,
      rev: 0, fxSmoke: 0, fxFlame: 0, wasAir: 0, prevSpeed: 0,
      renderPos: car.pos.clone(), renderQuat: car.quat.clone(),
    };
    this.racers.push(racer);
    for (const c of car.colliders) this.racerByCollider.set(c.handle, racer);
    this.racerByCollider.set(car.sensor.handle, racer);
    return racer;
  }

  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = -1;
    const loop = (now: number) => {
      if (!this.running) return;
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    this.renderer.dispose();
  }

  /** One rendered frame. Public so tests can drive time manually when rAF is throttled. */
  frame(nowMs: number): void {
    const dt = this.lastFrame < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (nowMs - this.lastFrame) / 1000));
    this.lastFrame = nowMs;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
    this.update(dt);
    this.render(dt);
    this.adaptResolution(dt);
  }

  /** Hold 60 fps: drop the render resolution when frames run long, creep back up when there's headroom. */
  private adaptResolution(dt: number): void {
    if (document.hidden || (this.perfTimer += dt) < 1) return;
    this.perfTimer = 0;
    let pr = this.pr;
    if (this.fps < 48 && pr > 0.6) {
      pr = Math.max(0.6, pr * 0.85);
      this.perfGood = 0;
    } else if (this.fps > 58 && pr < this.prTarget) {
      if (++this.perfGood >= 4) {
        pr = Math.min(this.prTarget, pr * 1.1);
        this.perfGood = 0;
      }
    } else {
      this.perfGood = 0;
    }
    if (pr !== this.pr) {
      this.pr = pr;
      this.renderer.setPixelRatio(pr);
      this.resize();
    }
  }

  // ------------------------------------------------------------------------------------------
  // Feel: particles and sound

  /** Tyre smoke, boost flames, landing dust and impact thumps for every car. */
  private carEffects(dt: number): void {
    const q = QUALITY.name === 'low' ? 0.5 : 1;
    const cam = this.camera.position;
    for (const r of this.racers) {
      const c = r.car;
      const near = c.pos.distanceToSquared(cam) < 35 * 35;
      // Sliding (drift, handbrake, spin-out): smoke from the rear tyres.
      const slide = c.groundedCount >= 2 && c.speed > 3
        ? Math.max(0, Math.abs(c.slipAngle) - 0.18) * 2.2 + (r.input.handbrake && c.speed > 5 ? 0.5 : 0) + (c.stunTime > 0 ? 0.6 : 0)
        : 0;
      r.fxSmoke = near ? r.fxSmoke + Math.min(1.5, slide) * 40 * q * dt : 0;
      while (r.fxSmoke >= 1) {
        r.fxSmoke -= 1;
        const rear = c.wheels.filter((w) => !w.front && w.grounded);
        const w = rear[Math.floor(Math.random() * rear.length)];
        if (!w) break;
        const v = c.body.linvel();
        this.smoke.emit({
          pos: _tmp.copy(w.contactPoint).addScaledVector(c.up, 0.03),
          vel: _tmp2.set(v.x * 0.15 + rand(-0.3, 0.3), 0.25 + Math.random() * 0.3, v.z * 0.15 + rand(-0.3, 0.3)),
          color: _col.setRGB(0.93, 0.93, 0.95), size: 0.12, grow: 0.9, life: rand(0.8, 1.2), alpha: 0.5, drag: 1.5, gravity: -0.15,
        });
      }
      // Boost: a flame from the back.
      r.fxFlame = near && c.boostTime > 0 ? r.fxFlame + 70 * q * dt : 0;
      while (r.fxFlame >= 1) {
        r.fxFlame -= 1;
        const v = c.body.linvel();
        this.glow.emit({
          pos: _tmp.copy(c.pos).addScaledVector(c.fwd, -0.27).addScaledVector(c.up, 0.03 + rand(-0.015, 0.015)).addScaledVector(c.left, rand(-0.03, 0.03)),
          vel: _tmp2.set(v.x * 0.85, v.y * 0.85, v.z * 0.85).addScaledVector(c.fwd, -rand(1.5, 3)),
          color: _col.set(Math.random() < 0.6 ? '#ff8a1f' : '#ffe45a'), size: rand(0.07, 0.11), grow: -0.25, life: rand(0.12, 0.2), alpha: 0.9, drag: 3,
        });
      }
      // Landing after a proper hop: a puff of turf and a thump.
      if (r.wasAir > 0.35 && c.airTime === 0 && c.groundedCount > 0) {
        if (near) {
          for (let k = 0; k < 12 * q; k++) {
            const a = Math.random() * Math.PI * 2;
            this.smoke.emit({
              pos: _tmp.copy(c.pos).addScaledVector(c.up, -0.08),
              vel: _tmp2.set(Math.cos(a) * rand(1, 2.4), rand(0.2, 0.7), Math.sin(a) * rand(1, 2.4)),
              color: _col.set('#b8c99a'), size: 0.12, grow: 0.7, life: rand(0.5, 0.8), alpha: 0.4, drag: 3,
            });
          }
        }
        this.sfx('land', c.pos, Math.min(1, r.wasAir));
        if (r === this.focusRacer()) this.rig.shake(Math.min(0.03, r.wasAir * 0.02));
      }
      // Sudden stop (a wall, a car): thump, sparks, a little shake.
      const drop = r.prevSpeed - c.speed;
      if (drop > 2.6 && c.stunTime <= 0 && r.wasAir === 0) {
        const g = Math.min(1, drop / 8);
        this.sfx('hit', c.pos, g);
        if (near) {
          for (let k = 0; k < 8; k++) {
            this.glow.emit({
              pos: _tmp.copy(c.pos).addScaledVector(c.fwd, 0.2), vel: _tmp2.set(rand(-2, 2), rand(0.5, 2), rand(-2, 2)),
              color: _col.set('#ffd98a'), size: 0.04, life: rand(0.2, 0.35), gravity: 6,
            });
          }
        }
        if (r === this.focusRacer()) this.rig.shake(0.03 * g);
      }
      r.wasAir = c.airTime;
      r.prevSpeed = c.speed;
    }
  }

  private throwConfetti(): void {
    const at = this.player.car.pos;
    for (let k = 0; k < 220; k++) {
      this.confetti.emit({
        pos: _tmp.copy(at).add(_tmp2.set(rand(-1.5, 1.5), rand(1.2, 2.2), rand(-1.5, 1.5))),
        vel: _tmp2.set(rand(-1.5, 1.5), rand(0.5, 3), rand(-1.5, 1.5)),
        color: _col.set(CONFETTI[k % CONFETTI.length]), size: rand(0.03, 0.06), life: rand(2.5, 4), gravity: 1.6, drag: 1.4,
      });
    }
    this.sound.cheer(1.3);
  }

  /** Engines (the followed car + the three nearest others) and tyre squeal. */
  private updateAudio(dt: number): void {
    if (!this.sound.ctx) return;
    if (this.mode === 'paused') {
      this.sound.quiet();
      return;
    }
    const focus = this.focusRacer();
    const cam = this.camera.position;
    const others = this.racers
      .filter((r) => r !== focus)
      .map((r) => ({ r, d: r.car.pos.distanceTo(cam) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    const menuScale = this.mode === 'menu' ? 0.45 : 1;
    [{ r: focus, d: 0 }, ...others].forEach(({ r, d }, i) => {
      const c = r.car;
      const spin = c.groundedCount > 0 ? Math.min(1.1, Math.abs(c.forwardSpeed) / c.cfg.maxSpeed) : Math.max(r.rev * 0.97, Math.abs(r.input.throttle));
      r.rev += (spin + (c.boostTime > 0 ? 0.15 : 0) - r.rev) * (1 - Math.exp(-dt * 8));
      const load = c.stunTime > 0 ? 0 : Math.abs(r.input.throttle);
      const gain = (i === 0 ? 1 : 1 / (1 + (d / 3) ** 2)) * menuScale;
      this.sound.setEngine(i, r.rev, load, gain, i === 0 ? 0 : this.spatial(c.pos).pan);
    });
    const c = focus.car;
    const skid = c.groundedCount >= 2 && c.speed > 3
      ? Math.max(0, Math.abs(c.slipAngle) - 0.15) * 3 + (focus.input.handbrake && c.speed > 4 ? 0.4 : 0) + (c.stunTime > 0 ? 0.5 : 0)
      : 0;
    this.sound.setSkid(skid * menuScale);
  }

  /**
   * Test hook: advance the simulation `seconds` without rendering (60 Hz frames), stopping
   * early when `until` returns true. Returns the simulated time actually advanced.
   */
  simulate(seconds: number, until?: () => boolean): number {
    const t0 = this.simTime;
    for (let i = 0, n = Math.round(seconds * 60); i < n; i++) {
      this.update(1 / 60);
      if (until?.()) break;
    }
    return this.simTime - t0;
  }

  private update(dt: number): void {
    this.input.poll();
    const act = this.input.actions;
    if (this.mode !== 'race') {
      // Gamepad in menus (the keyboard and mouse talk to the menu directly).
      if (act.nav) this.menu.nav(act.nav);
      if (act.accept) this.menu.activate();
      if (act.back || (this.mode === 'paused' && act.pause)) this.menu.back();
      if (this.mode === 'menu' && act.confirm) this.menu.activate();
      if (this.mode === 'paused') return;
    } else {
      this.handleActions();
    }
    const allCars = this.racers.map((r) => r.car);
    const demo = this.mode === 'menu';
    const aiCtx = (r: Racer) => ({
      gapToPlayer: demo ? 0 : r.progress.progress - this.playerProgress.progress,
      others: allCars,
      racing: this.race.racing,
      pace: this.difficulty.pace,
      band: this.difficulty.band,
    });
    // Past the flag (or in the demo) the player's car drives itself: a lap of honour.
    const selfDrive = demo || this.playerProgress.finished;
    const drive = this.autopilot
      ? this.autopilot(this.player.car, this.simTime)
      : selfDrive
        ? this.demoDriver.drive(dt, aiCtx(this.player))
        : this.input.drive;
    const countdown = this.race.phase === 'countdown';
    for (const r of this.racers) {
      let d = drive;
      if (r.ai) {
        d = r.ai.drive(dt, aiCtx(r));
        // Finished AI cruise on at an easy pace.
        if (r.progress.finished) d = { throttle: Math.min(d.throttle, 0.35), steer: d.steer, handbrake: false };
      }
      if (r === this.player && this.assistOn && !selfDrive) d = { ...d, steer: this.assistSteer(r, d) };
      // Grid hold during the countdown: steer all you like, but the handbrake is on.
      r.input = countdown ? { throttle: 0, steer: d.steer, handbrake: true } : { ...d, steer: this.railSteer(r, d.steer) };
    }

    const pc = this.player.car;
    const wasAirborne = pc.airTime;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      for (const r of this.racers) r.car.step(FIXED_DT, r.input);
      this.world.step(this.events);
      this.handleCollisions();
      for (const r of this.racers) r.car.postStep();
      this.accumulator -= FIXED_DT;
      this.simTime += FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // don't spiral after a hitch
    if (steps > 0) {
      this.trackBuild.cones.sync();
      this.trackBuild.balls.sync();
    }
    let proj = this.track.project(pc.pos, this.playerTrackIndex);
    if (proj.distance > 6) proj = this.track.project(pc.pos); // lost the thread (teleport, big jump)
    this.playerTrackIndex = proj.index;
    this.updateSetPieces(dt);
    for (const e of this.race.update(dt)) this.onRaceEvent(e);
    this.updateItems(dt);

    this.carEffects(dt);
    if (selfDrive && this.demoDriver.wantsRespawn && !this.autopilot) {
      this.respawn(this.player);
      this.demoDriver.reset();
    }
    if (demo && (this.demoCut -= dt) <= 0) this.cutDemoCamera();
    // Landed after a real jump → pop-up + stunt points.
    if (wasAirborne > 0 && pc.airTime === 0 && pc.lastAirTime >= 0.6) {
      this.hud.flash('AIR TIME', `${pc.lastAirTime.toFixed(1)}s`);
      this.addScore(Math.round(pc.lastAirTime * 100));
    }
    // Fell out of the world.
    if (pc.pos.y < -10) this.resetPlayer();
    for (const r of this.racers) {
      if (r.ai && (r.ai.wantsRespawn || r.car.pos.y < -10)) this.respawn(r);
    }
    // Stuck on its roof → remind the player about reset.
    this.flippedFor = pc.isUpsideDown && pc.speed < 1 ? this.flippedFor + dt : 0;
    if (this.flippedFor > 1.2) {
      this.hud.flash('FLIPPED', 'PRESS R', 1.2);
      this.flippedFor = -1.5;
    }
  }

  private onRaceEvent(e: RaceEvent): void {
    if (this.mode !== 'race') return;
    const mine = 'racer' in e && e.racer === this.playerProgress;
    switch (e.type) {
      case 'count':
        this.hud.countdown(String(e.n));
        this.sfx('count');
        break;
      case 'go':
        this.hud.countdown('GO!');
        this.sfx('go');
        break;
      case 'lap':
        if (mine) {
          this.hud.flash(e.best && e.lap > 1 ? 'BEST LAP' : `LAP ${e.lap}`, formatTime(e.time), 2);
          if (e.lap < this.race.laps) this.sfx('lap');
        }
        break;
      case 'finalLap':
        if (mine) this.later(1800, () => {
          this.hud.flash('FINAL LAP', '', 1.6);
          this.sfx('finalLap');
          this.sound.cheer(0.6);
        });
        break;
      case 'finish':
        if (mine) {
          this.hud.flash('FINISH!', `${e.place}${ordinal(e.place)}`, 2.5);
          this.sfx('finish');
          this.throwConfetti();
          this.later(1500, () => this.showResults());
        } else if (this.playerProgress.finished) {
          this.showResults(); // someone else crossed the line: refresh the table
        }
        break;
      case 'wrongWay':
        if (mine) {
          this.hud.banner('WRONG WAY', 1.6);
          this.sfx('wrong');
        }
        break;
    }
  }

  private showResults(): void {
    const rows = this.race.standings().map((r, i) => ({
      place: `${i + 1}${ordinal(i + 1)}`,
      name: r.name,
      time: r.finished ? formatTime(r.finishTime) : '—',
      best: r.lapTimes.length ? formatTime(Math.min(...r.lapTimes)) : '—',
      stunts: r === this.playerProgress ? this.score.toLocaleString('en-US') : '—',
      isPlayer: r === this.playerProgress,
    }));
    this.hud.showResults(rows, this.input.touch ? '' : 'ENTER: race again');
  }

  /** Race number, so delayed pop-ups from a previous race never fire into the next one. */
  private raceId = 0;

  private later(ms: number, fn: () => void): void {
    const id = this.raceId;
    setTimeout(() => id === this.raceId && fn(), ms);
  }

  /** Everyone back to the grid, props reset, countdown again. */
  restartRace(): void {
    this.raceId++;
    const grid = this.track.gridSlots(this.trackBuild.startS, 8);
    const aiSlots = grid.map((_, i) => i).filter((i) => i !== PLAYER_SLOT);
    let k = 0;
    for (const r of this.racers) {
      const slot = grid[r.ai ? aiSlots[k++] : PLAYER_SLOT];
      r.car.reset(slot.pos, slot.yaw);
      r.ai?.reset();
      r.stairStep = [-1, -1];
    }
    this.ballKicker.clear();
    this.trackBuild.cones.reset();
    this.trackBuild.balls.reset();
    this.items.clear();
    this.smoke.clear();
    this.glow.clear();
    this.confetti.clear();
    this.itemStats = { used: {}, hits: {} };
    this.pickups.reset();
    for (const r of this.racers) {
      r.item = null;
      r.itemRoll = r.itemHeld = 0;
      r.wasAir = r.prevSpeed = 0;
    }
    this.race.restart();
    this.score = 0;
    this.hud.setScore(0);
    this.hud.hideResults();
    this.loopProgress = 0;
    this.lastDriftBoosts = this.player.car.driftBoosts;
    this.playerTrackIndex = -1;
    this.rig.snap();
  }

  /** Small cyan posts at each checkpoint, visible with the F3 debug view. */
  private buildCheckpointMarkers(): void {
    const mat = new THREE.MeshBasicMaterial({ color: '#3fe6ff' });
    const geo = new THREE.CylinderGeometry(0.03, 0.03, 1.2, 6).translate(0, 0.6, 0);
    for (const cp of this.race.checkpoints) {
      const smp = this.track.samples[cp.index];
      for (const side of [-1, 1]) {
        const m = new THREE.Mesh(geo, mat);
        m.position.copy(smp.pos).addScaledVector(smp.right, side * (smp.width / 2 + 0.05));
        this.checkpointMarkers.add(m);
      }
    }
    this.checkpointMarkers.visible = false;
    this.scene.add(this.checkpointMarkers);
  }

  private addScore(points: number): void {
    this.score += points;
    this.hud.setScore(this.score);
  }

  /** Loop grip + LOOP BONUS, goals, drift-boost pop-ups. */
  private updateSetPieces(dt: number): void {
    const stands = this.trackBuild.zones.stands;
    for (const r of this.racers) {
      const c = r.car;
      const idx = r === this.player ? this.playerTrackIndex : r.ai!.hint;
      const at = this.track.samples[Math.max(0, idx)];
      this.stairHops(c, at.s, r.stairStep);
      if (stands && this.track.forwardDistance(stands[0], at.s) <= this.track.forwardDistance(stands[0], stands[1])) {
        this.guideAlong(c, at, dt);
        this.deckGovernor(c, at.s, dt);
      }
      // Loop run-in and ring: a slot-car pull onto the centre line (see railSteer).
      if (r.rail >= 0.7) {
        this.railPull(c, at, dt);
        this.guideAlong(c, at, dt);
      }
      // Inside the loop: press the car onto the surface (only while it's actually on it).
      // Raised plywood (decks, ramps): a little extra press-down so crests don't launch you off the edge.
      c.surfaceStick = at.loop
        ? c.groundedCount >= 2 ? LOOP_STICK : 2
        : at.pos.y > 0.3 && c.groundedCount >= 2 ? DECK_STICK : 0;
      // Holding the gas always carries you round the loop (a speed floor while on the ring).
      if (at.loop && c.groundedCount >= 2 && r.input.throttle > 0 && c.forwardSpeed < LOOP_MIN_SPEED) {
        const j = c.cfg.mass * LOOP_PUSH * dt;
        c.body.applyImpulse({ x: c.fwd.x * j, y: c.fwd.y * j, z: c.fwd.z * j }, true);
      }
    }
    const pc = this.player.car;
    const smp = this.track.samples[Math.max(0, this.playerTrackIndex)];
    const span = this.trackBuild.loopSpan;
    if (span) {
      if (smp.loop) {
        this.loopProgress = Math.max(this.loopProgress, this.track.forwardDistance(span[0], smp.s));
      } else if (this.loopProgress > 0) {
        const full = this.track.forwardDistance(span[0], span[1]);
        const justExited = this.track.forwardDistance(span[1], smp.s) < 6;
        if (justExited && this.loopProgress > full * 0.9 && pc.up.y > 0.5) {
          this.hud.flash('LOOP BONUS', '+250');
          this.addScore(250);
          if (this.mode === 'race') this.sound.cheer(0.7);
        }
        this.loopProgress = 0;
      }
    }
    for (const goal of this.trackBuild.balls.update(dt)) {
      this.sfx('goal', this.trackBuild.balls.bodies[goal.ball] ? v3(this.trackBuild.balls.bodies[goal.ball].translation()) : undefined, 1);
      if (this.ballKicker.get(goal.ball) !== this.player) continue;
      this.hud.flash('GOAL!', '+500', 2);
      this.addScore(500);
    }
    if (pc.driftBoosts !== this.lastDriftBoosts) {
      this.lastDriftBoosts = pc.driftBoosts;
      this.hud.flash('DRIFT BOOST', `${pc.lastDriftBoost.toFixed(1)}s`, 1.2);
      this.sfx('drift');
      this.sfx('boost', undefined, 0.6);
      this.addScore(Math.round(pc.lastDriftBoost * 60));
    }
  }

  /**
   * Smart steering: with no input the car follows the curve on its current line; near the edge
   * it's eased back toward the middle; the harder you steer, the less it interferes. Off while
   * handbrake-drifting, reversing, or airborne.
   */
  private assistSteer(r: Racer, input: DriveInput): number {
    const car = r.car;
    const steer = input.steer;
    const idx = this.playerTrackIndex;
    if (idx < 0 || input.handbrake || car.groundedCount < 2 || car.forwardSpeed < 2 || input.throttle < 0) return steer;
    const smp = this.track.samples[idx];
    if (smp.loop) return steer;
    const lat = _tmp.subVectors(car.pos, smp.pos).dot(smp.right);
    const room = Math.max(0.3, smp.width / 2 - 0.3);
    // How deep into the last 0.8 m before the edge (0 = clear, 1 = at the edge).
    const edge = THREE.MathUtils.clamp((Math.abs(lat) - (room - 0.8)) / 0.8, 0, 1);
    const aimLat = lat * (1 - 0.7 * edge);
    const target = this.track.pointAt(smp.s + 1.5 + car.speed * 0.22, aimLat).sub(car.pos);
    const ang = Math.atan2(target.dot(car.left), target.dot(car.fwd));
    const auto = THREE.MathUtils.clamp(-ang * 2, -1, 1);
    // Heading for the edge right now? Then the guard gets a bigger say.
    const v = car.body.linvel();
    const outward = Math.sign(lat) * (v.x * smp.right.x + v.y * smp.right.y + v.z * smp.right.z) > 0.3 ? 1 : 0;
    const w = Math.min(0.9, ASSIST * (1 - 0.7 * Math.abs(steer)) + 0.5 * edge * outward);
    return THREE.MathUtils.clamp(steer + (auto - steer) * w, -1, 1);
  }

  /**
   * "On rails" steering for the narrow set pieces. Through the loop (where the camera is side-on
   * and left/right stops meaning anything) the car steers itself; on the run-in to the loop and
   * the stand ramp the driver's input is blended with a pull toward the centre line.
   */
  private railSteer(r: Racer, steer: number): number {
    const idx = r === this.player ? this.playerTrackIndex : r.ai!.hint;
    r.rail = 0;
    if (idx < 0) return steer;
    const s = this.track.samples[idx].s;
    const within = (span: [number, number] | null | undefined, before: number, after = 0) =>
      !!span && this.track.forwardDistance(span[0] - before, s) <= this.track.forwardDistance(span[0] - before, span[1] + after);
    const loop = this.trackBuild.loopSpan;
    const stands = this.trackBuild.zones.stands;
    const car = r.car;
    let auto: number;
    if (within(loop, 8, 1)) auto = 1;
    else if (within(loop, 16)) auto = 0.7;
    else if (within(stands, 14)) auto = 0.6; // incl. the tight S-bend lining up the ramp
    else {
      car.cornerAssist = true;
      return steer;
    }
    r.rail = auto;
    // The loop wants all the speed it can get: no corner-assist lift on the run-in.
    car.cornerAssist = auto < 0.7;
    const target = this.track.pointAt(s + 1.2 + car.speed * 0.1, 0).sub(car.pos);
    const ang = Math.atan2(target.dot(car.left), target.dot(car.fwd));
    const pilot = THREE.MathUtils.clamp(-ang * 2.2, -1, 1);
    return THREE.MathUtils.clamp(pilot * auto + steer * (1 - auto), -1, 1);
  }

  /** Lateral spring-damper toward the centre line, capped (on top of the tyres' own grip). */
  private railPull(car: RaycastCar, smp: { pos: THREE.Vector3; right: THREE.Vector3 }, dt: number): void {
    if (car.groundedCount < 2) return;
    const lat = _tmp.subVectors(car.pos, smp.pos).dot(smp.right);
    const v = car.body.linvel();
    const vLat = v.x * smp.right.x + v.y * smp.right.y + v.z * smp.right.z;
    const a = THREE.MathUtils.clamp(-RAIL_K * lat - RAIL_D * vLat, -RAIL_MAX, RAIL_MAX);
    const j = car.cfg.mass * a * dt;
    car.body.applyImpulse({ x: smp.right.x * j, y: smp.right.y * j, z: smp.right.z * j }, true);
  }

  /**
   * The raised deck in the stands turns tighter than full speed allows and has nowhere to run
   * wide, so it quietly caps the speed to what the next few metres can take.
   */
  private deckGovernor(car: RaycastCar, s: number, dt: number): void {
    if (car.groundedCount < 2) return;
    let curv = 0;
    for (let d = 0; d < 6; d++) {
      const a = this.track.sampleAt(s + d).tangent, b = this.track.sampleAt(s + d + 1).tangent;
      const ha = Math.hypot(a.x, a.z), hb = Math.hypot(b.x, b.z);
      if (ha < 0.2 || hb < 0.2) continue;
      curv = Math.max(curv, Math.acos(Math.min(1, (a.x * b.x + a.z * b.z) / (ha * hb))));
    }
    const vCap = THREE.MathUtils.clamp(Math.sqrt(DECK_GRIP / Math.max(curv, 1e-3)), 7, 30);
    if (car.forwardSpeed <= vCap) return;
    const j = -car.cfg.mass * Math.min(DECK_BRAKE, (car.forwardSpeed - vCap) / dt) * dt;
    car.body.applyImpulse({ x: car.fwd.x * j, y: car.fwd.y * j, z: car.fwd.z * j }, true);
  }

  /**
   * Toy-track guide rail for the narrow stand section: a gentle yaw torque that lines the car up
   * with the track so it can't end up wedged sideways on a 1 m-wide deck. Steering still works.
   */
  private guideAlong(car: RaycastCar, smp: { tangent: THREE.Vector3 }, dt: number): void {
    if (car.groundedCount < 2) return;
    const up = car.up;
    const t = smp.tangent.clone().addScaledVector(up, -smp.tangent.dot(up)).normalize();
    const f = car.fwd.clone().addScaledVector(up, -car.fwd.dot(up)).normalize();
    // Signed angle from the car's heading to the track direction, about the car's up axis.
    const err = Math.atan2(new THREE.Vector3().crossVectors(f, t).dot(up), f.dot(t));
    if (Math.abs(err) > 2.2) return; // pointing backwards: let the player sort it out
    const av = car.body.angvel();
    const wUp = av.x * up.x + av.y * up.y + av.z * up.z;
    const a = THREE.MathUtils.clamp(GUIDE_K * err - GUIDE_D * wUp, -GUIDE_MAX, GUIDE_MAX);
    const I = 0.11; // ≈ car yaw inertia
    const j = a * I * dt;
    car.body.applyTorqueImpulse({ x: up.x * j, y: up.y * j, z: up.z * j }, true);
  }

  /** Bouncing down the aisle: each axle gets a kick as it passes a step edge. */
  private stairHops(car: RaycastCar, s: number, stairStep: number[]): void {
    for (const b of this.trackBuild.bumps) {
      const span = this.track.forwardDistance(b.s0, b.s1);
      const axles = [car.cfg.frontAxleZ, car.cfg.rearAxleZ];
      axles.forEach((az, a) => {
        const d = this.track.forwardDistance(b.s0, s + az);
        if (d > span || car.groundedCount === 0) {
          if (d > span) stairStep[a] = -1;
          return;
        }
        const step = Math.floor(d / b.pitch);
        if (step !== stairStep[a] && stairStep[a] !== -1) {
          // Same kick on both wheels of the axle (uneven kicks would slew the car sideways).
          const kick = (car.cfg.mass / 4) * b.strength * (0.85 + Math.random() * 0.3);
          for (const w of car.wheels.filter((wh) => wh.front === (a === 0))) {
            const at = w.mount.clone().applyQuaternion(car.quat).add(car.pos);
            const j = kick;
            car.body.applyImpulseAtPoint({ x: car.up.x * j, y: car.up.y * j, z: car.up.z * j }, { x: at.x, y: at.y, z: at.z }, true);
          }
        }
        stairStep[a] = step;
      });
    }
  }

  private handleCollisions(): void {
    const { cones, balls, pads } = this.trackBuild;
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const racer = this.racerByCollider.get(h1) ?? this.racerByCollider.get(h2);
      if (!racer) return;
      const box = this.pickups.byCollider.get(h1) ?? this.pickups.byCollider.get(h2);
      if (box !== undefined) {
        if (!racer.item && this.race.racing && this.pickups.take(box)) {
          this.giveItem(racer);
          if (racer === this.player) this.sfx('pickup');
        }
        return;
      }
      const pad = pads.byCollider.get(h1) ?? pads.byCollider.get(h2);
      if (pad !== undefined) {
        racer.car.boost(BOOST_PAD_SECONDS);
        if (racer === this.player) this.hud.flash('BOOST', '', 0.7);
        this.sfx('boostPad', racer.car.pos);
        return;
      }
      const ball = balls.byCollider.get(h1) ?? balls.byCollider.get(h2);
      if (ball !== undefined) {
        if (balls.kick(ball, racer.car.body.linvel(), racer.car.pos)) {
          this.ballKicker.set(ball, racer);
          this.sfx('kick', racer.car.pos);
        }
        return;
      }
      const cone = cones.byCollider.get(h1) ?? cones.byCollider.get(h2);
      if (cone === undefined) return;
      const body = racer.car.body;
      if (cones.kick(cone, body.linvel(), racer.car.pos)) {
        // The cone's momentum comes out of the car's: a small, arcade-sized speed scrub.
        const v = body.linvel();
        body.setLinvel({ x: v.x * 0.95, y: v.y, z: v.z * 0.95 }, true);
        this.sfx('cone', racer.car.pos);
      }
    });
  }

  private giveItem(r: Racer): void {
    r.item = rollItem(this.race.placeOf(r.progress), this.racers.length);
    r.itemRoll = ITEM_ROLL_SECONDS;
    r.itemHeld = 0;
  }

  private useItem(r: Racer): void {
    if (!r.item || r.itemRoll > 0 || !this.race.racing) return;
    this.items.use(r, r.item);
    this.itemStats.used[r.item] = (this.itemStats.used[r.item] ?? 0) + 1;
    if (r === this.player && r.item === 'boost') this.hud.flash('LIGHTNING!', '', 0.8);
    r.item = null;
  }

  /** Roulettes, AI item use, and what the items in play did this frame. */
  private updateItems(dt: number): void {
    const cars = this.racers.map((r) => r.car);
    for (const r of this.racers) {
      if (!r.item) continue;
      if (r.itemRoll > 0) {
        const before = r.itemRoll;
        r.itemRoll = Math.max(0, r.itemRoll - dt);
        if (r === this.player && this.mode === 'race') {
          if (Math.floor(before * 11) !== Math.floor(r.itemRoll * 11)) this.sfx('tick');
          if (r.itemRoll === 0) this.sfx('ready');
        }
        continue;
      }
      r.itemHeld += dt;
      // AI think about it a few times a second (not every frame, so they don't all fire at once).
      const bot = r.ai !== null || (this.mode === 'menu' && r === this.player);
      if (bot && this.race.racing && !r.progress.finished && Math.random() < dt * 3) {
        const s = this.track.samples[Math.max(0, this.trackIndexOf(r))].s;
        if (aiWantsToUse(r.item, r.car, cars, this.track, s, r.itemHeld)) this.useItem(r);
      }
    }
    this.pickups.update(dt);
    for (const h of this.items.update(dt)) this.onItemHit(h);
  }

  private onItemFx(kind: 'boost' | 'throw' | 'explode' | 'oil' | 'zap', at: THREE.Vector3, _by: Racer): void {
    this.sfx(kind, at);
    if (kind === 'explode') {
      for (let k = 0; k < 26; k++) {
        this.glow.emit({
          pos: at, vel: _tmp.set(rand(-1, 1), rand(0.5, 1.6), rand(-1, 1)).normalize().multiplyScalar(rand(2, 5)),
          color: _col.set(Math.random() < 0.5 ? '#ffb02e' : '#fff0a0'), size: rand(0.05, 0.1), life: rand(0.4, 0.8), gravity: 7, drag: 1.5,
        });
      }
      for (let k = 0; k < 10; k++) {
        this.smoke.emit({
          pos: at, vel: _tmp.set(rand(-1, 1), rand(0.3, 1), rand(-1, 1)).multiplyScalar(1.2),
          color: _col.set('#3a3a40'), size: 0.3, grow: 1.2, life: rand(0.9, 1.4), alpha: 0.5, drag: 2, gravity: -0.3,
        });
      }
      const near = this.spatial(at, 2.5).gain;
      this.rig.shake(0.08 * near);
    } else if (kind === 'zap') {
      for (let k = 0; k < 24; k++) {
        this.glow.emit({
          pos: at, vel: _tmp.set(rand(-1, 1), rand(0, 0.6), rand(-1, 1)).normalize().multiplyScalar(rand(3, 6)),
          color: _col.set('#7ff0ff'), size: 0.06, life: rand(0.2, 0.4), drag: 3,
        });
      }
    }
  }

  private onItemHit(h: ItemHit<Racer>): void {
    this.itemStats.hits[h.kind] = (this.itemStats.hits[h.kind] ?? 0) + 1;
    if (h.kind === 'oil') this.sfx('spin', h.victim.car.pos);
    if (h.victim === this.player) {
      this.hud.flash(h.kind === 'oil' ? 'SPIN OUT!' : h.kind === 'pulse' ? 'ZAPPED!' : 'BOOM!', h.by === this.player ? '' : h.by.progress.name, 1.2);
    } else if (h.by === this.player) {
      this.hud.flash(`${ITEM_NAMES[h.kind]} HIT`, `+${ITEM_HIT_SCORE}`, 1.2);
      this.addScore(ITEM_HIT_SCORE);
    }
  }

  private handleActions(): void {
    const a = this.input.actions;
    if (a.reset) this.resetPlayer();
    if (a.usePickup) this.useItem(this.player);
    if (a.camera) this.rig.cycle();
    if (a.confirm && this.hud.resultsShown) this.beginRace();
    if (a.pause) this.pause();
    if (a.debug) {
      this.hud.showDebug = !this.hud.showDebug;
      this.trackBuild.debugLine.visible = this.hud.showDebug;
      this.checkpointMarkers.visible = this.hud.showDebug;
    }
  }

  /** Back onto the track at the last safe spot behind the car (never before its last checkpoint). */
  resetPlayer(): void {
    this.respawn(this.player);
    this.playerTrackIndex = -1;
    this.rig.snap();
  }

  private respawn(r: Racer): void {
    const spot = this.race.respawnFor(r.progress);
    r.car.reset(spot.pos, spot.yaw);
    r.stairStep = [-1, -1];
    if (r === this.player) this.playerTrackIndex = -1;
    if (r.ai) {
      r.ai.reset();
      r.ai.stats.respawns++;
    }
  }

  private render(dt: number): void {
    const alpha = this.accumulator / FIXED_DT;
    for (const r of this.racers) {
      r.renderPos.lerpVectors(r.car.prevPos, r.car.pos, alpha);
      r.renderQuat.slerpQuaternions(r.car.prevQuat, r.car.quat, alpha);
      r.visual.root.position.copy(r.renderPos);
      r.visual.root.quaternion.copy(r.renderQuat);
      r.visual.update(r.car, dt);
    }

    const focus = this.focusRacer();
    const fc = focus.car;
    const lv = fc.body.linvel();
    const target: CameraTarget = {
      pos: focus.renderPos,
      quat: focus.renderQuat,
      velocity: new THREE.Vector3(lv.x, lv.y, lv.z),
      speedFrac: Math.min(1, fc.speed / fc.cfg.maxSpeed),
      grounded: fc.groundedCount > 0,
    };
    // Loop: watch through it from the grass behind the entry (the chase view would be blocked).
    const smp = this.track.samples[Math.max(0, this.trackIndexOf(focus))];
    this.rig.shot = smp.loop && this.loopShot ? this.loopShot : null;
    if (this.mode !== 'paused') this.rig.update(target, dt);
    this.sky.position.copy(this.camera.position);
    this.sun.follow(focus.renderPos);
    const pxPerM = this.renderer.getDrawingBufferSize(_v2).y / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const pdt = this.mode === 'paused' ? 0 : dt;
    this.smoke.update(pdt, pxPerM);
    this.glow.update(pdt, pxPerM);
    this.confetti.update(pdt, pxPerM);
    this.updateAudio(dt);
    const pc = this.player.car;

    const pp = this.playerProgress;
    const place = this.race.placeOf(pp);
    const best = pp.lapTimes.length ? Math.min(...pp.lapTimes) : null;
    this.hud.setRace({
      lap: pp.lap,
      laps: this.race.laps,
      time: formatTime(pp.finished ? pp.finishTime : this.race.clock),
      best: best !== null ? formatTime(best) : null,
      place,
      placeSuffix: ordinal(place),
      racers: this.race.racers.length,
    });
    const mph = Math.abs(pc.forwardSpeed) * MPH;
    this.hud.update(
      {
        mph,
        gauge: Math.min(1, Math.abs(pc.forwardSpeed) / (pc.cfg.maxSpeed * 0.9)),
        debug: this.hud.showDebug ? this.debugText() : undefined,
      },
      dt,
    );
    this.hud.setItem(this.player.item, this.player.itemRoll > 0);
    this.stadium.tv.update(this.renderer, this.scene, focus.renderPos, this.rigHeading(focus), dt);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  private readonly _heading = new THREE.Vector3();
  /** A car's flat heading, for the TV chase shot. */
  private rigHeading(r: Racer): THREE.Vector3 {
    const f = r.car.fwd;
    this._heading.set(f.x, 0, f.z);
    if (this._heading.lengthSq() < 1e-4) this._heading.set(1, 0, 0);
    return this._heading.normalize();
  }

  private debugText(): string {
    const c = this.player.car;
    const w = c.wheels;
    return [
      `fps        ${this.fps.toFixed(0)}`,
      `speed      ${c.speed.toFixed(2)} m/s  (${(c.speed * MPH).toFixed(1)} mph)`,
      `fwd speed  ${c.forwardSpeed.toFixed(2)} m/s`,
      `steer      ${(c.steerAngle * 57.3).toFixed(1)}°`,
      `grounded   ${c.groundedCount}/4   air ${c.airTime.toFixed(2)}s  last ${c.lastAirTime.toFixed(2)}s`,
      `load N     ${w.map((x) => x.load.toFixed(0).padStart(3)).join(' ')}`,
      `slip m/s   ${w.map((x) => x.slip.toFixed(1).padStart(3)).join(' ')}`,
      `pos        ${c.pos.x.toFixed(1)}, ${c.pos.y.toFixed(2)}, ${c.pos.z.toFixed(1)}`,
      `track s    ${this.track.samples[Math.max(0, this.playerTrackIndex)].s.toFixed(1)} / ${this.track.length.toFixed(0)} m`,
      `race       ${this.race.phase}  lap ${this.playerProgress.lap}  next cp ${this.playerProgress.nextCp}/${this.race.checkpoints.length}  progress ${this.playerProgress.progress.toFixed(1)}`,
      `camera     ${this.rig.mode}   quality ${QUALITY.name}`,
      `draws      ${this.renderer.info.render.calls}  tris ${this.renderer.info.render.triangles}`,
    ].join('\n');
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
