// Point cloud: the surface as a spinning lidar on our roof sees it, over a faint sheet. Its rings on the ground spread
// apart with distance, anything raised catches many of them and casts a shadow behind, and there's a dark ring round
// the car it can't see. Our own car is a fine lattice of points over its height map.
import * as THREE from '../../../vendor/three.module.min.js';
import { BASE_LIGHT, EGO_B, STYLE_GLSL } from '../glsl.js';
import { SHEET_FS } from '../sheet.js';
import { DRUM_FADE_GLSL } from '../../drum.js';

// `channels` rays one above another, from `lo` to `hi` radians of elevation and crowding toward the horizon (as a real
// one's do), each swept round in `steps` steps, from `height` m up at scene Z `z`; the returns fade out over `fade` m
const LIDAR = { channels: 80, steps: 1440, height: 1.95, z: 2.2, lo: -0.33, hi: 0.012, crowd: 0.55, fade: [30, 90] };
const EGO_S = 0.04, EGO_LAYERS = 4;   // our car: the lattice's pitch (m), and the layers its steep sides are filled down in
const GHOST = 0.12;                   // how much of the faint sheet shows

// Each ray cast from the roof against the height field (our car aside) to its first return.
const LIDAR_VS = `
${STYLE_GLSL}
${DRUM_FADE_GLSL}
attribute vec2 aRay;            // channel (lowest first), step round
uniform vec4 uLidar;            // channels, steps, sensor height, sensor Z
uniform vec3 uElev;             // lowest and highest elevation (rad), and how the channels crowd toward the highest
uniform float uPxPerM;
uniform vec2 uFade;
uniform vec3 uPoint;
varying vec3 vColor;
varying float vAlpha;
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; }
void main() {
  float el = mix(uElev.x, uElev.y, pow(aRay.x / (uLidar.x - 1.0), uElev.z));
  float az = (aRay.y + 0.5 * mod(aRay.x, 2.0)) / uLidar.y * 6.2831853;   // alternate channels half a step apart
  vec2 o = vec2(0.0, uLidar.w), dir = vec2(sin(az), cos(az));
  float H = uLidar.z, k = tan(el);   // the ray's height is H + k u, u along the ground
  // the ground first: the road's rise and its lines are low and gentle, so a few fixed-point steps find it
  float u = 1e4;
  if (k < -1e-4) {
    u = H / -k;
    for (int j = 0; j < 3; j++) { vec4 t = hTex(o + dir * u); u = (H - (t.r - t.b)) / -k; }
  }
  // then each car whose footprint (and drape) the ray crosses before that: march through it to the first return
  for (int i = 0; i < MAX_VEH; i++) {
    if (i >= uNVeh) break;
    vec4 b = uVehB[i];
    vec2 lo = vehLocal(i, o), ld = vec2(dir.x * b.x - dir.y * b.y, dir.x * b.y + dir.y * b.x);
    ld += vec2(abs(ld.x) < 1e-5 ? 1e-5 : 0.0, abs(ld.y) < 1e-5 ? 1e-5 : 0.0);
    vec2 ext = uVeh[i].zw + 0.9, t0 = (-ext - lo) / ld, t1 = (ext - lo) / ld;
    float ua = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), 0.0), ub = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), u);
    float top = b.z + 0.7;   // over the whole crossing the ray is above the car (and any ridge under it): nothing to hit
    if (ua >= ub || H + k * ua > top && H + k * ub > top) continue;
    float st = (ub - ua) / 24.0, a = ua, c = -1.0;
    for (int j = 1; j <= 24; j++) {
      float uu = ua + st * float(j);
      if (H + k * uu <= hTex(o + dir * uu).r) { c = uu; break; }
      a = uu;
    }
    if (c < 0.0) continue;
    for (int j = 0; j < 6; j++) { float m = 0.5 * (a + c); if (H + k * m <= hTex(o + dir * m).r) c = m; else a = m; }
    u = a;   // the last sample still in front of the surface
  }
  if (u > uFade.y * 2.0) { cull(); return; }
  vec2 p = o + dir * u;
  float h = H + k * u;
  vec4 sp = vec4(p.x, h, p.y, 1.0);
  // drawn toward the camera (which moves it in depth only), clear of the faint sheet under the cloud: that is coarser
  // than the returns far out, by up to a metre or so
  vec3 toCam = cameraPosition - sp.xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(sp.xyz + normalize(toCam) * min(1.5, 0.05 + 0.02 * length(toCam)), 1.0);
  gl_PointSize = clamp(0.035 * uPxPerM / gl_Position.w, 1.5, 2.6);
  vec4 ht = hTex(p), d = paintAt(p);
  float line = paintOf(d), car = smoothstep(0.02, 0.3, ht.b);
  vec3 n = heightNormal(p);
  vec4 vp = car > 0.0 ? vehPaint(p) : vec4(0.0);
  vec3 alb = mix(uPoint, lineColor(d), line * 0.9);
  alb = mix(alb, vp.rgb + 0.25, vp.a * 0.35);
  // a return is as bright as its surface faces the sensor (not lit by the scene's key light), brighter off the cars
  // and the paint, and dimmer with range
  float facing = abs(dot(n, normalize(vec3(dir.x, k, dir.y))));
  vColor = alb * (0.55 + 0.65 * facing) * mix(1.3, 0.75, smoothstep(6.0, 60.0, u)) * (1.0 + 0.3 * car) + uTail * tailAt(p) * 1.2;
  vColor = addGlow(vColor, d.rgb * 0.6 + (lineHalo(p) * 0.5 + lineBloom(p) * 0.3) * (1.0 - car));   // the returns near a line in its light
  float far = 1.0 + car + line * 0.5;   // the cars and lines carry further
  vAlpha = (1.0 - smoothstep(uFade.x * far, uFade.y * far, u)) * (1.0 - drumFade(sp.xyz));   // and out toward the drum's horizon
}`;

