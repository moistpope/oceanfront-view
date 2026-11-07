#!/usr/bin/env node
// Scores the world model's objects over a recorded tick stream for physical plausibility: what a real road user
// can't do. Runs the page's pipeline (static/js/world, as tools/replay_ticks.mjs does) and follows each object
// in the ground frame (the model's own ego odometry) from snapshot to snapshot:
//   spin     how fast it turns while (nearly) standing (deg/s; a car can't turn without rolling)
//   slip     how far its motion is from where it points while moving (deg; tyres don't slide sideways)
//   accel    how hard its speed changes (m/s^2) and how often past 6 m/s^2 (beyond a hard launch, short of a crash)
//   yaw      how fast it turns while moving, against the most its tyres grip (lateral acceleration, m/s^2)
//   overlap  vehicle pairs whose footprints overlap, per snapshot, and with our car
//   jitter   how far each position is off the line between its neighbours (m), the shake a viewer sees
// plus how many objects it showed and for how long.
//
//   node tools/track_eval.mjs ticks.jsonl                 # this checkout
//   node tools/track_eval.mjs --root /path/to/other ticks.jsonl   # another copy of the repo (e.g. git archive of master)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (args[0] === '--root') { root = path.resolve(args[1]); args.splice(0, 2); }
const file = args[0];
if (!file) { console.error('usage: track_eval.mjs [--root dir] <ticks.jsonl>'); process.exit(2); }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { DBC } = await imp('static/js/world/dbc.js');
const { StateBuilder, wireFrames } = await imp('static/js/world/state.js');
const { FRONT_TO_REAR_AXLE } = await imp('static/js/world/world_model.js');
const dbc = (f) => new DBC(fs.readFileSync(path.join(root, 'dbc', f), 'latin1'));
const builder = new StateBuilder(dbc('fisker_ocean_adas_world.dbc'), fs.existsSync(path.join(root, 'dbc/fisker_ocean_mrr.dbc')) ? dbc('fisker_ocean_mrr.dbc') : null);

