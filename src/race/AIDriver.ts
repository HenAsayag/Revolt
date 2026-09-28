import * as THREE from 'three';
import type { DriveInput } from '../core/Input';
import type { Track } from '../track/Track';
import type { RaycastCar } from '../vehicle/RaycastCar';

export interface AIPersonality {
  name: string;
  /** 0..1 — scales top speed and cornering commitment. */
  skill: number;
  /** Preferred lateral position, -1 (left edge) .. 1 (right edge). */
  lane: number;
  seed: number;
}

export const AI_ROSTER: AIPersonality[] = [
  { name: 'BLAZE', skill: 0.97, lane: -0.3, seed: 1 },
  { name: 'ZIPPY', skill: 0.95, lane: 0.35, seed: 2 },
  { name: 'SPARKY', skill: 0.93, lane: 0.0, seed: 3 },
  { name: 'NITRO', skill: 0.91, lane: -0.45, seed: 4 },
  { name: 'ROCKET', skill: 0.89, lane: 0.45, seed: 5 },
  { name: 'DIESEL', skill: 0.87, lane: -0.15, seed: 6 },
  { name: 'TURBO', skill: 0.85, lane: 0.2, seed: 7 },
];

export interface AIContext {
  /** Metres this car is ahead (+) or behind (−) the player in the race. */
  gapToPlayer: number;
  others: RaycastCar[];
  racing: boolean;
}

const _to = new THREE.Vector3();
const _flat = (t: THREE.Vector3) => {
  const v = new THREE.Vector3(t.x, 0, t.z);
  return v.lengthSq() < 0.04 ? null : v.normalize();
};

/**
 * Spline-following opponent: pure pursuit toward a point ahead on its own lane, speed planned
 * from the upcoming (horizontal) curvature and crests, a little wander, side-stepping cars in
 * front, rubber-banding against the player, and reversing out of trouble.
 */
export class AIDriver {
  hint = -1;
  /** Set when the driver wants to be put back on the track. */
  wantsRespawn = false;
  private time = 0;
  private stuckFor = 0;
  private reverseFor = 0;
  private reverseSteer = 0;
  private offTrackFor = 0;
  private flippedFor = 0;
  private dodge = 0;
  /** Track position of the last real forward progress, and the time since. */
  private anchorS = -1;
  private sinceProgress = 0;
  private reverseTries = 0;
  /** Dev stats: respawns and reverse manoeuvres since the last clear. */
  stats = { respawns: 0, reverses: 0, log: [] as string[] };

  constructor(
    readonly car: RaycastCar,
    private readonly track: Track,
    readonly p: AIPersonality,
    /** Track spans [s0, s1] where the driver takes the centre line (boost pads, the loop). */
    private readonly centreSpans: [number, number][] = [],
  ) {}

  /** 1 inside a centre span, easing from 0 over the few metres before it. */
  private centreWeight(s: number): number {
    let w = 0;
    for (const [s0, s1] of this.centreSpans) {
      const len = this.track.forwardDistance(s0, s1);
      const into = this.track.forwardDistance(s0, s);
      if (into <= len) return 1;
      const before = this.track.length - into; // metres until the span starts
      if (before < 6) w = Math.max(w, 1 - before / 6);
    }
    return w;
  }

