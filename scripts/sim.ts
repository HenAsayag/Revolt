/**
 * Headless handling tests for the arcade RC car: `npm run sim`.
 * Runs the real ArcadeCar on a flat plane (plus a kicker, a wall and a ramp) and prints the
 * numbers to tune against.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { addStaticBox, addStaticHull, createWorld, FIXED_DT, initPhysics } from '../src/physics/Physics';
import { ArcadeCar } from '../src/vehicle/ArcadeCar';
import { DEFAULT_CAR } from '../src/vehicle/CarConfig';
import type { DriveInput } from '../src/core/Input';

await initPhysics();

const MPH = 2.23694;
const f2 = (n: number) => n.toFixed(2);
const deg = (r: number) => ((r * 180) / Math.PI).toFixed(0);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function setup(extra?: (world: RAPIER.World) => void) {
  const world = createWorld();
  addStaticBox(world, new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(400, 0.5, 400));
  extra?.(world);
  const car = new ArcadeCar(world, DEFAULT_CAR, new THREE.Vector3(0, 0.2, 0), 0);
  world.step();
  return { world, car };
}

function run(world: RAPIER.World, car: ArcadeCar, seconds: number, ctl: (t: number) => DriveInput, each?: (t: number) => void) {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    const t = i * FIXED_DT;
    car.step(FIXED_DT, ctl(t));
    world.step();
    car.postStep();
    each?.(t);
  }
}
const gas = (steer = 0, throttle = 1, handbrake = false): DriveInput => ({ throttle, steer, handbrake });
/** Accelerate in a straight line to `v` and hold it for a moment. */
const speedUp = (world: RAPIER.World, car: ArcadeCar, v: number) => run(world, car, 6, () => gas(0, car.forwardSpeed < v ? 1 : 0));

