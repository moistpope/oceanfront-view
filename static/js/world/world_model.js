// World model for the web HUD: every object source placed in one ground-fixed frame and tracked there
// (a port of the former Python world_model.py; it now runs in the page's world-model worker).
//
// The sources see the same road with different strengths and different delays, and each measurement
// is weighted by its source's noise model (the *Noise functions below), so where they overlap the
// more trustworthy source dominates each quantity:
//   radar  the mid-range radar (bus 1, fisker_radar.js). Range to the near face and range rate are
//          excellent (checked against the road camera: boxes land on bumpers); bearing is coarse, so
//          lateral error grows with range; its lateral velocity is unreliable in turns. Young tracks
//          are mostly flicker (median life 0.13 s) and are left out; maturing ones count for less.
//   adas   the OEM ADAS object list (FiskerWorld). Camera classification, size, heading and the widest
//          coverage; range is the camera's, with no velocity. As decoded it's off in scale and origin
//          (see the calibration below).
//   op     openpilot's radarState leads (radar-backed when the model confirms a radar track, else
//          vision). Two leads; depth from the model, its error growing with distance; weighted by the
//          model's lead probability. The least stable source here (in a parking lot it put a car 13 m
//          ahead at 6 m), so an openpilot lead refines objects the others see but only stands alone
//          when it's the only object source there is. leadTwo is the model's lead 2 s from now
//          (modelV2.leadsV3[1]), most often the same car as leadOne, so it only counts when it's
//          clearly another car.
// Each object is a physically constrained extended Kalman filter (physics.js PhysFilter): a kinematic bicycle
// over its footprint's center, heading, speed, acceleration and path curvature, held to what its class and mass
// can do, so it can't spin in place, slide sideways or accelerate harder than it could, and kept from
// overlapping the others and our car (physics.js separate()). A measurement is
// placed at the time it was taken (the radar's synced MeasTime; the others by their typical latency)
// using the ego pose at that time, dead-reckoned from wheel speed and the yaw-rate gyro. Measurements
// are processed FUSION_DELAY_S behind the present so every source is in before its time is passed, and
// tracks are then predicted to the present. A stationary object therefore stays put on the ground
// through a turn and each source's lag is undone.
//
// Before fusion each source is corrected by a sensor calibration. MEASURED_CALIBRATION (the default)
// holds what replaying routes 000000b5--bfe13ac451 and 000000b4--d0f733ebb2 against GPS, openpilot's
// leads and lane lines found; NO_CALIBRATION takes every source as it decodes, for comparison
// (Display -> Geometry calibration). Uncorrected, the ADAS list reads 0.8x the radar's range plus ~3 m
// (so its copy of a car and the radar's cross over at ~10-15 m and split apart beyond) and puts
// left-lane cars 1.4 m too far out.
//
// Each object also carries a confidence (0..1) that it's really there, which the view fades it by
// (the CONF_* constants below). The radar measures range, bearing and Doppler but no elevation, so it
// tracks sign gantries, traffic lights and bridges like stopped cars in our lane until it passes under
// them (track 791 on route 000000b5--bfe13ac451--12 at 45-48 s: a "car" 3.4 m wide and 0.2-1.0 m long,
// dropped at 24 m). A camera positively classifying an object settles it. Without one, the radar alone
// can't show an object it hasn't classified (a point target needs a camera detection as well, from the
// ADAS list or an openpilot lead), nor one whose radar track hasn't lasted 1.3 s (mostly flicker). Past
// that, a radar-only object counts for more when it moves (signs and poles don't), less when it
// stands, less again when the radar draws it as a wide thin strip, and least where openpilot's model
// would plainly see a car and doesn't: standing in our path, within its range, with nothing nearer to
// hide it.
//
// Frames: world (x, y, heading) is fixed to the ground with an arbitrary origin, reset on seek. The ego
// frame is x forward from the front bumper, y left, like every other HUD object list.
import { pyRound } from './dbc.js';
import { PhysFilter, SimBody, separate, centerOf, faceOf, footprintOf, limitsOf } from './physics.js';

export const FRONT_TO_REAR_AXLE = 3.85;   // m: the Ocean is 4.775 m long with its rear axle 0.93 m from the back
export const FUSION_DELAY_S = 0.2;        // radar measurements arrive ~0.10-0.13 s after they're taken
const HISTORY_S = 5.0;
const ADAS_LATENCY_S = 0.12;       // uncalibrated guess: a typical camera pipeline (MEASURED_CALIBRATION has 0.23)
export const OP_LATENCY_S = 0.05;  // radarState.mdMonoTime is when the model ran; its frame is about this older
export const RADAR_MIN_AGE = 8;    // cycles (65 ms): younger radar tracks are left out entirely
const RADAR_MATURE_AGE = 20;
const OP_MIN_PROB = 0.5;
const LEAD_TWO_SAME_M = 6.0;       // openpilot's leadTwo within this (or LEAD_TWO_SAME_FRAC of the range) ahead or behind
const LEAD_TWO_SAME_FRAC = 0.15;   // leadOne and LEAD_TWO_SAME_Y beside it is the same car
const LEAD_TWO_SAME_Y = 2.0;
const GATE = 16.0;                 // Mahalanobis^2 (4 sigma) to associate a measurement with a track...
const GATE_M = 3.0;                // ...and no farther than this plus 2.5 sigma of the measurement, whatever the covariance
const MERGE_GATE = 4.0;            // two tracks this close (and within MERGE_M) are one object...
const MERGE_M = 1.5;
const MERGE_V = 2.5;               // ...if their speeds agree within this, or within 3 sigma of their velocity estimates
const MERGE_GATE_V = 9.0;
const SAME_ID_S = 1.0;             // two tracks one source fed under one id this close in time are one object split in two...
const SAME_ID_M = 5.0;             // ...unless they're farther apart than this
const ACCEL_SIGMA = 3.0;           // m/s^2: process noise of the constant-velocity model
const COAST_MOVING_S = 1.0;        // a track is dropped this long after its last measurement...
const COAST_STATIONARY_S = 2.5;    // ...longer when it stands still (e.g. parked cars the radar stops reporting in a turn)
const STATIONARY_SPEED = 0.7;      // m/s over ground
const CONFIRM_UPDATES = 3;         // a radar-only track is shown after this many measurements...
const CONFIRM_SPAN_S = 0.15;       // ...spanning at least this long
const HEADING_FROM_MOTION = 1.5;   // m/s: faster than this, an object points where it's going
const SOURCE_GONE_S = 5.0;
const CONF_SHOWN = 0.35;           // the view draws objects from about this confidence (scene.js CONF_HIDE)         // a source silent this long no longer counts as available

