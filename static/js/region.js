// The country the car is in, from its position, and what that country settles: which side of the road it drives on,
// whether its speed limits are in mph, which speed-limit sign it uses and whether Ordnance Survey's map data covers
// it. The settings marked Auto (regional.js, main.js postOs) follow it, so a UK driver needn't set any of them.
//
// The borders (borders_data.js, Natural Earth 1:50m: a few hundred metres) are loaded once, on the first fix. The
// country last seen is kept (localStorage), so it is known at start-up before there's a fix, and a new one is taken
// only after the car has been in it for SWITCH_S (or straight away when there's none yet): near a border, a fix a
// few hundred metres off doesn't flip the units back and forth (Ireland's km/h, Northern Ireland's mph). Out at sea or
// on a bridge between two (no country under the fix) the last one holds.

const SWITCH_S = 30;
const LOOK_S = 5, LOOK_DEG = 0.002;   // a fix is looked up when it's this long or ~200 m from the last one looked up
const KEY = 'oceanscape.region';

// ISO 3166 numeric codes. Left-hand traffic:
const LEFT = new Set([826, 372, 833, 831, 832, 36, 554, 392, 356, 710, 458, 702, 764, 360, 344, 446, 586, 50, 144, 524,
  64, 404, 800, 834, 894, 716, 72, 516, 508, 454, 426, 748, 480, 196, 470, 388, 780, 44, 52, 328, 740, 96, 598, 242,
  90, 882, 776, 626, 462, 690, 238, 28, 212, 308, 659, 662, 670, 60, 136, 92, 850, 660, 500, 796, 296, 798, 520, 570,
  184, 574, 654]);
// speed limits in mph:
const MPH = new Set([826, 833, 831, 832, 840, 630, 316, 850, 16, 580, 430, 238, 44, 84, 28, 212, 308, 659, 662, 670,
  136, 92, 660, 500, 796, 882, 654]);
// the US-style rectangular sign (the rest of the world's is the round red ring):
const US_SIGN = new Set([840, 630, 316, 850, 16, 580, 124]);
// Natural Earth's countries without an ISO code, by name
const NAMED = { 'N. Cyprus': { left: true } };

/** What a country (ISO numeric code, or '' with its name) settles: {code, name, left, mph, usSign, gb}. gb: the UK,
 *  where Ordnance Survey's data is (Great Britain's; in Northern Ireland the server just finds none). */
export function countryInfo(code, name) {
  const c = Number(code) || 0, named = (!c && NAMED[name]) || {};
  return { code: c, name, left: c ? LEFT.has(c) : !!named.left, mph: MPH.has(c), usSign: US_SIGN.has(c), gb: c === 826 };
}

let borders = null, loading = null;

/** Load the borders (once); resolves when they're in. */
export function loadBorders() {
  if (borders) return Promise.resolve(borders);
  if (!loading) loading = import('./borders_data.js').then((m) => (borders = prepare(m)));
  return loading;
}

/** The borders unpacked: [{code, name, rings: [Float64Array lon0, lat0, ...], box: [w, s, e, n]}]. */
export function prepare({ SCALE, ORIGIN, COUNTRIES }) {
  return COUNTRIES.map(([code, name, ...rings]) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const out = rings.map((r) => {
      const a = new Float64Array(r.length);
      let x = 0, y = 0;
      for (let i = 0; i < r.length; i += 2) {
        x += r[i]; y += r[i + 1];
        const lon = ORIGIN[0] + x * SCALE[0], lat = ORIGIN[1] + y * SCALE[1];
        a[i] = lon; a[i + 1] = lat;
        if (lon < w) w = lon; if (lon > e) e = lon; if (lat < s) s = lat; if (lat > n) n = lat;
      }
      return a;
    });
    return { code, name, rings: out, box: [w, s, e, n] };
  });
}

/** The country under (lat, lon) in these borders, or null (the sea). */
export function countryAt(list, lat, lon) {
  for (const c of list) {
    const [w, s, e, n] = c.box;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    let inside = false;
    for (const r of c.rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const yi = r[i + 1], yj = r[j + 1];
        if ((yi > lat) !== (yj > lat) && lon < (r[j] - r[i]) * (lat - yi) / (yj - yi) + r[i]) inside = !inside;
      }
    }
    if (inside) return countryInfo(c.code, c.name);
  }
  return null;
}

function store() { try { return globalThis.localStorage || null; } catch { return null; } }

/** The country the car is in, kept across fixes (see the top). `onChange(country)` hears each switch. */
export class Region {
  constructor(onChange = () => {}, saved = undefined) {
    this.onChange = onChange;
    this.country = null;       // countryInfo()
    this.candidate = null; this.since = 0;
    this.lat = null; this.lon = null; this.lookedAt = -Infinity;
    let s = saved;
    if (s === undefined) { try { s = JSON.parse(store()?.getItem(KEY) || 'null'); } catch { s = null; } }
    if (s && s.name) this.country = countryInfo(s.code, s.name);
  }

  /** A fix at t (s). With the borders not in yet, it asks for them and goes by the next fix. */
  update(lat, lon, t, list = borders) {
    if (!(Number.isFinite(lat) && Number.isFinite(lon)) || (lat === 0 && lon === 0)) return this.country;
    if (!list) { loadBorders().catch(() => {}); return this.country; }
    // drawn 20 times a second: looked up again only after the car has moved a little, or a while has passed
    if (this.lat != null && !this.candidate && t - this.lookedAt < LOOK_S && Math.abs(lat - this.lat) < LOOK_DEG && Math.abs(lon - this.lon) < LOOK_DEG) return this.country;
    this.lat = lat; this.lon = lon; this.lookedAt = t;
    const here = countryAt(list, lat, lon);
    if (!here) { this.candidate = null; return this.country; }
    const same = (a) => a && a.code === here.code && a.name === here.name;
    if (same(this.country)) { this.candidate = null; return this.country; }
    if (!this.country) { this._set(here); return this.country; }
    if (!same(this.candidate)) { this.candidate = here; this.since = t; }
    if (t - this.since >= SWITCH_S) { this.candidate = null; this._set(here); }
    return this.country;
  }

  _set(c) {
    this.country = c;
    try { store()?.setItem(KEY, JSON.stringify({ code: c.code, name: c.name })); } catch { /* none */ }
    this.onChange(c);
  }
}
