import type RAPIER from '@dimforge/rapier3d-compat';
import RAPIERNS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addStaticBox, addStaticHull } from '../physics/Physics';
import { GLIDE_GROUPS, PAD_GROUPS } from '../physics/groups';
import { boostPadTexture, plywoodTexture } from '../render/textures';
import type { TrackSample } from './Track';

/** Finds the surface under a point (the game installs a raycast against the stadium). */
let groundProbe: ((x: number, y: number, z: number) => number) | null = null;
export function setGroundProbe(fn: (x: number, y: number, z: number) => number): void {
  groundProbe = fn;
}

/** Height of whatever a support post at (x, z) hanging from height y would stand on. */
export function supportHeight(x: number, z: number, y = 30): number {
  if (groundProbe) return groundProbe(x, y, z);
  if (z >= 40.13 && z < 53.75 && Math.abs(x) < 50) return 1.15 + 0.43 * Math.floor((z - 40.13) / 0.75);
  return 0;
}

export interface RibbonOptions {
  thickness: number;
  curbHeight: number;
  curbWidth: number;
}

/**
 * Extrude a U-channel cross-section (deck + two curbs) along track samples, using each
 * sample's frame — so it works for ramps, banked decks and the vertical loop alike.
 * The deck's top surface sits exactly on the spline.
 */
export function ribbonGeometry(samples: TrackSample[], o: RibbonOptions): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  // Curbs taper in over the first/last 1.5 m so an off-centre car can't hit their square ends.
  const total = samples.reduce((d, s, i) => (i ? d + s.pos.distanceTo(samples[i - 1].pos) : 0), 0);
  const profile = (w: number, dist: number): [number, number][] => {
    const h = o.curbHeight * Math.min(1, dist / 1.5, (total - dist) / 1.5) + 0.001;
    return [
      [-w / 2 - o.curbWidth, h], [-w / 2, h], [-w / 2, 0], [w / 2, 0],
      [w / 2, h], [w / 2 + o.curbWidth, h], [w / 2 + o.curbWidth, -o.thickness],
      [-w / 2 - o.curbWidth, -o.thickness],
    ];
  };
  const at = (smp: TrackSample, [lat, up]: [number, number]) =>
    smp.pos.clone().addScaledVector(smp.right, lat).addScaledVector(smp.up, up);
  let along = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    const step = a.pos.distanceTo(b.pos);
    const pa = profile(a.width, along), pb = profile(b.width, along + step);
    let around = 0;
    for (let k = 0; k < pa.length; k++) {
      const k2 = (k + 1) % pa.length;
      const seg = Math.hypot(pa[k2][0] - pa[k][0], pa[k2][1] - pa[k][1]);
      const a0 = at(a, pa[k]), a1 = at(a, pa[k2]), b0 = at(b, pb[k]), b1 = at(b, pb[k2]);
      // Two triangles, wound so normals point out of the solid (the profile runs clockwise).
      pos.push(...a0.toArray(), ...b1.toArray(), ...b0.toArray(), ...a0.toArray(), ...a1.toArray(), ...b1.toArray());
      const u0 = around / 1.2, u1 = (around + seg) / 1.2, v0 = along / 1.2, v1 = (along + step) / 1.2;
      uv.push(u0, v0, u1, v1, u0, v1, u0, v0, u1, v0, u1, v1);
      around += seg;
    }
    along += step;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Physics for a ribbon: the running surface as a single-sided trimesh (clean topology, so
 * FIX_INTERNAL_EDGES works) and each curb as a chain of small convex hulls. A full thin-shell
 * trimesh (top + bottom + curbs) produced bogus "wall" contact normals.
 */
export function addRibbonColliders(world: RAPIER.World, samples: TrackSample[], curbHeight: number, curbWidth: number): void {
  const verts: number[] = [];
  const idx: number[] = [];
  samples.forEach((smp, i) => {
    for (const side of [-1, 1]) {
      const p = smp.pos.clone().addScaledVector(smp.right, (side * smp.width) / 2);
      verts.push(p.x, p.y, p.z);
    }
    if (i > 0) {
      const a = (i - 1) * 2, b = i * 2;
      // Up-facing triangles (left, right) × (prev, cur).
      idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
  });
  const body = world.createRigidBody(RAPIERNS.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIERNS.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx), RAPIERNS.TriMeshFlags.FIX_INTERNAL_EDGES)
      .setFriction(0.8).setRestitution(0.05),
    body,
  );
  const total = samples.reduce((d, s, i) => (i ? d + s.pos.distanceTo(samples[i - 1].pos) : 0), 0);
  let along = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    const step = a.pos.distanceTo(b.pos);
    const h = curbHeight * Math.min(1, along / 1.5, (total - along) / 1.5);
    along += step;
    if (h < 0.05) continue;
    for (const side of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      for (const smp of [a, b]) {
        for (const lat of [smp.width / 2, smp.width / 2 + curbWidth]) {
          for (const up of [-0.05, h]) pts.push(smp.pos.clone().addScaledVector(smp.right, side * lat).addScaledVector(smp.up, up));
        }
      }
      // Slippery, like the water barriers: a car that touches the curb slides along it instead of stopping dead.
      addStaticHull(world, pts, new THREE.Vector3(), undefined, { friction: 0.02, restitution: 0.05 });
    }
  }
}

