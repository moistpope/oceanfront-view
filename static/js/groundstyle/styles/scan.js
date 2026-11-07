// Scanlines: lines across the road, drawn on the surface (so a bump hides the lines behind it) and fixed along the
// road: its station plus the distance driven.
import * as THREE from '../../../vendor/three.module.min.js';
import { FIELD_GLSL } from '../../ground.js';
import { BASE_LIGHT } from '../glsl.js';
import { SHEET_FS } from '../sheet.js';

const SPACING = 0.45;   // m between scanlines

const SCAN_FS = `
${SHEET_FS}
${FIELD_GLSL}
uniform vec3 uSurf, uLine;
uniform float uScanSp, uOdo;
void main() {
  vec2 p = vPos.xz;
  float h = vPos.y + uDrop + 0.01;
  // the lines first, about 1.6 px wide (their anti-aliasing takes derivatives, so before anything branches)
  float g = (roadSD(vec2(-p.y, -p.x)).x + uOdo) / uScanSp;
  float dl = abs(fract(g + 0.5) - 0.5), fw = max(fwidth(g), 1e-5);
  float scan = 1.0 - smoothstep(fw * 0.8, fw * 1.8, dl);
  scan = mix(0.12, scan, smoothstep(3.0, 7.0, 1.0 / fw));   // closer than a few pixels: an even tone
  bool up = h > 0.004;
  vec3 n = up ? heightNormalWide(p) : vec3(0.0, 1.0, 0.0);
  vec3 V = normalize(cameraPosition - vPos);
  vec4 d = paintAt(p);
  vec4 vp = up ? vehPaint(p) : vec4(0.0);
  vec3 base = mix(uBg, uSurf, 0.22);
  vec3 col = mix(uLine, lineColor(d), paintOf(d) * 0.9);   // the scanlines take the road lines' colors
  col = mix(col, vp.rgb + 0.25, vp.a * 0.3);
  vec3 c = mix(lit(base, n, p, h, V, 0.0, false), lit(col, n, p, h, V, uSheen * 0.6, true), scan);
  // the lines' light: strongest along the scanlines, a little between them
  vec3 glow = d.rgb * 0.5 * scan + (lineHalo(p) * 0.5 + lineBloom(p) * 0.3) * (0.3 + 0.7 * scan) * (1.0 - carCover(p));
  c = addGlow(c, glow);
  gl_FragColor = vec4(sheetFinish(c, p, up, 70.0), 1.0);
  #include <colorspace_fragment>
}`;

export default {
  id: 'scan',
  label: 'Scanlines',
  blurb: 'Scanlines: lines across the road.',
  surface: {},
  light: BASE_LIGHT,
  palette: {
    light: { surf: 0xd2d4d8, line: 0x5a5e66 },
    dark: { surf: 0x4a4d54, line: 0xc8ccd4 },
  },
  create(kit) {
    const sheet = kit.add(kit.sheet(SCAN_FS, {
      uSurf: { value: new THREE.Color() }, uLine: { value: new THREE.Color() }, uScanSp: { value: SPACING }, uOdo: { value: 0 },
    }));
    const u = sheet.material.uniforms;
    return {
      setTheme(P) {
        u.uSurf.value.set(P.surf);
        u.uLine.value.set(P.line);
      },
      update(f) { u.uOdo.value = f.odometer; },
    };
  },
};
