/**
 * STADIUM TOUR — a wider lap that lives in the stands as much as on the pitch.
 *
 * Same conventions as trackData.ts (closed spline in driving order, world metres, features by
 * world position). Heights over the stands were surveyed with raycasts against the model's
 * collision mesh: seat treads + aisle handrails stay ≥ 0.4 m under every deck.
 *
 *  1. Grid on a plywood deck high in the SOUTH stand (y 7.9), heading toward the main stand;
 *     a bollard slalom right after the line.
 *  2. Right-hander at the end of the stand and a plunge down a ramp over the seats onto the pitch.
 *  3. Across the pitch past a sweeper arm to the big orange loop on the centre line, then a
 *     second sweeper.
 *  4. A muddy sweep into the north run past the goal — footballs on the line.
 *  5. Climbing right-hander up into the EAST stand.
 *  6. The balcony: ~90 m of deck over the East stand crowd, gently weaving — with a gap jump.
 *  7. Through the south-east corner over the seats and back onto the South stand deck.
 */
import type { TrackControlPoint, TrackFeature } from './trackData';

export const TOUR_WIDTH = 4.4;
const DECK_W = 3.2;
const LOOP_W = 2.6;

/** Deck heights (m): south stand, the corner, the East stand balcony. */
const SOUTH_Y = 7.9;
const BAL_Y = 7.4;
const SOUTH_X = -65.5;
const BAL_Z = 47;

type XZ = [number, number];

function loopPoints(base: XZ, heading: XZ, r: number, shift: number, width: number): TrackControlPoint[] {
  const [fx, fz] = heading;
  const rx = -fz, rz = fx;
  const pts: TrackControlPoint[] = [];
  for (let k = 0; k <= 12; k++) {
    const th = (k / 12) * Math.PI * 2;
    const f = r * Math.sin(th), lat = (shift * k) / 12;
    pts.push({ x: base[0] + fx * f + rx * lat, z: base[1] + fz * f + rz * lat, y: r * (1 - Math.cos(th)), width, loop: true });
  }
  return pts;
}

/** Quarter-ish arc of control points (deg a0 → a1 about centre, radius r), with heights y0 → y1. */
function arc(cx: number, cz: number, r: number, a0: number, a1: number, n: number, y0: number, y1: number, width: number, bank = 0): TrackControlPoint[] {
  const pts: TrackControlPoint[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const a = ((a0 + (a1 - a0) * t) * Math.PI) / 180;
    pts.push({ x: cx + r * Math.cos(a), z: cz + r * Math.sin(a), y: y0 + (y1 - y0) * t, width, bank });
  }
  return pts;
}

/** 0 → 1 with zero slope at both ends (no kink at the foot, no launch ramp at the crest). */
const smooth = (u: number) => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
};

/**
 * The South-stand plunge: straight along z = -18 from the deck (x = -58.5, y = SOUTH_Y) down onto
 * the pitch at x = -32.5, following a smoothstep profile (max ≈ 24°, crest radius ≈ 14 m).
 */
function plunge(): TrackControlPoint[] {
  const x0 = -58.5, x1 = -32.5, D = x1 - x0;
  const pts: TrackControlPoint[] = [];
  for (let d = 0; d <= D + 1e-6; d += 2) {
    const u = d / D;
    const y = Math.max(0.015, SOUTH_Y * (1 - smooth(u)));
    // Widen out toward the pitch.
    const width = u < 0.55 ? DECK_W : DECK_W + (TOUR_WIDTH - DECK_W) * smooth((u - 0.55) / 0.45);
    pts.push({ x: x0 + d, z: -18, y, width });
  }
  return pts;
}

/**
 * The East-stand climb: straight up x = 41.2 from the ramp mouth (z = 26) for 9 m, then a
 * right-hand arc (R 12, centre (29.2, 35)) onto the balcony at (29.2, 47). Height follows a
 * smoothstep over the first 25 m (max ≈ 24°), so the crest is spread along the arc.
 */
function climb(): TrackControlPoint[] {
  const D = 25, straight = 9, R = 12;
  const pts: TrackControlPoint[] = [];
  const yAt = (d: number) => Math.max(0.015, BAL_Y * smooth(d / D));
  for (const d of [0, 2.25, 4.5, 6.75]) {
    pts.push({ x: 41.2, z: 26 + d, y: yAt(d), width: 4.0 - (0.5 * d) / 6.75 });
  }
  for (let deg = 0; deg <= 75 + 1e-6; deg += 12.5) {
    const a = (deg * Math.PI) / 180;
    const d = straight + R * a;
    pts.push({ x: 29.2 + R * Math.cos(a), z: 35 + R * Math.sin(a), y: yAt(d), width: 3.5, bank: 0.16 * Math.sin(Math.PI * (deg / 90)) });
  }
  return pts;
}

const LOOP_BASE: XZ = [1, -8.5];

