// The turn in the nav app's own picture of it. Google Maps' turn-by-turn notification often gives only the
// distance and the road ("200 m", "Hartwith Lane"), with what to do there drawn as its large icon: an arrow
// coming up from the bottom and bending the way to go, or, at a roundabout, a ring with the exit leaving it.
// iconManeuver() reads that picture (plain RGBA pixels, no DOM, so it can be tested) as a maneuver like the
// words give (infotainment.js maneuverOf): { kind, side, angle (deg, 0 straight on, + right), fromIcon }, or null
// when it doesn't look like an arrow. iconManeuverFromUrl() decodes a data URL in the page and reads it.

const BOTTOM = 0.15;   // of the arrow's height: its foot, where the stem starts

/** The maneuver drawn in an RGBA image (Uint8ClampedArray w * h * 4), or null. */
export function iconManeuver(rgba, w, h) {
  const n = w * h;
  if (!rgba || rgba.length < n * 4 || n < 64) return null;
  // the arrow: opaque pixels on a transparent icon, else the pixels unlike the corners (an icon on a solid ground)
  let clear = 0;
  for (let i = 0; i < n; i++) if (rgba[4 * i + 3] < 100) clear++;
  const mask = new Uint8Array(n);
  if (clear > n * 0.2) {
    for (let i = 0; i < n; i++) mask[i] = rgba[4 * i + 3] >= 100 ? 1 : 0;
  } else {
    const lum = (i) => 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
    const bg = (lum(0) + lum(w - 1) + lum(n - w) + lum(n - 1)) / 4;
    for (let i = 0; i < n; i++) mask[i] = Math.abs(lum(i) - bg) > 60 ? 1 : 0;
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (area < 20 || x1 - x0 < 3 || y1 - y0 < 3) return null;
  const bh = y1 - y0 + 1, bw = x1 - x0 + 1;
  // the foot: the arrow's pixels in its bottom rows, as runs across
  const footTop = y1 - Math.max(1, Math.round(bh * BOTTOM));
  const cols = new Uint8Array(bw);
  for (let y = footTop; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mask[y * w + x]) cols[x - x0] = 1;
  const runs = [];
  for (let i = 0; i < bw; i++) if (cols[i]) { if (runs.length && runs[runs.length - 1][1] === i - 1) runs[runs.length - 1][1] = i; else runs.push([i, i]); }
  const big = runs.filter(r => r[1] - r[0] + 1 >= Math.max(2, bw * 0.06));
  // two feet far apart: the stem and the head of a U-turn come back down side by side; the head is the wider one
  if (big.length >= 2) {
    const [a, b] = [big[0], big[big.length - 1]], wa = a[1] - a[0], wb = b[1] - b[0];
    if (b[0] - a[1] > bw * 0.15) return { kind: 'uturn', side: wa > wb ? 'left' : 'right', angle: wa > wb ? -180 : 180, fromIcon: true };
  }
  let sx = 0, sy = 0, sn = 0;
  for (let y = footTop; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mask[y * w + x]) { sx += x; sy += y; sn++; }
  sx /= sn; sy = y1;
  // the tip: the end of the arrow, the pixel farthest from its foot going along the arrow (not as the crow flies:
  // a sharp turn's tip comes back down beside its stem)
  const dist = new Int32Array(n).fill(-1), queue = [];
  for (let y = footTop; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * w + x; if (mask[i] && y === y1) { dist[i] = 0; queue.push(i); } }
  let tip = queue[0];
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], x = i % w, y = (i / w) | 0;
    if (dist[i] > dist[tip]) tip = i;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j >= 0 && mask[j] && dist[j] < 0) { dist[j] = dist[i] + 1; queue.push(j); }
    }
  }
  const tx = tip % w, ty = (tip / w) | 0;
  if (Math.hypot(tx - sx, ty - sy) < Math.max(bw, bh) * 0.3) return null;
  const hole = holeAt(mask, w, h, area);
  if (hole) {
    // a roundabout: the exit is the arm reaching farthest from the ring's middle, the foot (the way in) aside
    let ex = null, ey = null, far = -1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mask[y * w + x]) {
      if (y >= footTop && Math.abs(x - sx) < bw * 0.2) continue;
      const d = (x - hole[0]) ** 2 + (y - hole[1]) ** 2;
      if (d > far) { far = d; ex = x; ey = y; }
    }
    if (ex == null) return { kind: 'roundabout', side: null, angle: null, fromIcon: true };
    const ang = Math.atan2(ex - hole[0], hole[1] - ey) * 180 / Math.PI;
    return { kind: 'roundabout', side: Math.abs(ang) < 20 ? null : ang > 0 ? 'right' : 'left', angle: ang, fromIcon: true };
  }
  // which way it points there: from the last of the shaft to the head, both found by how far along the arrow they lie
  // (so the head's wings, as far along as its point, don't skew it)
  const D = dist[tip];
  let hx = 0, hy = 0, hn = 0, kx = 0, ky = 0, kn = 0;
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    if (d < 0) continue;
    if (d >= 0.85 * D) { hx += i % w; hy += (i / w) | 0; hn++; } else if (d >= 0.55 * D) { kx += i % w; ky += (i / w) | 0; kn++; }
  }
  if (!hn || !kn) return null;
  hx /= hn; hy /= hn; kx /= kn; ky /= kn;
  const angle = Math.atan2(hx - kx, ky - hy) * 180 / Math.PI;
  const a = Math.abs(angle), side = Math.abs(angle) < 10 ? null : angle > 0 ? 'right' : 'left';
  const kind = a < 20 ? 'straight' : a < 60 ? 'slight' : a < 125 ? 'turn' : a < 165 ? 'sharp' : 'uturn';
  return { kind, side: kind === 'straight' ? null : side, angle, fromIcon: true };
}

/** The middle [x, y] of an enclosed clear piece of the picture (a roundabout's ring), or null. */
function holeAt(mask, w, h, area) {
  const seen = new Uint8Array(w * h), stack = [];
  const push = (i) => { if (!mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  let enclosed = 0, cx = 0, cy = 0;
  for (let i = 0; i < w * h; i++) if (!mask[i] && !seen[i]) { enclosed++; cx += i % w; cy += (i / w) | 0; }
  return enclosed > Math.max(4, area * 0.05) ? [cx / enclosed, cy / enclosed] : null;
}

const cache = new Map();

/** The maneuver in a data URL's picture (decoded on a canvas), cached by `key`; null when it can't be read. */
export async function iconManeuverFromUrl(url, key = url) {
  if (cache.has(key)) return cache.get(key);
  let out = null;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const S = 64, c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, S, S);
    out = iconManeuver(g.getImageData(0, 0, S, S).data, S, S);
  } catch (e) { out = null; }
  if (cache.size > 50) cache.clear();
  cache.set(key, out);
  return out;
}
