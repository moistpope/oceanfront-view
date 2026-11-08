// Perforated: a perforated fabric over the road, after the concept's head-unit stills and OceanScape's concept style
// (github.com/benkayuk/oceanscape, fabric.js). The lines are lit from under the cloth: a bright core along each line
// and a halo around it that shines out through the perforations, amber, blue while steering, red for a departure
// (surface.js CONCEPT_LINES). A soft bar of light lies just behind the car we follow, green to red with the time gap,
// and a sonar pulse runs out from it every few seconds; the tail
// lights shine dimly through the cloth over each car's back. A low light from ahead and to the left brings out the
// ridges, with soft shadows and creases; the sky brightens down to the horizon the sheet fades into.
import * as THREE from '../../../vendor/three.module.min.js';
import { SHEET_FS } from '../sheet.js';

const CELL = 0.085, HOLE_R = 0.3;   // the perforations' pitch (m) and radius (in pitches)
const FOG = [80, 260];              // m from the camera: the sheet fades into the horizon (the road map reaches 300 m)
// the bar's colors by the time gap to the car we follow (s): green with a long gap, through yellow and orange, red close
const GAP_COLORS = [[2.2, 0x3ddc6a], [1.5, 0xffd23a], [1.0, 0xff8a1f], [0, 0xff3b30]].map(([s, c]) => [s, new THREE.Color(c)]);
// the gap bar behind the car we follow: from BAR[0] to BAR[1] m off its back bumper, as wide as the car
const BAR = [0.3, 0.6];
const BAR_FADE_S = 1.2;   // s it takes to fade in or out as that car is gained or lost
const PULSE_S = 5;        // s between pulses
const PULSE_LIFE = 1.6;   // s a pulse lasts
const PULSE_REACH = 2;    // m it runs out from the bar