/** Square timber from a to b. */
export function beamGeometry(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(t, len, t);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return g.translate(mid.x, mid.y, mid.z);
}

function plywood(color: THREE.ColorRepresentation = '#ffffff'): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: plywoodTexture(), color, roughness: 0.78, side: THREE.DoubleSide });
}

/** Elevated plywood deck with curbs and posts down to the stands / ground. */
export function buildDeck(root: THREE.Object3D, world: RAPIER.World, samples: TrackSample[]): void {
  // Side walls taller than the car's centre of mass, so a slide into them deflects instead of tripping over.
  const geo = ribbonGeometry(samples, { thickness: 0.1, curbHeight: 0.45, curbWidth: 0.06 });
  const mesh = new THREE.Mesh(geo, plywood());
  mesh.castShadow = mesh.receiveShadow = true;
  root.add(mesh);
  addRibbonColliders(world, samples, 0.45, 0.06);
  const beams: THREE.BufferGeometry[] = [];
  for (let i = 0; i < samples.length; i += 5) {
    const smp = samples[i];
    for (const side of [-1, 1]) {
      const top = smp.pos.clone().addScaledVector(smp.right, side * (smp.width / 2 + 0.03)).addScaledVector(smp.up, -0.1);
      const foot = supportHeight(top.x, top.z, top.y - 0.05);
      if (top.y - foot < 0.25) continue;
      beams.push(beamGeometry(top, new THREE.Vector3(top.x, foot, top.z), 0.08));
    }
  }
  if (beams.length) {
    const posts = new THREE.Mesh(mergeGeometries(beams)!, new THREE.MeshStandardMaterial({ color: '#8a6a44', roughness: 0.85 }));
    posts.castShadow = true;
    root.add(posts);
  }
}

/**
 * The giant orange loop: a painted-plywood U-channel following the loop samples, held up by
 * wooden A-frames either side.
 */
export function buildLoop(root: THREE.Object3D, world: RAPIER.World, samples: TrackSample[]): void {
  const geo = ribbonGeometry(samples, { thickness: 0.12, curbHeight: 0.42, curbWidth: 0.07 });
  const mesh = new THREE.Mesh(geo, plywood('#ff8a2a'));
  mesh.castShadow = mesh.receiveShadow = true;
  root.add(mesh);
  addRibbonColliders(world, samples, 0.42, 0.07);

  // A-frames: at the two vertical sections (mid height), both outer sides.
  const vertical = [...samples].sort((a, b) => Math.abs(b.tangent.y) - Math.abs(a.tangent.y));
  const anchors: TrackSample[] = [vertical[0]];
  const second = vertical.find((s) => s.tangent.y * vertical[0].tangent.y < 0);
  if (second) anchors.push(second);
  const beams: THREE.BufferGeometry[] = [];
  for (const smp of anchors) {
    // Travel direction on the ground for the loop (its plane), and the outward side.
    const flat = new THREE.Vector3(samples[0].tangent.x, 0, samples[0].tangent.z).normalize();
    const side = new THREE.Vector3(-flat.z, 0, flat.x);
    for (const s of [-1, 1]) {
      const lat = s * (smp.width / 2 + 0.1);
      const top = smp.pos.clone().addScaledVector(smp.right, lat);
      // Push anchors to the outside of the whole loop footprint.
      const out = side.clone().multiplyScalar(Math.sign(side.dot(smp.right) * s) || s);
      const feet = [-1.9, 1.9].map((d) => top.clone().addScaledVector(flat, d).addScaledVector(out, 0.5).setY(0));
      for (const f of feet) beams.push(beamGeometry(top, f, 0.14));
      beams.push(beamGeometry(feet[0].clone().lerp(top, 0.45), feet[1].clone().lerp(top, 0.45), 0.1));
    }
  }
  const frames = new THREE.Mesh(mergeGeometries(beams)!, new THREE.MeshStandardMaterial({ color: '#9b7447', roughness: 0.8 }));
  frames.castShadow = true;
  root.add(frames);
}

