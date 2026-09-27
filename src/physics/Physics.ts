import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

/** Fixed simulation step. 120 Hz keeps a 0.5 m car at ~20 m/s from tunnelling through thin geometry. */
export const FIXED_DT = 1 / 120;
export const GRAVITY = 9.81;

let ready: Promise<void> | null = null;
/** Load Rapier's wasm once. */
export function initPhysics(): Promise<void> {
  return (ready ??= RAPIER.init());
}

export function createWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.timestep = FIXED_DT;
  return world;
}

export interface StaticOpts {
  friction?: number;
  restitution?: number;
}

const fixed = (world: RAPIER.World, pos: THREE.Vector3, quat?: THREE.Quaternion) =>
  world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation(quat ? { x: quat.x, y: quat.y, z: quat.z, w: quat.w } : { x: 0, y: 0, z: 0, w: 1 }),
  );

/** Static box collider (half-extents), optionally rotated. */
export function addStaticBox(
  world: RAPIER.World,
  center: THREE.Vector3,
  half: THREE.Vector3,
  quat?: THREE.Quaternion,
  opts: StaticOpts = {},
): RAPIER.Collider {
  const body = fixed(world, center, quat);
  const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
    .setFriction(opts.friction ?? 0.6)
    .setRestitution(opts.restitution ?? 0.1);
  return world.createCollider(desc, body);
}

/** Static convex hull from world-space (or body-local, with `origin`) points. */
export function addStaticHull(
  world: RAPIER.World,
  points: THREE.Vector3[],
  origin = new THREE.Vector3(),
  quat?: THREE.Quaternion,
  opts: StaticOpts = {},
): RAPIER.Collider {
  const body = fixed(world, origin, quat);
  const flat = new Float32Array(points.flatMap((p) => [p.x, p.y, p.z]));
  const desc = RAPIER.ColliderDesc.convexHull(flat);
  if (!desc) throw new Error('convex hull failed');
  desc.setFriction(opts.friction ?? 0.6).setRestitution(opts.restitution ?? 0.1);
  return world.createCollider(desc, body);
}

/** Static triangle mesh taken straight from a three.js geometry (in the mesh's world transform). */
export function addStaticTrimesh(world: RAPIER.World, mesh: THREE.Mesh, opts: StaticOpts = {}): RAPIER.Collider {
  mesh.updateWorldMatrix(true, false);
  const geom = mesh.geometry;
  const pos = geom.attributes.position;
  const v = new THREE.Vector3();
  const verts = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    verts.set([v.x, v.y, v.z], i * 3);
  }
  const indices = geom.index
    ? new Uint32Array(geom.index.array)
    : Uint32Array.from({ length: pos.count }, (_, i) => i);
  const body = fixed(world, new THREE.Vector3());
  const desc = RAPIER.ColliderDesc.trimesh(verts, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES_TWO_SIDED)
    .setFriction(opts.friction ?? 0.6)
    .setRestitution(opts.restitution ?? 0.1);
  return world.createCollider(desc, body);
}
