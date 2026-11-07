// Physical models for the world model's tracks (world_model.js): what a road user can and can't do, so the
// world drawn from noisy sensors moves like the real one.
//
// Each object is an extended Kalman filter over a kinematic bicycle, state [x, y, psi, v, a, k] in the world
// frame (world_model.js): the center of its footprint (m), its heading (rad), its speed along that heading (m/s,
// negative only reversing slowly), its acceleration along it (m/s^2) and the curvature of its path (1/m). It
// turns only by driving along a curve (psi changes by k times the distance covered), so it can't spin in place,
// and its velocity is always along its heading, so it can't slide sideways. After every prediction and update
// the state is held to what the object's class and mass allow (LIMITS, limit()): curvature to its tightest
// turning circle and to what its tyres grip at its speed, acceleration to what its power pushes its mass to, its
// braking to the tyres' grip, its speed to a top speed. Pedestrians (and animals) walk: they can turn on the
// spot, so their heading isn't tied to their path, but they can't run at car speeds or accelerate like one.
//
// Between tracks (separate()): no two road users stand in the same place. Footprints are oriented boxes; two that
// overlap are pushed apart along the shallowest way out (separating axes), the one less sure of where it is
// moving more, and none may overlap our own car. Boxes that overlap most of the smaller one's footprint and move
// alike are one object seen twice (world_model.js merges them).
//
// The sensors report the face of an object nearest to them, the track keeps its center: centerOf() moves a
// reported point back along the line of sight by the object's half extent in that direction (its half length
// seen end-on, half width side-on, between in between), and faceOf() the other way for the output.

// ---- classes ----------------------------------------------------------------------------------------

// per class: default footprint [w, l, h] (m), mass (kg) and power (W) for those dims, top speed (m/s), the tightest
// turning circle's curvature (1/m), the most the tyres grip sideways and in braking (m/s^2), the most it accelerates
// from rest (m/s^2), how much it reverses (m/s), and whether it can turn on the spot (walks)
export const LIMITS = {
  car:        { dims: [1.85, 4.6, 1.5], mass: 1700, power: 110e3, vMax: 55, kMax: 1 / 5.0, latMax: 8.0, brake: 9.0, accel: 4.0, reverse: 3.0 },
  truck:      { dims: [2.5, 10.0, 3.5], mass: 14000, power: 300e3, vMax: 33, kMax: 1 / 9.0, latMax: 4.0, brake: 6.0, accel: 1.5, reverse: 2.0 },
  motorcycle: { dims: [0.8, 2.1, 1.4], mass: 250, power: 50e3, vMax: 60, kMax: 1 / 3.0, latMax: 9.0, brake: 9.0, accel: 6.0, reverse: 0.0 },
  bicycle:    { dims: [0.6, 1.8, 1.7], mass: 90, power: 400, vMax: 15, kMax: 1 / 2.0, latMax: 6.0, brake: 5.0, accel: 2.0, reverse: 0.0 },
  pedestrian: { dims: [0.6, 0.6, 1.7], mass: 75, power: 400, vMax: 7, kMax: 1 / 0.3, latMax: 6.0, brake: 5.0, accel: 3.0, reverse: 7.0, walks: true },
  animal:     { dims: [0.6, 1.2, 1.0], mass: 60, power: 2e3, vMax: 15, kMax: 1 / 0.5, latMax: 8.0, brake: 8.0, accel: 6.0, reverse: 7.0, walks: true },
  // what nothing has classified yet: a radar point target, mostly cars (and signs, posts, which stand still)
  unknown:    { dims: [1.8, 4.5, 1.5], mass: 1700, power: 110e3, vMax: 55, kMax: 1 / 5.0, latMax: 8.0, brake: 9.0, accel: 4.0, reverse: 3.0 },
};
const SOLID = new Set(['car', 'truck', 'motorcycle', 'bicycle']);   // what separate() keeps apart
export const limitsOf = (cls) => LIMITS[cls] || LIMITS.unknown;

