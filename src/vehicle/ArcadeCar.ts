import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { DriveInput } from '../core/Input';
import type { CarConfig } from './CarConfig';
import { CAR_GROUPS, CAR_SENSOR_GROUPS, GHOST_GROUPS, GHOST_SENSOR_GROUPS, GROUND_RAY_GROUPS } from '../physics/groups';

/** Per-wheel state, for the visuals (spin, steer, travel) and effects (smoke from contact points). */
export interface WheelState {
  readonly mount: THREE.Vector3;
  readonly front: boolean;
  readonly left: boolean;
  grounded: boolean;
  /** Mount → wheel-centre distance (visual suspension travel). */
  suspensionLength: number;
  contactPoint: THREE.Vector3;
  spinVel: number;
  spin: number;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _g = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _t = new THREE.Vector3();

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const moveTowards = (cur: number, target: number, maxDelta: number) =>
  Math.abs(target - cur) <= maxDelta ? target : cur + Math.sign(target - cur) * maxDelta;
const vec = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });

/**
 * Kart-style arcade car.
 *
 * The body is a capsule on a Rapier dynamic body with rotations locked and gravity off: Rapier
 * only resolves contacts (walls, curbs, other cars). Every step the car itself decides:
 *  - where "down" is — a ray finds the surface under it, and the car aligns to that surface
 *    (so it can never tip over; loops and banked decks just work),
 *  - its heading — steering turns it at a speed-dependent rate,
 *  - its velocity — throttle/brake along the heading, sideways speed bled off by grip (drifting
 *    lowers it), gravity only along the slope, and a firm press onto the surface.
 * Walls are frictionless for the car, so a touch slides you along instead of stopping you.
 */
export class ArcadeCar {
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[] = [];
  readonly sensor: RAPIER.Collider;
  readonly wheels: WheelState[];

  /** Smoothed steering input, -1..1 (+ = right). */
  steer = 0;
  /** Front-wheel angle for the visuals, radians (+ = right). */
  steerAngle = 0;
  /** Kept for the game's rail zones (the corner assist of the old model); unused here. */
  cornerAssist = true;
  forwardSpeed = 0;
  speed = 0;
  /** 4 while on the ground, 0 in the air (wheel-count API the rest of the game uses). */
  groundedCount = 0;
  airTime = 0;
  lastAirTime = 0;
  /** Extra press-down toward the surface (loop, decks), m/s², set by the game each frame. */
  surfaceStick = 0;
  throttleLoad = 0;
  boostTime = 0;
  stunTime = 0;
  /** Signed slip angle, radians (+ = nose left of travel). */
  slipAngle = 0;
  drifting = false;
  driftTime = 0;
  /** Drift direction while drifting: +1 right, -1 left. */
  driftDir = 0;
  driftBoosts = 0;
  lastDriftBoost = 0;
  /** Visual body roll / pitch (radians), eased. */
  lean = 0;
  pitchLean = 0;
  /** Invisible rival: touches nothing but the world (see setGhost). */
  ghost = false;

  readonly prevPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly fwd = new THREE.Vector3(0, 0, 1);
  readonly left = new THREE.Vector3(1, 0, 0);

  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private spinRate = 0;
  private yawNudgeRate = 0;
  private groundDist = 0;
  private prevForward = 0;

