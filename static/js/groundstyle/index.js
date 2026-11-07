// Ground styles after Territory Studio's Fisker Ocean concept (Display -> Ground style): the whole scene as one surface
// that everything deforms, instead of a flat ground with models and painted lines on it.
//
// Two layers, so a look can be swapped without touching what it shows:
//  - the surface model (surface.js): the road, its lines and the cars around us (ours included) pushing up one sheet
//    fixed to the ground, baked into a height field each frame. Every style reads the same model (glsl.js).
//  - the styles (styles/*.js): how that surface is drawn. Each is one self-contained module:
//      id, label, blurb   for the settings
//      surface            its profile: how its sheet takes the model's shape (surface.js DEFAULT_PROFILE)
//      light              the light rig's settings (glsl.js BASE_LIGHT)
//      palette            { light, dark }: its own colors, handed to its setTheme
//      lines              the road's lines' colors in its road map (surface.js CONCEPT_LINES, the default)
//      sky                optional { light, dark: [overhead, horizon] }: a gradient behind it, the horizon also the fog's
//      create(kit)        builds its objects, the first time it's chosen. kit.uniforms are the model's and the light's
//                         (share them into its materials), kit.sheet(fragmentShader, uniforms) the surface as a mesh
//                         (sheet.js), kit.add(object, 'scene' | 'world') adds an object fixed to the car or to the
//                         ground, shown while the style is. Returns { setTheme(palette, dark), update(frame) }, both
//                         optional; the frame is GroundStyle._frame's.
//    Its patterns are fixed to the ground (or along the road), so the cars move under them like under a blanket.
//
// To add a style, write styles/<name>.js and list it in STYLES; the settings pick it up from GROUND_STYLES.
import * as THREE from '../../vendor/three.module.min.js';
import { GroundSurface, DEFAULT_PROFILE, CONCEPT_LINES } from './surface.js';
import { makeSheet } from './sheet.js';
import { BASE_LIGHT } from './glsl.js';
import pins from './styles/pins.js';
import scan from './styles/scan.js';
import perforated from './styles/perforated.js';
import points from './styles/points.js';

export const STYLES = [perforated, pins, scan, points].map((s) => ({ ...s, surface: { ...DEFAULT_PROFILE, ...s.surface }, light: s.light || BASE_LIGHT,
  lines: s.lines || CONCEPT_LINES }));
const BY_ID = new Map(STYLES.map((s) => [s.id, s]));

// for the settings: the styles (perforated, the default, first), then the flat ground and road without a surface
export const GROUND_STYLES = [...STYLES.map(({ id, label, blurb }) => ({ id, label, blurb })),
  { id: 'flat', label: 'Flat', blurb: 'Flat: the plain ground and road.' }];

export class GroundStyle {
  constructor(scene) {
    this.sc = scene;
    this.surface = new GroundSurface(scene);
    this.built = new Map();   // style id -> { objects, setTheme, update }
    this.active = null;       // the style drawn, or null: the flat ground
    this.dark = false;
    this._f = { carX: 0, carZ: 0, aheadX: 0, aheadZ: -1, odometer: 0, pxPerM: 1000, time: 0, dt: 0, speed: 0, lead: null };
    this._sky = null;         // the active style's sky, as a texture, while it shows
    this._v2 = new THREE.Vector2();
  }

  get style() { return this.active ? this.active.id : 'flat'; }

  setTheme(dark, t) {
    this.dark = dark;
    this.surface.setTheme(dark, t);
    for (const [id, s] of this.built) s.setTheme?.(BY_ID.get(id).palette[dark ? 'dark' : 'light'], dark);
    this._applySky();
  }

  // The active style's sky behind the scene (its horizon also the fog's and the sheets' background), or the theme's
  // plain background back.
  _applySky() {
    const sc = this.sc, def = this.active, sky = def && def.sky && def.sky[this.dark ? 'dark' : 'light'];
    if (!sky && !this._sky) return;
    if (this._sky) this._sky.dispose();
    this._sky = null;
    const bg = sky ? sky[1] : sc.theme.bg;
    if (sky) {
      // all round the viewer by direction (an equirectangular map: overhead at the top, the horizon across the middle),
      // so the horizon's color lies along the real horizon, where the fogged ground meets it without a line
      const c = document.createElement('canvas');
      c.width = 8; c.height = 256;
      const ctx = c.getContext('2d'), g = ctx.createLinearGradient(0, 0, 0, 256), hex = (v) => '#' + v.toString(16).padStart(6, '0');
      g.addColorStop(0, hex(sky[0]));
      g.addColorStop(0.3, hex(sky[0]));
      g.addColorStop(0.5, hex(sky[1]));
      g.addColorStop(1, hex(sky[1]));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 8, 256);
      this._sky = new THREE.CanvasTexture(c);
      this._sky.colorSpace = THREE.SRGBColorSpace;
      this._sky.mapping = THREE.EquirectangularReflectionMapping;
    }
    sc.scene.background = this._sky || new THREE.Color(bg);
    if (sc.scene.fog) sc.scene.fog.color.set(bg);
    this.surface.uniforms.uBg.value.set(bg);
  }

  buildEgo(ego) { this.surface.buildEgo(ego); }

  // Each frame, after the objects and the car have moved and before the render.
  update() {
    const def = BY_ID.get(this.sc.settings.groundStyle) || null;
    if (def !== this.active) this._show(def);
    if (!def) return;
    this.surface.update(def.surface, def.lines);
    this.built.get(def.id).update?.(this._frame());
  }

  _show(def) {
    const was = this.active;
    if (was) for (const o of this.built.get(was.id).objects) o.visible = false;
    if (def) {
      for (const o of this._build(def).objects) o.visible = true;
      this.surface.setLight(def.light);
    }
    if (!was !== !def) this.surface.attach(!!def);
    this.active = def;
    this._applySky();
  }

  _build(def) {
    let s = this.built.get(def.id);
    if (s) return s;
    const sc = this.sc, U = this.surface.uniforms, objects = [];
    const kit = {
      uniforms: U,
      sheet: (fragmentShader, uniforms) => makeSheet(U, fragmentShader, uniforms),
      add: (o, where = 'scene') => { o.visible = false; (where === 'world' ? sc.world : sc.scene).add(o); objects.push(o); return o; },
    };
    s = { ...def.create(kit), objects };
    s.setTheme?.(def.palette[this.dark ? 'dark' : 'light'], this.dark);
    this.built.set(def.id, s);
    return s;
  }

  // What a style may need each frame: the car and its heading in ground-fixed (scene.js world) coordinates, the
  // distance driven (m), the view's pixels per metre at 1 m from the camera, the scene's clock and this frame's step
  // (s), our speed (m/s) and the car we follow (surface.js lead, or null).
  _frame() {
    const sc = this.sc, p = sc.pose, f = this._f;
    f.dt = Math.max(0, Math.min(0.1, sc.clock - f.time));
    f.time = sc.clock;
    f.speed = sc.vehicle ? sc.vehicle.speed : 0;
    f.lead = this.surface.lead;
    f.carX = -p.y; f.carZ = -p.x;
    f.aheadX = -Math.sin(p.h); f.aheadZ = -Math.cos(p.h);
    f.odometer = sc.odometer;
    f.pxPerM = 0.5 * sc.renderer.getDrawingBufferSize(this._v2).y * sc.camera.projectionMatrix.elements[5];
    return f;
  }
}
