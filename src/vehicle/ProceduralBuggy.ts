import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarConfig } from './CarConfig';
import type { CarVisual, Livery } from './CarVisual';
import type { RaycastCar } from './RaycastCar';
import { checkerTexture, numberDecalTexture, treadTexture } from '../render/textures';

/** Give a geometry a flat per-vertex colour (linear), so differently coloured parts can share one mesh. */
function tint(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Side profile (z, y) extruded across the car's width. */
function profileExtrude(points: [number, number][], width: number, bevel = 0.008): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 4,
  });
  // Shape x → car z, extrusion axis → car x, centred.
  geo.rotateY(-Math.PI / 2);
  geo.translate(width / 2 - bevel, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

// Shared (car-independent) resources.
let shared: {
  tire: THREE.LatheGeometry;
  tireMat: THREE.MeshStandardMaterial;
  rim: THREE.CylinderGeometry;
  spoke: THREE.BoxGeometry;
  chassisMat: THREE.MeshStandardMaterial;
  glassMat: THREE.MeshStandardMaterial;
  blackMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  tailMat: THREE.MeshStandardMaterial;
  antennaMat: THREE.MeshStandardMaterial;
  bodyMat: THREE.MeshPhysicalMaterial;
  hubMat: THREE.MeshStandardMaterial;
  tipMat: THREE.MeshStandardMaterial;
} | null = null;

function getShared(cfg: CarConfig) {
  if (shared) return shared;
  const r = cfg.wheelRadius;
  const hw = cfg.wheelWidth / 2;
  // Balloon tyre: rounded shoulders, revolved around Y then turned to spin around X.
  const prof: THREE.Vector2[] = [
    [0.6, -hw], [0.84, -hw], [0.95, -hw * 0.88], [1.0, -hw * 0.6], [1.0, hw * 0.6], [0.95, hw * 0.88], [0.84, hw], [0.6, hw],
  ].map(([x, y]) => new THREE.Vector2(x * r, y));
  const tire = new THREE.LatheGeometry(prof, 28);
  tire.rotateZ(Math.PI / 2);
  const tread = treadTexture();
  shared = {
    tire,
    tireMat: new THREE.MeshStandardMaterial({ color: '#ffffff', map: tread, roughness: 0.92, metalness: 0 }),
    rim: new THREE.CylinderGeometry(r * 0.62, r * 0.62, cfg.wheelWidth * 0.8, 20).rotateZ(Math.PI / 2),
    spoke: new THREE.BoxGeometry(0.006, r * 1.12, r * 0.16),
    chassisMat: new THREE.MeshStandardMaterial({ color: '#2a2b2e', roughness: 0.7, metalness: 0.2 }),
    glassMat: new THREE.MeshStandardMaterial({ color: '#15181d', roughness: 0.15, metalness: 0.6 }),
    blackMat: new THREE.MeshStandardMaterial({ color: '#161616', roughness: 0.6 }),
    headMat: new THREE.MeshStandardMaterial({ color: '#fff6c8', emissive: '#fff1a8', emissiveIntensity: 0.6 }),
    tailMat: new THREE.MeshStandardMaterial({ color: '#ff2a2a', emissive: '#c00000', emissiveIntensity: 0.5 }),
    antennaMat: new THREE.MeshStandardMaterial({ color: '#0d0d0d', roughness: 0.4 }),
    bodyMat: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.2 }),
    hubMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.3 }),
    tipMat: new THREE.MeshStandardMaterial({ color: '#ff1414', emissive: '#8a0000', emissiveIntensity: 0.4, roughness: 0.4 }),
  };
  return shared;
}

/**
 * Toy RC buggy built from primitives: extruded body shell, glass cabin, rear wing,
 * balloon tyres with spoked rims, and a springy antenna with a red tip.
 */
export class ProceduralBuggy implements CarVisual {
  readonly root = new THREE.Group();
  private readonly wheelPivots: THREE.Object3D[] = [];
  private readonly wheelSpinners: THREE.Object3D[] = [];
  private readonly smoothSusp: number[];
  private readonly antenna = new THREE.Group();
  private readonly owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  // Antenna spring state (bend angles about local X and Z).
  private antX = 0;
  private antZ = 0;
  private antVX = 0;
  private antVZ = 0;
  private readonly prevVel = new THREE.Vector3();
  private hasPrevVel = false;

  constructor(private readonly cfg: CarConfig, livery: Livery) {
    const s = getShared(cfg);
    // Eight of these race at once, so the static parts are merged into a handful of meshes:
    // one vertex-coloured body, the roof, the decals, and per wheel a tyre + a hub.
    const roofMat =
      livery.roof === 'checker'
        ? new THREE.MeshStandardMaterial({ map: checkerTexture(6), roughness: 0.35 })
        : new THREE.MeshStandardMaterial({ color: livery.roof, roughness: 0.35 });
    const decalMat = new THREE.MeshStandardMaterial({ map: numberDecalTexture(livery.number), transparent: true, roughness: 0.4 });
    this.owned.push(roofMat, decalMat);

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.root, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow;
      m.receiveShadow = true;
      parent.add(m);
      this.owned.push(geo);
      return m;
    };
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

