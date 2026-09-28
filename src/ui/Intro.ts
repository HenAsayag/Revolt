/**
 * The front door: a "tap to start" gate (which also unlocks audio and offers fullscreen), and the
 * captions / letterbox for the opening fly-through of the stadium.
 */

const isIPhone = () => /iPhone|iPod/.test(navigator.userAgent);
const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const canFullscreen = () => {
  const d = document as Document & { webkitFullscreenEnabled?: boolean };
  return !!(document.fullscreenEnabled || d.webkitFullscreenEnabled);
};

/** Enter fullscreen (and lock landscape where allowed). Fails quietly. */
export async function goFullscreen(): Promise<void> {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
  try {
    await (el.requestFullscreen?.call(el, { navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.call(el));
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape');
  } catch {
    /* not allowed here (e.g. iPhone Safari) — carry on in the window */
  }
}

const SHARE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:-3px"><path d="M12 3l-4 4h3v8h2V7h3z" fill="#3fe6ff"/><path d="M5 10h3v2H7v8h10v-8h-1v-2h3v12H5z" fill="#3fe6ff"/></svg>`;

/** The start screen. Resolves once the player taps a start button (a user gesture: audio can start). */
export function showGate(parent: HTMLElement = document.body): Promise<void> {
  const fs = canFullscreen() && !isStandalone();
  const iphoneTip = isIPhone() && !isStandalone();
  const touch = matchMedia('(pointer: coarse)').matches;
  const root = document.createElement('div');
  root.className = 'gate';
  root.innerHTML = `
    <div class="gate-card">
      <div class="menu-logo"><span>BLOOMFIELD</span><b>RC</b></div>
      <div class="menu-tag">Toy-car racing inside Bloomfield Stadium</div>
      ${fs ? `<button class="menu-btn primary" data-go="fs">⛶ PLAY FULLSCREEN</button>` : ''}
      <button class="menu-btn ${fs ? '' : 'primary'}" data-go="play">${fs ? 'PLAY IN A WINDOW' : '▶ PLAY'}</button>
      ${iphoneTip ? `<div class="gate-tip"><b>iPhone:</b> Safari can't make a web page fullscreen. For the real thing, tap
        ${SHARE_ICON} <b>Share</b> → <b>Add to Home Screen</b>, then open Bloomfield RC from its new icon.</div>` : ''}
      ${touch ? `<div class="gate-rotate">Best played sideways ↻</div>` : ''}
    </div>`;
  parent.appendChild(root);
  return new Promise((resolve) => {
    for (const b of root.querySelectorAll<HTMLElement>('[data-go]')) {
      b.addEventListener('click', () => {
        if (b.dataset.go === 'fs') void goFullscreen();
        root.classList.add('out');
        setTimeout(() => root.remove(), 450);
        resolve();
      }, { once: true });
    }
  });
}

export interface Caption {
  at: number;
  until: number;
  title: string;
  sub?: string;
}

/** Letterbox bars, captions, a fade-to-black for cuts, and the skip hint. */
export class IntroOverlay {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly fade: HTMLElement;
  private shown = -1;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'intro';
    this.root.innerHTML = `
      <div class="intro-bar top"></div><div class="intro-bar bottom"></div>
      <div class="intro-cap"><div class="intro-title"></div><div class="intro-sub"></div></div>
      <div class="intro-logo menu-logo"><span>BLOOMFIELD</span><b>RC</b></div>
      <div class="intro-fade"></div>
      <div class="intro-skip">${matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Press any key'} to skip ›</div>`;
    parent.appendChild(this.root);
    this.title = this.root.querySelector('.intro-title')!;
    this.sub = this.root.querySelector('.intro-sub')!;
    this.fade = this.root.querySelector('.intro-fade')!;
  }

  show(): void {
    this.root.classList.add('show');
  }

  hide(): void {
    this.root.classList.remove('show', 'logo');
    this.shown = -1;
  }

  /** Per frame: which caption is up, the cut fade (0..1) and whether the end logo shows. */
  update(captions: Caption[], t: number, fade: number, logo: boolean): void {
    const i = captions.findIndex((c) => t >= c.at && t < c.until);
    if (i !== this.shown) {
      this.shown = i;
      const cap = this.root.querySelector('.intro-cap')!;
      cap.classList.remove('in');
      if (i >= 0) {
        this.title.textContent = captions[i].title;
        this.sub.textContent = captions[i].sub ?? '';
        void (cap as HTMLElement).offsetWidth;
        cap.classList.add('in');
      }
    }
    this.fade.style.opacity = String(fade);
    this.root.classList.toggle('logo', logo);
  }
}
