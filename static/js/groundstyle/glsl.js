// The surface model's constants and the GLSL every style reads it with (see index.js for the overview).
//
// SURFACE_GLSL samples the model: the baked height field, our own car's map, the road map's colors and the cars. It
// never changes with the style. LIGHT_GLSL is the shared light rig (a key light with soft shadows, a sky/ground
// ambient, creases and a sheen) whose settings each style picks for itself (its `light`).

export const MAX_VEH = 16;
export const EGO_B = { x0: -2.8, x1: 2.8, z0: -2.2, z1: 7.0 };   // scene X, Z our car's height map covers (the car is Z 0..4.775)
export const EGO_RES = 0.01;                                      // m per pixel
// the road map: scene X, Z, pixels. 8 cm a pixel across the road, 16.5 cm along it: the lines run along the road, so
// across is where they need it (the car's GPU pays for every pixel of this and the maps baked over it, every frame)
export const DEF = { x0: -26, x1: 26, z0: -130, z1: 18, w: 640, h: 896 };
export const LINE_H = 0.08;                                       // m: a crisp painted line over the sheet (pins)

// the light most styles use: ambient, key, how hard the creases darken, specular; and where the key comes from (ahead
// and above, as in the concept)
export const BASE_LIGHT = { look: [0.55, 0.75, 1, 0.16], key: [-0.45, 1.0, -0.85] };