/** Mass (kg) from the class and the footprint it's seen at: a bigger car of a class is heavier, by its plan area. */
export function massOf(cls, dims) {
  const L = limitsOf(cls);
  if (!dims || !(dims[0] > 0) || !(dims[1] > 0)) return L.mass;
  const k = (dims[0] * dims[1]) / (L.dims[0] * L.dims[1]);
  return L.mass * Math.min(3, Math.max(0.4, k));
}

/** The footprint to use: what a source measured (each part sanity-checked against the class), else the class's. */
export function footprintOf(cls, dims) {
  const D = limitsOf(cls).dims;
  if (!dims) return [D[0], D[1]];
  const w = dims[0] > 0.2 && dims[0] < 3.2 ? dims[0] : D[0];
  const l = dims[1] > 0.2 && dims[1] < 25 ? Math.max(dims[1], w * 0.8) : D[1];
  return [w, l];
}

// ---- process model ------------------------------------------------------------------------------------

const TAU_A = 2.0;         // s: an object's acceleration fades toward cruising (a Singer model)...
const TAU_K = 4.0;         // ...and its path straightens out, over about this long
const SIGMA_JERK = 2.5;    // m/s^3: how fast acceleration changes (process noise)
const SIGMA_LAT_JERK = 3.0;   // m/s^3: how fast lateral acceleration (v^2 k) changes, which sets the curvature's noise
const SIGMA_POS = 0.15;    // m/sqrt(s): what the model misses (a lane change's start, potholes, the sensors' sway)
const SIGMA_WALK_TURN = 2.0;   // rad/sqrt(s): how freely a pedestrian turns

/** The state dt later. Exact for constant a and k over dt (to first order in the heading change). */
export function propagate(X, dt, walks = false) {
  const [x, y, psi, v, a, k] = X;
  let ds = v * dt + 0.5 * a * dt * dt;
  let v1 = v + a * dt;
  // speed doesn't pass through zero by accelerating: braking stops a car, it doesn't reverse it
  if (v > 0 && v1 < 0) { const ts = -v / a; ds = v * ts / 2; v1 = 0; }
  else if (v < 0 && v1 > 0) { const ts = -v / a; ds = v * ts / 2; v1 = 0; }
  const dpsi = walks ? 0 : k * ds;
  const hm = psi + dpsi / 2;
  const ea = Math.exp(-dt / TAU_A), ek = Math.exp(-dt / TAU_K);
  return [x + ds * Math.cos(hm), y + ds * Math.sin(hm), psi + dpsi, v1, v1 === 0 ? 0 : a * ea, k * ek];
}

/** Process noise for dt, in the state's own terms (position noise along and across the heading). */
function processNoise(X, dt, walks) {
  const v = Math.abs(X[3]);
  const Q = zeros(6, 6);
  const c = Math.cos(X[2]), s = Math.sin(X[2]);
  const qp = SIGMA_POS ** 2 * dt;
  Q[0][0] = qp; Q[1][1] = qp;
  // the jerk enters speed and position along the heading too (a discrete white-jerk model)
  const j2 = SIGMA_JERK ** 2;
  const qa = j2 * dt, qva = j2 * dt * dt / 2, qv = j2 * dt ** 3 / 3, qsa = j2 * dt ** 4 / 8, qsv = j2 * dt ** 4 / 8, qs = j2 * dt ** 5 / 20;
  Q[4][4] += qa; Q[3][4] += qva; Q[4][3] += qva; Q[3][3] += qv;
  const along = [c, s];
  for (let i = 0; i < 2; i++) {
    Q[i][3] += along[i] * qsv; Q[3][i] += along[i] * qsv;
    Q[i][4] += along[i] * qsa; Q[4][i] += along[i] * qsa;
    for (let j = 0; j < 2; j++) Q[i][j] += along[i] * along[j] * qs;
  }
  if (walks) Q[2][2] += SIGMA_WALK_TURN ** 2 * dt;
  else {
    // lateral jerk j turns into curvature at j / v^2 (slow, the curvature is free to change; v^2 floors at 4)
    const sk = SIGMA_LAT_JERK / Math.max(v * v, 4);
    Q[5][5] += sk * sk * dt;
    Q[2][2] += 1e-4 * dt;   // the model's small heading misfit
  }
  return Q;
}

