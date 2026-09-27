/**
 * Stadium dimensions in metres, matching the Bloomfield 2019 model (tools/export_blend.py).
 * World frame: pitch centre at the origin, touchlines along X, goal ends at ±X.
 *  - West main stand (VIP / press box) at z < 0, East stand (two tiers, exposed steel) at z > 0.
 *  - North end at +X (the Tel Aviv skyline side), South end at -X.
 */
export const PITCH = { length: 105, width: 68 } as const;

/** Grass run-off beyond the lines, up to the advertising boards. */
export const GRASS = { halfX: 56.7, halfZ: 38.7 } as const;

/** Advertising boards (the model's perimeter panels sit here). */
export const BOARDS = { halfX: 56.8, halfZ: 38.8, height: 0.9, thickness: 0.12 } as const;

/** Front of the stand bowl: long sides at |z| = 40, ends at |x| = 58. First tread ≈ 1.15 m up. */
export const STAND_FRONT = { long: 40, end: 58 } as const;

/** Service apron under the bowl (the model's turf/apron slab). */
export const FLOOR = { halfX: 62.5, halfZ: 44 } as const;

/**
 * East stand, measured from the model: lower tier z 40.25 → 53.75 (rows 0.75 m deep, 0.43 m high,
 * first tread 1.15 m), a flat gallery at y ≈ 10.9 between z 54 and 55.2, upper tier above.
 */
export const EAST_STAND = { front: 40, firstTread: 1.15, tread: 0.75, rise: 0.43, galleryY: 10.89, galleryZ0: 54.0, galleryZ1: 55.2 } as const;
