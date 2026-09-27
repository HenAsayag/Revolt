import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONE_GROUPS } from '../physics/groups';

const HEIGHT = 0.32;
const BASE = 0.2;
const BASE_H = 0.022;
const RADIUS = 0.085;

/** Orange cone with a white reflective band on a black square base; origin at the base centre. */
function coneGeometry(): THREE.BufferGeometry {
  const paint = (g: THREE.BufferGeometry, hex: string) => {
    const c = new THREE.Color(hex);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const h = HEIGHT - BASE_H;
  const rAt = (y: number) => RADIUS + (0.012 - RADIUS) * (y / h);
  const band0 = h * 0.45, band1 = h * 0.62;
  const seg = (y0: number, y1: number, hex: string) =>
    paint(new THREE.CylinderGeometry(rAt(y1), rAt(y0), y1 - y0, 16, 1, true).translate(0, BASE_H + (y0 + y1) / 2, 0), hex);
  return mergeGeometries([
    paint(new THREE.BoxGeometry(BASE, BASE_H, BASE).translate(0, BASE_H / 2, 0), '#1a1a1a'),
    seg(0, band0, '#ff6a10'),
    seg(band0, band1, '#f2f2f2'),
    seg(band1, h, '#ff6a10'),
    paint(new THREE.CircleGeometry(0.012, 10).rotateX(-Math.PI / 2).translate(0, HEIGHT, 0), '#ff6a10'),
  ])!;
}

/**
 * Knock-over traffic cones: light dynamic Rapier bodies (cone + base) drawn with one
 * InstancedMesh that follows the bodies. Sleeping cones cost nothing per frame.
 */
export class ConeField {
  readonly bodies: RAPIER.RigidBody[] = [];
  /** Collider handle → cone index, for collision events. */
  readonly byCollider = new Map<number, number>();
  /** Total cones hit by cars (for stunt/audio hooks). */
  hits = 0;
  readonly mesh: THREE.InstancedMesh;
  private readonly home: { pos: THREE.Vector3; yaw: number }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(
    world: RAPIER.World,
    placements: { pos: THREE.Vector3; yaw: number }[],
  ) {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(coneGeometry(), mat, Math.max(1, placements.length));
    this.mesh.count = placements.length;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // cones move; bounds would go stale

    for (const pl of placements) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pl.yaw);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(pl.pos.x, pl.pos.y, pl.pos.z)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setLinearDamping(0.25)
          .setAngularDamping(0.6)
          .setCanSleep(true),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(BASE / 2, BASE_H / 2, BASE / 2)
          .setTranslation(0, BASE_H / 2, 0)
          .setDensity(160)
          .setFriction(0.7)
          .setRestitution(0.2)
          .setCollisionGroups(CONE_GROUPS),
        body,
      );
      const base = body.collider(0);
      // Physics body is a slim vertical cylinder, not a cone: a car bumper meeting a sloped
      // cone face gets a contact normal pointing up, so the pinned cone acts as a ramp and
      // flips the car. A cylinder's side normals are horizontal, so the cone just gets shoved.
      const hh = (HEIGHT - BASE_H) / 2;
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(hh, RADIUS * 0.65)
          .setTranslation(0, BASE_H + hh, 0)
          .setDensity(55)
          .setFriction(0.5)
          .setRestitution(0.3)
          .setCollisionGroups(CONE_GROUPS)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
        body,
      );
      const index = this.bodies.length;
      this.byCollider.set(base.handle, index);
      this.byCollider.set(body.collider(1).handle, index);
      base.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      body.sleep();
      this.bodies.push(body);
      this.home.push({ pos: pl.pos.clone(), yaw: pl.yaw });
    }
    this.sync(true);
  }

  /** Copy body poses into the instanced mesh (only awake cones unless `all`). */
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

  /**
   * A car touched cone `i`: launch it ahead of the car (arcade-style) rather than letting it
   * topple under the chassis. Ignored if the cone is already flying.
   */
  kick(i: number, carVel: { x: number; y: number; z: number }, carPos: { x: number; z: number }): boolean {
    const b = this.bodies[i];
    const v = b.linvel();
    if (Math.hypot(v.x, v.y, v.z) > 2) return false;
    const speed = Math.hypot(carVel.x, carVel.z);
    if (speed < 0.3) return false;
    const k = 1.2 + Math.random() * 0.25;
    // Throw it forward and out to whichever side of the car it's on — never up into the chassis.
    const nx = -carVel.z / speed, nz = carVel.x / speed;
    const t = b.translation();
    const side = Math.sign((t.x - carPos.x) * nx + (t.z - carPos.z) * nz) || 1;
    const out = side * (0.25 + Math.random() * 0.2) * speed;
    b.setLinvel({ x: carVel.x * k + nx * out, y: 0.5 + Math.random() * 0.6, z: carVel.z * k + nz * out }, true);
    b.setAngvel({ x: (Math.random() - 0.5) * 24, y: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 24 }, true);
    this.hits++;
    return true;
  }

  /** How many cones are currently tumbling (cheap "cone hit" signal for audio later). */
  awakeCount(): number {
    let n = 0;
    for (const b of this.bodies) if (!b.isSleeping()) n++;
    return n;
  }

  /** Stand every cone back up where it started. */
  reset(): void {
    this.bodies.forEach((b, i) => {
      const h = this.home[i];
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.yaw);
      b.setTranslation({ x: h.pos.x, y: h.pos.y, z: h.pos.z }, false);
      b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, false);
      b.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.sleep();
    });
    this.sync(true);
  }
}