const SHEET = `
${SHEET_FS}
uniform vec3 uBase, uHole;
uniform float uHoleR, uCell;
uniform vec4 uLead;   // the gap bar: center (scene X, Z), strength, where its pulse is in its cycle (0..1)
uniform vec4 uBar;    // its heading (scene X, Z), half width and half depth (m)
uniform vec3 uLeadC;  // its color
uniform vec2 uToUs;   // from the bar toward our car (scene X, Z)
// a hole, fixed to the ground: its mask and how well the holes resolve here (under a few pixels apart, their average
// instead, not moire)
float holeAt(vec2 gc, out vec2 off, out float raw, out float vis) {
  vec2 f = fract(gc) - 0.5; off = f;
  float dd = length(f);
  float aa = fwidth(dd) * 1.1 + 1e-4;
  raw = 1.0 - smoothstep(uHoleR - aa, uHoleR + aa, dd);
  float cellPx = 1.0 / max(max(fwidth(gc.x), fwidth(gc.y)), 1e-5);
  vis = smoothstep(3.0, 6.5, cellPx);
  return mix(3.14159 * uHoleR * uHoleR, raw, vis);
}
// the holes seen from above, as a texture's mipmaps would be: where they're under a few pixels apart, the pattern at
// twice the pitch (and again, up to HOLE_LODS times), blended between levels, so the cloth still reads as perforated far
// off and at a reduced render scale rather than turning smooth a few metres ahead. The derivatives are taken once here
// (gc / 2^k's are gc's / 2^k), before anything branches.
const float HOLE_LODS = 4.0;
float holeLevel(vec2 gc, float k, float fw, out vec2 off, out float raw) {
  float sc = exp2(k);
  vec2 g = gc / sc, f = fract(g) - 0.5; off = f;
  float dd = length(f), aa = fw / sc * 0.8 + 1e-4;
  raw = 1.0 - smoothstep(uHoleR - aa, uHoleR + aa, dd);
  return raw;
}
float holeTop(vec2 gc, out vec2 off, out float raw, out float vis) {
  float fw = max(max(fwidth(gc.x), fwidth(gc.y)), 1e-5);
  float k = clamp(log2(6.0 * fw), 0.0, HOLE_LODS), k0 = floor(k), t = smoothstep(0.6, 1.0, k - k0);
  vec2 oa, ob; float ra, rb;
  holeLevel(gc, k0, fw, oa, ra);
  holeLevel(gc, k0 + 1.0, fw, ob, rb);
  off = t < 0.5 ? oa : ob;
  // the coarser levels lighter: far off the holes are a texture, not the near ones' bold pattern
  raw = mix(ra, rb, t) * (1.0 - 0.14 * k);
  // past the coarsest level, their average
  vis = smoothstep(3.0, 6.5, exp2(HOLE_LODS) / fw);
  return mix(3.14159 * uHoleR * uHoleR, raw, vis);
}
void main() {
  vec2 p = vPos.xz;
  float h = vPos.y + uDrop + 0.01;
  // the holes first (their anti-aliasing takes derivatives, so before anything branches): seen from above and from
  // both ground-fixed sides
  vec2 o0, o1, o2; float r0, r1, r2, v0, v1, v2;
  float hT = holeTop(vWorld / uCell, o0, r0, v0), hA = holeAt(vec2(vWorld.y, vPos.y) / uCell, o1, r1, v1), hB = holeAt(vec2(vWorld.x, vPos.y) / uCell, o2, r2, v2);
  bool up = h > 0.004;
  vec3 n = up ? heightNormalWide(p) : vec3(0.0, 1.0, 0.0);
  vec3 V = normalize(cameraPosition - vPos);
  vec4 vp = vehTint(p);   // only the car we follow or a threat: the rest are the cloth itself
  vec4 e = egoTex(p);
  vec3 nw = normalize(mat3(uWorldInv) * n);
  vec3 bw = pow(abs(nw), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
  float holes = hA * bw.x + hT * bw.y + hB * bw.z;
  // how much of the light under the cloth gets out here: through a hole, or (holes too small to see) about half
  float through = mix(0.45, r1 * bw.x + r0 * bw.y + r2 * bw.z, v1 * bw.x + v0 * bw.y + v2 * bw.z);

  // the cloth: the key light with its shadows, creases darker, a sheen where it faces the light; the holes darker
  vec3 alb = mix(uBase, vp.rgb, vp.a * 0.35) * (1.0 - e.b * 0.4);
  float sh = shadowAt(p, h), ao = pow(aoAt(p, h), uLook.z);
  float lit = uLook.x * ao + uLook.y * max(dot(n, uKey), 0.0) * sh;
  float spec = pow(max(dot(n, normalize(uKey + V)), 0.0), 24.0) * sh;
  vec3 c = alb * lit + uKeyCol * spec * uLook.w * (1.0 - holes);
  vec2 ld = normalize((uWorldInv * vec4(uKey.x, 0.0, uKey.z, 0.0)).xz);
  float wall = clamp(dot(normalize(o0 + 1e-4), ld), 0.0, 1.0) * smoothstep(uHoleR * 0.35, uHoleR, length(o0)) * bw.y;
  c = mix(c, uHole * (0.6 + 0.4 * lit) + uKeyCol * wall * 0.05, holes * 0.85);

  // the light from under it: the lines' cores, their halos mostly out of the holes, and their bloom over the cloth
  float clear = 1.0 - carCover(p);
  vec3 glow = paintAt(p).rgb * (0.7 + 0.5 * through) + (lineHalo(p) * 0.6 * through + lineBloom(p) * (0.18 + 0.32 * through)) * clear;
  // the gap bar behind the car we follow: a soft rounded box of light (d its distance out from the box), and a pulse
  // for the first part of each cycle: an arc that leaves the bar's back and runs out toward us, slowing and fading. Its
  // circle is centered ahead of the bar so that it starts on the bar's back edge, curved about as wide as the car;
  // only the part facing us shows, its ends soft
  if (uLead.z > 0.003) {
    vec2 lq = p - uLead.xy;
    vec2 bq = abs(vec2(dot(lq, vec2(-uBar.y, uBar.x)), dot(lq, uBar.xy))) - (uBar.zw - 0.1);
    float d = length(max(bq, 0.0)) + min(max(bq.x, bq.y), 0.0) - 0.1;
    float bar = 1.0 - smoothstep(-0.16, 0.22, d);
    float k = uLead.w * ${(PULSE_S / PULSE_LIFE).toFixed(4)}, pulse = 0.0;
    if (k < 1.0) {
      float r = ${PULSE_REACH.toFixed(1)} * (1.0 - (1.0 - k) * (1.0 - k));
      vec2 aq = lq - uBar.xy * uBar.z;                   // from the arc's center, a half width ahead of the bar's
      float ar = length(aq), r0 = uBar.z + uBar.w;      // the bar's back edge
      float facing = smoothstep(0.45, 0.85, dot(aq / max(ar, 1e-3), uToUs));
      pulse = exp(-pow((ar - r0 - r) / (0.1 + 0.18 * k), 2.0)) * facing * (1.0 - k) * (1.0 - k) * smoothstep(0.0, 0.06, k);
    }
    glow += uLeadC * uLead.z * (bar * 0.5 + pulse * 0.55) * clear * (0.35 + 0.65 * through) * (uDark > 0.5 ? 1.0 : 1.5);
  }
  // the tail lights shining dimly through the cloth over each car's back, ours too
  if (up) glow += uTail * (tailAt(p) + egoBar(p)) * (0.12 + 0.88 * through) * (uDark > 0.5 ? 0.9 : 1.2);
  c = addGlow(c, glow);
  gl_FragColor = vec4(sheetFog(c, ${FOG[0].toFixed(1)}, ${FOG[1].toFixed(1)}), 1.0);
  #include <colorspace_fragment>
}`;

