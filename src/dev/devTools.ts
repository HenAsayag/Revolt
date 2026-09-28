import * as THREE from 'three';
import type { DriveInput } from '../core/Input';
import type { Game } from '../game/Game';
import type { RaycastCar } from '../vehicle/RaycastCar';

/**
 * Dev-only helpers on `window.__test` (headless lap checks from the console / automation).
 * The pilot is a simple pure-pursuit driver along the spline — a stand-in until the phase-6 AI.
 */
export function installDevTools(game: Game): void {
  const track = game.track;
  let hint = -1;
  const flatT = (s: number) => {
    const t = track.sampleAt(s).tangent;
    const v = new THREE.Vector3(t.x, 0, t.z);
    return v.lengthSq() < 0.04 ? null : v.normalize();
  };

  /** `digital`: steer like a keyboard player (full left / nothing / full right). */
  const pilot = (maxV = 19, grip = 12, digital = false) => (car: RaycastCar): DriveInput => {
    let p = track.project(car.pos, hint);
    if (p.distance > 6) p = track.project(car.pos);
    hint = p.index;
    const here = track.samples[p.index];
    const target = track.pointAt(p.s + 1.4 + car.speed * 0.2, 0).sub(car.pos);
    const ang = Math.atan2(target.dot(car.left), target.dot(car.fwd));
    let curv = 0;
    for (let d = 0; d < 16; d++) {
      if (track.sampleAt(p.s + d).loop) continue;
      const a = flatT(p.s + d), b = flatT(p.s + d + 1);
      if (a && b) curv = Math.max(curv, Math.acos(Math.min(1, a.dot(b))));
    }
    // Crests: keep v²·κ below g so the car stays planted over humps.
    let crest = 0;
    for (let d = 0; d < 10; d++) {
      const a = track.sampleAt(p.s + d).tangent.y, b = track.sampleAt(p.s + d + 1).tangent.y;
      if (!track.sampleAt(p.s + d).loop) crest = Math.max(crest, a - b);
    }
    const vLim = Math.min(maxV, Math.sqrt(grip / Math.max(curv, 1e-3)), Math.sqrt(8 / Math.max(crest, 1e-3)));
    const v = car.forwardSpeed;
    const throttle = here.loop ? 1 : v > vLim + 0.8 ? -0.7 : v < vLim ? 1 : 0.15;
    const steer = digital ? (Math.abs(ang) > 0.05 ? -Math.sign(ang) : 0) : THREE.MathUtils.clamp(-ang * 2, -1, 1);
    return { throttle: digital && throttle > 0 ? 1 : throttle, steer, handbrake: false };
  };

  /** Drive `laps` laps from the grid with the pilot; returns lap times, flips and a progress log. */
  const lap = (laps = 1, maxSeconds = 90, opts: { maxV?: number; from?: [number, number]; digital?: boolean } = {}) => {
    const car = game.player.car;
    game.stop();
    if (opts.from) {
      const s = track.sAt(opts.from);
      const smp = track.sampleAt(s);
      car.reset(smp.pos.clone().addScaledVector(smp.up, 0.3), track.yawAt(s));
    } else {
      game.restartRace();
      game.simulate(3.05); // countdown
    }
    hint = -1;
    game.autopilot = pilot(opts.maxV, 12, opts.digital);
    const t0 = game.simTime;
    let prevS = track.project(car.pos).s;
    let dist = 0, lastUp = 1, lapStart = 0;
    const times: number[] = [], flips: string[] = [], log: string[] = [];
    let stuck = 0;
    game.simulate(maxSeconds, () => {
      const pr = track.project(car.pos, hint);
      let ds = pr.s - prevS;
      if (ds < -track.length / 2) ds += track.length;
      if (ds > track.length / 2) ds -= track.length;
      dist += ds;
      prevS = pr.s;
      const t = game.simTime - t0;
      if (dist >= track.length * (times.length + 1)) {
        times.push(+(t - lapStart).toFixed(1));
        lapStart = t;
      }
      if (car.up.y < 0.2 && lastUp >= 0.2) flips.push(`${pr.s.toFixed(0)}@(${car.pos.x.toFixed(1)},${car.pos.y.toFixed(1)},${car.pos.z.toFixed(1)})`);
      lastUp = car.up.y;
      if (Math.floor(t * 2) !== Math.floor((t - 1 / 60) * 2)) log.push(`${pr.s.toFixed(0)}|${car.speed.toFixed(1)}|${car.pos.y.toFixed(1)}`);
      stuck = car.speed < 0.3 ? stuck + 1 / 60 : 0;
      return times.length >= laps || stuck > 4;
    });
    game.autopilot = null;
    const race = game.race.progressOf(car);
    return { raceLaps: race.lapTimes.map((t) => +t.toFixed(2)), lap: race.lap, finished: race.finished, times, flips, stuck: stuck > 4 ? { s: prevS.toFixed(0), pos: car.pos.toArray().map((v) => +v.toFixed(2)) } : null, score: game.score, log: log.join(' ') };
  };

  (window as unknown as { __test: unknown }).__test = { pilot, lap, track, game };
}
