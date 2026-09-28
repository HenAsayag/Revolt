import * as THREE from 'three';
import type { ArcadeCar } from './ArcadeCar';

/**
 * What the game needs from a car's look. The procedural buggy implements this today;
 * a GLTF-backed version only has to find its wheel/antenna nodes and do the same.
 */
export interface CarVisual {
  readonly root: THREE.Object3D;
  /** Called every rendered frame after `root` has been placed at the interpolated pose. */
  update(car: ArcadeCar, dt: number): void;
  dispose(): void;
}

export interface Livery {
  body: THREE.ColorRepresentation;
  accent: THREE.ColorRepresentation;
  rim: THREE.ColorRepresentation;
  /** 'checker' for the player's chequered roof, otherwise a colour. */
  roof: 'checker' | THREE.ColorRepresentation;
  number: number;
}

export const LIVERIES: Livery[] = [
  { body: '#d91e1e', accent: '#1a1a1a', rim: '#e8e8e8', roof: 'checker', number: 1 }, // player
  { body: '#ffc21a', accent: '#1a1a1a', rim: '#303030', roof: '#ffc21a', number: 2 },
  { body: '#1f5fe0', accent: '#e8e8e8', rim: '#e8e8e8', roof: '#e8e8e8', number: 3 },
  { body: '#2fb34a', accent: '#1a1a1a', rim: '#ffd000', roof: '#1a1a1a', number: 4 },
  { body: '#ff7a1a', accent: '#1a1a1a', rim: '#e8e8e8', roof: '#1a1a1a', number: 5 },
  { body: '#8e3bd9', accent: '#e8e8e8', rim: '#ffd000', roof: '#e8e8e8', number: 6 },
  { body: '#16c2c9', accent: '#1a1a1a', rim: '#e8e8e8', roof: '#ff3b8d', number: 7 },
  { body: '#f2f2f2', accent: '#d91e1e', rim: '#d91e1e', roof: '#1a1a1a', number: 8 },
];