export const SURFACE_GLSL = `
#define MAX_VEH ${MAX_VEH}
uniform vec4 uVeh[MAX_VEH];    // center X, Z (scene), half width, half length
uniform vec4 uVehB[MAX_VEH];   // cos, sin of the heading, height, presence 0..1 (negative: no tail lights)
uniform vec3 uVehC[MAX_VEH];   // paint (lead, threat...)
uniform int uNVeh;
uniform float uDrape;          // m over which a car rises out of the ground
uniform sampler2D tEgo;        // our car from above: r draped, g exact, b glass
uniform float uEgoOn, uEgoSharp;
uniform sampler2D tDef;        // the road from above: rgb its lines' colors, a where there is road
uniform vec4 uDefB;
uniform float uLineH;
uniform mat4 uWorldInv;   // scene -> ground-fixed (scene.js world) coordinates
const vec4 EGO_B = vec4(${EGO_B.x0}, ${EGO_B.x1}, ${EGO_B.z0}, ${EGO_B.z1});
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec2 vehLocal(int i, vec2 p) { vec2 d = p - uVeh[i].xy; vec4 b = uVehB[i]; return vec2(d.x * b.x - d.y * b.y, d.x * b.y + d.y * b.x); }
float vehD(int i, vec2 p) { return sdBox(vehLocal(i, p), uVeh[i].zw, min(0.5, uVeh[i].z * 0.6)); }
vec2 defUv(vec2 p) { return vec2((p.x - uDefB.x) / (uDefB.y - uDefB.x), (uDefB.w - p.y) / (uDefB.w - uDefB.z)); }
bool outside(vec2 uv) { return uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0; }
vec4 egoTex(vec2 p) {
  vec2 uv = vec2((p.x - EGO_B.x) / (EGO_B.y - EGO_B.x), (EGO_B.w - p.y) / (EGO_B.w - EGO_B.z));
  if (uEgoOn < 0.5 || outside(uv)) return vec4(0.0);
  return textureLod(tEgo, uv, 0.0);
}
float egoH(vec2 p) { vec4 e = egoTex(p); return mix(e.r, e.g, uEgoSharp); }
vec4 defAt(vec2 p) { vec2 uv = defUv(p); return outside(uv) ? vec4(0.0) : textureLod(tDef, uv, 0.0); }
// the road map blurred (its mipmaps): a soft spread of the lines' colors around them
vec3 defBlur(vec2 p, float lod) { vec2 uv = defUv(p); return outside(uv) ? vec3(0.0) : textureLod(tDef, uv, lod).rgb; }
// how much of a line's paint is here: its color's strength in the style's line colors (surface.js CONCEPT_LINES) and
// how much of the texel the line covers; and its hue
float paintOf(vec4 d) { return min(1.0, max(d.r, max(d.g, d.b))); }
// a car o m tall standing level on the ground, over the surface f: it lifts the surface where it's above it, its lowest
// edges give way to it (so a ridge under a car passes under it instead of bending it), and the two meet in a smooth
// fillet rather than a crease, as cloth over both would
float onTop(float f, float o) {
  float k = 0.2, hh = max(k - abs(o - f), 0.0) / k;
  return mix(f, max(o, f) + hh * hh * k * 0.25, smoothstep(0.0, 0.12, o));
}
vec3 lineColor(vec4 d) { float m = max(d.r, max(d.g, d.b)); return m > 0.0 ? d.rgb / m : vec3(0.0); }
// this frame's height field, baked once (surface.js): r the road and the cars around us, g their tail lights, b how much
// the cars raise it (r - b is the road alone). Our own car is added from its own, finer map.
uniform sampler2D tHeight;
vec4 hTex(vec2 p) { vec2 uv = defUv(p); return outside(uv) ? vec4(0.0) : textureLod(tHeight, uv, 0.0); }
float heightAt(vec2 p) { float f = hTex(p).r, e = egoH(p); return e > 0.0 ? onTop(f, e) : f; }
// a smoother normal for a big shaded sheet: the baked field's slope over a few of its texels (so its 10 cm steps
// don't show in the light), our car's over its own finer map where it's on top
vec3 heightNormalWide(vec2 p) {
  float e = 0.15, f = 0.04;
  vec2 g = vec2(hTex(p + vec2(e, 0.0)).r - hTex(p - vec2(e, 0.0)).r, hTex(p + vec2(0.0, e)).r - hTex(p - vec2(0.0, e)).r) / (2.0 * e);
  float eh = egoH(p);
  if (eh > 0.0) {
    vec2 ge = vec2(egoH(p + vec2(f, 0.0)) - egoH(p - vec2(f, 0.0)), egoH(p + vec2(0.0, f)) - egoH(p - vec2(0.0, f))) / (2.0 * f);
    g = mix(g, ge, smoothstep(0.0, 0.1, eh) * smoothstep(-0.02, 0.02, eh - hTex(p).r));
  }
  return normalize(vec3(-g.x, 1.0, -g.y));
}
vec3 heightNormal(vec2 p) {
  float e = 0.06;
  return normalize(vec3(heightAt(p - vec2(e, 0.0)) - heightAt(p + vec2(e, 0.0)), 2.0 * e, heightAt(p - vec2(0.0, e)) - heightAt(p + vec2(0.0, e))));
}
// the cars' paint over their footprints: rgb, and how much of a car is here
vec4 vehPaint(vec2 p) {
  vec3 c = vec3(0.0); float m = 0.0;
  for (int i = 0; i < MAX_VEH; i++) {
    if (i >= uNVeh) break;
    float w = smoothstep(0.3, -0.2, vehD(i, p)) * abs(uVehB[i].w);
    c += uVehC[i] * w; m += w;
  }
  return m > 0.0 ? vec4(c / m, min(m, 1.0)) : vec4(0.0);
}
// ...only the cars painted for a reason (the one we follow, a threat), spread softly over their skirts: a car otherwise
// is the cloth itself, the same color as the road around it
uniform float uVehP[MAX_VEH];   // 1 painted
vec4 vehTint(vec2 p) {
  vec3 c = vec3(0.0); float m = 0.0;
  for (int i = 0; i < MAX_VEH; i++) {
    if (i >= uNVeh) break;
    float w = smoothstep(0.9, -0.6, vehD(i, p)) * abs(uVehB[i].w) * uVehP[i];
    c += uVehC[i] * w; m += w;
  }
  return m > 0.0 ? vec4(c / m, min(m, 1.0)) : vec4(0.0);
}
float tailAt(vec2 p) { return hTex(p).g; }
// the lines' light spread about 30 cm around them, in their colors at their strengths (surface.js, for a profile with
// a halo): about a line's own color along it, falling away to either side
uniform sampler2D tGlow;
vec3 lineHalo(vec2 p) { vec2 uv = defUv(p); return outside(uv) ? vec3(0.0) : textureLod(tGlow, uv, 0.0).rgb * 5.0; }
// ...and their bloom, spread about a metre around them
uniform sampler2D tBloom;
vec3 lineBloom(vec2 p) { vec2 uv = defUv(p); return outside(uv) ? vec3(0.0) : textureLod(tBloom, uv, 0.0).rgb * 16.0; }
// how much a car (ours or another) covers the surface here, and the road map with the lines' paint left off the cars
float carCover(vec2 p) { return smoothstep(0.02, 0.12, hTex(p).b + heightAt(p) - hTex(p).r); }
vec4 paintAt(vec2 p) { vec4 d = defAt(p); d.rgb *= 1.0 - carCover(p); return d; }
float egoBar(vec2 p) { return smoothstep(0.86, 0.74, abs(p.x)) * smoothstep(4.3, 4.5, p.y) * smoothstep(0.08, 0.02, abs(egoH(p) - 0.86)); }
`;

