// Per-token energy for LLM inference. Input tokens (prefill, parallelized) are
// far cheaper than output tokens (autoregressive decoding).
// Calibrated against Epoch AI (2025) ~0.3 Wh for a typical 100-in / 500-out
// query; cross-checked against Jegham et al. (2025) and Google's Gemini
// disclosure. Reasoning models scale ~10x — not yet distinguished.
export const WH_PER_INPUT_TOKEN = 0.0001;
export const WH_PER_OUTPUT_TOKEN = 0.0006;

// Global grid carbon intensity fallback when no cached data is available.
// Source: Ember 2024 Global Electricity Review.
export const GRID_G_PER_KWH = 400;

// HD YouTube streaming. Source: Carbon Trust (2021), ~36 gCO₂/hour.
export const YOUTUBE_G_PER_MIN = 0.6;

// Traditional (non-AI) Google search, server-side. Source: Vanderbauwhede
// (2024), updating Google's 2009 figure for modern server efficiency and US
// grid intensity. Excludes AI Overviews, which run ~60–75× higher.
export const GOOGLE_SEARCH_G = 0.02;

export type Location = { lat: number; lng: number };
export type ServiceName = 'claude' | 'chatgpt' | 'gemini';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function whFromTokens(inputTokens: number, outputTokens: number): number {
  return inputTokens * WH_PER_INPUT_TOKEN + outputTokens * WH_PER_OUTPUT_TOKEN;
}

/**
 * Converts Wh to gCO₂ using a provided grid intensity value.
 *
 * The `gridIntensity` parameter should come from the cached Electricity Maps
 * data (via getCachedIntensityForService in grid-intensity.ts). If unavailable,
 * callers should pass GRID_G_PER_KWH as the fallback.
 */
export function whToGCO2(wh: number, gridIntensity: number = GRID_G_PER_KWH): number {
  return (wh / 1000) * gridIntensity;
}
