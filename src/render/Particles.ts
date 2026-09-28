import * as THREE from 'three';

export interface Emit {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
  /** World-space diameter (m) at birth and how much it grows per second. */
  size: number;
  grow?: number;
  life: number;
  alpha?: number;
  gravity?: number;
  /** Velocity damping per second. */
  drag?: number;
}

const VERT = /* glsl */ `
  attribute float psize;
  attribute float palpha;
  attribute vec3 pcolor;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = psize * uScale / max(0.05, -mv.z);
    gl_Position = projectionMatrix * mv;
    vColor = pcolor;
    vAlpha = palpha;
  }`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uSoft;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = mix(step(d, 0.5), smoothstep(0.5, 0.15, d), uSoft) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);
  }`;

/**
 * A pooled, CPU-simulated point-sprite system (one draw call). `soft` gives round smoke puffs;
 * hard-edged points are used for confetti. Oldest particles are recycled when the pool is full.
 */
export class Particles {
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly age: Float32Array;
  private readonly birthSize: Float32Array;
  private readonly grow: Float32Array;
  private readonly birthAlpha: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private next = 0;
  private live = 0;
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  readonly points: THREE.Points;

  constructor(scene: THREE.Scene, private readonly max: number, opts: { additive?: boolean; soft?: boolean } = {}) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max).fill(1e9);
    this.birthSize = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.birthAlpha = new Float32Array(max);
    this.gravity = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uScale: { value: 500 }, uSoft: { value: opts.soft === false ? 0 : 1 } },
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
  }

  emit(e: Emit): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos.set([e.pos.x, e.pos.y, e.pos.z], i * 3);
    this.vel.set([e.vel.x, e.vel.y, e.vel.z], i * 3);
    this.col.set([e.color.r, e.color.g, e.color.b], i * 3);
    this.birthSize[i] = this.size[i] = e.size;
    this.grow[i] = e.grow ?? 0;
    this.birthAlpha[i] = this.alpha[i] = e.alpha ?? 1;
    this.life[i] = e.life;
    this.age[i] = 0;
    this.gravity[i] = e.gravity ?? 0;
    this.drag[i] = e.drag ?? 0;
    this.live = this.max;
  }

  clear(): void {
    this.age.fill(1e9);
    this.alpha.fill(0);
    this.live = 0;
    (this.geo.getAttribute('palpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** `scale` = pixels per metre at 1 m: drawing-buffer height / (2·tan(fov/2)). */
  update(dt: number, scale: number): void {
    this.mat.uniforms.uScale.value = scale;
    if (this.live === 0) return;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) {
        this.alpha[i] = 0;
        continue;
      }
      alive++;
      const a = (this.age[i] += dt);
      const t = Math.min(1, a / this.life[i]);
      const k = Math.exp(-this.drag[i] * dt);
      const j = i * 3;
      this.vel[j] *= k;
      this.vel[j + 1] = this.vel[j + 1] * k - this.gravity[i] * dt;
      this.vel[j + 2] *= k;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      this.size[i] = this.birthSize[i] + this.grow[i] * a;
      // Quick fade-in, long fade-out.
      this.alpha[i] = this.birthAlpha[i] * Math.min(1, t * 8) * (1 - t) ** 1.5;
    }
    if (alive === 0) this.live = 0;
    for (const n of ['position', 'pcolor', 'psize', 'palpha']) (this.geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }
}
