// The surface model: one sheet over the whole scene, fixed to the ground, that the road and every car (ours included)
// push up from below like a blanket. It is the same whichever style draws it.
//
// The road's shape is OceanScape's (github.com/benkayuk/oceanscape, fabric.js): a soft ridge along each lane line,
// dashed or not (our lane's two full height, the others lower), and a broad berm along each edge, at their offsets
// across the road field's reference (ground.js: the cameras' arc or the map's centerline), so they bend with the road
// and grow and fade with it (_ridges). The road itself isn't raised.
//
// Each frame the road is also rendered from above into the road map (its own meshes, moved to render layer 1 while a
// style is on, in the style's line colors: CONCEPT_LINES) with the blind-spot warning (blindspot.js), for the lines'
// paint; its lines alone, in white, into a coverage map (a style with crisp lines raises the paint itself a little);
// and the paint's colors are blurred by true Gaussians for the light the lines spread (a style's halo, and its bloom
// a metre wide). The tracked
// cars (scene.js objects and worldObjs) are gathered nearest first, with the one we follow. From all that the height
// field is baked: the road's ridges, the cars as soft boxes standing level over them (a ridge passes under a car
// rather than bending it), and their tail lights. Our own car comes from its model, rendered once from above when it
// loads (egomap.js).
//
// A style's profile says what it needs of that and how its sheet takes the shape (DEFAULT_PROFILE).
import * as THREE from '../../vendor/three.module.min.js';
import { FIELD_GLSL } from '../ground.js';
import { MAX_VEH, DEF, LINE_H, BASE_LIGHT, SURFACE_GLSL, STYLE_GLSL } from './glsl.js';
import { buildEgoMap } from './egomap.js';

export const DEFAULT_PROFILE = {
  drape: 0.8,        // how softly a car meets the sheet: its top edge rounds over half this, its foot flares out 0.4 of it
  egoExact: false,   // our car exactly (pins, points) or tightly draped (a continuous sheet)
  ridge: 0.3,        // m: a lane line's ridge at full height (our lane's; a berm along an edge is 1.6 times that)
  crisp: false,      // the painted lines raised a little themselves, crisp (pins)
  halo: true,        // the lines' light spread around them (glsl.js lineHalo, lineBloom)
};
const BLOOM_TAPS = 3;   // the bloom's sigma in its taps, two texels apart: about a metre

// The road's ridges (after OceanScape): [weight, half-width (m)] of our lane's lines, the others, and the edges, and
// how far beyond the outermost lines a berm goes when the road reports no edges
const RIDGE = { ego: [1, 0.45], other: [0.7, 0.45], edge: [1.6, 0.9], beyond: 1.4 };
const RIDGE_MAX = 12;

// The lines' colors in the road map while a style is on, after OceanScape's concept style: our lane's two lines amber
// (blue while steering, red for a departure), the rest a dim amber, the road's edge lines too (OceanScape leaves them
// dark; they're painted lines, so here they glow like the others). [color, strength] by the scene's line materials
// (scene.js mats) and the map's road network's (roadnet.js); the strength goes with the material's own opacity.
const AMBER = 0xffa62b, BLUE = 0x3d8bff, RED = 0xff3b30, NONE = [0, 0];
export const CONCEPT_LINES = {
  ribbons: { lineEgo: [AMBER, 1], line: [AMBER, 0.35], lineYellow: [AMBER, 0.7], lineBlue: [BLUE, 1], lineRed: [RED, 1],
    lineSoft: [AMBER, 0.45], lineYellowSoft: [AMBER, 0.6], lineBlueSoft: [BLUE, 1], edge: [AMBER, 0.35], model: [AMBER, 0.3], modelEdge: [AMBER, 0.3],
    marking: [AMBER, 0.4], branch: NONE, branchEdge: [AMBER, 0.5], branchCenter: [AMBER, 0.55], branchLane: [AMBER, 0.5] },
  roadnet: { strip: NONE, edge: [AMBER, 0.6], center: [AMBER, 1], lane: [AMBER, 0.75], centerSingle: [AMBER, 0.5], arrow: [AMBER, 0.45] },
};

