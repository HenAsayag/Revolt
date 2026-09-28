import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { addStaticBox } from '../physics/Physics';
import { checkerTexture, plywoodTexture, startBannerTexture } from '../render/textures';
import { LevelBuilder } from '../world/LevelBuilder';
import { ConeField } from './Cones';
import { FootballField } from './Footballs';
import { buildBoostPads, buildDeck, buildGlide, buildLoop, buildRamp, buildWalls, type BoostPads } from './TrackPieces';
import type { Track } from './Track';
import type { TrackFeature } from './trackData';

const BARRIER = { length: 1.15, gap: 0.05, height: 0.55, base: 0.42, top: 0.14, clearance: 0.22 } as const;
/** Height of the barriers' (invisible) collision fence, m. */
const FENCE_HEIGHT = 1.7;
const RED = new THREE.Color('#d8262a');
const WHITE = new THREE.Color('#f1f1ef');

export interface BuiltTrack {
  cones: ConeField;
  balls: FootballField;
  pads: BoostPads;
  /** Stair-hop spans: axle impulses every `pitch` metres of track between s0 and s1. */
  bumps: { s0: number; s1: number; pitch: number; strength: number }[];
  /** Arc-length span of the loop, if the track has one. */
  loopSpan: [number, number] | null;
  startS: number;
  /** Named stretches reserved for later set pieces, as [s0, s1]. */
  zones: Record<string, [number, number]>;
  debugLine: THREE.Line;
  barrierCount: number;
}

/** Water-filled road barrier: a ribbed trapezoid, extruded along local Z, base at y = 0. */
function barrierGeometry(): THREE.BufferGeometry {
  const b = BARRIER.base / 2, t = BARRIER.top / 2, h = BARRIER.height;
  const shape = new THREE.Shape([
    new THREE.Vector2(-b, 0), new THREE.Vector2(b, 0), new THREE.Vector2(b, 0.07), new THREE.Vector2(b * 0.62, 0.16),
    new THREE.Vector2(t * 1.25, h * 0.86), new THREE.Vector2(t, h), new THREE.Vector2(-t, h), new THREE.Vector2(-t * 1.25, h * 0.86),
    new THREE.Vector2(-b * 0.62, 0.16), new THREE.Vector2(-b, 0.07),
  ]);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: BARRIER.length - 0.03, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.01, bevelSegments: 2, curveSegments: 1,
  });
  geo.translate(0, 0, -(BARRIER.length - 0.03) / 2);
  geo.computeVertexNormals();
  return geo;
}

/** Is arc length s inside [s0, s1] going forward around the loop? */
function inSpan(track: Track, s: number, s0: number, s1: number): boolean {
  return track.forwardDistance(s0, s) <= track.forwardDistance(s0, s1);
}

