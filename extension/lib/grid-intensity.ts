// ---------------------------------------------------------------------------
// Grid intensity cache: fetches carbon intensity (gCO₂eq/kWh) from the
// Electricity Maps API for each provider's datacenter regions, caches results
// in chrome.storage.local, and refreshes once per day via a background alarm.
//
// Weights are computed via inverse-distance from the user's location to each
// datacenter — closer DCs are more likely to serve the request.
// ---------------------------------------------------------------------------

import { GRID_G_PER_KWH, Location, ServiceName } from './emissions';
import { getStoredLocation } from './location';

const STORAGE_KEY = 'grid_intensity_cache';
const ALARM_NAME = 'refresh-grid-intensity';
const REFRESH_INTERVAL_MIN = 60 * 24; // 24 hours

// Default user location when geolocation is unavailable.
// Seattle, WA — update this or implement proper geolocation detection.
const DEFAULT_LOCATION: Location = { lat: 47.61, lng: -122.33 };
const DEFAULT_LOCATION_LABEL = 'Seattle, WA';

// Electricity Maps free-tier API base.
const API_BASE = 'https://api.electricitymap.org/v3';

// API token — free tier allows carbon-intensity/latest by zone or datacenter.
// Supplied at build time via WXT_PUBLIC_ELECTRICITY_MAPS_TOKEN (see .env.example).
const API_TOKEN = import.meta.env.WXT_PUBLIC_ELECTRICITY_MAPS_TOKEN;

// ---------------------------------------------------------------------------
// Datacenter region registry: provider, region name, and physical coordinates.
// ---------------------------------------------------------------------------

export type DatacenterRegion = {
  provider: string;   // Electricity Maps dataCenterProvider: 'aws', 'azure', 'gcp'
  region: string;     // Electricity Maps dataCenterRegion: e.g. 'us-east-1'
  label: string;      // Human-readable location name
  lat: number;
  lng: number;
};

// Claude → AWS
const CLAUDE_REGIONS: DatacenterRegion[] = [
  { provider: 'aws', region: 'us-east-1', label: 'Virginia',   lat: 39.04, lng: -77.49 },
  { provider: 'aws', region: 'us-west-2', label: 'Oregon',     lat: 45.59, lng: -122.60 },
];

// ChatGPT → Azure
const CHATGPT_REGIONS: DatacenterRegion[] = [
  { provider: 'azure', region: 'eastus',         label: 'Virginia',   lat: 37.37, lng: -79.13 },
  { provider: 'azure', region: 'eastus2',        label: 'Virginia',   lat: 36.67, lng: -78.38 },
  { provider: 'azure', region: 'southcentralus', label: 'Texas',      lat: 29.43, lng: -98.49 },
  { provider: 'azure', region: 'westus',         label: 'California', lat: 37.78, lng: -122.42 },
];

// Gemini → GCP
const GEMINI_REGIONS: DatacenterRegion[] = [
  { provider: 'gcp', region: 'us-central1', label: 'Iowa',       lat: 41.26, lng: -95.86 },
  { provider: 'gcp', region: 'us-east4',    label: 'Virginia',   lat: 39.04, lng: -77.49 },
  { provider: 'gcp', region: 'us-west4',    label: 'Las Vegas',  lat: 36.17, lng: -115.14 },
];

export const SERVICE_REGIONS: Record<ServiceName, DatacenterRegion[]> = {
  claude: CLAUDE_REGIONS,
  chatgpt: CHATGPT_REGIONS,
  gemini: GEMINI_REGIONS,
};

// All unique datacenter regions across all providers.
export function allRegions(): DatacenterRegion[] {
  return [...CLAUDE_REGIONS, ...CHATGPT_REGIONS, ...GEMINI_REGIONS];
}

// ---------------------------------------------------------------------------
// Haversine distance (km)
// ---------------------------------------------------------------------------

function haversineKm(a: Location, b: Location): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Compute inverse-distance weights for a set of datacenters relative to user.
// Returns normalized weights (sum to 1). Falls back to equal weights if no
// user location is available.
// ---------------------------------------------------------------------------

export function computeWeights(
  regions: DatacenterRegion[],
  userLocation: Location | null,
): number[] {
  if (!userLocation) {
    // Equal weighting when location unknown
    return regions.map(() => 1 / regions.length);
  }

  const rawWeights = regions.map((dc) => {
    const dist = haversineKm(userLocation, { lat: dc.lat, lng: dc.lng });
    return 1 / Math.max(dist, 10); // clamp to avoid div-by-zero
  });

  const sum = rawWeights.reduce((a, b) => a + b, 0);
  return rawWeights.map((w) => w / sum);
}

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

