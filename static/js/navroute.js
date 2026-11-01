// The nav app's route, as far as it can be told, laid on the map's roads. Google Maps (or whichever nav app) gives
// other apps only its next step: "in 0.3 mi, turn right onto High St" (infotainment.js parseNav). From the car,
// that step is found on the roads layer (the worker's drivable ways around the car, state.js _roadsLayer):
//   - the road ahead is followed, the way a driver keeps to a road, to the junction about that far on where a road
//     of that name (or, without one, a road the way the step turns) leaves; at a roundabout, to its nth exit;
//   - past the turn the new road is followed while there's no other way the route could go;
//   - from the first junction where it could (a road leaving that isn't a driveway or car park), it's only likely:
//     drawn fainter, for FAINT_M, until the nav app's next step says where it goes.
// Without a turn to find (no step, "continue", or a turn not found), the road ahead is drawn the same way, sure to
// the step's distance. Each piece runs in a lane: the one the car is in, the one for the turn as it nears, then the
// kerb side lane of the new road. planRoute() is plain arrays in the pose frame (x east, y north), routeview.js
// draws it.
import { laneCenters, smoothLine } from './mapsurface.js';

const KEY = (p) => p[0] + ',' + p[1];
const DEG = Math.PI / 180;
export const FAINT_M = 250;       // the likely part past the first junction the route could leave at
const MAX_M = 2000;               // never further than this from the car (the layer is ~320 m around it anyway)
const SLACK_M = 60;               // a turn this much beyond the step's rounding still counts
const LANE_EASE_M = 30;           // a lane change in the drawn route takes this long
const TURN_LANE_M = 70;           // the route moves to the turn's lane this far before it
const CONTINUE_DEG = 50;          // a road carries on through a junction within this angle
const MINOR = new Set(['service', 'track', 'parking_aisle', 'driveway', 'living_street_service']);

