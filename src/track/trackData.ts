/**
 * THE TRACK — edit here.
 *
 * `CONTROL_POINTS` is a closed Catmull-Rom spline through the listed points (world metres,
 * y defaults to 0, width defaults to DEFAULT_WIDTH). Driving direction = list order. Points
 * flagged `loop` form the loop-the-loop (built as an orange wooden loop, with extra grip).
 * Features are placed by world position ([x, z] or [x, y, z]); they snap to the nearest point
 * on the spline, so moving the spline drags them along.
 *
 * Route (stadium frame: pitch along X, West main stand at z < 0, East stand at z > 0):
 *  1. Start along the west touchline, in front of the main stand and the dugouts, heading north (+X). Kicker.
 *  2. Fast sweep into the north penalty box — footballs on the line; knock them into the goal.
 *  3. Right hairpin, then up a plywood ramp over the East stand seats, a hairpin deck under the
 *     gallery, and down into a real aisle: hop down the concrete steps beside the handrail.
 *  4. Kicker at the bottom flies you over the front wall and the ad boards back onto the pitch.
 *  5. Boost pad, then the giant orange loop on the halfway line.
 *  6. Slalom along the south half, U-turn in front of the south goal, back to the start.
 */

export interface TrackControlPoint {
  x: number;
  z: number;
  y?: number;
  width?: number;
  /** Bank angle, radians; + tilts the right edge down (for right-hand turns). */
  bank?: number;
  loop?: boolean;
}

export const DEFAULT_WIDTH = 2.8;

type XZ = [number, number];
type XYZ = [number, number, number];

export type TrackFeature =
  | { type: 'start'; at: XZ }
  | { type: 'kicker'; at: XZ; height: number; length: number }
  /** Free-standing plywood wedge between two points (low end → high end). */
  | { type: 'ramp'; from: XYZ; to: XYZ; width: number; base: number }
  /** Elevated plywood track with curbs and support posts, following the spline. */
  | { type: 'deck'; from: XZ; to: XZ }
  /**
   * Invisible slab only cars collide with. Laid along the stair noses it gives a clean running
   * surface (real step edges under a raycast wheel flip the car); pair it with 'stairBumps'.
   */
  | { type: 'glide'; from: XYZ; to: XYZ; width: number }
  /** Each axle gets a hop every `pitch` metres along from→to: the feel of bouncing down steps. */
  | { type: 'stairBumps'; from: XZ; to: XZ; pitch: number; strength: number }
  /** Invisible walls either side of the centre line (e.g. down an aisle between seats). */
  | { type: 'walls'; from: XZ; to: XZ; offset: number; height: number }
  | { type: 'boost'; at: XZ }
  /** Footballs on the racing line; knocked ones are steered toward `goal`. */
  | { type: 'footballs'; at: XZ[]; goal: XZ }
  /** Cones inside the track, alternating either side of the centre line. */
  | { type: 'slalom'; from: XZ; to: XZ; spacing: number; offset: number }
  /** A row of cones at a fixed lateral offset (+ = right of travel, metres from centre). */
  | { type: 'coneRow'; from: XZ; to: XZ; spacing: number; offset: number }
  /** No water barriers between from/to on the given side. */
  | { type: 'barrierGap'; from: XZ; to: XZ; side: 'left' | 'right' | 'both' }
  /** Named stretch (used by the game for per-section behaviour). */
  | { type: 'zone'; name: string; from: XZ; to: XZ };

/** East stand geometry (from the model): rows 0.75 m deep, 0.43 m high, row 0 at z 40.13, y 1.15. */
const stepNose = (z: number) => 1.58 + 0.573 * (z - 40.13);

/**
 * Curved kicker from the stair nose line (descending toward -z at the step slope) up to a lip
 * at z1 rising at +15°: y = y0 - 0.573u + a·u², u = distance travelled.
 */
function kickerCurve(x: number, z0: number, z1: number, width: number): TrackControlPoint[] {
  const L = z0 - z1;
  const a = (0.27 + 0.573) / (2 * L);
  const y0 = stepNose(z0) + 0.04;
  return [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const u = f * L;
    return { x, z: z0 - u, y: y0 - 0.573 * u + a * u * u, width };
  });
}