// ---- the filter -----------------------------------------------------------------------------------------

export class PhysFilter {
  /** x, y: the center; psi: a heading guess and its 1-sigma (rad); v: speed along it (m/s) and its sigma. */
  constructor(x, y, Rp, psi, sPsi, v, sV, cls = 'unknown') {
    this.X = [x, y, psi, v, 0, 0];
    this.P = zeros(6, 6);
    this.P[0][0] = Rp[0][0]; this.P[0][1] = Rp[0][1]; this.P[1][0] = Rp[1][0]; this.P[1][1] = Rp[1][1];
    this.P[2][2] = sPsi * sPsi;
    this.P[3][3] = sV * sV;
    this.P[4][4] = 2.0 ** 2;
    this.P[5][5] = 0.02 ** 2;
    this.cls = cls;
    this.dims = null;
    this.flips = 0;   // times the heading was turned around while young (see settle())
  }

  get walks() { return !!limitsOf(this.cls).walks; }
  get pos() { return [this.X[0], this.X[1]]; }
  /** Velocity over ground (m/s, world): along the heading, never sideways. */
  get vel() { return [this.X[3] * Math.cos(this.X[2]), this.X[3] * Math.sin(this.X[2])]; }
  get speed() { return Math.abs(this.X[3]); }
  get yawRate() { return this.walks ? 0 : this.X[3] * this.X[5]; }
  get footprint() { return footprintOf(this.cls, this.dims); }
  get mass() { return massOf(this.cls, this.dims); }
  /** The front wheels' angle (rad) a bicycle with this wheelbase would need for the path's curvature. */
  get steer() { return this.walks ? 0 : Math.atan(this.X[5] * 0.6 * this.footprint[1]); }

  /** The velocity's covariance (world), through the heading's and speed's. */
  velCov() {
    const c = Math.cos(this.X[2]), s = Math.sin(this.X[2]), v = this.X[3];
    const J = [[0, 0, -v * s, c, 0, 0], [0, 0, v * c, s, 0, 0]];
    return matmul(matmul(J, this.P), transpose(J));
  }