// confidence (see above); the view fades objects in between about 0.35 and 0.65
const VISION_CLASSES = new Set(['car', 'truck', 'motorcycle', 'bicycle', 'pedestrian', 'animal']);
const CONF_VISION = 1.0;           // a camera positively classified it (ADAS list class, or an openpilot lead)...
const VISION_HOLD_S = 1.0;         // ...this recently
const CONF_VISION_HELD = 0.9;      // one did earlier, and the others still track it
const CONF_UNCLASSIFIED = 0.25;    // radar alone, and it hasn't classified it: a point target needs a camera detection too
const RADAR_CLASS_CYCLES = 5;      // radar cycles with a class before it counts as classified (classes flicker for a cycle)
const CONF_YOUNG = 0.3;            // radar alone, before its track has lasted RADAR_MATURE_AGE: mostly flicker
const CONF_MOVING = 0.85;          // radar alone, moving over the ground
export const CONF_STANDING = 0.6;  // radar alone, standing: as often a parked car as a post
const THIN_ASPECT = 4.0;           // the radar has drawn it at least this many times wider than long...
const THIN_MIN_W = 1.5;            // ...and at least this wide: a sign or a gantry seen edge-on
const THIN_FACTOR = 0.55;
const CONF_UNSEEN = 0.15;          // standing in our path where openpilot's model would see a car, and doesn't...
const UNSEEN_HOLD_S = 0.5;         // ...for this long in all: then it stays that low, even once a turn takes it out of our path
const UNSEEN_MIN_V = 5.0;          // m/s: slower than this (parking), the model's leads are too unsteady to go by
const UNSEEN_X = [8.0, 80.0];      // m ahead: where the model reliably reports a stopped car in our lane
const CORRIDOR_HALF_W = 1.5;       // m either side of our predicted path: our half width and half a meter
const MOVING_SPEED = 1.5;          // m/s over ground, plus movingFrac (calibration) of our speed: how far apart
const MOVING_FRAC = 0.06;          // the Doppler and ego speed scales may be (4% uncorrected, so a standing object can read ~1 m/s)
const CONF_RISE_S = 0.5;           // confidence eases toward its target over about this long, in data time...
const CONF_FALL_S = 0.25;
const CONF_COAST_S = 0.3;          // ...but can't rise once no source has reported the object for this long, and a moving one fades out


// ---- sensor calibration ----------------------------------------------------------------------------

/** Corrections applied to each source before it's fused (the view's lanes and ego motion use the last two). */
function calibration(fields) {
  return Object.freeze({
    name: 'none',
    speedScale: 1.0,          // true speed / ESP_VehSpd (wheel speed), for the ego odometry
    radarDopplerScale: 1.0,   // true / decoded radar relative velocity
    radarYaw: 0.0,            // rad: the radar's output is turned this far left (CCW) into the car's frame
    adasXScale: 1.0,          // ADAS object range: x = decoded / adasXScale - adasXOrigin
    adasXOrigin: 0.0,         // m from the front bumper back to the ADAS list's origin
    adasYScale: 1.0,          // ADAS object lateral: y = decoded / adasYScale
    adasLatency: ADAS_LATENCY_S,
    opXOffset: 0.0,           // m added to openpilot leads' dRel
    modelXOffset: -1.6,       // m: openpilot's model frame (the comma camera) relative to the front bumper
    movingFrac: MOVING_FRAC,
    ...fields,
  });
}

export function calibrationToJson(c) {
  return { on: c.name !== 'none', name: c.name, speedScale: c.speedScale, modelXOffset: c.modelXOffset };
}

export const NO_CALIBRATION = calibration({});
// Measured on 2026-10-02 from routes 000000b5--bfe13ac451 and 000000b4--d0f733ebb2 (12 segments with the radar):
export const MEASURED_CALIBRATION = calibration({
  name: 'measured',
  speedScale: 1.031,                  // GPS / wheel speed: 1.031 on all six driving segments
  radarDopplerScale: 0.0625 / 0.06,   // standing targets fit 0.0618-0.0631 m/s per bit against GPS speed: 1/16, not the DBC's 0.06
  radarYaw: 0.6 * Math.PI / 180,      // cars in our lane drifted right with range (-0.7 m at 70 m) against openpilot's lanes and leads
  adasXScale: 0.80,                   // 60 cars paired with radar tracks: decoded = 0.80 (x + 3.7), 0.3 m median residual,
  adasXOrigin: 3.7,                   // i.e. ~0.25 m/bit rather than 0.2, from about the rear axle
  adasYScale: 1.35,                   // left-lane cars sat 1.4 m too far out at every range against openpilot's lanes
  adasLatency: 0.23,                  // lag that best lines up its ranges with the radar's (13 cars; 0.1-0.3 s for most)
  opXOffset: 0.2,                     // leads read 0.2 m short close up: the camera is ~1.72 m behind the radar, radard assumes 1.52
  modelXOffset: -1.7,
  movingFrac: 0.025,                  // both scales corrected, standing targets read within ~1.3% of our speed
});


// ---- measurement noise (1 sigma) -------------------------------------------------------------------

/** sx, sy (m), svx, svy (m/s) in the ego frame, and how much less a young or coasting track counts.
 *  ~1 deg of bearing error; range and Doppler fine. Its lateral velocity is barely usable: a young
 *  track's bearing converges over its first second and the radar reports that as sideways motion. */
function radarNoise(rng, age, hist) {
  let k = age >= RADAR_MATURE_AGE ? 1.0 : 2.5;
  if ((hist & 0b11) !== 0b11) k *= 2.0;   // no detection in one of the last two cycles: the track is coasting
  return [0.25 + 0.005 * rng, 0.15 + 0.017 * rng, 0.3, 6.0, k];
}

