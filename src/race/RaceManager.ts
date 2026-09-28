import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Track } from '../track/Track';
import type { RaycastCar } from '../vehicle/RaycastCar';

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface Checkpoint {
  index: number; // sample index
  s: number;
}

export interface RacerProgress {
  readonly car: RaycastCar;
  readonly name: string;
  /** Track sample hint for projection (also "where am I"). */
  hint: number;
  s: number;
  /** Has crossed the start line once (the grid is behind it). */
  started: boolean;
  /** Current lap, 1-based. */
  lap: number;
  /** Next checkpoint to pass (0 = the start/finish line). */
  nextCp: number;
  lapStart: number;
  lapTimes: number[];
  finished: boolean;
  finishTime: number;
  /** Ranking key: larger = further ahead. */
  progress: number;
  wrongWayFor: number;
}

export type RaceEvent =
  | { type: 'count'; n: number }
  | { type: 'go' }
  | { type: 'lap'; racer: RacerProgress; lap: number; time: number; best: boolean }
  | { type: 'finalLap'; racer: RacerProgress }
  | { type: 'finish'; racer: RacerProgress; place: number }
  | { type: 'wrongWay'; racer: RacerProgress };

const COUNTDOWN = 3;

/**
 * Race rules on top of the spline: evenly spaced checkpoints (nudged onto solid ground, never
 * mid-air or in the loop) that must be passed in order, lap counting and timing, standings,
 * wrong-way detection and "last safe spot" respawns.
 */
export class RaceManager {
  readonly checkpoints: Checkpoint[] = [];
  readonly racers: RacerProgress[] = [];
  phase: RacePhase = 'countdown';
  /** Race clock, seconds since GO (negative during the countdown). */
  clock = -COUNTDOWN;
  /** Samples a car can be put back on (supported, not in the loop). */
  private readonly safe: boolean[];
  private finishedCount = 0;
  private lastCount = COUNTDOWN + 1;