  predict(dt) {
    if (dt <= 0) return;
    // a long gap is stepped through, so the curvature and the limits act along the way
    const steps = Math.max(1, Math.ceil(dt / 0.1));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const F = jacobian((S) => propagate(S, h, this.walks), this.X);
      this.X = propagate(this.X, h, this.walks);
      this.P = matadd(matmul(matmul(F, this.P), transpose(F)), processNoise(this.X, h, this.walks));
      this.limit();
    }
  }

  /** Where it'll be dt from now (no covariance), for the output and the view's extrapolation. */
  ahead(dt) {
    let S = this.X;
    const steps = Math.max(1, Math.ceil(Math.abs(dt) / 0.1));
    for (let i = 0; i < steps && dt > 0; i++) S = propagate(S, dt / steps, this.walks);
    return S;
  }

  /** One EKF update: z = h(X) + noise(R), with h's Jacobian taken numerically; angles in `wrapIdx` wrap. */
  update(z, h, R, wrapIdx = []) {
    const hx = h(this.X);
    const H = jacobian(h, this.X);
    const y = z.map((zi, i) => (wrapIdx.includes(i) ? wrap(zi - hx[i]) : zi - hx[i]));
    const Ht = transpose(H);
    const S = matadd(matmul(matmul(H, this.P), Ht), R);
    const K = matmul(matmul(this.P, Ht), inv(S));
    const dx = matvec(K, y);
    this.X = this.X.map((xi, i) => xi + dx[i]);
    // Joseph form: stays symmetric and positive through the constraints' nudges
    const IKH = sub(eye(6), matmul(K, H));
    this.P = matadd(matmul(matmul(IKH, this.P), transpose(IKH)), matmul(matmul(K, R), transpose(K)));
    this.X[2] = wrap(this.X[2]);
    this.limit();
  }

  updatePos(z, Rp) { this.update(z, (S) => [S[0], S[1]], Rp); }

  updateVel(vg, Rv) {
    this.update(vg, (S) => [S[3] * Math.cos(S[2]), S[3] * Math.sin(S[2])], Rv);
  }

  /** A heading a sensor reports (rad, world). A standing object's could be either way round (and the cameras'
   *  are coarse), so when it's nearer the reverse of ours, it's taken that way round while we hardly know ours. */
  updateHeading(psi, sPsi) {
    let d = wrap(psi - this.X[2]);
    if (Math.abs(d) > Math.PI / 2) {
      if (Math.sqrt(this.P[2][2]) < 0.6 && this.speed > 1.0) psi = wrap(psi + Math.PI);   // we know which way it goes
      else { this.turnAround(); d = wrap(psi - this.X[2]); }
    }
    this.update([psi], (S) => [S[2]], [[sPsi * sPsi]], [0]);
  }

  /** The same motion, described facing the other way (heading + pi, speed and acceleration negated). */
  turnAround() {
    this.X[2] = wrap(this.X[2] + Math.PI);
    this.X[3] = -this.X[3];
    this.X[4] = -this.X[4];
    this.X[5] = -this.X[5];
    // the negated states' covariances with the others change sign; among themselves (two signs) they don't
    for (const i of [3, 4, 5]) for (const j of [0, 1, 2]) {
      this.P[i][j] = -this.P[i][j];
      this.P[j][i] = -this.P[j][i];
    }
    this.flips++;
  }

  /** While its heading is still a guess, a track that turns out to be moving backwards faster than it could
   *  reverse is facing the other way (an oncoming car first guessed to face our way). */
  settle() {
    const L = limitsOf(this.cls);
    if (this.X[3] < -Math.max(L.reverse, 1.0) - 0.5 && Math.sqrt(this.P[2][2]) > 0.3) this.turnAround();
  }

  /** Hold the state to what its class can physically do (see LIMITS). */
  limit() {
    const L = limitsOf(this.cls);
    const X = this.X;
    const m = this.mass;
    X[3] = clamp(X[3], -Math.max(L.reverse, this.P[2][2] > 0.25 ? 60 : 0), L.vMax);   // free while it hasn't a heading yet
    const v = Math.abs(X[3]);
    // power: P = m a v, so the most it can add falls with speed; the tyres hold it below their grip anyway
    const push = Math.min(L.accel, L.power / (m * Math.max(v, 1)), L.latMax);
    const sign = X[3] >= 0 ? 1 : -1;
    // forward: speeding up is limited by power, slowing by braking (and the other way round in reverse)
    X[4] = sign > 0 ? clamp(X[4], -L.brake, push) : clamp(X[4], -push, L.brake);
    if (!L.walks) {
      const kGrip = L.latMax / Math.max(v * v, 1e-6);
      const kMax = Math.min(L.kMax, kGrip);
      X[5] = clamp(X[5], -kMax, kMax);
    } else X[5] = 0;
  }
}

// ---- the body that's drawn -------------------------------------------------------------------------------

const PURSUIT_S = 0.9;       // s of travel ahead the steering aims at (pure pursuit), at least PURSUIT_MIN_M
const PURSUIT_MIN_M = 3.0;
const GAP_GAIN = 1.2;        // 1/s: the speed it adds per metre it trails its estimate (or takes off, ahead of it)
const SPEED_TAU = 0.35;      // s: how quickly it takes up the speed it wants
const STEER_RATE = 0.6;      // rad/s at the front wheels: how fast it can turn its wheels
const SETTLED_SV = 3.0;     // m/s: the speed's sigma below which the estimate's speed is known (settled tracks: ~2)
const SNAP_M = 6.0;          // farther than this from its estimate, or than SNAP_S of its travel, it's put there
const SNAP_S = 0.4;          // (a new object, a re-association)
const SNAP_TURN_S = 1.5;     // standing this long facing more than SNAP_TURN away from its estimate, it's turned
const SNAP_TURN = 0.6;       // (a standing car's heading only becomes known once a sensor says which way it faces)

/** A road user as it's drawn: a kinematic bicycle driven by steering and throttle under its class's limits toward
 *  its filter's estimate, so what's seen moves like a vehicle, whatever the sensors' noise does to the estimate.
 *  It can't turn on the spot, slide, or change speed harder than its class can; when it's far off (a new object,
 *  a correction of metres) it's put where it should be instead. Has what separate() needs (X, P, footprint, vel). */
