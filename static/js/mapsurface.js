// The road's reference line when the map knows the road: the matcher's horizon (state.map, world/mapmatch.js,
// a centerline polyline in the pose frame) is the road's geometry, whole; nothing of the cameras' lane
// shape is mixed into it. The pose (state.pose: the car's own odometry, with the GPS and heading corrections
// eased in slowly) puts the map into the car frame: that is where we are and which way we point, to a
// degree and a meter or two. What the cameras' lane model adds is *which lane* the car is drawn in: the
// map has no lanes, the GPS and the OSM centerline are both meter-level, so the car is placed in a lane of
// the map's road (counted from the right), and the whole map slides sideways -- slowly, never faster than
// a walking pace -- so that lane's center passes where the cameras see the ego lane's center at the car. A
// lane change moves the lane index, not the map. Without lanes seen the car keeps the lane it had (or
// starts in the right lane); only a GPS that insists for seconds that we are a lane over moves it. The
// lane lines drawn are the map road's own structure (its edges, centerline, lane boundaries) at the lane
// width the cameras measure, so they stay put on the map and never jump with a detection.
//
// Car frame: x ahead of the front bumper, y left, meters; stations s are arc length from the bumper.

export const POLY_MAX = 64;              // points the ground shader takes
const REAR_AXLE_TO_BUMPER = 4.775 - 0.93; // scene.js REAR_AXLE_Z, until the model says
const LANE_W = 3.6;
const DENSE_STEP_NEAR = 2, DENSE_STEP_FAR = 4, DENSE_NEAR_M = 80;   // the lines' sampling
const FAR_FADE = 60;                     // m: the field's fade past the horizon's end
const END_FADE = 12;                     // m: the field's fade where the road itself ends (a T-junction)
const BRANCH_MIN_LANES = 1;
// the placement (see above)
const SHIFT_TAU_S = 1.5;                 // s: the slide closes on its target with this time constant...
const SHIFT_RATE = 0.4;                  // m/s: ...and never faster
const SHIFT_MAX = 12.0;                  // m: the most the map is slid (beyond it the lanes and the map disagree about the road; the
                                         // slide stays at the limit rather than letting go, so nothing jumps)
const LANE_CHANGE_W = 0.5;               // lane widths the ego lane's center jumps by when the cameras move us to the next lane
const GPS_LANE_W = 0.8;                  // lane widths the GPS must put us over by...
const GPS_LANE_S = 5.0;                  // ...for this long, before the drawn lane moves over by one
const HOLD_DECAY_S = 10.0;               // s: with no lanes seen, the last in-lane offset decays to the lane's center over this

const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Linear interpolation on a polyline given by parallel arrays, at station s (clamped to the ends). */
function sample(xs, ys, st, s) {
  const n = st.length;
  if (s <= st[0]) return [xs[0], ys[0], 0];
  if (s >= st[n - 1]) return [xs[n - 1], ys[n - 1], n - 2];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st[m] <= s) lo = m; else hi = m; }
  const f = (s - st[lo]) / (st[hi] - st[lo] || 1);
  return [mix(xs[lo], xs[hi], f), mix(ys[lo], ys[hi], f), lo];
}