export function buildTrack(scene: THREE.Object3D, world: RAPIER.World, track: Track, features: TrackFeature[]): BuiltTrack {
  const root = new THREE.Group();
  root.name = 'track';
  scene.add(root);
  const zones: Record<string, [number, number]> = {};
  let startS = 0;
  const gaps: { s0: number; s1: number; side: 'left' | 'right' | 'both' }[] = [];
  const conePlacements: { pos: THREE.Vector3; yaw: number }[] = [];
  const ballSpots: THREE.Vector3[] = [];
  const goalTargets: THREE.Vector3[] = [];
  const padSamples: ReturnType<Track['sampleAt']>[] = [];
  const bumps: BuiltTrack['bumps'] = [];
  const builder = new LevelBuilder(root, world);
  const ply = new THREE.MeshStandardMaterial({ map: plywoodTexture(), roughness: 0.8 });

  const walk = (from: [number, number], to: [number, number], spacing: number, fn: (s: number, k: number) => void) => {
    const s0 = track.sAt(from);
    const span = track.forwardDistance(s0, track.sAt(to));
    for (let d = 0, k = 0; d <= span + 1e-6; d += spacing, k++) fn(track.wrapS(s0 + d), k);
  };
  const addCone = (s: number, lateral: number) => {
    const pos = track.pointAt(s, lateral);
    pos.y += 0.002;
    conePlacements.push({ pos, yaw: track.yawAt(s) + (Math.random() - 0.5) * 0.6 });
  };

  for (const f of features) {
    switch (f.type) {
      case 'start':
        startS = track.sAt(f.at);
        break;
      case 'kicker': {
        const s = track.sAt(f.at);
        const smp = track.sampleAt(s);
        builder.wedge(smp.pos.clone(), smp.width - 0.1, f.length, f.height, ply, track.yawAt(s), { friction: 0.8 });
        break;
      }
      case 'slalom':
        walk(f.from, f.to, f.spacing, (s, k) => addCone(s, (k % 2 ? 1 : -1) * f.offset));
        break;
      case 'coneRow':
        walk(f.from, f.to, f.spacing, (s) => addCone(s, f.offset));
        break;
      case 'ramp':
        buildRamp(root, world, new THREE.Vector3(...f.from), new THREE.Vector3(...f.to), f.width, f.base);
        break;
      case 'deck':
        buildDeck(root, world, track.span(track.sAt(f.from), track.sAt(f.to)));
        break;
      case 'glide':
        buildGlide(world, new THREE.Vector3(...f.from), new THREE.Vector3(...f.to), f.width);
        break;
      case 'stairBumps':
        bumps.push({ s0: track.sAt(f.from), s1: track.sAt(f.to), pitch: f.pitch, strength: f.strength });
        break;
      case 'walls':
        buildWalls(world, track.span(track.sAt(f.from), track.sAt(f.to)), f.offset, f.height);
        break;
      case 'boost':
        padSamples.push(track.sampleAt(track.sAt(f.at)));
        break;
      case 'footballs':
        for (const [x, z] of f.at) ballSpots.push(new THREE.Vector3(x, 0, z));
        goalTargets.push(new THREE.Vector3(f.goal[0] + Math.sign(f.goal[0]) * 0.8, 0.8, f.goal[1]));
        break;
      case 'barrierGap':
        gaps.push({ s0: track.sAt(f.from), s1: track.sAt(f.to), side: f.side });
        break;
      case 'zone':
        zones[f.name] = [track.sAt(f.from), track.sAt(f.to)];
        break;
    }
  }

  // --- Barriers: resample each side's offset line into equal pieces (~1.2 m) and place a
  // segment + static collider on each, alternating red and white.
  const mats: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const fwdZ = new THREE.Vector3(0, 0, 1);
  for (const side of [-1, 1] as const) {
    const sideName = side < 0 ? 'left' : 'right';
    const pts = track.samples.map((smp) => smp.pos.clone().addScaledVector(smp.right, side * (smp.width / 2 + BARRIER.clearance)));
    const n = pts.length;
    const cum = [0];
    for (let i = 0; i < n; i++) cum.push(cum[i] + pts[i].distanceTo(pts[(i + 1) % n]));
    const total = cum[n];
    const count = Math.floor(total / (BARRIER.length + BARRIER.gap));
    const pitch = total / count;
    let seg = 0;
    const at = (d: number, out: THREE.Vector3) => {
      while (seg < n - 1 && cum[seg + 1] < d) seg++;
      const t = (d - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]);
      return { point: out.copy(pts[seg]).lerp(pts[(seg + 1) % n], t), index: seg };
    };
    let colour = 0;
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
    for (let j = 0; j < count; j++) {
      const { index } = at(j * pitch, p0);
      at(j * pitch + pitch - BARRIER.gap, p1);
      const sHere = track.samples[index].s;
      if (gaps.some((g) => (g.side === 'both' || g.side === sideName) && inSpan(track, sHere, g.s0, g.s1))) {
        colour = 0;
        continue;
      }
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      const len = p0.distanceTo(p1);
      q.setFromUnitVectors(fwdZ, p1.clone().sub(p0).setY(0).normalize());
      mats.push(m.compose(mid, q, new THREE.Vector3(1, 1, len / BARRIER.length)).clone());
      cols.push((colour++ % 2 ? WHITE : RED).clone().multiplyScalar(0.94 + Math.random() * 0.08));
      // The collider rises well above the visible barrier: an invisible fence, so a car that
      // jumps near the edge lands back on the track instead of sailing out over the barriers.
      addStaticBox(
        world,
        mid.clone().add(new THREE.Vector3(0, FENCE_HEIGHT / 2, 0)),
        new THREE.Vector3(BARRIER.base / 2 - 0.04, FENCE_HEIGHT / 2, len / 2),
        q.clone(),
        { friction: 0.02, restitution: 0.05 }, // slide along, don't ping off
      );
    }
  }
  const barriers = new THREE.InstancedMesh(
    barrierGeometry(),
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.42 }),
    mats.length,
  );
  mats.forEach((mm, i) => {
    barriers.setMatrixAt(i, mm);
    barriers.setColorAt(i, cols[i]);
  });
  barriers.instanceMatrix.needsUpdate = true;
  if (barriers.instanceColor) barriers.instanceColor.needsUpdate = true;
  barriers.computeBoundingSphere();
  barriers.castShadow = true;
  barriers.receiveShadow = true;
  root.add(barriers);

  buildStartLine(root, world, track, startS);

  const loopSpan = track.loopSpan();
  if (loopSpan) buildLoop(root, world, track.span(loopSpan[0] - 1.5, loopSpan[1] + 1.5));
  const pads = buildBoostPads(root, world, padSamples);

  const cones = new ConeField(world, conePlacements);
  root.add(cones.mesh);
  const balls = new FootballField(world, ballSpots, goalTargets);
  root.add(balls.mesh);

  // Centre line for debugging / editing (shown with F3).
  const linePts = track.samples.map((smp) => smp.pos.clone().add(new THREE.Vector3(0, 0.04, 0)));
  linePts.push(linePts[0].clone());
  const debugLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(linePts),
    new THREE.LineBasicMaterial({ color: '#ffe600', depthTest: false, transparent: true }),
  );
  debugLine.renderOrder = 10;
  debugLine.visible = false;
  root.add(debugLine);

  return { cones, balls, pads, bumps, loopSpan, startS, zones, debugLine, barrierCount: mats.length };
}

