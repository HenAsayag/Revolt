/**
 * Headless handling tests for the RC car: `npm run sim`.
 * Runs the real RaycastCar on a flat plane + a kicker ramp and prints numbers to tune against.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { addStaticBox, addStaticHull, createWorld, FIXED_DT, initPhysics } from '../src/physics/Physics';
import { RaycastCar } from '../src/vehicle/RaycastCar';
import { DEFAULT_CAR } from '../src/vehicle/CarConfig';
import type { DriveInput } from '../src/core/Input';

await initPhysics();

const MPH = 2.23694;
const f2 = (n: number) => n.toFixed(2);

function setup(withRamp = false) {
  const world = createWorld();
  addStaticBox(world, new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(400, 0.5, 400));
  if (withRamp) {
    // Kicker: 1.2 m wide, 1.1 m long, 0.32 m tall, starting at z=25.
    const z0 = 25, L = 1.1, H = 0.32, W = 0.6;
    addStaticHull(world, [
      new THREE.Vector3(-W, 0, z0), new THREE.Vector3(W, 0, z0),
      new THREE.Vector3(-W, 0, z0 + L), new THREE.Vector3(W, 0, z0 + L),
      new THREE.Vector3(-W, H, z0 + L), new THREE.Vector3(W, H, z0 + L),
    ]);
  }
  const car = new RaycastCar(world, DEFAULT_CAR, new THREE.Vector3(0, 0.25, 0), 0);
  return { world, car };
}

function run(world: RAPIER.World, car: RaycastCar, seconds: number, ctl: (t: number) => DriveInput, each?: (t: number) => void) {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    const t = i * FIXED_DT;
    car.step(FIXED_DT, ctl(t));
    world.step();
    car.postStep();
    each?.(t);
  }
}

const idle = (): DriveInput => ({ throttle: 0, steer: 0, handbrake: false });
const gas = (steer = 0, handbrake = false): DriveInput => ({ throttle: 1, steer, handbrake });

// 1. Settle
{
  const { world, car } = setup();
  run(world, car, 2, idle);
  const lv = car.body.linvel();
  console.log(`[settle] ride height ${f2(car.pos.y)} m, compression ${car.wheels.map((w) => f2(w.compression)).join('/')}, up.y ${f2(car.up.y)}, residual v ${Math.hypot(lv.x, lv.y, lv.z).toExponential(1)}`);
}

// 2. Acceleration + 3. braking
{
  const { world, car } = setup();
  run(world, car, 0.5, idle);
  const marks: Record<number, number> = {};
  run(world, car, 8, () => gas(), (t) => {
    for (const s of [5, 10, 15, 18]) if (marks[s] === undefined && car.forwardSpeed >= s) marks[s] = t;
  });
  console.log(`[accel] 0→5 ${f2(marks[5] ?? NaN)}s, 0→10 ${f2(marks[10] ?? NaN)}s, 0→15 ${f2(marks[15] ?? NaN)}s, 0→18 ${f2(marks[18] ?? NaN)}s, top ${f2(car.forwardSpeed)} m/s = ${(car.forwardSpeed * MPH).toFixed(1)} mph, drift x ${f2(car.pos.x)}`);
  const z0 = car.pos.z;
  let stopT = -1;
  run(world, car, 4, () => ({ throttle: -1, steer: 0, handbrake: false }), (t) => {
    if (stopT < 0 && car.forwardSpeed < 0.3) stopT = t;
  });
  console.log(`[brake] stopped in ${f2(stopT)}s over ~${f2(car.pos.z - z0)}m (incl. reversing after), up.y ${f2(car.up.y)}`);
}

// 4. Steady full-lock corner at speed
{
  const { world, car } = setup();
  run(world, car, 3, () => gas());
  let minUp = 1, maxYawRate = 0, maxLat = 0;
  const prevV = new THREE.Vector3();
  run(world, car, 4, () => gas(1), () => {
    minUp = Math.min(minUp, car.up.y);
    const av = car.body.angvel();
    maxYawRate = Math.max(maxYawRate, Math.abs(av.y));
    const lv = car.body.linvel();
    const v = new THREE.Vector3(lv.x, lv.y, lv.z);
    const a = v.clone().sub(prevV).divideScalar(FIXED_DT);
    prevV.copy(v);
    maxLat = Math.max(maxLat, Math.abs(a.dot(car.left)));
  });
  console.log(`[corner] speed ${f2(car.speed)} m/s, yaw rate ${f2(maxYawRate)} rad/s, peak lat ${(maxLat / 9.81).toFixed(2)} g, min up.y ${f2(minUp)} ${minUp < 0.3 ? 'FLIPPED' : 'ok'}`);
}

// 5. Slalom
{
  const { world, car } = setup();
  run(world, car, 3, () => gas());
  let minUp = 1;
  run(world, car, 5, (t) => gas(Math.sin(t * 5) > 0 ? 1 : -1), () => (minUp = Math.min(minUp, car.up.y)));
  console.log(`[slalom] speed ${f2(car.speed)} m/s, min up.y ${f2(minUp)} ${minUp < 0.3 ? 'FLIPPED' : 'ok'}`);
}

// 6. Handbrake turn
{
  const { world, car } = setup();
  run(world, car, 2, () => gas());
  const v0 = car.speed, y0 = car.yaw;
  let yawAcc = 0, prevYaw = y0, minUp = 1;
  run(world, car, 1.0, () => ({ throttle: 0, steer: 1, handbrake: true }), () => {
    let d = car.yaw - prevYaw;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    yawAcc += d;
    prevYaw = car.yaw;
    minUp = Math.min(minUp, car.up.y);
  });
  const vel = car.body.linvel();
  const slipAngle = Math.acos(Math.min(1, Math.abs(new THREE.Vector3(vel.x, 0, vel.z).normalize().dot(car.fwd))));
  console.log(`[handbrake] from ${f2(v0)} m/s: turned ${(yawAcc * 180 / Math.PI).toFixed(0)}° in 1s, slip angle ${(slipAngle * 180 / Math.PI).toFixed(0)}°, speed ${f2(car.speed)}, min up.y ${f2(minUp)}`);
}

// 6b. Handbrake flick then release: does grip come back?
{
  const { world, car } = setup();
  run(world, car, 2, () => gas());
  const y0 = car.yaw;
  run(world, car, 0.4, () => ({ throttle: 0.5, steer: 1, handbrake: true }));
  const yawHb = car.yaw - y0;
  run(world, car, 0.8, () => gas(0.3));
  const vel = car.body.linvel();
  const slip = Math.acos(Math.min(1, new THREE.Vector3(vel.x, 0, vel.z).normalize().dot(car.fwd))) * 57.3;
  console.log(`[hb flick] 0.4s handbrake → ${(yawHb * -57.3).toFixed(0)}° rotation; 0.8s after release slip ${slip.toFixed(0)}°, speed ${f2(car.speed)}`);
}

// 7. Kicker jump
{
  const { world, car } = setup(true);
  let maxY = 0, minUp = 1;
  const airs: string[] = [];
  let wasAir = false;
  run(world, car, 5, () => gas(), () => {
    if (car.pos.z > 24) { maxY = Math.max(maxY, car.pos.y); minUp = Math.min(minUp, car.up.y); }
    if (car.airTime > 0.05) wasAir = true;
    if (wasAir && car.airTime === 0) { airs.push(f2(car.lastAirTime)); wasAir = false; }
  });
  console.log(`[jump] air phases ${airs.join(', ')}s (1st = the jump, rest = landing bounces), apex ${f2(maxY)} m, min up.y ${f2(minUp)} ${minUp < 0.3 ? 'FLIPPED' : 'ok'}, end speed ${f2(car.speed)}`);
}

// 8. Drop from 3 m
{
  const { world, car } = setup();
  car.reset(new THREE.Vector3(0, 3, 0), 0);
  let minY = 9, bounceMax = 0, hit = false;
  run(world, car, 3, idle, () => {
    minY = Math.min(minY, car.pos.y);
    if (car.groundedCount > 0) hit = true;
    if (hit) bounceMax = Math.max(bounceMax, car.pos.y);
  });
  console.log(`[drop 3m] lowest body y ${f2(minY)} m, rebound peak ${f2(bounceMax)} m, final up.y ${f2(car.up.y)}, final y ${f2(car.pos.y)}`);
}
