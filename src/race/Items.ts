import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PAD_GROUPS, PROJECTILE_GROUPS } from '../physics/groups';
import type { Track } from '../track/Track';
import type { RaycastCar } from '../vehicle/RaycastCar';

export type ItemKind = 'boost' | 'bomb' | 'oil' | 'pulse';
export const ITEM_KINDS: ItemKind[] = ['boost', 'bomb', 'oil', 'pulse'];
export const ITEM_NAMES: Record<ItemKind, string> = { boost: 'LIGHTNING', bomb: 'BOUNCY BOMB', oil: 'OIL SLICK', pulse: 'ELECTRIC PULSE' };

/** Item odds by race position: the leader gets mostly defensive items, the back of the pack speed. */
export function rollItem(place: number, racers: number, rnd = Math.random): ItemKind {
  const p = racers > 1 ? (place - 1) / (racers - 1) : 0.5; // 0 = leader … 1 = last
  const w: Record<ItemKind, number> = { boost: 0.15 + 0.5 * p, bomb: 0.3, oil: 0.4 - 0.3 * p, pulse: 0.1 + 0.25 * p };
  let r = rnd() * ITEM_KINDS.reduce((sum, k) => sum + w[k], 0);
  for (const k of ITEM_KINDS) {
    r -= w[k];
    if (r <= 0) return k;
  }
  return 'boost';
}

const svg = (body: string) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>${body}</svg>`)}")`;
/** HUD slot icons (CSS background-image values). */
export const ITEM_ICONS: Record<ItemKind, string> = {
  boost: svg(`<polygon points='38,3 13,36 29,36 22,61 52,24 35,24 44,3' fill='#ffd21f' stroke='#b36b00' stroke-width='3' stroke-linejoin='round'/>`),
  bomb: svg(`<circle cx='29' cy='38' r='20' fill='#1c1c22'/><circle cx='22' cy='31' r='6' fill='#5c5c68'/><rect x='36' y='13' width='9' height='11' rx='2' transform='rotate(38 40 18)' fill='#4a4a55'/><path d='M44 13 q6 -9 13 -5' stroke='#d9a066' stroke-width='3' fill='none'/><circle cx='57' cy='8' r='5' fill='#ffcf3a'/><circle cx='57' cy='8' r='2.5' fill='#fff'/>`),
  oil: svg(`<path d='M32 5 C21 22 13 32 13 42 a19 19 0 0 0 38 0 C51 32 43 22 32 5z' fill='#231a36' stroke='#9b7cff' stroke-width='3'/><ellipse cx='24' cy='41' rx='4' ry='8' fill='#9b7cff' opacity='.75'/>`),
  pulse: svg(`<circle cx='32' cy='32' r='27' fill='none' stroke='#3fe6ff' stroke-width='4'/><circle cx='32' cy='32' r='17' fill='none' stroke='#3fe6ff' stroke-width='4' opacity='.65'/><polygon points='35,13 22,35 31,35 28,51 43,28 34,28' fill='#fff'/>`),
};

// ---------------------------------------------------------------------------------------------
// Pickup boxes

const BOX = 0.25;
const BOX_RESPAWN = 3;
const FACE_COLORS = ['#ff4d4d', '#ffb02e', '#ffe44d', '#4dff88', '#4dc3ff', '#b36bff'];

/** Rows of spinning rainbow boxes across the track; drive through one to get an item. */
export class PickupBoxes {
  readonly byCollider = new Map<number, number>();
  private readonly spots: THREE.Vector3[] = [];
  private readonly hiddenFor: number[] = [];
  private readonly grow: number[] = [];
  private readonly mesh: THREE.InstancedMesh;
  /** Bright core inside each box, so they read from a distance. */
  private readonly core: THREE.InstancedMesh;
  private time = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();