  constructor(
    readonly track: Track,
    readonly startS: number,
    public laps: number,
    world: RAPIER.World,
    /** Stretches where a car must never be put back (set pieces), as [s0, s1]. */
    noRespawn: [number, number][] = [],
    checkpointCount = 28,
  ) {
    // Safe = flat-ish, solid right underneath, not in the loop or a set piece.
    // (The world must have stepped once so scene queries see the static colliders.)
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.safe = track.samples.map((smp) => {
      if (smp.loop || Math.abs(smp.tangent.y) > 0.2) return false;
      if (noRespawn.some(([a, b]) => track.forwardDistance(a, smp.s) <= track.forwardDistance(a, b))) return false;
      ray.origin = { x: smp.pos.x + smp.up.x * 0.3, y: smp.pos.y + smp.up.y * 0.3, z: smp.pos.z + smp.up.z * 0.3 };
      ray.dir = { x: -smp.up.x, y: -smp.up.y, z: -smp.up.z };
      const hit = world.castRayAndGetNormal(ray, 0.8, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
      return !!hit && hit.normal.y > 0.6;
    });
    const n = track.samples.length;
    for (let i = 0; i < checkpointCount; i++) {
      let idx = track.indexAt(startS + (i * track.length) / checkpointCount);
      if (i > 0) {
        // Nudge forward/back to the nearest safe sample (within ±6 m).
        for (let k = 0; k < 24 && !this.safe[idx]; k++) {
          const fwd = (idx + k) % n, back = (idx - k + n) % n;
          if (this.safe[fwd]) idx = fwd;
          else if (this.safe[back]) idx = back;
        }
      }
      this.checkpoints.push({ index: idx, s: track.samples[idx].s });
    }
  }

  addRacer(car: RaycastCar, name: string): RacerProgress {
    const r: RacerProgress = {
      car, name, hint: -1, s: 0, started: false, lap: 1, nextCp: 0, lapStart: 0,
      lapTimes: [], finished: false, finishTime: 0, progress: 0, wrongWayFor: 0,
    };
    this.racers.push(r);
    return r;
  }

  progressOf(car: RaycastCar): RacerProgress {
    return this.racers.find((r) => r.car === car)!;
  }

  /** Back to the grid state (the caller repositions the cars). */
  restart(): void {
    this.phase = 'countdown';
    this.clock = -COUNTDOWN;
    this.finishedCount = 0;
    this.lastCount = COUNTDOWN + 1;
    for (const r of this.racers) {
      Object.assign(r, { hint: -1, started: false, lap: 1, nextCp: 0, lapStart: 0, lapTimes: [], finished: false, finishTime: 0, wrongWayFor: 0 });
    }
  }

  /** Straight to GO (attract-mode demo races). */
  skipCountdown(): void {
    this.phase = 'racing';
    this.clock = 0;
    this.lastCount = 0;
  }

  get racing(): boolean {
    return this.phase === 'racing';
  }

  update(dt: number): RaceEvent[] {
    const events: RaceEvent[] = [];
    this.clock += dt;
    if (this.phase === 'countdown') {
      const n = Math.ceil(-this.clock);
      if (n < this.lastCount && n > 0) events.push({ type: 'count', n });
      this.lastCount = n;
      if (this.clock >= 0) {
        this.phase = 'racing';
        events.push({ type: 'go' });
      }
    }
    const L = this.track.length;
    const N = this.checkpoints.length;
    for (const r of this.racers) {
      let p = this.track.project(r.car.pos, r.hint);
      if (p.distance > 6) p = this.track.project(r.car.pos);
      r.hint = p.index;
      r.s = p.s;
      if (this.phase === 'countdown' || r.finished) {
        r.progress = r.finished ? 1e6 - r.finishTime : -this.track.forwardDistance(r.s, this.startS);
        continue;
      }
      // Checkpoints in order: "passed" = just beyond it (within half a gap), so skipping one never counts.
      const cp = this.checkpoints[r.nextCp];
      const halfGap = L / N / 2;
      if (p.distance < 8 && this.track.forwardDistance(cp.s, r.s) < halfGap) {
        if (r.nextCp === 0) {
          if (!r.started) {
            r.started = true;
          } else {
            const time = this.clock - r.lapStart;
            const best = r.lapTimes.every((t) => time < t);
            r.lapTimes.push(time);
            r.lapStart = this.clock;
            events.push({ type: 'lap', racer: r, lap: r.lap, time, best });
            r.lap++;
            if (r.lap > this.laps) {
              r.finished = true;
              r.finishTime = this.clock;
              this.finishedCount++;
              events.push({ type: 'finish', racer: r, place: this.finishedCount });
              r.progress = 1e6 - r.finishTime;
              continue;
            }
            if (r.lap === this.laps) events.push({ type: 'finalLap', racer: r });
          }
        }
        r.nextCp = (r.nextCp + 1) % N;
      }
      r.progress = this.computeProgress(r);
      // Wrong way: moving fast against the track direction for a while.
      const v = r.car.body.linvel();
      const t = this.track.samples[r.hint].tangent;
      const along = v.x * t.x + v.y * t.y + v.z * t.z;
      r.wrongWayFor = r.car.speed > 2.5 && along < -0.5 * r.car.speed ? r.wrongWayFor + dt : 0;
      if (r.wrongWayFor > 1.2) {
        events.push({ type: 'wrongWay', racer: r });
        r.wrongWayFor = -1.5;
      }
    }
    if (this.phase === 'racing' && this.racers.every((r) => r.finished)) this.phase = 'finished';
    return events;
  }

  /** Distance raced, clamped to the checkpoint just passed so shortcuts don't count. */
  private computeProgress(r: RacerProgress): number {
    const L = this.track.length;
    const N = this.checkpoints.length;
    if (!r.started) return -this.track.forwardDistance(r.s, this.startS);
    const last = this.checkpoints[(r.nextCp - 1 + N) % N];
    const next = this.checkpoints[r.nextCp];
    const lapBase = (r.lap - 1) * L;
    const toLast = this.track.forwardDistance(this.startS, last.s);
    const seg = this.track.forwardDistance(last.s, next.s) || L;
    // Slightly *behind* the last checkpoint wraps to ~L: count that as 0, not a whole segment.
    const raw = this.track.forwardDistance(last.s, r.s);
    const beyond = raw > seg + (L - seg) / 2 ? 0 : Math.min(raw, seg);
    return lapBase + toLast + beyond;
  }

  /** Standings, leader first. */
  standings(): RacerProgress[] {
    return [...this.racers].sort((a, b) => b.progress - a.progress);
  }

  placeOf(r: RacerProgress): number {
    return this.standings().indexOf(r) + 1;
  }

  /** The nearest safe spot at or behind where the car is on the track. */
  respawnFor(r: RacerProgress): { pos: THREE.Vector3; yaw: number } {
    const n = this.track.samples.length;
    let idx = r.hint >= 0 ? r.hint : this.checkpoints[(r.nextCp - 1 + this.checkpoints.length) % this.checkpoints.length].index;
    for (let k = 0; k < n && !this.safe[idx]; k++) idx = (idx - 1 + n) % n;
    const smp = this.track.samples[idx];
    return { pos: smp.pos.clone().addScaledVector(smp.up, 0.35), yaw: this.track.yawAt(smp.s) };
  }
}

/** mm:ss:cc */
export function formatTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}

/** 1 → "st", 2 → "nd", 11 → "th"… */
export function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}
