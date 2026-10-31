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

  /** The nearest link segment within MATCH_M of (x, y) running along (ux, uy) either way, or null. */
  match(x, y, ux, uy) {
    const a = this.grid.get(Math.floor(x / GRID_M) + ',' + Math.floor(y / GRID_M));
    if (!a) return null;
    let best = null, bestD = MATCH_M;
    for (const s of a) {
      if (Math.abs(s.ux * ux + s.uy * uy) < MATCH_COS) continue;
      const t = Math.max(0, Math.min(s.len, (x - s.x0) * s.ux + (y - s.y0) * s.uy));
      const d = Math.hypot(s.x0 + s.ux * t - x, s.y0 + s.uy * t - y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
}

/** The OS width of an OSM way (nodes: [lat0, lon0, ...]) from the index, or null when it doesn't run along OS links.
 *  covered(lat, lon) says whether OS links are loaded there (samples elsewhere neither match nor count against). */
export function wayWidth(nodes, index, covered = () => true) {
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
    const s = index.match(x, y, ux, uy);
    if (s) widths.push(s.link.w);
  }
  if (!samples || widths.length / samples < MIN_SHARE) return null;
  widths.sort((a, b) => a - b);
  return widths[widths.length >> 1];
}
