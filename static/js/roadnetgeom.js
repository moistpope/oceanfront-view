// The road network's meshes as plain arrays (roadnet.js draws them): mapsurface.js `roadNetwork` laid out as
// strips, lines, dashes and arrows, each kind one {pos: Float32Array, idx: Uint32Array}. No three.js and no DOM, so
// roadnetworker.js can build them off the page's thread (a town's network takes tens of ms on the head unit).
import { roadNetwork, NET_LINE_LIFT } from './mapsurface.js';
import earcut from './earcut.js';

const DASH = 3.0, GAP = 9.0;   // the network's lane dashes (world-fixed, so laid out once)
const CENTER_DASH = 4.0, CENTER_GAP = 5.0;   // a single (UK / European) center line's: longer than a lane line's
// The strips lie just above the ground plane (-0.01) and below the tires' contact plane (0), so the car stands on
// them rather than in them; against the plane, far out where millimeters are below the depth buffer's resolution,
// they win by polygon offset instead of height, and the lines over them by a larger one.
const STRIP_LIFT = -0.004;

/** The meshes for `layer` (the worker's roads layer), by material: strip, pave, edge, center, centerSingle, arrow, lane. */
export function roadArrays(layer, leftTraffic, usLines) {
  const net = roadNetwork(layer, leftTraffic, usLines);
  const single = net.centerStyle === 'single', centerDashes = [];
  if (single) { for (const l of net.centers) centerDashes.push(...dashed(l, CENTER_DASH, CENTER_GAP)); centerDashes.push(...net.solids); }
  const dashes = [];
  for (const l of net.lanes) dashes.push(...dashed(l));
  // Ordnance Survey's surveyed surfaces (Great Britain, with that map data on): the carriageway joins the strips, filling
  // the junction mouths and widenings the strips don't have; pavements and central reservations are drawn over the
  // strips and their lines, so the road shows only where it really is
  const surf = layer.surfaces || [];
  const road = polygonsGeometry(surf.filter(p => p.kind === 'R'), STRIP_LIFT);
  // where OS has surveyed the road, its kerbs are the pavements' edges: OSM's edge lines, laid at a width worked out
  // from the lane count, would run down the middle of a junction mouth or a widening, or a metre off the kerb
  const edges = surf.length ? offSurfaces(net.edges, surf, layer) : net.edges;
  return {
    strip: concat(stripsGeometry(net.strips, STRIP_LIFT), road),
    pave: polygonsGeometry(surf.filter(p => p.kind !== 'R'), NET_LINE_LIFT + 0.002),
    edge: linesGeometry(edges, 0.25, NET_LINE_LIFT),
    center: linesGeometry(single ? [] : [...net.centers, ...net.yellowDashed.flatMap(l => dashed(l, CENTER_DASH, CENTER_GAP))], 0.13, NET_LINE_LIFT),
    centerSingle: linesGeometry(centerDashes, 0.15, NET_LINE_LIFT),
    arrow: trianglesGeometry(net.arrows, NET_LINE_LIFT),
    lane: linesGeometry(dashes, 0.12, NET_LINE_LIFT),
  };
}

const SURF_CELL = 1;    // m: the grid OS's surfaces are rasterised on to test lines against
const SURF_NEAR = 2;    // cells: a line point this close to an OS surface is on OS's road
const SURF_STEP = 1;    // m: lines are tested this often along

/** The parts of `lines` that don't lie on or by OS's surfaces (any kind): where OS hasn't surveyed the road. */
export function offSurfaces(lines, surf, layer) {
  const grid = surfaceGrid(surf, layer);
  if (!grid) return lines;
  const out = [];
  for (const pts of lines) {
    let cur = null;
    const visit = (p) => {
      if (grid.near(p[0], p[1])) { if (cur && cur.length >= 2) out.push(cur); cur = null; }
      else { if (!cur) cur = []; cur.push(p); }
    };
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], L = Math.hypot(x1 - x0, y1 - y0), k = Math.floor(L / SURF_STEP);
        for (let j = 1; j < k; j++) visit([x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k]);
      }
      visit(pts[i]);
    }
    if (cur && cur.length >= 2) out.push(cur);
  }
  return out;
}

