/**
 * STAIR RUN — the race starts at the top of a staircase built into the East stand.
 *
 * Same conventions as trackData.ts. Heights over the East stand come from raycasts against the
 * model: rows 0.43 m high and 0.75 m deep, top row tread 8.03 m at z 53–53.75, the front guard
 * 2.2 m at z = 40, aisle handrails up to 9.7 m at the top rows. Everything in the stand (climb,
 * hairpin, staircase) sits between the aisles at x = 12 and x = 24 so nothing crosses a handrail;
 * the seats under it are removed (see STAIR_CLEAR_SEATS).
 *
 *  1. The grid waits in a hairpin at the top of the stand (y 8.3); the start line is the top step.
 *  2. Down 47 concrete steps at 30° — over the front guard and the ad boards — onto the pitch.
 *  3. A long diagonal sweep across the field, a wide U-turn by the south goal.
 *  4. Back along the main stand: boost, the orange loop.
 *  5. Right-hander into the north run past the goal (footballs on the line).
 *  6. A long climb up the East stand and the hairpin over the top rows back to the stairs.
 */
import type { TrackControlPoint, TrackFeature } from './trackData';

export const STAIR_WIDTH = 4.4;
const DECK_W = 3.2;
const STAIR_W = 3.0;
const LOOP_W = 2.6;

type XZ = [number, number];
type XYZ = [number, number, number];

/** Staircase: x, top-of-stairs z / height, 30° (the stand's own pitch). */
const STAIR_X = 15.5;
const TOP_Z = 49.3;
const TOP_Y = 8.3;
const SLOPE = 0.573;
const BOTTOM_Z = TOP_Z - (TOP_Y - 0.015) / SLOPE; // ≈ 35.8, where the nose line meets the grass
const noseY = (z: number) => TOP_Y - SLOPE * (TOP_Z - z);
/** The climb up the stand, and the hairpin (R 3) joining it to the stairs. */
const CLIMB_X = 21.5;
const PIN_R = (CLIMB_X - STAIR_X) / 2;
/** The north run on the pitch. */
const NORTH_X = 40;

const smooth = (u: number) => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
};

function arc(cx: number, cz: number, r: number, a0: number, a1: number, n: number, y: (t: number) => number, width?: number, bank = 0): TrackControlPoint[] {
  const pts: TrackControlPoint[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const a = ((a0 + (a1 - a0) * t) * Math.PI) / 180;
    pts.push({ x: cx + r * Math.cos(a), z: cz + r * Math.sin(a), y: y(t), width, bank });
  }
  return pts;
}

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

/**
 * The climb: straight up x = CLIMB_X from the grass (z = 18) to the top (z = TOP_Z), height on a
 * smoothstep that's done 2.3 m before the top (max ≈ 23°), so the crest is gentle.
 */
function climb(): TrackControlPoint[] {
  const z0 = 18, D = TOP_Z - 2.3 - z0;
  const yAt = (d: number) => Math.max(0.015, TOP_Y * smooth(d / D));
  const pts: TrackControlPoint[] = [];
  for (const d of [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 29.5]) pts.push({ x: CLIMB_X, z: z0 + d, y: yAt(d), width: d < 4 ? 4.0 - d * 0.2 : DECK_W });
  return pts;
}

const LOOP_BASE: XZ = [-3, -28];

