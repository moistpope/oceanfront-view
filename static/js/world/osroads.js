// Ordnance Survey's carriageway widths on the OSM ways (the "Ordnance Survey" map data setting, Great Britain only).
// OSM there rarely says how wide a road is; OS measures every road link kerb to kerb. The server fetches a FEAT_DEG
// cell's road links once (GET /map/os/<klat>/<klon>, OsRoads.kt) as [avgWidth, minWidth, dir, kind, lon0, lat0, ...],
// and the width of the links an OSM way lies along becomes the way's `osWidth`, which roaddetail.js laneLayout uses
// where OSM gives no width of its own. The two maps are drawn separately, so a way takes a width only when most of
// it runs along OS links (close by and parallel); junction mouths and odd stretches don't count.

const DEG = Math.PI / 180;
const EARTH_R = 6378137.0;
const STEP_M = 10;          // sample the way this often
const END_M = 12;           // and not this close to its ends, where it meets other roads
const MATCH_M = 8;          // an OS link this close and
const MATCH_COS = Math.cos(25 * DEG);   // this parallel is the same carriageway
const MIN_SHARE = 0.6;      // of the samples (those inside loaded cells) that must match
const GRID_M = 40;

/** The links of a cell as the server sends them: [{w, wMin, dir, kind, pts: [lat0, lon0, lat1, lon1, ...]}]. */
export function parseLinks(cell) {
  const out = [];
  for (const l of (cell && cell.links) || []) {
    if (!Array.isArray(l) || l.length < 8 || !(l[0] > 0)) continue;
    const pts = [];
    for (let i = 4; i + 1 < l.length; i += 2) pts.push(l[i + 1], l[i]);
    out.push({ w: l[0], wMin: l[1], dir: l[2], kind: l[3], pts });
  }
  return out;
}

/** A segment index of OS links around lat0, for matching. */
export class LinkIndex {
  constructor(lat0, lon0) {
    this.lat0 = lat0; this.lon0 = lon0;
    this.kx = DEG * EARTH_R * Math.cos(lat0 * DEG); this.ky = DEG * EARTH_R;
    this.grid = new Map();
    this.size = 0;
  }

