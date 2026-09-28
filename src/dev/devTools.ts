import * as THREE from 'three';
import type { DriveInput } from '../core/Input';
import { AIDriver } from '../race/AIDriver';
import type { Game } from '../game/Game';
import type { ArcadeCar } from '../vehicle/ArcadeCar';

/**
 * Dev-only helpers on `window.__test` (headless lap checks from the console / automation).
 * The pilot is a simple pure-pursuit driver along the spline — a stand-in until the phase-6 AI.
 */
const TEST = { track: 'tour' as const, laps: 3, assist: false, rivals: 'visible' as const, difficulty: 'normal' as const, items: true, music: 0, sfx: 0 };

export function installDevTools(game: Game): void {
  const track = game.track;
  let hint = -1;
  const flatT = (s: number) => {
    const t = track.sampleAt(s).tangent;
    const v = new THREE.Vector3(t.x, 0, t.z);
    return v.lengthSq() < 0.04 ? null : v.normalize();
  };

  /** `digital`: steer like a keyboard player (full left / nothing / full right). */
  const pilot = (maxV = 19, grip = 12, digital = false) => (car: ArcadeCar): DriveInput => {
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
      game.beginRace(TEST);
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

  /**
   * A full race with the AI field; the player is driven by the pilot at `playerV` (0 = parked).
   * Returns every racer's place, finish time, laps and (for the AI) respawns / reverses.
   */
  const race = (maxSeconds = 150, playerV = 17) => {
    game.stop();
    game.beginRace(TEST);
    for (const r of game.racers) if (r.ai) r.ai.stats = { respawns: 0, reverses: 0, log: [] };
    hint = -1;
    // playerV < 0: the player's car gets an AI driver of its own (recovers from bumps and wedges).
    const me = new AIDriver(game.player.car, track, { name: 'YOU', skill: -playerV / 18, lane: 0, seed: 9 });
    let lastT = game.simTime;
    game.autopilot = playerV > 0 ? pilot(playerV, 12)
      : playerV < 0 ? (_car, t) => {
        const d = me.drive(Math.max(1e-3, t - lastT), { gapToPlayer: 0, others: game.racers.map((r) => r.car), racing: game.race.racing });
        lastT = t;
        if (me.wantsRespawn) game.resetPlayer(), me.reset();
        return d;
      }
      : () => ({ throttle: 0, steer: 0, handbrake: true });
    game.simulate(maxSeconds, () => game.race.racers.every((r) => r.finished));
    game.autopilot = null;
    return game.race.standings().map((p, i) => {
      const r = game.racers.find((x) => x.progress === p)!;
      return {
        place: i + 1,
        name: p.name,
        time: p.finished ? +p.finishTime.toFixed(2) : null,
        laps: p.lapTimes.map((t) => +t.toFixed(1)),
        lap: p.lap,
        ...(r.ai ? r.ai.stats : {}),
        at: r.car.pos.toArray().map((v) => +v.toFixed(1)),
      };
    });
  };

  /**
   * "Naive player": holds full gas, steers like a keyboard (left / nothing / right) with a human
   * reaction delay, never brakes, presses R when stuck or on its roof. Solo (AI parked off-world).
   * Measures how forgiving the controls are: wall hits, resets, landing attitude, lap times.
   */
  const naive = (laps = 2, maxSeconds = 120, opts: { delay?: number; look?: number; lift?: boolean; assist?: boolean; lazy?: boolean } = {}) => {
    const delay = opts.delay ?? 0.15;
    const car = game.player.car;
    game.stop();
    game.beginRace({ ...TEST, assist: !!opts.assist });
    for (const r of game.racers) if (r.ai) r.car.body.setEnabled(false);
    game.simulate(3.05);
    hint = -1;
    const queue: { t: number; steer: number }[] = [];
    let stuckFor = 0, flipFor = 0, resets = 0;
    const hits: string[] = [], landings: string[] = [];
    const speedHist: { t: number; v: number }[] = [];
    let lastHit = -9, wasAir = 0, wasTouching = false;
    game.autopilot = (c, t) => {
      let p = track.project(c.pos, hint);
      if (p.distance > 6) p = track.project(c.pos);
      hint = p.index;
      const target = track.pointAt(p.s + (opts.look ?? 2.5) + c.speed * 0.15, 0).sub(c.pos);
      const ang = Math.atan2(target.dot(c.left), target.dot(c.fwd));
      // lazy: only reacts to big heading errors (a casual player leaving the small stuff to the assist).
      queue.push({ t, steer: Math.abs(ang) > (opts.lazy ? 0.22 : 0.06) ? -Math.sign(ang) : 0 });
      while (queue.length > 1 && queue[1].t <= t - delay) queue.shift();
      // lift: a slightly smarter human who lets off the gas while steering hard at speed.
      const steer = queue[0].steer;
      const throttle = opts.lift && Math.abs(ang) > 0.35 && c.speed > 9 ? 0 : 1;
      return { throttle, steer, handbrake: false };
    };
    game.simulate(maxSeconds, () => {
      const t = game.simTime;
      const c = car;
      speedHist.push({ t, v: c.speed });
      while (speedHist.length && speedHist[0].t < t - 0.25) speedHist.shift();
      const vMax = Math.max(...speedHist.map((h) => h.v));
      const s = track.samples[Math.max(0, hint)].s;
      // Wall hit = the chassis touching a static collider while (mostly) upright and moving.
      let touching = false;
      for (const col of c.colliders) {
        game.world.contactPairsWith(col, (o) => {
          if (touching || o.isSensor() || !o.parent()?.isFixed()) return;
          game.world.contactPair(col, o, (m) => {
            if (m.numContacts() > 0 && Math.abs(m.normal().y) < 0.6) touching = true;
          });
        });
      }
      if (touching && !wasTouching && t - lastHit > 0.7 && vMax > 3) {
        hits.push(`${s.toFixed(0)}:${vMax.toFixed(0)}→${c.speed.toFixed(0)}`);
        lastHit = t;
      }
      wasTouching = touching;
      if (wasAir > 0.4 && c.airTime === 0) {
        const pitch = Math.asin(Math.max(-1, Math.min(1, c.fwd.y))) * 57.3, roll = Math.asin(Math.max(-1, Math.min(1, c.left.y))) * 57.3;
        landings.push(`${s.toFixed(0)}:p${pitch.toFixed(0)}r${roll.toFixed(0)}`);
      }
      wasAir = c.airTime;
      stuckFor = c.speed < 0.5 ? stuckFor + 1 / 60 : 0;
      flipFor = c.isUpsideDown && !track.samples[Math.max(0, hint)].loop ? flipFor + 1 / 60 : 0;
      if (stuckFor > 1.5 || flipFor > 1 || c.pos.y < -10) {
        resets++;
        hits.push(`R@${s.toFixed(0)}`);
        game.resetPlayer();
        hint = -1;
        stuckFor = flipFor = 0;
      }
      return game.race.progressOf(car).lapTimes.length >= laps;
    });
    game.autopilot = null;
    for (const r of game.racers) if (r.ai) r.car.body.setEnabled(true);
    const pp = game.race.progressOf(car);
    return { laps: pp.lapTimes.map((t) => +t.toFixed(1)), resets, hits: hits.filter((h) => !h.startsWith('R')).length, hitLog: hits.join(' '), landings: landings.join(' ') };
  };

  (window as unknown as { __test: unknown }).__test = { pilot, lap, race, naive, track, game, items: () => JSON.stringify(game.itemStats) };
}