export const TOUR_POINTS: TrackControlPoint[] = [
  // 1. South stand deck, heading -z (the start line is at z = +2).
  { x: SOUTH_X, z: 27, y: SOUTH_Y, width: DECK_W },
  { x: SOUTH_X, z: 19, y: SOUTH_Y, width: DECK_W },
  { x: SOUTH_X, z: 12, y: SOUTH_Y, width: DECK_W },
  { x: SOUTH_X, z: 2, y: SOUTH_Y, width: DECK_W },
  { x: SOUTH_X, z: -8, y: SOUTH_Y, width: DECK_W },
  { x: SOUTH_X, z: -13, y: SOUTH_Y, width: DECK_W },
  // 2. Right-hander (R 5) toward the pitch, then the plunge down over the seats.
  ...arc(SOUTH_X + 5, -13, 5, 180, 270, 3, SOUTH_Y, SOUTH_Y, DECK_W, 0.1).slice(1),
  ...plunge(),
  // 3. Across the pitch to the loop.
  { x: -26, z: -16.2 },
  { x: -20, z: -12.6 },
  { x: -16, z: -9.8 },
  { x: -8, z: -8.5 },
  { x: -3, z: -8.5, width: 3.4 },
  ...loopPoints(LOOP_BASE, [1, 0], 3.2, 2.6, LOOP_W),
  { x: LOOP_BASE[0] + 4, z: LOOP_BASE[1] + 2.6, width: 3.4 },
  { x: 10, z: -5.9 },
  { x: 18, z: -6.4 },
  { x: 26, z: -8.6 },
  { x: 32, z: -9.4 },
  // 4. Right sweep (R 9) into the north run, heading +z past the goal.
  ...arc(32, -0.4, 9, 270, 360, 3, 0, 0, TOUR_WIDTH).slice(1),
  { x: 41.2, z: 6 },
  { x: 41.2, z: 14 },
  { x: 41.2, z: 21 },
  // 5. Climb into the East stand: a short straight ramp, then a wide right-hand arc (R 12) that
  // keeps rising gently as it swings onto the balcony — the crest is spread over the whole arc.
  ...climb(),
  // 6. The balcony, heading -x, weaving gently between the rows.
  { x: 29.2, z: BAL_Z, y: BAL_Y, width: DECK_W },
  { x: 20, z: BAL_Z - 0.55, y: BAL_Y, width: DECK_W },
  { x: 8, z: BAL_Z + 0.55, y: BAL_Y, width: DECK_W },
  { x: -4, z: BAL_Z - 0.55, y: BAL_Y, width: DECK_W },
  { x: -16, z: BAL_Z + 0.55, y: BAL_Y, width: DECK_W },
  { x: -28, z: BAL_Z - 0.4, y: BAL_Y, width: DECK_W },
  { x: -40, z: BAL_Z, y: BAL_Y, width: DECK_W },
  // 7. Through the south-east corner (R 14, over the seats) onto the South stand.
  ...arc(-51.5, 33, 14, 90, 180, 6, BAL_Y, SOUTH_Y, 3.5, 0.1),
];

/** Deck spans (world [x, z]): everything above the stands. */
const DECK_A: XZ = [41.2, 26];
const DECK_B: XZ = [-32.5, -18];

export const TOUR_FEATURES: TrackFeature[] = [
  { type: 'start', at: [SOUTH_X, 2] },

  // The deck runs from the East ramp foot, round the balcony, the corner and the South stand,
  // down to the foot of the plunge. Decks have their own curbs: no water barriers there.
  { type: 'deck', from: DECK_A, to: DECK_B },
  { type: 'barrierGap', from: [41.2, 25], to: [-31.5, -18], side: 'both' },

  // Pitch.
  { type: 'boost', at: [-9, -8.5] },
  { type: 'barrierGap', from: [LOOP_BASE[0] - 1, LOOP_BASE[1]], to: [LOOP_BASE[0] + 3.8, LOOP_BASE[1] + 2.6], side: 'both' },
  // Hazards (the Tour's hard mode): two sweeper arms on the pitch — time your run past them.
  { type: 'sweeper', at: [-14, -10.2], speed: 1.25 },
  { type: 'sweeper', at: [18, -6.4], speed: -1.5, phase: 1.2 },
  // Mud on the north sweep: the car slides wide unless you lift.
  { type: 'mud', from: [34.5, -8.9], to: [41.2, 3], grip: 0.3 },
  { type: 'footballs', at: [[41.2, 3.5], [41.4, 8], [41, 12.5]], goal: [52.5, 0] },
  { type: 'barrierGap', from: [41.2, 1], to: [41.2, 15], side: 'left' },
  // Balcony: a boost, then a kicker and a 2.8 m gap in the deck, 7 m above the seats.
  { type: 'boost', at: [2, BAL_Z] },
  { type: 'kicker', at: [-5.9, BAL_Z - 0.15], height: 0.28, length: 1.2 },
  { type: 'gap', from: [-7.35, BAL_Z - 0.1], to: [-10.1, BAL_Z + 0.05] },
  // South stand: a bollard slalom straight after the start line.
  { type: 'bollards', from: [SOUTH_X, -1.5], to: [SOUTH_X, -10], spacing: 4.2, offset: 0.8 },
];

/** Item box rows (world [x, z]): flat, wide places. */
export const TOUR_PICKUPS: XZ[] = [[-20, -11.6], [16, -6.3], [41.2, 15.5], [-22, BAL_Z - 0.2], [SOUTH_X, 18]];
