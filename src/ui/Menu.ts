export type Difficulty = 'easy' | 'normal' | 'hard';

export interface Settings {
  track: 'tour' | 'stairs' | 'classic';
  laps: number;
  /** Smart steering: helps follow the track and keeps you off the walls. */
  assist: boolean;
  /** Invisible rivals race the same lap but can't be seen or touched (and don't use items). */
  rivals: 'invisible' | 'visible';
  difficulty: Difficulty;
  items: boolean;
  /** 0..1 */
  music: number;
  sfx: number;
}

const KEY = 'bloomfield-rc-settings';
const DEFAULTS: Settings = { track: 'tour', laps: 3, assist: true, rivals: 'invisible', difficulty: 'normal', items: true, music: 0.5, sfx: 0.9 };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = { ...DEFAULTS, ...JSON.parse(raw) } as Settings;
      if (![1, 3, 5].includes(s.laps)) s.laps = 3;
      if (!['easy', 'normal', 'hard'].includes(s.difficulty)) s.difficulty = 'normal';
      if (!['tour', 'stairs', 'classic'].includes(s.track)) s.track = 'tour';
      if (s.rivals !== 'invisible' && s.rivals !== 'visible') s.rivals = 'invisible';
      return s;
    }
  } catch {
    /* private mode / blocked storage: defaults */
  }
  return { ...DEFAULTS };
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

type Card = 'title' | 'pause' | null;
export type NavDir = 'up' | 'down' | 'left' | 'right';

export interface MenuHandlers {
  start(s: Settings): void;
  resume(): void;
  restart(): void;
  quit(): void;
  /** Any setting changed (volumes apply live). */
  changed(s: Settings): void;
  click(): void;
}

/**
 * Title screen (options + RACE!) and pause menu, as a DOM overlay. Works with mouse / touch,
 * and with keyboard or gamepad via `nav()` / `activate()` (arrows move, left/right change).
 */
export class Menu {
  readonly settings = loadSettings();
  private readonly root: HTMLElement;
  private card: Card = null;
  private focus = 0;

