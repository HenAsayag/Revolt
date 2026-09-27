import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { DriveInput } from '../core/Input';
import type { CarConfig } from './CarConfig';
import { CAR_GROUPS, CAR_SENSOR_GROUPS, WHEEL_RAY_GROUPS } from '../physics/groups';

export interface WheelState {
  /** Suspension mount in car-local space. */
  readonly mount: THREE.Vector3;
  readonly front: boolean;
  readonly left: boolean;
  grounded: boolean;
  /** Mount → wheel-centre distance (0 = fully compressed, rest = fully extended). */
  suspensionLength: number;
  compression: number;
  /** Suspension force this step, N — doubles as the tyre load. */
  load: number;
  contactPoint: THREE.Vector3;
  contactNormal: THREE.Vector3;
  /** Lateral slip speed at the contact, m/s (for skid marks / tyre squeal later). */
  slip: number;
  /** Wheel angular velocity (rad/s) and accumulated angle, for the visuals. */
  spinVel: number;
  spin: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _mount = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _ws = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _com = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _linImp = new THREE.Vector3();
const _angImp = new THREE.Vector3();

const vec = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const moveTowards = (cur: number, target: number, maxDelta: number) =>
  Math.abs(target - cur) <= maxDelta ? target : cur + Math.sign(target - cur) * maxDelta;

/**
 * Arcade raycast-suspension car on a Rapier dynamic body.
 *
 * Each step: cast one ray per wheel along the car's down axis, apply a spring-damper
 * force at the mount, then tyre forces (drive, brake, lateral grip limited by a friction
 * circle of mu * load) at the contact patch. No Rapier friction is involved in driving,
 * which keeps the handling fully controllable from `CarConfig`.
 */
export class RaycastCar {
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[] = [];
  /** Slightly oversized sensor box: reports cones (and later pickups) the car drives into. */
  readonly sensor: RAPIER.Collider;
  readonly wheels: WheelState[];

  /** Current steering angle, radians, positive = right. */
  steerAngle = 0;
  /** Signed speed along the car's forward axis, m/s. */
  forwardSpeed = 0;
  speed = 0;
  groundedCount = 0;
  /** Seconds since all four wheels left the ground (0 while grounded). */
  airTime = 0;
  /** Duration of the last completed airborne phase (for "AIR TIME" pop-ups). */
  lastAirTime = 0;
  /** Set by track zones (e.g. the loop): extra acceleration pushing the car onto the surface, m/s². */
  surfaceStick = 0;
  /** Engine load 0..1, for audio/RPM gauge. */
  throttleLoad = 0;
  /** Seconds of boost left (boost pads, drift boosts, lightning pickup). */
  boostTime = 0;
  /** Signed slip angle of the body over the ground, radians (+ = nose left of travel). */
  slipAngle = 0;
  /** Current drift length, seconds; released drifts longer than ~0.7 s pay out a boost. */
  driftTime = 0;
  /** Incremented on every drift-boost payout (the game watches it for pop-ups). */
  driftBoosts = 0;
  lastDriftBoost = 0;

  /** Poses for render interpolation between fixed physics steps. */
  readonly prevPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly fwd = new THREE.Vector3(0, 0, 1);
  readonly left = new THREE.Vector3(1, 0, 0);

  private readonly principalInertia: THREE.Vector3;
  private readonly ray: RAPIER.Ray;