export type GridIntensityCache = {
  values: Record<string, number>; // "provider:region" → gCO₂eq/kWh
  updatedAt: number;
};

function cacheKey(dc: DatacenterRegion): string {
  return `${dc.provider}:${dc.region}`;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

export async function getCache(): Promise<GridIntensityCache | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as GridIntensityCache) ?? null;
}

async function saveCache(cache: GridIntensityCache): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: cache });
}

// ---------------------------------------------------------------------------
// Fetch carbon intensity for a single datacenter region from Electricity Maps.
// ---------------------------------------------------------------------------

async function fetchIntensity(dc: DatacenterRegion): Promise<number | null> {
  if (!API_TOKEN) return null;
  try {
    const url = `${API_BASE}/carbon-intensity/latest?dataCenterProvider=${dc.provider}&dataCenterRegion=${dc.region}`;
    const resp = await fetch(url, {
      headers: { 'auth-token': API_TOKEN },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.carbonIntensity === 'number' ? data.carbonIntensity : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Refresh all datacenter intensities and persist to cache.
// ---------------------------------------------------------------------------

export async function refreshGridIntensities(): Promise<void> {
  const regions = allRegions();
  const values: Record<string, number> = {};

  const results = await Promise.allSettled(
    regions.map(async (dc) => {
      const intensity = await fetchIntensity(dc);
      return { key: cacheKey(dc), intensity };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.intensity != null) {
      values[result.value.key] = result.value.intensity;
    }
  }

  if (Object.keys(values).length > 0) {
    await saveCache({ values, updatedAt: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// Resolve user location: stored geolocation or default fallback.
// ---------------------------------------------------------------------------

async function getUserLocation(): Promise<Location> {
  const stored = await getStoredLocation();
  return stored ? { lat: stored.lat, lng: stored.lng } : DEFAULT_LOCATION;
}

export async function getUserLocationLabel(): Promise<string> {
  const stored = await getStoredLocation();
  if (stored) {
    return `${stored.lat.toFixed(1)}°, ${stored.lng.toFixed(1)}°`;
  }
  return DEFAULT_LOCATION_LABEL;
}

// ---------------------------------------------------------------------------
// Weighted grid intensity for a service, using inverse-distance from user.
// ---------------------------------------------------------------------------

export async function getCachedIntensityForService(
  service: ServiceName,
): Promise<number> {
  const cache = await getCache();
  if (!cache || Object.keys(cache.values).length === 0) {
    return GRID_G_PER_KWH;
  }

  const regions = SERVICE_REGIONS[service];
  const userLocation = await getUserLocation();
  const weights = computeWeights(regions, userLocation);

  let weightedSum = 0;
  let weightUsed = 0;

  for (let i = 0; i < regions.length; i++) {
    const val = cache.values[cacheKey(regions[i])];
    if (val != null) {
      weightedSum += weights[i] * val;
      weightUsed += weights[i];
    }
  }

  return weightUsed > 0 ? weightedSum / weightUsed : GRID_G_PER_KWH;
}

// ---------------------------------------------------------------------------
// Per-region breakdown for display in the popup.
// ---------------------------------------------------------------------------

export type RegionBreakdown = {
  region: string;
  provider: string;
  label: string;
  gPerKwh: number | null;
  weightPct: number;
};

export async function getRegionBreakdown(
  service: ServiceName,
): Promise<RegionBreakdown[]> {
  const cache = await getCache();
  const regions = SERVICE_REGIONS[service];
  const userLocation = await getUserLocation();
  const weights = computeWeights(regions, userLocation);

  return regions.map((dc, i) => ({
    region: dc.region,
    provider: dc.provider,
    label: dc.label,
    gPerKwh: cache?.values[cacheKey(dc)] ?? null,
    weightPct: weights[i] * 100,
  }));
}

// ---------------------------------------------------------------------------
// Alarm setup: call from the background worker to register the daily refresh.
// ---------------------------------------------------------------------------

export function registerGridIntensityAlarm(): void {
  browser.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: REFRESH_INTERVAL_MIN,
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      refreshGridIntensities();
    }
  });
}
