// Ordnance Survey's widths on the OSM ways (osroads.js, mapdata.js), over a made-up patch of London.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MapData, keyOf, FEAT_DEG } from '../mapdata.js';
import { tileFor } from '../osmtile.js';
import { parseLinks, LinkIndex, wayWidth } from '../osroads.js';
import { laneLayout, widthOf } from '../roaddetail.js';

const LAT = 51.512, LON = -0.123;
const M_LAT = 1 / 111320, M_LON = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
/** lat/lon of a point x m east, y m north of (LAT, LON). */
const at = (x, y) => [LAT + y * M_LAT, LON + x * M_LON];

function way(id, pts, extra = {}) {
  const nodes = Float64Array.from(pts.flatMap(([x, y]) => at(x, y)));
  const lats = pts.map(([x, y]) => at(x, y)[0]), lons = pts.map(([x, y]) => at(x, y)[1]);
  return { id, name: '', ref: '', cls: 5, className: 'residential', lanes: 0, oneWay: false, maxSpeed: 0,
    minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons), nodes, ...extra };
}
/** A link as the server sends it: [avg, min, dir, kind, lon0, lat0, ...]. */
function link(w, pts, kind = 'SINGLE') {
  return [w, w, 0, kind, ...pts.flatMap(([x, y]) => { const [la, lo] = at(x, y); return [lo, la]; })];
}

describe('osroads', () => {
  test('parseLinks turns the compact links into lat/lon points', () => {
    const [l] = parseLinks({ links: [link(6.4, [[0, 0], [100, 0]])] });
    assert.equal(l.w, 6.4);
    assert.equal(l.pts.length, 4);
    assert.ok(Math.abs(l.pts[0] - LAT) < 1e-9 && Math.abs(l.pts[1] - LON) < 1e-9);
  });

  test('a way along a link takes its width; a crossing way and a far one don\'t', () => {
    const idx = new LinkIndex(LAT, LON);
    idx.add(parseLinks({ links: [link(5.2, [[-200, 1.5], [0, 2], [200, 1.5]]), link(7.0, [[0, -200], [0, 200]], 'SINGLE')] }));
    assert.equal(wayWidth(way(1, [[-150, 0], [150, 0]]).nodes, idx), 5.2);
    assert.equal(wayWidth(way(2, [[0, -150], [0, 150]]).nodes, idx), 7.0);
    assert.equal(wayWidth(way(3, [[-150, 30], [150, 30]]).nodes, idx), null);           // 30 m off
    assert.equal(wayWidth(way(4, [[-150, -150], [150, 150]]).nodes, idx), null);        // diagonal across both
  });

  test('a dual carriageway\'s halves each take their own', () => {
    const idx = new LinkIndex(LAT, LON);
    idx.add(parseLinks({ links: [link(7.3, [[-300, 6], [300, 6]], 'DUAL'), link(10.1, [[300, -6], [-300, -6]], 'DUAL')] }));
    assert.equal(wayWidth(way(1, [[-250, 6.5], [250, 6.5]], { oneWay: true }).nodes, idx), 7.3);
    assert.equal(wayWidth(way(2, [[250, -5.5], [-250, -5.5]], { oneWay: true }).nodes, idx), 10.1);
  });

  test('samples outside loaded cells neither match nor count against', () => {
    const idx = new LinkIndex(LAT, LON);
    idx.add(parseLinks({ links: [link(6, [[-200, 0], [0, 0]])] }));
    const w = way(1, [[-150, 0], [150, 0]]);
    assert.equal(wayWidth(w.nodes, idx), null);                                          // half matched: not enough
    assert.equal(wayWidth(w.nodes, idx, (la, lo) => lo < LON), 6);                       // the other half isn't loaded
  });

  test('MapData hangs the width on the ways, laneLayout uses it, turning it off takes it away', () => {
    const md = new MapData(async () => null);
    md.setOrigin({ lat: LAT, lon: LON, seq: 1 });
    const t = tileFor(LAT, LON);
    const narrow = way(1, [[-150, 0], [150, 0]]), wide = way(2, [[0, -150], [0, 150]]);
    md.addTile(keyOf(t), { minLat: t.tLat, minLon: t.tLon, maxLat: t.tLat + 0.25, maxLon: t.tLon + 0.25, ways: [narrow, wide] });
    md.setOs(async () => null);
    const v = md.version;
    md.addOsCell(Math.floor(LAT / FEAT_DEG), Math.floor(LON / FEAT_DEG), [link(5.2, [[-200, 0], [200, 0]]), link(9.0, [[0, -200], [0, 200]])]);
    assert.ok(md.version > v);
    assert.equal(narrow.osWidth, 5.2);
    assert.equal(widthOf(narrow), 5.2);
    assert.equal(laneLayout(narrow).laneW, 2.6);   // two lanes of a 5.2 m road: narrower than OSM's widths may make them
    assert.equal(laneLayout(wide).laneW, 4.5);
    // OSM's own width wins
    narrow.detail = { width: 6, fwd: null, bwd: null, both: 0 };
    assert.equal(widthOf(narrow), 6);
    md.setOs(null);
    assert.equal(narrow.osWidth, null);
    assert.equal(laneLayout(wide).laneW, 3.6);
  });
});

describe('single-track roads', () => {
  test('one shared lane, the car in the middle of it', async () => {
    const { laneCenters } = await import('../../mapsurface.js');
    const lane1 = { lanes: 1, oneWay: false, detail: null };
    const L = laneLayout(lane1, 1);
    assert.deepEqual([L.ours, L.theirs, L.centre, L.lanes], [1, 0, 0, 1]);
    for (const left of [true, false]) assert.deepEqual(laneCenters(L.lanes, false, L.laneW, left, L), [0]);
    // a narrow Ordnance Survey width with no OSM lane count says the same, at its width
    const narrow = { lanes: 0, oneWay: false, detail: null, osWidth: 3.0 };
    const N = laneLayout(narrow, 1);
    assert.deepEqual([N.lanes, N.laneW], [1, 3.0]);
    // a wider one stays two lanes
    assert.equal(laneLayout({ lanes: 0, oneWay: false, detail: null, osWidth: 5.5 }, 1).lanes, 2);
  });
});
