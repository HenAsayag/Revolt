/** Continuous driving controls, shared by the player and (later) AI drivers. */
export interface DriveInput {
  /** -1..1 — positive accelerates, negative brakes then reverses. */
  throttle: number;
  /** -1..1 — positive steers right. */
  steer: number;
  handbrake: boolean;
}

/** One-shot actions, true only on the frame they were pressed. */
export interface ActionInput {
  reset: boolean;
  camera: boolean;
  usePickup: boolean;
  pause: boolean;
  debug: boolean;
  /** Enter / gamepad Start: restart or confirm on menus. */
  confirm: boolean;
}

import { isTouchDevice, TouchControls } from './TouchControls';

export const neutralDrive = (): DriveInput => ({ throttle: 0, steer: 0, handbrake: false });

const DEADZONE = 0.15;
const deadzone = (v: number) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping)
const PAD = { A: 0, B: 1, X: 2, Y: 3, LT: 6, RT: 7, BACK: 8, START: 9 } as const;

/**
 * Keyboard + gamepad. Call `poll()` once per rendered frame, then read `drive` / `actions`.
 * Keyboard uses `KeyboardEvent.code` so WASD works on any layout (incl. Hebrew).
 */
export class Input {
  readonly drive: DriveInput = neutralDrive();
  readonly actions: ActionInput = { reset: false, camera: false, usePickup: false, pause: false, debug: false, confirm: false };
  /** True when the gamepad produced input most recently (for UI hints later). */
  usingGamepad = false;

  private down = new Set<string>();
  private pressed = new Set<string>();
  private padPrev: boolean[] = [];
  /** On-screen controls, created automatically on touch devices. */
  readonly touch: TouchControls | null;

  constructor(target: Window = window) {
    this.touch = isTouchDevice() ? new TouchControls() : null;
    target.addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  poll(): void {
    const k = (...codes: string[]) => codes.some((c) => this.down.has(c));
    const p = (...codes: string[]) => codes.some((c) => this.pressed.has(c));

    let throttle = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0);
    let steer = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
    let handbrake = k('Space');
    const a = this.actions;
    a.reset = p('KeyR');
    a.camera = p('KeyC');
    a.usePickup = p('ShiftLeft', 'ShiftRight', 'KeyE');
    a.pause = p('Escape', 'KeyP');
    a.debug = p('F3', 'Backquote');
    a.confirm = p('Enter', 'NumpadEnter');
    if (throttle || steer || handbrake) this.usingGamepad = false;

    const pad = firstGamepad();
    if (pad) {
      const btn = (i: number) => pad.buttons[i]?.pressed ?? false;
      const val = (i: number) => pad.buttons[i]?.value ?? 0;
      const edge = (i: number) => btn(i) && !this.padPrev[i];
      const padSteer = deadzone(pad.axes[0] ?? 0);
      const padThrottle = val(PAD.RT) - val(PAD.LT);
      if (Math.abs(padSteer) > 0 || Math.abs(padThrottle) > 0.05 || btn(PAD.A)) this.usingGamepad = true;
      if (!steer) steer = padSteer;
      if (!throttle) throttle = padThrottle;
      handbrake ||= btn(PAD.A);
      a.usePickup ||= edge(PAD.B) || edge(PAD.X);
      a.reset ||= edge(PAD.Y);
      a.camera ||= edge(PAD.BACK);
      a.confirm ||= edge(PAD.START);
      this.padPrev = pad.buttons.map((b) => b.pressed);
    }

    const t = this.touch?.state;
    if (t) {
      if (!steer) steer = t.steer;
      if (!throttle) throttle = (t.gas ? 1 : 0) - (t.brake ? 1 : 0);
      handbrake ||= t.drift;
      a.reset ||= t.reset;
      a.camera ||= t.camera;
      a.confirm ||= t.confirm;
      t.reset = t.camera = t.confirm = false;
    }

    this.drive.throttle = Math.max(-1, Math.min(1, throttle));
    this.drive.steer = Math.max(-1, Math.min(1, steer));
    this.drive.handbrake = handbrake;
    this.pressed.clear();
  }
}

const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F3']);

function firstGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  for (const g of navigator.getGamepads()) if (g && g.connected) return g;
  return null;
}