  constructor(
    private readonly world: RAPIER.World,
    readonly cfg: CarConfig,
    spawn: THREE.Vector3,
    yaw = 0,
  ) {
    const h = cfg.chassisHalf;
    const m = cfg.mass;
    // Solid-box inertia of the tub, scaled.
    const w = 2 * h.x, ht = 2 * h.y + 0.08, l = 2 * h.z;
    this.principalInertia = new THREE.Vector3(
      (m / 12) * (ht * ht + l * l),
      (m / 12) * (w * w + l * l),
      (m / 12) * (w * w + ht * ht),
    ).multiplyScalar(cfg.inertiaScale);

    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setAdditionalMassProperties(m, cfg.comOffset, vec(this.principalInertia), { x: 0, y: 0, z: 0, w: 1 })
      .setAngularDamping(cfg.groundAngularDamping)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = world.createRigidBody(desc);

    // Tub: as wide as the wheels so walls hit the body, not the (raycast) tyres.
    const tub = RAPIER.ColliderDesc.roundCuboid(cfg.halfTrack + cfg.wheelWidth / 2 - 0.02, h.y - 0.02, h.z + 0.02, 0.02)
      .setDensity(0)
      .setFriction(0.35)
      .setRestitution(0) // bottoming out must not bounce; walls add their own restitution
      .setCollisionGroups(CAR_GROUPS);
    // Roll cage / shell so the car lands on its roof believably.
    const cage = RAPIER.ColliderDesc.roundCuboid(h.x - 0.02, 0.035, h.z * 0.55, 0.02)
      .setTranslation(0, h.y + 0.05, -0.02)
      .setDensity(0)
      .setFriction(0.5)
      .setRestitution(0.05)
      .setCollisionGroups(CAR_GROUPS);
    this.colliders.push(world.createCollider(tub, this.body), world.createCollider(cage, this.body));
    this.sensor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(cfg.halfTrack + cfg.wheelWidth / 2 + 0.02, 0.09, h.z + 0.07)
        .setTranslation(0, 0.02, 0)
        .setSensor(true)
        .setDensity(0)
        .setCollisionGroups(CAR_SENSOR_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );

    this.wheels = [
      [1, cfg.frontAxleZ, true], [-1, cfg.frontAxleZ, true],
      [1, cfg.rearAxleZ, false], [-1, cfg.rearAxleZ, false],
    ].map(([side, z, front]) => ({
      mount: new THREE.Vector3((side as number) * cfg.halfTrack, cfg.mountY, z as number),
      front: front as boolean,
      left: (side as number) > 0,
      grounded: false,
      suspensionLength: cfg.suspensionRest,
      compression: 0,
      load: 0,
      contactPoint: new THREE.Vector3(),
      contactNormal: new THREE.Vector3(0, 1, 0),
      slip: 0,
      spinVel: 0,
      spin: 0,
    }));

    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.readPose();
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
  }