export default {
  id: 'perforated',
  label: 'Perforated',
  blurb: 'Perforated: a perforated fabric, the lines glowing through it.',
  surface: { halo: true },
  // a low key from ahead and to the left that brings the ridges out: ambient, key, how hard the creases darken, sheen
  light: { look: [0.38, 0.85, 1.6, 0.18], key: [-0.55, 0.55, -0.65] },
  palette: {
    light: { base: 0xdcdcdc, hole: 0x8a8a8a },
    dark: { base: 0x555555, hole: 0x1c1c1c },
  },
  // the sky: overhead, and at the horizon (which the sheet fades into)
  sky: { light: [0xf2f2f2, 0xd6d6d6], dark: [0x1a1a1a, 0x3a3a3a] },
  create(kit) {
    const sheet = kit.add(kit.sheet(SHEET, {
      uBase: { value: new THREE.Color() }, uHole: { value: new THREE.Color() }, uHoleR: { value: HOLE_R }, uCell: { value: CELL },
      uLead: { value: new THREE.Vector4() }, uBar: { value: new THREE.Vector4(0, -1, 1, 0.15) }, uLeadC: { value: new THREE.Color() }, uToUs: { value: new THREE.Vector2(0, 1) },
    }));
    const u = sheet.material.uniforms, snap = CELL * 512;
    const bar = { s: 0, phase: 0, on: false, color: GAP_COLORS[0][1].clone() };
    return {
      setTheme(P) {
        u.uBase.value.set(P.base);
        u.uHole.value.set(P.hole);
      },
      update(f) {
        // the holes' origin near the car, snapped to a multiple of their pitch
        u.uOrigin.value.set(Math.round(f.carX / snap) * snap, Math.round(f.carZ / snap) * snap);
        // the gap bar: fixed behind the car we follow, its color eased to the time gap. It fades in when we gain that car
        // and out (where it last was) when we lose it; a different car (one cutting in) fades the bar out at the old one
        // before it comes back at the new
        const L = f.lead, U = u.uLead.value, B = u.uBar.value;
        const cx = L ? L.X - L.fx * (L.l + (BAR[0] + BAR[1]) / 2) : 0, cz = L ? L.Z - L.fz * (L.l + (BAR[0] + BAR[1]) / 2) : 0;
        const jumped = L && bar.on && Math.hypot(cx - U.x, cz - U.y) > 4;
        const want = L && !jumped ? L.a : 0;
        const step = f.dt / BAR_FADE_S;
        bar.s = want > bar.s ? Math.min(want, bar.s + step) : Math.max(want, bar.s - step);
        if (L && (!jumped || bar.s <= 0.01)) {
          if (!bar.on || jumped) { bar.color.copy(GAP_COLORS.find(([s]) => L.gap / Math.max(3, f.speed) >= s)[1]); bar.phase = 0; }
          bar.on = true;
          U.x = cx; U.y = cz;
          B.set(L.fx, L.fz, Math.max(0.6, L.w), (BAR[1] - BAR[0]) / 2);
          const tx = -cx, tz = 2.4 - cz, tl = Math.hypot(tx, tz) || 1;   // toward our middle (scene X 0, Z 2.4)
          u.uToUs.value.set(tx / tl, tz / tl);
          bar.color.lerp(GAP_COLORS.find(([s]) => L.gap / Math.max(3, f.speed) >= s)[1], Math.min(1, f.dt * 2));
        } else if (bar.s <= 0) bar.on = false;
        bar.phase = (bar.phase + f.dt / PULSE_S) % 1;
        U.z = bar.s;
        U.w = bar.phase;
        u.uLeadC.value.copy(bar.color);
      },
    };
  },
};