{
  const { world, car } = setup();
  run(world, car, 1, () => gas(0, 0));
  console.log(`[settle] body centre ${f2(car.pos.y)} m (radius ${DEFAULT_CAR.radius}), up.y ${f2(car.up.y)}, speed ${f2(car.speed)}`);
}
{
  const { world, car } = setup();
  const marks: Record<number, number> = {};
  run(world, car, 8, () => gas(), (t) => {
    for (const v of [5, 10, 14]) if (marks[v] === undefined && car.forwardSpeed >= v) marks[v] = t;
  });
  console.log(`[accel] 0→5 ${f2(marks[5])}s, 0→10 ${f2(marks[10])}s, 0→14 ${f2(marks[14] ?? NaN)}s, top ${f2(car.forwardSpeed)} m/s = ${(car.forwardSpeed * MPH).toFixed(1)} mph, drift x ${f2(car.pos.x)}`);
  const z0 = car.pos.z;
  let stopT = -1;
  run(world, car, 3, () => gas(0, -1), (t) => { if (stopT < 0 && car.forwardSpeed < 0.3) stopT = t; });
  console.log(`[brake] from top: stopped in ${f2(stopT)}s`);
  void z0;
}
for (const v of [4, 8, 12, 15]) {
  const { world, car } = setup();
  speedUp(world, car, v);
  let turned = 0, maxSlip = 0, prev = car.yaw;
  run(world, car, 2, () => gas(1, car.forwardSpeed < v ? 0.7 : 0), () => {
    maxSlip = Math.max(maxSlip, Math.abs(car.slipAngle));
    turned += wrap(car.yaw - prev);
    prev = car.yaw;
  });
  const yawRate = Math.abs(turned) / 2;
  console.log(`[turn ${v} m/s] full lock: ${f2(yawRate)} rad/s → radius ${f2(car.forwardSpeed / Math.max(yawRate, 1e-3))} m, speed ${f2(car.forwardSpeed)}, peak slip ${deg(maxSlip)}°`);
}
for (const v of [10, 15]) {
  const { world, car } = setup();
  speedUp(world, car, v);
  const y0 = car.yaw;
  run(world, car, 1, (t) => gas(t < 0.12 ? 1 : 0));
  console.log(`[0.12s tap ${v} m/s] heading change ${deg(wrap(car.yaw - y0))}°`);
}
{
  const { world, car } = setup();
  speedUp(world, car, 14);
  const y0 = car.yaw, x0 = car.pos.x;
  run(world, car, 2, (t) => gas(t < 0.3 ? 1 : t < 0.6 ? -1 : 0));
  console.log(`[lane change 14] sideways ${f2(car.pos.x - x0)} m, heading error ${deg(wrap(car.yaw - y0))}°, speed ${f2(car.forwardSpeed)}`);
}
{
  const { world, car } = setup();
  speedUp(world, car, 13);
  const y0 = car.yaw;
  let maxSlip = 0;
  run(world, car, 1.5, () => gas(0.6, 1, true), () => (maxSlip = Math.max(maxSlip, Math.abs(car.slipAngle))));
  const turned = deg(wrap(car.yaw - y0));
  const boosts = car.driftBoosts;
  run(world, car, 0.1, () => gas(0));
  console.log(`[drift 13 m/s] 1.5 s: turned ${turned}°, peak slip ${deg(maxSlip)}°, speed ${f2(car.forwardSpeed)}; release → boost ${car.driftBoosts > boosts ? f2(car.boostTime) + 's' : 'none'}`);
}
{
  // Kicker: 1.4 m wide, 1.1 m long, 0.3 m tall at z = 25.
  const { world, car } = setup((w) => {
    const z0 = 25, L = 1.1, H = 0.3, W = 0.7;
    addStaticHull(w, [
      new THREE.Vector3(-W, 0, z0), new THREE.Vector3(W, 0, z0), new THREE.Vector3(-W, 0, z0 + L),
      new THREE.Vector3(W, 0, z0 + L), new THREE.Vector3(-W, H, z0 + L), new THREE.Vector3(W, H, z0 + L),
    ]);
  });
  let apex = 0, airs: number[] = [], minUp = 1;
  run(world, car, 4, () => gas(), () => {
    apex = Math.max(apex, car.pos.y);
    minUp = Math.min(minUp, car.up.y);
    if (car.airTime === 0 && car.lastAirTime > 0 && airs[airs.length - 1] !== car.lastAirTime) airs.push(car.lastAirTime);
  });
  console.log(`[kicker] air phases ${airs.map(f2).join(', ')}s, apex ${f2(apex)} m, min up.y ${f2(minUp)}, end speed ${f2(car.forwardSpeed)}`);
}
{
  const { world, car } = setup();
  car.reset(new THREE.Vector3(0, 3, 0), 0);
  let minY = 9, bounce = 0, landed = false;
  run(world, car, 2, () => gas(0, 0), () => {
    minY = Math.min(minY, car.pos.y);
    if (car.groundedCount > 0) landed = true;
    else if (landed) bounce = Math.max(bounce, car.pos.y);
  });
  console.log(`[drop 3m] lowest centre ${f2(minY)} m, rebound ${f2(bounce)} m, final y ${f2(car.pos.y)}, up.y ${f2(car.up.y)}`);
}
{
  // Wall along x = 1.2; drive into it at 25° and 14 m/s.
  const { world, car } = setup((w) => addStaticBox(w, new THREE.Vector3(1.4, 0.3, 40), new THREE.Vector3(0.2, 0.3, 60), undefined, { friction: 0.02 }));
  speedUp(world, car, 14);
  car.reset(car.pos.clone().setX(0), 0.44);
  const v0 = 14;
  car.body.setLinvel({ x: Math.sin(0.44) * v0, y: 0, z: Math.cos(0.44) * v0 }, true);
  let minSpeed = 99;
  run(world, car, 1.5, () => gas(), () => (minSpeed = Math.min(minSpeed, car.speed)));
  console.log(`[wall 25°] min speed ${f2(minSpeed)} m/s (from ${v0}), after ${f2(car.speed)}, x ${f2(car.pos.x)}`);
}
{
  // 25° ramp, 4 m tall.
  const { world, car } = setup((w) => {
    const z0 = 20, L = 4 / Math.tan((25 * Math.PI) / 180), H = 4, W = 1.5;
    addStaticHull(w, [
      new THREE.Vector3(-W, 0, z0), new THREE.Vector3(W, 0, z0), new THREE.Vector3(-W, 0, z0 + L),
      new THREE.Vector3(W, 0, z0 + L), new THREE.Vector3(-W, H, z0 + L), new THREE.Vector3(W, H, z0 + L),
    ]);
    addStaticBox(w, new THREE.Vector3(0, H / 2, z0 + L + 5), new THREE.Vector3(W, H / 2, 5));
  });
  let topSpeed = -1;
  run(world, car, 6, () => gas(), () => {
    if (topSpeed < 0 && car.pos.y > 4) topSpeed = car.forwardSpeed;
  });
  console.log(`[ramp 25° × 4 m] speed at the top ${f2(topSpeed)} m/s, y ${f2(car.pos.y)}`);
}
