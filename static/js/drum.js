// The drum horizon (Display -> Layout): the whole 3D view bent over a horizontal drum under the car, so the road
// falls away ahead to a close horizon, as in the Fisker Ocean concept's renders.
//
// Every vertex shader gets it (installDrum, through three.js's onBeforeCompile; a material with its own
// onBeforeCompile calls drumShader itself): once a vertex is projected, it's taken back to the scene, bent and
// projected again, so it works whatever the material and however it placed the vertex. Orthographic renders (the
// ground styles' top-down maps, the car's height map) stay flat, and so does the shading: only where things are drawn
// moves. The drum's axis runs across the car (scene X) under its middle; DRUM.k is its curvature, 0 for flat.
import * as THREE from '../vendor/three.module.min.js';

export const DRUM = { value: new THREE.Vector2(0, 2.4) };   // curvature (1/m), scene Z of the drum's top

const HALF_PI = Math.PI / 2;
const GLSL = `
uniform vec2 uDrum;
vec4 drumBend(vec4 c) {
  if (uDrum.x < 1e-5 || isOrthographic) return c;
  // the camera's frame (the perspective's w is the depth), then the scene's
  float z = -c.w;
  vec3 v = vec3((c.x - projectionMatrix[2][0] * z) / projectionMatrix[0][0], (c.y - projectionMatrix[2][1] * z) / projectionMatrix[1][1], z);
  vec3 p = transpose(mat3(viewMatrix)) * (v - viewMatrix[3].xyz);
  // round the drum: the distance ahead of its top becomes an angle; past a quarter turn, straight down
  float R = 1.0 / uDrum.x, s = uDrum.y - p.z, a = s * uDrum.x, r = R + p.y;
  vec3 q = abs(a) < ${HALF_PI.toFixed(7)}
    ? vec3(p.x, r * cos(a) - R, uDrum.y - r * sin(a))
    : vec3(p.x, -R - (abs(s) - R * ${HALF_PI.toFixed(7)}), uDrum.y - sign(a) * r);
  return projectionMatrix * (viewMatrix * vec4(q, 1.0));
}
`;

// How close a point of the ground (scene coordinates, unbent) appears to the drum's horizon: 1 on it, 0 from about 2
// degrees below it (as the camera sees it, so the same band on the screen however far off the horizon is). The ground
// fades into the background by it, so the drum ends in a soft haze rather than a cut. Needs `uniform vec2 uDrum` (a
// vertex shader has it from drumShader; a fragment shader declares it) and the material bent by drumShader, which
// gives it the value.
export const DRUM_FADE_GLSL = `
float drumFade(vec3 p) {
  if (uDrum.x < 1e-5) return 0.0;
  // in the drum's cross-section, from its axis: z from its top (behind positive), y up
  float R = 1.0 / uDrum.x;
  vec2 cam = vec2(cameraPosition.z - uDrum.y, cameraPosition.y + R);
  float a = (uDrum.y - p.z) * uDrum.x, r = R + p.y;
  vec2 q = vec2(-r * sin(a), r * cos(a));   // the point where the drum puts it
  // the horizon: the camera's line of sight that just grazes the drum ahead
  float t = acos(clamp(R / length(cam), -1.0, 1.0)) - atan(cam.x, cam.y);
  vec2 h = normalize(vec2(-R * sin(t), R * cos(t)) - cam), v = normalize(q - cam);
  float below = h.x * v.y - h.y * v.x;   // sine of the angle the point's line of sight lies under it
  return 1.0 - smoothstep(0.0, 0.035, below);
}`;

// three.js's own materials for the sky (the background, and the cube it makes from a sky map) and for environment
// maps: they draw directions, not places, so they stay as they are
const UNBENT = /^(Background|Cubemap|Equirect|SphericalGaussian)/;

// Bend a material's vertex shader (an onBeforeCompile: `this` is the material).
export function drumShader(shader) {
  if (shader.vertexShader.includes('drumBend') || UNBENT.test(this?.name || '')) return;
  shader.uniforms.uDrum = DRUM;
  const vs = shader.vertexShader, end = vs.lastIndexOf('}');
  shader.vertexShader = GLSL + vs.slice(0, end) + '  gl_Position = drumBend(gl_Position);\n' + vs.slice(end);
}

// A material that fades out toward the drum's horizon as the ground does (for what's drawn on the ground in the main
// view: the planned path and the like). Its own onBeforeCompile replaces the drum's, so it bends it too.
export function fadeAtDrum(material) {
  material.transparent = true;
  material.onBeforeCompile = function (sh) {
    sh.vertexShader = 'varying vec3 vDrumPos;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvDrumPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'varying vec3 vDrumPos;\nuniform vec2 uDrum;\n' + DRUM_FADE_GLSL + sh.fragmentShader.replace('#include <alphamap_fragment>',
      '#include <alphamap_fragment>\ndiffuseColor.a *= 1.0 - drumFade(vDrumPos);');
    drumShader.call(this, sh);
  };
  material.customProgramCacheKey = () => 'drumFade';
  material.needsUpdate = true;
  return material;
}

// Every material from now on (before anything is drawn).
export function installDrum() { THREE.Material.prototype.onBeforeCompile = drumShader; }

// The same bend for a point in the scene (for what's placed over the view from JavaScript, like the object tags).
export function drumPoint(v) {
  const k = DRUM.value.x, top = DRUM.value.y;
  if (k < 1e-5) return v;
  const R = 1 / k, s = top - v.z, a = s * k, r = R + v.y;
  if (Math.abs(a) < HALF_PI) v.set(v.x, r * Math.cos(a) - R, top - r * Math.sin(a));
  else v.set(v.x, -R - (Math.abs(s) - R * HALF_PI), top - Math.sign(a) * r);
  return v;
}