/** Unit direction of the polyline's segment i (the last point uses the segment before it). */
function direction(xs, ys, i) {
  const n = xs.length;
  if (n < 2) return [1, 0];
  const k = Math.max(0, Math.min(i, n - 2)), j = k + 1;
  const dx = xs[j] - xs[k], dy = ys[j] - ys[k], L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

/** A carriageway's lanes when the map gives only a count: all ours one way; else halved, an odd one a center turn lane. */
export function splitOf(lanes, oneWay) {
  if (oneWay) return { ours: Math.max(1, lanes), theirs: 0, centre: 0 };
  const n = Math.max(2, lanes), half = Math.floor(n / 2);
  return { ours: half, theirs: half, centre: n % 2 };
}

/** The centers of the lanes going our way, m left of the carriageway's centerline, rightmost first. `split`
 *  ({ours, theirs, centre}, roaddetail.js laneLayout) when OSM says how many go each way. */
export function laneCenters(lanes, oneWay, W = LANE_W, leftTraffic = false, split = null) {
  const { ours, theirs, centre } = split || splitOf(lanes, oneWay);
  const half = (ours + theirs + centre) * W / 2;
  const right = leftTraffic ? (theirs + centre) * W - half : -half;   // our side's right edge
  return Array.from({ length: ours }, (_, k) => Math.round((right + (k + 0.5) * W) * 1e9) / 1e9 + 0);   // (+ 0: no -0)
}

/** A fresh placement state (kept by the view between frames). */
export function freshPlacement() {
  return { lane: null, shift: 0, dh: 0, laneW: LANE_W, hold: 0, yCenterPrev: null, gpsT: 0, wayId: null };
}

/**
 * Where the car is drawn across the map's road, this frame. `place` is the state (freshPlacement()), updated
 * in place; with null, the targets apply at once (no smoothing). frame: { yMap0 (the centerline's y at the
 * car), hMap (its direction, rad, car frame), lanes, oneWay, wayId }. Returns { shift, dh, lane, laneW,
 * laneCenter (m left of the centerline), shown }.
 */
export function placeInLane(place, frame, road, dt) {
  const p = place || freshPlacement();
  const a = road && road.anchor, shown = !!(road && road.shown && a && road.surface && road.surface.reveal > 0.2);
  const k = (tau) => (place ? 1 - Math.exp(-Math.max(0, dt) / tau) : 1);
  // the lane width is the map's (LANE_W): the network's lines are drawn with it for every road, ours included, so the
  // placement must count in the same lanes (the cameras' measured width would put the two out of step)
  if (frame.laneW > 0) p.laneW = frame.laneW;   // the road's own, when OSM gives its width (roaddetail.js)
  const W = p.laneW;
  const centers = laneCenters(frame.lanes, frame.oneWay, W, frame.leftTraffic, frame.split);
  const Lmap = -frame.yMap0;   // the car's offset from the centerline (m left) by the pose
  // the ego lane's center at the car: measured, else the last one decaying to the lane's center
  let yCenter;
  if (shown) {
    yCenter = a.c.y0 - a.offset;
    // the cameras moved us to the next lane (the ego lane's center jumps a lane width: left when we went left): the
    // index follows, the map stays
    if (p.yCenterPrev != null && p.lane != null && Math.abs(yCenter - p.yCenterPrev) > LANE_CHANGE_W * W) p.lane += Math.round((yCenter - p.yCenterPrev) / W);
    p.yCenterPrev = yCenter;
    p.hold = yCenter;
  } else {
    p.yCenterPrev = null;
    p.hold *= place ? Math.exp(-Math.max(0, dt) / HOLD_DECAY_S) : 0;
    yCenter = p.hold;
  }
  if (p.lane == null) {
    // first placement: the lane whose implied position is nearest the GPS's; a two-way road without lanes seen: the outer lane on our traffic side
    let best = frame.leftTraffic && !frame.oneWay ? centers.length - 1 : 0;
    if (shown || frame.oneWay) {
      let err = Infinity;
      centers.forEach((d, i) => { const e = Math.abs((d - yCenter) - Lmap); if (e < err) { err = e; best = i; } });
    }
    p.lane = best;
    p.gpsT = 0;
  }
  p.lane = clamp(p.lane, 0, centers.length - 1);
  // the GPS insisting we are a lane over: move over after a while
  const err = Lmap - (centers[p.lane] - yCenter);
  if (Math.abs(err) > GPS_LANE_W * W) {
    p.gpsT += place ? dt : GPS_LANE_S;
    if (p.gpsT >= GPS_LANE_S) { p.lane = clamp(p.lane + Math.sign(err), 0, centers.length - 1); p.gpsT = 0; }
  } else p.gpsT = Math.max(0, p.gpsT - dt);
  p.wayId = frame.wayId;
  // the slide: the centerline drawn at yCenter - laneCenter, so the ego lane's center is where the cameras see it
  const laneCenter = centers[p.lane];
  const target = clamp((yCenter - laneCenter) - frame.yMap0, -SHIFT_MAX, SHIFT_MAX);
  let dShift = (target - p.shift) * k(SHIFT_TAU_S);
  if (place) dShift = clamp(dShift, -SHIFT_RATE * dt, SHIFT_RATE * dt);
  p.shift += dShift;
  // no turn: the pose's heading (the car's heading sensor, 0.15 deg) places the map's direction; letting the lanes
  // turn it about the car, even by a degree or two, swung everything far ahead as the angle settled
  p.dh = 0;
  return { shift: p.shift, dh: 0, lane: p.lane, laneW: W, laneCenter, shown };
}

/**
 * Build the reference from a snapshot's map, the scene's pose (the frame the horizon is in), this frame's
 * road model output (for the lane placement) and the settings. `place` carries the placement between frames
 * (freshPlacement()); `reveal` is how far the map road has faded in (0..1).
 * Returns null when there is nothing to build from, else
 *  { pts: [[x, y], ...] (<= POLY_MAX, for the shader), st: [stations], dense: {xs, ys, st} (2-4 m sampling for the
 *    lines), width: [right, left] (the carriageway), reveal, reach, back, fade, centerY0, shift, rotated, lane,
 *    laneW, laneCenter, ourLeft, ourRight, branches, structure, lanes, oneWay }.
 */
export function mapReference(map, pose, road, settings, rearAxleZ = REAR_AXLE_TO_BUMPER, place = null, dt = 1 / 60, reveal = 1) {
  if (!map || !map.way || !map.horizon || map.horizon.length < 2 || (settings && settings.mapRoad === false)) return null;
  // the map's road as a smooth curve through its nodes, as the network draws it (roadNetwork), sharp where roads leave
  const corners = new Set();
  for (const b of map.branches || []) {
    const k = map.horizon.findIndex(p => Math.abs(p[0] - b.x) < 0.6 && Math.abs(p[1] - b.y) < 0.6);
    if (k >= 0) corners.add(k);
  }
  const sm = smoothLine(map.horizon, corners), H = sm.pts, n = H.length;
  const ci = sm.index[Math.min(Math.max(map.carIndex || 0, 0), map.horizon.length - 1)];
  const c = Math.cos(pose.h), s = Math.sin(pose.h);
  const xs = new Float64Array(n), ys = new Float64Array(n), st = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = H[i][0] - pose.x, dy = H[i][1] - pose.y;
    xs[i] = c * dx + s * dy - rearAxleZ;   // ahead of the bumper
    ys[i] = -s * dx + c * dy;
  }
  // stations: the rear axle's foot on the line (the segment nearest it around the matched point) is -rearAxleZ,
  // the bumper 0; found here rather than taken from the matcher since the pose shown may trail its estimate
  let seg = Math.max(0, ci - 1), foot = 0, best = Infinity;
  for (let i = Math.max(0, ci - 3); i < Math.min(n - 1, ci + 3); i++) {
    const ax = xs[i], ay = ys[i], bx = xs[i + 1], by = ys[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? clamp(((-rearAxleZ - ax) * dx + (0 - ay) * dy) / L2, 0, 1) : 0;
    const d = Math.hypot(ax + t * dx + rearAxleZ, ay + t * dy);
    if (d < best) { best = d; seg = i; foot = t * Math.sqrt(L2); }
  }
  st[seg] = -rearAxleZ - foot;
  for (let i = seg + 1; i < n; i++) st[i] = st[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  for (let i = seg - 1; i >= 0; i--) st[i] = st[i + 1] - Math.hypot(xs[i] - xs[i + 1], ys[i] - ys[i + 1]);
  // (a horizon that ends at the car -- a junction mid-turn -- still places the map; the field fades where it ends)

  const way = map.way;
  const leftTr = settings?.trafficSide === 'left';
  // the carriageway: the lanes each way and their width, from OSM's full detail when there is some (roaddetail.js)
  const lay = way.layout || { ...splitOf(way.lanes || 0, !!way.oneWay), laneW: LANE_W, turns: null };
  const split = { ours: lay.ours, theirs: lay.theirs, centre: lay.centre };
  const lanes = split.ours + split.theirs + split.centre;
  // the map line at the car: its y and direction (station 0)
  const [, yMap0, seg0] = sample(xs, ys, st, 0);
  const [ux, uy] = direction(xs, ys, seg0);
  const hMap = Math.atan2(uy, ux);
  const pl = placeInLane(place, { yMap0, hMap, lanes, oneWay: !!way.oneWay, wayId: way.id, leftTraffic: leftTr, split, laneW: lay.laneW }, road, dt);
  const W = pl.laneW, half = lanes * W / 2, shift = pl.shift, dh = pl.dh;
  // the rigid placement: rotate about the car's spot on the line (station 0), slide sideways
  const px0 = 0, py0 = yMap0;
  const cr = Math.cos(dh), sr = Math.sin(dh);
  const refX = new Float64Array(n), refY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - px0, dy = ys[i] - py0;
    refX[i] = px0 + cr * dx - sr * dy;
    refY[i] = py0 + sr * dx + cr * dy + shift;
  }
  const centerY0 = yMap0 + shift;

  // the shader's polyline: at most POLY_MAX points, thinned from the far end first
  let pts = Array.from(refX, (x, i) => [x, refY[i]]), pst = Array.from(st);
  while (pts.length > POLY_MAX) {
    const keep = [], ks = [];
    for (let i = 0; i < pts.length; i++) if (i === 0 || i === pts.length - 1 || i % 2 === 0 || pst[i] < 100) { keep.push(pts[i]); ks.push(pst[i]); }
    if (keep.length === pts.length) { keep.length = POLY_MAX; ks.length = POLY_MAX; }
    pts = keep; pst = ks;
  }
  // a dense sampling for the lane strips
  const dXs = [], dYs = [], dSt = [];
  for (let si = Math.max(st[0], -30); si <= st[n - 1]; si += si < DENSE_NEAR_M ? DENSE_STEP_NEAR : DENSE_STEP_FAR) {
    const [x, y] = sample(refX, refY, st, si);
    dXs.push(x); dYs.push(y); dSt.push(si);
  }
  // the road's lane structure, as offsets from the reference line (the carriageway's center): the centerline of a
  // two-way road (both edges of a center turn lane), the boundaries between lanes, the edges. The two lines
  // bounding the lane the car is drawn in are tagged L1 / R1 so the view can color them as the ego lane's.
  const structure = [];
  const egoR = pl.laneCenter - W / 2, egoL = pl.laneCenter + W / 2;
  const tag = (d) => (Math.abs(d - egoR) < 1e-6 ? 'R1' : Math.abs(d - egoL) < 1e-6 ? 'L1' : null);
  const push = (d, kind) => structure.push({ d, kind, ego: tag(d) });
  // from the right edge: the lanes on the right of the centerline (ours, or theirs driving on the left), the shared
  // center lane(s), the rest; the lines either side of the shared part are the center lines
  const R = leftTr ? split.theirs : split.ours;
  for (let k = 1; k < lanes; k++) push(-half + k * W, !way.oneWay && (k === R || k === R + split.centre) ? 'center' : 'lane');
  push(half, 'edge'); push(-half, 'edge');
  // the roads leaving the horizon, placed the same way (pose, then the turn and slide)
  const toCar = (wx, wy) => {
    const dx = wx - pose.x, dy = wy - pose.y;
    const x = c * dx + s * dy - rearAxleZ, y = -s * dx + c * dy;
    const rx = x - px0, ry = y - py0;
    return [px0 + cr * rx - sr * ry, py0 + sr * rx + cr * ry + shift];
  };
  const branches = [];
  for (const b of map.branches || []) {
    if (!b.pts || b.pts.length < 2) continue;
    const bl = b.oneWay ? Math.max(BRANCH_MIN_LANES, b.lanes || 0) : Math.max(2, b.lanes || 0);
    branches.push({ pts: b.pts.map(p => toCar(p[0], p[1])), width: b.layout ? b.layout.width : bl * LANE_W, laneW: b.layout ? b.layout.laneW : LANE_W, along: b.along, angle: b.angle, name: b.name, ref: b.ref, className: b.className, oneWay: b.oneWay,
      merge: !!b.merge, end: !!b.end, continuation: !!b.continuation });
  }
  return {
    pts, st: pst,
    line: { xs: refX, ys: refY, st },   // the reference at full resolution (the horizon's nodes are its vertices)
    dense: { xs: dXs, ys: dYs, st: dSt },
    width: [-half, half],
    reveal: clamp(reveal, 0, 1),
    reach: st[n - 1], back: -st[0], fade: map.ended ? END_FADE : FAR_FADE,
    centerY0, yMap0, shift, rotated: dh,   // the placement: the map line's y at the bumper by the pose, the slide and the turn about (0, yMap0)
    lane: pl.lane, laneW: W, laneCenter: pl.laneCenter, lanesShown: pl.shown,
    ourLeft: leftTr ? half : -half + split.ours * W, ourRight: leftTr ? half - split.ours * W : -half,   // our carriageway's bounds, m left of the reference line
    branches, structure,
    lanes, oneWay: !!way.oneWay, split, turns: lay.turns || null,
  };
}

/**
 * The rigid placement the reference gives the road we're on -- in the car frame (origin at the bumper) the map was
 * turned by `rotated` about (0, yMap0) and slid by `shift` to the left -- as a transform of the pose frame, for the
 * view's ground-fixed map layers (roadnet.js, mapfeatures.js), whose group axes are X = -y, Y = up, Z = -x of the
 * pose frame. Returns the 4 x 4 matrix, column-major (THREE.Matrix4.fromArray), or null for the identity.
 * pose: the view's pose (rear axle, x east, y north, h), rearAxleZ: the axle to the bumper.
 */
export function mapAlignMatrix(ref, pose, rearAxleZ) {
  if (!ref || (!ref.shift && !ref.rotated)) return null;
  const c = Math.cos(pose.h), s = Math.sin(pose.h);
  // the turn's center in the pose frame: rearAxleZ ahead of the axle, yMap0 to the left
  const Px = pose.x + c * rearAxleZ - s * ref.yMap0, Py = pose.y + s * rearAxleZ + c * ref.yMap0;
  const cr = Math.cos(ref.rotated), sr = Math.sin(ref.rotated);
  // q' = R q + t in the pose frame
  const tx = Px - (cr * Px - sr * Py) - s * ref.shift, ty = Py - (sr * Px + cr * Py) + c * ref.shift;
  // in the group's axes: for a local point L = M p (p in the pose frame, M the axis swap), L' = M A M^-1 L. With
  // X = -y, Y = z, Z = -x: a pose-frame vector (vx, vy) is the local (-vy, 0, -vx), and the rotation about the up axis
  // keeps its sense (the swap is a rotation, not a reflection, when the up axis is counted)
  //   x' = cr x - sr y + tx,  y' = sr x + cr y + ty   =>   X' = -y' = -sr x - cr y - ty = cr X + sr Z - ty  (x = -Z, y = -X)
  //                                                      Z' = -x' = -cr x + sr y - tx = -sr X + cr Z - tx
  return [
    cr, 0, -sr, 0,     // column 1: the image of local X
    0, 1, 0, 0,        // column 2: up
    sr, 0, cr, 0,      // column 3: the image of local Z
    -ty, 0, -tx, 1,    // column 4: the translation
  ];
}

/**
 * The map road as the road frame furniture and the nav arrow anchor to (road.js RoadModel's `place`, `laneEdge`,
 * `odo`, `width`, `lanesShown`): s m down the reference line, d m left of the ego lane's center, on the road as drawn.
 */
export function mapRoadFrame(ref, odo) {
  const { xs, ys, st } = ref.dense;
  const lc = ref.laneCenter;
  return {
    odo, width: ref.laneW, lanesShown: true,
    place(s, d) {
      const [x, y, seg] = sample(xs, ys, st, s);
      const [ux, uy] = direction(xs, ys, seg);
      const off = lc + d;
      return { x: x - uy * off, y: y + ux * off, h: Math.atan2(uy, ux) };
    },
    laneEdge(side) { return (side > 0 ? ref.ourLeft : ref.ourRight) - lc; },
  };
}

/** Unit left normal of the dense polyline at index i. */
function normalAt(ref, i) {
  const [dx, dy] = direction(ref.dense.xs, ref.dense.ys, i);
  return [-dy, dx];
}

/**
 * A lane line along the reference: the map line offset sideways by the line's distance from the ego lane's
 * center as the cameras measure it at the car (`c.y0 - centerY0` for a measured line's quadratic `c`, or `d`
 * for an inferred one). Returns [[x, y], ...] in the car frame.
 */
export function lineAlong(ref, c, d = null) {
  const { xs, ys } = ref.dense;
  const off = c ? c.y0 - ref.centerY0 : d;
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const [nx, ny] = normalAt(ref, i);
    out.push([xs[i] + nx * off, ys[i] + ny * off]);
  }
  return out;
}

