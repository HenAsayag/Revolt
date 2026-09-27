import * as THREE from 'three';
import { DEFAULT_WIDTH, type TrackControlPoint } from './trackData';

export interface TrackSample {
  /** Arc length from the spline start, metres. */
  s: number;
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
  /** Right of travel, in the track plane. */
  right: THREE.Vector3;
  up: THREE.Vector3;
  width: number;
  /** True inside the loop-the-loop (frames there follow the curve instead of world up). */
  loop: boolean;
}

export interface TrackProjection {
  index: number;
  s: number;
  /** Signed distance right of the centre line. */
  lateral: number;
  /** Straight-line distance to the nearest sample. */
  distance: number;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * The racing line as a closed centripetal Catmull-Rom spline, pre-sampled at even arc-length
 * steps with a frame (tangent/right/up) and width at each sample. Everything else — barriers,
 * features, checkpoints, AI, respawns — is derived from these samples.
 */
export class Track {
  readonly curve: THREE.CatmullRomCurve3;
  readonly length: number;
  readonly step: number;
  readonly samples: TrackSample[] = [];

  constructor(readonly points: TrackControlPoint[], targetStep = 0.5) {
    this.curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(p.x, p.y ?? 0, p.z)),
      true,
      'centripetal',
    );
    this.curve.arcLengthDivisions = Math.max(2000, points.length * 60);
    this.length = this.curve.getLength();
    const n = Math.ceil(this.length / targetStep);
    this.step = this.length / n;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const t = this.curve.getUtoTmapping(u, 0);
      const pos = this.curve.getPoint(t);
      const tangent = this.curve.getTangent(t).normalize();
      const right = new THREE.Vector3().crossVectors(tangent, WORLD_UP).normalize();
      const up = new THREE.Vector3().crossVectors(right, tangent).normalize();
      const ci = Math.floor(t * points.length) % points.length;
      const loop = !!points[ci].loop && !!points[(ci + 1) % points.length].loop;
      const smp = { s: u * this.length, pos, tangent, right, up, width: this.lerpAtT(t, 'width', DEFAULT_WIDTH), loop };
      const bank = this.lerpAtT(t, 'bank', 0);
      if (bank !== 0) {
        smp.up.applyAxisAngle(tangent, bank);
        smp.right.crossVectors(tangent, smp.up).normalize();
      }
      this.samples.push(smp);
    }
    this.fixLoopFrames();
  }

  /**
   * World-up frames break down where the track goes vertical, so inside loop zones the frame is
   * carried along by rotation-minimising (double reflection) transport, then untwisted so it
   * meets the world-up frame again where the zone ends.
   */
  private fixLoopFrames(): void {
    const n = this.samples.length;
    for (let i = 0; i < n; i++) {
      if (!this.samples[i].loop || this.samples[(i - 1 + n) % n].loop) continue;
      // Zone starts at i: collect it (plus one sample either side as anchors).
      const idx: number[] = [(i - 1 + n) % n];
      for (let k = i; this.samples[k % n].loop && idx.length < n; k++) idx.push(k % n);
      idx.push((idx[idx.length - 1] + 1) % n);
      const ups: THREE.Vector3[] = [this.samples[idx[0]].up.clone()];
      for (let k = 1; k < idx.length; k++) {
        const a = this.samples[idx[k - 1]], b = this.samples[idx[k]];
        const v1 = b.pos.clone().sub(a.pos);
        const c1 = v1.dot(v1) || 1e-9;
        const rL = ups[k - 1].clone().addScaledVector(v1, (-2 / c1) * v1.dot(ups[k - 1]));
        const tL = a.tangent.clone().addScaledVector(v1, (-2 / c1) * v1.dot(a.tangent));
        const v2 = b.tangent.clone().sub(tL);
        const c2 = v2.dot(v2);
        ups.push(c2 < 1e-12 ? rL : rL.addScaledVector(v2, (-2 / c2) * v2.dot(rL)).normalize());
      }
      // Twist left over at the exit, spread evenly through the zone.
      const last = idx.length - 1;
      const tEnd = this.samples[idx[last]].tangent;
      const target = this.samples[idx[last]].up;
      const twist = Math.atan2(new THREE.Vector3().crossVectors(ups[last], target).dot(tEnd), ups[last].dot(target));
      for (let k = 1; k < last; k++) {
        const smp = this.samples[idx[k]];
        const up = ups[k].applyAxisAngle(smp.tangent, (twist * k) / last);
        smp.up.copy(up.addScaledVector(smp.tangent, -up.dot(smp.tangent)).normalize());
        smp.right.crossVectors(smp.tangent, smp.up).normalize();
      }
    }
  }

  /** Arc-length span [s0, s1] of the (first) loop zone, or null. */
  loopSpan(): [number, number] | null {
    const i0 = this.samples.findIndex((smp, i) => smp.loop && !this.samples[(i - 1 + this.samples.length) % this.samples.length].loop);
    if (i0 < 0) return null;
    let i1 = i0;
    while (this.samples[(i1 + 1) % this.samples.length].loop) i1 = (i1 + 1) % this.samples.length;
    return [this.samples[i0].s, this.samples[i1].s];
  }

  /** A per-point value interpolated between control points (point i sits at t = i / count). */
  private lerpAtT(t: number, key: 'width' | 'bank', fallback: number): number {
    const n = this.points.length;
    const f = t * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const a = this.points[i0][key] ?? fallback;
    const b = this.points[i1][key] ?? fallback;
    return a + (b - a) * (f - Math.floor(f));
  }

  wrapS(s: number): number {
    return ((s % this.length) + this.length) % this.length;
  }

  indexAt(s: number): number {
    return Math.round(this.wrapS(s) / this.step) % this.samples.length;
  }

  sampleAt(s: number): TrackSample {
    return this.samples[this.indexAt(s)];
  }

  /** Forward distance from s0 to s1 along the loop (0..length). */
  forwardDistance(s0: number, s1: number): number {
    return this.wrapS(s1 - s0);
  }

  /**
   * Nearest sample to a world position. With `hint` (a previous index) only a window around it
   * is searched, which is both faster and avoids snapping to a parallel stretch of track.
   */
  project(p: THREE.Vector3, hint = -1, window = 60): TrackProjection {
    const n = this.samples.length;
    let best = 0;
    let bestD = Infinity;
    const scan = (i: number) => {
      const d = this.samples[i].pos.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    };
    if (hint >= 0) for (let k = -window; k <= window; k++) scan((hint + k + n) % n);
    else for (let i = 0; i < n; i++) scan(i);
    const smp = this.samples[best];
    const lateral = p.clone().sub(smp.pos).dot(smp.right);
    return { index: best, s: smp.s, lateral, distance: Math.sqrt(bestD) };
  }

  /**
   * Snap a feature anchor to the spline: [x, z] matches in plan view (ignoring height, so anchors
   * on ramps and decks work); [x, y, z] matches in 3D.
   */
  sAt(p: [number, number] | [number, number, number]): number {
    if (p.length === 3) return this.project(new THREE.Vector3(p[0], p[1], p[2])).s;
    let best = 0, bestD = Infinity;
    for (const smp of this.samples) {
      const d = (smp.pos.x - p[0]) ** 2 + (smp.pos.z - p[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = smp.s;
      }
    }
    return best;
  }

  /** Samples from s0 forward to s1 (inclusive, wrapping). */
  span(s0: number, s1: number): TrackSample[] {
    const out: TrackSample[] = [];
    const n = this.samples.length;
    const i0 = this.indexAt(s0), i1 = this.indexAt(s1);
    for (let i = i0; ; i = (i + 1) % n) {
      out.push(this.samples[i]);
      if (i === i1 || out.length > n) break;
    }
    return out;
  }

  /** World position at arc length s, offset `lateral` metres to the right. */
  pointAt(s: number, lateral = 0, out = new THREE.Vector3()): THREE.Vector3 {
    const smp = this.sampleAt(s);
    return out.copy(smp.pos).addScaledVector(smp.right, lateral);
  }

  /** Heading (yaw about +Y, car convention: 0 = facing +Z) at arc length s. */
  yawAt(s: number): number {
    const t = this.sampleAt(s).tangent;
    return Math.atan2(t.x, t.z);
  }

  /** Staggered two-wide starting grid behind `startS`. */
  gridSlots(startS: number, count: number): { pos: THREE.Vector3; yaw: number }[] {
    const slots: { pos: THREE.Vector3; yaw: number }[] = [];
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const s = startS - 1.6 - row * 1.4 - (i % 2) * 0.6;
      const pos = this.pointAt(s, side * 0.62);
      pos.y += 0.3;
      slots.push({ pos, yaw: this.yawAt(s) });
    }
    return slots;
  }
}