/** Chequered line across the track, painted grid boxes behind it, and a gantry overhead. */
function buildStartLine(root: THREE.Object3D, world: RAPIER.World, track: Track, startS: number): void {
  const smp = track.sampleAt(startS);
  const yaw = track.yawAt(startS);
  const group = new THREE.Group();
  group.position.copy(smp.pos);
  group.rotation.y = yaw;
  root.add(group);

  const checker = checkerTexture(6).clone();
  checker.repeat.set(smp.width / 0.75, 0.5 / 0.75); // 12.5 cm squares
  checker.needsUpdate = true;
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(smp.width, 0.5).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: checker, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  line.position.y = 0.006;
  line.receiveShadow = true;
  group.add(line);

  // Grid boxes (local -Z is behind the line).
  const paint = new THREE.MeshBasicMaterial({ color: '#f0f0f0' });
  for (let i = 0; i < 8; i++) {
    const row = Math.floor(i / 2);
    const side = i % 2 === 0 ? -1 : 1;
    const z = -(1.6 + row * 1.4 + (i % 2) * 0.6);
    // Car convention: local +X is the car's left, so right-of-travel = -X.
    const x = -side * 0.62;
    for (const [w, d, ox, oz] of [[0.5, 0.04, 0, 0.3], [0.04, 0.34, -0.25, 0.13], [0.04, 0.34, 0.25, 0.13]]) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), paint);
      bar.position.set(x + ox, 0.005, z + oz);
      group.add(bar);
    }
  }

  // Gantry: two posts outside the barriers carrying a banner.
  const post = new THREE.MeshStandardMaterial({ color: '#2b2e33', roughness: 0.5, metalness: 0.4 });
  const halfSpan = smp.width / 2 + 0.75;
  const h = 1.7;
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.1), post);
    p.position.set(sx * halfSpan, h / 2, 0);
    p.castShadow = true;
    group.add(p);
    group.updateMatrixWorld(true);
    addStaticBox(world, p.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0.05, h / 2, 0.05));
  }
  const bannerMat = new THREE.MeshStandardMaterial({ map: startBannerTexture(), emissive: '#ffffff', emissiveMap: startBannerTexture(), emissiveIntensity: 0.3 });
  const banner = new THREE.Mesh(new THREE.BoxGeometry(halfSpan * 2 + 0.1, 0.36, 0.06), [post, post, post, post, bannerMat, bannerMat]);
  banner.position.set(0, h - 0.18, 0);
  banner.castShadow = true;
  group.add(banner);
}