// ---- junctions ------------------------------------------------------------------------------------------
//
// Where a road leaves (or joins) the one we're on, draw what a map would: the arm's edges don't stop dead at
// our edge, they curve into it (fillets: tight at a street corner, long and shallow at a ramp's gore), our edge
// line opens across the mouth between the two fillets, and inside a crossing our lane dashes stop. The arm
// itself is a strip of road between its two filleted edges, with its own centerline or lane boundaries
// starting past the mouth. Everything is in the car frame; stations are along our own reference line.

const R_ACUTE = 2.0, R_RIGHT = 6.0, R_OBTUSE = 4.0;   // fillet radii by the corner's angle
const FILLET_MAX_D = 30;                              // m: a gore's taper, at most
const PARALLEL = Math.sin(20 * Math.PI / 180);        // |sin| below which an arm is a fork or a split of the road, not a side road: the strips
                                                      // show it, there is no mouth to round off (fillets of nearly parallel edges degenerate)...
const PARALLEL_RAMP = Math.sin(5 * Math.PI / 180);    // ...unless it is a one-way link (an exit ramp leaves at 10-15 deg with a real gore)
const CORNER_MAX_M = 120;                             // m from the node a corner may lie (a 3 deg fork's inner edges meet 7 m apart
                                                      // 137 m on); beyond that the lines are as good as parallel