  /** Apply this step's forces (call before `world.step()`, then `postStep()` after it). */
  step(dt: number, input: DriveInput): void {
    const cfg = this.cfg;
    const body = this.body;
    this.readPose();

    const lv = body.linvel();
    const linvel = _v.set(lv.x, lv.y, lv.z);
    this.speed = linvel.length();
    this.forwardSpeed = linvel.dot(this.fwd);

    // --- Steering: lock limited to what the tyres can use at this speed (the steer angle for
    // max lateral grip plus a little slip), so full lock carves instead of scrubbing speed.
    const wheelbase = cfg.frontAxleZ - cfg.rearAxleZ;
    const vAbs = Math.max(Math.abs(this.forwardSpeed), 0.1);
    const gripSteer = Math.atan((wheelbase * cfg.gripFront * 9.81) / (vAbs * vAbs)) + cfg.steerSlipAngle;
    const maxSteer = clamp(gripSteer, cfg.maxSteerHigh, cfg.maxSteerLow);
    const targetSteer = input.steer * maxSteer;
    const returning = Math.abs(targetSteer) < Math.abs(this.steerAngle) || Math.sign(targetSteer) !== Math.sign(this.steerAngle);
    this.steerAngle = moveTowards(this.steerAngle, targetSteer, (returning ? cfg.steerReturnSpeed : cfg.steerSpeed) * dt);

    // --- Engine & brakes (totals, split over wheels below).
    const t = input.throttle;
    const v = this.forwardSpeed;
    // Braking always wins: it cancels a boost so you can still slow for a corner.
    if (t < -0.1 && this.boostTime > 0) this.boostTime = 0;
    const boosting = this.boostTime > 0;
    const braking = !boosting && ((t < 0 && v > 0.6) || (t > 0 && v < -0.6));
    let drive = 0;
    let brake = 0;
    if (boosting) {
      this.boostTime = Math.max(0, this.boostTime - dt);
      drive = cfg.driveForce * cfg.boostDrive * Math.max(0, 1 - (Math.max(v, 0) / (cfg.maxSpeed * cfg.boostTopSpeed)) ** 3);
    } else if (braking) {
      brake = Math.abs(t) * cfg.brakeForce;
    } else if (t > 0) {
      drive = t * cfg.driveForce * Math.max(0, 1 - (Math.max(v, 0) / cfg.maxSpeed) ** 3);
    } else if (t < 0) {
      drive = t * cfg.driveForce * 0.65 * Math.max(0, 1 - (Math.max(-v, 0) / cfg.maxReverseSpeed) ** 2);
    }
    this.throttleLoad = Math.abs(t);

    // --- Wheels.
    const massShare = cfg.mass / 4;
    const down = _w.copy(this.up).negate();
    const rayLen = cfg.suspensionRest + cfg.wheelRadius;
    let grounded = 0;
    _n.set(0, 0, 0);
    // Wheel impulses are summed and applied once after the loop (Jacobi style): applying them
    // wheel-by-wheel lets later wheels react to earlier ones, which biases the car sideways.
    const c = body.worldCom();
    _com.set(c.x, c.y, c.z);
    _linImp.set(0, 0, 0);
    _angImp.set(0, 0, 0);
    const addImpulse = (imp: THREE.Vector3, at: THREE.Vector3) => {
      _linImp.add(imp);
      _angImp.add(_arm.subVectors(at, _com).cross(imp));
    };
    const idleHold = Math.abs(t) < 0.05 && !input.handbrake && Math.abs(v) < 0.8;

    for (const wheel of this.wheels) {
      _mount.copy(wheel.mount).applyQuaternion(this.quat).add(this.pos);
      this.ray.origin = vec(_mount);
      this.ray.dir = vec(down);
      const hit = this.world.castRayAndGetNormal(
        this.ray, rayLen, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, WHEEL_RAY_GROUPS, undefined, body,
      );
      if (!hit || hit.normal.x * this.up.x + hit.normal.y * this.up.y + hit.normal.z * this.up.z < 0.25) {
        wheel.grounded = false;
        wheel.load = 0;
        wheel.slip = 0;
        wheel.compression = 0;
        wheel.suspensionLength = moveTowards(wheel.suspensionLength, cfg.suspensionRest, 1.5 * dt);
        // Free-spinning wheels: spin up with throttle, slowly coast down.
        wheel.spinVel = moveTowards(wheel.spinVel, (t * cfg.maxSpeed) / cfg.wheelRadius, 60 * dt);
        wheel.spin += wheel.spinVel * dt;
        continue;
      }
      grounded++;
      wheel.grounded = true;
      const toi = hit.timeOfImpact;
      wheel.contactPoint.copy(down).multiplyScalar(toi).add(_mount);
      wheel.contactNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      _n.add(wheel.contactNormal);

      // Suspension spring-damper, measured along the car's up axis, pushing along the contact normal.
      const suspLen = Math.max(0, toi - cfg.wheelRadius);
      const compression = clamp(cfg.suspensionRest - suspLen, 0, cfg.suspensionRest);
      const mv = body.velocityAtPoint(vec(_mount));
      // Clamp the damper input: hitting a ramp face at speed would otherwise spike the force and
      // spring-launch the car far higher than the ramp geometry implies.
      // Rebound (extension) gets a much wider clamp so landings are soaked up instead of
      // springing the car back into the air.
      const compVel = clamp(mv.x * down.x + mv.y * down.y + mv.z * down.z, -cfg.damperMaxReboundVel, cfg.damperMaxVel);
      let f = cfg.springK * compression + (compVel > 0 ? cfg.damperCompression : cfg.damperRebound) * compVel;
      const stopStart = cfg.bumpStopStart * cfg.suspensionRest;
      // Bump stop with hysteresis: full force while compressing, a fraction while extending,
      // so the energy of a hard landing is lost instead of relaunching the car.
      if (compression > stopStart) f += cfg.bumpStopK * (compression - stopStart) * (compVel > 0 ? 1 : cfg.bumpStopReturn);
      f = clamp(f, 0, cfg.maxSuspensionForce);
      wheel.suspensionLength = suspLen;
      wheel.compression = compression;
      wheel.load = f;
      addImpulse(_imp.copy(wheel.contactNormal).multiplyScalar(f * dt), _mount);

      // Tyre frame: steered forward projected onto the contact plane.
      const n = wheel.contactNormal;
      _wf.copy(this.fwd);
      if (wheel.front && this.steerAngle !== 0) _wf.applyAxisAngle(this.up, -this.steerAngle);
      _wf.addScaledVector(n, -_wf.dot(n)).normalize();
      _ws.crossVectors(n, _wf).normalize();

      _pt.copy(n).multiplyScalar(cfg.tireForceLift).add(wheel.contactPoint);
      const pv = body.velocityAtPoint(vec(_pt));
      const vLong = pv.x * _wf.x + pv.y * _wf.y + pv.z * _wf.z;
      const vLat = pv.x * _ws.x + pv.y * _ws.y + pv.z * _ws.z;

      const handbraking = input.handbrake && !wheel.front;
      const mu = wheel.front ? cfg.gripFront : cfg.gripRear * (handbraking ? cfg.handbrakeRearGrip : 1);
      // Blend real load with static load so grip doesn't flicker as the springs bounce.
      const staticLoad = (cfg.mass * 9.81) / 4;
      const maxF = mu * (0.6 * f + 0.4 * staticLoad);

      let latF = -vLat * (massShare / dt) * cfg.lateralStiffness;
      // Longitudinal: 4WD drive, brakes that can't push the car backwards, rolling drag.
      const stopF = Math.abs(vLong) * (massShare / dt) * 0.5;
      let longF = drive / 4 - vLong * cfg.coastDrag;
      if (brake > 0) longF -= Math.sign(vLong) * Math.min(brake / 4, stopF);
      if (handbraking) longF -= Math.sign(vLong) * Math.min(cfg.handbrakeForce / 2, stopF);
      if (idleHold) longF = -vLong * (massShare / dt) * 0.5; // rolling resistance "holds" a parked car

      // Friction circle, arcade flavour: lateral grip first, but drive/brake always keep a
      // share so the car doesn't bog down at full lock.
      latF = clamp(latF, -maxF, maxF);
      const longMax = maxF * Math.sqrt(Math.max(cfg.longGripReserve, 1 - (latF / maxF) ** 2));
      longF = clamp(longF, -longMax, longMax);
      wheel.slip = Math.abs(vLat);

      addImpulse(_imp.copy(_wf).multiplyScalar(longF * dt).addScaledVector(_ws, latF * dt), _pt);

      wheel.spinVel = handbraking ? 0 : vLong / cfg.wheelRadius;
      wheel.spin += wheel.spinVel * dt;
    }
    this.groundedCount = grounded;
    body.applyImpulse(vec(_linImp), true);
    body.applyTorqueImpulse(vec(_angImp), true);

    // --- Whole-body forces.
    const speed2 = this.speed * this.speed;
    _imp.set(0, 0, 0);
    if (this.speed > 0.01) _imp.copy(linvel).multiplyScalar((-cfg.airDrag * this.speed * dt));
    if (grounded >= 2) {
      _n.normalize();
      const pushDown = cfg.downforce * speed2 + this.surfaceStick * cfg.mass;
      _imp.addScaledVector(_n, -pushDown * dt);
    }
    body.applyImpulse(vec(_imp), true);

    // --- Air time + air control.
    if (grounded === 0) {
      this.airTime += dt;
      // In the loop the surface stick keeps the car on the track; levelling it would fight that.
      if (this.surfaceStick <= 0) this.airControl(dt, input, linvel);
      body.setAngularDamping(cfg.airAngularDamping);
    } else {
      this.slipAngle = this.computeSlip(linvel);
      if (grounded >= 3 && !input.handbrake) this.stabilizeYaw(dt);
      this.trackDrift(dt, input, grounded);
      if (this.airTime > 0) this.lastAirTime = this.airTime;
      this.airTime = 0;
      body.setAngularDamping(cfg.groundAngularDamping);
    }
  }