/** Loop-the-loop control points: vertical circle of radius r starting at `base`, drifting `shift` metres to the right. */
function loopPoints(base: XZ, heading: XZ, r: number, shift: number, width: number): TrackControlPoint[] {
  const [fx, fz] = heading;
  const rx = -fz, rz = fx; // right of travel (car convention: right = forward × up)
  const pts: TrackControlPoint[] = [];
  for (let k = 0; k <= 12; k++) {
    const th = (k / 12) * Math.PI * 2;
    const f = r * Math.sin(th), lat = (shift * k) / 12;
    pts.push({ x: base[0] + fx * f + rx * lat, z: base[1] + fz * f + rz * lat, y: r * (1 - Math.cos(th)), width, loop: true });
  }
  return pts;
}

// Straddles the west touchline: the team dugouts in front of the main stand reach z = -37.
const WEST_STRIP = -33.2;
const LANE_X = 12.64; // east lane of the aisle at x = 12 (handrail on its centre line)
const LOOP_X = -1.2;

export const CONTROL_POINTS: TrackControlPoint[] = [
  // 1. West strip, heading +X.
  { x: -32, z: WEST_STRIP },
  { x: -24, z: WEST_STRIP },
  { x: -14, z: WEST_STRIP },
  { x: -4, z: WEST_STRIP },
  { x: 8, z: WEST_STRIP },
  { x: 20, z: WEST_STRIP },
  { x: 28, z: WEST_STRIP },
  // Sweep right (R 14) into the north penalty box.
  { x: 33.36, z: -32.13 },
  { x: 37.9, z: -29.1 },
  { x: 40.93, z: -24.56 },
  { x: 42, z: -19.2 },
  // 2. North run, heading +Z past the goal.
  { x: 42, z: -14 },
  { x: 42, z: -5 },
  { x: 42, z: 4 },
  { x: 42, z: 12 },
  // Right turn (R 12) to head back south along the east side.
  { x: 41.09, z: 16.59 },
  { x: 38.49, z: 20.49 },
  { x: 34.59, z: 23.09 },
  { x: 30, z: 24 },
  { x: 27, z: 24 },
  // Left (R 5) into the climb.
  { x: 24.5, z: 24.67 },
  { x: 22.67, z: 26.5 },
  { x: 22, z: 29.5 },
  // 3. Plywood ramp up over the East stand (parallel to the steps, ~30°). It starts flush with the
  // grass and bends up over ~4 m so the suspension isn't slammed at the foot.
  { x: 22, z: 32.4 },
  { x: 22, z: 34.4, y: 0, width: 2.9 }, // flared mouth
  { x: 22, z: 35.8, y: 0.2, width: 2.6 },
  { x: 22, z: 37.2, y: 0.78, width: 2.3 },
  { x: 22, z: 38.8, y: 1.7, width: 2.0 }, // over the ad boards
  { x: 22, z: 41.5, y: 3.3, width: 1.8 }, // over the front glass guard (2.2 m at z = 40)
  { x: 22, z: 45.0, y: 5.3, width: 1.7 },
  // Banked hairpin (R 4.7) over the top rows, riding ~0.95 m above the step noses so it clears the
  // seats, peaking just under the gallery front. It comes round into the aisle's east lane.
  { x: 22.0, z: 48.4, y: 7.3, width: 1.6, bank: 0.12 },
  { x: 21.37, z: 50.74, y: stepNose(50.74) + 0.95, width: 1.6, bank: 0.25 },
  { x: 19.66, z: 52.45, y: stepNose(52.45) + 0.95, width: 1.6, bank: 0.25 },
  { x: 17.32, z: 53.08, y: stepNose(53.08) + 0.95, width: 1.6, bank: 0.25 },
  { x: 14.98, z: 52.45, y: stepNose(52.45) + 0.95, width: 1.6, bank: 0.25 },
  { x: 13.27, z: 50.74, y: stepNose(50.74) + 0.95, width: 1.3, bank: 0.12 },
  // Out of the hairpin the plywood tips over and runs down onto the steps (no edge to fall off).
  { x: LANE_X, z: 48.4, y: 7.2, width: 0.9 },
  { x: LANE_X, z: 47.6, y: 6.25, width: 0.9 },
  { x: LANE_X, z: 46.9, y: stepNose(46.9) + 0.02, width: 0.9 },
  // Hop down the concrete steps. The lane is narrow (0.9 m) so the car can't slew sideways.
  { x: LANE_X, z: 45.6, y: stepNose(45.6) + 0.02, width: 0.9 },
  // 4. Ski-jump kicker on posts over the bottom rows: picks up the step slope and curves up to a
  // +15° lip 3.3 m up, flying you over the front glass and the ad boards onto the grass.
  ...kickerCurve(LANE_X, 44.2, 40.05, 0.9),
  { x: LANE_X, z: 36.5, y: 3.25 },
  { x: LANE_X, z: 32.0, y: 1.7 },
  { x: LANE_X, z: 28.0, y: 0 },
  { x: LANE_X, z: 24.5 },
  // 5. Swing over to the halfway line and the loop.
  { x: 10, z: 18 },
  { x: 4, z: 13.5 },
  { x: 0, z: 9 },
  { x: LOOP_X, z: 5 },
  ...loopPoints([LOOP_X, 1.5], [0, -1], 3.2, 2.4, 2.0),
  { x: LOOP_X + 2.4, z: -2.5 },
  { x: LOOP_X + 2.4, z: -8 },
  // Left (R 12) onto the south run.
  { x: 0.29, z: -12.59 },
  { x: -2.31, z: -16.49 },
  { x: -6.21, z: -19.09 },
  { x: -10.8, z: -20 },
  // 6. South run, heading -X.
  { x: -18, z: -20 },
  { x: -26, z: -20 },
  { x: -34, z: -20 },
  { x: -38, z: -20 },
  // U-turn (R 6.6) in front of the south goal, back onto the West strip.
  { x: -41.3, z: -20.88 },
  { x: -43.72, z: -23.3 },
  { x: -44.6, z: -26.6 },
  { x: -43.72, z: -29.9 },
  { x: -41.3, z: -32.32 },
  { x: -38, z: WEST_STRIP },
];