const BOX_ANGLE = 60 * Math.PI / 180;                 // an arm turning more than this makes an intersection, not an exit
const BOX_PAIR_M = 15;                                // arms on both sides this close in station form one crossing
const ARC_N = 8;
const BEHIND_ARMS_M = 55;                             // arms are kept this far behind the car (the reference reaches 60 m back)
const VERTEX_SNAP = 0.6;                              // m: a branch's node this close to a reference vertex is that vertex

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const norm = (a) => { const L = Math.hypot(a[0], a[1]) || 1; return [a[0] / L, a[1] / L]; };
const left = (u) => [-u[1], u[0]];

/** Intersection of the lines p + a*u and q + b*v: [a, b], or null when parallel. */
function meet(p, u, q, v) {
  const den = cross(u, v);
  if (Math.abs(den) < 1e-9) return null;
  const d = sub(q, p);
  return [cross(d, v) / den, cross(d, u) / den];
}

/**
 * Where an arm's edge (through B along ub) meets our edge at a node P: our road arrives at P along umIn and leaves along
 * umOut; the edge is offset `off` to the left of each. The corner before the node lies on the arriving segment's edge
 * line, the one after it on the departing segment's. Returns {C, a (station from P along that segment), t (along the
 * arm from B), um (the segment's direction)} or null.
 */
function cornerOn(P, umIn, umOut, off, B, ub) {
  const on = (um) => { const E = add(P, mul(left(um), off)); const ab = meet(E, um, B, ub); return ab ? { C: add(E, mul(um, ab[0])), a: ab[0], t: ab[1], um } : null; };
  const kIn = on(umIn);
  if (kIn && kIn.a <= 0) return kIn;
  const kOut = on(umOut);
  if (kOut && kOut.a >= 0) return kOut;
  return kIn || kOut;
}

/** Points of a quadratic Bezier from a through (toward) c to b: a round enough fillet. */
function fillet(a, c, b) {
  const out = [];
  for (let i = 0; i <= ARC_N; i++) {
    const t = i / ARC_N, s = 1 - t;
    out.push([s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]]);
  }
  return out;
}

/** Cumulative arc length of a polyline. */
function cumulative(pts) {
  const st = [0];
  for (let i = 1; i < pts.length; i++) st.push(st[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return st;
}

/** A polyline resampled at n points by arc length. */
export function resample(pts, n) {
  if (pts.length < 2) return pts.slice();
  const st = cumulative(pts), L = st[st.length - 1], out = [];
  for (let k = 0; k < n; k++) {
    const s = L * k / (n - 1);
    let i = 1;
    while (i < st.length - 1 && st[i] < s) i++;
    const f = st[i] - st[i - 1] > 0 ? (s - st[i - 1]) / (st[i] - st[i - 1]) : 0;
    out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]);
  }
  return out;
}

/** The part of a polyline from arc length `from` on, starting exactly there (or [] when it's shorter). */
export function fromDistance(pts, from) {
  const st = cumulative(pts);
  for (let i = 1; i < pts.length; i++) {
    if (st[i] >= from) {
      const f = st[i] - st[i - 1] > 0 ? (from - st[i - 1]) / (st[i] - st[i - 1]) : 0;
      return [[pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f], ...pts.slice(i)];
    }
  }
  return [];
}

/** The polyline with a vertex inserted at arc length s (unchanged when s falls on a vertex or outside). */
function insertAt(pts, s) {
  const st = cumulative(pts);
  for (let i = 1; i < pts.length; i++) {
    if (s <= st[i - 1] + 0.01 || s >= st[i] - 0.01) continue;
    const f = (s - st[i - 1]) / (st[i] - st[i - 1]);
    return [...pts.slice(0, i), [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f], ...pts.slice(i)];
  }
  return pts;
}

/** A polyline offset to its left by d[i] * sign at each point (neighbours give the direction). */
function offsetPolyVar(pts, ds, sign) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const u = norm(sub(b, a)), d = ds[i] * sign;
    return [p[0] - u[1] * d, p[1] + u[0] * d];
  });
}

const SMOOTH_STEP = 3;          // m: the most a smoothed road's points lie apart
const SMOOTH_MAX_TURN = 35 * Math.PI / 180;    // a node turning more than this stays a corner (a junction turn, a street corner): OSM
                                               // draws a curve as many small turns

/**
 * A road's OSM nodes joined by a centripetal Catmull-Rom curve rather than straight segments: points added every
 * SMOOTH_STEP m between nodes, the nodes themselves kept exactly (junctions are found by shared node coordinates, and
 * the curve still passes through them). Nodes in `corners` (indices: junctions, where other roads leave) stay sharp,
 * as does any node turning more than SMOOTH_MAX_TURN. `before` / `after`: the next node of the road beyond each end when
 * it goes on in another way, so the two ways leave their shared node along the same tangent and their edges meet.
 * Returns { pts, index } where index[i] is node i's place in pts.
 */
export function smoothLine(nodes, corners = null, before = null, after = null) {
  if (before || after) {
    const ext = [...(before ? [before] : []), ...nodes, ...(after ? [after] : [])], o = before ? 1 : 0;
    const shifted = corners ? new Set([...corners].map(i => i + o)) : null;
    const r = smoothLine(ext, shifted);
    const index = r.index.slice(o, o + nodes.length);
    return { pts: r.pts.slice(index[0], index[index.length - 1] + 1), index: index.map(i => i - index[0]) };
  }
  const n = nodes.length, pts = [], index = [];
  if (n < 3) { nodes.forEach((p, i) => { index.push(pts.length); pts.push(p); }); return { pts, index }; }
  const at = (i) => nodes[Math.max(0, Math.min(n - 1, i))];
  const turn = (i) => {   // the turn at node i (0 at the ends; a kept corner counts as sharp)
    if (i <= 0 || i >= n - 1) return 0;
    if (corners && corners.has(i)) return Math.PI;
    const u = norm(sub(nodes[i], nodes[i - 1])), v = norm(sub(nodes[i + 1], nodes[i]));
    return Math.abs(Math.atan2(cross(u, v), dot(u, v)));
  };
  for (let i = 0; i < n - 1; i++) {
    index.push(pts.length);
    pts.push(nodes[i]);
    const p1 = nodes[i], p2 = nodes[i + 1], L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.ceil(L / SMOOTH_STEP);
    if (k < 2) continue;
    // an end, or a corner too sharp to round, gets a straight-on tangent (its neighbour mirrored through it)
    const p0 = i === 0 || turn(i) > SMOOTH_MAX_TURN ? sub(mul(p1, 2), p2) : at(i - 1);
    const p3 = i + 1 === n - 1 || turn(i + 1) > SMOOTH_MAX_TURN ? sub(mul(p2, 2), p1) : at(i + 2);
    // centripetal parameterisation (alpha 0.5): no loops or overshoot at uneven node spacing
    const d = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0, t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const lerp = (a, b, ta, tb, t) => add(mul(a, (tb - t) / (tb - ta)), mul(b, (t - ta) / (tb - ta)));
    for (let j = 1; j < k; j++) {
      const t = t1 + (t2 - t1) * j / k;
      const a1 = lerp(p0, p1, t0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
      const c = lerp(b1, b2, t1, t2, t);
      pts.push(c);
    }
  }
  index.push(pts.length);
  pts.push(nodes[n - 1]);
  return { pts, index };
}

/** A polyline offset to its left by d (uses each point's neighbours for the direction). */
function offsetPoly(pts, d) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const u = norm(sub(b, a));
    return [p[0] - u[1] * d, p[1] + u[0] * d];
  });
}

