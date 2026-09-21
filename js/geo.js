/* Where are you? Pure distance maths plus a thin wrapper around the browser's
   geolocation.

   The accuracy the phone reports is part of the input, not noise. Inside a
   gym a fix can easily be ±300 m or worse, so a reading is matched to a place
   when the place is within its own radius PLUS the fix's uncertainty. A fix too
   vague to mean anything is refused outright rather than guessed from. */

const EARTH_RADIUS_M = 6_371_000;

/* Beyond this the fix could be anywhere in town. */
export const MAX_USEFUL_ACCURACY_M = 1000;

/* A saved location rougher than this is still worth keeping (it tells towns
   apart) but worth retaking somewhere with a clearer view of the sky. */
export const ROUGH_CAPTURE_M = 300;

export function distanceMeters(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function hasLocation(place) {
  return Number.isFinite(place?.lat) && Number.isFinite(place?.lng);
}

/* Which saved place is this fix at, if any?

   Returns { place, distance, ambiguous } or null. `ambiguous` means a second
   place also fits — the caller should suggest rather than apply. */
export function matchPlace(places, fix) {
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return null;
  if (!(fix.accuracy <= MAX_USEFUL_ACCURACY_M)) return null;

  const candidates = places
    .filter(hasLocation)
    .map((place) => ({ place, distance: distanceMeters(place, fix) }))
    .filter(({ place, distance }) => distance <= (place.radius_m ?? 250) + fix.accuracy)
    .sort((a, b) => a.distance - b.distance);

  if (!candidates.length) return null;
  return { ...candidates[0], ambiguous: candidates.length > 1 };
}

/* The nearest saved place regardless of whether it matches, for the "Detect
   now" readout: "Nearest saved place is 42 km away" is useful to see. */
export function nearestPlace(places, fix) {
  const located = places.filter(hasLocation);
  if (!fix || !located.length) return null;
  return located
    .map((place) => ({ place, distance: distanceMeters(place, fix) }))
    .sort((a, b) => a.distance - b.distance)[0];
}

export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

/* ---------- the browser side ---------- */

export class GeoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MESSAGES = {
  1: 'Location is off for LiftLog. In iOS Settings → Privacy & Security → '
    + 'Location Services, set it to "While Using the App" (not "Ask Next Time", '
    + 'which asks again every launch).',
  2: 'Couldn\'t get a location fix. Try again near a window or doorway.',
  3: 'Getting a location took too long. Try again near a window or doorway.',
};

export function available() {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

/* A fresh, high-accuracy fix, as { lat, lng, accuracy }. Rejects with a
   GeoError whose message is fit to show as-is. */
export function currentFix({ timeout = 15000, maximumAge = 0 } = {}) {
  if (!available()) {
    return Promise.reject(new GeoError(0, 'This device can\'t share its location.'));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        lat: coords.latitude,
        lng: coords.longitude,
        accuracy: coords.accuracy,
      }),
      (error) => reject(new GeoError(error.code, MESSAGES[error.code] || 'Location failed.')),
      { enableHighAccuracy: true, timeout, maximumAge },
    );
  });
}
