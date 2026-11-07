// Our car from above, for the surface model: its exact height map (lightly smoothed), a tight drape of it for a
// continuous sheet, and where its glass is. RGBA half floats over EGO_B.
import * as THREE from '../../vendor/three.module.min.js';
import { EGO_B, EGO_RES } from './glsl.js';

function boxBlur(src, w, h, r, passes) {
  let a = src;
  for (let k = 0; k < passes; k++) {
    const t = new Float32Array(a.length), o = new Float32Array(a.length), n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { t[row + x] = acc / n; acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += t[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { o[y * w + x] = acc / n; acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; }
    }
    a = o;
  }
  return a;
}
function rankFilter(src, w, h, r, fn) {
  const t = new Float32Array(src.length), o = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = src[y * w + x];
    for (let k = -r; k <= r; k++) v = fn(v, src[y * w + Math.min(w - 1, Math.max(0, x + k))]);
    t[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = t[y * w + x];
    for (let k = -r; k <= r; k++) v = fn(v, t[Math.min(h - 1, Math.max(0, y + k)) * w + x]);
    o[y * w + x] = v;
  }
  return o;
}
function cone(src, w, h, slope) {
  const c = Float32Array.from(src), s1 = slope, s2 = slope * Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x; let v = c[k];
    if (x > 0) v = Math.max(v, c[k - 1] - s1);
    if (y > 0) { v = Math.max(v, c[k - w] - s1); if (x > 0) v = Math.max(v, c[k - w - 1] - s2); if (x < w - 1) v = Math.max(v, c[k - w + 1] - s2); }
    c[k] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const k = y * w + x; let v = c[k];
    if (x < w - 1) v = Math.max(v, c[k + 1] - s1);
    if (y < h - 1) { v = Math.max(v, c[k + w] - s1); if (x < w - 1) v = Math.max(v, c[k + w + 1] - s2); if (x > 0) v = Math.max(v, c[k + w - 1] - s2); }
    c[k] = v;
  }
  return c;
}
const smax = (a, b, k) => { const hh = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + hh * hh * k / 4; };

function egoMaps(raw, lum, w, h) {
  const sharp = boxBlur(raw, w, h, 2, 2);
  const opened = rankFilter(rankFilter(raw, w, h, 7, Math.min), w, h, 7, Math.max);   // drops the mirrors and other thin parts
  // the cloth pulled over the car at its true size: its edges rounded off (a light blur), and at its foot a concave
  // fillet FOOT m out where the cloth curls into the road: from the outline's distance (a cone falling one metre per
  // metre from it), u = 1 at the outline to 0 at FOOT out, a quarter round between
  const FOOT = 0.3;
  const body = boxBlur(opened, w, h, 8, 3);
  const reach = cone(opened.map(v => (v > 0.05 ? FOOT : 0)), w, h, EGO_RES);
  const base0 = smax(0, 0, 0.08);   // what the smooth maximum adds over flat ground
  const data = new Uint16Array(w * h * 4), toHalf = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < w * h; i++) {
    const u = Math.min(1, reach[i] / FOOT), foot = FOOT * (1 - Math.sqrt(1 - u * u));
    const drape = Math.max(0, smax(body[i], foot, 0.08) - base0);
    const glass = raw[i] > 0.75 ? Math.min(1, Math.max(0, (0.15 - lum[i]) / 0.1)) : 0;
    data[i * 4] = toHalf(drape); data[i * 4 + 1] = toHalf(sharp[i]); data[i * 4 + 2] = toHalf(glass); data[i * 4 + 3] = toHalf(1);
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// The car's model rendered from above once it has loaded: heights (two bytes, red coarse, green fine) and a lit
// render for where the glass is, read back now and turned into the maps off this frame. Resolves to the texture.
export function buildEgoMap(renderer, ego) {
  const R = renderer, B = EGO_B;
  const w = Math.round((B.x1 - B.x0) / EGO_RES), h = Math.round((B.z1 - B.z0) / EGO_RES);
  const cam = new THREE.OrthographicCamera(B.x0, B.x1, (B.z1 - B.z0) / 2, -(B.z1 - B.z0) / 2, 0.1, 30);
  cam.position.set(0, 12, (B.z0 + B.z1) / 2);
  cam.up.set(0, 0, -1);
  cam.lookAt(0, 0, (B.z0 + B.z1) / 2);
  cam.updateMatrixWorld();
  const heightMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: 'varying float vY; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'varying float vY; void main() { float h = clamp(vY / 2.0, 0.0, 1.0); gl_FragColor = vec4(h, fract(h * 255.0), 0.0, 1.0); }',
  });
  const rt = new THREE.WebGLRenderTarget(w, h);
  const tmp = new THREE.Scene();
  tmp.background = new THREE.Color(0x000000);
  const lights = [new THREE.HemisphereLight(0xffffff, 0x888888, 2.0), new THREE.AmbientLight(0xffffff, 0.6)];
  const parent = ego.parent, visible = ego.visible;
  const hb = new Uint8Array(w * h * 4), cb = new Uint8Array(w * h * 4);
  const prev = R.getRenderTarget();
  try {
    ego.visible = true;
    tmp.add(ego);
    R.setRenderTarget(rt);
    tmp.overrideMaterial = heightMat;
    R.render(tmp, cam);
    R.readRenderTargetPixels(rt, 0, 0, w, h, hb);
    tmp.overrideMaterial = null;
    tmp.add(...lights);
    R.render(tmp, cam);
    R.readRenderTargetPixels(rt, 0, 0, w, h, cb);
  } finally {
    R.setRenderTarget(prev);
    if (parent) parent.add(ego);
    ego.visible = visible;
    rt.dispose();
    heightMat.dispose();
  }
  return new Promise((resolve) => setTimeout(() => {
    const raw = new Float32Array(w * h), lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const n = hb[i * 4], fr = hb[i * 4 + 1] / 255;
      const v = (n + fr - (fr >= 0.5 ? 1 : 0)) / 255 * 2;
      raw[i] = v < 0.02 ? 0 : v;
      lum[i] = (0.3 * cb[i * 4] + 0.59 * cb[i * 4 + 1] + 0.11 * cb[i * 4 + 2]) / 255;
    }
    resolve(egoMaps(raw, lum, w, h));
  }, 0));
}