/** Split a line (points with ascending stations) into the pieces outside the given [s0, s1] intervals, cut exactly
 *  at the interval ends (a point is interpolated there), so a sparse polyline -- OSM nodes can be 100 m apart --
 *  loses just the opening, not its whole segment. */
export function cutByStations(pts, st, intervals) {
  if (!intervals.length) return [pts];
  const sorted = intervals.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const [a, b] of sorted) { const m = merged[merged.length - 1]; if (m && a <= m[1]) m[1] = Math.max(m[1], b); else merged.push([a, b]); }
  const inside = (s) => merged.some(([a, b]) => s >= a && s <= b);
  const at = (i, s) => { const f = (s - st[i]) / (st[i + 1] - st[i] || 1); return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; };
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length >= 2) out.push(cur); cur = []; };
  for (let i = 0; i < pts.length; i++) {
    const s = st[i];
    if (inside(s)) flush(); else cur.push(pts[i]);
    if (i + 1 >= pts.length) break;
    const s1 = st[i + 1];
    const bounds = [];   // the interval ends crossed within this segment, in order
    for (const [a, b] of merged) { if (a > s && a < s1) bounds.push([a, true]); if (b > s && b < s1) bounds.push([b, false]); }
    bounds.sort((p, q) => p[0] - q[0]);
    for (const [sb, entering] of bounds) {
      if (entering) { cur.push(at(i, sb)); flush(); } else cur = [at(i, sb)];
    }
  }
  flush();
  return out;
}

/**
 * The junction geometry for the reference's branches. hm = {left, right}: the main road's half widths
 * (from its centerline) on each side. Returns { arms: [{strip: {left, right} (two boundaries, equal counts),
 * edges: [polyline], arcs: [polyline], center: polyline | null, lanes: [polyline], along, angle, merge, name}],
 * cuts: {left: [[s0, s1]], right: [...], all: [...]} } with cuts as station intervals along the reference.
 */
export function junctions(ref, hm) {
  const arms = [], mouths = [];
  const { xs, ys, st } = ref.dense;
  const line = ref.line;
  for (const b of ref.branches || []) {
    if (b.along < -BEHIND_ARMS_M || b.pts.length < 2) continue;
    const bp = densifyPts(b.pts, 3);
    const P0 = bp[0];
    // our direction and station at the junction: the node is a vertex of the reference (a horizon node ahead, a passed
    // node in the trail behind), and the direction we *arrive* there with is the segment ending at it -- exact and the
    // same from frame to frame (the reference may turn at the node, the horizon bending into the road we're taking: the
    // arms are the roads leaving the one we come in on). A node that isn't a vertex falls back to the nearest dense point.
    // our road may bend at the node: the corner before the node lies on the arriving segment's edge, the one after it
    // on the departing segment's (the network opens its lines by the same rule, so the two meet)
    let umIn = null, umOut = null, s0 = 0;
    if (line) {
      for (let k = 1; k < line.xs.length; k++) {
        if (Math.abs(line.xs[k] - P0[0]) < VERTEX_SNAP && Math.abs(line.ys[k] - P0[1]) < VERTEX_SNAP) {
          umIn = norm([line.xs[k] - line.xs[k - 1], line.ys[k] - line.ys[k - 1]]);
          umOut = k + 1 < line.xs.length ? norm([line.xs[k + 1] - line.xs[k], line.ys[k + 1] - line.ys[k]]) : umIn;
          s0 = line.st[k];
          break;
        }
      }
    }
    if (!umIn) {
      let ni = 0, best = Infinity;
      for (let i = 0; i < xs.length; i++) { const d2 = (xs[i] - P0[0]) ** 2 + (ys[i] - P0[1]) ** 2; if (d2 < best) { best = d2; ni = i; } }
      umIn = direction(xs, ys, Math.max(0, ni - 1));
      umOut = direction(xs, ys, ni);
      s0 = st[ni] + dot(sub(P0, [xs[ni], ys[ni]]), umIn);
    }
    if (b.end) umOut = umIn;   // our road ends here: there is no departing segment of ours
    const ub = norm(sub(bp[1], P0));
    const sin = cross(umIn, ub);
    const ramp = b.oneWay && /_link$/.test(b.className || '');
    if (Math.abs(sin) < (ramp ? PARALLEL_RAMP : PARALLEL)) continue;   // runs alongside: nothing to cut or round
    const side = sin > 0 ? 1 : -1;
    const H = side > 0 ? hm.left : hm.right, hb = b.width / 2;
    const nb = left(ub);
    const corners = [];
    for (const j of [1, -1]) {
      const B = add(P0, mul(nb, j * hb));
      const k = cornerOn(P0, umIn, umOut, side * H, B, ub);
      if (!k || Math.abs(k.a) > CORNER_MAX_M) continue;
      corners.push({ j, C: k.C, sC: s0 + k.a, tC: k.t, um: k.um });
    }
    corners.sort((p, q) => p.sC - q.sC);
    // where our road ends at the node (a T, a Y: `end`), only the corner on our side of the node is real; the arm's far
    // edge is the through road's, running on untouched
    if (b.end) { while (corners.length && corners[0].sC > s0 + 0.01) corners.shift(); corners.length = Math.min(corners.length, 1); }
    if (corners.length < (b.end ? 1 : 2)) continue;
    const arcs = [], edges = [], bounds = {};
    let cutFrom = Infinity, cutTo = -Infinity;
    corners.forEach((k, idx) => {
      const upstream = idx === 0;
      const e1 = upstream ? mul(k.um, -1) : k.um, e2 = ub;
      const alpha = Math.acos(Math.max(-1, Math.min(1, dot(e1, e2))));
      const R = alpha > 100 * Math.PI / 180 ? R_OBTUSE : alpha > 50 * Math.PI / 180 ? R_RIGHT : R_ACUTE;
      let d = alpha > 1e-3 ? R / Math.tan(alpha / 2) : FILLET_MAX_D;
      d = Math.min(d, FILLET_MAX_D, Math.max(1, k.tC + 25));
      const T1 = add(k.C, mul(e1, d)), T2 = add(k.C, mul(e2, d));
      const arc = fillet(T1, k.C, T2);
      arcs.push(arc);
      // our edge opens from the upstream tangent point to the downstream one
      const sT1 = upstream ? k.sC - d : k.sC + d;
      cutFrom = Math.min(cutFrom, sT1); cutTo = Math.max(cutTo, sT1);
      // the arm's edge: from the tangent point on out along the arm
      const edgePoly = offsetPoly(bp, k.j * hb);
      const beyondT2 = fromDistance(edgePoly, Math.max(0, k.tC + d));
      const edge = [T2, ...beyondT2.slice(beyondT2.length && Math.hypot(beyondT2[0][0] - T2[0], beyondT2[0][1] - T2[1]) < 0.5 ? 1 : 0)];
      edges.push(edge);
      bounds[k.j] = [...arc, ...edge.slice(1)];
    });
    if (b.end) {
      // the far bound: the arm's far edge from the node on; our edge opens from the fillet to the node
      const jFar = -corners[0].j;
      bounds[jFar] = offsetPoly(bp, jFar * hb);
      cutTo = Math.max(cutTo, s0 + 0.5);
    }
    if (!(cutFrom < cutTo)) continue;
    // the arm's own markings start past the mouth
    const start = Math.max(...corners.map(k => k.tC)) + 2;
    let center = null;
    const lanes = [];
    const bW = b.laneW || LANE_W, bl = Math.max(1, Math.round(b.width / bW));
    if (!b.oneWay) center = fromDistance(bp, start);
    else for (let k = 1; k < bl; k++) lanes.push(fromDistance(offsetPoly(bp, -hb + k * bW), start));
    const N = 24;
    arms.push({ strip: { left: resample(bounds[1], N), right: resample(bounds[-1], N) }, edges, arcs, center: center && center.length >= 2 ? center : null,
      lanes: lanes.filter(l => l.length >= 2), along: b.along, angle: b.angle, merge: !!b.merge, name: b.name || b.ref || '', side, s0, crossing: Math.abs(b.angle) * Math.PI / 180 > BOX_ANGLE });
    mouths.push({ side, s0, from: cutFrom, to: cutTo, crossing: Math.abs(b.angle) * Math.PI / 180 > BOX_ANGLE });
  }
  // what our lines lose: the edge across each mouth; everything across a crossing with arms on both sides
  const cuts = { left: [], right: [], all: [] };
  for (const m of mouths) (m.side > 0 ? cuts.left : cuts.right).push([m.from, m.to]);
  for (const m of mouths) {
    if (!m.crossing) continue;
    const other = mouths.find(o => o !== m && o.side !== m.side && o.crossing && Math.abs(o.s0 - m.s0) < BOX_PAIR_M);
    if (other && m.side > 0) cuts.all.push([Math.min(m.from, other.from), Math.max(m.to, other.to)]);
  }
  return { arms, cuts };
}

