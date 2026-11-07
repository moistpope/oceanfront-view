// The sheet: the surface model as a mesh, for a style to shade with its own fragment shader (makeSheet). A grid in the
// car frame, dense where our car is and widening outward and ahead, its every vertex lifted to the height field.
import * as THREE from '../../vendor/three.module.min.js';
import { STYLE_GLSL } from './glsl.js';
import { DRUM, DRUM_FADE_GLSL } from '../drum.js';

// m the sheet reaches out to either side and ahead: past where every style's fog has faded it into the background
// (190 m from the camera at most), so its edges are never seen; over their last stretch it fades out anyway (SHEET_FS)
const SIDE = 240, AHEAD = 280;

let grid = null;   // one, shared by every style's sheet
function sheetGeometry() {
  const grow = (from, to, step, k) => { const a = []; let x = from, s = step; while (Math.abs(x) < Math.abs(to)) { a.push(x); x += Math.sign(to - from) * s; s *= k; } a.push(to); return a; };
  const dense = [];
  for (let x = -2.4; x <= 2.4 + 1e-6; x += 0.04) dense.push(+x.toFixed(3));
  const xs = [...grow(-2.4, -SIDE, 0.04, 1.045).slice(1).reverse(), ...dense, ...grow(2.4, SIDE, 0.04, 1.045).slice(1)];
  const zd = [];
  for (let z = -1.6; z <= 6.6 + 1e-6; z += 0.04) zd.push(+z.toFixed(3));
  const zs = [...grow(-1.6, -AHEAD, 0.04, 1.011).slice(1).reverse(), ...zd, ...grow(6.6, 40, 0.04, 1.05).slice(1)];
  const pos = new Float32Array(xs.length * zs.length * 3);
  let k = 0;
  for (const z of zs) for (const x of xs) { pos[k++] = x; pos[k++] = 0; pos[k++] = z; }
  const nx = xs.length, idx = new Uint32Array((nx - 1) * (zs.length - 1) * 6);
  let q = 0;
  for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);   // shaped in the shader: never cull
  return g;
}

const SHEET_VS = `
${STYLE_GLSL}
uniform vec2 uOrigin;     // subtracted from the ground-fixed coordinates, to keep their numbers small (a multiple of the pattern's period)
uniform float uDrop;      // m the sheet sits under the surface (the pin screen's floor, under its pins)
varying vec3 vPos;
varying vec2 vWorld;
varying float vEdge;      // 1 at the sheet's far edges, fading in over their last stretch
void main() {
  vec3 p = position;
  p.y = heightAt(p.xz) - uDrop - 0.01;
  vPos = p;
  vWorld = (uWorldInv * vec4(p.x, 0.0, p.z, 1.0)).xz - uOrigin;
  vEdge = max(smoothstep(${(SIDE * 0.7).toFixed(1)}, ${(SIDE * 0.95).toFixed(1)}, abs(p.x)), 1.0 - smoothstep(${(-AHEAD * 0.95).toFixed(1)}, ${(-AHEAD * 0.7).toFixed(1)}, p.z));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

// What a sheet's fragment shader starts with: the model, the light, where on the sheet this is (vPos in the scene,
// vWorld fixed to the ground) and its last touches.
export const SHEET_FS = `
${STYLE_GLSL}
uniform float uDrop;
varying vec3 vPos;
varying vec2 vWorld;
varying float vEdge;
uniform vec2 uDrum;
${DRUM_FADE_GLSL}
// the scene's fog, from near to far m from the camera, into the background (the horizon's color); the sheet's own far
// edges and the drum's horizon (drum.js) fade into it too, so the ground never ends in a line
vec3 sheetFog(vec3 c, float near, float far) {
  return mix(c, uBg, max(max(smoothstep(near, far, length(vPos - cameraPosition)), vEdge), drumFade(vPos)));
}
// the tail lights where the sheet is raised, then the fog from fog m out
vec3 sheetFinish(vec3 c, vec2 p, bool up, float fog) {
  if (up) c += uTail * (tailAt(p) + egoBar(p)) * 1.2;
  return sheetFog(c, fog, 190.0);
}`;

// A sheet shaded by `fragmentShader` (which starts with SHEET_FS), with the style's own uniforms besides the shared ones.
export function makeSheet(shared, fragmentShader, uniforms = {}) {
  const material = new THREE.ShaderMaterial({
    vertexShader: SHEET_VS, fragmentShader,
    uniforms: Object.assign({ uOrigin: { value: new THREE.Vector2() }, uDrop: { value: 0 }, uDrum: DRUM }, uniforms, shared),
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
  });
  const mesh = new THREE.Mesh(grid || (grid = sheetGeometry()), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
