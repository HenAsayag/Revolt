import * as THREE from 'three';

export type CameraMode = 'chase' | 'bumper';

/** What the camera needs to know about its target each frame (interpolated render pose). */
export interface CameraTarget {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  velocity: THREE.Vector3;
  /** 0..1 of top speed, drives FOV. */
  speedFrac: number;
  grounded: boolean;
}

/**
 * Line-of-sight probe: fraction (0..1) along from→to where scenery blocks the view, or null.
 * The game supplies one backed by the physics world.
 */
export type SightProbe = (from: THREE.Vector3, to: THREE.Vector3) => number | null;

/** Critically damped spring toward `target` (Unity-style SmoothDamp), per component. */
function smoothDampVec(cur: THREE.Vector3, target: THREE.Vector3, vel: THREE.Vector3, smoothTime: number, dt: number): void {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  for (const k of ['x', 'y', 'z'] as const) {
    const change = cur[k] - target[k];
    const temp = (vel[k] + omega * change) * dt;
    vel[k] = (vel[k] - omega * temp) * exp;
    cur[k] = target[k] + (change + temp) * exp;
  }
}

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();

/**
 * Chase camera (spring-damped, swings wide in turns, FOV opens up with speed)
 * and a bumper camera. Toggle with `cycle()`.
 */
export class CameraRig {
  mode: CameraMode = 'chase';

  // Chase tuning — metres, for a ~0.5 m car.
  distance = 1.25;
  /** Extra pull-back at top speed. */
  speedDistance = 0.3;
  height = 0.42;
  lookAhead = 0.8;
  lookHeight = 0.1;
  /** SmoothDamp times: the offset from the car (not world position, so no speed-dependent lag). */
  offsetLag = 0.08;
  headingLag = 0.16;
  verticalLag = 0.09;
  baseFov = 62;
  speedFov = 16;

  private readonly offset = new THREE.Vector3();
  private readonly offsetVel = new THREE.Vector3();
  /** Car position with smoothed height, so bumps and landings don't shake the view. */
  private readonly anchor = new THREE.Vector3();
  private anchorVelY = 0;
  private readonly heading = new THREE.Vector3(0, 0, 1);
  private readonly headingVel = new THREE.Vector3();
  private readonly smoothUp = new THREE.Vector3(0, 1, 0);
  private fov = 62;
  private initialised = false;
  /** Set-piece camera spot (e.g. looking through the loop); null = normal chase. */
  shot: THREE.Vector3 | null = null;
  private shotBlend = 0;
  private readonly shotLook = new THREE.Vector3();

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly probe?: SightProbe) {}

  cycle(): void {
    this.mode = this.mode === 'chase' ? 'bumper' : 'chase';
    this.initialised = false;
  }

  /** Jump straight to the resting position (after resets / respawns). */
  snap(): void {
    this.initialised = false;
  }

  update(t: CameraTarget, dt: number): void {
    dt = Math.min(dt, 1 / 20);
    if (this.mode === 'bumper') this.updateBumper(t, dt);
    else {
      this.updateChase(t, dt);
      this.applyShot(t, dt);
    }
    const targetFov = (this.mode === 'bumper' ? 74 : this.baseFov) + this.speedFov * t.speedFrac * t.speedFrac;
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 3));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private updateChase(t: CameraTarget, dt: number): void {
    // Heading: the car's forward flattened; fall back to travel direction when the nose points
    // straight up/down (loops, tumbles) so the camera doesn't spin.
    _fwd.set(0, 0, 1).applyQuaternion(t.quat);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 0.05) {
      _fwd.set(t.velocity.x, 0, t.velocity.z);
      if (_fwd.lengthSq() < 0.05) _fwd.copy(this.heading);
    }
    _fwd.normalize();

    if (!this.initialised) {
      this.heading.copy(_fwd);
      this.headingVel.set(0, 0, 0);
    } else {
      smoothDampVec(this.heading, _fwd, this.headingVel, this.headingLag, dt);
      this.heading.y = 0;
      this.heading.normalize();
    }

    const dist = this.distance + this.speedDistance * t.speedFrac;
    _desired.copy(this.heading).multiplyScalar(-dist);
    // Going downhill (stairs, drops) the ground behind is higher: lift the camera to stay above it.
    _fwd.set(0, 0, 1).applyQuaternion(t.quat);
    _desired.y = this.height + Math.max(0, -_fwd.y) * dist * 1.3;

    if (!this.initialised) {
      this.offset.copy(_desired);
      this.offsetVel.set(0, 0, 0);
      this.anchor.copy(t.pos);
      this.anchorVelY = 0;
      this.initialised = true;
    } else {
      smoothDampVec(this.offset, _desired, this.offsetVel, this.offsetLag, dt);
      // Vertical anchor: critically damped follow of the car's height.
      const omega = 2 / this.verticalLag;
      const x = omega * dt;
      const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const change = this.anchor.y - t.pos.y;
      const temp = (this.anchorVelY + omega * change) * dt;
      this.anchorVelY = (this.anchorVelY - omega * temp) * exp;
      this.anchor.y = t.pos.y + (change + temp) * exp;
      this.anchor.x = t.pos.x;
      this.anchor.z = t.pos.z;
    }

    this.camera.position.copy(this.anchor).add(this.offset);
    // Never dip below the car's own level by much (stops the camera ploughing into the floor).
    this.camera.position.y = Math.max(this.camera.position.y, t.pos.y + 0.12);
    // Keep scenery (decks, steps, stands) from coming between the camera and the car.
    if (this.probe) {
      _look.copy(t.pos);
      _look.y += 0.15;
      const hit = this.probe(_look, this.camera.position);
      if (hit !== null) this.camera.position.lerpVectors(_look, this.camera.position, Math.max(0.15, hit - 0.08));
    }
    _look.copy(this.anchor).addScaledVector(this.heading, this.lookAhead);
    _look.y += this.lookHeight;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(_look);
  }

  /** Blend from the chase camera to a fixed set-piece spot that watches the car. */
  private applyShot(t: CameraTarget, dt: number): void {
    this.shotBlend = THREE.MathUtils.clamp(this.shotBlend + (this.shot ? dt : -dt) * 2.5, 0, 1);
    if (this.shotBlend <= 0) return;
    if (this.shot) this.shotLook.copy(this.shot);
    const k = this.shotBlend * this.shotBlend * (3 - 2 * this.shotBlend);
    this.camera.position.lerp(this.shotLook, k);
    _look.copy(t.pos);
    _look.y += 0.1;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(_look);
  }

  private updateBumper(t: CameraTarget, dt: number): void {
    _up.set(0, 1, 0).applyQuaternion(t.quat);
    if (!this.initialised) {
      this.smoothUp.copy(_up);
      this.initialised = true;
    }
    this.smoothUp.lerp(_up, 1 - Math.exp(-dt * 12)).normalize();
    this.camera.position.set(0, 0.11, 0.2).applyQuaternion(t.quat).add(t.pos);
    _look.set(0, 0.07, 3).applyQuaternion(t.quat).add(t.pos);
    this.camera.up.copy(this.smoothUp);
    this.camera.lookAt(_look);
  }
}