/** A street as written by the nav app or OSM, for comparing: lower case, abbreviations spelt out. */
export function streetKey(s) {
  const ABBR = { st: 'street', rd: 'road', ave: 'avenue', av: 'avenue', ln: 'lane', dr: 'drive', ct: 'court', pl: 'place',
    sq: 'square', hwy: 'highway', blvd: 'boulevard', pkwy: 'parkway', cres: 'crescent', gdns: 'gardens', gr: 'grove',
    tce: 'terrace', ter: 'terrace', n: 'north', s: 'south', e: 'east', w: 'west', mt: 'mount', hl: 'hill' };
  return (s || '').toLowerCase().replace(/[.,'’]/g, '').split(/\s+/).filter(Boolean).map(w => ABBR[w] || w).join(' ');
}

/** Whether a way is what a step's street names: its name or ref (the step's may carry more: "A3212/Whitehall"). */
function names(way, street) {
  if (!street) return false;
  const want = streetKey(street);
  if (!want) return false;
  const parts = want.split(/\s*[/;]\s*|\s+towards?\s+/);
  const n = streetKey(way.name), r = streetKey(way.ref);
  return parts.some(p => p && ((n && (p === n || p.startsWith(n + ' ') || n.startsWith(p))) || (r && (p === r || p.split(' ').includes(r)))));
}

/** "take the 2nd exit" -> 2 */
export function exitNumber(text) {
  const m = /\b(\d+)(?:st|nd|rd|th)\s+exit\b/i.exec(text || '') ||
    /\b(first|second|third|fourth|fifth|sixth)\s+exit\b/i.exec(text || '');
  if (!m) return null;
  const words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
  return words[m[1].toLowerCase()] || Number(m[1]) || null;
}

/** The layer's ways as a graph: nodes by coordinate, each with the ways' directed steps out of it. */
export function buildGraph(layer) {
  const ways = (layer && layer.ways || []).filter(w => w.pts && w.pts.length >= 2);
  const nodes = new Map();
  const node = (p) => { const k = KEY(p); let n = nodes.get(k); if (!n) nodes.set(k, n = { k, x: p[0], y: p[1], out: [] }); return n; };
  ways.forEach((w, wi) => {
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const a = node(w.pts[i]), b = node(w.pts[i + 1]);
      if (a === b) continue;
      a.out.push({ wi, i, j: i + 1, to: b });
      if (!w.oneWay) b.out.push({ wi, i: i + 1, j: i, to: a });
    }
  });
  return { ways, nodes };
}

const heading = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

/** The steps out of a node, arriving by `from` (a step), less going back. Each {step, turn (rad, + left)}. */
function options(g, nodeK, from) {
  const n = g.nodes.get(nodeK);
  if (!n) return [];
  const prev = from ? g.nodes.get(KEY(g.ways[from.wi].pts[from.i])) : null;
  const hIn = prev ? heading(prev, n) : null;
  const out = [];
  for (const s of n.out) {
    if (from && s.wi === from.wi && s.j === from.i) continue;           // straight back
    if (prev && s.to === prev) continue;
    out.push({ step: s, turn: hIn == null ? 0 : angDiff(hIn, heading(n, s.to)) });
  }
  return out;
}

/** Of the options, the one that keeps to the road: the same way on, else a way of the same name or ref nearly
 *  straight on, else the straightest within CONTINUE_DEG; null at a T or where two go on equally. */
function carryOn(g, opts, from) {
  if (!opts.length) return null;
  const w0 = g.ways[from.wi];
  const same = opts.find(o => o.step.wi === from.wi || g.ways[o.step.wi].id === w0.id);
  if (same) return same;
  const named = opts.filter(o => Math.abs(o.turn) < CONTINUE_DEG * DEG * 1.6 &&
    ((w0.name && g.ways[o.step.wi].name === w0.name) || (w0.ref && g.ways[o.step.wi].ref === w0.ref)));
  if (named.length) return named.sort((a, b) => Math.abs(a.turn) - Math.abs(b.turn))[0];
  const near = opts.filter(o => Math.abs(o.turn) < CONTINUE_DEG * DEG).sort((a, b) => Math.abs(a.turn) - Math.abs(b.turn));
  if (!near.length) return null;
  if (near.length > 1 && Math.abs(near[1].turn) - Math.abs(near[0].turn) < 12 * DEG) return null;   // a fork: either
  return near[0];
}

/** Whether a junction offers the route another way than `keep` (driveways and car parks don't count). */
function canLeave(g, opts, keep) {
  return opts.some(o => o !== keep && !MINOR.has(g.ways[o.step.wi].className) && !(g.ways[o.step.wi].roundabout && keep && g.ways[keep.step.wi].roundabout));
}

/** Follow the road from a step on: [{step, at (m to its end), node}] until `limit` m or it can't tell. With
 *  stopAtLeave, it stops after the first junction the route could leave at (reported as `left`). */
function walk(g, first, startM, limit, stopAtLeave) {
  const steps = [];
  let s = first, m = startM, left = null;
  for (let guard = 0; s && guard < 4000; guard++) {
    const a = g.nodes.get(KEY(g.ways[s.wi].pts[s.i]));
    m += Math.hypot(s.to.x - a.x, s.to.y - a.y);
    steps.push({ step: s, at: m, node: s.to });
    if (m >= limit) break;
    const opts = options(g, s.to.k, s);
    const keep = carryOn(g, opts, s);
    if (opts.length > 1 || (opts.length === 1 && !keep)) {
      if (canLeave(g, opts, keep) && left == null) { left = steps.length - 1; if (stopAtLeave) break; }
    }
    if (!keep) break;
    s = keep.step;
  }
  return { steps, left };
}

/** Where the car is on the layer: the nearest segment within 12 m running its way (of `wayId` when it's there).
 *  {step (the segment as a step), x, y (the car's foot on it), rest (m from the foot to the step's end)} or null. */
export function locate(g, x, y, h, wayId = null) {
  const ux = Math.cos(h), uy = Math.sin(h);
  let best = null;
  for (const n of g.nodes.values()) {
    for (const s of n.out) {
      const bx = s.to.x - n.x, by = s.to.y - n.y, L = Math.hypot(bx, by);
      if (L < 0.01) continue;
      const along = (bx * ux + by * uy) / L;
      if (along < 0.5) continue;                                   // not our direction
      const t = Math.max(0, Math.min(L, ((x - n.x) * bx + (y - n.y) * by) / L));
      const fx = n.x + bx / L * t, fy = n.y + by / L * t, d = Math.hypot(x - fx, y - fy);
      if (d > 12) continue;
      const score = d + (wayId != null && g.ways[s.wi].id !== wayId ? 6 : 0) + (1 - along) * 8;
      if (!best || score < best.score) best = { score, step: s, x: fx, y: fy, rest: L - t };
    }
  }
  return best;
}

/** The turn the step means among the junctions passed on the walk ahead: {index into steps, opt, exitSteps} or null. */
function findTurn(g, ahead, nav) {
  const man = nav.maneuver, rem = nav.remaining, half = nav.half || 0;
  if (!man || man.kind === 'arrive' || man.kind === 'straight' && !nav.street) return null;
  const want = man.side === 'left' ? 1 : man.side === 'right' ? -1 : 0;
  let best = null;
  ahead.steps.forEach((st, k) => {
    if (rem != null && Math.abs(st.at - rem) > half + SLACK_M) return;
    const opts = options(g, st.node.k, st.step);
    const keep = k + 1 < ahead.steps.length ? opts.find(o => o.step === ahead.steps[k + 1].step) : null;
    for (const o of opts) {
      if (o === keep && man.kind !== 'straight') continue;
      const w = g.ways[o.step.wi], a = Math.abs(o.turn) / DEG;
      if (MINOR.has(w.className) && !names(w, nav.street)) continue;
      const side = want === 0 ? 1 : Math.sign(o.turn) === want ? 1 : 0;
      const kindOk = man.kind === 'roundabout' ? !!w.roundabout
        : man.kind === 'slight' || man.kind === 'keep' || man.kind === 'ramp' || man.kind === 'merge' ? a < 60
        : man.kind === 'sharp' ? a > 100 : man.kind === 'uturn' ? a > 140 : man.kind === 'straight' ? a < 35 : a > 35 && a < 150;
      const named = names(w, nav.street);
      if (!named && !(side && kindOk)) continue;
      const score = (named ? 4 : 0) + 2 * side + (kindOk ? 1 : 0) - (rem != null ? Math.abs(st.at - rem) / (half + SLACK_M) : 0);
      if (!best || score > best.score) best = { score, k, opt: o };
    }
  });
  return best;
}

/** At a roundabout entered by `entry`, round to the exit the step means: steps on the roundabout and the exit step. */
function roundabout(g, entry, nav) {
  const n = exitNumber(nav.instruction);
  const ring = [];
  let s = entry.step, count = 0;
  for (let guard = 0; guard < 200; guard++) {
    ring.push(s);
    const opts = options(g, s.to.k, s);
    const exits = opts.filter(o => !g.ways[o.step.wi].roundabout && !MINOR.has(g.ways[o.step.wi].className));
    for (const e of exits) {
      count++;
      if ((n != null && count === n) || (n == null && names(g.ways[e.step.wi], nav.street))) return { ring, exit: e };
    }
    const on = opts.find(o => g.ways[o.step.wi].roundabout);
    if (!on || on.step === entry.step) break;
    s = on.step;
  }
  return { ring, exit: null };
}

/**
 * The route from the car: { pieces: [{pts: [[x, y], ...], strength: 1 | FAINT, offsets: [m left of travel], ...}],
 * turn: {x, y} | null }, or null without a road under the car.
 * car: {x, y, h} in the layer's frame; nav: {maneuver, street, instruction, remaining (m to the step, or null),
 * half (its rounding, m)} or null; opts: {wayId, egoOffset (m left of the way's centreline the car's lane is, by
 * travel), leftTraffic}.
 */
export function planRoute(layer, car, nav, opts = {}) {
  const g = buildGraph(layer);
  const at = locate(g, car.x, car.y, car.h, opts.wayId);
  if (!at) return null;
  const leftTr = !!opts.leftTraffic;
  // the road ahead of the car, as far as the step and the turn may be
  const rem = nav && nav.remaining != null ? Math.max(0, nav.remaining) : null;
  const reach = Math.min(MAX_M, rem != null ? rem + (nav.half || 0) + SLACK_M + 5 : MAX_M);
  // (the walk counts each step's whole length: the car is `rest` short of its first step's end)
  const ahead = walk(g, at.step, at.rest - segLen(g, at.step), reach, false);
  const turn = nav ? findTurn(g, ahead, nav) : null;
  const strong = [];   // steps drawn sure, then the likely ones
  let likely = [];
  let turnNode = null, turnStepIdx = -1;
  if (turn) {
    strong.push(...ahead.steps.slice(0, turn.k + 1).map(s => s.step));
    turnNode = ahead.steps[turn.k].node;
    let next = turn.opt;
    if (nav.maneuver.kind === 'roundabout' && g.ways[next.step.wi].roundabout) {
      const r = roundabout(g, next, nav);
      turnStepIdx = strong.length;
      strong.push(...r.ring);
      next = r.exit;
    } else turnStepIdx = strong.length;
    if (next) {
      // past the turn: sure until the first place it could leave the road, likely for FAINT_M after
      const used = strong.reduce((m, s) => m + segLen(g, s), 0);
      const after = walk(g, next.step, 0, MAX_M - used, true);
      strong.push(...after.steps.map(s => s.step));
      if (after.left != null) likely = walk(g, after.steps[after.steps.length - 1].step, 0, FAINT_M, false).steps.slice(1).map(s => s.step);
    }
  } else {
    // no turn to find: the road ahead, sure to the step (or to where it could leave), likely beyond
    let cut = ahead.steps.length;
    if (rem != null) { const i = ahead.steps.findIndex(s => s.at >= rem); cut = i < 0 ? ahead.steps.length : i + 1; }
    else if (ahead.left != null) cut = ahead.left + 1;
    strong.push(...ahead.steps.slice(0, cut).map(s => s.step));
    if (rem == null && ahead.left != null) {
      const more = walk(g, ahead.steps[cut - 1].step, 0, FAINT_M, false).steps.slice(1).map(s => s.step);
      likely = more;
    }
  }
  if (!strong.length) return null;
  // the lanes: the car's, the turn's as it nears, the kerb side's on the roads after
  const laneOf = (s, which, keep = null) => laneOffset(g.ways[s.wi], s.j > s.i, leftTr, which, keep);
  const turnSide = turn ? nav.maneuver.side : null;
  const pts = [[at.x, at.y]], offs = [], wis = [];
  const egoLane = opts.egoOffset != null ? opts.egoOffset : laneOf(at.step, 'kerb');
  const all = [...strong, ...likely];
  let d = 0;
  const dist = [0];
  let turnAt = null, nStrong = 1;
  all.forEach((s, k) => {
    const last = pts[pts.length - 1], step = Math.hypot(s.to.x - last[0], s.to.y - last[1]);
    if (k === turnStepIdx) turnAt = d;
    if (step >= 0.05) { pts.push([s.to.x, s.to.y]); d += step; dist.push(d); wis.push(s); }
    if (k === strong.length - 1) nStrong = pts.length;
  });
  // a point where the move to the turn's lane starts, so the drawn line changes lane there and not a whole road early
  const laneAt = turnAt != null ? turnAt - TURN_LANE_M : null;
  const split = laneAt != null && laneAt > 0 ? dist.findIndex((d, i) => i > 0 && dist[i - 1] < laneAt - 1 && d > laneAt + 1) : -1;
  if (split > 0) {
    const a = pts[split - 1], b = pts[split], f = (laneAt - dist[split - 1]) / (dist[split] - dist[split - 1]);
    pts.splice(split, 0, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    dist.splice(split, 0, laneAt);
    wis.splice(split - 1, 0, wis[split - 1]);
    if (nStrong > split) nStrong++;
  }
  for (let i = 0; i < pts.length; i++) {
    const s = wis[Math.max(0, i - 1)] || at.step;
    if (turnAt != null && dist[i] > turnAt + 0.01) offs.push(laneOf(s, 'kerb'));
    else if (turnAt != null && dist[i] > turnAt - TURN_LANE_M) offs.push(laneOf(s, turnSide || 'keep', egoLane));
    else offs.push(s.wi === at.step.wi ? egoLane : laneOf(s, 'kerb'));
  }
  const sureLen = dist[nStrong - 1];
  return { pts, dist, offsets: offs, sure: sureLen, total: d,
    turn: turnNode ? { x: turnNode.x, y: turnNode.y } : null, corners: turnAt != null ? [turnStepIdx] : [] };
}

function segLen(g, s) { const a = g.ways[s.wi].pts[s.i], b = g.ways[s.wi].pts[s.j]; return Math.hypot(b[0] - a[0], b[1] - a[1]); }

/** The centre of a lane of a way, m left of its centreline by the direction of travel: 'kerb' (the traffic side's
 *  outer lane), 'left' / 'right' (for a turn: by its turn:lanes when OSM has them, else the lane nearest that side),
 *  else `keep` (m) when it's one of the lanes, else the kerb's. */
export function laneOffset(way, forward, leftTraffic, which = 'kerb', keep = null) {
  if (way.singleTrack) return 0;
  const ours = forward ? way.fwd : way.bwd, theirs = forward ? way.bwd : way.fwd;
  if (!(ours > 0)) return 0;
  const centers = laneCenters(ours + theirs + (way.centre || 0), !!way.oneWay, way.laneW || 3.5, leftTraffic, { ours, theirs, centre: way.centre || 0 });
  if (!centers.length) return 0;
  const kerb = leftTraffic ? centers[centers.length - 1] : centers[0];   // rightmost first
  if (which === 'left' || which === 'right') {
    const turns = forward ? way.turnsFwd : way.turnsBwd;   // left to right
    if (turns && turns.length === centers.length) {
      const fits = turns.map((t, i) => [t.some(x => x.includes(which)), centers[centers.length - 1 - i]]).filter(f => f[0]);
      if (fits.length) return which === 'left' ? Math.max(...fits.map(f => f[1])) : Math.min(...fits.map(f => f[1]));
    }
    return which === 'left' ? centers[centers.length - 1] : centers[0];
  }
  if (which === 'keep' && keep != null && centers.some(c => Math.abs(c - keep) < 0.3)) return keep;
  return kerb;
}

/**
 * The route drawn: { pts: [[x, y]], along: [m], sure: m, total: m } (strength beyond `sure` is the likely part's).
 * Built in this order so it can't fold over itself: the centreline smoothed as the network draws its roads (corners
 * kept sharp), cut into short steps; each point moved into its lane (lane changes eased over LANE_EASE_M, sharp
 * corners mitred so both legs keep their lane); any point that would take the line backwards dropped (the inside of a
 * tight bend, where the lane is further from the centreline than the bend is round); then the corners rounded to
 * CORNER_M and the whole line smoothed, so a kink left anywhere doesn't show.
 */
export function routeLine(route) {
  if (!route || route.pts.length < 2) return null;
  const P = route.pts, O = route.offsets, D = route.dist;
  const corners = new Set();
  for (let i = 1; i + 1 < P.length; i++) {
    const h1 = Math.atan2(P[i][1] - P[i - 1][1], P[i][0] - P[i - 1][0]), h2 = Math.atan2(P[i + 1][1] - P[i][1], P[i + 1][0] - P[i][0]);
    if (Math.abs(angDiff(h1, h2)) > 20 * DEG) corners.add(i);
  }
  const sm = smoothLine(P, corners);
  // the smoothed line in short steps: [x, y, c (m along the route's own points), corner?]
  const cAt = new Array(sm.pts.length).fill(0);
  for (let i = 0; i + 1 < P.length; i++) {
    const a = sm.index[i], b = sm.index[i + 1];
    for (let k = a; k <= b; k++) cAt[k] = D[i] + (D[i + 1] - D[i]) * (b > a ? (k - a) / (b - a) : 0);
  }
  const cornerAt = new Set([...corners].map(i => sm.index[i]));
  const dense = [];
  for (let k = 0; k < sm.pts.length; k++) {
    const p = sm.pts[k];
    if (k) {
      const q = sm.pts[k - 1], n = Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / STEP_M);
      for (let j = 1; j < n; j++) dense.push([q[0] + (p[0] - q[0]) * j / n, q[1] + (p[1] - q[1]) * j / n, cAt[k - 1] + (cAt[k] - cAt[k - 1]) * j / n, false]);
    }
    dense.push([p[0], p[1], cAt[k], cornerAt.has(k)]);
  }
  // each point into its lane
  const lane = laneAlong(D, O);
  const moved = [];
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i], o = lane(p[2]);
    const a = dense[Math.max(0, i - 1)], b = dense[Math.min(dense.length - 1, i + 1)];
    let nx, ny;
    if (p[3] && i > 0 && i + 1 < dense.length) {
      const n1 = normal(a, p), n2 = normal(p, b), k = Math.max(0.3, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
      nx = (n1[0] + n2[0]) / k; ny = (n1[1] + n2[1]) / k;   // the mitre: both legs stay `o` from the centreline
    } else [nx, ny] = normal(a, b);
    moved.push({ x: p[0] + nx * o, y: p[1] + ny * o, c: p[2], corner: p[3], tx: b[0] - a[0], ty: b[1] - a[1] });
  }
  // never backwards: a point behind the last one kept, by the centreline's direction there, is dropped
  const kept = [moved[0]];
  for (let i = 1; i < moved.length; i++) {
    const m = moved[i], last = kept[kept.length - 1];
    if ((m.x - last.x) * m.tx + (m.y - last.y) * m.ty > 0.05 * Math.hypot(m.tx, m.ty)) kept.push(m);
    else if (m.corner) last.corner = true;   // the corner's point fell inside the bend: round from the last one kept
  }
  let pts = roundCorners(kept);
  pts = smoothPts(pts, SMOOTH_PASSES);
  const along = [];
  let m = 0, sure = null;
  for (let i = 0; i < pts.length; i++) {
    if (i) m += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    along.push(m);
    if (sure == null && pts[i][2] >= route.sure) sure = m;
  }
  return { pts: pts.map(p => [p[0], p[1]]), along, sure: sure == null ? m : sure, total: m };
}

