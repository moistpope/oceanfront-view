// Pins: a pin screen. Square pins fixed to the ground, each pushed up to the surface under its center, over a dark
// floor. Two nested lattices: fine near the car, coarse further out, every second fine pin being a coarse one.
import * as THREE from '../../../vendor/three.module.min.js';
import { BASE_LIGHT, STYLE_GLSL } from '../glsl.js';
import { SHEET_FS } from '../sheet.js';
import { DRUM_FADE_GLSL } from '../../drum.js';

// pitch (m), reach (m), centered this far ahead: the coarse pins reach a little past where they've faded into the fog
// (PIN_VS: 45-100 m from the camera) and no farther, ~70k pins in all (they were ~140k, 1.4M triangles a frame)
const PINS = [{ s: 0.2, r: 16, ahead: 9 }, { s: 0.4, r: 44, ahead: 36 }];
const SWAP = [16, 22];   // m from the car over which the fine pins hand over to the coarse
const FILL = 0.82;       // of the pitch a pin's top covers
const DROP = 0.12;       // m the floor sits under the pins

// One box per instance, its top at the height under its center.
const PIN_VS = `
${STYLE_GLSL}
${DRUM_FADE_GLSL}
attribute vec3 aCell;           // ground-fixed position (in the lattice's frame) and level (0 fine, 1 coarse)
uniform vec2 uSwap;
uniform float uS0, uS1, uFill;
uniform float uReach;           // the coarse lattice's reach (m from its center): its pins fade out over the last fifth
uniform vec3 uPin;
varying vec3 vColor;
void main() {
  vec4 c4 = modelMatrix * vec4(aCell.x, 0.0, aCell.z, 1.0);
  vec2 c = c4.xz;
  float dist = length(c - vec2(0.0, 2.4));
  float k = smoothstep(uSwap.x, uSwap.y, dist);
  float level = aCell.y;
  float size = level < 0.5 ? uS0 * (1.0 - k) : mix(uS0, uS1, k);
  if (size < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec3(0.0); return; }
  float h = heightAt(c);
  vec3 w = vec3(c.x + position.x * size * uFill, mix(h - 1.6, h, position.y), c.y + position.z * size * uFill);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  vec4 d = paintAt(c);
  float line = paintOf(d);
  vec4 vp = vehPaint(c);
  vec4 e = egoTex(c);
  vec3 alb = mix(uPin, lineColor(d) * 0.95, line * 0.9);
  alb = mix(alb, vp.rgb + 0.2, vp.a * 0.35) * (1.0 - e.b * 0.35);
  alb *= 0.88 + 0.22 * clamp(h / 1.6, 0.0, 1.0);   // higher pins catch more light
  vec3 V = normalize(cameraPosition - w);
  // the lines' light on the pins: their paint on the tops, their halo and bloom over the pins round them
  vec3 glow = d.rgb * 0.5 + (lineHalo(c) * 0.5 + lineBloom(c) * 0.3) * (1.0 - carCover(c));
  if (normal.y > 0.5) vColor = addGlow(lit(alb, vec3(0.0, 1.0, 0.0), c, h, V, 0.0, true) + uTail * (tailAt(c) + egoBar(c)) * 1.1, glow);
  else vColor = addGlow(lit(alb, normal, c, h, V, uSheen, false) * mix(0.25, 0.85, position.y), glow * 0.5 * position.y);
  // the pins end well inside the fog, and fade out toward the drum's horizon (drum.js) and their lattice's edge
  float edge = level > 0.5 ? smoothstep(uReach * 0.8, uReach, max(abs(aCell.x), abs(aCell.z))) : 0.0;
  vColor = mix(vColor, uBg, max(max(smoothstep(45.0, 100.0, length(w - cameraPosition)), drumFade(w)), edge));
}`;
const PIN_FS = `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0);
  #include <colorspace_fragment>
}`;

