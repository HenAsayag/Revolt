import * as THREE from 'three';

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Collects cylinders between point pairs (truss members, handrails, posts, cables) and
 * emits them as a single InstancedMesh — thousands of members, one draw call.
 */
export class StrutBatch {
  private readonly matrices: THREE.Matrix4[] = [];

  add(a: THREE.Vector3, b: THREE.Vector3, radius: number): this {
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-5) return this;
    _mid.addVectors(a, b).multiplyScalar(0.5);
    _q.setFromUnitVectors(_up, _dir.divideScalar(len));
    _s.set(radius, len, radius);
    this.matrices.push(_m.compose(_mid, _q, _s).clone());
    return this;
  }

  get count(): number {
    return this.matrices.length;
  }

  build(material: THREE.Material, radialSegments = 6, castShadow = true): THREE.InstancedMesh {
    const geo = new THREE.CylinderGeometry(1, 1, 1, radialSegments, 1, true);
    const mesh = new THREE.InstancedMesh(geo, material, this.matrices.length);
    this.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    return mesh;
  }
}