export const STAIR_POINTS: TrackControlPoint[] = [
  // 1. The hairpin over the top rows (right-hand, R 3) from the top of the climb onto the top step.
  ...arc(CLIMB_X - PIN_R, TOP_Z, PIN_R, 0, 180, 6, () => TOP_Y, DECK_W, 0.08),
  // 2. Down the stairs (on their nose line), onto the grass.
  { x: STAIR_X, z: 47.5, y: noseY(47.5), width: STAIR_W },
  { x: STAIR_X, z: 44, y: noseY(44), width: STAIR_W },
  { x: STAIR_X, z: 40.5, y: noseY(40.5), width: STAIR_W },
  { x: STAIR_X, z: 37.5, y: noseY(37.5), width: STAIR_W },
  { x: STAIR_X, z: BOTTOM_Z, y: 0.015, width: 3.6 },
  // 3. A long diagonal sweep across the pitch, then the U-turn (R 11.25) by the south goal.
  { x: STAIR_X, z: 31 },
  { x: 14, z: 24 },
  { x: 9, z: 16 },
  { x: 0, z: 9 },
  { x: -12, z: 3.5 },
  { x: -26, z: -1.5 },
  ...arc(-38, -16.75, 11.25, 90, 270, 6, () => 0, STAIR_WIDTH, 0),
  // 4. Along the main stand, heading +x: the loop.
  { x: -28, z: -28 },
  { x: -18, z: -28 },
  { x: -9, z: -28 },
  { x: -6, z: -28, width: 3.4 },
  ...loopPoints(LOOP_BASE, [1, 0], 3.2, 2.6, LOOP_W),
  { x: LOOP_BASE[0] + 4, z: LOOP_BASE[1] + 2.6, width: 3.4 },
  { x: 10, z: -25.4 },
  { x: 20, z: -25.5 },
  // 5. Right-hander (R 11.5) into the north run past the goal, then an S over to the climb.
  ...arc(28.5, -13, 11.5, 270, 360, 3, () => 0, STAIR_WIDTH, 0),
  { x: NORTH_X, z: -4 },
  { x: NORTH_X, z: 2 },
  { x: 37.5, z: 7 },
  { x: 31, z: 10.5 },
  { x: 25.5, z: 13 },
  { x: 22.3, z: 15.8 },
  // 6. The climb up the East stand.
  ...climb(),
];

const STAIR_TOP: XYZ = [STAIR_X, TOP_Y, TOP_Z];
const STAIR_BOTTOM: XYZ = [STAIR_X, 0.015, BOTTOM_Z];

export const STAIR_FEATURES: TrackFeature[] = [
  // The start line is the top step: the front row looks straight down the stairs.
  { type: 'start', at: [STAIR_X, TOP_Z - 0.2] },

  // Plywood from the foot of the climb, up the stand and round the hairpin to the top of the stairs.
  { type: 'deck', from: [CLIMB_X, 18], to: [STAIR_X, TOP_Z] },
  { type: 'stairway', from: STAIR_TOP, to: STAIR_BOTTOM, width: STAIR_W, steps: 47, hopPitch: 0.62, hopStrength: 1.5 },
  { type: 'barrierGap', from: [CLIMB_X, 17], to: [STAIR_X, BOTTOM_Z + 0.5], side: 'both' },
  { type: 'zone', name: 'landing', from: [CLIMB_X, TOP_Z - 3], to: [STAIR_X, TOP_Z] },
  { type: 'zone', name: 'stairs', from: [STAIR_X, TOP_Z], to: [STAIR_X, BOTTOM_Z + 1] },

  // Pitch.
  { type: 'sweeper', at: [-12, 3.5], speed: 0.9 },
  { type: 'boost', at: [-12, -28] },
  { type: 'barrierGap', from: [LOOP_BASE[0] - 1, LOOP_BASE[1]], to: [LOOP_BASE[0] + 3.8, LOOP_BASE[1] + 2.6], side: 'both' },
  { type: 'footballs', at: [[NORTH_X, -3], [NORTH_X + 0.2, 1], [NORTH_X - 0.2, 5]], goal: [52.5, 0] },
  { type: 'barrierGap', from: [NORTH_X, -6], to: [NORTH_X, 7], side: 'left' },
  { type: 'boost', at: [CLIMB_X, 15.5] },
];

/** Item box rows (world [x, z]). */
export const STAIR_PICKUPS: XZ[] = [[9, 16], [-24, -28], [14, -25.4], [NORTH_X, -8]];

/** Seats removed under the staircase, the top-row deck and the climb's arc. */
export const STAIR_CLEAR_SEATS: [number, number, number, number][] = [
  [STAIR_X - 1.75, 34, STAIR_X + 1.75, 54.2],
  [STAIR_X - 1.8, 46, CLIMB_X + 1.9, 54.2],
  [CLIMB_X - 1.9, 38, CLIMB_X + 1.9, 54.2],
];
