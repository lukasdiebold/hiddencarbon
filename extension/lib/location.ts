import { Location } from './emissions';

export type StoredLocation = Location & { detectedAt: number };

const STORAGE_KEY = 'user_location';

export async function getStoredLocation(): Promise<StoredLocation | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as StoredLocation) ?? null;
}

export async function saveLocation(loc: StoredLocation): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: loc });
}

export async function clearLocation(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEY);
}

// Wraps navigator.geolocation in a promise. Rejects if the user denies
// permission or the browser can't fix a location.
export function detectUserLocation(): Promise<StoredLocation> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation API unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          detectedAt: Date.now(),
        }),
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 24 * 3600_000 },
    );
  });
}
