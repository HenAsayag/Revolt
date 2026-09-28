/**
 * All game audio, synthesised with Web Audio (no sample files, no licensed music):
 * electric-motor whines for the cars, tyre squeal, crowd ambience with cheers, one-shot effects
 * and an original chiptune loop. Browsers only allow audio after a user gesture, so nothing
 * starts until `unlock()` is called from one.
 */
export type SfxName =
  | 'count' | 'go' | 'pickup' | 'tick' | 'ready' | 'boost' | 'throw' | 'explode' | 'oil' | 'spin'
  | 'zap' | 'hit' | 'land' | 'lap' | 'finalLap' | 'finish' | 'goal' | 'click' | 'cone' | 'kick'
  | 'boostPad' | 'drift' | 'wrong';

export interface Volumes {
  master: number;
  sfx: number;
  music: number;
}

interface EngineVoice {
  a: OscillatorNode;
  b: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

/** The player + the three nearest AI. */
export const ENGINE_VOICES = 4;

export class Sound {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private engines: EngineVoice[] = [];
  private skidGain!: GainNode;
  private crowdGain!: GainNode;
  private cheerGain!: GainNode;
  private music: Music | null = null;
  private musicMode: 'menu' | 'race' | 'off' = 'menu';
  volumes: Volumes = { master: 0.8, sfx: 0.9, music: 0.45 };

  /** Create / resume the audio graph. Safe to call on every gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.build();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolumes(v: Partial<Volumes>): void {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.volumes.music * 0.55, t, 0.05);
  }

  /** Menu: mellow (filtered) music. Race: full. Off: silence. */
  setMusicMode(mode: 'menu' | 'race' | 'off'): void {
    this.musicMode = mode;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.musicFilter.frequency.setTargetAtTime(mode === 'race' ? 16000 : 900, t, 0.3);
    if (mode === 'off') this.music?.stop();
    else this.music?.start();
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 900;
    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.musicFilter).connect(this.master);

    // One second of white noise, looped / sliced for everything noisy.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    for (let i = 0; i < ENGINE_VOICES; i++) {
      const a = ctx.createOscillator();
      a.type = 'sawtooth';
      const b = ctx.createOscillator();
      b.type = 'triangle';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 4;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      a.connect(filter);
      b.connect(filter);
      filter.connect(gain).connect(pan).connect(this.sfxBus);
      a.start();
      b.start();
      this.engines.push({ a, b, filter, gain, pan });
    }

    // Tyre squeal: band-passed noise.
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    const skidBp = ctx.createBiquadFilter();
    skidBp.type = 'bandpass';
    skidBp.frequency.value = 2400;
    skidBp.Q.value = 1.6;
    this.loopNoise().connect(skidBp).connect(this.skidGain).connect(this.sfxBus);

    // Crowd: a low murmur, plus a brighter cheer layer that swells on big moments.
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.05;
    const crowdLp = ctx.createBiquadFilter();
    crowdLp.type = 'lowpass';
    crowdLp.frequency.value = 650;
    this.loopNoise().connect(crowdLp).connect(this.crowdGain).connect(this.sfxBus);
    this.cheerGain = ctx.createGain();
    this.cheerGain.gain.value = 0;
    const cheerBp = ctx.createBiquadFilter();
    cheerBp.type = 'bandpass';
    cheerBp.frequency.value = 1300;
    cheerBp.Q.value = 0.7;
    const wobble = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.35;
    lfo.connect(lfoAmt).connect(wobble.gain);
    lfo.start();
    this.loopNoise().connect(cheerBp).connect(wobble).connect(this.cheerGain).connect(this.sfxBus);

