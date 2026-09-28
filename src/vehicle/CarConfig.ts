/**
 * All tunables for the arcade RC car, in SI units (metres, seconds, m/s, m/s², rad/s).
 *
 * Local car frame: +Z forward, +Y up, +X to the car's LEFT (so right = -X).
 * The car is toy-sized (~0.5 m long) so the stadium feels enormous.
 *
 * Handling is kart-style and fully deterministic: the game decides the heading, speed and grip
 * directly (no tyre-force simulation), physics only resolves contacts. See ArcadeCar.
 */
export interface CarConfig {
  // --- Geometry (collision capsule + visuals).
  /** Capsule radius (= ride height of the body centre) and half length of its straight part. */
  radius: number;
  halfLength: number;
  mass: number;
  wheelRadius: number;
  wheelWidth: number;
  /** Half the distance between left/right wheel centres. */
  halfTrack: number;
  frontAxleZ: number;
  rearAxleZ: number;
  /** Local Y of the suspension mounts (visual wheel travel is measured from here). */
  mountY: number;
  suspensionRest: number;

  // --- Speed.
  maxSpeed: number; // m/s, top speed on the flat
  maxReverseSpeed: number;
  /** Acceleration from standstill (m/s²); it fades toward top speed. */
  accel: number;
  brake: number; // m/s²
  /** Rolling slow-down with no throttle, m/s². */
  coast: number;

  // --- Steering.
  /** Turn rate at full lock (rad/s): at walking pace, and at top speed. */
  turnLow: number;
  turnHigh: number;
  /** Below this speed the turn rate scales down to zero (you can't pirouette on the spot). */
  turnFullSpeed: number;
  /** How fast the steering input follows the stick/keys (1/s), and returns to centre. */
  steerRise: number;
  steerFall: number;

  // --- Grip.
  /** Sideways velocity decay (1/s): normal, drifting, stunned. High = on rails. */
  grip: number;
  driftGrip: number;
  stunGrip: number;
  /** Share of the velocity that turns with the car each step (1 = pure kart, <1 = a little slide). */
  carve: number;

  // --- Drift (hold DRIFT + steer at speed): tighter turning, a slide, and a mini-turbo on release.
  driftMinSpeed: number;
  driftTurnBoost: number;
  driftBoostMinTime: number;
  driftBoostBase: number;
  driftBoostPerSecond: number;

  // --- Boost.
  boostTopSpeed: number; // multiplier
  boostAccel: number; // m/s²

  // --- Ground contact.
  /** Press-down toward the surface while on it (m/s²; replaces gravity's normal part). */
  stick: number;
  /** Extra pull back to the surface when it's just below the wheels (bumps, steps). */
  snap: number;
  gravity: number;
  /** Steering authority in the air (rad/s). */
  airTurn: number;
}

export const DEFAULT_CAR: CarConfig = {
  radius: 0.13,
  halfLength: 0.12,
  mass: 3.0,
  wheelRadius: 0.078,
  wheelWidth: 0.07,
  halfTrack: 0.155,
  frontAxleZ: 0.165,
  rearAxleZ: -0.165,
  mountY: -0.01,
  suspensionRest: 0.1,

  maxSpeed: 15.5, // ≈ 35 mph
  maxReverseSpeed: 5,
  accel: 13,
  brake: 24,
  coast: 2.2,

  turnLow: 2.7,
  turnHigh: 1.45,
  turnFullSpeed: 3.5,
  steerRise: 7,
  steerFall: 11,

  grip: 12,
  driftGrip: 2.2,
  stunGrip: 1.2,
  carve: 0.94,

  driftMinSpeed: 6,
  driftTurnBoost: 1.3,
  driftBoostMinTime: 0.6,
  driftBoostBase: 0.35,
  driftBoostPerSecond: 0.45,

  boostTopSpeed: 1.35,
  boostAccel: 22,

  stick: 18,
  snap: 14,
  gravity: 9.81,
  airTurn: 1.2,
};
