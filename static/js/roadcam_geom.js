// The camera view's arithmetic (roadcam.js, commaui.js): the comma's /video frames, the H.264 codec string, the
// plain views' fit and projection (sunnypilot selfdrive/ui/onroad/model_renderer.py), and the comma 4 screen's own
// framing, projection, colours and shapes for the mirror (sunnypilot selfdrive/ui/mici/onroad).
// No DOM here, so Node tests it.

export const FRAME_HEADER_BYTES = 16;   // <BBHIQ: kind, flags, camera, frameId, timestampEof (ns)
export const CAMERAS = ['road', 'wide'];
// the plain camera views (road, wide): the whole 16:9 picture with the model's lines over it
export const MIN_DRAW_DISTANCE = 10, MAX_DRAW_DISTANCE = 100;
export const PATH_HALF_WIDTH = 0.9;     // m
export const LINE_HALF_WIDTH = 0.025;   // m, times the lane line's probability
export const ZOOM = { road: 1, wide: 1 };   // the window is 16:9 like the stream: the whole picture shows

/** A binary /video message: {key, camera, frameId, tsNs, data}, or null if it isn't a frame. */
export function parseFrame(buf) {
  if (!buf || buf.byteLength < FRAME_HEADER_BYTES) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== 1) return null;
  return {
    key: (v.getUint8(1) & 1) === 1,
    camera: CAMERAS[v.getUint16(2, true)] || 'road',
    frameId: v.getUint32(4, true),
    tsNs: Number(v.getBigUint64(8, true)),
    data: new Uint8Array(buf, FRAME_HEADER_BYTES),
  };
}

/** The NAL units of an Annex B access unit, as [type, offset of the unit's first byte after its start code]. */
export function nalUnits(data) {
  const out = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const start = i + (data[i + 2] === 1 ? 3 : 4);
      if (start < data.length) out.push([data[start] & 0x1f, start]);
      i = start;
    }
  }
  return out;
}

