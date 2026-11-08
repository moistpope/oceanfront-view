#!/usr/bin/env node
// Runs the page's world model (static/js/world) over a route's ticks (tools/route_ticks.py) and writes, for every
// road-camera frame, what it shows then: each object's footprint and heading in our car's frame, and the raw
// measurements each sensor gave (as the model takes them, calibration applied). tools/route_overlay.py draws them
// over the camera video and in a top-down view.
//
//   node tools/route_overlay.mjs <out>.ticks.jsonl <out>.frames.json > <out>.overlay.jsonl
//   node tools/route_overlay.mjs --root /path/to/other/checkout ...    # another version of the world model
//
// One JSON line per camera frame: {i, t, v (our speed), objs: [{id, cls, cx, cy, h, w, l, hgt, v, a, k, conf,
// src, lead, threat}], raw: {radar: [[x, y]], adas: [[x, y]], op: [[x, y]]}}. x ahead of our front bumper, y left,
// m; h the heading relative to ours, rad. The old model (no cx/cy) is given its center the way the view placed it.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (args[0] === '--root') { root = path.resolve(args[1]); args.splice(0, 2); }
const [ticksFile, framesFile] = args;
if (!ticksFile || !framesFile) { console.error('usage: route_overlay.mjs [--root dir] <ticks.jsonl> <frames.json>'); process.exit(2); }

const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { DBC } = await imp('static/js/world/dbc.js');
const { StateBuilder, wireFrames } = await imp('static/js/world/state.js');
const W = await imp('static/js/world/world_model.js');
const dbc = (f) => new DBC(fs.readFileSync(path.join(root, 'dbc', f), 'latin1'));
const builder = new StateBuilder(dbc('fisker_ocean_adas_world.dbc'), dbc('fisker_ocean_mrr.dbc'));

const DEF = { car: [1.85, 4.6, 1.5], truck: [2.5, 10, 3.5], motorcycle: [0.8, 2.1, 1.4], bicycle: [0.6, 1.8, 1.7], pedestrian: [0.6, 0.6, 1.7] };
const r2 = (x) => Math.round(x * 100) / 100;
const meta = JSON.parse(fs.readFileSync(framesFile, 'utf8'));
const frames = meta.frames;

// the old model reports the face nearest us: the view moved its center half a length on along its heading (or half
// a width side-on), as scene.js did
function center(o, dims) {
  if (o.cx !== undefined) return [o.cx, o.cy];
  const hd = (o.heading || 0) * Math.PI / 180, ax = Math.cos(hd), ay = Math.sin(hd), d = Math.hypot(o.x, o.y);
  if (d <= 2) return [o.x, o.y];
  const along = (o.x * ax + o.y * ay) / d;
  if (Math.abs(along) >= 0.5) { const k = Math.sign(along) * dims[1] / 2; return [o.x + k * ax, o.y + k * ay]; }
  const k = Math.sign(o.y * ax - o.x * ay) * dims[0] / 2;
  return [o.x - k * ay, o.y + k * ax];
}

let fi = 0;
const rl = readline.createInterface({ input: fs.createReadStream(ticksFile) });
const lines = [];
for await (const line of rl) if (line.trim()) lines.push(line);
for (let li = 0; li < lines.length && fi < frames.length; li++) {
  const tick = JSON.parse(lines[li]);
  const nextNow = li + 1 < lines.length ? JSON.parse(lines[li + 1]).now : Infinity;
  if (tick.reset) builder.reset();
  if (tick.brand !== undefined) builder.setBrand(tick.brand);
  for (const [t, fr] of tick.can || []) builder.feedCan(wireFrames(fr), t);
  for (const [which, t, data] of tick.op || []) builder.feedService(which, data, t);
  // every frame up to the next tick, as of the frame's own time
  while (fi < frames.length && frames[fi][0] < nextNow) {
    const [t] = frames[fi];
    if (t < tick.now - 0.5) { fi++; continue; }   // before the data starts
    const snap = builder.snapshot(t);
    const calib = builder.model.calib;
    const v = builder.model.odo.speed(t);
    const objs = (snap.objects || []).map((o) => {
      const d = DEF[o.cls] || DEF.car;
      const dims = [o.fw ?? o.w ?? d[0], o.fl ?? o.l ?? d[1], o.h ?? d[2]];
      const [cx, cy] = center(o, dims);
      const adas = o.sources.find(s => s.src === 'adas'), flags = (adas && adas.flags) || [];
      return { id: o.id, cls: o.cls, cx: r2(cx), cy: r2(cy), h: r2((o.heading || 0) * Math.PI / 180), w: dims[0], l: dims[1], hgt: dims[2],
        v: o.v ?? o.speed, a: o.accel ?? null, k: o.curvature ?? null, conf: o.conf, src: o.sources.map(s => s.src),
        lead: flags.includes('accPrimary') || flags.includes('leading'), threat: flags.some(f => ['bsd', 'dow', 'aeb', 'raeb', 'bacm', 'elka'].includes(f)) };
    });
    const raw = { radar: [], adas: [], op: [] };
    if (snap.radar && snap.radar.objects) for (const m of W.radarMeasurements(t, snap.radar.objects, v, calib)) raw.radar.push([r2(m.x), r2(m.y)]);
    for (const o of (snap.fisker && snap.fisker.objects) || []) { const m = W.adasMeasurement(t, o, calib); raw.adas.push([r2(m.x), r2(m.y)]); }
    const radarState = snap.op && snap.op.radarState;
    if (radarState) for (const m of W.opMeasurements(t, radarState, v, calib)) raw.op.push([r2(m.x), r2(m.y)]);
    process.stdout.write(JSON.stringify({ i: fi, t, v: r2(v), objs, raw }) + '\n');
    fi++;
  }
}
