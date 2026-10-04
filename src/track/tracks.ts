import { CONTROL_POINTS, DEFAULT_WIDTH, FEATURES, type TrackControlPoint, type TrackFeature } from './trackData';
import { TOUR_FEATURES, TOUR_PICKUPS, TOUR_POINTS, TOUR_WIDTH } from './tourData';
import { STAIR_CLEAR_SEATS, STAIR_FEATURES, STAIR_PICKUPS, STAIR_POINTS, STAIR_WIDTH } from './stairData';

export type TrackId = 'tour' | 'stairs' | 'classic';

export interface TrackDef {
  id: TrackId;
  name: string;
  points: TrackControlPoint[];
  features: TrackFeature[];
  /** Width where a control point doesn't set one. */
  width: number;
  /** Item box rows: track arc length s, or a world [x, z] that snaps to the track. */
  pickups: (number | [number, number])[];
  /** Seats to remove under pieces built into the stands ([x0, z0, x1, z1]). */
  clearSeats?: [number, number, number, number][];
}

export const TRACKS: Record<TrackId, TrackDef> = {
  tour: { id: 'tour', name: 'Stadium Tour', points: TOUR_POINTS, features: TOUR_FEATURES, width: TOUR_WIDTH, pickups: TOUR_PICKUPS },
  stairs: {
    id: 'stairs', name: 'Stair Run', points: STAIR_POINTS, features: STAIR_FEATURES, width: STAIR_WIDTH,
    pickups: STAIR_PICKUPS, clearSeats: STAIR_CLEAR_SEATS,
  },
  classic: { id: 'classic', name: 'Pitch Circuit', points: CONTROL_POINTS, features: FEATURES, width: DEFAULT_WIDTH, pickups: [52, 130, 212, 265] },
};