  constructor(
    private readonly world: RAPIER.World,
    readonly cfg: CarConfig,
    spawn: THREE.Vector3,
    yaw = 0,
  ) {
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .lockRotations()
        .setGravityScale(0)
        .setLinearDamping(0)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    // Capsule along local Z (Rapier capsules run along Y).
    _q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const capsule = RAPIER.ColliderDesc.capsule(cfg.halfLength, cfg.radius)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setMass(cfg.mass)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(0)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setCollisionGroups(CAR_GROUPS);
    this.colliders.push(world.createCollider(capsule, this.body));
    this.sensor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(cfg.halfTrack + cfg.wheelWidth / 2 + 0.02, 0.09, cfg.halfLength + cfg.radius + 0.05)
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
      contactPoint: new THREE.Vector3(),
      spinVel: 0,
      spin: 0,
    }));
    this.reset(spawn, yaw);
  }

  /** Invisible rival mode: no contact with cars, props or item sensors (world only). */
  setGhost(on: boolean): void {
    this.ghost = on;
    for (const c of this.colliders) c.setCollisionGroups(on ? GHOST_GROUPS : CAR_GROUPS);
    this.sensor.setCollisionGroups(on ? GHOST_SENSOR_GROUPS : CAR_SENSOR_GROUPS);
  }

  /** Start (or extend) a speed boost. */
  boost(seconds: number): void {
    this.boostTime = Math.max(this.boostTime, seconds);
  }

  /** Spin the car (item hits): rad/s of extra yaw that dies away. */
  spin(rate: number): void {
    this.spinRate += rate;
  }

  /** Turn the heading this step at `rate` rad/s (game assists: guide rails). */
  nudgeYaw(rate: number): void {
    this.yawNudgeRate += rate;
  }

  /** Surface under the car along `dir` (usually -up): distance + normal, or null. */
  private probe(dir: THREE.Vector3, reach: number): { dist: number; normal: THREE.Vector3 } | null {
    this.ray.origin = vec(this.pos);
    this.ray.dir = vec(dir);
    const hit = this.world.castRayAndGetNormal(this.ray, reach, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUND_RAY_GROUPS, undefined, this.body);
    if (!hit) return null;
    return { dist: hit.timeOfImpact, normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z) };
  }

  /** Apply this step's controls (call before `world.step()`, then `postStep()` after it). */
  step(dt: number, input: DriveInput): void {
    const cfg = this.cfg;
    let inp = input;
    const stunned = this.stunTime > 0;
    if (stunned) {
      this.stunTime = Math.max(0, this.stunTime - dt);
      this.boostTime = 0;
      inp = { throttle: 0, steer: input.steer * 0.3, handbrake: false };
    }
    const lv = this.body.linvel();
    const v = _v.set(lv.x, lv.y, lv.z);

    // --- Steering input: eased, so a key tap is a nudge and holding it is a full turn.
    const target = clamp(inp.steer, -1, 1);
    const rising = Math.abs(target) > Math.abs(this.steer) && (this.steer === 0 || Math.sign(target) === Math.sign(this.steer));
    this.steer = moveTowards(this.steer, target, (rising ? cfg.steerRise : cfg.steerFall) * dt);

    // --- Where is the ground? Along our own down first (loops, banks), then straight down.
    const reach = cfg.radius + 0.3;
    let hit = this.probe(_t.copy(this.up).negate(), reach);
    if ((!hit || hit.normal.dot(this.up) < 0.4) && this.up.y < 0.98) hit = this.probe(_t.set(0, -1, 0), reach);
    let grounded = false;
    let near = false;
    if (hit && hit.normal.dot(this.up) > 0.3) {
      grounded = hit.dist <= cfg.radius + 0.06;
      near = !grounded;
      this.groundDist = hit.dist;
      this.up.lerp(hit.normal, 1 - Math.exp(-dt * (grounded ? 20 : 6))).normalize();
    } else {
      this.groundDist = reach;
      // Airborne: settle level (and nose-down along the flight path is left to the visuals).
      this.up.lerp(WORLD_UP, 1 - Math.exp(-dt * 2.5)).normalize();
    }
    const contact = grounded || near;
    this.groundedCount = contact ? 4 : 0;

    // Heading stays in the surface plane.
    const h = this.fwd;
    h.addScaledVector(this.up, -h.dot(this.up));
    if (h.lengthSq() < 1e-6) h.copy(_t.set(v.x, 0, v.z).lengthSq() > 1e-4 ? _t : _t.set(0, 0, 1));
    h.normalize();
    this.left.crossVectors(this.up, h).normalize();

    // Velocity in the car's frame.
    let vn = v.dot(this.up);
    let vf = v.dot(h);
    let vs = v.dot(this.left);
    const vAbs = Math.abs(vf);

    // --- Drift: hold DRIFT while steering at speed. Releasing a long drift pays out a boost.
    if (!this.drifting && inp.handbrake && grounded && vf > cfg.driftMinSpeed && Math.abs(this.steer) > 0.3) {
      this.drifting = true;
      this.driftDir = Math.sign(this.steer);
      this.driftTime = 0;
    }
    if (this.drifting) {
      const released = !inp.handbrake;
      if (released || !contact || vf < cfg.driftMinSpeed * 0.5 || stunned) {
        if (released && contact && this.driftTime >= cfg.driftBoostMinTime) {
          this.boost(cfg.driftBoostBase + Math.min(this.driftTime, 2.5) * cfg.driftBoostPerSecond);
          this.lastDriftBoost = this.driftTime;
          this.driftBoosts++;
        }
        this.drifting = false;
        this.driftTime = 0;
      } else {
        this.driftTime += dt;
      }
    }

    // --- Turning.
    let yawRate: number;
    let steerAmt = this.steer;
    if (contact) {
      // Turning needs speed — or wheelspin: with the throttle on you can swing the nose round even
      // from a standstill (e.g. pinned against a wall).
      const speedF = clamp(Math.max(vAbs, Math.abs(inp.throttle) * 1.4) / cfg.turnFullSpeed, 0, 1);
      const turn = THREE.MathUtils.lerp(cfg.turnLow, cfg.turnHigh, clamp(vAbs / cfg.maxSpeed, 0, 1));
      // Drifting: always turning into the drift; steering tightens or widens it.
      if (this.drifting) steerAmt = this.driftDir * cfg.driftTurnBoost * (0.7 + 0.5 * clamp(this.steer * this.driftDir, -1, 1));
      yawRate = -steerAmt * turn * speedF * (vf < -0.2 ? -1 : 1);
    } else {
      yawRate = -this.steer * cfg.airTurn;
    }
    yawRate += this.spinRate + this.yawNudgeRate;
    this.spinRate *= Math.exp(-dt * 2.2);
    this.yawNudgeRate = 0;
    const dYaw = yawRate * dt;
    if (dYaw !== 0) {
      _q.setFromAxisAngle(this.up, dYaw);
      h.applyQuaternion(_q).normalize();
      this.left.crossVectors(this.up, h).normalize();
      if (contact) {
        // Carve: most of the velocity turns with the car (kart feel); the rest becomes a slide.
        const carve = this.drifting ? 0.55 : stunned ? 0.2 : cfg.carve;
        const vfNew = v.dot(h), vsNew = v.dot(this.left);
        vf = THREE.MathUtils.lerp(vfNew, vf, carve);
        vs = THREE.MathUtils.lerp(vsNew, vs, carve);
      } else {
        vf = v.dot(h);
        vs = v.dot(this.left);
      }
    }

    // --- Engine, brakes, grip, gravity.
    const t = inp.throttle;
    const boosting = this.boostTime > 0;
    if (boosting && t < -0.1) this.boostTime = 0; // braking always wins
    const top = cfg.maxSpeed * (this.boostTime > 0 ? cfg.boostTopSpeed : 1);
    _g.set(0, -cfg.gravity, 0);
    if (contact) {
      if (this.boostTime > 0) {
        this.boostTime = Math.max(0, this.boostTime - dt);
        vf += cfg.boostAccel * Math.max(0, 1 - Math.max(vf, 0) / top) * dt;
      }
      if (inp.handbrake && !this.drifting) {
        vf = moveTowards(vf, 0, cfg.brake * 0.8 * dt); // parking brake / handbrake stop
      } else if (t > 0.02) {
        if (vf < -0.3) vf = moveTowards(vf, 0, cfg.brake * t * dt);
        else vf += cfg.accel * t * Math.max(0, 1 - (Math.max(vf, 0) / top) ** 2) * dt;
      } else if (t < -0.02) {
        if (vf > 0.3) vf = Math.max(0, vf - cfg.brake * -t * dt);
        else vf = Math.max(-cfg.maxReverseSpeed, vf - cfg.accel * 0.6 * -t * dt);
      } else {
        vf = moveTowards(vf, 0, cfg.coast * dt);
      }
      // Faster than allowed (a boost ended, a long downhill): ease back.
      if (vf > top) vf -= Math.min(vf - top, 5 * dt);
      const grip = stunned ? cfg.stunGrip : this.drifting ? cfg.driftGrip : cfg.grip;
      vs *= Math.exp(-grip * dt);
      // Slopes pull along the surface; parked on one, stay put.
      const parked = Math.abs(t) < 0.05 && vAbs < 0.4 && !boosting;
      if (parked) {
        vf = 0;
        vs *= 0.5;
      } else {
        const gUp = _g.dot(this.up);
        _t.copy(_g).addScaledVector(this.up, -gUp);
        vf += _t.dot(h) * dt;
        vs += _t.dot(this.left) * dt;
      }
      if (grounded) vn -= (cfg.stick + this.surfaceStick) * dt;
      else vn -= (cfg.snap + cfg.gravity * Math.max(0, this.up.y)) * dt; // just above a bump: pull back down
    } else {
      // Flight: plain gravity.
      vn += _g.dot(this.up) * dt;
      vf += _g.dot(h) * dt;
      vs += _g.dot(this.left) * dt;
    }
    v.copy(h).multiplyScalar(vf).addScaledVector(this.left, vs).addScaledVector(this.up, vn);
    this.body.setLinvel(vec(v), true);

    // --- Orientation: the car always sits on the surface it's driving on.
    _m.makeBasis(this.left, this.up, h);
    this.quat.setFromRotationMatrix(_m);
    this.body.setRotation({ x: this.quat.x, y: this.quat.y, z: this.quat.z, w: this.quat.w }, true);

    // --- Book-keeping for the rest of the game and the visuals.
    this.forwardSpeed = vf;
    this.speed = v.length();
    this.throttleLoad = Math.abs(t);
    this.slipAngle = this.speed > 2.5 ? Math.atan2(-vs, Math.max(Math.abs(vf), 0.1)) : 0;
    if (!contact) {
      this.airTime += dt;
    } else {
      if (this.airTime > 0) this.lastAirTime = this.airTime;
      this.airTime = 0;
    }
    const speedF = clamp(vAbs / cfg.maxSpeed, 0, 1);
    this.steerAngle = this.steer * THREE.MathUtils.lerp(0.5, 0.18, speedF);
    const leanTarget = contact ? clamp(steerAmt, -1.5, 1.5) * speedF * (this.drifting ? 0.16 : 0.09) : 0;
    this.lean += (leanTarget - this.lean) * (1 - Math.exp(-dt * 8));
    const accel = (vf - this.prevForward) / dt;
    this.prevForward = vf;
    this.pitchLean += (clamp(-accel * 0.004, -0.06, 0.06) - this.pitchLean) * (1 - Math.exp(-dt * 6));
    const travel = contact ? clamp(cfg.mountY + this.groundDist - cfg.wheelRadius, 0.02, cfg.suspensionRest) : cfg.suspensionRest;
    for (const w of this.wheels) {
      w.grounded = contact;
      w.suspensionLength = travel;
      w.contactPoint.copy(w.mount).applyQuaternion(this.quat).add(this.pos).addScaledVector(this.up, -(cfg.radius + cfg.mountY));
      w.spinVel = contact ? vf / cfg.wheelRadius : moveTowards(w.spinVel, (t * cfg.maxSpeed) / cfg.wheelRadius, 60 * dt);
      w.spin += w.spinVel * dt;
    }
  }

  /** Record the new pose after `world.step()`; keeps the previous one for render interpolation. */
  postStep(): void {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    const p = this.body.translation();
    this.pos.set(p.x, p.y, p.z);
    this.glanceWalls();
  }

  /**
   * Kart-style wall contact: when the car touches a wall at an angle, its heading swings to run
   * along the wall, so it glides on instead of grinding its nose into it. Head-on hits still stop.
   */
  private glanceWalls(): void {
    if (this.groundedCount === 0) return;
    const col = this.colliders[0];
    this.world.contactPairsWith(col, (other) => {
      if (other.isSensor()) return;
      this.world.contactPair(col, other, (m, flipped) => {
        if (m.numContacts() === 0) return;
        const nn = m.normal();
        // Normal from the wall toward the car.
        const s = flipped ? 1 : -1;
        _t.set(nn.x * s, nn.y * s, nn.z * s);
        if (Math.abs(_t.dot(this.up)) > 0.6) return; // floor / ceiling, not a wall
        _t.addScaledVector(this.up, -_t.dot(this.up)).normalize();
        const into = this.fwd.dot(_t);
        if (into > -0.05 || into < -0.97) return; // parallel already, or a dead-straight head-on hit
        this.fwd.addScaledVector(_t, -into).normalize();
        this.left.crossVectors(this.up, this.fwd).normalize();
      });
    });
  }

  /** Place the car upright at a position/heading, killing all motion. */
  reset(position: THREE.Vector3, yaw: number): void {
    this.fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.up.set(0, 1, 0);
    this.left.crossVectors(this.up, this.fwd).normalize();
    _m.makeBasis(this.left, this.up, this.fwd);
    this.quat.setFromRotationMatrix(_m);
    this.body.setTranslation(vec(position), true);
    this.body.setRotation({ x: this.quat.x, y: this.quat.y, z: this.quat.z, w: this.quat.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.pos.copy(position);
    this.prevPos.copy(position);
    this.prevQuat.copy(this.quat);
    this.steer = this.steerAngle = 0;
    this.forwardSpeed = this.speed = this.prevForward = 0;
    this.airTime = this.lastAirTime = 0;
    this.boostTime = this.stunTime = 0;
    this.drifting = false;
    this.driftTime = 0;
    this.spinRate = this.yawNudgeRate = 0;
    this.lean = this.pitchLean = 0;
  }

  /** Heading (yaw around world up) of the car's forward axis. */
  get yaw(): number {
    return Math.atan2(this.fwd.x, this.fwd.z);
  }

  get isUpsideDown(): boolean {
    return this.up.y < -0.3;
  }
}
