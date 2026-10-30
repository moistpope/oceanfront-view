// The road network's meshes as plain arrays (roadnet.js draws them): mapsurface.js `roadNetwork` laid out as
// strips, lines, dashes and arrows, each kind one {pos: Float32Array, idx: Uint32Array}. No three.js and no DOM, so
// roadnetworker.js can build them off the page's thread (a town's network takes tens of ms on the head unit).
import { roadNetwork, NET_LINE_LIFT } from './mapsurface.js';

const DASH = 3.0, GAP = 9.0;   // the network's lane dashes (world-fixed, so laid out once)
const CENTER_DASH = 4.0, CENTER_GAP = 5.0;   // a single (UK / European) center line's: longer than a lane line's
// The strips lie just above the ground plane (-0.01) and below the tires' contact plane (0), so the car stands on
// them rather than in them; against the plane, far out where millimeters are below the depth buffer's resolution,
// they win by polygon offset instead of height, and the lines over them by a larger one.
const STRIP_LIFT = -0.004;

/** The meshes for `layer` (the worker's roads layer), by material: strip, edge, center, centerSingle, arrow, lane. */
export function roadArrays(layer, leftTraffic, usLines) {
  const net = roadNetwork(layer, leftTraffic, usLines);
  const single = net.centerStyle === 'single', centerDashes = [];
  if (single) { for (const l of net.centers) centerDashes.push(...dashed(l, CENTER_DASH, CENTER_GAP)); centerDashes.push(...net.solids); }
  const dashes = [];
  for (const l of net.lanes) dashes.push(...dashed(l));
  return {
    strip: stripsGeometry(net.strips, STRIP_LIFT),
    edge: linesGeometry(net.edges, 0.25, NET_LINE_LIFT),
    center: linesGeometry(single ? [] : [...net.centers, ...net.yellowDashed.flatMap(l => dashed(l, CENTER_DASH, CENTER_GAP))], 0.13, NET_LINE_LIFT),
    centerSingle: linesGeometry(centerDashes, 0.15, NET_LINE_LIFT),
    arrow: trianglesGeometry(net.arrows, NET_LINE_LIFT),
    lane: linesGeometry(dashes, 0.12, NET_LINE_LIFT),
  };
}

// pose frame (x east, y north) -> world-group axes (X = -y, Z = -x), like the world objects
const toWorld = (x, y, lift) => [-y, lift, -x];

function stripsGeometry(strips, lift) {
  const pos = [], idx = [];
  for (const { left, right } of strips) {
    const m = Math.min(left.length, right.length);
    if (m < 2) continue;
    const base = pos.length / 3;
    for (let i = 0; i < m; i++) { pos.push(...toWorld(left[i][0], left[i][1], lift), ...toWorld(right[i][0], right[i][1], lift)); }
    for (let i = 0; i < m - 1; i++) { const a = base + 2 * i, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
  }
  return geometry(pos, idx);
}

function linesGeometry(lines, width, lift) {
  const pos = [], idx = [];
  for (const pts of lines) {
    if (pts.length < 2) continue;
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      dx /= L; dy /= L;
      const nx = -dy * width / 2, ny = dx * width / 2;
      pos.push(...toWorld(pts[i][0] + nx, pts[i][1] + ny, lift), ...toWorld(pts[i][0] - nx, pts[i][1] - ny, lift));
    }
    for (let i = 0; i < pts.length - 1; i++) { const a = base + 2 * i, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
  }
  return geometry(pos, idx);
}

function geometry(pos, idx) {
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

function trianglesGeometry(tris, lift) {
  const pos = [], idx = [];
  for (const t of tris) { const b = pos.length / 3; for (const p of t) pos.push(...toWorld(p[0], p[1], lift)); idx.push(b, b + 1, b + 2); }
  return geometry(pos, idx);
}

function dashed(pts, dash = DASH, gap = GAP) {
  const P = dash + gap, out = [];
  let s0 = 0, cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) continue;
    const at = (d) => [x0 + (x1 - x0) * d / len, y0 + (y1 - y0) * d / len];
    let a = 0;
    while (a < len) {
      const m = ((s0 + a) % P + P) % P, on = m < dash;
      const next = Math.min(len, a + (on ? dash - m : P - m));
      if (on) { if (!cur) { cur = [at(a)]; out.push(cur); } cur.push(at(next)); } else cur = null;
      a = next;
    }
    s0 += len;
  }
  return out.filter(p => p.length >= 2);
}
