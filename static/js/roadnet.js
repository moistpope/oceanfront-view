// The map's road network drawn on the ground around the car (mapsurface.js `roadNetwork`): meshes in the
// view's ground-fixed `world` group (under the scene's map group, which takes the lane placement's slide and
// turn), in the pose frame the worker's roads layer comes in, rebuilt only when a new layer arrives. The rebuild runs
// in roadnetworker.js, off the page's thread; the last meshes stay up until the new ones come back. Every
// road gets its strip and its lines, the one we're on included: one source of lines, nothing toggles.
import * as THREE from '../vendor/three.module.min.js';
import { roadArrays } from './roadnetgeom.js';

export class RoadNetwork {
  constructor(world) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.renderOrder = 0;
    world.add(this.group);
    // double-sided: the strips' boundaries run whichever way the OSM way does; lifted clear of the ground plane,
    // which otherwise wins the depth test at a distance. One pass: they're flat, so three's back-then-front pair of
    // draws for a transparent two-sided material (and its program check each time) buys nothing
    const side = THREE.DoubleSide;
    const over = (units) => ({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -units, forceSinglePass: true });
    this.mats = {
      strip: new THREE.MeshBasicMaterial({ color: 0x1e2127, fog: true, side, ...over(2) }),
      edge: new THREE.MeshBasicMaterial({ color: 0x6c727b, transparent: true, opacity: 0.6, fog: true, depthWrite: false, side, ...over(4) }),
      center: new THREE.MeshBasicMaterial({ color: 0xdcaa2e, transparent: true, opacity: 0.5, fog: true, depthWrite: false, side, ...over(4) }),
      lane: new THREE.MeshBasicMaterial({ color: 0x8e949d, transparent: true, opacity: 0.45, fog: true, depthWrite: false, side, ...over(4) }),
      centerSingle: new THREE.MeshBasicMaterial({ color: 0x8e949d, transparent: true, opacity: 0.7, fog: true, depthWrite: false, side, ...over(4) }),
      arrow: new THREE.MeshBasicMaterial({ color: 0x8e949d, transparent: true, opacity: 0.8, fog: true, depthWrite: false, side, ...over(4) }),
    };
    this.meshes = {};
    for (const k in this.mats) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), this.mats[k]);
      m.frustumCulled = false;
      m.renderOrder = k === 'strip' ? 0 : 1;
      this.group.add(m);
      this.meshes[k] = m;
    }
    this.version = -1;
    this.layer = null;
    this.leftTraffic = false;
    this.usLines = true;
    this.visible = true;
    this.seq = 0;   // the latest rebuild asked for; an answer to an older one (or one from before clear()) is dropped
    try {
      this.worker = new Worker(new URL('./roadnetworker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => { if (e.data.seq === this.seq) this._apply(e.data.arrays); };
      this.worker.onerror = () => { this.worker = null; if (this.layer) this._rebuild(); };   // build here instead
    } catch (e) { this.worker = null; }
  }

  setTheme(t, dark) {
    this.mats.strip.color.set(t.ground).lerp(new THREE.Color(t.road), dark ? 0.35 : 0.07);
    this.mats.edge.color.set(t.edge);
    this.mats.center.color.set(t.yellow);
    this.mats.lane.color.set(t.line);
    this.mats.centerSingle.color.set(t.edge);
    this.mats.arrow.color.set(t.line);
  }

  /** Take the snapshot's layer when a new one came and rebuild. */
  /** usLines: the double yellow center line (the US), else a single white dashed one (regional.js). */
  update(map, show = true, leftTraffic = false, usLines = !leftTraffic) {
    this.group.visible = show && !!this.layer;
    if (!map) return;
    const changed = leftTraffic !== this.leftTraffic || usLines !== this.usLines;
    this.leftTraffic = leftTraffic; this.usLines = usLines;
    if (map.roads && map.roads.version !== this.version) { this.layer = map.roads; this.version = map.roads.version; this._rebuild(); }
    else if (this.layer && changed) this._rebuild();
    this.group.visible = show && !!this.layer;
  }

  /** Drop the layer (the pose frame changed: its geometry is in the old one). */
  clear() {
    this.layer = null;
    this.version = -1;
    this.group.visible = false;
    this.seq++;
    for (const k in this.meshes) { this.meshes[k].geometry.dispose(); this.meshes[k].geometry = new THREE.BufferGeometry(); }
  }

  _rebuild() {
    const seq = ++this.seq;
    if (this.worker) this.worker.postMessage({ seq, layer: this.layer, leftTraffic: this.leftTraffic, usLines: this.usLines });
    else this._apply(roadArrays(this.layer, this.leftTraffic, this.usLines));
  }

  _apply(arrays) {
    for (const k in this.meshes) {
      const a = arrays[k], g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
      g.setIndex(new THREE.BufferAttribute(a.idx, 1));
      this.meshes[k].geometry.dispose(); this.meshes[k].geometry = g;
    }
  }
}