/** OS's surfaces as an occupancy grid over the layer's box, grown by SURF_NEAR cells: { near(x, y) }. */
function surfaceGrid(surf, layer) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { rings } of surf) for (const [x, y] of rings[0] || []) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (layer && layer.r > 0) {   // no bigger than the layer's box (and a margin): a far polygon mustn't make a huge grid
    x0 = Math.max(x0, layer.cx - layer.r - 50); y0 = Math.max(y0, layer.cy - layer.r - 50);
    x1 = Math.min(x1, layer.cx + layer.r + 50); y1 = Math.min(y1, layer.cy + layer.r + 50);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  const nx = Math.ceil((x1 - x0) / SURF_CELL) + 1, ny = Math.ceil((y1 - y0) / SURF_CELL) + 1;
  if (nx * ny > 4e6) return null;
  const g = new Uint8Array(nx * ny);
  // each polygon filled at its cells' centers, even-odd across its rings (holes stay empty)
  for (const { rings } of surf) {
    let ry0 = Infinity, ry1 = -Infinity;
    for (const [, y] of rings[0] || []) { ry0 = Math.min(ry0, y); ry1 = Math.max(ry1, y); }
    const j0 = Math.max(0, Math.ceil((ry0 - y0) / SURF_CELL - 0.5)), j1 = Math.min(ny - 1, Math.floor((ry1 - y0) / SURF_CELL - 0.5));
    for (let j = j0; j <= j1; j++) {
      const yc = y0 + (j + 0.5) * SURF_CELL, xs = [];
      for (const ring of rings) for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, ya] = ring[a], [xb, yb] = ring[b];
        if ((ya > yc) !== (yb > yc)) xs.push(xa + (yc - ya) * (xb - xa) / (yb - ya));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - x0) / SURF_CELL - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / SURF_CELL - 0.5));
        for (let i = i0; i <= i1; i++) g[j * nx + i] = 1;
      }
    }
  }
  return {
    near(x, y) {
      const ci = Math.floor((x - x0) / SURF_CELL), cj = Math.floor((y - y0) / SURF_CELL);
      for (let j = Math.max(0, cj - SURF_NEAR); j <= Math.min(ny - 1, cj + SURF_NEAR); j++)
        for (let i = Math.max(0, ci - SURF_NEAR); i <= Math.min(nx - 1, ci + SURF_NEAR); i++) if (g[j * nx + i]) return true;
      return false;
    },
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

/** Polygons ({rings: [[[x, y], ...] outline, holes...]}) triangulated flat at `lift`. */
function polygonsGeometry(polys, lift) {
  const pos = [], idx = [];
  for (const { rings } of polys) {
    const flat = [], holes = [];
    rings.forEach((ring, r) => { if (r) holes.push(flat.length / 2); for (const [x, y] of ring) flat.push(x, y); });
    const tri = earcut(flat, holes);
    if (!tri.length) continue;
    const base = pos.length / 3;
    for (let i = 0; i < flat.length; i += 2) pos.push(...toWorld(flat[i], flat[i + 1], lift));
    for (const t of tri) idx.push(base + t);
  }
  return geometry(pos, idx);
}

/** Two geometries as one. */
function concat(a, b) {
  if (!b.idx.length) return a;
  const pos = new Float32Array(a.pos.length + b.pos.length), idx = new Uint32Array(a.idx.length + b.idx.length);
  pos.set(a.pos); pos.set(b.pos, a.pos.length);
  idx.set(a.idx); const off = a.pos.length / 3;
  for (let i = 0; i < b.idx.length; i++) idx[a.idx.length + i] = b.idx[i] + off;
  return { pos, idx };
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
