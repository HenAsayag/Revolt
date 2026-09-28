/**
 * On-screen controls for phones and tablets (landscape): an analog steering pad on the left,
 * GAS / BRAKE / DRIFT on the right, and small reset / camera / fullscreen buttons at the top.
 * Writes into a plain state object that `Input` merges with keyboard and gamepad.
 */
export interface TouchState {
  steer: number; // -1..1
  gas: boolean;
  brake: boolean;
  drift: boolean;
  /** One-shot flags, cleared by Input after reading. */
  reset: boolean;
  camera: boolean;
  confirm: boolean;
  item: boolean;
  pause: boolean;
  active: boolean;
}

/** Touch UI on phones/tablets; force it with ?touch=1 (or hide with ?touch=0). */
export const isTouchDevice = (): boolean => {
  if (typeof window === 'undefined') return false;
  const force = new URLSearchParams(location.search).get('touch');
  if (force !== null) return force === '1';
  return ('ontouchstart' in window || navigator.maxTouchPoints > 0) && matchMedia('(pointer: coarse)').matches;
};

export class TouchControls {
  readonly state: TouchState = { steer: 0, gas: false, brake: false, drift: false, reset: false, camera: false, confirm: false, item: false, pause: false, active: false };
  private readonly root: HTMLElement;
  private readonly knob: HTMLElement;
  private steerPointer: number | null = null;
  private steerOrigin = 0;

  constructor(parent: HTMLElement = document.body) {
    document.body.classList.add('touch');
    this.root = document.createElement('div');
    this.root.className = 'touch-ui';
    this.root.innerHTML = `
      <div class="t-steer" data-zone="steer"><div class="t-steer-track"><div class="t-knob"></div></div><span>STEER</span></div>
      <div class="t-pedals">
        <button class="t-btn t-item" data-tap="item">ITEM</button>
        <button class="t-btn t-drift" data-hold="drift">DRIFT</button>
        <button class="t-btn t-brake" data-hold="brake">BRAKE</button>
        <button class="t-btn t-gas" data-hold="gas">GAS</button>
      </div>
      <div class="t-top">
        <button class="t-mini" data-tap="reset" title="Reset">↺</button>
        <button class="t-mini" data-tap="camera" title="Camera">🎥</button>
        <button class="t-mini" data-tap="pause" title="Pause">⏸</button>
        <button class="t-mini" data-tap="fullscreen" title="Fullscreen">⛶</button>
      </div>
      <div class="t-rotate">Turn your phone sideways for the best view ↻</div>`;
    parent.appendChild(this.root);
    this.knob = this.root.querySelector('.t-knob')!;
    const steerZone = this.root.querySelector<HTMLElement>('.t-steer')!;

    // Steering: horizontal drag from wherever the thumb lands (floating centre).
    steerZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.steerPointer = e.pointerId;
      this.steerOrigin = e.clientX;
      try { steerZone.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ }
      this.state.active = true;
    });
    steerZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.steerPointer) return;
      const range = Math.min(90, steerZone.clientWidth * 0.4);
      const dx = (e.clientX - this.steerOrigin) / range;
      const x = Math.max(-1, Math.min(1, dx));
      this.state.steer = Math.sign(x) * Math.abs(x) ** 1.6; // expo: fine control near the centre
      this.knob.style.transform = `translateX(${x * 60}px)`; // knob follows the thumb, not the curve
    });
    const endSteer = (e: PointerEvent) => {
      if (e.pointerId !== this.steerPointer) return;
      this.steerPointer = null;
      this.state.steer = 0;
      this.knob.style.transform = '';
    };
    steerZone.addEventListener('pointerup', endSteer);
    steerZone.addEventListener('pointercancel', endSteer);

    // Hold buttons (multi-touch: gas + drift + steer at once).
    for (const btn of this.root.querySelectorAll<HTMLElement>('[data-hold]')) {
      const key = btn.dataset.hold as 'gas' | 'brake' | 'drift';
      const set = (on: boolean) => (e: PointerEvent) => {
        e.preventDefault();
        this.state[key] = on;
        btn.classList.toggle('down', on);
        this.state.active = true;
      };
      btn.addEventListener('pointerdown', (e) => {
        try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ }
        set(true)(e);
      });
      btn.addEventListener('pointerup', set(false));
      btn.addEventListener('pointercancel', set(false));
      btn.addEventListener('lostpointercapture', () => {
        this.state[key] = false;
        btn.classList.remove('down');
      });
    }
    for (const btn of this.root.querySelectorAll<HTMLElement>('[data-tap]')) {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const what = btn.dataset.tap!;
        if (what === 'fullscreen') this.toggleFullscreen();
        else this.state[what as 'reset' | 'camera' | 'confirm' | 'item' | 'pause'] = true;
      });
    }
    // No page scrolling, zooming or long-press menus while playing.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  private toggleFullscreen(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      (document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(doc))?.();
      return;
    }
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    Promise.resolve(req?.())
      .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape'))
      .catch(() => {});
  }
}
