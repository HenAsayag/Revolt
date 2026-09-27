import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BALL_GROUPS } from '../physics/groups';
import { PITCH } from '../world/stadium/layout';

const RADIUS = 0.11; // a real size-5 football — half an RC car long

/** Classic black-and-white ball: icosphere with the 12 pentagon patches painted black. */
function ballGeometry(): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(RADIUS, 3);
  const ico = new THREE.IcosahedronGeometry(1, 0);
  const centres: THREE.Vector3[] = [];
  const p = ico.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i).normalize();
    if (!centres.some((c) => c.distanceTo(v) < 1e-3)) centres.push(v);
  }
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const black = centres.some((c) => c.dot(v) > 0.93);
    col.set(black ? [0.05, 0.05, 0.06] : [0.95, 0.95, 0.93], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export interface GoalEvent {
  ball: number;
  /** +1 = north goal (x > 0), -1 = south goal. */
  end: 1 | -1;
}

/**
 * Footballs on the pitch. Cars don't touch them physically (see groups.ts); their sensor
 * "kicks" a ball — forward, lofted, and nudged toward the nearest goal when it's in range.
 * Balls that cross a goal line between the posts score and respawn a moment later.
 */
export class FootballField {
  readonly bodies: RAPIER.RigidBody[] = [];
  readonly mesh: THREE.InstancedMesh;
  readonly byCollider = new Map<number, number>();
  goals = 0;
  private readonly home: THREE.Vector3[] = [];
  private readonly respawnIn: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(world: RAPIER.World, spots: THREE.Vector3[], private readonly goalTargets: THREE.Vector3[]) {
    this.mesh = new THREE.InstancedMesh(ballGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45 }), Math.max(1, spots.length));
    this.mesh.count = spots.length;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    for (const s of spots) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(s.x, RADIUS + 0.002, s.z).setLinearDamping(0.35).setAngularDamping(0.8).setCcdEnabled(true),
      );
      const col = world.createCollider(
        RAPIER.ColliderDesc.ball(RADIUS).setMass(0.43).setRestitution(0.62).setFriction(0.6).setCollisionGroups(BALL_GROUPS)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
        body,
      );
      this.byCollider.set(col.handle, this.bodies.length);
      body.sleep();
      this.bodies.push(body);
      this.home.push(new THREE.Vector3(s.x, RADIUS + 0.002, s.z));
      this.respawnIn.push(0);
    }
    this.sync(true);
  }

  /** A car drove into ball `i`. Returns true if the ball was kicked. */
  kick(i: number, carVel: { x: number; y: number; z: number }, carPos: THREE.Vector3): boolean {
    const b = this.bodies[i];
    const speed = Math.hypot(carVel.x, carVel.z);
    if (speed < 0.5 || this.respawnIn[i] > 0) return false;
    const t = b.translation();
    let dx = carVel.x / speed, dz = carVel.z / speed;
    // Aim assist: if a goal is within ~70° of the kick and in range, send it at the goal mouth
    // (somewhere between the posts) — scoring should feel like skill, not luck.
    for (const g of this.goalTargets) {
      const gx = g.x - t.x, gz = g.z + (Math.random() - 0.5) * 3.2 - t.z;
      const dist = Math.hypot(gx, gz);
      if (dist > 18) continue;
      const cos = (gx * dx + gz * dz) / dist;
      if (cos < 0.3) continue;
      const k = 0.92;
      dx = dx * (1 - k) + (gx / dist) * k;
      dz = dz * (1 - k) + (gz / dist) * k;
      const n = Math.hypot(dx, dz);
      dx /= n;
      dz /= n;
    }
    // A glancing hit also pushes the ball away from the car's side.
    const sx = t.x - carPos.x, sz = t.z - carPos.z;
    const kickSpeed = 3 + speed * 1.25;
    b.setLinvel({ x: dx * kickSpeed + sx * 1.5, y: 1.6 + speed * 0.22, z: dz * kickSpeed + sz * 1.5 }, true);
    b.setAngvel({ x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20, z: (Math.random() - 0.5) * 20 }, true);
    return true;
  }

  /** Detect goals and handle respawns. Returns the goals scored this frame. */
  update(dt: number): GoalEvent[] {
    const events: GoalEvent[] = [];
    this.bodies.forEach((b, i) => {
      if (this.respawnIn[i] > 0) {
        this.respawnIn[i] -= dt;
        if (this.respawnIn[i] <= 0) this.place(i, this.home[i]);
        return;
      }
      const t = b.translation();
      if (Math.abs(t.x) > PITCH.length / 2 + RADIUS && Math.abs(t.z) < 3.66 && t.y < 2.44) {
        events.push({ ball: i, end: t.x > 0 ? 1 : -1 });
        this.goals++;
        this.respawnIn[i] = 2.5;
      } else if (t.y < -3 || Math.abs(t.x) > 70 || Math.abs(t.z) > 60) {
        this.place(i, this.home[i]);
      }
    });
    return events;
  }

  reset(): void {
    this.bodies.forEach((_, i) => {
      this.respawnIn[i] = 0;
      this.place(i, this.home[i]);
    });
  }

  private place(i: number, at: THREE.Vector3): void {
    const b = this.bodies[i];
    b.setTranslation({ x: at.x, y: at.y + 0.6, z: at.z }, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  sync(all = false): void {
    let dirty = false;
    this.bodies.forEach((b, i) => {
      if (!all && b.isSleeping()) return;
      const t = b.translation(), r = b.rotation();
      this.p.set(t.x, t.y, t.z);
      this.q.set(r.x, r.y, r.z, r.w);
      this.mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.one));
      dirty = true;
    });
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
