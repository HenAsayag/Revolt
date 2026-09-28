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
import { CONTROL_POINTS, FEATURES } from '../track/trackData';
import { formatTime, ordinal, RaceManager, type RaceEvent, type RacerProgress } from '../race/RaceManager';
import { AI_ROSTER, AIDriver } from '../race/AIDriver';

const MPH = 2.23694;
const LAPS = 3;
/** Grid slot the player starts from (0 = pole); the AI fill the rest. */
const PLAYER_SLOT = 5;
const MAX_STEPS_PER_FRAME = 8;
/** Extra acceleration toward the loop surface, m/s² (gravity alone would need ~12 m/s at the entry). */
const LOOP_STICK = 9;
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
    this.track = new Track(CONTROL_POINTS);
    this.trackBuild = buildTrack(this.scene, this.world, this.track, FEATURES);
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
    this.race = new RaceManager(this.track, this.trackBuild.startS, LAPS, this.world, noRespawn);
    for (const r of this.racers) r.progress = this.race.addRacer(r.car, r.ai ? r.ai.p.name : 'YOU');
    this.playerProgress = this.player.progress;
    this.buildCheckpointMarkers();
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

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private addRacer(liveryIndex: number, pos: THREE.Vector3, yaw: number): Racer {
    const car = new RaycastCar(this.world, DEFAULT_CAR, pos, yaw);
    const visual = new ProceduralBuggy(DEFAULT_CAR, LIVERIES[liveryIndex % LIVERIES.length]);
    this.scene.add(visual.root);
    const racer: Racer = {
      car, visual, ai: null, progress: null!, input: { throttle: 0, steer: 0, handbrake: true }, stairStep: [-1, -1],
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
    this.handleActions();
    const drive = this.autopilot ? this.autopilot(this.player.car, this.simTime) : this.input.drive;
    const countdown = this.race.phase === 'countdown';
    const allCars = this.racers.map((r) => r.car);
    for (const r of this.racers) {
      let d = drive;
      if (r.ai) {
        d = r.ai.drive(dt, { gapToPlayer: r.progress.progress - this.playerProgress.progress, others: allCars, racing: this.race.racing });
        // Finished AI cruise on at an easy pace.
        if (r.progress.finished) d = { throttle: Math.min(d.throttle, 0.35), steer: d.steer, handbrake: false };
      }
      // Grid hold during the countdown: steer all you like, but the handbrake is on.
      r.input = countdown ? { throttle: 0, steer: d.steer, handbrake: true } : d;
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
    const mine = 'racer' in e && e.racer === this.playerProgress;
    switch (e.type) {
      case 'count':
        this.hud.countdown(String(e.n));
        break;
      case 'go':
        this.hud.countdown('GO!');
        break;
      case 'lap':
        if (mine) this.hud.flash(e.best && e.lap > 1 ? 'BEST LAP' : `LAP ${e.lap}`, formatTime(e.time), 2);
        break;
      case 'finalLap':
        if (mine) this.later(1800, () => this.hud.flash('FINAL LAP', '', 1.6));
        break;
      case 'finish':
        if (mine) {
          this.hud.flash('FINISH!', `${e.place}${ordinal(e.place)}`, 2.5);
          this.later(1500, () => this.showResults());
        } else if (this.playerProgress.finished) {
          this.showResults(); // someone else crossed the line: refresh the table
        }
        break;
      case 'wrongWay':
        if (mine) this.hud.banner('WRONG WAY', 1.6);
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
    this.hud.showResults(rows, 'Press ENTER to race again');
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
      }
      // Inside the loop: press the car onto the surface (only while it's actually on it).
      c.surfaceStick = at.loop && c.groundedCount >= 2 ? LOOP_STICK : at.loop ? 2 : 0;
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
        }
        this.loopProgress = 0;
      }
    }
    for (const goal of this.trackBuild.balls.update(dt)) {
      if (this.ballKicker.get(goal.ball) !== this.player) continue;
      this.hud.flash('GOAL!', '+500', 2);
      this.addScore(500);
    }
    if (pc.driftBoosts !== this.lastDriftBoosts) {
      this.lastDriftBoosts = pc.driftBoosts;
      this.hud.flash('DRIFT BOOST', `${pc.lastDriftBoost.toFixed(1)}s`, 1.2);
      this.addScore(Math.round(pc.lastDriftBoost * 60));
    }
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
      const pad = pads.byCollider.get(h1) ?? pads.byCollider.get(h2);
      if (pad !== undefined) {
        racer.car.boost(BOOST_PAD_SECONDS);
        if (racer === this.player) this.hud.flash('BOOST', '', 0.7);
        return;
      }
      const ball = balls.byCollider.get(h1) ?? balls.byCollider.get(h2);
      if (ball !== undefined) {
        if (balls.kick(ball, racer.car.body.linvel(), racer.car.pos)) this.ballKicker.set(ball, racer);
        return;
      }
      const cone = cones.byCollider.get(h1) ?? cones.byCollider.get(h2);
      if (cone === undefined) return;
      const body = racer.car.body;
      if (cones.kick(cone, body.linvel(), racer.car.pos)) {
        // The cone's momentum comes out of the car's: a small, arcade-sized speed scrub.
        const v = body.linvel();
        body.setLinvel({ x: v.x * 0.95, y: v.y, z: v.z * 0.95 }, true);
      }
    });
  }

  private handleActions(): void {
    const a = this.input.actions;
    if (a.reset) this.resetPlayer();
    if (a.camera) this.rig.cycle();
    if (a.confirm) this.restartRace();
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

    const pc = this.player.car;
    const lv = pc.body.linvel();
    const target: CameraTarget = {
      pos: this.player.renderPos,
      quat: this.player.renderQuat,
      velocity: new THREE.Vector3(lv.x, lv.y, lv.z),
      speedFrac: Math.min(1, pc.speed / pc.cfg.maxSpeed),
      grounded: pc.groundedCount > 0,
    };
    // Loop: watch through it from the grass behind the entry (the chase view would be blocked).
    const smp = this.track.samples[Math.max(0, this.playerTrackIndex)];
    this.rig.shot = smp.loop && this.loopShot ? this.loopShot : null;
    this.rig.update(target, dt);
    this.sky.position.copy(this.camera.position);
    this.sun.follow(this.player.renderPos);

    const pp = this.playerProgress;
    const place = this.race.placeOf(pp);
    const best = pp.lapTimes.length ? Math.min(...pp.lapTimes) : null;
    this.hud.setRace({
      lap: pp.lap,
      laps: LAPS,
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
    this.stadium.tv.update(this.renderer, this.scene, this.player.renderPos, this.rigHeading(), dt);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  private readonly _heading = new THREE.Vector3();
  /** Player's flat heading, for the TV chase shot. */
  private rigHeading(): THREE.Vector3 {
    const f = this.player.car.fwd;
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