const STEP_M = 1.5;          // the drawn line's points are about this far apart
const CORNER_M = 9;          // a corner is rounded over this much of each leg (less where the legs are short)
const SMOOTH_PASSES = 4;     // passes of neighbour averaging over the whole line: irons out kinks a few metres long

/** The lane (m left of travel) at c m along the route: each point's lane holds from the point before it, and a
 *  change is eased over LANE_EASE_M centred on where it happens, so the line never steps sideways. */
function laneAlong(D, O) {
  const changes = [];
  for (let i = 1; i < O.length; i++) if (Math.abs(O[i] - O[i - 1]) > 0.01) changes.push([D[i - 1], O[i] - O[i - 1]]);
  return (c) => {
    let o = O[0];
    for (const [at, by] of changes) {
      const t = Math.max(0, Math.min(1, (c - at + LANE_EASE_M / 2) / LANE_EASE_M));
      o += by * t * t * (3 - 2 * t);
    }
    return o;
  };
}

function normal(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  return [-dy / L, dx / L];
}

/** Each corner rounded: the line from CORNER_M before it to CORNER_M after (less where a leg is shorter, or another
 *  corner is near) replaced by a curve through the corner's tangents. Returns [[x, y, c]]. */
function roundCorners(kept) {
  const n = kept.length, cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(kept[i].x - kept[i - 1].x, kept[i].y - kept[i - 1].y));
  const cornerIdx = [];
  for (let i = 1; i + 1 < n; i++) if (kept[i].corner) cornerIdx.push(i);
  const pointAt = (s) => {   // the point s m along the kept line
    let i = 1;
    while (i < n - 1 && cum[i] < s) i++;
    const f = cum[i] > cum[i - 1] ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0, a = kept[i - 1], b = kept[i];
    return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.c + (b.c - a.c) * f];
  };
  const out = [];
  let from = 0;   // the next stretch of the kept line to copy starts here (m)
  cornerIdx.forEach((ci, j) => {
    const prev = j ? cum[cornerIdx[j - 1]] : 0, next = j + 1 < cornerIdx.length ? cum[cornerIdx[j + 1]] : cum[n - 1];
    const d = Math.min(CORNER_M, (cum[ci] - prev) / 2, (next - cum[ci]) / 2);
    if (d < 0.5) return;
    const s0 = cum[ci] - d, s1 = cum[ci] + d;
    for (let i = 0; i < n && cum[i] < s0; i++) if (cum[i] >= from) out.push([kept[i].x, kept[i].y, kept[i].c]);
    const s = pointAt(s0), e = pointAt(s1), p = [kept[ci].x, kept[ci].y], steps = Math.max(4, Math.ceil(2 * d / STEP_M));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      out.push([u * u * s[0] + 2 * u * t * p[0] + t * t * e[0], u * u * s[1] + 2 * u * t * p[1] + t * t * e[1], s[2] + (e[2] - s[2]) * t]);
    }
    from = s1 + 1e-6;
  });
  for (let i = 0; i < n; i++) if (cum[i] >= from) out.push([kept[i].x, kept[i].y, kept[i].c]);
  return out;
}

/** Neighbour averaging (the ends stay put): each pass moves every point halfway to the midpoint of its neighbours. */
function smoothPts(pts, passes) {
  let cur = pts;
  for (let k = 0; k < passes; k++) {
    const next = cur.map(p => p.slice());
    for (let i = 1; i + 1 < cur.length; i++) {
      next[i][0] = cur[i][0] * 0.5 + (cur[i - 1][0] + cur[i + 1][0]) * 0.25;
      next[i][1] = cur[i][1] * 0.5 + (cur[i - 1][1] + cur[i + 1][1]) * 0.25;
    }
    cur = next;
  }
  return cur;
}