export class SimBody {
  constructor(f) {
    this.X = f.X.slice();
    this.P = [[f.P[0][0], f.P[0][1]], [f.P[1][0], f.P[1][1]]];
    this.cls = f.cls;
    this.dims = f.dims;
    this.delta = 0;       // front-wheel angle (rad)
    this.misaligned = 0;  // s it has stood facing away from its estimate
  }

  get footprint() { return footprintOf(this.cls, this.dims); }
  get vel() { return [this.X[3] * Math.cos(this.X[2]), this.X[3] * Math.sin(this.X[2])]; }
  get wheelbase() { return 0.6 * this.footprint[1]; }

  /** Drive dt toward the filter f's state T (f.ahead(): its estimate at this time). */
  follow(f, T, dt) {
    this.cls = f.cls; this.dims = f.dims;
    this.P = [[f.P[0][0], f.P[0][1]], [f.P[1][0], f.P[1][1]]];
    const L = limitsOf(this.cls), X = this.X;
    if (!(dt > 0)) return;
    const ex = T[0] - X[0], ey = T[1] - X[1], err = Math.hypot(ex, ey);
    // until the estimate knows how fast it goes (a new object: its first second), the body is the estimate; it
    // only starts driving itself once there's a speed to drive at
    if (Math.sqrt(f.P[3][3]) > SETTLED_SV) { this.X = T.slice(); this.delta = Math.atan(T[5] * this.wheelbase); return; }
    if (err > Math.max(SNAP_M, SNAP_S * Math.abs(T[3]))) { this.X = T.slice(); this.delta = 0; this.snaps = (this.snaps || 0) + 1; return; }
    const c = Math.cos(X[2]), s = Math.sin(X[2]);
    if (L.walks) {
      // walking: straight toward where it should be, at a walker's pace and acceleration; turning freely
      const want = Math.min(L.vMax, Math.abs(T[3]) + GAP_GAIN * err);
      const a = clamp((want - X[3]) / SPEED_TAU, -L.brake, L.accel);
      X[3] = Math.max(0, X[3] + a * dt);
      const step = Math.min(err, X[3] * dt);
      if (err > 1e-3) { X[0] += ex / err * step; X[1] += ey / err * step; }
      const face = err > 0.3 ? Math.atan2(ey, ex) : T[2];
      X[2] = wrap(X[2] + clamp(wrap(face - X[2]), -2 * Math.PI * dt, 2 * Math.PI * dt));
      X[4] = a; X[5] = 0;
      return;
    }
    // a standing car whose estimate faces another way: it can't turn there, so once that's settled it's turned
    if (Math.abs(X[3]) < 0.5 && Math.abs(T[3]) < 0.5 && Math.abs(wrap(T[2] - X[2])) > SNAP_TURN) {
      this.misaligned += dt;
      if (this.misaligned > SNAP_TURN_S) { this.X = T.slice(); this.delta = 0; this.misaligned = 0; return; }
    } else this.misaligned = 0;
    // speed: the estimate's, plus what closes the gap along our heading (reversing only as the estimate does)
    const along = ex * c + ey * s;
    let want = T[3] * Math.cos(wrap(T[2] - X[2])) + GAP_GAIN * along;
    want = clamp(want, T[3] < -0.3 ? -L.reverse : 0, L.vMax);
    const v = X[3], av = Math.abs(v);
    const push = Math.min(L.accel, L.power / (massOf(this.cls, this.dims) * Math.max(av, 1)), L.latMax);
    const a = clamp((want - v) / SPEED_TAU, v >= 0 ? -L.brake : -push, v >= 0 ? push : L.brake);
    // steering: pure pursuit to a point ahead on the estimate's path
    const look = Math.max(PURSUIT_MIN_M, av * PURSUIT_S);
    const gx = T[0] + Math.cos(T[2]) * look * Math.sign(T[3] || 1), gy = T[1] + Math.sin(T[2]) * look * Math.sign(T[3] || 1);
    const dx = gx - X[0], dy = gy - X[1];
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    const ld2 = Math.max(lx * lx + ly * ly, 1e-6);
    let k = (v >= 0 ? 1 : -1) * 2 * ly / ld2;
    const kGrip = L.latMax / Math.max(av * av, 1e-6);
    k = clamp(k, -Math.min(L.kMax, kGrip), Math.min(L.kMax, kGrip));
    const wantDelta = Math.atan(k * this.wheelbase);
    this.delta += clamp(wantDelta - this.delta, -STEER_RATE * dt, STEER_RATE * dt);
    const kNow = Math.tan(this.delta) / this.wheelbase;
    // integrate the bicycle (stopping at zero rather than through it)
    let v1 = v + a * dt, ds;
    if ((v > 0 && v1 < 0) || (v < 0 && v1 > 0)) { ds = v * (-v / a) / 2; v1 = 0; } else ds = (v + v1) / 2 * dt;
    const dpsi = kNow * ds, hm = X[2] + dpsi / 2;
    X[0] += ds * Math.cos(hm); X[1] += ds * Math.sin(hm);
    X[2] = wrap(X[2] + dpsi);
    X[3] = v1; X[4] = a; X[5] = kNow;
  }
}