/** Solid plywood wedge from a low end to a high end, sitting on `base`. */
export function buildRamp(root: THREE.Object3D, world: RAPIER.World, from: THREE.Vector3, to: THREE.Vector3, width: number, base: number): void {
  const dir = to.clone().sub(from).setY(0).normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
  const tl = [from.clone().add(side), from.clone().sub(side), to.clone().sub(side), to.clone().add(side)]; // top quad
  const bl = tl.map((p) => p.clone().setY(base));
  const quads = [
    [tl[0], tl[1], tl[2], tl[3]], [bl[3], bl[2], bl[1], bl[0]], [tl[3], tl[2], bl[2], bl[3]],
    [tl[1], tl[0], bl[0], bl[1]], [tl[0], tl[3], bl[3], bl[0]], [tl[2], tl[1], bl[1], bl[2]],
  ];
  const pos: number[] = [];
  const uv: number[] = [];
  for (const [a, b, c, d] of quads) {
    pos.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray());
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, plywood());
  mesh.castShadow = mesh.receiveShadow = true;
  root.add(mesh);
  addStaticHull(world, [...tl, ...bl], new THREE.Vector3(), undefined, { friction: 0.8 });
}

/** Invisible chassis-only slab between two points (top surface through them), 0.1 m thick. */
export function buildGlide(world: RAPIER.World, from: THREE.Vector3, to: THREE.Vector3, width: number): void {
  const dir = to.clone().sub(from).setY(0).normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
  const top = [from.clone().add(side), from.clone().sub(side), to.clone().sub(side), to.clone().add(side)];
  const pts = [...top, ...top.map((p) => p.clone().setY(p.y - 0.1))];
  const body = world.createRigidBody(RAPIERNS.RigidBodyDesc.fixed());
  const desc = RAPIERNS.ColliderDesc.convexHull(new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z])));
  if (desc) world.createCollider(desc.setFriction(0.25).setRestitution(0).setCollisionGroups(GLIDE_GROUPS), body);
}

/** Invisible walls either side of the centre line along `samples` (collider only). */
export function buildWalls(world: RAPIER.World, samples: TrackSample[], offset: number, height: number): void {
  for (let i = 0; i < samples.length - 1; i += 2) {
    const a = samples[i], b = samples[Math.min(samples.length - 1, i + 2)];
    const mid = a.pos.clone().add(b.pos).multiplyScalar(0.5);
    const len = a.pos.distanceTo(b.pos) + 0.1;
    const fwd = b.pos.clone().sub(a.pos).setY(0).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd);
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x); // fwd × up
    for (const s of [-1, 1]) {
      const c = mid.clone().addScaledVector(right, s * offset);
      c.y += height / 2 - 0.35;
      addStaticBox(world, c, new THREE.Vector3(0.03, height / 2, len / 2), q, { friction: 0.1, restitution: 0.2 });
    }
  }
}

export interface BoostPads {
  /** Collider handle → pad index. */
  byCollider: Map<number, number>;
  meshes: THREE.Mesh[];
}

/** Chevron pads on the track surface with sensor volumes that trigger a boost. */
export function buildBoostPads(root: THREE.Object3D, world: RAPIER.World, spots: TrackSample[]): BoostPads {
  const tex = boostPadTexture();
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.9, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -3 });
  const byCollider = new Map<number, number>();
  const meshes: THREE.Mesh[] = [];
  spots.forEach((smp, i) => {
    const w = Math.min(1.4, smp.width - 0.3), l = 1.9;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), mat);
    mesh.position.copy(smp.pos).addScaledVector(smp.up, 0.008);
    // Chevrons point to the texture's +v, which the rotated plane maps to local -Z: aim -Z along travel.
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(smp.right, smp.up, smp.tangent.clone().negate()));
    mesh.receiveShadow = true;
    root.add(mesh);
    meshes.push(mesh);
    const body = world.createRigidBody(
      RAPIERNS.RigidBodyDesc.fixed().setTranslation(mesh.position.x, mesh.position.y + 0.2, mesh.position.z)
        .setRotation({ x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w }),
    );
    const col = world.createCollider(
      RAPIERNS.ColliderDesc.cuboid(w / 2, 0.25, l / 2).setSensor(true).setCollisionGroups(PAD_GROUPS)
        .setActiveEvents(RAPIERNS.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    byCollider.set(col.handle, i);
  });
  return { byCollider, meshes };
}