function densifyPts(pts, step) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = 0; j < n; j++) out.push([x0 + (x1 - x0) * j / n, y0 + (y1 - y0) * j / n]);
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

// ---- the road network around the car -------------------------------------------------------------------
//
// The map itself, as a map would draw it: every road within reach as a strip in its own width, its edges,
// a centerline on two-way roads and lane boundaries on multi-lane one-way ones, with the lines broken where
// roads meet so junctions read as openings, not as lines crossing each other: an edge opens between the
// fillets' tangent points (the same geometry `junctions` draws the fillets with, so the two meet), the inner
// lines across the other road's width. A way that simply goes on into the next (the same road split into
// two ways, a shallow end-to-end bend) opens nothing. The layer comes from the worker in the pose frame
// (state.js `_roadsLayer`), which is also the frame of the view's ground group, so the geometry is built
// once per layer and stays put while the car drives over it. This is the only source of lane lines for
// every road, the one we're on included (the field highlights the ego lane's two on top of them).

const NET_LINE_LIFT = -0.002;   // below the tires' contact plane; over the strips by polygon offset (roadnet.js)
const TAPER_M = 20;             // m over which a road's width eases into a wider or narrower way of the same road
const NODE_CLEAR = 1.0;                  // m past the other road's half width that an inner line stops before a shared node
const PARALLEL_ANG = 5 * Math.PI / 180;  // a way leaving within this of our line runs with us: no opening
const CONTINUE_ANG = 25 * Math.PI / 180; // end to end at less than this: the road goes on, no opening
const EDGE_INSET = 0.3;                  // m: the edge lines sit this far in from the strip's edge, as painted ones do
const ARROW_FROM_END = [12, 42];         // m before a junction the turn arrows are painted (their tips)
const ARROW_LEN = 6;                     // m, at full size
const ARROW_SCALE = 0.75;                // the arrows' size in a wide lane
const ARROW_REACH = 1.5;                 // m: how far a bent arrow reaches to the side at full size
const ARROW_CLEAR = 0.6;                 // m: kept clear inside the lane's edge (an edge line is painted 0.3 m in)

// The turn arrows' shapes, in meters along the lane (u, from the tail) and to its left (v): triangles. Through: a shaft
// and a head; left and right: the shaft bending off at the top with the head pointing the new way.
const bar = (a, b, w) => { const d = norm(sub(b, a)), n = mul(left(d), w / 2); return [[add(a, n), sub(a, n), add(b, n)], [sub(a, n), sub(b, n), add(b, n)]]; };
const head = (p, d, len, hw) => { const n = mul(left(d), hw); return [[add(p, n), sub(p, n), add(p, mul(d, len))]]; };
function arrowShape(turn) {
  const L = ARROW_LEN, W = 0.3;
  const bend = (side, k) => {   // k: how far it turns (1 a turn, 0.5 a slight one)
    const top = [L * 0.5, 0], end = [L * 0.5 + 1.3, side * 0.75 * k], d = norm(sub(end, top));   // inside a 3 m lane
    return [...bar([0, 0], top, W), ...bar(top, end, W), ...head(end, d, 1.3, 0.45)];
  };
  switch (turn) {
    case 'through': return [...bar([0, 0], [L - 1.6, 0], W), ...head([L - 1.6, 0], [1, 0], 1.6, 0.5)];
    case 'left': case 'sharp_left': return bend(1, 1);
    case 'right': case 'sharp_right': return bend(-1, 1);
    case 'slight_left': case 'merge_to_left': return bend(1, 0.5);
    case 'slight_right': case 'merge_to_right': return bend(-1, 0.5);
    default: return [];   // none, reverse, anything else: no arrow
  }
}

/** The point and unit direction at station s of a polyline with stations st. */
function pointAt(pts, st, s) {
  let i = 1;
  while (i < pts.length - 1 && st[i] < s) i++;
  const a = pts[i - 1], b = pts[i], f = (s - st[i - 1]) / ((st[i] - st[i - 1]) || 1);
  return [add(a, mul(sub(b, a), clamp(f, 0, 1))), norm(sub(b, a))];
}

/** Build the network's drawing geometry from a roads layer. `usLines`: a two-way road's center is the double yellow
 *  line, else (the UK and Europe) a white one: dashed where traffic may cross it, solid where it may not, and a double
 *  line (one of each, or two solid) where only one side may (ukCenter; the lanes and bend rules only driving on the left).
 *  Returns { strips: [{left, right}], edges: [polyline], centers: [polyline] (dashed when single), solids: [polyline]
 *  (solid white center lines), yellowDashed: [polyline] (US passing lines), centerStyle: 'double' | 'single', lanes: [polyline], arrows: [triangle] } in the pose frame. */
const UK_DOUBLE = 0.14;   // m: each line of a double white line from its middle

/** Whether traffic each way may cross a UK-style center line: { fwd, bwd } (fwd: the traffic going with the way's
 *  nodes). OSM's overtaking or divider tags when it has them; else a road with more lanes one way than the other (a
 *  climbing or overtaking lane) or two or more lanes each way has a solid double line; else a dashed one. */
export function ukCenter(w, uk = true) {
  let fwd = w.passFwd ?? null, bwd = w.passBwd ?? null;
  if (fwd != null && bwd != null) return { fwd, bwd };
  if (fwd != null || bwd != null) return { fwd: fwd ?? true, bwd: bwd ?? true };
  if (!uk) return { fwd: null, bwd: null };   // elsewhere OSM's tags only; null: the country's usual line
  const f = w.detailed && w.fwd != null ? w.fwd : null, b = w.detailed && w.bwd != null ? w.bwd : null;
  let dFwd = true, dBwd = true;
  if (f != null && b != null && !w.centre) {
    if (f !== b || f >= 2) dFwd = dBwd = false;
  } else if (!w.detailed && (w.lanes || 0) >= 4 && !w.centre) dFwd = dBwd = false;
  return { fwd: dFwd, bwd: dBwd };
}