// the road's own geometry, drawn into the road map while a style is on instead of the main view
const ROAD_GEOMETRY = ['line', 'lineEgo', 'lineBlue', 'lineYellow', 'lineRed', 'edge', 'model', 'modelEdge', 'lineSoft', 'lineYellowSoft',
  'lineBlueSoft', 'marking', 'zebra', 'branch', 'branchEdge', 'branchCenter', 'branchLane'];

// the light rig's colors, and the cars' paint where the world model gives them none
const PALETTE = {
  light: { sky: 0xffffff, gnd: 0x9a9ea6, key: 0xfff6ea, tail: 0xe5413a, sheen: 0.35, paint: 0xd2d4d8 },
  dark: { sky: 0x6f7682, gnd: 0x16181c, key: 0xd8dde6, tail: 0xff2a1a, sheen: 0.55, paint: 0x4a4d54 },
};

// ---- how the field is made ------------------------------------------------------------------------------------------

const BAKE_GLSL = `
${FIELD_GLSL}
#define RIDGE_MAX ${RIDGE_MAX}
uniform vec2 uRidgeD[RIDGE_MAX];   // each ridge: offset across the road field's reference (m), weight
uniform float uRidgeS[RIDGE_MAX];  // ...its half-width (m)
uniform int uRidgeN;
uniform float uRidgeH;             // m at weight 1
// the road: its ridges, where the road field has road
float roadShape(vec2 p) {
  vec2 sd = roadSD(vec2(-p.y, -p.x));
  float mask = smoothstep(0.0, 1.0, -roadDist(sd));
  if (mask <= 0.0) return 0.0;
  float h = 0.0;
  for (int i = 0; i < RIDGE_MAX; i++) {
    if (i >= uRidgeN) break;
    float d = (sd.y - uRidgeD[i].x) / uRidgeS[i];
    h += uRidgeD[i].y * exp(-d * d);
  }
  return h * uRidgeH * mask;
}
// the painted lines, raised a little and crisp, for a style that shows them so (pins)
uniform sampler2D tCov;
uniform float uCrisp;
float paintH(vec2 p) {
  if (uCrisp < 0.5) return 0.0;
  vec2 uv = defUv(p);
  return outside(uv) ? 0.0 : smoothstep(0.05, 0.25, textureLod(tCov, uv, 0.0).r);
}
float baseAt(vec2 p) { return roadShape(p) + paintH(p) * uLineH; }
// the cars around us (ours comes from its own map) on the surface f, each standing level on the ground over whatever
// it covers
float smaxH(float a, float b, float k) { float hh = max(k - abs(a - b), 0.0) / k; return max(a, b) + hh * hh * k * 0.25; }
float withCars(vec2 p, float f) {
  float h = f;
  for (int i = 0; i < MAX_VEH; i++) {
    if (i >= uNVeh) break;
    float d = vehD(i, p);
    // the cloth pulled over it, at its true size: its top edge rounded over e m, an upright side down its outline, and
    // at its foot a concave fillet r m out where the cloth curls into the road (narrow things, bikes and people, round
    // over less)
    float e = min(0.5 * uDrape, 0.7 * uVeh[i].z), r = 0.4 * uDrape;
    if (d >= r) continue;
    float H = uVehB[i].z * abs(uVehB[i].w);
    float u = clamp(-d / e, 0.0, 1.0);
    float side = d < 0.0 ? sqrt(1.0 - (1.0 - u) * (1.0 - u)) : 0.0;   // a quarter round: upright at the outline, level on top
    float crown = clamp(-d / 1.4, 0.0, 1.0);
    float body = H * (side * 0.82 + sqrt(crown) * 0.18);
    float v = clamp(1.0 - d / r, 0.0, 1.0);
    float foot = min(r, 0.5 * H) * (1.0 - sqrt(1.0 - v * v));   // a concave quarter round, meeting the road level
    h = max(h, onTop(f, smaxH(body, foot, 0.08)));
  }
  return h;
}
// the tail lights across each car's back: a faint band, and a lamp at each corner brighter (after OceanScape)
float tailBake(vec2 p) {
  float t = 0.0;
  for (int i = 0; i < MAX_VEH; i++) {
    if (i >= uNVeh) break;
    vec2 q = vehLocal(i, p); vec4 v = uVeh[i];
    float side = abs(q.x) / v.z;
    float lamps = 0.35 * smoothstep(0.9, 0.6, side) + exp(-pow((side - 0.72) / 0.14, 2.0));
    t += min(1.0, lamps) * smoothstep(0.1 * uDrape + 0.03, 0.02 * uDrape, abs(q.y - (v.w - 0.27 * uDrape))) * max(uVehB[i].w, 0.0);
  }
  return t;
}`;

