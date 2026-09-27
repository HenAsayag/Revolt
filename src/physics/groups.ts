/**
 * Rapier interaction groups: a 32-bit value, (membership << 16) | filter.
 * Two colliders (or a query and a collider) interact when each one's membership
 * overlaps the other's filter. Colliders left at the default are in every group.
 */
export const GROUP = {
  WORLD: 1 << 0,
  CAR: 1 << 1,
  CONE: 1 << 2,
  PICKUP: 1 << 3,
  /** Sensor volume around each car, used to detect (not collide with) cones and balls. */
  CAR_SENSOR: 1 << 4,
  BALL: 1 << 5,
  /** Invisible driving surfaces laid over stair noses (only cars touch them). */
  GLIDE: 1 << 6,
} as const;

export const groups = (membership: number, filter: number) => (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;

/**
 * Cones and footballs collide with the world and each other but NOT with car bodies: a light
 * prop wedged under a chassis would lever the car over. Cars find them through their sensor and kick them.
 */
export const CONE_GROUPS = groups(GROUP.CONE, 0xffff & ~GROUP.CAR);
export const BALL_GROUPS = groups(GROUP.BALL, 0xffff & ~GROUP.CAR);
/** Car chassis colliders. */
export const CAR_GROUPS = groups(GROUP.CAR, 0xffff);
export const CAR_SENSOR_GROUPS = groups(GROUP.CAR_SENSOR, GROUP.CONE | GROUP.BALL);
/** Boost pads and pickups: sensors that only notice car chassis. */
export const PAD_GROUPS = groups(GROUP.PICKUP, GROUP.CAR);
/** Glide slabs only exist for cars (props fall through to the real steps). */
export const GLIDE_GROUPS = groups(GROUP.GLIDE, GROUP.CAR);
/** Suspension rays only see solid scenery (and other cars). */
export const WHEEL_RAY_GROUPS = groups(GROUP.CAR, 0xffff & ~(GROUP.CONE | GROUP.BALL | GROUP.PICKUP));