const BEND_ACCEL = 2.45;     // m/s^2: a bend tighter than v^2 / this at the road's speed gets a solid line (60 mph: 290 m, 30 mph: 75 m)
const BEND_CHORD = 25;       // m either side of a point over which its bend's radius is measured
const BEND_LEAD = 40;        // m: the solid line starts this far before the bend and runs on as far after it
const CLASS_SPEED = { motorway: 31.3, trunk: 26.8, primary: 26.8, secondary: 26.8, tertiary: 26.8, unclassified: 26.8 };   // m/s, the national limit

/** Station intervals of a way's line through bends too tight for its speed (maxSpeed, else its class's national limit,
 *  else 30 mph), with their lead-ins. */
export function blindBends(pts, st, w) {
  const L = st[st.length - 1];
  const v = w.maxSpeed > 0 ? w.maxSpeed : CLASS_SPEED[(w.className || '').replace(/_link$/, '')] || 13.4;
  const rMin = v * v / BEND_ACCEL, out = [];
  if (L < 2 * BEND_CHORD) return out;
  let run = null;
  for (let s = BEND_CHORD; s <= L - BEND_CHORD; s += 5) {
    const [a] = pointAt(pts, st, s - BEND_CHORD), [b] = pointAt(pts, st, s), [c] = pointAt(pts, st, s + BEND_CHORD);
    // the circle through three points: R = |ab| |bc| |ca| / (2 |ab x ac|)
    const area2 = Math.abs(cross(sub(b, a), sub(c, a)));
    const R = area2 > 1e-9 ? Math.hypot(...sub(b, a)) * Math.hypot(...sub(c, b)) * Math.hypot(...sub(a, c)) / (2 * area2) : Infinity;
    if (R < rMin) { if (run && s - BEND_LEAD <= run[1]) run[1] = s + BEND_LEAD; else out.push(run = [s - BEND_LEAD, s + BEND_LEAD]); }
  }
  return out.map(([a, b]) => [Math.max(0, a), Math.min(L, b)]);
}

/** The complement of sorted, disjoint intervals within [0, L]. */
function outside(intervals, L) {
  const out = []; let s = -1;
  for (const [a, b] of intervals) { out.push([s, a]); s = b; }
  out.push([s, L + 1]);
  return out;
}

