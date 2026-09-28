/**
 * Controllability checks with digital (keyboard / touch-button) input: `npx tsx scripts/control.ts`.
 * Reports how twitchy the car is and how quickly it settles.
 */
import * as THREE from 'three';
import { addStaticBox, createWorld, FIXED_DT, initPhysics } from '../src/physics/Physics';
import { RaycastCar } from '../src/vehicle/RaycastCar';
import { DEFAULT_CAR } from '../src/vehicle/CarConfig';
import type { DriveInput } from '../src/core/Input';

await initPhysics();
const f2 = (n: number) => n.toFixed(2);

function setup() {
  const world = createWorld();
  addStaticBox(world, new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(400, 0.5, 400));
  const car = new RaycastCar(world, DEFAULT_CAR, new THREE.Vector3(0, 0.25, 0), 0);
  return { world, car };
}
function run(world: ReturnType<typeof setup>['world'], car: RaycastCar, secs: number, ctl: (t: number) => DriveInput, each?: (t: number) => void) {
  for (let i = 0, n = Math.round(secs / FIXED_DT); i < n; i++) {
    const t = i * FIXED_DT;
    car.step(FIXED_DT, ctl(t));
    world.step();
    car.postStep();
    each?.(t);
  }
}
const slipDeg = (car: RaycastCar) => {
  const v = car.body.linvel();
  const h = Math.hypot(v.x, v.z);
  if (h < 1) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, (v.x * car.fwd.x + v.z * car.fwd.z) / (h * Math.hypot(car.fwd.x, car.fwd.z))))) * 180) / Math.PI;
};
const yawRate = (car: RaycastCar) => car.body.angvel().y;
const speedUp = (world: ReturnType<typeof setup>['world'], car: RaycastCar, v: number) =>
  run(world, car, 6, () => ({ throttle: car.forwardSpeed < v ? 1 : 0, steer: 0, handbrake: false }));

for (const v of [8, 12, 16]) {
  // 1. Tap full steer for 0.6 s, release, watch it settle.
  const { world, car } = setup();
  speedUp(world, car, v);
  let maxYaw = 0, maxSlip = 0, settle = -1;
  const y0 = car.yaw;
  run(world, car, 2.1, (t) => ({ throttle: 0.7, steer: t < 0.6 ? 1 : 0, handbrake: false }), (t) => {
    maxYaw = Math.max(maxYaw, Math.abs(yawRate(car)));
    maxSlip = Math.max(maxSlip, slipDeg(car));
    if (t > 0.6 && settle < 0 && Math.abs(yawRate(car)) < 0.2) settle = t - 0.6;
  });
  let turned = (car.yaw - y0) * 57.3;
  if (turned > 180) turned -= 360;
  if (turned < -180) turned += 360;
  console.log(`[tap ${v} m/s] turned ${turned.toFixed(0)}°, peak yaw ${f2(maxYaw)} rad/s, peak slip ${maxSlip.toFixed(0)}°, settles ${settle < 0 ? 'never' : f2(settle) + 's'} after release, speed ${f2(car.speed)}`);
}
{
  // 2. Digital slalom: flip full left/right every 0.45 s at full throttle.
  const { world, car } = setup();
  speedUp(world, car, 14);
  let maxSlip = 0, spins = 0, spun = false, minUp = 1;
  run(world, car, 6, (t) => ({ throttle: 1, steer: Math.floor(t / 0.45) % 2 ? 1 : -1, handbrake: false }), () => {
    const s = slipDeg(car);
    maxSlip = Math.max(maxSlip, s);
    if (s > 60 && !spun) { spins++; spun = true; }
    if (s < 20) spun = false;
    minUp = Math.min(minUp, car.up.y);
  });
  console.log(`[slalom] peak slip ${maxSlip.toFixed(0)}°, spins ${spins}, min up.y ${f2(minUp)}, speed ${f2(car.speed)}`);
}
for (const v of [10, 15]) {
  // 2b. A 0.12 s tap (a quick correction) should nudge, not swerve.
  const { world, car } = setup();
  speedUp(world, car, v);
  const y0 = car.yaw;
  run(world, car, 1.2, (t) => ({ throttle: 0.7, steer: t < 0.12 ? 1 : 0, handbrake: false }));
  console.log(`[0.12s tap ${v} m/s] heading change ${((car.yaw - y0) * 57.3).toFixed(1)}°`);
}
{
  // 3. Quick lane change at 16 m/s.
  const { world, car } = setup();
  speedUp(world, car, 16);
  const y0 = car.yaw, x0 = car.pos.x;
  let maxSlip = 0;
  run(world, car, 2, (t) => ({ throttle: 1, steer: t < 0.25 ? 1 : t < 0.5 ? -1 : 0, handbrake: false }), () => (maxSlip = Math.max(maxSlip, slipDeg(car))));
  console.log(`[lane change 16] sideways ${f2(car.pos.x - x0)} m, heading error ${((car.yaw - y0) * 57.3).toFixed(0)}°, peak slip ${maxSlip.toFixed(0)}°`);
}
{
  // 4. Tight turn at walking pace.
  const { world, car } = setup();
  speedUp(world, car, 4);
  let r = 0;
  run(world, car, 3, () => ({ throttle: car.forwardSpeed < 4 ? 0.6 : 0, steer: 1, handbrake: false }), () => (r = car.speed / Math.max(0.01, Math.abs(yawRate(car)))));
  console.log(`[tight turn 4 m/s] turning circle ≈ ${f2(2 * r)} m`);
}
