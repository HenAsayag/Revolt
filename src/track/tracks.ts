import { CONTROL_POINTS, DEFAULT_WIDTH, FEATURES, type TrackControlPoint, type TrackFeature } from './trackData';
import { TOUR_FEATURES, TOUR_PICKUPS, TOUR_POINTS, TOUR_WIDTH } from './tourData';

export type TrackId = 'tour' | 'classic';

export interface TrackDef {
  id: TrackId;
  name: string;
  points: TrackControlPoint[];
  features: TrackFeature[];
  /** Width where a control point doesn't set one. */
  width: number;
  /** Item box rows: track arc length s, or a world [x, z] that snaps to the track. */
  pickups: (number | [number, number])[];
}

export const TRACKS: Record<TrackId, TrackDef> = {
  tour: { id: 'tour', name: 'Stadium Tour', points: TOUR_POINTS, features: TOUR_FEATURES, width: TOUR_WIDTH, pickups: TOUR_PICKUPS },
  classic: { id: 'classic', name: 'Pitch Circuit', points: CONTROL_POINTS, features: FEATURES, width: DEFAULT_WIDTH, pickups: [52, 130, 212, 265] },
};