  xy(lat, lon) { return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]; }

  add(links) {
    for (const l of links) {
      const p = l.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const [x0, y0] = this.xy(p[i], p[i + 1]), [x1, y1] = this.xy(p[i + 2], p[i + 3]);
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 0.01) continue;
        const seg = { x0, y0, x1, y1, ux: (x1 - x0) / len, uy: (y1 - y0) / len, len, link: l };
        const gx0 = Math.floor((Math.min(x0, x1) - MATCH_M) / GRID_M), gx1 = Math.floor((Math.max(x0, x1) + MATCH_M) / GRID_M);
        const gy0 = Math.floor((Math.min(y0, y1) - MATCH_M) / GRID_M), gy1 = Math.floor((Math.max(y0, y1) + MATCH_M) / GRID_M);
        for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
          const k = gx + ',' + gy;
          let a = this.grid.get(k);
          if (!a) this.grid.set(k, a = []);
          a.push(seg);
        }
        this.size++;
      }
    }
  }

  /** The nearest link segment within MATCH_M of (x, y) running along (ux, uy) either way, or null; with oneWay, only
   *  among one-way links (dir != 0), as one half of a dual carriageway is. */
  match(x, y, ux, uy, oneWay = false) {
    const a = this.grid.get(Math.floor(x / GRID_M) + ',' + Math.floor(y / GRID_M));
    if (!a) return null;
    let best = null, bestD = MATCH_M;
    for (const s of a) {
      if (Math.abs(s.ux * ux + s.uy * uy) < MATCH_COS || (oneWay && !s.link.dir)) continue;
      const t = Math.max(0, Math.min(s.len, (x - s.x0) * s.ux + (y - s.y0) * s.uy));
      const d = Math.hypot(s.x0 + s.ux * t - x, s.y0 + s.uy * t - y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
}

/** The OS width of an OSM way (nodes: [lat0, lon0, ...]) from the index, or null when it doesn't run along OS links.
 *  covered(lat, lon) says whether OS links are loaded there (samples elsewhere neither match nor count against). A
 *  one-way way only takes a one-way link's width: a two-way link's is both halves of the road. */
export function wayWidth(nodes, index, covered = () => true, oneWay = false) {
  const pts = [];
  for (let i = 0; i + 1 < nodes.length; i += 2) pts.push(index.xy(nodes[i], nodes[i + 1]));
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (total < 1) return null;
  const short = total < 2 * END_M + STEP_M;   // its middle only
  const from = short ? total / 2 : END_M, to = short ? total / 2 : total - END_M;
  const widths = [];
  let samples = 0;
  let run = 0, seg = 1;
  for (let at = from; at <= to + 1e-6; at += STEP_M) {
    while (seg < pts.length - 1 && run + Math.hypot(pts[seg][0] - pts[seg - 1][0], pts[seg][1] - pts[seg - 1][1]) < at) {
      run += Math.hypot(pts[seg][0] - pts[seg - 1][0], pts[seg][1] - pts[seg - 1][1]);
      seg++;
    }
    const [ax, ay] = pts[seg - 1], [bx, by] = pts[seg];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.01) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len, t = Math.min(len, at - run);
    const x = ax + ux * t, y = ay + uy * t;
    if (!covered(index.lat0 + y / index.ky, index.lon0 + x / index.kx)) continue;
    samples++;
    const s = index.match(x, y, ux, uy, oneWay);
    if (s) widths.push(s.link.w);
  }
  if (!samples || widths.length / samples < MIN_SHARE) return null;
  widths.sort((a, b) => a - b);
  return widths[widths.length >> 1];
}

/** Where an OSM way's nodes lie on the OS centrelines it runs along: [[i, dLat, dLon], ...] for each node (lat/lon
 *  pairs in `nodes`) with a parallel OS link within MATCH_M, the move onto the link's nearest point. The two maps were
 *  surveyed apart, by metres in places, and the road surfaces (parseSurfaces) are OS's: on OS's lines, the road, its
 *  lines and the car agree with them. A one-way OSM way (one half of a dual carriageway, mostly) only moves onto a
 *  one-way OS link: onto a two-way one it would land on the middle of the whole road, both halves on the same line. */
export function snapNodes(nodes, index, covered = () => true, oneWay = false) {
  const n = nodes.length >> 1, out = [];
  const xy = [];
  for (let i = 0; i < n; i++) xy.push(index.xy(nodes[2 * i], nodes[2 * i + 1]));
  for (let i = 0; i < n; i++) {
    if (!covered(nodes[2 * i], nodes[2 * i + 1])) continue;
    // the way's direction at the node: across it, or along the one segment at an end
    const a = xy[Math.max(0, i - 1)], b = xy[Math.min(n - 1, i + 1)];
    const m = snapAt(index, xy[i][0], xy[i][1], b[0] - a[0], b[1] - a[1], oneWay);
    if (m) out.push([i, m[1] / index.ky, m[0] / index.kx]);
  }
  return out;
}

const DENSE_M = 15;   // OSM's long straights get a point this often between their nodes, each put on OS's line

/** The points to put between an OSM way's nodes so that it follows OS's line where OS's bends and OSM's straight
 *  doesn't (a lane with nodes 140 m apart): [[i, lat, lon], ...], each on the OS link next to the segment from node i
 *  to node i + 1, in order. Points with no OS link alongside are left out (that stretch stays straight). */
export function denseOnto(nodes, index, covered = () => true, oneWay = false) {
  const n = nodes.length >> 1, out = [];
  for (let i = 0; i + 1 < n; i++) {
    const [ax, ay] = index.xy(nodes[2 * i], nodes[2 * i + 1]), [bx, by] = index.xy(nodes[2 * i + 2], nodes[2 * i + 3]);
    const L = Math.hypot(bx - ax, by - ay);
    const k = Math.floor(L / DENSE_M);
    if (k < 2) continue;
    for (let j = 1; j < k; j++) {
      const t = j / k, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      const lat = index.lat0 + y / index.ky, lon = index.lon0 + x / index.kx;
      if (!covered(lat, lon)) continue;
      const m = snapAt(index, x, y, bx - ax, by - ay, oneWay);
      if (m) out.push([i, lat + m[1] / index.ky, lon + m[0] / index.kx]);
    }
  }
  return out;
}

/** The move [dx, dy] (m) from (x, y), heading (dx, dy), onto the nearest parallel OS link, or null. */
function snapAt(index, x, y, dx, dy, oneWay) {
  const L = Math.hypot(dx, dy);
  if (L < 0.01) return null;
  const s = index.match(x, y, dx / L, dy / L, oneWay);
  if (!s) return null;
  const t = Math.max(0, Math.min(s.len, (x - s.x0) * s.ux + (y - s.y0) * s.uy));
  const mx = s.x0 + s.ux * t - x, my = s.y0 + s.uy * t - y;
  return Math.hypot(mx, my) < 0.05 ? null : [mx, my];
}

/** The road surfaces of a cell as the server sends them ([kind, ring, hole, ...]; rings [x0, y0, ...] in millionths of
 *  a degree from the cell's `origin` [lon, lat], or plain [lon0, lat0, ...] without one):
 *  [{kind: 'R' | 'P' | 'C', rings: [Float64Array lat0, lon0, lat1, lon1, ...]}]. */
export function parseSurfaces(cell) {
  const out = [];
  const o = cell && Array.isArray(cell.origin) ? cell.origin : null, k = o ? 1e-6 : 1;
  const lon0 = o ? o[0] : 0, lat0 = o ? o[1] : 0;
  for (const p of (cell && cell.polys) || []) {
    if (!Array.isArray(p) || p.length < 2 || !/^[RPC]$/.test(p[0])) continue;
    const rings = [];
    for (let r = 1; r < p.length; r++) {
      const src = p[r];
      if (!Array.isArray(src) || src.length < 6) { if (r === 1) break; continue; }
      const ring = new Float64Array(src.length & ~1);
      for (let i = 0; i + 1 < src.length; i += 2) { ring[i] = lat0 + src[i + 1] * k; ring[i + 1] = lon0 + src[i] * k; }
      rings.push(ring);
    }
    if (rings.length) out.push({ kind: p[0], rings });
  }
  return out;
}
