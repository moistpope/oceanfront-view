// The ground styles' contract (static/js/groundstyle/index.js): every style is a self-contained module over the one
// surface model, and its shaders build on the shared GLSL without redeclaring any of it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// the page loads three.js from /vendor/ (serve.py); here it's third_party/three
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec.endsWith('vendor/three.module.min.js')) return { url: ${JSON.stringify(new URL('../../../../third_party/three/three.module.min.js', import.meta.url).href)}, shortCircuit: true };
  return next(spec, ctx);
}`));
const { STYLES, GROUND_STYLES } = await import('../../groundstyle/index.js');
const { DEFAULT_PROFILE } = await import('../../groundstyle/surface.js');
const { makeSheet } = await import('../../groundstyle/sheet.js');

// a style built without a renderer: its objects collected, its materials' shaders to read
function build(style) {
  const objects = [];
  const kit = { uniforms: {}, sheet: (fs, u) => makeSheet({}, fs, u), add: (o, where = 'scene') => { objects.push({ o, where }); return o; } };
  return { inst: style.create(kit), objects };
}
// the names a shader declares more than once (GLSL has no redeclaration: the shader would fail to compile)
function redeclared(src) {
  const names = [];
  for (const m of src.matchAll(/^\s*(?:uniform|varying|attribute)\s+\w+\s+([^;]+);/gm)) {
    for (const n of m[1].split(',')) names.push(n.trim().replace(/\[.*$/, ''));
  }
  for (const m of src.matchAll(/^\s*(?:float|int|bool|void|vec[234]|mat[34])\s+(\w+)\s*\([^;{]*\)\s*\{/gm)) names.push(m[1] + '()');
  return names.filter((n, i) => names.indexOf(n) !== i);
}

describe('ground styles', () => {
  test('the settings list perforated (the default) first, each style once, and the flat ground', () => {
    assert.equal(GROUND_STYLES[0].id, 'perforated');
    const ids = GROUND_STYLES.map((s) => s.id);
    assert.deepEqual(ids, [...new Set(ids)]);
    assert.ok(ids.includes('flat'));
    for (const s of GROUND_STYLES) assert.ok(s.label && s.blurb, s.id);
  });

  for (const style of STYLES) {
    describe(style.id, () => {
      test('declares only the profile the surface model knows', () => {
        assert.deepEqual(Object.keys(style.surface).sort(), Object.keys(DEFAULT_PROFILE).sort());
        assert.equal(style.light.look.length, 4);
        assert.equal(style.light.key.length, 3);
      });
      test('has the same colors by day and by night', () => {
        assert.deepEqual(Object.keys(style.palette.light).sort(), Object.keys(style.palette.dark).sort());
      });
      test('builds its objects, fixed to the car or the ground, and takes a theme and a frame', () => {
        const { inst, objects } = build(style);
        assert.ok(objects.length > 0);
        for (const { where } of objects) assert.ok(where === 'scene' || where === 'world');
        inst.setTheme?.(style.palette.dark, true);
        inst.update?.({ carX: 10, carZ: -20, aheadX: 0, aheadZ: -1, odometer: 123, pxPerM: 900 });
      });
      test('its shaders redeclare nothing', () => {
        for (const { o } of build(style).objects) {
          for (const src of [o.material.vertexShader, o.material.fragmentShader]) assert.deepEqual(redeclared(src), []);
        }
      });
    });
  }
});