  constructor(parent: HTMLElement, private readonly h: MenuHandlers) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.root.innerHTML = `
      <div class="menu-card" data-card="title">
        <div class="menu-logo"><span>BLOOMFIELD</span><b>RC</b></div>
        <div class="menu-tag">Toy-car racing around the stadium</div>
        <button class="menu-btn primary" data-act="start" data-row>RACE!</button>
        <div class="menu-opts">
          ${seg('Track', 'track', [['tour', 'Stadium Tour'], ['stairs', 'Stair Run'], ['classic', 'Pitch Circuit']])}
          ${seg('Laps', 'laps', [['1', '1'], ['3', '3'], ['5', '5']])}
          ${seg('Steering', 'assist', [['on', 'Assisted'], ['off', 'Pro']])}
          ${seg('Opponents', 'rivals', [['invisible', 'Invisible'], ['visible', 'Visible']])}
          ${seg('AI level', 'difficulty', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']])}
          ${seg('Pickups', 'items', [['on', 'On'], ['off', 'Off']])}
          ${slider('Music', 'music')}
          ${slider('Sound', 'sfx')}
        </div>
        <div class="menu-help">
          <div><b>W A S D</b> / arrows drive · <b>Space</b> drift · <b>Shift</b>/<b>E</b> use item · <b>R</b> reset · <b>C</b> camera · <b>Esc</b> pause</div>
          <div>Gamepad: <b>RT</b>/<b>LT</b> gas/brake · stick steer · <b>A</b> drift · <b>B</b> item · <b>Y</b> reset · <b>Start</b> pause</div>
          <div class="menu-touch">Phone: steer pad on the left, GAS / BRAKE / DRIFT / ITEM on the right — turn it sideways!</div>
        </div>
      </div>
      <div class="menu-card" data-card="pause">
        <div class="menu-title">PAUSED</div>
        <button class="menu-btn primary" data-act="resume" data-row>RESUME</button>
        <button class="menu-btn" data-act="restart" data-row>RESTART RACE</button>
        <button class="menu-btn" data-act="quit" data-row>MAIN MENU</button>
        <div class="menu-opts">
          ${slider('Music', 'music')}
          ${slider('Sound', 'sfx')}
        </div>
      </div>`;
    parent.appendChild(this.root);

    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act], [data-v]');
      if (!el) return;
      const row = el.closest<HTMLElement>('[data-row]');
      if (row) this.setFocus(this.rows().indexOf(row));
      if (el.dataset.act) this.act(el.dataset.act);
      else this.choose(el.closest<HTMLElement>('[data-opt]')!.dataset.opt!, el.dataset.v!);
    });
    for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-vol]')) {
      input.addEventListener('input', () => {
        this.settings[input.dataset.vol as 'music' | 'sfx'] = Number(input.value) / 100;
        this.sync();
        this.h.changed(this.settings);
      });
    }
    window.addEventListener('keydown', (e) => {
      if (!this.card) return;
      const map: Record<string, NavDir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };
      if (map[e.code]) {
        e.preventDefault();
        this.nav(map[e.code]);
      } else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) this.activate();
      } else if ((e.code === 'Escape' || e.code === 'KeyP') && this.card === 'pause' && !e.repeat) {
        this.act('resume');
      }
    });
    this.sync();
  }

  get visible(): boolean {
    return this.card !== null;
  }

  show(card: Exclude<Card, null>): void {
    this.card = card;
    this.root.classList.add('show');
    for (const c of this.root.querySelectorAll<HTMLElement>('.menu-card')) c.classList.toggle('show', c.dataset.card === card);
    this.setFocus(0);
    this.sync();
  }

  hide(): void {
    this.card = null;
    this.root.classList.remove('show');
  }

  nav(dir: NavDir): void {
    const rows = this.rows();
    if (!rows.length) return;
    if (dir === 'up' || dir === 'down') {
      this.setFocus((this.focus + (dir === 'down' ? 1 : -1) + rows.length) % rows.length);
      this.h.click();
      return;
    }
    const row = rows[this.focus];
    const opt = row.querySelector<HTMLElement>('[data-opt]');
    const vol = row.querySelector<HTMLInputElement>('input[data-vol]');
    const step = dir === 'right' ? 1 : -1;
    if (opt) {
      const vals = [...opt.querySelectorAll<HTMLElement>('[data-v]')].map((b) => b.dataset.v!);
      const cur = vals.indexOf(this.current(opt.dataset.opt!));
      this.choose(opt.dataset.opt!, vals[Math.max(0, Math.min(vals.length - 1, cur + step))]);
    } else if (vol) {
      vol.value = String(Math.max(0, Math.min(100, Number(vol.value) + step * 10)));
      vol.dispatchEvent(new Event('input'));
      this.h.click();
    }
  }

  activate(): void {
    const row = this.rows()[this.focus];
    const act = row?.dataset.act ?? row?.querySelector<HTMLElement>('[data-act]')?.dataset.act;
    if (act) this.act(act);
    else this.nav('right');
  }

  /** Back (Esc / gamepad B): resume from pause. */
  back(): void {
    if (this.card === 'pause') this.act('resume');
  }

  private act(a: string): void {
    this.h.click();
    if (a === 'start') this.h.start(this.settings);
    else if (a === 'resume') this.h.resume();
    else if (a === 'restart') this.h.restart();
    else if (a === 'quit') this.h.quit();
  }

  private current(opt: string): string {
    const s = this.settings;
    if (opt === 'track') return s.track;
    if (opt === 'assist') return s.assist ? 'on' : 'off';
    if (opt === 'rivals') return s.rivals;
    return opt === 'laps' ? String(s.laps) : opt === 'difficulty' ? s.difficulty : s.items ? 'on' : 'off';
  }

  private choose(opt: string, v: string): void {
    if (opt === 'laps') this.settings.laps = Number(v);
    else if (opt === 'difficulty') this.settings.difficulty = v as Difficulty;
    else if (opt === 'items') this.settings.items = v === 'on';
    else if (opt === 'assist') this.settings.assist = v === 'on';
    else if (opt === 'rivals') this.settings.rivals = v as Settings['rivals'];
    else if (opt === 'track') {
      if (this.settings.track === v) return;
      this.settings.track = v as Settings['track'];
      this.sync();
      // A different track means a different world: rebuild by reloading (keeps it simple and leak-free).
      this.root.querySelector('.menu-tag')!.textContent = 'Loading track…';
      setTimeout(() => location.reload(), 60);
      return;
    }
    this.h.click();
    this.sync();
    this.h.changed(this.settings);
  }

  private sync(): void {
    for (const opt of this.root.querySelectorAll<HTMLElement>('[data-opt]')) {
      const cur = this.current(opt.dataset.opt!);
      for (const b of opt.querySelectorAll<HTMLElement>('[data-v]')) b.classList.toggle('on', b.dataset.v === cur);
    }
    for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-vol]')) {
      input.value = String(Math.round(this.settings[input.dataset.vol as 'music' | 'sfx'] * 100));
    }
    saveSettings(this.settings);
  }

  private rows(): HTMLElement[] {
    const card = this.root.querySelector<HTMLElement>(`.menu-card[data-card="${this.card}"]`);
    return card ? [...card.querySelectorAll<HTMLElement>('[data-row]')] : [];
  }

  private setFocus(i: number): void {
    const rows = this.rows();
    this.focus = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, k) => r.classList.toggle('focus', k === this.focus));
  }
}

function seg(label: string, opt: string, vals: [string, string][]): string {
  return `<div class="menu-row" data-row><label>${label}</label><div class="seg" data-opt="${opt}">${vals
    .map(([v, t]) => `<button data-v="${v}">${t}</button>`)
    .join('')}</div></div>`;
}

function slider(label: string, key: string): string {
  return `<div class="menu-row" data-row><label>${label}</label><input type="range" min="0" max="100" step="5" data-vol="${key}" /></div>`;
}