// The floor between the pins: the surface, lowered.
const FLOOR_FS = `
${SHEET_FS}
uniform vec3 uFloor;
void main() {
  vec2 p = vPos.xz;
  float h = vPos.y + uDrop + 0.01;
  bool up = h > 0.004;
  vec3 n = up ? heightNormal(p) : vec3(0.0, 1.0, 0.0);
  vec3 c = mix(uFloor, lit(uFloor * 2.0, n, p, h, normalize(cameraPosition - vPos), 0.0, false), 0.5);
  c = addGlow(c, (lineHalo(p) * 0.45 + lineBloom(p) * 0.45) * (1.0 - carCover(p)));   // the lines' light between the pins
  c = mix(c, uBg, smoothstep(45.0, 100.0, length(vPos - cameraPosition)));
  gl_FragColor = vec4(sheetFinish(c, p, up, 70.0), 1.0);
  #include <colorspace_fragment>
}`;

// A pin: the top and four sides of a unit box standing on y 0..1, instanced over its lattice's cells.
function pinGeometry(cells) {
  const F = [[[-.5, 1, -.5], [.5, 1, -.5], [.5, 1, .5], [-.5, 1, .5], [0, 1, 0]], [[.5, 0, -.5], [.5, 1, -.5], [.5, 1, .5], [.5, 0, .5], [1, 0, 0]],
    [[-.5, 0, .5], [-.5, 1, .5], [-.5, 1, -.5], [-.5, 0, -.5], [-1, 0, 0]], [[-.5, 0, .5], [.5, 0, .5], [.5, 1, .5], [-.5, 1, .5], [0, 0, 1]],
    [[.5, 0, -.5], [-.5, 0, -.5], [-.5, 1, -.5], [.5, 1, -.5], [0, 0, -1]]];
  const V = [], N = [], X = [];
  F.forEach((f, i) => { for (let k = 0; k < 4; k++) { V.push(...f[k]); N.push(...f[4]); } X.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2); });
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setIndex(X);
  g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 3));
  g.instanceCount = cells.length / 3;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}

// A lattice's cells: the fine lattice without the pins it shares with the coarse one, or the whole coarse lattice.
function pinCells(level) {
  const t = PINS[level], n = Math.round(t.r / t.s), a = [];
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) if (level === 1 || i % 2 !== 0 || j % 2 !== 0) a.push(i * t.s, level, j * t.s);
  return new Float32Array(a);
}

export default {
  id: 'pins',
  label: 'Pins',
  blurb: 'Pins: a pin screen.',
  surface: { drape: 0.3, egoExact: true, crisp: true },   // the pins show the shapes as they are, the painted lines too
  light: BASE_LIGHT,
  palette: {
    light: { pin: 0xd6d8dc, floor: 0x9ea2aa },
    dark: { pin: 0x6a6e76, floor: 0x0b0c0f },
  },
  create(kit) {
    const floor = kit.add(kit.sheet(FLOOR_FS, { uDrop: { value: DROP }, uFloor: { value: new THREE.Color() } }));
    const mat = new THREE.ShaderMaterial({
      vertexShader: PIN_VS, fragmentShader: PIN_FS, side: THREE.DoubleSide,
      uniforms: Object.assign({
        uSwap: { value: new THREE.Vector2(...SWAP) }, uS0: { value: PINS[0].s }, uS1: { value: PINS[1].s }, uFill: { value: FILL }, uReach: { value: PINS[1].r },
        uPin: { value: new THREE.Color() },
      }, kit.uniforms),
    });
    const tiers = PINS.map((t, i) => {
      const m = new THREE.Mesh(pinGeometry(pinCells(i)), mat);
      m.frustumCulled = false;
      return kit.add(m, 'world');
    });
    return {
      setTheme(P) {
        mat.uniforms.uPin.value.set(P.pin);
        floor.material.uniforms.uFloor.value.set(P.floor);
      },
      // each lattice re-centered ahead of the car, in whole coarse pairs (so the fine lattice's gaps stay on the coarse pins)
      update(f) {
        const q = PINS[1].s * 2;
        PINS.forEach((t, i) => tiers[i].position.set(Math.round((f.carX + f.aheadX * t.ahead) / q) * q, 0, Math.round((f.carZ + f.aheadZ * t.ahead) / q) * q));
      },
    };
  },
};