// ---- line of sight: center <-> the face a sensor sees ------------------------------------------------------

/** How far a box's boundary is from its center along unit direction (dx, dy): w, l its size, psi its heading. */
export function halfExtent(w, l, psi, dx, dy) {
  const c = Math.cos(psi), s = Math.sin(psi);
  const along = Math.abs(dx * c + dy * s), across = Math.abs(-dx * s + dy * c);
  // a box's support: the distance to the boundary along the ray, capped by the box's half diagonal
  const t = Math.min(along > 1e-6 ? (l / 2) / along : Infinity, across > 1e-6 ? (w / 2) / across : Infinity);
  return Math.min(t, Math.hypot(w, l) / 2);
}

/** The center of a box whose face nearest to the sensor at (ox, oy) is at (fx, fy). */
export function centerOf(fx, fy, ox, oy, w, l, psi) {
  const dx = fx - ox, dy = fy - oy, r = Math.hypot(dx, dy) || 1;
  const e = halfExtent(w, l, psi, dx / r, dy / r);
  return [fx + dx / r * e, fy + dy / r * e];
}

/** The face nearest to the sensor at (ox, oy) of a box centered at (cx, cy). */
export function faceOf(cx, cy, ox, oy, w, l, psi) {
  const dx = cx - ox, dy = cy - oy, r = Math.hypot(dx, dy) || 1;
  const e = Math.min(halfExtent(w, l, psi, dx / r, dy / r), r);
  return [cx - dx / r * e, cy - dy / r * e];
}

// ---- no two in one place --------------------------------------------------------------------------------

/** The corners of a box (center, size, heading). */
function corners(cx, cy, w, l, psi) {
  const c = Math.cos(psi), s = Math.sin(psi), a = l / 2, b = w / 2;
  return [[cx + c * a - s * b, cy + s * a + c * b], [cx + c * a + s * b, cy + s * a - c * b],
    [cx - c * a + s * b, cy - s * a - c * b], [cx - c * a - s * b, cy - s * a + c * b]];
}

/** Two boxes' overlap by separating axes: null when apart, else the shortest push [dx, dy] that moves A out of B
 *  and how deep they overlap relative to the smaller one (0..1, a rough share of its footprint). */
export function overlap(A, B) {
  const ca = corners(...A), cb = corners(...B);
  let best = Infinity, axis = null;
  for (const psi of [A[4], A[4] + Math.PI / 2, B[4], B[4] + Math.PI / 2]) {
    const ax = [Math.cos(psi), Math.sin(psi)];
    const pa = ca.map(p => p[0] * ax[0] + p[1] * ax[1]), pb = cb.map(p => p[0] * ax[0] + p[1] * ax[1]);
    const d = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
    if (d <= 0) return null;
    if (d < best) { best = d; axis = ax; }
  }
  // push A away from B along the axis
  const dir = (A[0] - B[0]) * axis[0] + (A[1] - B[1]) * axis[1] >= 0 ? 1 : -1;
  const minSide = Math.min(A[2], A[3], B[2], B[3]);
  const out = best + GAP_M;   // apart, not just touching
  return { push: [axis[0] * out * dir, axis[1] * out * dir], depth: best, share: Math.min(1, best / Math.max(minSide, 0.3)) };
}

