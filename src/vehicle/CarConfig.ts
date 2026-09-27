/**
 * All tunables for the raycast RC car, in SI units (metres, kg, seconds, newtons).
 *
 * Local car frame: +Z forward, +Y up, +X to the car's LEFT (so right = -X).
 * The car is toy-sized (~0.5 m long) so the stadium feels enormous.
 */
export interface CarConfig {
  /** Chassis collider half-extents. */
  chassisHalf: { x: number; y: number; z: number };
  mass: number;
  /** Centre of mass offset in local space (lower = harder to flip). */
  comOffset: { x: number; y: number; z: number };
  /** Multiplier on the box inertia; >1 makes the car rotate more lazily. */
  inertiaScale: number;

  wheelRadius: number;
  wheelWidth: number;
  /** Half the distance between left/right wheel centres. */
  halfTrack: number;
  /** Local Z of the front / rear axles. */
  frontAxleZ: number;
  rearAxleZ: number;
  /** Local Y where suspension rays start. */
  mountY: number;

  suspensionRest: number;
  springK: number;
  damperCompression: number;
  damperRebound: number;
  /** Extra stiffness applied in the last part of the travel so hard landings don't bottom out as hard. */
  bumpStopK: number;
  bumpStopStart: number; // fraction of travel
  /** Fraction of bump-stop force kept while the suspension extends (energy loss on landings). */
  bumpStopReturn: number;
  maxSuspensionForce: number;
  /** Damper input is clamped to this compression speed, m/s. */
  damperMaxVel: number;
  /** Same for extension; higher so rebound damping can absorb hard landings. */
  damperMaxReboundVel: number;

  /** Friction coefficient (force limit = mu * load). */
  gripFront: number;
  gripRear: number;
  /** 0..1 — how much of the lateral slip velocity each wheel tries to cancel per step. */
  lateralStiffness: number;
  /** Minimum fraction (squared) of grip kept for drive/brake when lateral grip is saturated. */
  longGripReserve: number;
  handbrakeRearGrip: number; // multiplier on rear grip while handbraking
  /** Drift catch after handbrake release: slip angle (rad) where it starts, gain, yaw damping, max rad/s². */
  slipAssistStart: number;
  slipAssist: number;
  slipAssistDamp: number;
  slipAssistMax: number;
  /** How far above the contact point tyre forces are applied (reduces body roll / tripping). */
  tireForceLift: number;

  maxSpeed: number; // m/s forward
  maxReverseSpeed: number;
  driveForce: number; // total, N, split over driven wheels
  brakeForce: number; // total, N
  handbrakeForce: number; // total on rear, N
  coastDrag: number; // N per m/s per wheel
  airDrag: number; // N per (m/s)^2
  downforce: number; // N per (m/s)^2 while grounded

  maxSteerLow: number; // radians at standstill
  maxSteerHigh: number; // radians, floor at top speed
  /** Slip angle added on top of the grip-limited steer angle. */
  steerSlipAngle: number;
  steerSpeed: number; // rad/s the steering rack moves
  steerReturnSpeed: number;

  /** Boost: drive-force multiplier and top-speed multiplier while boosting. */
  boostDrive: number;
  boostTopSpeed: number;
  /** Drift boost: minimum drift (s), base boost (s), extra boost per drift second. */
  driftBoostMinTime: number;
  driftBoostBase: number;
  driftBoostPerSecond: number;
  /** Air attitude assist (PD gains on pitch/roll angles, rad & rad/s). */
  airKp: number;
  airKd: number;
  airMaxAccel: number; // rad/s^2
  /** 0..1 — how much the nose follows the flight path (1 = like a dart). */
  airFollowTrajectory: number;
  /** Max pitch/roll the player can dial in while airborne, radians. */
  airPitchBias: number;
  airRollBias: number;
  airYawAccel: number; // rad/s^2 from steering
  airAngularDamping: number;
  groundAngularDamping: number;
}

export const DEFAULT_CAR: CarConfig = {
  chassisHalf: { x: 0.12, y: 0.045, z: 0.23 },
  mass: 3.0,
  comOffset: { x: 0, y: -0.035, z: -0.01 },
  inertiaScale: 1.6,

  wheelRadius: 0.078,
  wheelWidth: 0.07,
  halfTrack: 0.155,
  frontAxleZ: 0.165,
  rearAxleZ: -0.165,
  mountY: -0.01,

  suspensionRest: 0.1,
  springK: 190,
  damperCompression: 7.5,
  damperRebound: 17,
  bumpStopK: 1600,
  bumpStopStart: 0.72,
  bumpStopReturn: 0.3,
  maxSuspensionForce: 110,
  damperMaxVel: 1.2,
  damperMaxReboundVel: 5,

  gripFront: 1.35,
  gripRear: 1.3,
  lateralStiffness: 0.45,
  longGripReserve: 0.35,
  handbrakeRearGrip: 0.62,
  tireForceLift: 0.07,
  slipAssistStart: 0.12,
  slipAssist: 14,
  slipAssistDamp: 4,
  slipAssistMax: 30,

  maxSpeed: 20.5, // asymptote; drag caps it near 18 m/s ≈ 41 mph
  maxReverseSpeed: 6,
  driveForce: 34,
  brakeForce: 42,
  handbrakeForce: 6,
  coastDrag: 0.08,
  airDrag: 0.012,
  downforce: 0.018,

  maxSteerLow: 0.52,
  maxSteerHigh: 0.05,
  steerSlipAngle: 0.07,
  steerSpeed: 4.5,
  steerReturnSpeed: 7,

  boostDrive: 2.1,
  boostTopSpeed: 1.32,
  driftBoostMinTime: 0.7,
  driftBoostBase: 0.35,
  driftBoostPerSecond: 0.35,

  airKp: 14,
  airKd: 5,
  airMaxAccel: 28,
  airFollowTrajectory: 0.55,
  airPitchBias: 0.35,
  airRollBias: 0.3,
  airYawAccel: 3,
  airAngularDamping: 0.6,
  groundAngularDamping: 1.2,
};