// The road map's camera restricted to the ground plane (y 0): uv = (U, V) . (x, z, 1) / W . (x, z, 1), uv 0..1. A plane
// mapping (three dot products and a divide) for the styles' shaders instead of the full matrix.
function defPlane(vp) {
  const e = vp.elements;   // column-major: clip = col0 * x + col2 * z + col3
  const row = (r) => [e[r], e[8 + r], e[12 + r]];
  const [X, Y, W] = [row(0), row(1), row(3)];
  const half = (a) => new THREE.Vector3(0.5 * (a[0] + W[0]), 0.5 * (a[1] + W[1]), 0.5 * (a[2] + W[2]));
  return { uDefU: { value: half(X) }, uDefV: { value: half(Y) }, uDefW: { value: new THREE.Vector3(...W) } };
}
// the light map's size: the road map's area at 16 cm a texel
const LIGHT_W = 320, LIGHT_H = 896;
// one texel of the light map: the surface's height there (with our car on it), its shadow and occlusion
const LIGHT_FS = `
${STYLE_GLSL}
varying vec2 vUv;
void main() {
  vec2 p = defGround(vUv);
  float h = heightAt(p);
  gl_FragColor = vec4(shadowMarch(p, h), aoMarch(p, h), fieldSlopeMarch(p));   // ba: the field's slope (heightNormalWide)
}`;
// the cars' paint and the tint of the ones painted for a reason, over the road map's area (glsl.js vehPaintLoop,
// vehTintLoop), baked once a frame so no style loops over every car for every pixel or pin
const CAR_FS = `
${SURFACE_GLSL}
varying vec2 vUv;
void main() {
  vec2 p = defGround(vUv);
#ifdef TINT
  gl_FragColor = vehTintLoop(p);
#else
  gl_FragColor = vehPaintLoop(p);
#endif
}`;
const QUAD_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BAKE_FS = `
${SURFACE_GLSL}
${BAKE_GLSL}
varying vec2 vUv;
void main() {
  vec2 p = defGround(vUv);
  float f = baseAt(p), h = withCars(p, f);
  gl_FragColor = vec4(h, tailBake(p), h - f, 1.0);   // b: how much the cars raise it
}`;

// One pass of a Gaussian over the road map's colors: across (from a level down, at this resolution), then along.
const BLUR_FS = `
uniform sampler2D tSrc;
uniform vec2 uStep;     // one output texel along this pass's direction
uniform float uLod;     // the source's level
uniform float uSigma;   // in texels
varying vec2 vUv;
void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -7; i <= 7; i++) {
    float x = float(i), w = exp(-0.5 * x * x / (uSigma * uSigma));
    acc += textureLod(tSrc, vUv + uStep * x, uLod).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}`;

const fullscreen = (material) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  m.frustumCulled = false;
  const s = new THREE.Scene();
  s.add(m);
  return s;
};

