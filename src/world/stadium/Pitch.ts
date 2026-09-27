import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addStaticBox } from '../../physics/Physics';
import { grassDetailTexture } from '../../render/textures';
import { GRASS, PITCH } from './layout';

const LINE_W = 0.12;
const LINE_Y = 0.012;

/** Grass with a chequered mowing pattern (vertex colours × tiled blade detail). */
function buildGrass(): THREE.Mesh {
  const stripeW = PITCH.length / 20;
  const bandW = PITCH.width / 8;
  const xs: number[] = [-GRASS.halfX];
  for (let x = -PITCH.length / 2; x <= PITCH.length / 2 + 1e-6; x += stripeW) xs.push(x);
  xs.push(GRASS.halfX);
  const zs: number[] = [-GRASS.halfZ];
  for (let z = -PITCH.width / 2; z <= PITCH.width / 2 + 1e-6; z += bandW) zs.push(z);
  zs.push(GRASS.halfZ);

  const light = new THREE.Color('#62b344');
  const dark = new THREE.Color('#4c9a35');
  const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < zs.length - 1; j++) {
      const x0 = xs[i], x1 = xs[i + 1], z0 = zs[j], z1 = zs[j + 1];
      const si = Math.floor(((x0 + x1) / 2 + PITCH.length / 2) / stripeW);
      const sj = Math.floor(((z0 + z1) / 2 + PITCH.width / 2) / bandW);
      c.copy((si & 1) === 0 ? light : dark).multiplyScalar((sj & 1) === 0 ? 1.04 : 0.96);
      const base = pos.length / 3;
      for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
        pos.push(x, 0, z);
        col.push(c.r, c.g, c.b);
        uv.push(x / 3, z / 3);
      }
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: grassDetailTexture(), vertexColors: true, roughness: 0.95 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** All pitch markings as one merged, slightly raised mesh (crisp at any distance). */
function buildLines(): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const seg = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const g = new THREE.PlaneGeometry(len + LINE_W, LINE_W).rotateX(-Math.PI / 2);
    g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
    g.translate((x0 + x1) / 2, LINE_Y, (z0 + z1) / 2);
    parts.push(g);
  };
  const rect = (x0: number, z0: number, x1: number, z1: number) => {
    seg(x0, z0, x1, z0);
    seg(x1, z0, x1, z1);
    seg(x1, z1, x0, z1);
    seg(x0, z1, x0, z0);
  };
  const arc = (cx: number, cz: number, r: number, a0: number, a1: number) => {
    const g = new THREE.RingGeometry(r - LINE_W / 2, r + LINE_W / 2, 64, 1, a0, a1 - a0).rotateX(-Math.PI / 2);
    g.translate(cx, LINE_Y, cz);
    parts.push(g);
  };
  const spot = (x: number, z: number, r = 0.12) => {
    const g = new THREE.CircleGeometry(r, 16).rotateX(-Math.PI / 2);
    g.translate(x, LINE_Y, z);
    parts.push(g);
  };

  const hl = PITCH.length / 2, hw = PITCH.width / 2;
  rect(-hl, -hw, hl, hw);
  seg(0, -hw, 0, hw);
  arc(0, 0, 9.15, 0, Math.PI * 2);
  spot(0, 0, 0.15);
  for (const s of [-1, 1]) {
    const gx = s * hl;
    rect(gx, -20.16, gx - s * 16.5, 20.16); // penalty area
    rect(gx, -9.16, gx - s * 5.5, 9.16); // goal area
    const px = gx - s * 11;
    spot(px, 0);
    // Penalty arc: the part of the 9.15 m circle outside the box.
    const half = Math.acos(5.5 / 9.15);
    // RingGeometry angles are measured in its XY plane; after rotateX(-90°) angle a maps to (cos a, -sin a) in XZ.
    const toward = s > 0 ? Math.PI : 0; // arc bulges toward the halfway line
    arc(px, 0, 9.15, toward - half, toward + half);
    for (const zs of [-1, 1]) {
      // Corner arcs: the quarter pointing into the pitch (angle a → XZ direction (cos a, -sin a)).
      const a0 = s > 0 ? (zs > 0 ? Math.PI / 2 : Math.PI) : zs > 0 ? 0 : Math.PI * 1.5;
      arc(gx, zs * hw, 1, a0, a0 + Math.PI / 2);
    }
  }
  const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  const mat = new THREE.MeshStandardMaterial({ color: '#f4f6f0', roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Goal colliders only — the model provides the frames and nets. Posts and crossbar stop cars;
 * thin walls where the net is keep footballs in the goal.
 */
function addGoalColliders(side: 1 | -1, world: RAPIER.World): void {
  const x = side * (PITCH.length / 2);
  const r = 0.06, hw = 3.66, h = 2.44, depth = 2.1;
  for (const zs of [-1, 1]) addStaticBox(world, new THREE.Vector3(x, h / 2, zs * hw), new THREE.Vector3(r, h / 2, r));
  addStaticBox(world, new THREE.Vector3(x, h, 0), new THREE.Vector3(r, r, hw));
  const net = { friction: 0.9, restitution: 0.05 };
  addStaticBox(world, new THREE.Vector3(x + side * depth, h / 2, 0), new THREE.Vector3(0.03, h / 2, hw), undefined, net);
  for (const zs of [-1, 1]) {
    addStaticBox(world, new THREE.Vector3(x + side * depth / 2, h / 2, zs * (hw + 0.05)), new THREE.Vector3(depth / 2, h / 2, 0.03), undefined, net);
  }
  addStaticBox(world, new THREE.Vector3(x + side * depth / 2, h + 0.03, 0), new THREE.Vector3(depth / 2, 0.03, hw), undefined, net);
}

export function buildPitch(scene: THREE.Object3D, world: RAPIER.World): void {
  scene.add(buildGrass(), buildLines());
  addGoalColliders(1, world);
  addGoalColliders(-1, world);
}
