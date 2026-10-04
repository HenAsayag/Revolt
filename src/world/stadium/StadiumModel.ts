import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addStaticTrimesh } from '../../physics/Physics';

/**
 * The Bloomfield 2019 model, converted by tools/export_blend.py:
 *  - bloomfield.glb            visuals, one mesh per (stand region, material)
 *  - bloomfield_collision.glb  concrete, aisles, rails → static trimeshes
 *  - seats.bin                 28k seat transforms → InstancedMesh (far cheaper than the 1.8M-tri shells)
 */
const BASE = `${import.meta.env.BASE_URL}models/`;

export interface StadiumAssets {
  visual: THREE.Group;
  collision: THREE.Group;
  seats: ArrayBuffer;
}

export async function loadStadiumAssets(onProgress?: (fraction: number) => void): Promise<StadiumAssets> {
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const parts = { visual: 0, collision: 0, seats: 0 };
  const report = () => onProgress?.((parts.visual * 0.6 + parts.collision * 0.25 + parts.seats * 0.15));
  const prog = (key: keyof typeof parts) => (e: ProgressEvent) => {
    if (e.lengthComputable) parts[key] = e.loaded / e.total;
    report();
  };
  const [visual, collision, seats] = await Promise.all([
    loader.loadAsync(`${BASE}bloomfield.glb`, prog('visual')),
    loader.loadAsync(`${BASE}bloomfield_collision.glb`, prog('collision')),
    fetch(`${BASE}seats.bin`).then((r) => {
      if (!r.ok) throw new Error(`seats.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  parts.seats = 1;
  report();
  draco.dispose();
  return { visual: visual.scene, collision: collision.scene, seats };
}

/** Seat palette from the model (linear RGB, as authored in Blender). */
const SEAT_COLOURS = [
  [0.1, 0.05, 0.24], // muted violet
  [0.79, 0.8, 0.77], // warm light gray
  [0.54, 0.57, 0.59], // medium gray
  [0.27, 0.28, 0.32], // graphite
].map(([r, g, b]) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace));

/** Moulded seat facing local -Z, origin at the centre of the seat pan (dimensions from the model). */
function seatGeometry(): THREE.BufferGeometry {
  const paint = (g: THREE.BufferGeometry, v: number) => {
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(v), 3));
    return g;
  };
  // 28k of these are drawn, so every triangle counts: boxes lose their (never seen) bottoms and
  // the pedestal is a single front-facing quad. 22 triangles per seat.
  const noBottom = (g: THREE.BoxGeometry) => {
    const idx = Array.from(g.index!.array);
    idx.splice(18, 6); // face order +x, -x, +y, -y, +z, -z; drop -y
    g.setIndex(idx);
    return g;
  };
  const pan = paint(noBottom(new THREE.BoxGeometry(0.43, 0.055, 0.44)), 1);
  const back = paint(noBottom(new THREE.BoxGeometry(0.42, 0.46, 0.11)).rotateX(-0.1).translate(0, 0.26, 0.26), 1);
  const post = paint(new THREE.PlaneGeometry(0.07, 0.42).rotateY(Math.PI).translate(0, -0.24, 0.06), 0.35);
  return mergeGeometries([pan, back, post])!;
}

function buildSeats(buffer: ArrayBuffer): THREE.Group {
  const count = new Uint32Array(buffer, 0, 1)[0];
  const xf = new Float32Array(buffer, 4, count * 4);
  const col = new Uint8Array(buffer, 4 + count * 16, count);
  // Bucket seats into angular sectors so each InstancedMesh can be frustum-culled.
  const SECTORS = 12;
  const buckets: number[][] = Array.from({ length: SECTORS }, () => []);
  for (let i = 0; i < count; i++) {
    const a = Math.atan2(xf[i * 4 + 2], xf[i * 4]);
    buckets[Math.min(SECTORS - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * SECTORS))].push(i);
  }
  const geo = seatGeometry();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
  const group = new THREE.Group();
  group.name = 'seats';
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const Y = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  for (const ids of buckets) {
    if (!ids.length) continue;
    const mesh = new THREE.InstancedMesh(geo, mat, ids.length);
    ids.forEach((id, k) => {
      p.set(xf[id * 4], xf[id * 4 + 1], xf[id * 4 + 2]);
      q.setFromAxisAngle(Y, xf[id * 4 + 3]);
      mesh.setMatrixAt(k, m.compose(p, q, one));
      mesh.setColorAt(k, c.copy(SEAT_COLOURS[col[id]] ?? SEAT_COLOURS[0]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

export interface InstalledStadium {
  root: THREE.Group;
  screens: THREE.Mesh[];
  seatCount: number;
  seats: THREE.Group;
}

/** Hide every seat whose position falls inside one of the [x0, z0, x1, z1] rectangles (under track pieces). */
export function clearSeats(seats: THREE.Group, rects: [number, number, number, number][]): number {
  if (!rects.length) return 0;
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  let cleared = 0;
  for (const child of seats.children) {
    const mesh = child as THREE.InstancedMesh;
    let touched = false;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      if (rects.some(([x0, z0, x1, z1]) => p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1)) {
        mesh.setMatrixAt(i, zero);
        touched = true;
        cleared++;
      }
    }
    if (touched) mesh.instanceMatrix.needsUpdate = true;
  }
  return cleared;
}

/** Tune the model's materials for the game's lighting and add it (plus colliders and seats) to the scene. */
export function installStadiumModel(
  scene: THREE.Object3D,
  world: RAPIER.World,
  assets: StadiumAssets,
  screenTexture: THREE.Texture,
): InstalledStadium {
  const root = new THREE.Group();
  root.name = 'bloomfield-model';
  root.add(assets.visual);
  scene.add(root);

  const screens: THREE.Mesh[] = [];
  const lampMat = new THREE.MeshBasicMaterial({ color: '#fffbe8', toneMapped: false });
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false });
  assets.visual.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const name = mat.name ?? '';
    const region = mesh.name.split('__')[0] || mesh.parent?.name.split('__')[0] || '';
    mesh.receiveShadow = true;
    // Only the stand concrete, rails and goals cast shadows: they're near the car. The high steel and the
    // huge "Misc" meshes would enter the small car-centred shadow frustum and leave a cut-off edge.
    mesh.castShadow = region !== 'Misc' && /concrete|Railings/.test(name);
    if (name === 'Floodlight lamp') mesh.material = lampMat;
    else if (name === 'Screen | inactive black') {
      mesh.material = screenMat;
      screens.push(mesh);
    } else if (/structural steel/.test(name)) {
      mat.color.setRGB(0.9, 0.93, 0.93, THREE.LinearSRGBColorSpace);
      mat.roughness = 0.5;
      mat.metalness = 0;
    } else if (name === 'Tinted glazing') {
      mat.metalness = 0.6;
      mat.roughness = 0.12;
    } else if (/Goal/.test(name)) {
      mesh.castShadow = true;
    }
  });

  assets.collision.updateMatrixWorld(true);
  assets.collision.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) addStaticTrimesh(world, mesh, { friction: 0.8 });
  });

  const seats = buildSeats(assets.seats);
  root.add(seats);
  const seatCount = seats.children.reduce((n, m) => n + (m as THREE.InstancedMesh).count, 0);
  return { root, screens, seatCount, seats };
}
