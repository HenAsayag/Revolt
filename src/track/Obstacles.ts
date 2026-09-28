import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TrackSample } from './Track';

/** Red/white hazard stripes (for the sweeper arms). */
function stripeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 16;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#f4f4f0' : '#d8262a';
    g.beginPath();
    g.moveTo(i * 16, 0);
    g.lineTo(i * 16 + 16, 0);
    g.lineTo(i * 16 + 8, 16);
    g.lineTo(i * 16 - 8, 16);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Splotchy mud: brown with darker puddles, soft transparent edges. */
function mudTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const x = 10 + rnd() * 108, y = rnd() * 256, r = 8 + rnd() * 26;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = rnd() < 0.35;
    grd.addColorStop(0, dark ? 'rgba(52,34,18,0.95)' : 'rgba(92,62,32,0.9)');
    grd.addColorStop(1, 'rgba(92,62,32,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * A striped arm spinning over the track on a post in the middle of it: time your run past it or
 * get swatted sideways. The arm is a kinematic body, so it shoves cars (and props) it hits.
 */
export class Sweeper {
  readonly body: RAPIER.RigidBody;
  readonly arm: THREE.Mesh;
  private angle: number;
  private readonly q = new THREE.Quaternion();
  private readonly axis: THREE.Vector3;

  constructor(root: THREE.Object3D, world: RAPIER.World, smp: TrackSample, private readonly speed: number, phase = 0) {
    this.axis = smp.up.clone();
    this.angle = phase;
    const halfLen = smp.width / 2 - 0.12;
    const base = smp.pos;
    // Post (fixed) and hub.
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.1, 0.42, 12).translate(0, 0.21, 0),
      new THREE.MeshStandardMaterial({ color: '#2b2e33', metalness: 0.5, roughness: 0.4 }),
    );
    post.position.copy(base);
    post.castShadow = true;
    root.add(post);
    const postBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(base.x, base.y + 0.21, base.z));
    world.createCollider(RAPIER.ColliderDesc.cylinder(0.21, 0.1), postBody);
    // Arm.
    const tex = stripeTexture();
    tex.repeat.set((halfLen * 2) / 0.5, 1);
    this.arm = new THREE.Mesh(
      mergeGeometries([
        new THREE.BoxGeometry(halfLen * 2, 0.1, 0.08),
        new THREE.CylinderGeometry(0.1, 0.1, 0.14, 14).translate(0, 0.02, 0),
      ].map((g) => g.toNonIndexed()))!,
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: '#330000', emissiveIntensity: 0.25 }),
    );
    this.arm.castShadow = true;
    const at = base.clone().addScaledVector(this.axis, 0.2);
    this.arm.position.copy(at);
    root.add(this.arm);
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y, at.z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(halfLen, 0.06, 0.05).setFriction(0.1).setRestitution(0.3), this.body);
    this.step(0);
  }

  /** Advance one physics step. */
  step(dt: number): void {
    this.angle += this.speed * dt;
    this.q.setFromAxisAngle(this.axis, this.angle);
    this.body.setNextKinematicRotation({ x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w });
  }

  /** Match the visual to the physics after a step. */
  sync(): void {
    const r = this.body.rotation();
    this.arm.quaternion.set(r.x, r.y, r.z, r.w);
  }
}

/** A brown slick across the track (lowers grip; the game applies it per car). */
export function buildMud(root: THREE.Object3D, samples: TrackSample[]): void {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let along = 0;
  samples.forEach((smp, i) => {
    if (i) along += smp.pos.distanceTo(samples[i - 1].pos);
    const w = smp.width * 0.48;
    for (const side of [-1, 1]) {
      const p = smp.pos.clone().addScaledVector(smp.right, side * w).addScaledVector(smp.up, 0.012);
      pos.push(p.x, p.y, p.z);
      uv.push(side < 0 ? 0 : 1, along / 4);
    }
    if (i) {
      const a = (i - 1) * 2, b = i * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: mudTexture(), transparent: true, roughness: 0.35, metalness: 0.05, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide,
  }));
  mesh.receiveShadow = true;
  root.add(mesh);
}

/** Yellow-and-black bollards (fixed posts); returns their positions for the AI to steer around. */
export function buildBollards(root: THREE.Object3D, world: RAPIER.World, spots: TrackSample[], lateral: number[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const yellow: THREE.BufferGeometry[] = [], black: THREE.BufferGeometry[] = [];
  const R = 0.11, H = 0.6;
  spots.forEach((smp, i) => {
    const p = smp.pos.clone().addScaledVector(smp.right, lateral[i]);
    out.push(p);
    for (let k = 0; k < 4; k++) {
      const seg = new THREE.CylinderGeometry(R, R, H / 4, 14).translate(p.x, p.y + (k + 0.5) * (H / 4), p.z);
      (k % 2 ? black : yellow).push(seg);
    }
    yellow.push(new THREE.SphereGeometry(R, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(p.x, p.y + H, p.z));
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y + H / 2, p.z));
    world.createCollider(RAPIER.ColliderDesc.cylinder(H / 2, R).setFriction(0.02).setRestitution(0.2), body);
  });
  if (spots.length) {
    const y = new THREE.Mesh(mergeGeometries(yellow)!, new THREE.MeshStandardMaterial({ color: '#ffd21f', roughness: 0.5 }));
    const b = new THREE.Mesh(mergeGeometries(black)!, new THREE.MeshStandardMaterial({ color: '#1c1c1c', roughness: 0.6 }));
    y.castShadow = b.castShadow = true;
    root.add(y, b);
  }
  return out;
}
