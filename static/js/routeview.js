// The nav app's route on the map's roads (navroute.js): a glowing ribbon in its lane, in the map group (the pose
// frame, slid and turned with the lane placement like the road network). Violet, so it stands apart from
// openpilot's path (blue) and the comma's planner (green). Sure as far as the route can be told, then fainter where
// it's only likely, fading out; a slow light runs along it the way the car goes.
import * as THREE from '../vendor/three.module.min.js';
import { planRoute, routeLine } from './navroute.js';
import { NET_LINE_LIFT } from './mapsurface.js';

const HALF_W = 1.7;          // m: the ribbon's half width (its glow; the bright core is about half that)
const LIFT = NET_LINE_LIFT + 0.004;
const REBUILD_M = 4, REBUILD_S = 0.5;   // rebuilt when the car has moved this far, or this long has passed
const FADE_S = 0.6;
const COLORS = { light: 0x9a4cf5, dark: 0xb48cff };

const toWorld = (x, y) => [-y, LIFT, -x];   // pose frame -> the world group's axes (as roadnetgeom.js)

const VERT = `
attribute float aAcross;
attribute float aAlong;
varying float vAcross;
varying float vAlong;
#include <fog_pars_vertex>
void main() {
  vAcross = aAcross; vAlong = aAlong;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const FRAG = `
uniform vec3 uColor;
uniform float uTime, uOpacity, uSure, uTotal, uFaint, uLift;
varying float vAcross;
varying float vAlong;
#include <fog_pars_fragment>
void main() {
  float a = abs(vAcross);
  float core = 1.0 - smoothstep(0.38, 0.52, a);
  float glow = exp(-a * a * 5.0);
  // sure to uSure, then the likely part, fainter and fading to nothing at its end
  float past = clamp((vAlong - uSure) / max(uTotal - uSure, 1.0), 0.0, 1.0);
  float strength = mix(1.0, uFaint * (1.0 - past), smoothstep(uSure - 6.0, uSure + 6.0, vAlong));
  strength *= smoothstep(1.0, 9.0, vAlong) * (1.0 - smoothstep(uTotal - 8.0, uTotal, vAlong));
  float pulse = 0.86 + 0.14 * sin((vAlong - uTime * 9.0) * 0.21);
  float alpha = (core * 0.5 + glow * 0.36) * strength * pulse * uOpacity;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), core * uLift), alpha);
  #include <fog_fragment>
}`;

export class RouteView {
  constructor(world) {
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uColor: { value: new THREE.Color(COLORS.light) }, uTime: { value: 0 }, uOpacity: { value: 0 },
        uSure: { value: 0 }, uTotal: { value: 0 }, uFaint: { value: 0.32 }, uLift: { value: 0 },
      }]),
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -5, forceSinglePass: true,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    world.add(this.mesh);
    this.nav = null;        // the step: {key, maneuver, street, instruction, m, half, odo (when given)}
    this.built = null;      // {x, y, t, layer, key, rem}
    this.opacity = 0;
    this.line = null;
  }

  setTheme(dark) {
    this.material.uniforms.uColor.value.set(dark ? COLORS.dark : COLORS.light);
    this.material.uniforms.uLift.value = dark ? 0.25 : 0.0;     // a whiter core at night
    this.material.uniforms.uFaint.value = dark ? 0.3 : 0.36;
    this.material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.material.needsUpdate = true;
  }

  /** The nav app's step (infotainment.js parseNav), or null when there's none. odo: the road's odometer now. */
  setNav(parsed, odo) {
    if (!parsed || !parsed.maneuver && !parsed.dist) { this.nav = null; return; }
    const key = `${parsed.instruction}|${parsed.street}`;
    const m = parsed.dist ? parsed.dist.m : null;
    if (this.nav && this.nav.key === key && m != null && this.nav.m != null) {
      // the same step counting down: keep where it was pinned, nudged inside what the new distance allows
      const ahead = this.nav.m - (odo - this.nav.odo), half = (parsed.dist.half || 0) + 3;
      const kept = Math.max(m - half, Math.min(m + half, ahead));
      this.nav = { ...this.nav, m: kept, half: parsed.dist.half || 0, odo };
      return;
    }
    this.nav = { key, maneuver: parsed.maneuver, street: parsed.street, instruction: parsed.instruction, m, half: parsed.dist ? parsed.dist.half : 0, odo };
  }

  /**
   * Each frame. map: the snapshot's map (its roads layer and way); pose: the car in the layer's frame; ref: the
   * lane placement (mapsurface.js mapReference: its laneCenter, m left of our road's centreline); odo: the road's
   * odometer; show: the map is drawn and the setting is on.
   */
  update({ map, pose, ref, odo, leftTraffic, show, clock, dt }) {
    const layer = map && map.roads;
    const want = !!(show && this.nav && layer && pose);
    if (want) this._maybeBuild(layer, map, pose, ref, odo, leftTraffic, clock);
    const on = want && !!this.line;
    this.opacity = Math.max(0, Math.min(1, this.opacity + (on ? 1 : -1) * (dt || 0.016) / FADE_S));
    this.material.uniforms.uOpacity.value = this.opacity;
    this.material.uniforms.uTime.value = clock;
    this.mesh.visible = this.opacity > 0.001 && !!this.line;
  }

  _maybeBuild(layer, map, pose, ref, odo, leftTraffic, clock) {
    const n = this.nav, rem = n.m != null ? n.m - (odo - n.odo) : null;
    const b = this.built;
    if (b && b.layer === layer.version && b.key === n.key && b.left === leftTraffic && clock - b.t < REBUILD_S &&
      Math.hypot(pose.x - b.x, pose.y - b.y) < REBUILD_M && (rem == null || Math.abs(rem - b.rem) < REBUILD_M)) return;
    this.built = { x: pose.x, y: pose.y, t: clock, layer: layer.version, key: n.key, rem, left: leftTraffic };
    // the route stops being drawn once the step is behind us (the nav app's next one is due)
    if (rem != null && rem < -30) { this.line = null; return; }
    const route = planRoute(layer, { x: pose.x, y: pose.y, h: pose.h },
      { maneuver: n.maneuver, street: n.street, instruction: n.instruction, remaining: rem, half: n.half },
      { wayId: map.way ? map.way.id : null, egoOffset: ref && ref.laneCenter != null ? ref.laneCenter : null, leftTraffic });
    this.line = routeLine(route);
    this._geometry();
  }

  _geometry() {
    const L = this.line;
    if (!L) return;
    const n = L.pts.length, pos = new Float32Array(n * 6), across = new Float32Array(n * 2), along = new Float32Array(n * 2);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = L.pts[Math.max(0, i - 1)], b = L.pts[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * HALF_W, ny = dx / len * HALF_W, p = L.pts[i];
      pos.set([...toWorld(p[0] + nx, p[1] + ny), ...toWorld(p[0] - nx, p[1] - ny)], i * 6);
      across[2 * i] = 1; across[2 * i + 1] = -1;
      along[2 * i] = along[2 * i + 1] = L.along[i];
      if (i + 1 < n) { const k = 2 * i; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
    g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    g.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.material.uniforms.uSure.value = L.sure;
    this.material.uniforms.uTotal.value = L.total;
  }

  clear() { this.line = null; this.built = null; this.mesh.visible = false; this.opacity = 0; }
}
