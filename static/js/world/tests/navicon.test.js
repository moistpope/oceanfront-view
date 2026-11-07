// The turn read from the nav app's picture of it (navicon.js), and the route found from it (navroute.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { iconManeuver } from '../../navicon.js';
import { planRoute } from '../../navroute.js';
import { parseNav } from '../../infotainment.js';

const S = 64;
// a white picture on a clear ground, drawn with thick strokes, arrow heads and rings
const canvas = () => new Uint8ClampedArray(S * S * 4);
const dot = (img, x, y) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < S && y < S) img.fill(255, 4 * (y * S + x), 4 * (y * S + x) + 4); };
const stroke = (img, [x0, y0], [x1, y1], r = 3) => {
  const L = Math.hypot(x1 - x0, y1 - y0);
  for (let t = 0; t <= L; t += 0.5) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++)
    if (dx * dx + dy * dy <= r * r) dot(img, x0 + (x1 - x0) * t / L + dx, y0 + (y1 - y0) * t / L + dy);
};
const head = (img, from, [x, y], size = 9) => {   // a filled triangle at (x, y) pointing away from `from`
  const L = Math.hypot(x - from[0], y - from[1]), ux = (x - from[0]) / L, uy = (y - from[1]) / L;
  for (let a = 0; a <= size; a += 0.5) { const w = size - a; stroke(img, [x - ux * (size - a) + uy * w, y - uy * (size - a) - ux * w], [x - ux * (size - a) - uy * w, y - uy * (size - a) + ux * w], 1); }
};
const arrow = (...pts) => {
  const img = canvas();
  for (let i = 1; i < pts.length; i++) stroke(img, pts[i - 1], pts[i]);
  head(img, pts[pts.length - 2], pts[pts.length - 1]);
  return img;
};
const roundaboutIcon = (deg) => {   // the ring, the way in from the bottom, the exit leaving at deg (+ right of straight on)
  const img = canvas(), c = [32, 30], R = 12;
  for (let a = 0; a < 360; a += 2) stroke(img, [c[0] + R * Math.sin(a * Math.PI / 180), c[1] - R * Math.cos(a * Math.PI / 180)],
    [c[0] + R * Math.sin((a + 2) * Math.PI / 180), c[1] - R * Math.cos((a + 2) * Math.PI / 180)], 2);
  stroke(img, [32, 62], [32, 30 + R]);
  const r = deg * Math.PI / 180, from = [c[0] + R * Math.sin(r), c[1] - R * Math.cos(r)], to = [c[0] + 28 * Math.sin(r), c[1] - 28 * Math.cos(r)];
  stroke(img, from, to);
  head(img, from, to, 6);
  return img;
};

describe('the turn in the nav app\'s picture', () => {
  test('turns, bends, straight on and U-turns', () => {
    const m = (img) => iconManeuver(img, S, S);
    assert.deepEqual([m(arrow([30, 62], [30, 30], [58, 30])).kind, m(arrow([30, 62], [30, 30], [58, 30])).side], ['turn', 'right']);
    assert.deepEqual([m(arrow([34, 62], [34, 30], [6, 30])).kind, m(arrow([34, 62], [34, 30], [6, 30])).side], ['turn', 'left']);
    assert.equal(m(arrow([32, 62], [32, 6])).kind, 'straight');
    const slight = m(arrow([28, 62], [28, 36], [50, 8]));
    assert.deepEqual([slight.kind, slight.side], ['slight', 'right']);
    const sharp = m(arrow([20, 62], [20, 14], [54, 46]));
    assert.deepEqual([sharp.kind, sharp.side], ['sharp', 'right']);
    const u = m(arrow([48, 62], [48, 16], [16, 16], [16, 50]));
    assert.equal(u.kind, 'uturn');
    assert.equal(m(canvas()), null);
  });

  test('a roundabout, and which way its exit leaves', () => {
    for (const [deg, side] of [[0, null], [90, 'right'], [-90, 'left'], [45, 'right']]) {
      const r = iconManeuver(roundaboutIcon(deg), S, S);
      assert.equal(r.kind, 'roundabout', String(deg));
      assert.equal(r.side, side, String(deg));
      assert.ok(Math.abs(r.angle - deg) < 20, `${deg}: ${r.angle}`);
    }
  });
});

const way = (id, name, pts, extra = {}) => ({ id, name, ref: '', className: 'residential', cls: 5, oneWay: false, fwd: 1, bwd: 1,
  centre: 0, laneW: 3.5, lanes: 2, singleTrack: false, turnsFwd: null, turnsBwd: null, roundabout: false, pts, ...extra });
const car = { x: 0, y: 0, h: 0 };
const at = (route, x, y, tol = 2) => route.pts.some(p => Math.hypot(p[0] - x, p[1] - y) < tol);

describe('a step with only the road in words', () => {
  test('"200 m", "Side Road": the road is the street', () => {
    const p = parseNav({ title: '200 m', text: 'Side Road', subText: '12 min · 5 km · 12:30 ETA' });
    assert.equal(p.street, 'Side Road');
    assert.equal(p.maneuver, null);
    assert.equal(p.dist.m, 200);
  });

  test('the turn onto the road named, with or without the picture read', () => {
    const layer = { ways: [
      way(1, 'High Street', [[-50, 0], [0, 0], [200, 0], [400, 0]]),
      way(2, 'Side Road', [[200, 0], [200, 300]]),
      way(3, 'Other Road', [[200, 0], [200, -300]]),
    ] };
    const plain = planRoute(layer, car, { maneuver: null, street: 'Side Road', instruction: 'Side Road', remaining: 200, half: 5 }, { wayId: 1 });
    assert.ok(at(plain, 200, 300), 'up Side Road');
    // no name to go by: the picture's side
    const pic = planRoute(layer, car, { maneuver: { kind: 'turn', side: 'right', angle: 90, fromIcon: true }, street: '', instruction: '', remaining: 200, half: 5 }, { wayId: 1 });
    assert.ok(at(pic, 200, -300), 'right, down Other Road');
  });

  test('a roundabout\'s exit by the picture\'s angle', () => {
    // a ring round (100, 0), anticlockwise (traffic on the right), met at its west side heading east
    const ring = way(10, '', [[80, 0], [100, -20], [120, 0], [100, 20], [80, 0]], { oneWay: true, roundabout: true, fwd: 1, bwd: 0, lanes: 1 });
    const layer = { ways: [
      way(1, 'A Road', [[-50, 0], [0, 0], [80, 0]]), ring,
      way(2, 'South Rd', [[100, -20], [100, -300]]), way(3, 'East Rd', [[120, 0], [300, 0]]), way(4, 'North Rd', [[100, 20], [100, 300]]),
    ] };
    const go = (angle) => planRoute(layer, car, { maneuver: { kind: 'roundabout', side: null, angle, fromIcon: true }, street: '', instruction: '', remaining: 80, half: 5 }, { wayId: 1 });
    assert.ok(at(go(0), 300, 0), 'straight on: East Rd');
    assert.ok(at(go(-90), 100, 300) && !at(go(-90), 300, 0), 'left: North Rd');
    assert.ok(at(go(90), 100, -300) && !at(go(90), 300, 0), 'right: South Rd');
  });
});
