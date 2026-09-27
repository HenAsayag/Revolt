import * as THREE from 'three';

/**
 * Procedural canvas textures, cached by key. Everything here is generated at runtime so the
 * project needs no image assets; swap any of these for real textures later.
 */
const cache = new Map<string, THREE.Texture>();

function canvasTexture(
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  opts: { repeat?: [number, number]; srgb?: boolean; anisotropy?: number } = {},
): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (opts.repeat) tex.repeat.set(...opts.repeat);
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  tex.anisotropy = opts.anisotropy ?? 8;
  cache.set(key, tex);
  return tex;
}

/** Deterministic PRNG so textures look the same every load. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, n: number, seed: number, dark: string, light: string) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rnd() < 0.5 ? dark : light;
    const s = 1 + rnd() * 2.5;
    ctx.fillRect(rnd() * w, rnd() * h, s, s);
  }
}

/** Light grey poured concrete with speckle and faint expansion joints. */
export function concreteTexture(): THREE.Texture {
  return canvasTexture('concrete', 512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#b9b6ae';
    ctx.fillRect(0, 0, w, h);
    const rnd = mulberry32(7);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(${rnd() < 0.5 ? '90,88,80' : '235,232,225'},${0.04 + rnd() * 0.06})`;
      ctx.beginPath();
      ctx.arc(rnd() * w, rnd() * h, 20 + rnd() * 90, 0, Math.PI * 2);
      ctx.fill();
    }
    speckle(ctx, w, h, 9000, 11, 'rgba(70,68,62,0.25)', 'rgba(250,250,245,0.25)');
    ctx.strokeStyle = 'rgba(60,58,54,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
  });
}

/** Plywood sheet: warm base, long grain streaks, screw heads near the edges. */
export function plywoodTexture(): THREE.Texture {
  return canvasTexture('plywood', 512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#c8995b';
    ctx.fillRect(0, 0, w, h);
    const rnd = mulberry32(3);
    for (let i = 0; i < 180; i++) {
      const y = rnd() * h;
      ctx.strokeStyle = `rgba(${rnd() < 0.6 ? '120,78,35' : '235,200,140'},${0.08 + rnd() * 0.16})`;
      ctx.lineWidth = 1 + rnd() * 5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= w; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.01 + i) * 6 + (rnd() - 0.5) * 3);
      ctx.stroke();
    }
    speckle(ctx, w, h, 1500, 5, 'rgba(90,60,30,0.25)', 'rgba(255,230,180,0.2)');
    ctx.fillStyle = '#6d6a64';
    for (const [x, y] of [[24, 24], [w - 24, 24], [24, h - 24], [w - 24, h - 24], [w / 2, 24], [w / 2, h - 24]]) {
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** Knobby tyre tread, wrapped around the tyre circumference (u) and across its width (v). */
export function treadTexture(): THREE.Texture {
  return canvasTexture('tread', 256, 64, (ctx, w, h) => {
    ctx.fillStyle = '#1b1b1d';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#2d2d31';
    const n = 24;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const off = i % 2 ? 0 : h * 0.2;
      ctx.fillRect(x + 1, off + 4, w / n - 3, h * 0.28);
      ctx.fillRect(x + 1, off + h * 0.46, w / n - 3, h * 0.28);
    }
  });
}

/** Black/white chequer for the player car's roof. */
export function checkerTexture(cells = 6): THREE.Texture {
  return canvasTexture(`checker${cells}`, 256, 256, (ctx, w, h) => {
    const s = w / cells;
    for (let y = 0; y < cells; y++)
      for (let x = 0; x < cells; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
        ctx.fillRect(x * s, y * s, s, (h / cells));
      }
  });
}

/** Racing number decal: white disc with a black number. */
export function numberDecalTexture(num: number): THREE.Texture {
  return canvasTexture(`num${num}`, 128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fafafa';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.44, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 76px "Chakra Petch", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), w / 2, h / 2 + 4);
  }, { anisotropy: 4 });
}

/** Near-white grass detail, tiled a few metres; the pitch's vertex colours supply the hue. */
export function grassDetailTexture(): THREE.Texture {
  return canvasTexture('grass', 256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#e6eee0';
    ctx.fillRect(0, 0, w, h);
    const rnd = mulberry32(21);
    for (let i = 0; i < 5000; i++) {
      const x = rnd() * w, y = rnd() * h;
      const l = 150 + rnd() * 105;
      ctx.strokeStyle = `rgba(${l * 0.85 | 0},${l | 0},${l * 0.8 | 0},0.55)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 4);
      ctx.stroke();
    }
  });
}

