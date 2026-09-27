import { isTouchDevice } from './TouchControls';

/**
 * Rendering quality preset. Phones/tablets default to "low"; override with ?quality=low|high.
 */
export interface QualitySettings {
  name: 'low' | 'high';
  pixelRatioCap: number;
  antialias: boolean;
  shadowMapSize: number;
  /** Render the stadium-screen TV feed every N frames, at this resolution. */
  tvEvery: number;
  tvWidth: number;
}

const PRESETS: Record<'low' | 'high', QualitySettings> = {
  high: { name: 'high', pixelRatioCap: 2, antialias: true, shadowMapSize: 2048, tvEvery: 4, tvWidth: 384 },
  low: { name: 'low', pixelRatioCap: 1.25, antialias: false, shadowMapSize: 1024, tvEvery: 10, tvWidth: 256 },
};

function pick(): QualitySettings {
  const q = new URLSearchParams(location.search).get('quality');
  if (q === 'low' || q === 'high') return PRESETS[q];
  return isTouchDevice() ? PRESETS.low : PRESETS.high;
}

export const QUALITY = pick();
