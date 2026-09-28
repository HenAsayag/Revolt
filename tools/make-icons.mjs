// Generates the home-screen / PWA icons (PNG, no dependencies): `node tools/make-icons.mjs`.
// A red toy RC car over a chequered band on a stadium-blue background.
import fs from 'fs';
import zlib from 'zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
/** Colour at unit coords (u, v) in 0..1 (v down), or null for "keep the background". */
function shade(u, v) {
  // Rounded-rectangle helper (signed distance).
  const rr = (cx, cy, hw, hh, r) => {
    const dx = Math.max(Math.abs(u - cx) - hw + r, 0), dy = Math.max(Math.abs(v - cy) - hh + r, 0);
    return Math.hypot(dx, dy) - r;
  };
  const circle = (cx, cy, r) => Math.hypot(u - cx, v - cy) - r;
  // Wheels.
  for (const [cx, cy] of [[0.3, 0.66], [0.7, 0.66]]) {
    if (circle(cx, cy, 0.115) < 0) return circle(cx, cy, 0.05) < 0 ? hex('#ffd21f') : hex('#141414');
  }
  // Body, cabin, wing.
  if (rr(0.5, 0.56, 0.3, 0.085, 0.05) < 0) return v < 0.52 ? hex('#ff4a3d') : hex('#d8262a');
  if (rr(0.47, 0.44, 0.13, 0.06, 0.03) < 0) return u > 0.44 && u < 0.56 && v < 0.46 ? hex('#9fd8ff') : hex('#d8262a');
  if (rr(0.2, 0.43, 0.05, 0.012, 0.01) < 0 || (u > 0.18 && u < 0.2 && v > 0.43 && v < 0.5)) return hex('#1c1c1c');
  // Antenna.
  if (Math.abs(u - 0.66) < 0.006 && v > 0.22 && v < 0.5) return hex('#1c1c1c');
  if (circle(0.66, 0.22, 0.018) < 0) return hex('#ff3b2e');
  // Chequered track band under the car.
  if (v > 0.78 && v < 0.9) return (Math.floor(u * 12) + Math.floor((v - 0.78) / 0.06)) % 2 ? hex("#f4f4f0") : hex("#1c1c1c");
  return null;
}

function icon(size, pad = 0) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (x + (sx + 0.5) / SS) / size, fy = (y + (sy + 0.5) / SS) / size;
          // Background: stadium-night blue gradient.
          const t = fy;
          let c = [Math.round(20 + 40 * t), Math.round(60 + 60 * t), Math.round(140 + 60 * t)];
          const u = (fx - pad) / (1 - 2 * pad), v = (fy - pad) / (1 - 2 * pad);
          if (u >= 0 && u <= 1 && v >= 0 && v <= 1) c = shade(u, v) ?? c;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (y * size + x) * 4;
      px[i] = r / (SS * SS);
      px[i + 1] = g / (SS * SS);
      px[i + 2] = b / (SS * SS);
      px[i + 3] = 255;
    }
  }
  return png(size, px);
}

fs.mkdirSync('public/icons', { recursive: true });
fs.writeFileSync('public/icons/icon-180.png', icon(180, 0.06));
fs.writeFileSync('public/icons/icon-192.png', icon(192, 0.06));
fs.writeFileSync('public/icons/icon-512.png', icon(512, 0.06));
fs.writeFileSync('public/icons/icon-maskable-512.png', icon(512, 0.16));
console.log('icons written');