  /**
   * Airborne attitude assist: a PD controller eases the nose toward the flight path and
   * level roll; the player biases it (throttle = nose down, steer = roll + a little yaw).
   * Only active while roughly upright, so real tumbles still end on the roof.
   */
  private airControl(dt: number, input: DriveInput, linvel: THREE.Vector3): void {
    const cfg = this.cfg;
    const I = this.principalInertia;
    const av = this.body.angvel();
    const wLeft = av.x * this.left.x + av.y * this.left.y + av.z * this.left.z;
    const wFwd = av.x * this.fwd.x + av.y * this.fwd.y + av.z * this.fwd.z;
    let aPitch = 0;
    let aRoll = 0;
    if (this.up.y > 0.35) {
      const pitch = Math.asin(clamp(this.fwd.y, -1, 1)); // + = nose up
      const roll = Math.asin(clamp(this.left.y, -1, 1)); // + = right side down
      const hSpeed = Math.hypot(linvel.x, linvel.z);
      const flightPitch = Math.atan2(linvel.y, Math.max(hSpeed, 1)) * cfg.airFollowTrajectory;
      const targetPitch = flightPitch - input.throttle * cfg.airPitchBias;
      const targetRoll = input.steer * cfg.airRollBias;
      // Pitch rate (nose up) is -wLeft; roll rate is +wFwd.
      const pAcc = cfg.airKp * (targetPitch - pitch) + cfg.airKd * wLeft;
      aPitch = -clamp(pAcc, -cfg.airMaxAccel, cfg.airMaxAccel);
      aRoll = clamp(cfg.airKp * (targetRoll - roll) - cfg.airKd * wFwd, -cfg.airMaxAccel, cfg.airMaxAccel);
    }
    const aYaw = -input.steer * cfg.airYawAccel;
    _imp.set(0, 0, 0)
      .addScaledVector(this.left, aPitch * I.x * dt)
      .addScaledVector(this.fwd, aRoll * I.z * dt)
      .addScaledVector(this.up, aYaw * I.y * dt);
    this.body.applyTorqueImpulse(vec(_imp), true);
  }