// Our car: a fine jittered lattice over its height map, with its steep sides filled in downward in layers.
const EGO_VS = `
${STYLE_GLSL}
attribute float aLayer;
uniform float uPxPerM, uEgoS, uLayers;
uniform vec3 uPoint;
varying vec3 vColor;
varying float vAlpha;
float hash(vec2 c) { return fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453); }
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; }
void main() {
  vec2 p = position.xz + (vec2(hash(position.xz * 13.1), hash(position.xz * 7.7 + 3.0)) - 0.5) * uEgoS * 0.8;
  float e = egoH(p);
  if (e < 0.03) { cull(); return; }
  float s = uEgoS;
  float lo = min(min(egoH(p + vec2(s, 0.0)), egoH(p - vec2(s, 0.0))), min(egoH(p + vec2(0.0, s)), egoH(p - vec2(0.0, s))));
  float drop = (e - lo) * aLayer / uLayers;
  if (aLayer > 0.0 && drop < 0.03) { cull(); return; }
  float h = heightAt(p) - drop;   // standing level on the road, as the sheet draws it
  vec4 sp = vec4(p.x, h, p.y, 1.0);
  gl_Position = projectionMatrix * viewMatrix * sp;
  gl_PointSize = clamp(0.03 * uPxPerM / gl_Position.w, 1.5, 2.4);
  vec3 n = heightNormal(p);
  vec3 V = normalize(cameraPosition - sp.xyz);
  // shaded like the lidar's returns (as it faces the camera), with a touch of the key light for its form
  vColor = uPoint * (1.0 - egoTex(p).b * 0.45) * (0.45 + 0.5 * abs(dot(n, V)) + 0.35 * max(dot(n, uKey), 0.0)) + uTail * egoBar(p) * 1.4;
  vAlpha = 1.0;
}`;
const POINT_FS = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5 || vAlpha <= 0.0) discard;
  gl_FragColor = vec4(vColor, smoothstep(0.5, 0.3, r) * vAlpha);
  #include <colorspace_fragment>
}`;

// The faint sheet under the cloud, a shade more over the cars.
const GHOST_FS = `
${SHEET_FS}
uniform vec3 uSurf;
uniform float uGhost;
void main() {
  vec2 p = vPos.xz;
  float h = vPos.y + uDrop + 0.01;
  bool up = h > 0.004;
  vec3 n = up ? heightNormalWide(p) : vec3(0.0, 1.0, 0.0);
  vec4 d = paintAt(p);
  vec3 alb = mix(uSurf, lineColor(d), paintOf(d) * 0.8);
  vec3 c = mix(uBg, lit(alb, n, p, h, normalize(cameraPosition - vPos), uSheen * 0.5, true), uGhost + smoothstep(0.02, 0.15, hTex(p).b) * 0.08);
  c = addGlow(c, (lineHalo(p) * 0.3 + lineBloom(p) * 0.4) * (1.0 - carCover(p)));   // the lines' light on the sheet under the cloud
  gl_FragColor = vec4(sheetFinish(c, p, up, 70.0), 1.0);
  #include <colorspace_fragment>
}`;

// One point per lidar ray (LIDAR_VS places it), and the lattice our car's points are laid on (EGO_VS).
function lidarGeometry() {
  const n = LIDAR.channels * LIDAR.steps, ray = new Float32Array(n * 2);
  for (let c = 0, i = 0; c < LIDAR.channels; c++) for (let a = 0; a < LIDAR.steps; a++, i += 2) { ray[i] = c; ray[i + 1] = a; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aRay', new THREE.BufferAttribute(ray, 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}
function egoGeometry() {
  const s = EGO_S, nx = Math.round((EGO_B.x1 - EGO_B.x0) / s), nz = Math.round((EGO_B.z1 - EGO_B.z0) / s);
  const pos = new Float32Array(EGO_LAYERS * (nx + 1) * (nz + 1) * 3), layer = new Float32Array(pos.length / 3);
  let i = 0;
  for (let l = 0; l < EGO_LAYERS; l++) for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++, i++) {
    pos[i * 3] = EGO_B.x0 + x * s; pos[i * 3 + 2] = EGO_B.z0 + z * s; layer[i] = l;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aLayer', new THREE.BufferAttribute(layer, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}

export default {
  id: 'points',
  label: 'Point cloud',
  blurb: 'Point cloud: that surface as a lidar on your roof sees it, in rings that spread out with distance and close up on the cars.',
  surface: { drape: 0.3, egoExact: true },
  light: BASE_LIGHT,
  palette: {
    light: { point: 0x3a3e46, surf: 0xd2d4d8 },
    dark: { point: 0xb8bcc4, surf: 0x4a4d54 },
  },
  create(kit) {
    const ghost = kit.add(kit.sheet(GHOST_FS, { uSurf: { value: new THREE.Color() }, uGhost: { value: GHOST } }));
    // the lidar and our car's points share the point size and color; both are fixed to the car
    const shared = Object.assign({ uPxPerM: { value: 1000 }, uPoint: { value: new THREE.Color() } }, kit.uniforms);
    const L = LIDAR;
    const lidar = new THREE.ShaderMaterial({
      vertexShader: LIDAR_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false,
      uniforms: Object.assign({
        uLidar: { value: new THREE.Vector4(L.channels, L.steps, L.height, L.z) }, uElev: { value: new THREE.Vector3(L.lo, L.hi, L.crowd) },
        uFade: { value: new THREE.Vector2(...L.fade) },
      }, shared),
    });
    const ego = new THREE.ShaderMaterial({
      vertexShader: EGO_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false,
      uniforms: Object.assign({ uEgoS: { value: EGO_S }, uLayers: { value: EGO_LAYERS } }, shared),
    });
    for (const pts of [new THREE.Points(lidarGeometry(), lidar), new THREE.Points(egoGeometry(), ego)]) {
      pts.frustumCulled = false;
      pts.renderOrder = 2;
      kit.add(pts);
    }
    return {
      setTheme(P) {
        shared.uPoint.value.set(P.point);
        ghost.material.uniforms.uSurf.value.set(P.surf);
      },
      update(f) { shared.uPxPerM.value = f.pxPerM; },
    };
  },
};