export function roadNetwork(layer, leftTraffic = false, usLines = !leftTraffic) {
  const out = { strips: [], edges: [], centers: [], solids: [], yellowDashed: [], centerStyle: usLines ? 'double' : 'single', lanes: [], arrows: [] };
  if (!layer || !layer.ways) return out;
  const key = (p) => p[0] + ',' + p[1];
  // each road a smooth curve through its OSM nodes (smoothLine), kept sharp at the nodes it shares with another road
  const raw = layer.ways.filter(w => w.pts.length >= 2), uses = new Map();
  for (const w of raw) for (const p of w.pts) uses.set(key(p), (uses.get(key(p)) || 0) + 1);
  // a road split into ways end to end (two ways sharing an end node, nothing else there) carries on smoothly across it
  const ends = new Map();   // end node -> [{w, at: the neighbour node inside that way}]
  for (const w of raw) for (const [i, j] of [[0, 1], [w.pts.length - 1, w.pts.length - 2]]) {
    const k = key(w.pts[i]);
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push({ w, at: w.pts[j] });
  }
  const beyond = (w, i) => {
    const k = key(w.pts[i]), e = ends.get(k);
    if (uses.get(k) !== 2 || !e || e.length !== 2) return null;
    const o = e.find(x => x.w !== w);
    if (!o) return null;
    const p = w.pts[i], inner = w.pts[i === 0 ? 1 : w.pts.length - 2];
    const u = norm(sub(p, inner)), v = norm(sub(o.at, p));
    return Math.acos(clamp(dot(u, v), -1, 1)) < SMOOTH_MAX_TURN ? o.at : null;
  };
  const ways = raw.map(w => {
    const corners = new Set(), b = beyond(w, 0), a = beyond(w, w.pts.length - 1);
    w.pts.forEach((p, i) => { if (uses.get(key(p)) > 1 && !(i === 0 && b) && !(i === w.pts.length - 1 && a)) corners.add(i); });
    return { ...w, pts: smoothLine(w.pts, corners, b, a).pts };
  });
  // shared nodes: coordinate -> [{wi, i}]
  const nodes = new Map();
  ways.forEach((w, wi) => w.pts.forEach((p, i) => { const k = key(p); if (!nodes.has(k)) nodes.set(k, []); nodes.get(k).push({ wi, i }); }));
  const leaving = (w, i) => {
    const o = [], p = w.pts[i];
    if (i + 1 < w.pts.length) o.push(norm(sub(w.pts[i + 1], p)));
    if (i > 0) o.push(norm(sub(w.pts[i - 1], p)));
    return o;
  };
  // where a road goes on into a way of another width (lanes gained or lost), the width eases over TAPER_M rather than
  // stepping: the half width per point, from the narrower neighbour's at the shared end
  const continuesInto = (w, i) => {
    const here = nodes.get(key(w.pts[i]));
    if (!here) return null;
    const um = i > 0 ? norm(sub(w.pts[i], w.pts[i - 1])) : norm(sub(w.pts[1], w.pts[0]));
    for (const o of here) {
      const ow = ways[o.wi];
      if (ow === w) continue;
      const oEnd = o.i === 0 || o.i === ow.pts.length - 1;
      if (!oEnd || here.length !== 2) continue;
      for (const ub of leaving(ow, o.i)) {
        const ang = Math.abs(Math.atan2(cross(um, ub), dot(um, ub)));
        if (Math.min(ang, Math.PI - ang) < CONTINUE_ANG) return ow;
      }
    }
    return null;
  };
  ways.forEach((w, wi) => {
    const h = w.width / 2;
    const first = continuesInto(w, 0), last = continuesInto(w, w.pts.length - 1);
    const tFirst = first && first.width < w.width, tLast = last && last.width < w.width;
    // the taper needs a vertex where it ends: put one TAPER_M in from a tapered end
    let pts = w.pts;
    if (tFirst) pts = insertAt(pts, TAPER_M);
    if (tLast) pts = insertAt(pts, cumulative(pts)[pts.length - 1] - TAPER_M);
    const st = cumulative(pts), L = st[st.length - 1];
    const hs = new Array(pts.length).fill(h);
    if (tFirst) { const h0 = first.width / 2; for (let i = 0; i < pts.length; i++) hs[i] = Math.min(hs[i], h0 + (h - h0) * Math.min(1, st[i] / TAPER_M)); }
    if (tLast) { const h1 = last.width / 2; for (let i = 0; i < pts.length; i++) hs[i] = Math.min(hs[i], h1 + (h - h1) * Math.min(1, (L - st[i]) / TAPER_M)); }
    const left_ = offsetPolyVar(pts, hs, 1), right_ = offsetPolyVar(pts, hs, -1);
    out.strips.push({ left: left_, right: right_ });
    const inner = [], edgeCuts = { 1: [], '-1': [] };
    pts.forEach((p, i) => {
      const here = nodes.get(key(p));
      if (!here || here.length < 2) return;
      const s0 = st[i], endHere = i === 0 || i === pts.length - 1;
      // this way's direction into and out of the node (along increasing station); a corner before the node lies on the
      // arriving segment's edge, one after it on the departing segment's (the field rounds them by the same rule)
      const umIn = i > 0 ? norm(sub(p, pts[i - 1])) : norm(sub(pts[i + 1], p));
      const umOut = i + 1 < pts.length ? norm(sub(pts[i + 1], p)) : umIn;
      let other = 0;
      for (const o of here) {
        if (o.wi === wi || ways[o.wi].id === w.id) continue;   // ourselves, or another copy of us (state.js mergeCopies)
        const ow = ways[o.wi], hb = ow.width / 2, oEnd = o.i === 0 || o.i === ow.pts.length - 1;
        for (const ub of leaving(ow, o.i)) {
          const ang = Math.abs(Math.atan2(cross(umIn, ub), dot(umIn, ub)));
          const turn = Math.min(ang, Math.PI - ang);
          if (turn < PARALLEL_ANG || (turn < CONTINUE_ANG && endHere && oEnd)) continue;   // runs with us / goes on
          other = Math.max(other, hb);
          const side = cross(umIn, ub) > 0 ? 1 : -1;
          const nb = left(ub);
          const corners = [];
          for (const j of [1, -1]) {
            const k = cornerOn(p, umIn, umOut, side * h, add(p, mul(nb, j * hb)), ub);
            if (k && Math.abs(k.a) <= CORNER_MAX_M) corners.push({ a: k.a, t: k.t, um: k.um });
          }
          if (corners.length < 2) continue;
          corners.sort((x, y) => x.a - y.a);
          let from = Infinity, to = -Infinity;
          corners.forEach((k, idx) => {
            const e1 = idx === 0 ? mul(k.um, -1) : k.um;
            const alpha = Math.acos(Math.max(-1, Math.min(1, dot(e1, ub))));
            const R = alpha > 100 * Math.PI / 180 ? R_OBTUSE : alpha > 50 * Math.PI / 180 ? R_RIGHT : R_ACUTE;
            let d = alpha > 1e-3 ? R / Math.tan(alpha / 2) : FILLET_MAX_D;
            d = Math.min(d, FILLET_MAX_D, Math.max(1, k.t + 25));
            const sT = idx === 0 ? k.a - d : k.a + d;
            from = Math.min(from, sT); to = Math.max(to, sT);
          });
          if (from < to) edgeCuts[side].push([s0 + from, s0 + to]);
        }
      }
      if (other > 0) inner.push([s0 - other - NODE_CLEAR, s0 + other + NODE_CLEAR]);
    });
    // the edge lines, painted a little in from the strip's edges
    const he = hs.map(x => Math.max(x / 2, x - EDGE_INSET));
    out.edges.push(...cutByStations(offsetPolyVar(pts, he, 1), st, edgeCuts[1]), ...cutByStations(offsetPolyVar(pts, he, -1), st, edgeCuts['-1']));
    const W = w.laneW || LANE_W;
    // may each side cross the center line? (the side going with the way's nodes lies right of it, or left driving on the left)
    // the UK's rules (driving on the left, white lines) from the lanes and bends; elsewhere only what OSM's tags say
    const uk = leftTraffic && !usLines, pass = ukCenter(w, uk), fwdSide = leftTraffic ? 1 : -1;
    const double = (piece, d, fwdMay, bwdMay) => {   // a double white line: each side's half solid where that side may not cross
      for (const [side, may] of [[fwdSide, fwdMay], [-fwdSide, bwdMay]]) (may ? out.centers : out.solids).push(offsetPoly(piece, d + side * UK_DOUBLE));
    };
    const centerLine = (piece, d) => {
      if (usLines) {
        // double solid yellow, unless OSM lets a side pass: dashed yellow on that side, or one dashed line when both may
        if (pass.fwd == null) out.centers.push(offsetPoly(piece, d + 0.11), offsetPoly(piece, d - 0.11));
        else if (pass.fwd && pass.bwd) out.yellowDashed.push(offsetPoly(piece, d));
        else for (const [side, may] of [[fwdSide, pass.fwd], [-fwdSide, pass.bwd]]) (may ? out.yellowDashed : out.centers).push(offsetPoly(piece, d + side * 0.11));
        return;
      }
      if (pass.fwd == null || (pass.fwd && pass.bwd)) out.centers.push(offsetPoly(piece, d)); else double(piece, d, pass.fwd, pass.bwd);
    };
    // the center line along the way, clear of junctions: in the UK, solid both sides through a bend too tight to see
    // round at the road's speed (where OSM doesn't say otherwise)
    const bends = uk && pass.fwd && pass.bwd && w.passFwd == null && w.passBwd == null ? blindBends(pts, st, w) : [];
    const centerRun = (d) => {
      for (const piece of cutByStations(pts, st, inner.concat(bends))) centerLine(piece, d);
      if (bends.length) for (const piece of cutByStations(pts, st, inner.concat(outside(bends, st[st.length - 1])))) double(piece, d, false, false);
    };
    if (w.markings === false || w.singleTrack) {
      // OSM says no lane markings (lane_markings=no), or one lane both ways share: only its edges
    } else if (!w.oneWay && w.detailed && w.fwd != null) {
      // OSM says how many lanes go each way (roaddetail.js): from the right edge, the lanes driving with the way's nodes
      // (against them where traffic keeps left), the shared center lane, the rest; center lines either side of the shared part
      const R = leftTraffic ? w.bwd : w.fwd, C = w.centre || 0, n = w.fwd + w.bwd + C;
      const centerAt = (d) => { if (!C) { centerRun(d); return; } for (const piece of cutByStations(pts, st, inner)) out.centers.push(offsetPoly(piece, d)); };
      centerAt(-h + R * W);
      if (C) centerAt(-h + (R + C) * W);
      for (let k = 1; k < n; k++) if (k !== R && k !== R + C) out.lanes.push(...cutByStations(offsetPoly(pts, -h + k * W), st, inner));
    } else if (!w.oneWay) {
      centerRun(0);
    } else {
      for (let k = 1; k < w.lanes; k++) out.lanes.push(...cutByStations(offsetPoly(pts, -h + k * W), st, inner));
    }
    // the turn arrows OSM gives (turn:lanes), in each lane approaching a junction at the way's end
    const junctionAt = (atEnd) => { const i = atEnd ? w.pts.length - 1 : 0, here = nodes.get(key(w.pts[i])); return !!here && here.length >= 2 && continuesInto(w, i) === null; };
    const fwd = w.oneWay ? w.lanes : w.fwd, bwd = w.oneWay ? 0 : w.bwd;
    for (const [dir, turns] of [[1, w.turnsFwd], [-1, w.turnsBwd]]) {
      if (!turns || !turns.length || !junctionAt(dir > 0)) continue;
      // lane i's center (i = 0 the driver's leftmost), m left of the way's line looking along its nodes
      const center = (i) => dir > 0
        ? (leftTraffic || w.oneWay ? h : -h + fwd * W) - (i + 0.5) * W
        : (leftTraffic ? -h : h - bwd * W) + (i + 0.5) * W;
      for (const back of ARROW_FROM_END) {
        const tip = dir > 0 ? L - back : back, tail = tip - dir * ARROW_LEN * ARROW_SCALE;
        if (tail < 0 || tail > L || L < back + ARROW_LEN + 5) continue;
        const [P, t] = pointAt(pts, st, tail), ux = mul(t, dir), nWay = left(t), vx = left(ux);
        // sized to the lane: a bent arrow reaches ARROW_REACH m to the side at full size, kept ARROW_CLEAR m inside the lane
        const k = clamp((W / 2 - ARROW_CLEAR) / ARROW_REACH, 0.4, ARROW_SCALE);
        turns.forEach((lane, i) => {
          const base = add(P, mul(nWay, center(i)));
          for (const turn of lane) for (const tri of arrowShape(turn)) out.arrows.push(tri.map(([u, v]) => add(add(base, mul(ux, u * k)), mul(vx, v * k))));
        });
      }
    }
  });
  return out;
}

export { NET_LINE_LIFT };
