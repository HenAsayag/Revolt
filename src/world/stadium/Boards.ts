import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addStaticBox } from '../../physics/Physics';
import { adBoardTexture } from '../../render/textures';
import { BOARDS } from './layout';

/** Generic, made-up sponsors only. */
const ADS = ['BLOOMFIELD RC', 'TURBO TOYS', 'RC LEAGUE', 'PIT STOP', 'NITRO KIDS', 'SPEEDWAY', 'SUNNY COLA', 'GO FAST', 'JAFFA HOBBY', 'TOY GARAGE'];

/**
 * Red advertising boards ringing the grass, text on both faces. Bodies are merged into one
 * mesh and faces into one mesh per advert, so ~50 boards cost ~11 draw calls.
 */
export function buildBoards(scene: THREE.Object3D, world: RAPIER.World): void {
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#a8121a', roughness: 0.5 });
  const bodies: THREE.BufferGeometry[] = [];
  const faces: THREE.BufferGeometry[][] = ADS.map(() => []);
  const segLen = 7.6;
  let adIndex = 0;
  const m = new THREE.Matrix4();
  const place = (cx: number, cz: number, len: number, alongX: boolean) => {
    const yaw = alongX ? 0 : Math.PI / 2;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const pos = new THREE.Vector3(cx, BOARDS.height / 2, cz);
    m.compose(pos, q, new THREE.Vector3(1, 1, 1));
    const w = len - 0.12;
    bodies.push(new THREE.BoxGeometry(w, BOARDS.height, BOARDS.thickness).applyMatrix4(m));
    const ad = adIndex++ % ADS.length;
    for (const side of [1, -1]) {
      const face = new THREE.PlaneGeometry(w - 0.02, BOARDS.height - 0.04);
      if (side < 0) face.rotateY(Math.PI);
      face.translate(0, 0, side * (BOARDS.thickness / 2 + 0.004));
      faces[ad].push(face.applyMatrix4(m));
    }
    addStaticBox(world, pos, new THREE.Vector3(len / 2, BOARDS.height / 2, BOARDS.thickness / 2), q, { friction: 0.02, restitution: 0.05 });
  };
  for (const s of [-1, 1]) {
    const n = Math.floor((BOARDS.halfX * 2 - 2) / segLen);
    for (let i = 0; i < n; i++) place(-((n - 1) * segLen) / 2 + i * segLen, s * BOARDS.halfZ, segLen, true);
    const k = Math.floor((BOARDS.halfZ * 2 - 2) / segLen);
    for (let i = 0; i < k; i++) place(s * BOARDS.halfX, -((k - 1) * segLen) / 2 + i * segLen, segLen, false);
  }

  const body = new THREE.Mesh(mergeGeometries(bodies)!, bodyMat);
  body.castShadow = body.receiveShadow = true;
  scene.add(body);
  faces.forEach((geos, i) => {
    if (!geos.length) return;
    const map = adBoardTexture(ADS[i], i);
    const mat = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: '#ffffff', emissiveIntensity: 0.25, roughness: 0.4 });
    const mesh = new THREE.Mesh(mergeGeometries(geos)!, mat);
    mesh.receiveShadow = true;
    scene.add(mesh);
  });
}