/** Camera ranging (~6%) and 0.2 m quantization; bearing is the camera's strength. */
function adasNoise(rng) {
  return [0.5 + 0.06 * rng, 0.3 + 0.012 * rng];
}

/** sx, sy, svx. openpilot leads backed by a car radar (not this port) are radar-grade. */
function opNoise(rng, prob, radar) {
  if (radar) return [0.3 + 0.01 * rng, 0.3 + 0.017 * rng, 0.4];
  const k = 1.0 / Math.sqrt(Math.max(prob, 0.2));
  return [k * (0.6 + 0.08 * rng), k * (0.4 + 0.015 * rng), k * (0.6 + 0.04 * rng)];
}


// ---- small dense matrices (arrays of rows): physics.js's ----------------------------------------------

import { zeros, eye, matmul, transpose, matadd, matvec, sub, block, inv } from './physics.js';

/** d^T S^-1 d for a 2x2 S. */
function quad2(S, d) {
  const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
  const x = (S[1][1] * d[0] - S[0][1] * d[1]) / det;
  const y = (-S[1][0] * d[0] + S[0][0] * d[1]) / det;
  return d[0] * x + d[1] * y;
}

const rot = (h) => { const c = Math.cos(h), s = Math.sin(h); return [[c, -s], [s, c]]; };
const wrap = (a) => (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const hypot = (x, y) => Math.sqrt(x * x + y * y);


// ---- ego pose ---------------------------------------------------------------------------------------

/** Pose of the rear axle in the world frame, integrated from signed speed and yaw rate, with a
 *  few seconds of history so a measurement can be placed at the pose it was taken from. */
export class EgoOdometry {
  constructor() { this.reset(); }

  reset() {
    this.ts = [];
    this.poses = [];   // [x, y, heading, signed speed]
    this.t = null;
    this.x = this.y = this.h = this.v = this.w = 0.0;
  }

  /** v: signed speed (m/s, negative in reverse), w: yaw rate (rad/s, + = left). */
  update(t, v, w) {
    if (this.t !== null) {
      const dt = t - this.t;
      if (dt <= 0) return;
      if (dt < 0.5) {   // a longer gap (seek, dropout) restarts the integration in place
        const hm = this.h + 0.5 * w * dt;
        this.x += v * Math.cos(hm) * dt;
        this.y += v * Math.sin(hm) * dt;
        this.h += w * dt;
      }
    }
    this.t = t; this.v = v; this.w = w;
    this.ts.push(t);
    this.poses.push([this.x, this.y, this.h, v]);
    if (this.ts.length > 256 && t - this.ts[0] > HISTORY_S) {
      const cut = bisectLeft(this.ts, t - HISTORY_S);
      this.ts.splice(0, cut);
      this.poses.splice(0, cut);
    }
  }

  pose(t) {
    if (!this.ts.length) return [0.0, 0.0, 0.0];
    if (t >= this.ts[this.ts.length - 1]) {   // carry the last motion forward (briefly)
      const dt = Math.min(t - this.ts[this.ts.length - 1], 0.5);
      const hm = this.h + 0.5 * this.w * dt;
      return [this.x + this.v * Math.cos(hm) * dt, this.y + this.v * Math.sin(hm) * dt, this.h + this.w * dt];
    }
    const i = bisectRight(this.ts, t);
    if (i === 0) return this.poses[0].slice(0, 3);
    const t0 = this.ts[i - 1], t1 = this.ts[i];
    const a = this.poses[i - 1], b = this.poses[i];
    const f = (t - t0) / (t1 - t0);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  speed(t) {
    if (!this.ts.length || t >= this.ts[this.ts.length - 1]) return this.v;
    const i = Math.max(1, bisectRight(this.ts, t));
    return this.poses[i - 1][3];
  }
}

function bisectLeft(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
function bisectRight(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x < a[m]) hi = m; else lo = m + 1; } return lo; }

export function toWorld(pose, x, y) {
  const [px, py, h] = pose;
  const xr = x + FRONT_TO_REAR_AXLE;
  const c = Math.cos(h), s = Math.sin(h);
  return [px + c * xr - s * y, py + s * xr + c * y];
}

export function toEgo(pose, wx, wy) {
  const [px, py, h] = pose;
  const dx = wx - px, dy = wy - py;
  const c = Math.cos(h), s = Math.sin(h);
  return [c * dx + s * dy - FRONT_TO_REAR_AXLE, -s * dx + c * dy];
}


// ---- measurements & tracks --------------------------------------------------------------------------

export class Meas {
  constructor(src, sid, t, x, y, sx, sy, { vx = null, vy = null, svx = 10.0, svy = 10.0, weight = 1.0, cls = null, dims = null, heading = null, info = {} } = {}) {
    this.src = src;         // 'radar' | 'adas' | 'op'
    this.sid = sid;         // the source's own track id (op: lead index)
    this.t = t;             // when it was measured (log clock, s)
    this.x = x;             // ego frame at t: m ahead of the front bumper (near face of the object)
    this.y = y;             // m left
    this.sx = sx;           // 1-sigma noise, ego axes: what the source measures to, used to gate association
    this.sy = sy;
    this.vx = vx;           // velocity over ground, ego axes at t (null: not measured)
    this.vy = vy;
    this.svx = svx;
    this.svy = svy;
    this.weight = weight;   // < 1: counts for less (a young or coasting radar track); the noise is scaled by 1/weight
    this.cls = cls;
    this.dims = dims;       // [w, l, h]
    this.heading = heading; // deg, + = left of the ego heading at t
    this.info = info;       // what the source said, for the stats view
  }
}

const SOURCE_RANK = { adas: 0, radar: 1, op: 2 };   // whose class / size / heading wins
const RANK_SRC = { 0: 'adas', 1: 'radar', 2: 'op' };

// how sure a source's heading is (rad, 1 sigma); only used while an object is slow, where its motion can't tell
const HEADING_SIGMA = { adas: 0.35, radar: 0.25, op: 0.6 };
const HEADING_MEAS_MAX_V = 3.0;   // m/s: faster, the heading is the motion's
const EGO_W = 1.98, EGO_L = 4.775; // m: our footprint (the rear axle 0.925 m from the back)

/** A measured class as the physical model knows it. */
const physClass = (cls) => (cls && limitsOf(cls) !== limitsOf('unknown') ? cls : 'unknown');

class Track {
  /** z: the face a sensor at o saw (world); Rp its noise; v, Rv: a measured velocity over ground (or null);
   *  psi0: a heading guess (rad) and its sigma; vEgo our speed (a prior for an object's). */
  constructor(tid, t, z, o, Rp, v, Rv, m, psi0, sPsi0, vEgo) {
    this.id = tid;
    this.t = t;
    const cls = physClass(m.cls);
    const [w, l] = cls === 'unknown' && !m.dims ? [0, 0] : footprintOf(cls, m.dims);
    const c = centerOf(z[0], z[1], o[0], o[1], w, l, psi0);
    let v0 = vEgo, sV = Math.max(6, 0.6 * Math.abs(vEgo));
    if (v !== null) { v0 = v[0] * Math.cos(psi0) + v[1] * Math.sin(psi0); sV = 2.0; }
    if (limitsOf(cls).walks) { v0 = 0; sV = 2.0; }
    this.f = new PhysFilter(c[0], c[1], Rp, psi0, sPsi0, v0, sV, cls);
    this.f.dims = m.dims;
    this.first = t;
    this.n = 0;
    this.last = {};        // src -> time of its last measurement
    this.sources = {};     // src -> {id, t, dx, dy, info}
    this.confirmed = false;
    this.cls = null;
    this.clsRank = 99;
    this.dims = null;
    this.headingRank = 99;
    this.visionT = null;   // last time a camera positively classified it
    this.thin = 0.0;       // widest-for-its-length the radar has drawn it (w/l)
    this.radarAge = 0;     // oldest radar track (cycles) that has reported it
    this.radarClsN = 0;    // radar cycles that gave it a class (not just a point target)
    this.unseenS = 0.0;    // how long openpilot's model has missed it in plain view
    this.conf = 0.0;
    this.confT = t;
    this.confWhy = '';
  }

  get lastT() {
    const v = Object.values(this.last);
    return v.length ? Math.max(...v) : this.first;
  }

  get pos() { return this.f.pos; }
  get vel() { return this.f.vel; }
  get heading() { return this.f.X[2]; }
  speed() { return this.f.speed; }

  predict(t) {
    const dt = t - this.t;
    if (dt === 0) return;
    this.f.predict(dt);   // backward too (a late measurement), as the constant-velocity filter did
    this.t = t;
  }

  /** Its size for placing it along the line of sight: none when nothing has said what it is or how big
   *  (a radar point target: a sign, a post, or a car the radar sees as a point), so its center is the point seen. */
  get sight() { return this.f.cls === 'unknown' && !this.f.dims ? [0, 0] : this.f.footprint; }

  /** Where a face seen from o puts this object's center, by its own heading and size. */
  centerFor(z, o) {
    const [w, l] = this.sight;
    return centerOf(z[0], z[1], o[0], o[1], w, l, this.f.X[2]);
  }

  maha(z, o, Rp) {
    const c = this.centerFor(z, o);
    const S = matadd(block(this.f.P, 0, 2, 0, 2), Rp);
    return quad2(S, [c[0] - this.f.X[0], c[1] - this.f.X[1]]);
  }

  update(z, o, Rp, v, Rv) {
    this.f.updatePos(this.centerFor(z, o), Rp);
    if (v !== null) this.f.updateVel(v, Rv);
    this.f.settle();
  }

  /** A source's heading (world, rad), while the object is slow enough that its motion doesn't say. */
  updateHeading(psi, src) {
    if (this.f.speed < HEADING_MEAS_MAX_V || Math.sqrt(this.f.P[2][2]) > 0.5) this.f.updateHeading(psi, HEADING_SIGMA[src] ?? 0.5);
  }
}

/** Of two tracks that are one object, the one to keep: the one the view shows (confirmed, and sure enough to draw),
 *  then a confirmed one, then the older, so the
 *  object keeps its id (a new id is a new object to the view: the old one fades out and this one in). */
function older(A, B) {
  const shown = (T) => T.confirmed && T.conf >= CONF_SHOWN;
  if (shown(A) !== shown(B)) return shown(A) ? [A, B] : [B, A];
  if (A.confirmed !== B.confirmed) return A.confirmed ? [A, B] : [B, A];
  return A.first <= B.first ? [A, B] : [B, A];
}

/** Both fed by the same radar or ADAS track id within SAME_ID_S (openpilot's lead index isn't an identity). */
function sameSourceId(a, b) {
  for (const src in a.sources) {
    const s = a.sources[src], o = b.sources[src];
    if (src !== 'op' && o !== undefined && o.id === s.id && Math.abs(o.t - s.t) < SAME_ID_S) return true;
  }
  return false;
}


export class WorldModel {
  constructor(calib = MEASURED_CALIBRATION) {
    this.odo = new EgoOdometry();
    this.calib = calib;
    this.nextId = 1;   // never reset: a viewer keyed by id mustn't mistake a new object for an old one after a seek
    this.reset();
  }

  /** Switch calibrations; tracks built on the other one start over (they'd jump by meters). */
  setCalibration(calib) {
    if (calib.name !== this.calib.name) {
      this.calib = calib;
      this.reset();
    }
  }

  reset() {
    this.odo.reset();
    this.tracks = new Map();   // tid -> Track, in creation order
    this.pending = [];
    this.sticky = new Map();   // "src:sid" -> track id
    this.srcSeen = {};         // src -> time of its latest measurement
    this.modelSeen = -1e9;     // time of openpilot's latest model output, leads or not
    this.lastNow = null;
  }

  add(meas) { this.pending.push(...meas); }

  /** openpilot's model looked at t. Where it reported no lead, it saw no car. */
  modelRan(t) { this.modelSeen = Math.max(this.modelSeen, t); }

  /** Fuse everything measured up to FUSION_DELAY_S ago; return the objects as of `now`. */
  step(now) {
    // waiting for late sources only makes sense while time moves; paused (a replay), take everything
    const paused = this.lastNow !== null && now <= this.lastNow;
    const cutoff = paused ? now : now - FUSION_DELAY_S;
    this.lastNow = now;
    const ready = this.pending.filter(m => m.t <= cutoff).sort((a, b) => a.t - b.t || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
    this.pending = this.pending.filter(m => m.t > cutoff && m.t > now - HISTORY_S);
    let i = 0;
    while (i < ready.length) {   // one batch = one source's report at one time
      let j = i;
      while (j < ready.length && ready[j].t === ready[i].t && ready[j].src === ready[i].src) j++;
      this._process(ready.slice(i, j));
      i = j;
    }
    this._merge();
    this._separate(cutoff);
    this._prune(cutoff);
    this._confidence(cutoff, paused);
    return this._output(now);
  }

  // ---- fusion ----
  _process(batchIn) {
    // one measurement per source id: the radar sometimes re-sends a whole cycle, and a second copy of an id would
    // find its track already taken and start a duplicate of it
    const byId = new Map();
    for (const m of batchIn) byId.set(`${m.src}:${m.sid}`, m);
    const batch = [...byId.values()];
    const t = batch[0].t;
    this.srcSeen[batch[0].src] = t;
    const pose = this.odo.pose(t);
    const R = rot(pose[2]), Rt = transpose(R);
    const o = toWorld(pose, 0, 0);   // where the sensors look from: our front bumper
    const vEgo = this.odo.speed(t);
    const meas = [];
    for (const m of batch) {
      const z = toWorld(pose, m.x, m.y);
      const Rg = matmul(matmul(R, [[m.sx ** 2, 0], [0, m.sy ** 2]]), Rt);   // gates association
      const k2 = 1.0 / m.weight ** 2;                                       // weighs the update
      let v = null, Rv = null;
      if (m.vx !== null) {
        v = matvec(R, [m.vx, m.vy ?? 0.0]);
        const svy = m.vy !== null ? m.svy : 10.0;
        Rv = matmul(matmul(R, [[k2 * m.svx ** 2, 0], [0, k2 * svy ** 2]]), Rt);
      }
      meas.push([m, z, Rg, Rg.map(row => row.map(x => k2 * x)), v, Rv]);
    }
    for (const tr of this.tracks.values()) tr.predict(t);

    const assigned = new Map();   // meas index -> track id
    const used = new Set();
    // gated on the center the face puts each track at, so a long truck's rear and its center aren't 5 m apart
    const near = (tr, m, z) => { const c = tr.centerFor(z, o); return hypot(c[0] - tr.pos[0], c[1] - tr.pos[1]) < GATE_M + 2.5 * Math.max(m.sx, m.sy); };

    // a source's own track id keeps feeding the same object while it's plausible
    meas.forEach(([m, z, Rg], k) => {
      const tid = this.sticky.get(`${m.src}:${m.sid}`);
      const tr = tid !== undefined ? this.tracks.get(tid) : undefined;
      if (tr !== undefined && !used.has(tid) && near(tr, m, z) && tr.maha(z, o, Rg) < 4 * GATE) {
        assigned.set(k, tid);
        used.add(tid);
      }
    });
    // the rest by nearest fit
    const cands = [];
    meas.forEach(([m, z, Rg], k) => {
      if (assigned.has(k)) return;
      for (const [tid, tr] of this.tracks) {
        if (used.has(tid) || !near(tr, m, z)) continue;
        const d2 = tr.maha(z, o, Rg);
        if (d2 < GATE) cands.push([d2, k, tid]);
      }
    });
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    for (const [, k, tid] of cands) {
      if (assigned.has(k) || used.has(tid)) continue;
      assigned.set(k, tid);
      used.add(tid);
    }

    meas.forEach(([m, z, , Rp, v, Rv], k) => {
      let tid = assigned.get(k);
      let innovation;
      if (tid === undefined) {
        if (m.src === 'op' && (m.info.modelProb ?? 1.0) < OP_MIN_PROB) return;
        tid = this.nextId++;
        // which way it faces: as it moves (a measured velocity), else as a source says, else (most of what's around us)
        // as we do, though
        // loosely: an oncoming car turns itself round once it's seen to move toward us (PhysFilter.settle)
        let psi0 = pose[2], sPsi0 = 1.2;
        if (v !== null && hypot(v[0], v[1]) > HEADING_FROM_MOTION) { psi0 = Math.atan2(v[1], v[0]); sPsi0 = 0.3; }
        else if (m.heading !== null) { psi0 = pose[2] + m.heading * Math.PI / 180; sPsi0 = HEADING_SIGMA[m.src] ?? 0.5; }
        this.tracks.set(tid, new Track(tid, t, z, o, Rp, v, Rv, m, psi0, sPsi0, vEgo));
        innovation = [0, 0];
      } else {
        const tr = this.tracks.get(tid);
        const c = tr.centerFor(z, o);
        innovation = [c[0] - tr.pos[0], c[1] - tr.pos[1]];
        tr.update(z, o, Rp, v, Rv);
      }
      const tr = this.tracks.get(tid);
      this._annotate(tr, m, matvec(Rt, innovation), pose[2]);
      this.sticky.set(`${m.src}:${m.sid}`, tid);
    });
  }

  _annotate(tr, m, resid, h) {
    tr.n += 1;
    tr.last[m.src] = m.t;
    tr.sources[m.src] = { id: m.sid, t: m.t, dx: resid[0], dy: resid[1], info: m.info };
    const rank = SOURCE_RANK[m.src];
    if (m.cls && m.cls !== 'unclassified' && m.cls !== 'unknown' && rank <= tr.clsRank) {
      tr.cls = m.cls; tr.clsRank = rank;
    } else if (tr.cls === null) {
      tr.cls = m.src === 'op' ? 'car' : m.cls;
    }
    if (m.dims && rank <= tr.clsRank) tr.dims = m.dims;
    if ((m.src === 'adas' && VISION_CLASSES.has(m.cls)) || (m.src === 'op' && (m.info.modelProb ?? 0.0) >= OP_MIN_PROB)) tr.visionT = m.t;
    if (m.src === 'radar') {
      tr.radarAge = Math.max(tr.radarAge, m.info.cycles);
      tr.radarClsN += m.cls !== null ? 1 : 0;
      if (m.dims && m.dims[0] >= THIN_MIN_W) tr.thin = Math.max(tr.thin, m.dims[0] / m.dims[1]);
    }
    if (m.heading !== null && rank <= tr.headingRank) {
      tr.updateHeading(h + m.heading * Math.PI / 180, m.src);
      tr.headingRank = rank;
    }
    // the physical model follows the class and size (they set its limits and its footprint)
    tr.f.cls = physClass(tr.cls);
    tr.f.dims = tr.dims;
    if (!tr.confirmed) {
      if (m.src === 'op') {   // alone, only once it has held for a second with neither the radar nor the ADAS around
        tr.confirmed = m.t - tr.first >= 1.0 && ['radar', 'adas'].every(s => m.t - (this.srcSeen[s] ?? -1e9) > SOURCE_GONE_S);
      } else {
        tr.confirmed = m.src === 'adas' || (tr.n >= CONFIRM_UPDATES && m.t - tr.first >= CONFIRM_SPAN_S);
      }
    }
  }

  /** Tracks that are one object: the same source id split in two, two copies close and alike, or (`overlapping`,
   *  pairs of ids from physics.js separate()) two that physically overlap most of a car and move alike. */
  _merge(overlapping = []) {
    const forced = new Set(overlapping.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
    const ids = [...this.tracks.keys()].sort((a, b) => a - b);
    const gone = new Set();
    for (let ai = 0; ai < ids.length; ai++) {
      const a = ids[ai];
      if (gone.has(a)) continue;
      const A = this.tracks.get(a);
      for (let bi = ai + 1; bi < ids.length; bi++) {
        const b = ids[bi];
        if (gone.has(b)) continue;
        const B = this.tracks.get(b);
        if (B.t !== A.t) B.predict(A.t);
        const d = [A.pos[0] - B.pos[0], A.pos[1] - B.pos[1]];
        const same = sameSourceId(A, B);
        const overlaps = forced.has(`${a}:${b}`);
        let keep, drop;
        if (same) {
          // one object split in two (its measurement jumped out of its own track's gate): the copy the source fed
          // last is where the object is now, so its estimate goes on, under the id the view already shows
          if (hypot(d[0], d[1]) > SAME_ID_M) continue;
          [keep, drop] = older(A, B);
          const fresh = A.lastT >= B.lastT ? A : B;
          // (a correction, not motion: what's drawn is put there too, rather than driving over)
          if (fresh !== keep) { keep.f = fresh.f; keep.t = fresh.t; keep.body = null; }
        } else if (overlaps) {
          [keep, drop] = older(A, B);
        } else {
          if (hypot(d[0], d[1]) > MERGE_M || quad2(matadd(block(A.f.P, 0, 2, 0, 2), block(B.f.P, 0, 2, 0, 2)), d) > MERGE_GATE) continue;
          // a new track's velocity is barely known (the radar's lateral velocity especially), so speeds
          // only have to agree within what the two estimates allow
          const dv = [A.vel[0] - B.vel[0], A.vel[1] - B.vel[1]];
          if (hypot(dv[0], dv[1]) > MERGE_V && quad2(matadd(A.f.velCov(), B.f.velCov()), dv) > MERGE_GATE_V) continue;
          [keep, drop] = older(A, B);
        }
        for (const src in drop.sources) {
          const s = drop.sources[src];
          if (!(src in keep.sources) || s.t > keep.sources[src].t) {
            keep.sources[src] = s;
            keep.last[src] = drop.last[src];
          }
        }
        keep.confirmed = keep.confirmed || drop.confirmed;
        keep.n += drop.n;
        if (drop.clsRank < keep.clsRank) {
          keep.cls = drop.cls; keep.clsRank = drop.clsRank; keep.dims = drop.dims || keep.dims;
        }
        if (drop.headingRank < keep.headingRank) keep.headingRank = drop.headingRank;
        keep.f.cls = physClass(keep.cls);
        keep.f.dims = keep.dims;
        if (drop.visionT !== null && (keep.visionT === null || drop.visionT > keep.visionT)) keep.visionT = drop.visionT;
        keep.thin = Math.max(keep.thin, drop.thin);
        keep.radarAge = Math.max(keep.radarAge, drop.radarAge);
        keep.radarClsN = Math.max(keep.radarClsN, drop.radarClsN);
        keep.unseenS = Math.max(keep.unseenS, drop.unseenS);
        keep.conf = Math.max(keep.conf, drop.conf);
        for (const [key, tid] of this.sticky) if (tid === drop.id) this.sticky.set(key, keep.id);
        gone.add(drop.id);
        if (drop === A) break;
      }
    }
    for (const tid of gone) this.tracks.delete(tid);
  }

  /** No two road users in one place, and none in ours (physics.js separate()), as of t; those that overlap most of
   *  a car and move alike are one object. */
  _separate(t) {
    if (!this.tracks.size) return;
    for (const tr of this.tracks.values()) tr.predict(t);
    const pose = this.odo.pose(t);
    const back = FRONT_TO_REAR_AXLE - EGO_L / 2;   // our footprint's center, ahead of the rear axle
    const ego = [pose[0] + back * Math.cos(pose[2]), pose[1] + back * Math.sin(pose[2]), EGO_W, EGO_L, pose[2]];
    // two tracks are surely two objects only when the ADAS camera list has told them apart, seeing each under its
    // own id now (openpilot's two leads don't: its second is most often the first again). Otherwise overlapping
    // tracks are one object seen twice
    const seenAs = (tr, src) => (tr.sources[src] && t - tr.sources[src].t < 0.5 ? tr.sources[src].id : null);
    const distinct = (a, b) => {
      const A = this.tracks.get(a), B = this.tracks.get(b);
      const ia = seenAs(A, 'adas'), ib = seenAs(B, 'adas');
      return ia !== null && ib !== null && ia !== ib;
    };
    const same = separate([...this.tracks.values()].map(tr => ({ f: tr.f, id: tr.id })), ego, 3, distinct);
    if (same.length) this._merge(same);
  }

  _prune(cutoff) {
    for (const tid of [...this.tracks.keys()]) {
      const tr = this.tracks.get(tid);
      const srcs = Object.keys(tr.last);
      if (!tr.confirmed && srcs.length === 1 && srcs[0] === 'op' && cutoff - tr.first > 1.5) {
        this.tracks.delete(tid);   // an openpilot lead nothing else confirmed
        continue;
      }
      const stale = cutoff - tr.lastT;
      const limit = tr.speed() < STATIONARY_SPEED ? COAST_STATIONARY_S : COAST_MOVING_S;
      if ((!tr.confirmed && stale > 0.3) || stale > limit || tr.f.P[0][0] + tr.f.P[1][1] > 50) this.tracks.delete(tid);
    }
    for (const [key, tid] of [...this.sticky]) if (!this.tracks.has(tid)) this.sticky.delete(key);
  }

  /** Ease each track's confidence toward what its evidence supports as of t (see CONF_*); with `settle`
   *  (time standing still, as in a paused replay), go straight there. */
  _confidence(t, settle = false) {
    const pose = this.odo.pose(t);
    const v = this.odo.speed(t);
    const kappa = v > 1.0 ? this.odo.w / v : 0.0;
    const looking = v > UNSEEN_MIN_V && t - this.modelSeen < 1.0;
    const moving = MOVING_SPEED + this.calib.movingFrac * Math.abs(v);
    const seen = new Map(), ahead = new Map(), classified = new Map(), solid = new Map();
    for (const [tid, tr] of this.tracks) seen.set(tid, tr.visionT !== null || 'adas' in tr.last);   // a camera has it
    // tracks in our path within the model's range (m ahead), and the nearest one that surely blocks the model's
    // view past it: one a camera has, or a moving one the radar has classified and tracked for a while
    for (const [tid, tr] of this.tracks) {
      const dt = t - tr.t;
      const S = tr.f.ahead(dt);
      const [x, y] = toEgo(pose, S[0], S[1]);
      const xr = x + FRONT_TO_REAR_AXLE;
      if (UNSEEN_X[0] < x && x < UNSEEN_X[1] && Math.abs(y - kappa * xr * xr / 2) < CORRIDOR_HALF_W) ahead.set(tid, x);
    }
    for (const [tid, tr] of this.tracks) classified.set(tid, tr.radarClsN >= RADAR_CLASS_CYCLES);
    for (const [tid, tr] of this.tracks) solid.set(tid, seen.get(tid) || (classified.get(tid) && tr.radarAge >= RADAR_MATURE_AGE && tr.speed() > moving));
    let blocker = Infinity;
    for (const [tid, x] of ahead) if (solid.get(tid) && x < blocker) blocker = x;

    for (const [tid, tr] of this.tracks) {
      const dt = t - tr.confT;
      const standing = tr.speed() <= moving;
      if (dt > 0 && standing && looking && ahead.has(tid) && ahead.get(tid) < blocker + 2.0 && !seen.get(tid) && tr.cls !== 'pedestrian') tr.unseenS += dt;
      let target, why;
      if (tr.visionT !== null) {
        [target, why] = t - tr.visionT < VISION_HOLD_S ? [CONF_VISION, 'vision'] : [CONF_VISION_HELD, 'vision earlier'];
      } else if (!('adas' in tr.last) && !classified.get(tid)) {
        [target, why] = [CONF_UNCLASSIFIED, 'unclassified'];
      } else if (!('adas' in tr.last) && tr.radarAge < RADAR_MATURE_AGE) {
        [target, why] = [CONF_YOUNG, 'young'];
      } else if (!standing) {
        [target, why] = [CONF_MOVING, 'moving'];
      } else {
        [target, why] = [CONF_STANDING, 'standing'];
        if (tr.thin >= THIN_ASPECT) [target, why] = [target * THIN_FACTOR, 'thin'];
        if (tr.unseenS >= UNSEEN_HOLD_S) [target, why] = [Math.min(target, CONF_UNSEEN), 'unseen'];
      }
      if (t - tr.lastT > CONF_COAST_S) {
        // nothing reports it any more. A standing object stays put on the ground, so it waits out a gap (a parked
        // car the radar loses in a turn) without rising; a moving one would carry on along a velocity that's now
        // a guess, through whatever it's really doing, so it fades out
        target = Math.min(target, tr.conf);
        if (!standing) [target, why] = [0.0, 'coasting'];
      }
      if (settle) tr.conf = target;
      else if (dt > 0) tr.conf += (target - tr.conf) * (1 - Math.exp(-dt / (target > tr.conf ? CONF_RISE_S : CONF_FALL_S)));
      tr.confT = t;
      tr.confWhy = why;
    }
  }

  // ---- output ----
  _output(now) {
    const pose = this.odo.pose(now);
    const h = pose[2];
    const Rt = transpose(rot(h));
    const out = [];
    // what's drawn: each confirmed track's body (physics.js SimBody) driven toward its estimate as of now, then the
    // bodies kept apart and off our car
    const shown = [...this.tracks.values()].filter(tr => tr.confirmed);
    for (const tr of shown) {
      const T = tr.f.ahead(now - tr.t);
      if (!tr.body) { tr.body = new SimBody(tr.f); tr.body.X = T.slice(); tr.bodyT = now; }
      if (now < tr.bodyT) { tr.body.X = T.slice(); tr.bodyT = now; }   // time went back (a seek)
      tr.body.follow(tr.f, T, now - tr.bodyT);
      tr.bodyT = now;
    }
    const back = FRONT_TO_REAR_AXLE - EGO_L / 2;
    separate(shown.map(tr => ({ f: tr.body, id: tr.id })), [pose[0] + back * Math.cos(h), pose[1] + back * Math.sin(h), EGO_W, EGO_L, h]);
    for (const tr of shown) {
      const S = tr.body.X;
      const [w, l] = tr.f.footprint;
      const o = toWorld(pose, 0, 0);
      const face = faceOf(S[0], S[1], o[0], o[1], ...tr.sight, S[2]);
      const [x, y] = toEgo(pose, face[0], face[1]);   // the near face, as the sensors report it
      const [cx, cy] = toEgo(pose, S[0], S[1]);       // the footprint's center
      const v = S[3];
      const [vx, vy] = matvec(Rt, [v * Math.cos(S[2]), v * Math.sin(S[2])]);
      const speed = Math.abs(v);
      const heading = S[2] - h;
      // where its heading comes from: its motion once it moves, else the source that last set it
      const hsrc = speed > HEADING_FROM_MOTION ? 'motion' : tr.headingRank < 99 ? RANK_SRC[tr.headingRank] : null;
      const sxy = matmul(matmul(Rt, block(tr.f.P, 0, 2, 0, 2)), transpose(Rt));
      const sources = Object.keys(tr.sources).sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b])
        .filter(src => now - tr.sources[src].t < COAST_STATIONARY_S + 1)
        .map(src => { const s = tr.sources[src]; return { src, id: s.id, dx: pyRound(s.dx, 2), dy: pyRound(s.dy, 2), age: pyRound(now - s.t, 2), ...s.info }; });
      out.push({
        id: tr.id,
        x: pyRound(x, 2), y: pyRound(y, 2),
        cx: pyRound(cx, 2), cy: pyRound(cy, 2),
        vx: pyRound(vx, 2), vy: pyRound(vy, 2), speed: pyRound(speed, 2),
        // the physical model: speed along its heading (signed), acceleration, path curvature and the yaw rate and
        // front-wheel angle they make, and the mass its class and size suggest
        v: pyRound(v, 2), accel: pyRound(S[4], 2), curvature: pyRound(S[5], 4), yawRate: pyRound(v * S[5] * 180 / Math.PI, 1),
        steer: pyRound(tr.body.delta * 180 / Math.PI, 1), mass: Math.round(tr.f.mass), fw: pyRound(w, 2), fl: pyRound(l, 2),
        heading: pyRound(wrap(heading) * 180 / Math.PI, 1), headingSrc: hsrc,
        cls: tr.cls || 'unknown',
        w: tr.dims ? tr.dims[0] : null, l: tr.dims ? tr.dims[1] : null, h: tr.dims ? tr.dims[2] : null,
        std: [pyRound(Math.sqrt(Math.max(sxy[0][0], 0)), 2), pyRound(Math.sqrt(Math.max(sxy[1][1], 0)), 2)],
        age: pyRound(now - tr.first, 1),
        stale: pyRound(Math.max(0.0, now - FUSION_DELAY_S - tr.lastT), 2),
        stationary: speed < STATIONARY_SPEED,
        conf: pyRound(tr.conf, 2), confWhy: tr.confWhy,
        sources,
      });
    }
    out.sort((a, b) => hypot(a.x, a.y) - hypot(b.x, b.y));
    return out;
  }
}


// ---- source adapters -------------------------------------------------------------------------------

/** One radar cycle (fisker_radar objects, measured at t). Relative velocity is translational, so
 *  over ground it's v_rel + ego speed along x. vEgo is the calibrated speed the odometry runs on. */
export function radarMeasurements(t, objects, vEgo, calib = NO_CALIBRATION) {
  const c = Math.cos(calib.radarYaw), s = Math.sin(calib.radarYaw);
  const kV = calib.radarDopplerScale;
  const out = [];
  for (const o of objects) {
    if (o.age < RADAR_MIN_AGE) continue;
    const x = c * o.x - s * o.y, y = s * o.x + c * o.y;
    const vx = kV * (c * o.vx - s * o.vy), vy = kV * (s * o.vx + c * o.vy);
    const heading = o.heading ?? null;
    const [sx, sy, svx, svy, k] = radarNoise(hypot(x, y), o.age, o.hist ?? 0xFF);
    out.push(new Meas('radar', o.id, t, x, y, sx, sy, {
      vx: vx + vEgo, vy, svx, svy, weight: 1.0 / k,
      cls: o.cls === 'unclassified' ? null : o.cls,
      dims: (o.w && o.l) ? [o.w, o.l, 1.5] : null,
      heading: heading === null ? null : heading + calib.radarYaw * 180 / Math.PI,
      info: { cycles: o.age, state: o.state ?? null, quality: o.quality ?? null },
    }));
  }
  return out;
}

export function adasMeasurement(tRx, o, calib = NO_CALIBRATION) {
  const x = o.x / calib.adasXScale - calib.adasXOrigin, y = o.y / calib.adasYScale;
  const [sx, sy] = adasNoise(hypot(x, y));
  const dims = (o.w && o.l) ? [o.w, o.l, o.h ?? null] : null;
  return new Meas('adas', o.id, tRx - calib.adasLatency, x, y, sx, sy, {
    cls: o.cls ?? null, dims, heading: o.heading ?? null, info: { flags: o.flags || [], classConf: o.classConf ?? null },
  });
}

export function opMeasurements(t, rs, vEgo, calib = NO_CALIBRATION) {
  const out = [];
  const one = rs.leadOne || {};
  ['leadOne', 'leadTwo'].forEach((key, i) => {
    const ld = rs[key];
    if (!ld || !ld.present || ld.dRel == null) return;
    // leadTwo from the camera model is its lead 2 s from now, most often the car that's leadOne now: a second
    // object a few meters off it (route 000000b4--d0f733ebb2--5 showed one for 15 s)
    if (i === 1 && !ld.radar && one.present && one.dRel != null &&
        Math.abs(ld.dRel - one.dRel) < Math.max(LEAD_TWO_SAME_M, LEAD_TWO_SAME_FRAC * one.dRel) &&
        Math.abs((ld.yRel || 0.0) - (one.yRel || 0.0)) < LEAD_TWO_SAME_Y) return;
    const prob = ld.modelProb || 0.0;
    const dRel = ld.dRel + (ld.radar ? 0.0 : calib.opXOffset);
    const [sx, sy, svx] = opNoise(dRel, prob, Boolean(ld.radar));
    const v = ld.vLead != null ? ld.vLead : (ld.vRel != null ? ld.vRel + vEgo : null);
    out.push(new Meas('op', i, t, dRel, ld.yRel || 0.0, sx, sy, {
      vx: v, vy: null, svx, svy: 10.0, cls: 'car',
      info: { modelProb: prob, radar: Boolean(ld.radar), aLead: ld.aLead ?? null },
    }));
  });
  return out;
}