  drive(dt: number, ctx: AIContext): DriveInput {
    const car = this.car;
    const track = this.track;
    this.time += dt;
    let pr = track.project(car.pos, this.hint);
    if (pr.distance > 6) pr = track.project(car.pos);
    this.hint = pr.index;
    const here = track.samples[pr.index];

    // --- Trouble: upside down, far off the line, or stuck against something.
    // (Upside down is normal over the top of the loop.)
    this.flippedFor = car.isUpsideDown && !here.loop && car.speed < 3 ? this.flippedFor + dt : 0;
    this.offTrackFor = pr.distance > 4 ? this.offTrackFor + dt : 0;
    if (this.flippedFor > 1.2 || this.offTrackFor > 2.5) {
      if (!this.wantsRespawn) this.stats.log.push(`${this.flippedFor > 1.2 ? "flip" : "off"}@${pr.s.toFixed(0)}`);
      this.wantsRespawn = true;
    }
    // No forward progress for a while (wedged, circling, reversing in vain) → respawn.
    const moved = this.anchorS < 0 ? 2 : track.forwardDistance(this.anchorS, pr.s);
    if (moved > 1 && moved < 30) {
      this.anchorS = pr.s;
      this.sinceProgress = 0;
      this.reverseTries = 0;
    } else if (ctx.racing) {
      this.sinceProgress += dt;
    }
    if (this.sinceProgress > 4 && !this.wantsRespawn) {
      this.stats.log.push(`stuck@${pr.s.toFixed(0)}`);
      this.wantsRespawn = true;
    }
    if (ctx.racing && this.reverseFor <= 0) {
      this.stuckFor = car.speed < 0.7 ? this.stuckFor + dt : 0;
      if (this.stuckFor > 0.9) {
        this.reverseFor = 0.8;
        this.stats.reverses++;
        this.stuckFor = 0;
        // Back out toward the centre line; alternate if that didn't help last time.
        this.reverseSteer = (pr.lateral > 0 ? -1 : 1) * (this.reverseTries++ % 2 === 0 ? 1 : -1);
      }
    }
    if (this.reverseFor > 0) {
      this.reverseFor -= dt;
      if (this.reverseFor <= 0 && car.speed < 0.5) this.stuckFor = 0.6; // try again soon, or respawn via off-track
      return { throttle: -1, steer: this.reverseSteer, handbrake: false };
    }

    // --- Where to aim: own lane (wandering a little), squeezed to the middle on narrow bits.
    const room = Math.max(0, here.width / 2 - 0.45);
    let lane = THREE.MathUtils.clamp(this.p.lane + Math.sin(this.time * 0.35 + this.p.seed * 1.7) * 0.25, -1, 1);
    // Side-step a car right ahead in our lane.
    for (const o of ctx.others) {
      if (o === car) continue;
      _to.subVectors(o.pos, car.pos);
      const ahead = _to.dot(car.fwd);
      const side = _to.dot(car.left);
      if (ahead > 0.2 && ahead < 2.8 && Math.abs(side) < 0.45) this.dodge = side > 0 ? -0.8 : 0.8;
    }
    this.dodge *= Math.exp(-dt * 1.5);
    lane = THREE.MathUtils.clamp(lane + this.dodge, -1, 1) * (1 - this.centreWeight(pr.s + car.speed * 0.3));
    const look = 1.4 + car.speed * 0.2;
    const target = track.pointAt(pr.s + look, lane * room);
    _to.subVectors(target, car.pos);
    const ang = Math.atan2(_to.dot(car.left), _to.dot(car.fwd));

    // --- Speed plan.
    let curv = 0;
    let crest = 0;
    for (let d = 0; d < 16; d++) {
      const a = track.sampleAt(pr.s + d), b = track.sampleAt(pr.s + d + 1);
      if (a.loop) continue;
      const fa = _flat(a.tangent), fb = _flat(b.tangent);
      if (fa && fb) curv = Math.max(curv, Math.acos(Math.min(1, fa.dot(fb))));
      if (d < 10) crest = Math.max(crest, a.tangent.y - b.tangent.y);
    }
    // Rubber band: ease off when well ahead of the player, push when behind.
    const g = ctx.gapToPlayer;
    const band = g > 0 ? 1 - Math.min(0.14, g * 0.003) : 1 + Math.min(0.08, -g * 0.002);
    const skill = this.p.skill;
    const maxV = 18 * skill * band;
    const grip = 11 * (0.9 + 0.1 * skill);
    const vLim = Math.min(maxV, Math.sqrt(grip / Math.max(curv, 1e-3)), Math.sqrt(8 / Math.max(crest, 1e-3)));
    const v = car.forwardSpeed;
    const throttle = here.loop ? 1 : v > vLim + 0.8 ? -0.7 : v < vLim ? 1 : 0.15;
    const wobble = Math.sin(this.time * 2.3 + this.p.seed) * 0.04 * (1 - skill) * 10;
    return { throttle, steer: THREE.MathUtils.clamp(-ang * 2.1 + wobble, -1, 1), handbrake: false };
  }

  reset(): void {
    this.hint = -1;
    this.wantsRespawn = false;
    this.stuckFor = this.reverseFor = this.offTrackFor = this.flippedFor = this.dodge = 0;
    this.anchorS = -1;
    this.sinceProgress = this.reverseTries = 0;
  }
}