  /** Start (or extend) a speed boost. */
  boost(seconds: number): void {
    this.boostTime = Math.max(this.boostTime, seconds);
  }

  /** Slip angle between heading and travel, in the car's ground plane; 0 when slow. */
  private computeSlip(linvel: THREE.Vector3): number {
    const up = this.up;
    const vn = linvel.dot(up);
    const vx = linvel.x - up.x * vn, vy = linvel.y - up.y * vn, vz = linvel.z - up.z * vn;
    const vPlanar = Math.hypot(vx, vy, vz);
    if (vPlanar < 2.5) return 0;
    const f = this.fwd;
    const dot = (f.x * vx + f.y * vy + f.z * vz) / vPlanar;
    // (v × fwd) · up: positive when the nose points left of the travel direction.
    const cross = ((vy * f.z - vz * f.y) * up.x + (vz * f.x - vx * f.z) * up.y + (vx * f.y - vy * f.x) * up.z) / vPlanar;
    return Math.atan2(cross, dot);
  }

  /** Drift boost: hold a slide (handbrake or big slip angle) and release it cleanly to earn a boost. */
  private trackDrift(dt: number, input: DriveInput, grounded: number): void {
    const cfg = this.cfg;
    const slip = Math.abs(this.slipAngle);
    const drifting = grounded >= 3 && this.speed > 5 && slip < 1.6 && (slip > 0.3 || (input.handbrake && Math.abs(input.steer) > 0.3));
    if (drifting) {
      this.driftTime += dt;
      return;
    }
    if (this.driftTime > cfg.driftBoostMinTime && slip < 0.2 && !input.handbrake) {
      this.boost(cfg.driftBoostBase + Math.min(this.driftTime, 2) * cfg.driftBoostPerSecond);
      this.lastDriftBoost = this.driftTime;
      this.driftBoosts++;
    }
    if (slip < 0.2) this.driftTime = 0;
  }

  /**
   * Drift catch: once the handbrake is released, gently yaw the car back toward its direction of
   * travel so slides end in a controllable way instead of a spin. Skipped when reversing.
   */
  private stabilizeYaw(dt: number): void {
    const cfg = this.cfg;
    const up = this.up;
    const slip = this.slipAngle;
    if (Math.abs(slip) < cfg.slipAssistStart || Math.abs(slip) > 2.0) return;
    const excess = slip - Math.sign(slip) * cfg.slipAssistStart;
    const av = this.body.angvel();
    const wUp = av.x * up.x + av.y * up.y + av.z * up.z;
    // Only resist rotation that deepens the slide.
    const deepening = Math.sign(wUp) === Math.sign(slip) ? wUp : 0;
    const a = clamp(-cfg.slipAssist * excess - cfg.slipAssistDamp * deepening, -cfg.slipAssistMax, cfg.slipAssistMax);
    _imp.copy(up).multiplyScalar(a * this.principalInertia.y * dt);
    this.body.applyTorqueImpulse(vec(_imp), true);
  }

  /** Record the new pose after `world.step()`; keeps the previous one for render interpolation. */
  postStep(): void {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.readPose();
  }

  /** Place the car upright at a position/heading, killing all motion. */
  reset(position: THREE.Vector3, yaw: number): void {
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation(vec(position), true);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.airTime = 0;
    this.lastAirTime = 0;
    this.boostTime = 0;
    this.driftTime = 0;
    this.readPose();
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
  }

  /** Heading (yaw around world up) of the car's forward axis. */
  get yaw(): number {
    return Math.atan2(this.fwd.x, this.fwd.z);
  }

  get isUpsideDown(): boolean {
    return this.up.y < 0.1;
  }

  private readPose(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.fwd.set(0, 0, 1).applyQuaternion(this.quat);
    this.left.set(1, 0, 0).applyQuaternion(this.quat);
  }
}
