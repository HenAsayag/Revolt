import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { addStaticBox, addStaticHull, type StaticOpts } from '../physics/Physics';

/**
 * Creates matching render meshes + static colliders for simple level pieces.
 * Every piece is placed by a position and a yaw (radians about +Y).
 */
export class LevelBuilder {
  constructor(
    readonly scene: THREE.Object3D,
    readonly world: RAPIER.World,
  ) {}

  private place(mesh: THREE.Mesh, pos: THREE.Vector3, yaw: number, shadows = true): THREE.Mesh {
    mesh.position.copy(pos);
    mesh.rotation.y = yaw;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  /** Axis-aligned-then-yawed box, `pos` is its centre. */
  box(pos: THREE.Vector3, size: THREE.Vector3, mat: THREE.Material, yaw = 0, opts?: StaticOpts): THREE.Mesh {
    const mesh = this.place(new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat), pos, yaw);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    addStaticBox(this.world, pos, size.clone().multiplyScalar(0.5), q, opts);
    return mesh;
  }

  /**
   * Kicker ramp (triangular prism). `pos` is the centre of the leading edge on the ground;
   * the ramp rises along its local +Z to `height` at `length`.
   */
  wedge(pos: THREE.Vector3, width: number, length: number, height: number, mat: THREE.Material, yaw = 0, opts?: StaticOpts): THREE.Mesh {
    const geo = prismGeometry(width, length, height);
    const mesh = this.place(new THREE.Mesh(geo, mat), pos, yaw);
    const hw = width / 2;
    const pts = [
      [-hw, 0, 0], [hw, 0, 0], [-hw, 0, length], [hw, 0, length], [-hw, height, length], [hw, height, length],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    addStaticHull(this.world, pts, pos, q, opts);
    return mesh;
  }

  /** Half-buried log/speed bump lying across local X. */
  bump(pos: THREE.Vector3, radius: number, length: number, mat: THREE.Material, yaw = 0): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(radius, radius, length, 16, 1).rotateZ(Math.PI / 2);
    const mesh = this.place(new THREE.Mesh(geo, mat), pos, yaw);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const x of [-length / 2, length / 2]) pts.push(new THREE.Vector3(x, Math.cos(a) * radius, Math.sin(a) * radius));
    }
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    addStaticHull(this.world, pts, pos, q);
    return mesh;
  }
}

/** Triangular prism with UVs suitable for a plywood texture on the sloped face. */
export function prismGeometry(width: number, length: number, height: number): THREE.BufferGeometry {
  const hw = width / 2;
  const slope = Math.hypot(length, height);
  const pos: number[] = [];
  const uv: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], u: number, v: number) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    uv.push(0, 0, u, 0, u, v, 0, 0, u, v, 0, v);
  };
  const tri = (a: number[], b: number[], c: number[], u: number, v: number) => {
    pos.push(...a, ...b, ...c);
    uv.push(0, 0, u, 0, u, v);
  };
  const s = 1.2; // metres per texture repeat
  quad([hw, 0, 0], [-hw, 0, 0], [-hw, height, length], [hw, height, length], width / s, slope / s); // slope
  quad([-hw, 0, length], [hw, 0, length], [hw, height, length], [-hw, height, length], width / s, height / s); // back
  tri([hw, 0, 0], [hw, height, length], [hw, 0, length], length / s, height / s); // +X side
  tri([-hw, 0, length], [-hw, height, length], [-hw, 0, 0], length / s, height / s); // -X side
  quad([-hw, 0, 0], [hw, 0, 0], [hw, 0, length], [-hw, 0, length], width / s, length / s); // bottom
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}