    this.music = new Music(ctx, this.musicBus);
    this.setVolumes({});
    this.setMusicMode(this.musicMode);
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start(0, Math.random() * 0.5);
    return src;
  }

  /**
   * Engine voice `i` (0 = the player). `rev` 0..1 (motor speed), `load` 0..1 (throttle),
   * `gain` 0..1 (distance), `pan` -1..1.
   */
  setEngine(i: number, rev: number, load: number, gain: number, pan = 0): void {
    const v = this.engines[i];
    if (!v || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 70 + 560 * rev + 40 * load;
    v.a.frequency.setTargetAtTime(f, t, 0.04);
    v.b.frequency.setTargetAtTime(f * 2.01, t, 0.04);
    v.filter.frequency.setTargetAtTime(400 + 2600 * load + 1800 * rev, t, 0.05);
    v.gain.gain.setTargetAtTime(gain * (0.035 + 0.05 * load + 0.03 * rev), t, 0.05);
    v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.05);
  }

  setSkid(amount: number): void {
    if (!this.ctx) return;
    this.skidGain.gain.setTargetAtTime(Math.min(1, amount) * 0.12, this.ctx.currentTime, 0.04);
  }

  /** A swell from the crowd. */
  cheer(strength = 1): void {
    if (!this.ctx) return;
    const g = this.cheerGain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.16 * strength, t + 0.25);
    g.setTargetAtTime(0, t + 0.6, 0.9);
  }

  /** Silence the continuous sounds (menus, pause). */
  quiet(): void {
    if (!this.ctx) return;
    for (let i = 0; i < ENGINE_VOICES; i++) this.setEngine(i, 0, 0, 0);
    this.setSkid(0);
  }

  play(name: SfxName, o: { gain?: number; pan?: number } = {}): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const g = o.gain ?? 1;
    const p = o.pan ?? 0;
    if (g < 0.01) return;
    const t = ctx.currentTime;
    switch (name) {
      case 'count':
        this.tone('square', 660, 660, 0.16, 0.22 * g, t, p);
        break;
      case 'go':
        this.tone('square', 1320, 1320, 0.45, 0.22 * g, t, p);
        this.tone('square', 990, 990, 0.45, 0.12 * g, t, p);
        break;
      case 'pickup':
        [880, 1175, 1568].forEach((f, k) => this.tone('sine', f, f, 0.09, 0.2 * g, t + k * 0.055, p));
        break;
      case 'tick':
        this.tone('triangle', 1900, 1900, 0.03, 0.07 * g, t, p);
        break;
      case 'ready':
        this.tone('sine', 1320, 1760, 0.16, 0.2 * g, t, p);
        break;
      case 'boost':
        this.noiseBurst('bandpass', 400, 3500, 1.2, 0.6, 0.35 * g, t, p);
        this.tone('sawtooth', 220, 900, 0.5, 0.06 * g, t, p);
        break;
      case 'boostPad':
        this.noiseBurst('bandpass', 900, 4200, 1.5, 0.35, 0.22 * g, t, p);
        break;
      case 'throw':
        this.tone('sine', 260, 720, 0.18, 0.25 * g, t, p);
        break;
      case 'explode':
        this.noiseBurst('lowpass', 3200, 140, 0.7, 1.0, 0.9 * g, t, p);
        this.tone('sine', 95, 38, 0.55, 0.7 * g, t, p);
        break;
      case 'oil':
        this.noiseBurst('lowpass', 900, 200, 1, 0.25, 0.45 * g, t, p);
        break;
      case 'spin':
        this.tone('sine', 1400, 280, 0.55, 0.14 * g, t, p);
        break;
      case 'zap':
        this.tone('sawtooth', 1700, 110, 0.45, 0.16 * g, t, p);
        this.noiseBurst('highpass', 3000, 6000, 0.7, 0.3, 0.18 * g, t, p);
        break;
      case 'hit':
        this.noiseBurst('bandpass', 900, 500, 1.2, 0.16, 0.5 * g, t, p);
        this.tone('sine', 130, 60, 0.12, 0.35 * g, t, p);
        break;
      case 'land':
        this.tone('sine', 120, 48, 0.16, 0.35 * g, t, p);
        this.noiseBurst('lowpass', 700, 200, 1, 0.12, 0.2 * g, t, p);
        break;
      case 'lap':
        this.tone('triangle', 880, 880, 0.12, 0.25 * g, t, p);
        this.tone('triangle', 1320, 1320, 0.22, 0.25 * g, t + 0.12, p);
        break;
      case 'finalLap':
        [880, 1109, 1320, 1760].forEach((f, k) => this.tone('triangle', f, f, 0.13, 0.24 * g, t + k * 0.11, p));
        break;
      case 'finish':
        [523, 659, 784, 1047, 784, 1047].forEach((f, k) => this.tone('square', f, f, k === 5 ? 0.6 : 0.14, 0.14 * g, t + k * 0.13, p));
        this.cheer(1.2);
        break;
      case 'goal':
        this.tone('sawtooth', 220, 220, 0.7, 0.1 * g, t, p);
        this.tone('sawtooth', 277, 277, 0.7, 0.08 * g, t, p);
        this.cheer(1);
        break;
      case 'drift':
        this.tone('sine', 988, 1480, 0.14, 0.14 * g, t, p);
        break;
      case 'click':
        this.tone('triangle', 1100, 1100, 0.035, 0.12 * g, t, p);
        break;
      case 'cone':
        this.tone('triangle', 520, 300, 0.08, 0.13 * g, t, p);
        break;
      case 'kick':
        this.tone('sine', 200, 90, 0.1, 0.3 * g, t, p);
        this.noiseBurst('bandpass', 1200, 800, 1, 0.05, 0.15 * g, t, p);
        break;
      case 'wrong':
        this.tone('square', 220, 220, 0.18, 0.12 * g, t, p);
        this.tone('square', 175, 175, 0.25, 0.12 * g, t + 0.2, p);
        break;
    }
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, t: number, pan: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.panned(pan));
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noiseBurst(type: BiquadFilterType, f0: number, f1: number, q: number, dur: number, gain: number, t: number, pan: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.panned(pan));
    src.start(t, Math.random() * 0.4);
    src.stop(t + dur + 0.02);
  }

  private panned(pan: number): AudioNode {
    if (Math.abs(pan) < 0.02) return this.sfxBus;
    const p = this.ctx!.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.sfxBus);
    return p;
  }
}

