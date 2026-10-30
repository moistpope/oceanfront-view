// A road's full OSM detail, beyond what the offline tiles (osmtile.js) carry: the lanes each way (lanes:forward,
// lanes:backward, lanes:both_ways), the turn arrows painted in them (turn:lanes...), the carriageway's width
// (width, est_width) and whether it is a roundabout. The server fetches these tags from the Overpass API, a road
// tile at a time (GET /map/ways/<tlat>/<tlon>: {ways: {<osm id>: {tag: value}}}, maptiles.py / MapFeatures.kt),
// and mapdata.js hangs the parsed result on each way as `way.detail`. "Forward" is the way's node order.

const FT = 0.3048;
export const LANE_W = 3.6;   // m: a lane when OSM gives no width
const LANE_W_MIN = 2.4, LANE_W_MAX = 4.6;   // m: a width tag that gives lanes outside this is the wrong kind of width (with verges, say)

/** A width tag in meters ("7", "7 m", "7.5m", "23'", "23 ft", "6'6\""), or null. */
export function parseWidth(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(',', '.');
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?)?$/);
  if (m) return +m[1] > 0 ? +m[1] : null;
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)(?:\s*(\d+(?:\.\d+)?)\s*(?:"|in))?$/);
  if (m) return +m[1] * FT + (m[2] ? +m[2] * FT / 12 : 0) || null;
  return null;
}

/** A turn:lanes value as one list of arrows per lane, left to right as the driver sees them ("left|through;right"
 *  -> [['left'], ['through', 'right']]; an empty lane is ['none']), or null. */
export function parseTurns(v) {
  if (v == null || v === '') return null;
  return String(v).split('|').map(l => {
    const a = l.split(';').map(x => x.trim()).filter(Boolean);
    return a.length ? a : ['none'];
  });
}

/** Whether traffic each way may overtake across the center line, from overtaking / overtaking:forward|backward
 *  and divider: { fwd, bwd }, each true, false or null (OSM doesn't say). */
export function overtaking(tags) {
  const yn = (v) => (v === 'yes' ? true : v === 'no' ? false : null);
  let fwd = null, bwd = null;
  const o = tags.overtaking;
  if (o === 'yes' || o === 'no' || o === 'both') fwd = bwd = o !== 'no';
  else if (o === 'forward') { fwd = true; bwd = false; }
  else if (o === 'backward') { fwd = false; bwd = true; }
  const dv = tags.divider;
  if (fwd == null && bwd == null && dv) {
    if (/^(solid_line|double_solid_line|barrier|kerb)$/.test(dv)) fwd = bwd = false;
    else if (/^(dashed_line|no)$/.test(dv)) fwd = bwd = true;
  }
  fwd = yn(tags['overtaking:forward']) ?? fwd;
  bwd = yn(tags['overtaking:backward']) ?? bwd;
  return { fwd, bwd };
}

const count = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= 12 ? n : null; };

/** The parsed detail of a way from its tags: { width, fwd, bwd, both, turnsFwd, turnsBwd, roundabout, passFwd, passBwd, markings } (null fields
 *  where OSM doesn't say). `oneWay` is the tile's flag (the tags' oneway is already folded into it). */
export function wayDetail(tags, oneWay = false) {
  if (!tags) return null;
  const width = parseWidth(tags.width) ?? parseWidth(tags.est_width);
  const lanes = count(tags.lanes);
  let fwd = count(tags['lanes:forward']), bwd = count(tags['lanes:backward']);
  const both = count(tags['lanes:both_ways']) ?? 0;
  let turnsFwd = parseTurns(tags['turn:lanes:forward']), turnsBwd = parseTurns(tags['turn:lanes:backward']);
  if (oneWay) {
    turnsFwd = turnsFwd || parseTurns(tags['turn:lanes']);
    fwd = fwd ?? lanes ?? (turnsFwd ? turnsFwd.length : null);
    bwd = 0;
  } else {
    // one side told, the other by difference
    if (lanes != null && fwd != null && bwd == null && lanes - fwd - both > 0) bwd = lanes - fwd - both;
    if (lanes != null && bwd != null && fwd == null && lanes - bwd - both > 0) fwd = lanes - bwd - both;
    if (fwd == null && turnsFwd) fwd = turnsFwd.length;
    if (bwd == null && turnsBwd) bwd = turnsBwd.length;
  }
  if (turnsFwd && fwd != null && turnsFwd.length !== fwd) turnsFwd = null;   // they disagree: trust neither arrow
  if (turnsBwd && bwd != null && turnsBwd.length !== bwd) turnsBwd = null;
  const pass = overtaking(tags);
  return { width, lanes, fwd, bwd, both, turnsFwd, turnsBwd, roundabout: tags.junction === 'roundabout' || tags.junction === 'circular',
    passFwd: pass.fwd, passBwd: pass.bwd, markings: tags.lane_markings === 'no' ? false : tags.lane_markings === 'yes' ? true : null };
}

/** A way's lane count when OSM doesn't say: two for a two-way road, two for a one-way road of a kind that is usually a
 *  carriageway of a divided road (motorway, trunk, primary and their links), one for any other one-way street. */
export function lanesOf(way) {
  if (way.lanes > 0) return way.lanes;
  if (!way.oneWay) return 2;
  return /^(motorway|trunk|primary)/.test(way.className || '') ? 2 : 1;
}

/** How a way's carriageway is laid out for traffic going `dir` along it (+1 with the nodes, -1 against):
 *  { lanes (total), ours, theirs, centre (shared lanes between), laneW, width, turns (ours, left to right, or null),
 *  detailed (the split comes from OSM rather than halving the count) }. Without detail: lanesOf's count, halved
 *  (an odd one with a center turn lane), at laneW. */
export function laneLayout(way, dir = 1, laneW = LANE_W) {
  const d = way && way.detail, lanes = lanesOf(way || {});
  let ours, theirs, centre = 0, turns = null, detailed = false;
  if (way && way.oneWay) {
    ours = Math.max(1, (d && d.fwd) || lanes); theirs = 0;
    turns = d && d.turnsFwd && d.turnsFwd.length === ours ? d.turnsFwd : null;
    detailed = !!(d && d.fwd);
  } else if (d && d.fwd != null && d.bwd != null && d.fwd + d.bwd > 0) {
    const f = Math.max(d.fwd, 0), b = Math.max(d.bwd, 0);
    ours = dir < 0 ? b : f; theirs = dir < 0 ? f : b; centre = Math.min(d.both, 1);
    if (ours === 0) { ours = 1; }   // a one-way way the tile didn't flag: never no lane to be in
    turns = dir < 0 ? d.turnsBwd : d.turnsFwd;
    if (turns && turns.length !== ours) turns = null;
    detailed = true;
  } else {
    const n = Math.max(2, lanes);
    ours = Math.max(1, Math.floor(n / 2)); theirs = ours; centre = n % 2;   // an odd count: a center turn lane
  }
  const total = ours + theirs + centre;
  let W = laneW;
  if (d && d.width) { const w = d.width / total; if (w >= LANE_W_MIN && w <= LANE_W_MAX) W = w; }
  return { lanes: total, ours, theirs, centre, laneW: W, width: total * W, turns, detailed };
}

/** The tags worth keeping from an Overpass way (the server keeps exactly these too). */
export const WAY_TAGS = ['width', 'est_width', 'lanes', 'lanes:forward', 'lanes:backward', 'lanes:both_ways', 'turn:lanes',
  'turn:lanes:forward', 'turn:lanes:backward', 'junction', 'overtaking', 'overtaking:forward', 'overtaking:backward', 'divider', 'lane_markings'];