export class GroundSurface {
  constructor(scene) {
    this.sc = scene;
    this.palette = PALETTE.light;
    this.egoReady = false;
    const vec4s = () => Array.from({ length: MAX_VEH }, () => new THREE.Vector4());
    const egoTex = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    egoTex.needsUpdate = true;

    // the road map (anti-aliased, with mipmaps), and the camera that renders it
    const mips = { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, samples: 4 };
    this.defRT = new THREE.WebGLRenderTarget(DEF.w, DEF.h, { depthBuffer: true, ...mips });
    // in perspective (glsl.js DEF): pitched down so its frame runs from DEF.near behind our car to DEF.far ahead, and
    // wide enough for DEF.side either side at the car
    const below = (dz) => Math.atan2(DEF.height, DEF.back - dz);   // how far below the horizon a point on the ground at Z is
    const aNear = below(DEF.near), aFar = below(DEF.far), pitch = (aNear + aFar) / 2, fov = aNear - aFar;
    const depth = DEF.height * Math.sin(pitch) + DEF.back * Math.cos(pitch);   // our car along its axis
    this.defCam = new THREE.PerspectiveCamera(fov * 180 / Math.PI, (DEF.side / depth) / Math.tan(fov / 2), 1, 1000);
    this.defCam.position.set(0, DEF.height, DEF.back);
    this.defCam.rotation.set(-pitch, 0, 0);
    this.defCam.updateMatrixWorld();
    this.defVP = new THREE.Matrix4().multiplyMatrices(this.defCam.projectionMatrix, this.defCam.matrixWorldInverse);
    this.defCam.layers.set(1);
    // the road's lines alone, in white (layer 2)
    this.covRT = new THREE.WebGLRenderTarget(DEF.w, DEF.h, { depthBuffer: false, samples: 4 });
    this.covMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false });
    this.covCam = this.defCam.clone();
    this.covCam.layers.set(2);
    // the lines' colors spread about 30 cm, at half the road map's resolution in half floats, for their halo
    // (in the map's texels: about square at the car, and growing with distance as the view's own pixels do, so the glow
    // spreads alike on screen near and far)
    const BW = DEF.w / 2, BH = DEF.h / 2, texel = 2 * DEF.side / BW, across = 1;
    const half = () => new THREE.WebGLRenderTarget(BW, BH, { type: THREE.HalfFloatType, depthBuffer: false });
    this.glowRT = [half(), half()];
    // ...and spread again, about a metre, for their bloom
    this.bloomRT = [half(), half()];
    this.sigmaHalo = 0.3 / texel;
    this.blurMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() }, uLod: { value: 1 }, uSigma: { value: this.sigmaHalo } } });
    this.blurStep = [new THREE.Vector2(1 / BW, 0), new THREE.Vector2(0, across / BH)];
    this.bloomStep = [new THREE.Vector2(2 / BW, 0), new THREE.Vector2(0, 2 * across / BH)];
    this.blurScene = fullscreen(this.blurMat);
    // the height field, baked over the road map's area
    this.heightRT = new THREE.WebGLRenderTarget(512, 1024, { type: THREE.HalfFloatType, depthBuffer: false });
    // the light map over it: the key light's shadow and the creases' occlusion, baked once a frame (glsl.js shadowMarch,
    // aoMarch) at 16 cm, which the styles read instead of marching the height field for every pixel
    this.lightRT = new THREE.WebGLRenderTarget(LIGHT_W, LIGHT_H, { depthBuffer: false, type: THREE.HalfFloatType });   // half floats: the slopes in ba
    this.lightRT.texture.minFilter = this.lightRT.texture.magFilter = THREE.LinearFilter;
    // ...and the cars' paint and tint over it, at the light map's 16 cm
    this.carPaintRT = new THREE.WebGLRenderTarget(LIGHT_W, LIGHT_H, { depthBuffer: false });
    this.carTintRT = new THREE.WebGLRenderTarget(LIGHT_W, LIGHT_H, { depthBuffer: false });

    // the model's uniforms and the light rig's, shared by every style's materials (with the road field's, ground.js)
    this.uniforms = Object.assign({
      uVeh: { value: vec4s() }, uVehB: { value: vec4s() }, uVehC: { value: Array.from({ length: MAX_VEH }, () => new THREE.Color()) },
      uVehP: { value: new Float32Array(MAX_VEH) },
      uNVeh: { value: 0 }, uDrape: { value: DEFAULT_PROFILE.drape }, tEgo: { value: egoTex }, uEgoOn: { value: 0 }, uEgoSharp: { value: 0 },
      tDef: { value: this.defRT.texture }, tHeight: { value: this.heightRT.texture }, tCov: { value: this.covRT.texture },
      tLight: { value: this.lightRT.texture }, tCarPaint: { value: this.carPaintRT.texture }, tCarTint: { value: this.carTintRT.texture },
      tGlow: { value: this.glowRT[1].texture }, tBloom: { value: this.bloomRT[1].texture }, uDark: { value: 0 },
      uDefInv: { value: this.defVP.clone().invert() }, ...defPlane(this.defVP), uLineH: { value: LINE_H }, uCrisp: { value: 0 },
      uRidgeD: { value: Array.from({ length: RIDGE_MAX }, () => new THREE.Vector2()) }, uRidgeS: { value: new Float32Array(RIDGE_MAX).fill(0.5) },
      uRidgeN: { value: 0 }, uRidgeH: { value: DEFAULT_PROFILE.ridge }, uWorldInv: { value: new THREE.Matrix4() },
      uLook: { value: new THREE.Vector4(...BASE_LIGHT.look) }, uKey: { value: new THREE.Vector3(...BASE_LIGHT.key).normalize() },
      uKeyCol: { value: new THREE.Color() }, uSky: { value: new THREE.Color() }, uGnd: { value: new THREE.Color() },
      uTail: { value: new THREE.Color() }, uBg: { value: new THREE.Color() }, uSheen: { value: 0.5 },
    }, scene.field.uniforms);

    this.bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bakeScene = fullscreen(new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: BAKE_FS, uniforms: this.uniforms, depthTest: false, depthWrite: false }));
    this.lightScene = fullscreen(new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: LIGHT_FS, uniforms: this.uniforms,
      defines: { LIGHT_BAKE: 1 }, depthTest: false, depthWrite: false }));
    const carMat = (defines) => new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: CAR_FS, uniforms: this.uniforms, defines, depthTest: false, depthWrite: false });
    this.carPaintScene = fullscreen(carMat({ CAR_BAKE: 1 }));
    this.carTintScene = fullscreen(carMat({ CAR_BAKE: 1, TINT: 1 }));
    this.lead = null;           // the car we follow this frame: { X, Z (scene), fx, fz (its heading), l, w (half length, half width), gap (m), a }
    this._swaps = new Map();    // line colors -> the materials they recolor (_colors)
    this._c = new THREE.Color();
  }

  setTheme(dark, t) {
    const P = this.palette = dark ? PALETTE.dark : PALETTE.light, U = this.uniforms;
    U.uDark.value = dark ? 1 : 0;
    U.uBg.value.set(t.bg);
    U.uTail.value.set(P.tail);
    U.uSky.value.set(P.sky);
    U.uGnd.value.set(P.gnd);
    U.uKeyCol.value.set(P.key);
    U.uSheen.value = P.sheen;
  }

  // the light a style is drawn in (its `light`)
  setLight({ look, key }) {
    this.uniforms.uLook.value.set(...look);
    this.uniforms.uKey.value.set(...key).normalize();
  }

  buildEgo(ego) {
    buildEgoMap(this.sc.renderer, ego).then((tex) => {
      const old = this.uniforms.tEgo.value;
      this.uniforms.tEgo.value = tex;
      old.dispose();
      this.egoReady = true;
    });
  }

  // Take over from the standard ground (on) or give the scene back to it: the road's own meshes move from the main
  // view (layer 0) into the road map (layer 1) and, its lines and markings, the coverage map (layer 2).
  attach(on) {
    const sc = this.sc;
    const set = (o) => o.traverse((m) => { if (m.isMesh) m.layers.set(on ? 1 : 0); });
    for (const k of ROAD_GEOMETRY) if (sc.ribbons[k]) set(sc.ribbons[k].mesh);
    set(sc.roadnet.group);
    if (sc.blindSpot) set(sc.blindSpot.group);   // its warning glows out of the sheet like the lines' paint
    const cover = (o, skip) => o.traverse((m) => { if (on && m.isMesh && m.material !== skip) m.layers.enable(2); });
    for (const k of ROAD_GEOMETRY) if (sc.ribbons[k] && k !== 'branch') cover(sc.ribbons[k].mesh);
    cover(sc.roadnet.group, sc.roadnet.mats.strip);
    if (!on) {
      sc.ego.visible = true;
      for (const e of sc.objects.values()) if (e.pivot) e.pivot.visible = true;
    }
  }

  // Each frame while a style is on, after the objects and the car have moved and before the render.
  update(profile, lines) {
    const sc = this.sc, U = this.uniforms;
    // the car controls show the real car; otherwise ours is part of the surface once its height map exists
    const real = !!sc.studio || sc.cutaway.awake || !this.egoReady;
    sc.ego.visible = real;
    sc.ground.visible = false;
    U.uEgoOn.value = this.egoReady && !real ? 1 : 0;
    U.uEgoSharp.value = profile.egoExact ? 1 : 0;
    U.uDrape.value = profile.drape;
    U.uRidgeH.value = profile.ridge;
    U.uCrisp.value = profile.crisp ? 1 : 0;
    this._ridges();
    this._cars();
    sc.world.updateMatrixWorld(true);
    U.uWorldInv.value.copy(sc.world.matrixWorld).invert();
    this._render(profile.halo, lines, profile.crisp);
  }

  // The road's ridges (after OceanScape): one along each lane line at its offset across the road field's reference (the
  // map's centerline, or the cameras' anchor line), our lane's two full height and the rest lower, and a broad berm along
  // each edge (or beyond the outermost lines, when the road reports no edges); the nearest first.
  _ridges() {
    const sc = this.sc, U = this.uniforms, ref = sc.mapRef, road = sc.roadOut, out = [];
    let edges = 0;
    if (ref) {
      if (ref.reveal > 0) {
        for (const l of ref.structure) {
          if (l.kind === 'edge') { out.push([l.d, RIDGE.edge]); edges++; } else if (ref.painted !== false) out.push([l.d, l.ego ? RIDGE.ego : RIDGE.other]);
        }
      }
    } else if (road && road.surface.reveal > 0.001) {
      for (const line of road.lines) {
        if (line.inferred && sc.settings?.showRoad === false) continue;
        const d = line.inferred ? line.offset - road.anchor.offset : line.c.y0 - road.anchor.c.y0;
        if (line.edge) { out.push([d, RIDGE.edge]); edges++; } else out.push([d, line.id === 'L1' || line.id === 'R1' ? RIDGE.ego : RIDGE.other]);
      }
    }
    if (out.length && !edges) {
      const ds = out.map(r => r[0]), berm = [RIDGE.edge[0] * 0.875, RIDGE.edge[1]];
      out.push([Math.max(...ds) + RIDGE.beyond, berm], [Math.min(...ds) - RIDGE.beyond, berm]);
    }
    const mid = road && !ref ? -road.anchor.offset : 0;
    out.sort((a, b) => Math.abs(a[0] - mid) - Math.abs(b[0] - mid));
    const n = Math.min(RIDGE_MAX, out.length);
    for (let i = 0; i < n; i++) {
      const [d, [w, s]] = out[i];
      U.uRidgeD.value[i].set(d, w);
      U.uRidgeS.value[i] = s;
    }
    U.uRidgeN.value = n;
  }

  // the cars around us, nearest first, into the model (their own models hidden: the surface draws them)
  _cars() {
    const sc = this.sc, U = this.uniforms, list = [];
    let lead = null;
    for (const e of [...sc.objects.values(), ...sc.worldObjs.values()]) {
      if (!e.pivot || !e.group || e.alpha <= 0.02) continue;
      e.pivot.updateWorldMatrix(true, false);
      const m = e.pivot.matrixWorld.elements, ud = e.group.userData, s = e.pivot.scale.x;
      const X = m[12], Z = m[14];
      list.push({ X, Z, d: Math.hypot(X, Z - 2.4), th: Math.atan2(m[8], m[10]),
        w: ud.width * e.group.scale.x * s / 2, l: ud.length * e.group.scale.z * s / 2, h: ud.height * e.group.scale.y * s, a: e.alpha, c: e.color, painted: !!(e.lead || e.threat) });
      e.pivot.visible = false;
      // the car we follow: the nearest flagged ahead
      if (e.lead && -Z > 0 && (!lead || Z > lead.Z)) {
        const fl = Math.hypot(m[8], m[10]) || 1, l = ud.length * e.group.scale.z * s / 2;
        lead = { X, Z, fx: -m[8] / fl, fz: -m[10] / fl, l, w: ud.width * e.group.scale.x * s / 2, gap: Math.max(0, -Z - l), a: Math.min(1, e.alpha) };
      }
    }
    this.lead = lead;
    list.sort((a, b) => a.d - b.d);
    const n = Math.min(MAX_VEH, list.length);
    for (let i = 0; i < n; i++) {
      const o = list[i];
      U.uVeh.value[i].set(o.X, o.Z, Math.max(0.2, o.w), Math.max(0.2, o.l));
      U.uVehB.value[i].set(Math.cos(o.th), Math.sin(o.th), o.h, o.w > 0.6 ? o.a : -o.a);   // tail lights on cars, not bikes
      U.uVehC.value[i].set(o.c == null ? this.palette.paint : o.c);
      U.uVehP.value[i] = o.painted ? 1 : 0;   // the one we follow, or a threat
    }
    U.uNVeh.value = n;
  }

  // The road map's line colors (the scene's own while it shows them, the style's while it draws the road map)
  _colors(lines, on) {
    let swaps = this._swaps.get(lines);
    if (!swaps) {
      swaps = [];
      const add = (mat, spec) => { if (mat && spec) swaps.push({ mat, keep: new THREE.Color(), to: new THREE.Color(spec[0]).multiplyScalar(spec[1]) }); };
      for (const [k, spec] of Object.entries(lines.ribbons || {})) add(this.sc.mats[k], spec);
      for (const [k, spec] of Object.entries(lines.roadnet || {})) add(this.sc.roadnet.mats[k], spec);
      this._swaps.set(lines, swaps);
    }
    for (const w of swaps) {
      if (on) { w.keep.copy(w.mat.color); w.mat.color.copy(w.to); } else w.mat.color.copy(w.keep);
    }
  }

  // The road map (in the style's line colors) and the coverage map, the halo's Gaussian if the profile asks for it,
  // then the height field from them and the cars.
  _render(halo, lines, crisp) {
    const R = this.sc.renderer, scene = this.sc.scene;
    const prevTarget = R.getRenderTarget(), prevBg = scene.background;
    R.getClearColor(this._c);
    const prevAlpha = R.getClearAlpha();
    scene.background = null;
    R.setClearColor(0x000000, 0);
    if (lines) this._colors(lines, true);
    R.setRenderTarget(this.defRT);
    R.clear();
    R.render(scene, this.defCam);
    if (lines) this._colors(lines, false);
    if (crisp) {   // the lines' coverage, only for a style that draws them crisp (carCrisp); the rest never read it
      scene.overrideMaterial = this.covMat;
      R.setRenderTarget(this.covRT);
      R.clear();
      R.render(scene, this.covCam);
      scene.overrideMaterial = null;
    }
    if (halo) {
      // the halo from the road map's colors, then the bloom from the halo, with taps twice as far apart
      const B = this.blurMat.uniforms;
      for (const [src, lod, steps, sigma, rts] of [[this.defRT.texture, 1, this.blurStep, this.sigmaHalo, this.glowRT],
        [this.glowRT[1].texture, 0, this.bloomStep, BLOOM_TAPS, this.bloomRT]]) {
        B.uSigma.value = sigma;
        for (let i = 0; i < 2; i++) {
          B.tSrc.value = i ? rts[0].texture : src;
          B.uLod.value = i ? 0 : lod;
          B.uStep.value.copy(steps[i]);
          R.setRenderTarget(rts[i]);
          R.render(this.blurScene, this.bakeCam);
        }
      }
    }
    R.setRenderTarget(this.heightRT);
    R.render(this.bakeScene, this.bakeCam);
    R.setRenderTarget(this.lightRT);
    R.render(this.lightScene, this.bakeCam);
    R.setRenderTarget(this.carPaintRT);
    R.render(this.carPaintScene, this.bakeCam);
    R.setRenderTarget(this.carTintRT);
    R.render(this.carTintScene, this.bakeCam);
    R.setRenderTarget(prevTarget);
    R.setClearColor(this._c, prevAlpha);
    scene.background = prevBg;
  }
}
