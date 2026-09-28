import { ITEM_ICONS, ITEM_KINDS, type ItemKind } from '../race/Items';
/**
 * DOM HUD, laid out like the reference: lap + pickup slot top-left, race time top-right,
 * position bottom-left, speedometer (mph + arc of lights) bottom-right, pop-ups in the centre,
 * plus the countdown, a wrong-way banner and the results table.
 */
const LIGHT_COLORS = ['#ff2a1a', '#ff5a14', '#ff9a12', '#ffd21a', '#c8e81e', '#7ee62a', '#2fdc3a'];

export interface HudFrame {
  mph: number;
  /** 0..1 — lights the RPM/speed arc. */
  gauge: number;
  debug?: string;
}

export interface HudRace {
  lap: number;
  laps: number;
  time: string;
  best: string | null;
  place: number;
  placeSuffix: string;
  racers: number;
}

export interface ResultRow {
  place: string;
  name: string;
  time: string;
  best: string;
  stunts: string;
  isPlayer: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class Hud {
  private readonly root: HTMLElement;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly lights: HTMLElement[] = [];
  private popupTimer = 0;
  private bannerTimer = 0;
  private countTimer = 0;
  private last: Record<string, string> = {};
  private lastLit = -1;
  showDebug = false;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-tl">
        <div class="hud-label hud-small">Lap</div>
        <div class="hud-num" id="hud-lap">1/3</div>
        <div class="hud-slot" id="hud-slot"><div class="hud-slot-icon" id="hud-slot-icon"></div></div>
      </div>
      <div class="hud-tr">
        <div class="hud-label hud-small">Time</div>
        <div class="hud-num" id="hud-time">00:00:00</div>
        <div class="hud-sub" id="hud-best"></div>
        <div class="hud-sub"><span class="hud-label">STUNTS</span> <span id="hud-score">0</span></div>
      </div>
      <div class="hud-bl"><span class="hud-pos" id="hud-pos">1</span><span class="hud-label hud-pos-suf" id="hud-pos-suf">st</span><span class="hud-pos-of" id="hud-pos-of">/ 1</span></div>
      <div class="hud-speed">
        <div class="hud-lights"></div>
        <div class="hud-speed-readout"><span class="hud-big" id="hud-mph">0</span><span class="hud-label">mph</span></div>
      </div>
      <div class="hud-popup" id="hud-popup"></div>
      <div class="hud-count" id="hud-count"></div>
      <div class="hud-banner" id="hud-banner"></div>
      <div class="hud-results" id="hud-results"></div>
      <div class="hud-hint" id="hud-hint">
        <b>W A S D</b> / arrows drive · <b>Space</b> handbrake (drift!) · <b>R</b> reset · <b>C</b> camera · <b>Shift</b>/<b>E</b> use item · <b>Enter</b> restart · gamepad: RT/LT, stick, A, B = item
      </div>
      <pre class="hud-debug" id="hud-debug"></pre>`;
    for (const id of ['lap', 'time', 'best', 'score', 'pos', 'pos-suf', 'pos-of', 'mph', 'popup', 'count', 'banner', 'results', 'hint', 'debug', 'slot', 'slot-icon']) {
      this.el[id] = root.querySelector(`#hud-${id}`)!;
    }
    const lightsEl = root.querySelector('.hud-lights')!;
    // Lights sweep along a quarter arc from bottom-left up to top-right.
    LIGHT_COLORS.forEach((c, i) => {
      const a = (Math.PI / 2) * (i / (LIGHT_COLORS.length - 1));
      const el = document.createElement('div');
      el.className = 'hud-light';
      el.style.setProperty('--c', c);
      el.style.left = `${(1 - Math.cos(a)) * 92}px`;
      el.style.bottom = `${Math.sin(a) * 60 + (1 - Math.cos(a)) * 18}px`;
      lightsEl.appendChild(el);
      this.lights.push(el);
    });
    setTimeout(() => this.el.hint.classList.add('fade'), 14000);
  }

  /** Only touch the DOM when text actually changes. */
  private set(id: string, text: string): void {
    if (this.last[id] === text) return;
    this.last[id] = text;
    this.el[id].textContent = text;
  }

  private slotKey = '';
  /** Pickup slot: the item's icon, a flicking roulette while it's rolling, empty when null. */
  setItem(kind: ItemKind | null, rolling: boolean): void {
    const shown: ItemKind | null = rolling ? ITEM_KINDS[Math.floor(performance.now() / 85) % ITEM_KINDS.length] : kind;
    const key = `${shown}|${rolling}`;
    if (key === this.slotKey) return;
    this.slotKey = key;
    this.el['slot-icon'].style.backgroundImage = shown ? ITEM_ICONS[shown] : 'none';
    this.el.slot.classList.toggle('rolling', rolling);
    this.el.slot.classList.toggle('ready', !!kind && !rolling);
  }

  setScore(points: number): void {
    this.set('score', points.toLocaleString('en-US'));
  }

  setRace(r: HudRace): void {
    this.set('lap', `${Math.min(r.lap, r.laps)}/${r.laps}`);
    this.set('time', r.time);
    this.set('best', r.best ? `BEST ${r.best}` : '');
    this.set('pos', String(r.place));
    this.set('pos-suf', r.placeSuffix);
    this.set('pos-of', `/ ${r.racers}`);
  }

  /** Centre pop-up, e.g. `AIR TIME` + `1.2s`. */
  flash(label: string, value: string, seconds = 1.6): void {
    const p = this.el.popup;
    p.innerHTML = `<span class="hud-label">${esc(label)}</span> <span class="hud-value">${esc(value)}</span>`;
    p.classList.remove('show');
    void p.offsetWidth; // restart the CSS animation
    p.classList.add('show');
    this.popupTimer = seconds;
  }

  /** Big countdown number / GO! */
  countdown(text: string): void {
    const c = this.el.count;
    c.textContent = text;
    c.classList.toggle('go', text.startsWith('GO'));
    c.classList.remove('show');
    void c.offsetWidth;
    c.classList.add('show');
    this.countTimer = 0.9;
  }

  /** Red flashing banner (WRONG WAY). */
  banner(text: string, seconds = 1.5): void {
    this.el.banner.textContent = text;
    this.el.banner.classList.add('show');
    this.bannerTimer = seconds;
  }

  showResults(rows: ResultRow[], footer: string): void {
    const body = rows
      .map((r) => `<tr class="${r.isPlayer ? 'me' : ''}"><td>${esc(r.place)}</td><td>${esc(r.name)}</td><td>${esc(r.time)}</td><td>${esc(r.best)}</td><td>${esc(r.stunts)}</td></tr>`)
      .join('');
    this.el.results.innerHTML = `
      <div class="hud-results-card">
        <div class="hud-results-title">RACE RESULTS</div>
        <table><thead><tr><th>Pos</th><th>Racer</th><th>Time</th><th>Best lap</th><th>Stunts</th></tr></thead><tbody>${body}</tbody></table>
        <div class="hud-results-foot">${esc(footer)}</div>
      </div>`;
    this.el.results.classList.add('show');
  }

  hideResults(): void {
    this.el.results.classList.remove('show');
  }

  update(f: HudFrame, dt: number): void {
    this.set('mph', String(Math.round(f.mph)));
    const lit = Math.round(Math.min(1, Math.max(0, f.gauge)) * this.lights.length);
    if (lit !== this.lastLit) {
      this.lights.forEach((el, i) => el.classList.toggle('on', i < lit));
      this.lastLit = lit;
    }
    if (this.popupTimer > 0 && (this.popupTimer -= dt) <= 0) this.el.popup.classList.remove('show');
    if (this.countTimer > 0 && (this.countTimer -= dt) <= 0) this.el.count.classList.remove('show');
    if (this.bannerTimer > 0 && (this.bannerTimer -= dt) <= 0) this.el.banner.classList.remove('show');
    this.el.debug.style.display = this.showDebug ? 'block' : 'none';
    if (this.showDebug && f.debug !== undefined) this.el.debug.textContent = f.debug;
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }
}