  constructor(scene: THREE.Scene, world: RAPIER.World, track: Track, rows: number[]) {
    for (const s of rows) {
      const smp = track.sampleAt(s);
      const room = smp.width / 2 - 0.4;
      for (const lat of [-1, 0, 1]) {
        const pos = track.pointAt(s, lat * room).addScaledVector(smp.up, 0.3);
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z));
        const col = world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.2, 0.3, 0.2).setSensor(true).setCollisionGroups(PAD_GROUPS)
            .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
          body,
        );
        this.byCollider.set(col.handle, this.spots.length);
        this.spots.push(pos);
        this.hiddenFor.push(0);
        this.grow.push(1);
      }
    }
    const geo = new THREE.BoxGeometry(BOX, BOX, BOX);
    const colors: number[] = [];
    for (let f = 0; f < 6; f++) {
      const c = new THREE.Color(FACE_COLORS[f]);
      for (let v = 0; v < 4; v++) colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    // Unlit: the sun and tone mapping would wash the rainbow out to pastel.
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.spots.length);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    const coreMat = new THREE.MeshBasicMaterial({ color: '#fffbe0' });
    this.core = new THREE.InstancedMesh(new THREE.OctahedronGeometry(BOX * 0.32), coreMat, this.spots.length);
    this.core.frustumCulled = false;
    scene.add(this.core, this.mesh);
    this.update(0);
  }

  private enabled = true;

  /** Pickups off (menu option): boxes vanish and can't be collected. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.mesh.visible = this.core.visible = on;
  }

  /** Box `i` was driven through: true (and it hides for a moment) if it was there. */
  take(i: number): boolean {
    if (!this.enabled || this.hiddenFor[i] > 0) return false;
    this.hiddenFor[i] = BOX_RESPAWN;
    this.grow[i] = 0;
    return true;
  }

  reset(): void {
    this.hiddenFor.fill(0);
    this.grow.fill(1);
  }

  update(dt: number): void {
    this.time += dt;
    this.spots.forEach((pos, i) => {
      if (this.hiddenFor[i] > 0) this.hiddenFor[i] = Math.max(0, this.hiddenFor[i] - dt);
      else this.grow[i] = Math.min(1, this.grow[i] + dt * 4);
      const g = this.hiddenFor[i] > 0 ? 0 : this.grow[i];
      const pop = g < 1 ? g * (1 + 0.35 * Math.sin(g * Math.PI)) : 1; // overshoot as it reappears
      this.p.copy(pos);
      this.p.y += Math.sin(this.time * 2.2 + i * 1.3) * 0.03;
      this.q.setFromEuler(this.e.set(this.time * 1.4 + i, this.time * 1.9 + i * 0.7, 0.4));
      this.m.compose(this.p, this.q, this.sc.setScalar(Math.max(pop, 1e-3)));
      this.mesh.setMatrixAt(i, this.m);
      this.q.setFromEuler(this.e.set(0, -this.time * 3, 0));
      this.m.compose(this.p, this.q, this.sc.setScalar(Math.max(pop, 1e-3) * (1 + 0.12 * Math.sin(this.time * 6 + i))));
      this.core.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.core.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Items in play

export interface ItemHit<T> {
  victim: T;
  by: T;
  kind: Exclude<ItemKind, 'boost'>;
}

interface Bomb<T> { body: RAPIER.RigidBody; mesh: THREE.Group; light: THREE.MeshBasicMaterial; owner: T; age: number }
interface Slick<T> { pos: THREE.Vector3; normal: THREE.Vector3; mesh: THREE.Mesh; owner: T; age: number; cooldown: Map<T, number>; hitsLeft: number }
interface Fx { mesh: THREE.Mesh; age: number; life: number; from: number; to: number; opacity: number }

const BOOST_SECONDS = 1.8;
const BOMB_FUSE = 3;
const BOMB_RADIUS = 2.1;
const OIL_LIFE = 10;
/** Cars a slick can spin before it's smeared away. */
const OIL_HITS = 2;
const OIL_RADIUS = 0.5;
const MAX_SLICKS = 8;
const PULSE_RADIUS = 4.5;

const _d = new THREE.Vector3();
const _i = new THREE.Vector3();

/**
 * Everything items do once used: bombs in flight, oil on the ground, pulse rings, the flashes,
 * the "stunned" sparkle over hit cars, and the hits themselves (returned for HUD / score).
 */
export class ItemWorld<T extends { car: RaycastCar }> {
  private readonly bombs: Bomb<T>[] = [];
  private readonly slicks: Slick<T>[] = [];
  private readonly fx: Fx[] = [];
  private readonly hits: ItemHit<T>[] = [];
  private readonly stars = new Map<T, THREE.Mesh>();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly bombGeo = new THREE.SphereGeometry(0.08, 16, 12);
  private readonly bombMat = new THREE.MeshStandardMaterial({ color: '#1c1c22', roughness: 0.35, metalness: 0.3 });
  private readonly fuseGeo = new THREE.SphereGeometry(0.025, 8, 6);
  private readonly oilGeo = oilSplat();
  private readonly burstGeo = new THREE.SphereGeometry(1, 20, 14);
  private readonly ringGeo = new THREE.RingGeometry(0.72, 1, 56);
  private readonly starGeo = new THREE.TorusGeometry(0.11, 0.012, 6, 20);
  private readonly starMat = new THREE.MeshBasicMaterial({ color: '#8ff4ff' });

  /** Sound / particle hook: an item went off (`boost`, `throw`, `explode`, `oil`, `zap`) at `at`. */
  onFx: ((kind: 'boost' | 'throw' | 'explode' | 'oil' | 'zap', at: THREE.Vector3, by: T) => void) | null = null;

  constructor(private readonly scene: THREE.Scene, private readonly world: RAPIER.World, private readonly racers: T[]) {}

  use(user: T, kind: ItemKind): void {
    const car = user.car;
    if (kind === 'boost') {
      car.boost(BOOST_SECONDS);
      this.onFx?.('boost', car.pos, user);
    }
    else if (kind === 'bomb') this.throwBomb(user);
    else if (kind === 'oil') this.dropOil(user);
    else this.pulse(user);
  }

  /** Advance everything; returns the hits that happened this frame. */
  update(dt: number): ItemHit<T>[] {
    this.updateBombs(dt);
    this.updateSlicks(dt);
    this.updateFx(dt);
    this.updateStars(dt);
    // (Includes hits from items used since the last update, e.g. a pulse lands instantly.)
    return this.hits.splice(0);
  }

  /** Remove every bomb, slick and effect (race restart). */
  clear(): void {
    for (const b of this.bombs) this.removeBomb(b);
    this.bombs.length = 0;
    for (const s of this.slicks) this.scene.remove(s.mesh);
    this.slicks.length = 0;
    for (const f of this.fx) this.scene.remove(f.mesh);
    this.fx.length = 0;
    this.hits.length = 0;
  }

  // --- Bouncy bomb: lobbed forward, bounces off everything, goes off near a car or after the fuse.

  private throwBomb(owner: T): void {
    const car = owner.car;
    const at = car.pos.clone().addScaledVector(car.fwd, 0.38).addScaledVector(car.up, 0.14);
    const v = car.body.linvel();
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z)
        .setLinvel(v.x + car.fwd.x * 7 + car.up.x * 2.4, v.y + car.fwd.y * 7 + car.up.y * 2.4, v.z + car.fwd.z * 7 + car.up.z * 2.4)
        .setLinearDamping(0.1).setCcdEnabled(true),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(0.08).setMass(0.35).setRestitution(0.72).setFriction(0.4).setCollisionGroups(PROJECTILE_GROUPS),
      body,
    );
    const mesh = new THREE.Group();
    const ball = new THREE.Mesh(this.bombGeo, this.bombMat);
    ball.castShadow = true;
    const light = new THREE.MeshBasicMaterial({ color: '#ff3b2e' });
    const fuse = new THREE.Mesh(this.fuseGeo, light);
    fuse.position.set(0, 0.085, 0);
    mesh.add(ball, fuse);
    mesh.position.copy(at);
    this.scene.add(mesh);
    this.bombs.push({ body, mesh, light, owner, age: 0 });
    this.onFx?.('throw', at, owner);
  }

  private updateBombs(dt: number): void {
    for (let k = this.bombs.length - 1; k >= 0; k--) {
      const b = this.bombs[k];
      b.age += dt;
      const t = b.body.translation();
      b.mesh.position.set(t.x, t.y, t.z);
      const r = b.body.rotation();
      b.mesh.children[0].quaternion.set(r.x, r.y, r.z, r.w);
      // Blink faster as the fuse runs down.
      b.light.color.set(Math.sin(b.age * (8 + b.age * 10)) > 0 ? '#ff3b2e' : '#ffd21f');
      let boom = b.age > BOMB_FUSE || t.y < -5;
      if (!boom && b.age > 0.12) {
        for (const r of this.racers) {
          if (r === b.owner && b.age < 0.8) continue;
          if (r.car.pos.distanceTo(b.mesh.position) < 0.55) boom = true;
        }
      }
      if (!boom) continue;
      const at = b.mesh.position.clone();
      this.onFx?.('explode', at, b.owner);
      this.burst(at, '#ff8a2a', BOMB_RADIUS * 0.9, 0.45, 0.6);
      this.burst(at, '#fff3b0', BOMB_RADIUS * 0.4, 0.2, 0.75);
      for (const r of this.racers) {
        const dist = r.car.pos.distanceTo(at);
        if (dist > BOMB_RADIUS) continue;
        const f = 1 - (dist / BOMB_RADIUS) * 0.5;
        _d.subVectors(r.car.pos, at).setY(0);
        if (_d.lengthSq() < 1e-4) _d.copy(r.car.fwd);
        _d.normalize();
        this.stun(r, b.owner, 'bomb', { lift: 3.2 * f, away: _d.multiplyScalar(1.8 * f), spin: (Math.random() < 0.5 ? -1 : 1) * 7 * f, keep: 0.55, time: 1.1 });
      }
      this.removeBomb(b);
      this.bombs.splice(k, 1);
    }
  }

  private removeBomb(b: Bomb<T>): void {
    this.world.removeRigidBody(b.body);
    this.scene.remove(b.mesh);
    b.light.dispose();
  }

  // --- Oil slick: a puddle behind the car; driving over it spins you out.

  private dropOil(owner: T): void {
    const car = owner.car;
    const from = car.pos.clone().addScaledVector(car.fwd, -0.45).addScaledVector(car.up, 0.25);
    this.ray.origin = { x: from.x, y: from.y, z: from.z };
    this.ray.dir = { x: -car.up.x, y: -car.up.y, z: -car.up.z };
    const hit = this.world.castRayAndGetNormal(
      this.ray, 1.5, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    if (!hit) return; // mid-air: the oil just splashes away
    const pos = from.clone().addScaledVector(car.up, -hit.timeOfImpact);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
    const mat = new THREE.MeshStandardMaterial({
      color: '#2a1a4a', emissive: '#1a0b36', roughness: 0.12, metalness: 0.25, transparent: true, opacity: 0.92,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(this.oilGeo, mat);
    mesh.position.copy(pos).addScaledVector(normal, 0.006);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.scale.set(1.25, 0.9, 1); // a splat, not a coin
    mesh.rotateZ(Math.random() * Math.PI);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.slicks.push({ pos, normal, mesh, owner, age: 0, cooldown: new Map(), hitsLeft: OIL_HITS });
    this.onFx?.('oil', pos, owner);
    if (this.slicks.length > MAX_SLICKS) {
      const old = this.slicks.shift()!;
      this.scene.remove(old.mesh);
    }
  }

  private updateSlicks(dt: number): void {
    for (let k = this.slicks.length - 1; k >= 0; k--) {
      const s = this.slicks[k];
      s.age += dt;
      (s.mesh.material as THREE.MeshStandardMaterial).opacity = 0.92 * Math.min(1, (OIL_LIFE - s.age) / 1.2);
      if (s.age > OIL_LIFE) {
        this.scene.remove(s.mesh);
        (s.mesh.material as THREE.Material).dispose();
        this.slicks.splice(k, 1);
        continue;
      }
      for (const [r, t] of s.cooldown) if (t - dt <= 0) s.cooldown.delete(r); else s.cooldown.set(r, t - dt);
      for (const r of this.racers) {
        if (s.hitsLeft <= 0 || (r === s.owner && s.age < 1.5) || s.cooldown.has(r) || r.car.groundedCount === 0) continue;
        _d.subVectors(r.car.pos, s.pos);
        const h = _d.dot(s.normal);
        if (h < -0.2 || h > 0.4) continue;
        if (_d.addScaledVector(s.normal, -h).length() > OIL_RADIUS) continue;
        s.cooldown.set(r, 1.5);
        if (--s.hitsLeft <= 0) s.age = Math.max(s.age, OIL_LIFE - 0.4); // smeared: fade out now
        this.stun(r, s.owner, 'oil', { lift: 0.4, spin: (Math.random() < 0.5 ? -1 : 1) * 9, keep: 0.75, time: 0.9 });
      }
    }
  }

  // --- Electric pulse: a ring that zaps every car close by.

  private pulse(owner: T): void {
    const car = owner.car;
    const at = car.pos.clone();
    this.onFx?.('zap', at, owner);
    const ring = this.addFx(this.ringGeo, '#3fe6ff', at.clone().addScaledVector(car.up, 0.12), 0.2, PULSE_RADIUS, 0.6, 1);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), car.up);
    (ring.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
    this.burst(at, '#3fe6ff', PULSE_RADIUS * 0.6, 0.35, 0.3);
    for (const r of this.racers) {
      if (r === owner || r.car.pos.distanceTo(at) > PULSE_RADIUS) continue;
      this.stun(r, owner, 'pulse', { lift: 1.2, spin: 0, keep: 0.5, time: 1.3 });
    }
  }

  // --- Shared bits.

  private stun(victim: T, by: T, kind: ItemHit<T>['kind'], o: { lift: number; away?: THREE.Vector3; spin: number; keep: number; time: number }): void {
    const c = victim.car;
    const v = c.body.linvel();
    c.body.setLinvel({ x: v.x * o.keep, y: v.y, z: v.z * o.keep }, true);
    const m = c.cfg.mass;
    _i.copy(c.up).multiplyScalar(o.lift * m);
    if (o.away) _i.addScaledVector(o.away, m);
    c.body.applyImpulse({ x: _i.x, y: _i.y, z: _i.z }, true);
    if (o.spin) {
      const j = o.spin * c.principalInertia.y;
      c.body.applyTorqueImpulse({ x: c.up.x * j, y: c.up.y * j, z: c.up.z * j }, true);
    }
    c.stunTime = Math.max(c.stunTime, o.time);
    this.hits.push({ victim, by, kind });
  }

  private burst(at: THREE.Vector3, color: string, radius: number, life: number, opacity: number): void {
    this.addFx(this.burstGeo, color, at, radius * 0.2, radius, life, opacity);
  }

  private addFx(geo: THREE.BufferGeometry, color: string, at: THREE.Vector3, from: number, to: number, life: number, opacity: number): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(at);
    mesh.scale.setScalar(from);
    this.scene.add(mesh);
    this.fx.push({ mesh, age: 0, life, from, to, opacity });
    return mesh;
  }

  private updateFx(dt: number): void {
    for (let k = this.fx.length - 1; k >= 0; k--) {
      const f = this.fx[k];
      f.age += dt;
      const t = Math.min(1, f.age / f.life);
      const ease = 1 - (1 - t) ** 3;
      f.mesh.scale.setScalar(f.from + (f.to - f.from) * ease);
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = f.opacity * (1 - t);
      if (t >= 1) {
        this.scene.remove(f.mesh);
        (f.mesh.material as THREE.Material).dispose();
        this.fx.splice(k, 1);
      }
    }
  }

  /** A spinning halo over every car that's currently stunned. */
  private updateStars(dt: number): void {
    for (const r of this.racers) {
      let star = this.stars.get(r);
      if (r.car.stunTime <= 0) {
        if (star) star.visible = false;
        continue;
      }
      if (!star) {
        star = new THREE.Mesh(this.starGeo, this.starMat);
        this.scene.add(star);
        this.stars.set(r, star);
      }
      star.visible = true;
      star.position.copy(r.car.pos).addScaledVector(r.car.up, 0.28);
      star.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), r.car.up);
      const spin = (star.userData.spin = (star.userData.spin ?? 0) + dt * 9);
      star.rotateX(Math.sin(spin) * 0.45);
      star.rotateY(Math.cos(spin) * 0.45);
    }
  }
}