    // --- Body: every static part, coloured per vertex, one draw call.
    const body: THREE.BufferGeometry[] = [];
    const part = (g: THREE.BufferGeometry, color: THREE.ColorRepresentation) => body.push(tint(g, color));
    part(box(0.22, 0.034, 0.46).translate(0, -0.03, 0), '#2a2b2e'); // chassis tub
    part(box(0.25, 0.036, 0.045).translate(0, -0.018, 0.262), '#161616'); // bumpers
    part(box(0.23, 0.04, 0.04).translate(0, -0.012, -0.252), '#161616');
    part(profileExtrude(
      [[-0.235, -0.012], [0.25, -0.012], [0.25, 0.034], [0.218, 0.058], [0.11, 0.078], [-0.2, 0.084], [-0.235, 0.074]],
      0.24,
    ), livery.body);
    part(profileExtrude([[-0.145, 0.07], [0.105, 0.07], [0.035, 0.148], [-0.1, 0.143]], 0.2, 0.006), '#15181d'); // glass
    part(box(0.244, 0.012, 0.36).translate(0, 0.018, 0), livery.accent); // flank stripe
    part(box(0.27, 0.008, 0.075).rotateX(-0.12).translate(0, 0.145, -0.205), livery.accent); // wing
    for (const side of [1, -1]) {
      part(box(0.008, 0.06, 0.022).translate(side * 0.075, 0.112, -0.2), '#161616'); // wing struts
      part(box(0.045, 0.018, 0.01).translate(side * 0.072, 0.03, 0.26), '#fff6c8'); // headlights
      part(box(0.04, 0.016, 0.01).translate(side * 0.075, 0.052, -0.245), '#ff2a2a'); // tail lights
    }
    mesh(mergeGeometries(body.map((g) => (g.index ? g.toNonIndexed() : g)))!, s.bodyMat);
    mesh(box(0.19, 0.008, 0.13).rotateX(0.03).translate(0, 0.151, -0.032), roofMat);
    const decals = [1, -1].map((side) => new THREE.PlaneGeometry(0.075, 0.075).rotateY((side * Math.PI) / 2).translate(side * 0.1225, 0.045, -0.04));
    mesh(mergeGeometries(decals)!, decalMat, this.root, false);

    // Antenna (rear right), pivoting at its base.
    this.antenna.position.set(-0.075, 0.085, -0.16);
    this.root.add(this.antenna);
    const antLen = 0.36;
    mesh(new THREE.CylinderGeometry(0.0022, 0.0035, antLen, 5).translate(0, antLen / 2, 0), s.antennaMat, this.antenna);
    mesh(new THREE.SphereGeometry(0.011, 10, 8).translate(0, antLen, 0), s.tipMat, this.antenna);

    // Wheels: pivot (suspension travel + steering) → spinner (roll) → tyre + hub (rim and spokes).
    const hub = mergeGeometries([
      tint(s.rim.clone(), livery.rim),
      ...[0, 1, 2].map((i) => tint(s.spoke.clone().rotateX((i * Math.PI) / 3).translate(cfg.wheelWidth * 0.4, 0, 0), '#161616')),
    ].map((g) => (g.index ? g.toNonIndexed() : g)))!;
    this.owned.push(hub);
    for (const [x, z] of [
      [cfg.halfTrack, cfg.frontAxleZ], [-cfg.halfTrack, cfg.frontAxleZ],
      [cfg.halfTrack, cfg.rearAxleZ], [-cfg.halfTrack, cfg.rearAxleZ],
    ]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, cfg.mountY - cfg.suspensionRest, z);
      const spinner = new THREE.Group();
      spinner.scale.x = Math.sign(x); // mirror so spokes face outward on both sides
      pivot.add(spinner);
      const tire = new THREE.Mesh(s.tire, s.tireMat);
      tire.castShadow = tire.receiveShadow = true;
      const h = new THREE.Mesh(hub, s.hubMat);
      h.castShadow = true;
      spinner.add(tire, h);
      this.root.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelSpinners.push(spinner);
    }
    this.smoothSusp = this.wheelPivots.map(() => cfg.suspensionRest);
  }

  update(car: RaycastCar, dt: number): void {
    const cfg = this.cfg;
    const k = 1 - Math.exp(-dt * 40);
    car.wheels.forEach((w, i) => {
      this.smoothSusp[i] += (w.suspensionLength - this.smoothSusp[i]) * k;
      const pivot = this.wheelPivots[i];
      pivot.position.y = cfg.mountY - this.smoothSusp[i];
      pivot.rotation.y = w.front ? -car.steerAngle : 0;
      this.wheelSpinners[i].rotation.x = w.spin;
    });
    this.updateAntenna(car, dt);
  }

  /** Antenna whips opposite to the car's acceleration, like a thin steel whip on a real RC car. */
  private updateAntenna(car: RaycastCar, dt: number): void {
    if (dt <= 0) return;
    const lv = car.body.linvel();
    const v = new THREE.Vector3(lv.x, lv.y, lv.z);
    if (!this.hasPrevVel) {
      this.prevVel.copy(v);
      this.hasPrevVel = true;
    }
    const acc = v.clone().sub(this.prevVel).divideScalar(dt);
    this.prevVel.copy(v);
    acc.y += 9.81; // feel gravity/landings too
    acc.applyQuaternion(car.quat.clone().invert());
    // Teleports and hard landings produce huge one-frame spikes; keep the whip believable.
    if (acc.lengthSq() > 30 * 30) acc.setLength(30);
    const K = 160, C = 4, G = 0.011;
    const h = Math.min(dt, 1 / 30);
    this.antVX += (-K * this.antX - C * this.antVX - acc.z * G * K) * h;
    this.antVZ += (-K * this.antZ - C * this.antVZ + acc.x * G * K) * h;
    this.antX = THREE.MathUtils.clamp(this.antX + this.antVX * h, -0.6, 0.6);
    this.antZ = THREE.MathUtils.clamp(this.antZ + this.antVZ * h, -0.6, 0.6);
    this.antenna.rotation.set(this.antX - 0.12, 0, this.antZ);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const o of this.owned) o.dispose();
  }
}
