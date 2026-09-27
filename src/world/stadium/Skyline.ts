import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facadeTexture, mulberry32 } from '../../render/textures';

/** Facade texture covers 8 bays × 16 floors; these are the metres per repeat. */
const BAY_W = 26;
const FLOOR_H = 58;

type Style = 'glass' | 'stone' | 'dark';

/** Street level around the stadium: the model's plaza sits at about -0.72 m. */
const CITY_Y = -0.75;

/** Scale a prism's side UVs to metres so windows keep a constant size; caps get a flat patch. */
function scaleUVs(geo: THREE.BufferGeometry, perimeterOrWidths: (face: number) => number, height: number): THREE.BufferGeometry {
  const uv = geo.attributes.uv;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(nrm.getY(i)) > 0.9) {
      uv.setXY(i, 0.02, 0.02); // roofs: sample a solid corner of the texture
      continue;
    }
    uv.setXY(i, uv.getX(i) * (perimeterOrWidths(i) / BAY_W), uv.getY(i) * (height / FLOOR_H));
  }
  return geo;
}

function boxTower(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  // Box vertex order: 4 verts each for +x, -x, +y, -y, +z, -z.
  scaleUVs(g, (i) => (i < 8 ? d : w), h);
  return g.translate(0, h / 2, 0);
}

function prismTower(r: number, h: number, sides: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, sides, 1);
  const perim = 2 * Math.PI * r * (sides <= 4 ? 0.8 : 1);
  scaleUVs(g, () => perim, h);
  return g.translate(0, h / 2, 0);
}

interface TowerSpec {
  x: number;
  z: number;
  h: number;
  kind: 'box' | 'round' | 'tri';
  w: number;
  d?: number;
  style: Style;
  yaw?: number;
}

/**
 * A Tel Aviv–style cluster of towers behind the east end (a round, a triangular and a square
 * tower side by side, plus glass slabs), and a low-rise white city all around the stadium.
 */
export function buildSkyline(scene: THREE.Object3D): void {
  const rnd = mulberry32(2024);
  const towers: TowerSpec[] = [
    // The recognisable trio.
    { x: 430, z: 150, h: 187, kind: 'round', w: 24, style: 'glass' },
    { x: 470, z: 105, h: 169, kind: 'tri', w: 28, style: 'glass', yaw: 0.4 },
    { x: 505, z: 60, h: 154, kind: 'box', w: 38, style: 'glass', yaw: 0.2 },
    // Tall slabs and blocks.
    { x: 380, z: -40, h: 238, kind: 'box', w: 30, d: 36, style: 'dark' },
    { x: 330, z: 40, h: 150, kind: 'box', w: 26, d: 40, style: 'glass', yaw: -0.3 },
    { x: 560, z: -110, h: 210, kind: 'round', w: 26, style: 'glass' },
    { x: 300, z: 210, h: 120, kind: 'box', w: 30, d: 22, style: 'stone' },
    { x: 610, z: 190, h: 165, kind: 'box', w: 28, d: 28, style: 'dark', yaw: 0.6 },
  ];
  // Push the named cluster out ~1 km so it reads as a distant skyline over the east stand.
  for (const t of towers) {
    t.x += 520;
    t.z *= 1.6;
  }
  for (let i = 0; i < 26; i++) {
    const a = -0.75 + rnd() * 1.5;
    const r = 650 + rnd() * 700;
    towers.push({
      x: Math.cos(a) * r + 150,
      z: Math.sin(a) * r * 1.1,
      h: 45 + rnd() * rnd() * 150,
      kind: rnd() < 0.12 ? 'round' : 'box',
      w: 18 + rnd() * 20,
      d: 18 + rnd() * 22,
      style: (['glass', 'stone', 'dark', 'stone'] as Style[])[Math.floor(rnd() * 4)],
      yaw: rnd() * Math.PI,
    });
  }

  const byStyle: Record<Style, THREE.BufferGeometry[]> = { glass: [], stone: [], dark: [] };
  for (const t of towers) {
    const g = t.kind === 'box' ? boxTower(t.w, t.h, t.d ?? t.w) : prismTower(t.w / 2, t.h, t.kind === 'tri' ? 3 : 40);
    // Crown / setback on some towers.
    const parts = [g];
    if (t.h > 140 && t.kind === 'box') parts.push(boxTower(t.w * 0.6, 12, (t.d ?? t.w) * 0.6).translate(0, t.h, 0));
    const merged = parts.length > 1 ? mergeGeometries(parts)! : g;
    merged.rotateY(t.yaw ?? 0).translate(t.x, CITY_Y, t.z);
    byStyle[t.style].push(merged);
  }
  for (const style of ['glass', 'stone', 'dark'] as Style[]) {
    if (!byStyle[style].length) continue;
    const mat = new THREE.MeshStandardMaterial({
      map: facadeTexture(style, 1),
      roughness: style === 'stone' ? 0.85 : 0.25,
      metalness: style === 'stone' ? 0 : 0.35,
    });
    scene.add(new THREE.Mesh(mergeGeometries(byStyle[style])!, mat));
  }

  // Low-rise "White City": instanced boxes in cream/white, a ring around the stadium.
  const blocks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 }),
    700,
  );
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  const palette = ['#f1ece0', '#e8dfcc', '#f6f3ec', '#d9d2c3', '#ece3d3', '#c9c2b5'];
  let n = 0;
  while (n < blocks.count) {
    const a = rnd() * Math.PI * 2;
    const r = 150 + rnd() * 650;
    p.set(Math.cos(a) * r, CITY_Y, Math.sin(a) * r * 0.9);
    // Keep clear of the model's plaza and trees around the bowl.
    if (Math.abs(p.x) < 140 && p.z > -145 && p.z < 195) continue;
    s.set(12 + rnd() * 26, 7 + rnd() * rnd() * 26, 12 + rnd() * 26);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.round(rnd() * 3) * 0.25);
    blocks.setMatrixAt(n, m.compose(p, q, s));
    blocks.setColorAt(n, c.set(palette[Math.floor(rnd() * palette.length)]));
    n++;
  }
  blocks.instanceMatrix.needsUpdate = true;
  blocks.computeBoundingSphere();
  scene.add(blocks);

  // City ground.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2400, 48).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#b9b2a2', roughness: 1 }),
  );
  ground.position.y = CITY_Y - 0.03;
  scene.add(ground);
}
