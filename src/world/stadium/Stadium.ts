import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { addStaticBox } from '../../physics/Physics';
import { concreteTexture } from '../../render/textures';
import { buildBoards } from './Boards';
import { FLOOR } from './layout';
import { buildPitch } from './Pitch';
import { buildSkyline } from './Skyline';
import { clearSeats, installStadiumModel, type StadiumAssets } from './StadiumModel';
import { TvFeed } from './TvFeed';

export interface Stadium {
  tv: TvFeed;
  seatCount: number;
  /** Remove the seats under track pieces built into the stands ([x0, z0, x1, z1] rectangles). */
  clearSeats(rects: [number, number, number, number][]): number;
}

/** Bloomfield Stadium: the imported model, plus the game's own pitch, boards, skyline and TV feed. */
export function buildStadium(scene: THREE.Scene, world: RAPIER.World, assets: StadiumAssets): Stadium {
  const root = new THREE.Group();
  root.name = 'stadium';
  scene.add(root);

  // Service apron slab under the bowl (replaces the model's turf/apron, which the exporter drops).
  const concrete = concreteTexture().clone();
  concrete.repeat.set((FLOOR.halfX * 2) / 4, (FLOOR.halfZ * 2) / 4);
  concrete.needsUpdate = true;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR.halfX * 2, FLOOR.halfZ * 2).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: concrete, color: '#9aa3a0', roughness: 0.92 }),
  );
  floor.position.y = -0.004;
  floor.receiveShadow = true;
  root.add(floor);
  addStaticBox(world, new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(160, 0.5, 160), undefined, { friction: 0.8 });

  buildPitch(root, world);
  buildBoards(root, world);

  const tv = new TvFeed();
  const model = installStadiumModel(root, world, assets, tv.target.texture);
  tv.screens = model.screens;

  buildSkyline(root);
  return { tv, seatCount: model.seatCount, clearSeats: (rects) => clearSeats(model.seats, rects) };
}
