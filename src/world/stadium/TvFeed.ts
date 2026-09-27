import * as THREE from 'three';

/**
 * Broadcast camera feeding the stadium's LED screens: alternates between a long-lens gantry
 * shot and a high chase shot. Rendered at low resolution every few frames.
 */
export class TvFeed {
  readonly target = new THREE.WebGLRenderTarget(384, 216, { samples: 0 });
  readonly camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.3, 2500);
  /** Meshes that display the feed; hidden while the feed renders (no feedback loop). */
  screens: THREE.Object3D[] = [];
  private frame = 0;
  private clock = 0;
  private readonly look = new THREE.Vector3();
  private readonly gantries = [
    new THREE.Vector3(0, 30, -62),
    new THREE.Vector3(0, 30, 62),
    new THREE.Vector3(-76, 17, 0),
    new THREE.Vector3(76, 17, 0),
  ];

  constructor() {
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
  }

  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, focus: THREE.Vector3, heading: THREE.Vector3, dt: number): void {
    this.clock += dt;
    if (++this.frame % 4 !== 0) return;
    const shot = Math.floor(this.clock / 7) % 2;
    if (shot === 0) {
      let best = this.gantries[0];
      for (const g of this.gantries) if (g.distanceToSquared(focus) < best.distanceToSquared(focus)) best = g;
      this.camera.position.copy(best);
      const dist = best.distanceTo(focus);
      this.camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(5 / dist)), 6, 40);
    } else {
      this.camera.position.copy(focus).addScaledVector(heading, -3.2);
      this.camera.position.y += 1.8;
      this.camera.fov = 45;
    }
    this.look.lerp(focus, this.look.lengthSq() === 0 ? 1 : 0.6);
    this.camera.lookAt(this.look);
    this.camera.updateProjectionMatrix();

    for (const s of this.screens) s.visible = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prev);
    for (const s of this.screens) s.visible = true;
  }
}