/**
 * An original 4-bar chiptune loop (Am – F – C – G, 128 BPM): triangle bass, square arpeggio and a
 * noise/sine drum kit, scheduled ahead on the audio clock.
 */
class Music {
  private timer = 0;
  private step = 0;
  private nextTime = 0;
  private readonly noise: AudioBuffer;
  private readonly stepDur = 60 / 128 / 4;
  /** Chord roots (MIDI) and chord tones per bar. */
  private readonly chords = [
    { root: 45, tones: [57, 60, 64, 69] }, // Am
    { root: 41, tones: [53, 57, 60, 65] }, // F
    { root: 48, tones: [55, 60, 64, 67] }, // C
    { root: 43, tones: [55, 59, 62, 67] }, // G
  ];
  private readonly arp = [0, 1, 2, 3, 2, 1, 2, 3, 0, 2, 1, 3, 2, 3, 1, 2];

  constructor(private readonly ctx: AudioContext, private readonly out: AudioNode) {
    this.noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.3), ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  start(): void {
    if (this.timer) return;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  private schedule(): void {
    // Tab was hidden a while: don't try to catch up on every missed step.
    if (this.nextTime < this.ctx.currentTime - 0.5) this.nextTime = this.ctx.currentTime + 0.05;
    while (this.nextTime < this.ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += this.stepDur;
      this.step = (this.step + 1) % 64;
    }
  }

  private playStep(step: number, t: number): void {
    const chord = this.chords[Math.floor(step / 16)];
    const s = step % 16;
    const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
    // Bass: eighth notes, root with an octave pop on the offbeats.
    if (s % 2 === 0) this.note('triangle', midi(chord.root + (s % 4 === 2 ? 12 : 0)), t, this.stepDur * 1.8, 0.2);
    // Arpeggio, an octave up.
    this.note('square', midi(chord.tones[this.arp[s]] + 12), t, this.stepDur * 0.9, 0.045);
    // Drums.
    if (s % 4 === 0) this.kick(t);
    if (s === 4 || s === 12) this.hat(t, 0.13, 1800, 0.18); // snare-ish
    if (s % 2 === 1) this.hat(t, 0.04, 7000, 0.05);
  }

  private note(type: OscillatorType, f: number, t: number, dur: number, gain: number): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private kick(t: number): void {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.2);
  }

  private hat(t: number, dur: number, freq: number, gain: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = freq > 4000 ? 'highpass' : 'bandpass';
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.out);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
}