export const FEATURES: TrackFeature[] = [
  { type: 'start', at: [-20, WEST_STRIP] },

  { type: 'kicker', at: [4, WEST_STRIP], height: 0.3, length: 1.1 },

  // North box: footballs on the line; the barrier on the goal side is open so they can go in.
  { type: 'footballs', at: [[42, -7], [42.1, -2.5], [41.9, 2], [42, 6.5]], goal: [52.5, 0] },
  { type: 'barrierGap', from: [42, -9], to: [42, 9], side: 'left' },
  { type: 'boost', at: [42, -17] },

  // East stand: boost before the climb; the ramp and deck are plywood; walls down the aisle.
  { type: 'boost', at: [22, 31] },
  { type: 'deck', from: [22, 34.4], to: [LANE_X, 46.9] },
  // Walls run on into the kicker (whose own curbs taper in at its start).
  { type: 'walls', from: [LANE_X, 47.1], to: [LANE_X, 41.6], offset: 0.45, height: 1.3 },
  { type: 'glide', from: [LANE_X, stepNose(47.1) + 0.02, 47.1], to: [LANE_X, stepNose(44.2) + 0.04, 44.2], width: 0.9 },
  { type: 'stairBumps', from: [LANE_X, 46.85], to: [LANE_X, 44.3], pitch: 0.75, strength: 0.9 },
  { type: 'deck', from: [LANE_X, 44.2], to: [LANE_X, 40.05] },
  { type: 'barrierGap', from: [22, 33.6], to: [LANE_X, 29.0], side: 'both' },
  { type: 'zone', name: 'stands', from: [22, 34.4], to: [LANE_X, 40.05] },

  // Loop.
  { type: 'boost', at: [2.2, 11.6] },
  { type: 'barrierGap', from: [LOOP_X, 3.6], to: [LOOP_X + 2.4, -1.2], side: 'both' },

  // South run slalom and decoration.
  { type: 'slalom', from: [-15, -20], to: [-35, -20], spacing: 5, offset: 0.12 },
  { type: 'boost', at: [-4, WEST_STRIP] },
  { type: 'coneRow', from: [-12, -20], to: [-36, -20], spacing: 6, offset: 2.4 },
  { type: 'coneRow', from: [42, -20], to: [42, 12], spacing: 6, offset: 2.4 },
  { type: 'coneRow', from: [-43.6, -23.4], to: [-43.6, -29.8], spacing: 1.6, offset: 1.1 },
];
