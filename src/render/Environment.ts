import * as THREE from 'three';

/**
 * Direction *towards* the sun: high midday sun from the south-east (Tel Aviv), lighting the
 * north stand face-on; high enough that stands barely shade the apron.
 */
export const SUN_DIR = new THREE.Vector3(0.3, 0.9, -0.32).normalize();

export const SKY = {
  zenith: new THREE.Color('#2f78d6'),
  horizon: new THREE.Color('#b9dcf7'),
  ground: new THREE.Color('#d8e4ea'),
};

/** Clear-day gradient dome that follows the camera. */
export function createSky(radius = 1800): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: SKY.zenith },
      horizon: { value: SKY.horizon },
      ground: { value: SKY.ground },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always at the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith, horizon, ground, sunDir;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 col = h > 0.0
          ? mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55))
          : mix(horizon, ground, clamp(-h * 4.0, 0.0, 1.0));
        float sun = max(dot(normalize(vDir), sunDir), 0.0);
        col += vec3(1.0, 0.95, 0.85) * (pow(sun, 900.0) * 3.0 + pow(sun, 12.0) * 0.12);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

/**
 * Sunny daytime rig: sky/ground hemisphere fill + a sun whose shadow frustum tracks a focus
 * point (the player car), so a tight frustum gives crisp shadows on tiny cars in a huge scene.
 */
export class SunLight {
  readonly hemi: THREE.HemisphereLight;
  readonly sun: THREE.DirectionalLight;
  readonly dir = SUN_DIR;
  private readonly shadowRange: number;

  constructor(scene: THREE.Scene, opts: { shadowRange?: number; mapSize?: number } = {}) {
    this.shadowRange = opts.shadowRange ?? 16;
    this.hemi = new THREE.HemisphereLight('#d4e8ff', '#9a917f', 1.15);
    this.sun = new THREE.DirectionalLight('#fff3de', 3.8);
    this.sun.castShadow = true;
    const size = opts.mapSize ?? 2048;
    this.sun.shadow.mapSize.set(size, size);
    const cam = this.sun.shadow.camera;
    const r = this.shadowRange;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 10;
    cam.far = 200; // keep the depth range tight: bias is relative to it
    this.sun.shadow.bias = -0.00005;
    this.sun.shadow.normalBias = 0.01;
    this.sun.shadow.radius = 2;
    scene.add(this.hemi, this.sun, this.sun.target);
  }

  /** Centre the shadow frustum on `focus`, snapped to shadow texels to avoid shimmering. */
  follow(focus: THREE.Vector3): void {
    const texel = (this.shadowRange * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx, focus.y, fz).addScaledVector(this.dir, 90);
    this.sun.target.updateMatrixWorld();
  }
}