/** A puddle with a few droplets around it (flat, in the XY plane). */
function oilSplat(): THREE.BufferGeometry {
  const parts = [new THREE.CircleGeometry(OIL_RADIUS, 28)];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.4 * Math.sin(k * 7.1);
    const r = OIL_RADIUS * (0.95 + 0.25 * ((k * 37) % 5) / 5);
    parts.push(new THREE.CircleGeometry(OIL_RADIUS * (0.14 + 0.08 * (k % 3)), 12).translate(Math.cos(a) * r, Math.sin(a) * r, 0));
  }
  return mergeGeometries(parts)!;
}

/**
 * When an AI driver fires its item. `held` is how long it's been sitting on it: everything gets
 * used eventually, even without a perfect moment.
 */
export function aiWantsToUse(kind: ItemKind, me: RaycastCar, others: RaycastCar[], track: Track, s: number, held: number): boolean {
  let ahead = 0, behind = 0, near = 0;
  for (const o of others) {
    if (o === me) continue;
    _d.subVectors(o.pos, me.pos);
    const along = _d.dot(me.fwd);
    const side = Math.abs(_d.dot(me.left));
    const dist = _d.length();
    if (along > 1.5 && along < 12 && side < 0.25 * along + 0.3) ahead++;
    if (along < -1 && along > -8 && side < 1.2) behind++;
    if (dist < PULSE_RADIUS * 0.85) near++;
  }
  switch (kind) {
    case 'boost': {
      if (held > 6) return true;
      // A straight-ish, flat run ahead (not the loop or the stand deck).
      for (let d = 0; d < 20; d += 2) {
        const a = track.sampleAt(s + d), b = track.sampleAt(s + d + 2);
        if (a.loop || a.width < 2.4 || Math.abs(a.tangent.y) > 0.1) return false;
        if (a.tangent.dot(b.tangent) < Math.cos(0.12)) return false;
      }
      return true;
    }
    case 'bomb':
      return ahead > 0 || held > 12;
    case 'oil':
      return behind > 0 || held > 12;
    case 'pulse':
      return near > 0 || held > 14;
  }
}