/** Red LED/advertising board with generic text. */
export function adBoardTexture(text: string, variant = 0): THREE.Texture {
  return canvasTexture(`ad:${text}:${variant}`, 1024, 128, (ctx, w, h) => {
    const bg = ['#d3161b', '#c01016', '#e0201f'][variant % 3];
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,0.12)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = variant % 2 ? '#ffe14a' : '#ffffff';
    ctx.font = 'italic 700 78px "Chakra Petch", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(0, h - 6, w, 3);
  }, { anisotropy: 4 });
}

/** Tower facade: glass curtain wall or punched windows, with floor/mullion lines. */
export function facadeTexture(style: 'glass' | 'stone' | 'dark', seed = 1): THREE.Texture {
  return canvasTexture(`facade:${style}:${seed}`, 128, 256, (ctx, w, h) => {
    const rnd = mulberry32(seed * 97 + 5);
    const base = style === 'glass' ? '#7ea4c4' : style === 'dark' ? '#5d7088' : '#e4ddcf';
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    const floors = 16, cols = 8;
    for (let f = 0; f < floors; f++)
      for (let c = 0; c < cols; c++) {
        const x = (c / cols) * w, y = (f / floors) * h;
        if (style === 'stone') {
          ctx.fillStyle = `rgba(60,80,100,${0.55 + rnd() * 0.3})`;
          ctx.fillRect(x + 3, y + 4, w / cols - 6, h / floors - 7);
        } else {
          const l = rnd();
          ctx.fillStyle = style === 'glass' ? `rgba(${200 + l * 55 | 0},${225 + l * 30 | 0},255,${0.15 + l * 0.35})` : `rgba(140,170,200,${0.1 + l * 0.3})`;
          ctx.fillRect(x + 1, y + 1, w / cols - 2, h / floors - 2);
        }
      }
    ctx.fillStyle = style === 'stone' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.35)';
    for (let f = 0; f <= floors; f++) ctx.fillRect(0, (f / floors) * h, w, 1.5);
  }, { anisotropy: 2 });
}

/** Goal net mesh (alpha-tested). */
export function netTexture(): THREE.Texture {
  return canvasTexture('net', 128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(245,245,245,1)';
    ctx.lineWidth = 3;
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const p = (i / n) * w;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(w, p); ctx.stroke();
    }
  }, { anisotropy: 4 });
}

/** START / FINISH banner with chequered ends. */
export function startBannerTexture(): THREE.Texture {
  return canvasTexture('startBanner', 1024, 128, (ctx, w, h) => {
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, w, h);
    const s = h / 4;
    for (const x0 of [0, w - s * 4])
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
          ctx.fillRect(x0 + x * s, y * s, s, s);
        }
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 700 84px "Chakra Petch", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('START  ·  FINISH', w / 2, h / 2 + 4);
  }, { anisotropy: 4 });
}

/** Yellow chevrons for boost pads (points toward +v). */
export function boostPadTexture(): THREE.Texture {
  return canvasTexture('boostPad', 128, 256, (ctx, w, h) => {
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffd21a';
    for (let i = 0; i < 3; i++) {
      const y = h * (0.82 - i * 0.28);
      ctx.beginPath();
      ctx.moveTo(w * 0.12, y);
      ctx.lineTo(w * 0.5, y - h * 0.16);
      ctx.lineTo(w * 0.88, y);
      ctx.lineTo(w * 0.88, y - h * 0.08);
      ctx.lineTo(w * 0.5, y - h * 0.24);
      ctx.lineTo(w * 0.12, y - h * 0.08);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = '#ffd21a';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, w - 6, h - 6);
  }, { anisotropy: 8 });
}