// The light: a key light with soft shadows marched over the height field, creases darkened, a sky/ground ambient and
// a fabric sheen at grazing angles. uBg is the scene's background (its fog), uTail the tail lights' glow.
export const LIGHT_GLSL = `
uniform vec3 uKey, uKeyCol, uSky, uGnd, uBg, uTail;
uniform vec4 uLook;   // ambient, key, how hard the creases darken, specular (the style's)
uniform float uSheen;
uniform float uDark;  // 1 at night
// light from the lines (their paint, halo and bloom) on a color: at night it adds, by day it tints toward its color
vec3 addGlow(vec3 c, vec3 glow) {
  if (uDark > 0.5) return c + glow * 1.6;
  float gi = max(glow.r, max(glow.g, glow.b));
  return mix(c, glow / max(gi, 1e-4), min(1.0, gi) * 0.92);
}
// The key light's soft shadow (marched toward the light over the height field) and the creases' occlusion, at a point
// on the surface p of height h. Each takes a few dozen reads of the height field, too many per pixel at full
// resolution on the car's GPU, so the surface bakes both once a frame into the light map (surface.js, LIGHT_BAKE)
// and the styles read that (shadowAt, aoAt below): they change slowly over the ground.
float shadowMarch(vec2 p, float h) {
  vec2 d = normalize(uKey.xz);
  float tanE = uKey.y / length(uKey.xz), s = 1.0;
  for (int i = 1; i <= 8; i++) {
    float t = float(i) * 0.4;
    float occ = heightAt(p + d * t) - (h + t * tanE);
    s = min(s, 1.0 - smoothstep(0.0, 0.05 + 0.08 * t, occ));
  }
  return s;
}
float aoMarch(vec2 p, float h) {
  float a = 0.0;
  for (int i = 0; i < 6; i++) { float t = float(i) * 1.0472; a += heightAt(p + vec2(cos(t), sin(t)) * 0.5) * 0.6 + heightAt(p + vec2(cos(t + 0.5), sin(t + 0.5)) * 1.1) * 0.4; }
  return clamp(1.0 - max(a / 6.0 - h, 0.0) * 2.4, 0.25, 1.0);
}
#ifndef LIGHT_BAKE
uniform sampler2D tLight;   // the light map: r the key light's shadow, g the occlusion, over the road map's area
#endif
vec2 lightAt(vec2 p) {
#ifdef LIGHT_BAKE
  return vec2(1.0);         // (baking it: not read)
#else
  vec2 uv = defUv(p); return outside(uv) ? vec2(1.0) : textureLod(tLight, uv, 0.0).rg;
#endif
}
float shadowAt(vec2 p, float h) {
#ifdef LIGHT_BAKE
  return shadowMarch(p, h);
#else
  return lightAt(p).r;
#endif
}
float aoAt(vec2 p, float h) {
#ifdef LIGHT_BAKE
  return aoMarch(p, h);
#else
  return lightAt(p).g;
#endif
}
vec3 lit(vec3 alb, vec3 n, vec2 p, float h, vec3 V, float sheen, bool shade) {
  float sh = 1.0, ao = 1.0;
  if (shade) { sh = shadowAt(p, h); ao = pow(aoAt(p, h), uLook.z); }
  float dif = max(dot(n, uKey), 0.0) * sh;
  vec3 c = alb * (mix(uGnd, uSky, n.y * 0.5 + 0.5) * uLook.x * ao + uKeyCol * dif * uLook.y);
  c += uKeyCol * pow(max(dot(n, normalize(uKey + V)), 0.0), 36.0) * uLook.w * sh;
  c += uSky * pow(1.0 - max(dot(n, V), 0.0), 3.0) * sheen * ao;
  return c;
}
`;

// What a style's shaders start with: the model and the light.
export const STYLE_GLSL = SURFACE_GLSL + LIGHT_GLSL;
