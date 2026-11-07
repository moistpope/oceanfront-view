// Blind spot (BSM): the car's warning of something in the lane beside it, drawn on the road there. With a lane line on
// that side, the line turns red along the car, fading out ahead of it and behind it; without one, red ripples run out
// from that side of the car. Both are drawn like the road's paint, so while a ground style is on they go into its
// road map with the lines (groundstyle/surface.js) and glow out of the sheet like them.
//
// Car frame: x ahead of the front bumper, y left; the car spans x -4.775..0. Scene: X = -y, Z = -x.
import * as THREE from '../vendor/three.module.min.js';

const SPAN = [-8.5, 2.0];   // m (car frame x): behind the rear bumper to just ahead of the car
const FADE = 2.6;           // m over which each end fades out
const LINE_W = 0.34;        // m: over the lane line, a little wider than it
const SIDE = 1.05;          // m from the car's middle to where the ripples start, its side
const REACH = 3.4;          // m the ripples run out
const CAP = 160;            // points along a highlighted line
const RED = 0xff3b30;

const LINE_VS = `
attribute float aX;
varying float vX;
void main() { vX = aX; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LINE_FS = `
uniform vec3 uColor;
uniform float uOn, uTime;
varying float vX;
void main() {
  float a = smoothstep(${SPAN[0].toFixed(2)}, ${(SPAN[0] + FADE).toFixed(2)}, vX) * (1.0 - smoothstep(${(SPAN[1] - FADE).toFixed(2)}, ${SPAN[1].toFixed(2)}, vX));
  gl_FragColor = vec4(uColor, a * uOn * (0.82 + 0.18 * sin(uTime * 6.0)));
  #include <colorspace_fragment>
}`;
const RIPPLE_VS = `
varying vec2 vCar;
void main() { vec4 sp = modelMatrix * vec4(position, 1.0); vCar = vec2(-sp.z, -sp.x); gl_Position = projectionMatrix * viewMatrix * sp; }`;
const RIPPLE_FS = `
uniform vec3 uColor;
uniform float uOn, uTime;
varying vec2 vCar;
void main() {
  float along = smoothstep(${SPAN[0].toFixed(2)}, ${(SPAN[0] + FADE).toFixed(2)}, vCar.x) * (1.0 - smoothstep(${(SPAN[1] - FADE).toFixed(2)}, ${SPAN[1].toFixed(2)}, vCar.x));
  float d = abs(vCar.y) - ${SIDE.toFixed(2)};   // m out from the car's side
  float wave = pow(0.5 + 0.5 * cos((d / 0.9 - uTime * 1.5) * 6.2831853), 4.0);   // rings running outward
  float env = smoothstep(0.0, 0.25, d) * (1.0 - smoothstep(${(REACH * 0.45).toFixed(2)}, ${REACH.toFixed(2)}, d));
  float glow = exp(-max(d, 0.0) / 0.7) * 0.35;   // and a glow along the side itself
  gl_FragColor = vec4(uColor, uOn * along * min(1.0, env * wave * 0.9 + glow));
  #include <colorspace_fragment>
}`;

const material = (vertexShader, fragmentShader) => new THREE.ShaderMaterial({
  vertexShader, fragmentShader, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  uniforms: { uColor: { value: new THREE.Color(RED) }, uOn: { value: 0 }, uTime: { value: 0 } },
});

// One side's highlight along its lane line: a strip over the line, rebuilt each frame from the line's points.
class LineStrip {
  constructor() {
    this.pos = new Float32Array(CAP * 2 * 3);
    this.x = new Float32Array(CAP * 2);
    const idx = [];
    for (let i = 0; i < CAP - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aX', new THREE.BufferAttribute(this.x, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, material(LINE_VS, LINE_FS));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;   // over the lines
  }
  // the line's points (car frame) along the span, every half metre or closer
  set(pts) {
    const out = [];
    if (pts) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        if (Math.max(x0, x1) < SPAN[0] - 0.5 || Math.min(x0, x1) > SPAN[1] + 0.5) continue;
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5));
        for (let k = out.length ? 1 : 0; k <= n; k++) out.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
      }
    }
    const m = Math.min(CAP, out.length);
    for (let i = 0; i < m; i++) {
      const [xa, ya] = out[Math.max(0, i - 1)], [xb, yb] = out[Math.min(m - 1, i + 1)];
      const len = Math.hypot(xb - xa, yb - ya) || 1, nx = -(yb - ya) / len * LINE_W / 2, ny = (xb - xa) / len * LINE_W / 2;
      const [x, y] = out[i];
      this.pos.set([-(y + ny), 0.03, -(x + nx), -(y - ny), 0.03, -(x - nx)], i * 6);
      this.x[i * 2] = this.x[i * 2 + 1] = x;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aX.needsUpdate = true;
    this.geo.setDrawRange(0, Math.max(0, m - 1) * 6);
  }
}

export class BlindSpot {
  constructor(scene) {
    this.group = new THREE.Group();
    this.sides = {};
    for (const [name, sign] of [['left', 1], ['right', -1]]) {
      const line = new LineStrip();
      // the ripples' ground beside the car on this side (scene X = -y)
      const ripple = new THREE.Mesh(new THREE.PlaneGeometry(REACH, SPAN[1] - SPAN[0]).rotateX(-Math.PI / 2), material(RIPPLE_VS, RIPPLE_FS));
      ripple.position.set(-sign * (SIDE + REACH / 2), 0.025, -(SPAN[0] + SPAN[1]) / 2);
      ripple.renderOrder = 3;
      ripple.frustumCulled = false;
      this.group.add(line.mesh, ripple);
      this.sides[name] = { line, ripple, on: 0, lineOn: 0 };
    }
    scene.add(this.group);
  }

  /** Each frame: for each side, whether the car warns of something there and our lane's line on that side (car-frame
   *  points, or null for none). The warning eases in and out; so does a line coming or going under it. */
  update(dt, clock, warn) {
    const k = 1 - Math.exp(-dt * 8);
    for (const name of ['left', 'right']) {
      const s = this.sides[name], w = warn[name] || {};
      s.on += ((w.on ? 1 : 0) - s.on) * k;
      s.lineOn += ((w.pts ? 1 : 0) - s.lineOn) * k;
      if (w.pts) s.line.set(w.pts);
      const lineU = s.line.mesh.material.uniforms, rippleU = s.ripple.material.uniforms;
      lineU.uOn.value = s.on * s.lineOn;
      rippleU.uOn.value = s.on * (1 - s.lineOn);
      lineU.uTime.value = rippleU.uTime.value = clock % 1000;
      s.line.mesh.visible = lineU.uOn.value > 0.002;
      s.ripple.visible = rippleU.uOn.value > 0.002;
    }
  }
}