const GAP_M = 0.02;        // m left between two boxes pushed apart
const SAME_SHARE = 0.6;     // overlapping this much of the narrower side's width...
const SAME_DV = 3.0;        // ...and moving alike within this (m/s): one object seen twice

/** Keep the solid road users apart, and off our car (ego: [cx, cy, w, l, psi] of our footprint, world). Each track
 *  is { f: PhysFilter, id }. Moves the less certain of each overlapping pair (all of it, against our car); returns
 *  the pairs that look like one object seen twice, [idA, idB], for the caller to merge. */
export function separate(tracks, ego = null, iterations = 3) {
  const solid = tracks.filter(t => SOLID.has(t.f.cls) || (t.f.cls === 'unknown' && t.f.dims));
  const same = [];
  const box = (f) => { const [w, l] = f.footprint; return [f.X[0], f.X[1], w, l, f.X[2]]; };
  const shift = (f, dx, dy) => { f.X[0] += dx; f.X[1] += dy; };
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < solid.length; i++) {
      const A = solid[i].f;
      if (ego) {
        const o = overlap(box(A), ego);
        if (o) { shift(A, o.push[0], o.push[1]); moved = true; }
      }
      for (let j = i + 1; j < solid.length; j++) {
        const B = solid[j].f;
        const o = overlap(box(A), box(B));
        if (!o) continue;
        const va = A.vel, vb = B.vel;
        if (it === 0 && o.share >= SAME_SHARE && Math.hypot(va[0] - vb[0], va[1] - vb[1]) < SAME_DV) {
          same.push([solid[i].id, solid[j].id]);
          continue;
        }
        // the less certain moves more: by their position variances
        const ua = A.P[0][0] + A.P[1][1], ub = B.P[0][0] + B.P[1][1];
        const ka = ua / (ua + ub || 1);
        shift(A, o.push[0] * ka, o.push[1] * ka);
        shift(B, -o.push[0] * (1 - ka), -o.push[1] * (1 - ka));
        moved = true;
      }
    }
    if (!moved) break;
  }
  return same;
}

// ---- small dense matrices (arrays of rows) -----------------------------------------------------------------

export const zeros = (n, m) => Array.from({ length: n }, () => new Array(m).fill(0));
export const eye = (n) => { const I = zeros(n, n); for (let i = 0; i < n; i++) I[i][i] = 1; return I; };
export function matmul(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { let s = 0; for (let l = 0; l < k; l++) s += A[i][l] * B[l][j]; C[i][j] = s; }
  return C;
}
export const transpose = (A) => A[0].map((_, j) => A.map(row => row[j]));
export const matadd = (A, B) => A.map((row, i) => row.map((v, j) => v + B[i][j]));
export const matvec = (A, v) => A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
export const sub = (A, B) => A.map((row, i) => row.map((v, j) => v - B[i][j]));
export const block = (A, r0, r1, c0, c1) => A.slice(r0, r1).map(row => row.slice(c0, c1));
export const wrap = (a) => (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Gauss-Jordan inverse with partial pivoting (small n). */
export function inv(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...eye(n)[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (p !== c) [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (d === 0) throw new Error('singular matrix');
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const f = M[i][c];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) M[i][j] -= f * M[c][j];
    }
  }
  return M.map(row => row.slice(n));
}

/** A function's Jacobian at X by central differences (angles in the output wrap). */
export function jacobian(f, X) {
  const n = X.length, f0 = f(X), m = f0.length;
  const J = zeros(m, n);
  for (let j = 0; j < n; j++) {
    const h = 1e-5 * Math.max(1, Math.abs(X[j]));
    const Xp = X.slice(), Xm = X.slice();
    Xp[j] += h; Xm[j] -= h;
    const fp = f(Xp), fm = f(Xm);
    for (let i = 0; i < m; i++) J[i][j] = (fp[i] - fm[i]) / (2 * h);
  }
  return J;
}
