/* Location matching. Coordinates here are arbitrary test points, not real
   gyms — real locations only ever live on the phone and behind RLS. */

import {
  distanceMeters, hasLocation, matchPlace, nearestPlace, formatDistance,
  MAX_USEFUL_ACCURACY_M,
} from '../js/geo.js';

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

const ORIGIN = { lat: 40.0, lng: -88.0 };
// One degree of latitude is ~111.2 km, so 0.001° ≈ 111 m.
const north = (meters) => ({ lat: ORIGIN.lat + meters / 111_195, lng: ORIGIN.lng });

check('a point is zero from itself', distanceMeters(ORIGIN, ORIGIN) === 0);
check('~1 km north measures ~1 km',
  Math.abs(distanceMeters(ORIGIN, north(1000)) - 1000) < 2,
  `got ${distanceMeters(ORIGIN, north(1000))}`);
check('distance is symmetric',
  Math.abs(distanceMeters(ORIGIN, north(500)) - distanceMeters(north(500), ORIGIN)) < 1e-6);
check('a degree of longitude shrinks away from the equator',
  distanceMeters({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })
    < distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) * 0.55);

const gym = { id: 'gym', name: 'Gym', ...ORIGIN, radius_m: 250 };
const garage = { id: 'garage', name: 'Garage', ...north(30_000), radius_m: 250 };
const unsaved = { id: 'unsaved', name: 'Not yet saved', lat: null, lng: null, radius_m: 250 };
const places = [gym, garage, unsaved];

check('a place without coordinates has no location', !hasLocation(unsaved));
check('one with coordinates does', hasLocation(gym));

const atGym = matchPlace(places, { ...north(80), accuracy: 30 });
check('a good fix inside the radius matches', atGym?.place.id === 'gym');
check('and reports how far', Math.abs(atGym.distance - 80) < 2);
check('and is unambiguous', atGym.ambiguous === false);

check('a good fix outside the radius does not',
  matchPlace(places, { ...north(600), accuracy: 30 }) === null);

const vague = matchPlace(places, { ...north(600), accuracy: 450 });
check("a vague fix whose uncertainty reaches the gym still matches",
  vague?.place.id === 'gym');

check('a fix too vague to mean anything is refused',
  matchPlace(places, { ...ORIGIN, accuracy: MAX_USEFUL_ACCURACY_M + 1 }) === null);
check('a missing fix is refused', matchPlace(places, null) === null);
check('a fix with no accuracy is refused', matchPlace(places, { ...ORIGIN }) === null);
check('unsaved places are skipped, not matched at 0,0',
  matchPlace([unsaved], { lat: 0, lng: 0, accuracy: 10 }) === null);

const twin = { id: 'twin', name: 'Next door', ...north(150), radius_m: 250 };
const both = matchPlace([gym, twin], { ...north(60), accuracy: 40 });
check('two places in range picks the nearer one', both?.place.id === 'gym');
check('and flags it as ambiguous', both?.ambiguous === true);

const near = nearestPlace(places, { ...north(12_000), accuracy: 20 });
check('nearest works even without a match', near?.place.id === 'gym'
  && Math.abs(near.distance - 12_000) < 20);
check('nearest with nothing saved is nothing', nearestPlace([unsaved], { ...ORIGIN, accuracy: 5 }) === null);

check('short distances read in metres', formatDistance(83) === '80 m');
check('mid distances read in km with a decimal', formatDistance(4321) === '4.3 km');
check('long distances read in whole km', formatDistance(42_400) === '42 km');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