const VEH = new Set(['car', 'truck', 'motorcycle', 'bicycle']);
const DEF = { car: [1.85, 4.6], truck: [2.5, 10], motorcycle: [0.8, 2.1], bicycle: [0.6, 1.8] };
const wrap = (a) => (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// the object's footprint center and heading in the ground frame: the new model gives the center (cx, cy), the old
// one the near face, which the view moved back by half the length along the heading (scene.js), as here
function ground(o, pose) {
  const hRel = (o.heading || 0) * Math.PI / 180;
  const [w, l] = [o.fw ?? o.w ?? DEF[o.cls]?.[0] ?? 1.8, o.fl ?? o.l ?? DEF[o.cls]?.[1] ?? 4.5];
  let ex, ey;
  if (o.cx !== undefined) { ex = o.cx; ey = o.cy; } else {
    const r = Math.hypot(o.x, o.y) || 1;
    const sideOn = Math.abs(Math.cos(hRel - Math.atan2(o.y, o.x))) < 0.5;
    const e = sideOn ? w / 2 : l / 2;
    ex = o.x + o.x / r * e; ey = o.y + o.y / r * e;
  }
  const xr = ex + FRONT_TO_REAR_AXLE, c = Math.cos(pose[2]), s = Math.sin(pose[2]);
  return { x: pose[0] + c * xr - s * ey, y: pose[1] + s * xr + c * ey, h: pose[2] + hRel, w, l };
}

function boxesOverlap(A, B) {
  const corners = (b) => { const c = Math.cos(b.h), s = Math.sin(b.h), a = b.l / 2, d = b.w / 2;
    return [[b.x + c * a - s * d, b.y + s * a + c * d], [b.x + c * a + s * d, b.y + s * a - c * d], [b.x - c * a + s * d, b.y - s * a - c * d], [b.x - c * a - s * d, b.y - s * a + c * d]]; };
  const ca = corners(A), cb = corners(B);
  for (const h of [A.h, A.h + Math.PI / 2, B.h, B.h + Math.PI / 2]) {
    const ax = [Math.cos(h), Math.sin(h)];
    const pa = ca.map(p => p[0] * ax[0] + p[1] * ax[1]), pb = cb.map(p => p[0] * ax[0] + p[1] * ax[1]);
    if (Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= 0.05) return false;
  }
  return true;
}

const hist = new Map();   // id -> [{t, x, y, h}]
const M = { spin: [], slip: [], accel: [], latAcc: [], jitter: [], overlaps: 0, egoOverlaps: 0, frames: 0, objFrames: 0 };
const lives = new Map();

const rl = readline.createInterface({ input: fs.createReadStream(file) });
for await (const line of rl) {
  if (!line.trim()) continue;
  const tick = JSON.parse(line);
  if (tick.reset) { builder.reset(); hist.clear(); }
  if (tick.brand !== undefined) builder.setBrand(tick.brand);
  for (const [t, frames] of tick.can || []) builder.feedCan(wireFrames(frames), t);
  for (const [which, t, data] of tick.op || []) builder.feedService(which, data, t);
  const snap = builder.snapshot(tick.now);
  const pose = builder.model.odo.pose(tick.now);
  const objs = (snap.objects || []).filter(o => o.conf >= 0.35);
  M.frames++;
  const boxes = [];
  for (const o of objs) {
    M.objFrames++;
    const g = ground(o, pose);
    const life = lives.get(o.id) || [tick.now, tick.now]; life[1] = tick.now; lives.set(o.id, life);
    if (VEH.has(o.cls)) boxes.push(g);
    const H = hist.get(o.id) || [];
    H.push({ t: tick.now, ...g });
    while (H.length > 3) H.shift();
    hist.set(o.id, H);
    if (H.length < 3) continue;
    const [a, b, c] = H;
    const dt1 = b.t - a.t, dt2 = c.t - b.t;
    if (dt1 <= 0.01 || dt2 <= 0.01 || dt1 > 0.3 || dt2 > 0.3) continue;
    const v1 = Math.hypot(b.x - a.x, b.y - a.y) / dt1, v2 = Math.hypot(c.x - b.x, c.y - b.y) / dt2;
    const dh = Math.abs(wrap(c.h - b.h)) / dt2;
    if (!VEH.has(o.cls)) continue;
    if (v2 < 0.5) M.spin.push(dh * 180 / Math.PI);
    if (v2 > 2) {
      const dir = Math.atan2(c.y - b.y, c.x - b.x);
      M.slip.push(Math.min(Math.abs(wrap(dir - c.h)), Math.abs(wrap(dir - c.h - Math.PI))) * 180 / Math.PI);
      M.latAcc.push(dh * v2);
    }
    M.accel.push(Math.abs(v2 - v1) / ((dt1 + dt2) / 2));
    // how far the middle sample is off the line between its neighbours, by their times (uneven snapshot spacing
    // isn't shake)
    const f = dt1 / (dt1 + dt2);
    M.jitter.push(Math.hypot(b.x - (a.x + (c.x - a.x) * f), b.y - (a.y + (c.y - a.y) * f)));
  }
  const back = FRONT_TO_REAR_AXLE - 4.775 / 2;
  const ego = { x: pose[0] + back * Math.cos(pose[2]), y: pose[1] + back * Math.sin(pose[2]), h: pose[2], w: 1.98, l: 4.775 };
  for (let i = 0; i < boxes.length; i++) {
    if (boxesOverlap(boxes[i], ego)) M.egoOverlaps++;
    for (let j = i + 1; j < boxes.length; j++) if (boxesOverlap(boxes[i], boxes[j])) M.overlaps++;
  }
}

const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const lifeS = [...lives.values()].map(([a, b]) => b - a);
const out = {
  snapshots: M.frames,
  objects: lives.size,
  'median life (s)': f(pct(lifeS, 0.5)),
  'spin standing p95/max (deg/s)': `${f(pct(M.spin, 0.95))} / ${f(Math.max(...M.spin, 0))}`,
  'slip moving p50/p95 (deg)': `${f(pct(M.slip, 0.5))} / ${f(pct(M.slip, 0.95))}`,
  'accel p95/p99 (m/s^2)': `${f(pct(M.accel, 0.95))} / ${f(pct(M.accel, 0.99))}`,
  'accel > 6 m/s^2 (share)': f(100 * M.accel.filter(a => a > 6).length / Math.max(1, M.accel.length), 2) + '%',
  'lateral accel p99 (m/s^2)': f(pct(M.latAcc, 0.99)),
  'jitter p95 (cm)': f(100 * pct(M.jitter, 0.95)),
  'vehicle overlaps (pair-snapshots)': M.overlaps,
  'overlaps with our car': M.egoOverlaps,
};
for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(36)} ${v}`);
