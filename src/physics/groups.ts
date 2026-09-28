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
  /** Thrown items (bombs): bounce off scenery and props, pass through cars (hits are proximity checks). */
  PROJECTILE: 1 << 7,
  /** Invisible rivals: they drive on the world but touch nothing else (no cars, props or items). */
  GHOST: 1 << 8,
} as const;

export const groups = (membership: number, filter: number) => (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;

/**
 * Cones and footballs collide with the world and each other but NOT with car bodies: a light
 * prop wedged under a chassis would lever the car over. Cars find them through their sensor and kick them.
 */
export const CONE_GROUPS = groups(GROUP.CONE, 0xffff & ~GROUP.CAR);
export const BALL_GROUPS = groups(GROUP.BALL, 0xffff & ~GROUP.CAR);
/** Car bodies. */
export const CAR_GROUPS = groups(GROUP.CAR, 0xffff & ~GROUP.GHOST);
export const GHOST_GROUPS = groups(GROUP.GHOST, 0xffff & ~(GROUP.CAR | GROUP.GHOST | GROUP.CONE | GROUP.BALL | GROUP.PROJECTILE | GROUP.CAR_SENSOR));
export const CAR_SENSOR_GROUPS = groups(GROUP.CAR_SENSOR, GROUP.CONE | GROUP.BALL);
export const GHOST_SENSOR_GROUPS = groups(GROUP.CAR_SENSOR, 0);
/** Boost pads and pickups: sensors that only notice car bodies (ghosts included; the game ignores their pickups). */
export const PAD_GROUPS = groups(GROUP.PICKUP, GROUP.CAR | GROUP.GHOST);
/** Glide slabs only exist for cars (props fall through to the real steps). */
export const GLIDE_GROUPS = groups(GROUP.GLIDE, GROUP.CAR | GROUP.GHOST);
export const PROJECTILE_GROUPS = groups(GROUP.PROJECTILE, 0xffff & ~(GROUP.CAR | GROUP.CAR_SENSOR | GROUP.PICKUP | GROUP.GLIDE | GROUP.PROJECTILE));
/** A car's ground probe only sees solid scenery (not props, items or other cars). */
export const GROUND_RAY_GROUPS = groups(GROUP.CAR, 0xffff & ~(GROUP.CONE | GROUP.BALL | GROUP.PICKUP | GROUP.PROJECTILE | GROUP.CAR | GROUP.GHOST | GROUP.CAR_SENSOR));