/** 'avc1.PPCCLL' from the access unit's SPS (profile, constraints, level), or null without one. */
export function avcCodec(data) {
  const sps = nalUnits(data).find(([type]) => type === 7);
  if (!sps || sps[1] + 3 >= data.length) return null;
  const hex = (b) => b.toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${hex(data[sps[1] + 1])}${hex(data[sps[1] + 2])}${hex(data[sps[1] + 3])}`;
}

/** Applies a 3x3 matrix to [x, y, z]; [u, v] in the stream's pixels, or null behind the camera. */
export function projectRaw(M, x, y, z) {
  const w = M[2][0] * x + M[2][1] * y + M[2][2] * z;
  if (w < 1e-6) return null;
  return [(M[0][0] * x + M[0][1] * y + M[0][2] * z) / w, (M[1][0] * x + M[1][1] * y + M[1][2] * z) / w];
}

/**
 * Where the stream goes on a view of vw x vh: covering it, `zoom` times more, and centred on the vanishing
 * point (straight ahead) as far as the frame still covers the view. Screen = scale * stream + [tx, ty].
 */
export function fitStream(width, height, vw, vh, M = null, zoom = 1) {
  const scale = Math.max(vw / width, vh / height) * zoom;
  const vp = (M && projectRaw(M, 1000, 0, 0)) || [width / 2, height / 2];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return {
    scale,
    tx: clamp(vw / 2 - scale * vp[0], vw - scale * width, 0),
    ty: clamp(vh / 2 - scale * vp[1], vh - scale * height, 0),
  };
}

/** A projector from the car frame (x forward, y right, z down) to the screen, for a stream fitted by `fit`. */
export function projector(M, fit) {
  return (x, y, z) => {
    const p = projectRaw(M, x, y, z);
    return p && [fit.scale * p[0] + fit.tx, fit.scale * p[1] + fit.ty];
  };
}

/** The index of the last point at or before x = d (0 if none). */
export function indexAt(points, d) {
  let idx = 0;
  for (let i = 0; i < points.length; i++) if (points[i][0] <= d) idx = i;
  return idx;
}

/**
 * A line of [x, y, z] points as a ribbon `halfWidth` wide either side, `zOff` lower, out to maxDistance:
 * the left edge forward and the right edge back, on screen (model_renderer.py _map_line_to_polygon).
 */
export function lineRibbon(points, halfWidth, zOff, maxDistance, project) {
  if (!points || !points.length) return [];
  const maxIdx = indexAt(points, maxDistance);
  let pts = points.slice(0, maxIdx + 1);
  if (maxIdx > 0 && maxIdx < points.length - 1) {   // end exactly at maxDistance so the path's end doesn't jump
    const [x0, y0, z0] = points[maxIdx], [x1, y1, z1] = points[maxIdx + 1];
    const f = x1 > x0 ? (maxDistance - x0) / (x1 - x0) : 0;
    pts.push([maxDistance, y0 + (y1 - y0) * f, z0 + (z1 - z0) * f]);
  }
  pts = pts.filter(p => p[0] >= 0);
  const left = [], right = [];
  for (const [x, y, z] of pts) {
    const l = project(x, y - halfWidth, z + zOff), r = project(x, y + halfWidth, z + zOff);
    if (l && r) { left.push(l); right.push(r); }
  }
  if (left.length < 2) return [];
  return left.concat(right.reverse());
}

/** How far the path is drawn: the model's reach, short of the lead (model_renderer.py _update_model). */
export function pathDistance(path, lead) {
  if (!path || !path.length) return 0;
  let d = Math.min(MAX_DRAW_DISTANCE, Math.max(MIN_DRAW_DISTANCE, path[path.length - 1][0]));
  if (lead) {
    const leadD = lead.d * 2;
    d = Math.min(d, Math.max(0, leadD - Math.min(leadD * 0.35, 10)));
  }
  return d;
}

/** The lead's chevron and glow (model_renderer.py _update_lead_vehicle), at its screen point [x, y]. */
export function leadChevron(lead, point, vw, vh) {
  const speedBuff = 10, leadBuff = 40;
  let alpha = 0;
  if (lead.d < leadBuff) {
    alpha = 255 * (1 - lead.d / leadBuff);
    if (lead.v < 0) alpha += 255 * (-lead.v / speedBuff);
    alpha = Math.min(alpha, 255);
  }
  const sz = Math.min(30, Math.max(15, (25 * 30) / (lead.d / 3 + 30))) * 2.35 * Math.min(1, vh / 1080);
  const x = Math.min(Math.max(point[0], 0), vw - sz / 2);
  const y = Math.min(point[1], vh - sz * 0.6);
  const gx = sz / 5, gy = sz / 10;
  return {
    glow: [[x + sz * 1.35 + gx, y + sz + gy], [x, y - gy], [x - sz * 1.35 - gx, y + sz + gy]],
    chevron: [[x + sz * 1.25, y + sz], [x, y], [x - sz * 1.25, y + sz]],
    alpha: alpha / 255,
  };
}

/** The colour along the path in experimental mode, from the planned acceleration (model_renderer.py). */
export function accelColor(a, along) {
  const hue = Math.min(120, Math.max(0, 60 + a * 35));
  const sat = Math.min(Math.abs(a * 1.5), 1);
  const light = 0.95 + (0.62 - 0.95) * sat;
  const alpha = along <= 0.375 ? 0.4 : along >= 0.75 ? 0 : 0.4 * (0.75 - along) / 0.375;
  return `hsla(${hue.toFixed(0)}, ${(sat * 100).toFixed(0)}%, ${(light * 100).toFixed(0)}%, ${alpha.toFixed(3)})`;
}

/** The model output for a frame: the one computed from it, else the latest before it. */
export function modelFor(models, frameId, camera) {
  let best = null;
  for (const m of models) {
    const id = camera === 'wide' ? (m.frameIdExtra || m.frameId) : m.frameId;
    if (id === frameId) return m;
    if (id < frameId && (!best || id > (camera === 'wide' ? (best.frameIdExtra || best.frameId) : best.frameId))) best = m;
  }
  return best;
}

// ---- the comma 4's onroad screen (sunnypilot selfdrive/ui/mici/onroad), for commaui.js ---------------------

export const MICI = { width: 536, height: 240, side: 60, content: 476, camYOffset: 20 };

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** numpy's interp: piecewise linear through (xs, ys), flat beyond the ends. */
export function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  }
  return ys[ys.length - 1];
}

/** openpilot's FirstOrderFilter, for a frame `dt` seconds long (the screen runs these at 60 Hz). */
export class Filter {
  constructor(x = 0, rc = 0.1, initialized = true) { this.x = x; this.rc = rc; this.initialized = initialized; }
  update(target, dt = 1 / 60) {
    if (!this.initialized) { this.initialized = true; this.x = target; return this.x; }
    const a = dt / (this.rc + dt);
    this.x = (1 - a) * this.x + a * target;
    return this.x;
  }
}

/** openpilot's BounceFilter: a first-order filter that overshoots a little (the alerts' slide). */
export class BounceFilter extends Filter {
  constructor(x = 0, rc = 0.1, bounce = 2) { super(x, rc); this.velocity = new Filter(0, 0.15); this.bounce = bounce; }
  update(target, dt = 1 / 60) {
    super.update(target, dt);
    this.velocity.x += (target - this.x) * this.bounce * (dt * 60) * dt;
    this.velocity.update(0, dt);
    if (Math.abs(this.velocity.x) < 1e-3) this.velocity.x = 0;
    this.x += this.velocity.x;
    return this.x;
  }
}

const mul3 = (M, p) => [0, 1, 2].map(r => M[r][0] * p[0] + M[r][1] * p[1] + M[r][2] * p[2]);
const VIEW_FROM_DEVICE = [[0, 1, 0], [0, 0, 1], [1, 0, 0]];

/** K . view_from_device: the projection before calibration converges (the screen's default). */
export function uncalibratedM(K) {
  return K.map(row => [0, 1, 2].map(c => row[0] * VIEW_FROM_DEVICE[0][c] + row[1] * VIEW_FROM_DEVICE[1][c] + row[2] * VIEW_FROM_DEVICE[2][c]));
}

/**
 * How the comma 4 frames its camera in its w x h content area (mici augmented_road_view.py _calc_frame_matrix):
 * the sensor's frame (Kfull, Mfull: car frame to sensor pixels) zoomed with the speed on the road camera, the
 * vanishing point centred and lifted CAM_Y_OFFSET as far as the picture still covers the area.
 * Screen = zoom * sensor pixel + [tx, ty].
 */
export function miciFrame(Kfull, Mfull, w, h, wide, vEgo) {
  const cx = Kfull[0][2], cy = Kfull[1][2];
  let zoom = wide ? 0.7 * 1.5 : interp(vEgo, [10, 30], [0.8, 1.0]);
  zoom = Math.max(zoom, w / (2 * cx), h / (2 * cy));
  const margin = 5;
  const maxX = Math.max(0, cx * zoom - w / 2 - margin), maxY = Math.max(0, cy * zoom - h / 2 - margin);
  const kep = mul3(Mfull, [1000, 0, 0]);
  let xo = 0, yo = 0;
  if (Math.abs(kep[2]) > 1e-6) {
    xo = clamp((kep[0] / kep[2] - cx) * zoom, -maxX, maxX);
    yo = clamp((kep[1] / kep[2] - cy) * zoom + MICI.camYOffset, -maxY, maxY);
  }
  return { zoom, tx: w / 2 - xo - cx * zoom, ty: h / 2 - yo - cy * zoom };
}

/** The last index whose x is at or before d, else 0 (model_renderer.py _get_path_length_idx). */
export function lengthIdx(points, d) {
  let idx = 0;
  for (let i = 0; i < points.length; i++) if (points[i][0] <= d) idx = i;
  return idx;
}

const CLIP_MARGIN = 500;

/**
 * A line as the comma 4 draws it (mici model_renderer.py _map_line_to_polygon): its points up to maxIdx,
 * widened yOff either side and zOff lower, projected with M and the frame; points off the screen by more than
 * CLIP_MARGIN are dropped, and for the path (allowInvert false) so are points that climb back down on a hill.
 * The left edge forward then the right edge back.
 */
export function miciPolygon(line, yOff, zOff, maxIdx, M, frame, w, h, allowInvert = true) {
  if (!line || !line.length) return [];
  const pts = line.slice(0, maxIdx + 1).filter(p => p[0] >= 0);
  const left = [], right = [];
  const scr = (p) => {
    const q = mul3(M, p);
    if (Math.abs(q[2]) < 1e-6) return null;
    return [frame.zoom * q[0] / q[2] + frame.tx, frame.zoom * q[1] / q[2] + frame.ty];
  };
  const inClip = (s) => s[0] >= -CLIP_MARGIN && s[0] <= w + CLIP_MARGIN && s[1] >= -CLIP_MARGIN && s[1] <= h + CLIP_MARGIN;
  for (const [x, y, z] of pts) {
    const l = scr([x, y - yOff, z + zOff]), r = scr([x, y + yOff, z + zOff]);
    if (!l || !r || !inClip(l) || !inClip(r)) continue;
    left.push(l); right.push(r);
  }
  if (!left.length) return [];
  let L = left, R = right;
  if (!allowInvert && L.length > 1) {
    let min = Infinity;
    const keep = L.map(p => { min = Math.min(min, p[1]); return p[1] === min; });
    L = L.filter((_, i) => keep[i]);
    R = R.filter((_, i) => keep[i]);
  }
  return L.concat(R.slice().reverse());
}

/** raylib's ColorToHSV / ColorFromHSV: [h degrees, s, v]; ColorFromHSV gives back an opaque colour. */
export function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  const s = max > 0 ? d / max : 0;
  if (max > 0 && d > 0) {
    if (r >= max) h = (g - b) / d;
    else if (g >= max) h = 2 + (b - r) / d;
    else h = 4 + (r - g) / d;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, max];
}

export function hsvToRgb(h, s, v) {
  const k = (n) => { const kk = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1)))); };
  return [k(5), k(3), k(1), 255];
}

/** The screen's blend_colors: between a and b in HSV by f, the short way round the hue. Opaque, as raylib's is. */
export function blendColors(a, b, f) {
  const [h0, s0, v0] = rgbToHsv(a), [h1, s1, v1] = rgbToHsv(b);
  const dh = ((h1 - h0 + 180) % 360 + 360) % 360 - 180;
  return hsvToRgb(((h0 + f * dh) % 360 + 360) % 360, s0 + f * (s1 - s0), v0 + f * (v1 - v0));
}

/**
 * The torque bar's outline (mici torque_bar.py arc_bar_pts): a thick arc of radius rMid from a0 to a1 degrees
 * with rounded corners, around the origin, in screen coordinates (y down, -90 degrees is up).
 */
export function arcBarPts(rMid, thickness, a0, a1, { maxPoints = 100, capSegs = 10, capRadius = 7, pxPerSeg = 2 } = {}) {
  if (a1 < a0) [a0, a1] = [a1, a0];
  const half = thickness / 2;
  capRadius = Math.min(capRadius, half);
  const span = Math.max(1e-3, a1 - a0);
  const rad = (d) => d * Math.PI / 180;
  const lin = (from, to, n) => Array.from({ length: n }, (_, i) => (n === 1 ? from : from + (to - from) * i / (n - 1)));
  let arcSegs = Math.max(6, Math.floor(rMid * rad(span) / pxPerSeg));
  arcSegs = Math.max(6, Math.min(arcSegs, Math.floor((maxPoints - (4 * capSegs + 3)) / 2)));

  const cap = (left, a) => {
    const nx = Math.cos(rad(a)), ny = Math.sin(rad(a)), tx = -ny, ty = nx;
    const mx = nx * rMid, my = ny * rMid;
    const ex = mx + nx * (half - capRadius), ey = my + ny * (half - capRadius);
    const top = (left ? lin(180, 90, capSegs + 2) : lin(90, 0, capSegs + 2)).slice(1, -1).map(rad)
      .map(al => [ex + Math.cos(al) * capRadius * tx + Math.sin(al) * capRadius * nx, ey + Math.cos(al) * capRadius * ty + Math.sin(al) * capRadius * ny]);
    const ex2 = mx + nx * (-half + capRadius), ey2 = my + ny * (-half + capRadius);
    const bot = (left ? lin(-90, -180, capSegs + 1) : lin(0, -90, capSegs + 1)).slice(0, -1).map(rad)
      .map(al => [ex2 + Math.cos(al) * capRadius * tx + Math.sin(al) * capRadius * nx, ey2 + Math.cos(al) * capRadius * ty + Math.sin(al) * capRadius * ny]);
    return left ? bot.concat(top) : top.concat(bot);
  };
  const outer = lin(a0, a1, arcSegs + 1).map(a => [Math.cos(rad(a)) * (rMid + half), Math.sin(rad(a)) * (rMid + half)]);
  const inner = lin(a1, a0, arcSegs + 1).map(a => [Math.cos(rad(a)) * (rMid - half), Math.sin(rad(a)) * (rMid - half)]);
  return outer.concat(cap(false, a1), inner, cap(true, a0));
}

/** The status the screen colours itself by, from the comma's hud message. */
export const STATUS = { DISENGAGED: 'disengaged', ENGAGED: 'engaged', OVERRIDE: 'override', LAT_ONLY: 'lat_only', LONG_ONLY: 'long_only' };
