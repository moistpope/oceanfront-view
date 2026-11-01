// The nav app's next step laid on the map's roads (navroute.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planRoute, routeLine, streetKey, exitNumber, laneOffset, FAINT_M } from '../../navroute.js';
import { parseNav } from '../../infotainment.js';

const way = (id, name, pts, extra = {}) => ({ id, name, ref: '', className: 'residential', cls: 5, oneWay: false, fwd: 1, bwd: 1,
  centre: 0, laneW: 3.5, lanes: 2, singleTrack: false, turnsFwd: null, turnsBwd: null, roundabout: false, pts, ...extra });
const nav = (instruction, remaining, extra = {}) => {
  const side = /left/.test(instruction) ? 'left' : /right/.test(instruction) ? 'right' : null;
  const kind = /roundabout/.test(instruction) ? 'roundabout' : /continue/i.test(instruction) ? 'straight' : 'turn';
  const street = (/onto (.+)$/.exec(instruction) || [])[1] || '';
  return { maneuver: { kind, side }, street, instruction, remaining, half: 25, ...extra };
};
// High St runs east from the car (at 0,0 heading east); side roads leave it
const car = { x: 0, y: 0, h: 0 };
const at = (route, x, y, tol = 2) => route.pts.some(p => Math.hypot(p[0] - x, p[1] - y) < tol);

describe('navroute', () => {
  test('the street a step names, "The ..." ones too, but not "the fork"', () => {
    assert.equal(parseNav({ title: '200 yd', text: 'At the roundabout, take the 3rd exit onto The Mall' }).street, 'The Mall');
    assert.equal(parseNav({ title: '0.3 mi', text: 'Keep left at the fork' }).street, '');
    assert.equal(parseNav({ title: '50 m', text: 'Turn left at the traffic lights onto Horse Guards Avenue' }).street, 'Horse Guards Avenue');
  });

  test('streets and exits as the nav app writes them', () => {
    assert.equal(streetKey('High St.'), 'high street');
    assert.equal(exitNumber('At the roundabout, take the 2nd exit onto Station Rd'), 2);
    assert.equal(exitNumber('take the third exit'), 3);
  });

  test('to the named turn and round it, sure until the new road could be left, likely after', () => {
    const layer = { ways: [
      way(1, 'High Street', [[-50, 0], [0, 0], [200, 0], [400, 0], [600, 0]]),
      way(2, 'Mill Lane', [[200, 0], [200, -100]]),                    // a right turn at 200 m
      way(3, 'Station Road', [[400, 0], [400, -30], [400, -300], [400, -600]]),   // the right at 400 m
      way(4, 'Park Road', [[400, -30], [300, -30]]),                    // a junction 30 m down Station Road
    ] };
    const r = planRoute(layer, car, nav('Turn right onto Station Rd', 410), { wayId: 1 });
    assert.ok(r, 'a route');
    assert.ok(at(r, 400, 0) && at(r, 400, -30), 'to the turn and round it');
    assert.ok(!at(r, 200, -100), 'not down Mill Lane');
    assert.ok(Math.abs(r.sure - 430) < 3, `sure to Park Road's junction: ${r.sure}`);
    assert.ok(r.total > r.sure + FAINT_M - 10 && r.total < r.sure + FAINT_M + 300, `likely for ~${FAINT_M} m: ${r.total}`);
    // without the name, by the side, nearest the distance
    const r2 = planRoute(layer, car, nav('Turn right', 210), { wayId: 1 });
    assert.ok(at(r2, 200, -100) && !at(r2, 400, -30));
  });

  test('a turn onto a long road with nowhere else to go is sure all the way', () => {
    const layer = { ways: [
      way(1, 'High Street', [[-50, 0], [0, 0], [300, 0], [500, 0]]),
      way(2, 'Long Road', [[300, 0], [300, 150], [300, 900]]),
    ] };
    const r = planRoute(layer, car, nav('Turn left onto Long Road', 300), { wayId: 1 });
    assert.ok(Math.abs(r.sure - r.total) < 0.5 && r.total > 1100, `${r.sure} / ${r.total}`);
  });

  test('a roundabout: round to the nth exit', () => {
    const ring = way(10, '', [[100, 0], [120, 20], [100, 40], [80, 20], [100, 0]], { oneWay: true, roundabout: true, fwd: 1, bwd: 0, lanes: 1 });
    const layer = { ways: [
      way(1, 'A Road', [[-50, 0], [0, 0], [100, 0]]),
      ring,
      way(2, 'East Rd', [[120, 20], [300, 20]]),
      way(3, 'North Rd', [[100, 40], [100, 300]]),
      way(4, 'West Rd', [[80, 20], [-100, 20]]),
    ] };
    const r = planRoute(layer, car, nav('At the roundabout, take the 2nd exit onto North Rd', 100), { wayId: 1 });
    assert.ok(at(r, 100, 300) || at(r, 100, 200), 'out on North Rd');
    assert.ok(!at(r, 250, 20) && !at(r, -80, 20));
  });

  test('lanes: the kerb side by traffic, the turn lanes OSM gives', () => {
    const two = way(1, 'X', [[0, 0], [100, 0]], { fwd: 2, bwd: 2, lanes: 4, laneW: 3.5 });
    assert.equal(laneOffset(two, true, true, 'kerb'), 5.25);     // UK: the left lane, 1.5 lanes left of the centre
    assert.equal(laneOffset(two, true, false, 'kerb'), -5.25);   // the right lane
    assert.equal(laneOffset(two, true, true, 'right'), 1.75);
    const tagged = { ...two, turnsFwd: [['left'], ['left', 'through']] };   // left to right
    assert.equal(laneOffset(tagged, true, false, 'left'), -1.75);           // both may turn left: the left one
  });

  test('the drawn line: in its lane, rounded at the turn, as long as the route', () => {
    const layer = { ways: [
      way(1, 'High Street', [[-50, 0], [0, 0], [200, 0]]),
      way(2, 'Side Road', [[200, 0], [200, 300]]),
    ] };
    const r = planRoute(layer, car, nav('Turn left onto Side Road', 200), { wayId: 1, leftTraffic: true });
    const line = routeLine(r);
    assert.ok(line.pts.length > 4);
    assert.ok(Math.abs(line.pts[0][1] - 1.75) < 0.3, `in the left lane: ${line.pts[0]}`);
    assert.ok(Math.abs(line.total - r.total) < 15, `${line.total} vs ${r.total}`);
    const end = line.pts[line.pts.length - 1];
    assert.ok(Math.abs(end[0] - 198.25) < 0.5, `the left lane of Side Road going north: ${end}`);
  });

  // the drawn line never folds, steps sideways or kinks: each step goes forward and the heading turns gently
  const smoothness = (line) => {
    const P = line.pts;
    let maxTurn = 0, backwards = 0, maxStep = 0;
    for (let i = 1; i + 1 < P.length; i++) {
      const h1 = Math.atan2(P[i][1] - P[i - 1][1], P[i][0] - P[i - 1][0]), h2 = Math.atan2(P[i + 1][1] - P[i][1], P[i + 1][0] - P[i][0]);
      let d = Math.abs(h2 - h1); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > Math.PI / 2) backwards++;
      maxTurn = Math.max(maxTurn, d);
    }
    for (let i = 1; i < P.length; i++) maxStep = Math.max(maxStep, Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    return { maxTurnDeg: maxTurn * 180 / Math.PI, backwards, maxStep };
  };

  test('the drawn line is smooth: a left turn from the inside lane of a wide road, and a lane change', () => {
    // a wide road (2 lanes each way): the left turn's lane is 5.25 m left of the centreline, nearly the corner's radius
    const layer = { ways: [
      way(1, 'Whitehall', [[-50, 0], [0, 0], [120, 0], [300, 0]], { fwd: 2, bwd: 2, lanes: 4 }),
      way(2, 'Horse Guards Avenue', [[120, 0], [121, 4], [122, 60], [125, 200]]),
    ] };
    // the car in the right-hand lane of its side (1.75 m left): moves to the left lane before the turn
    const r = planRoute(layer, car, nav('Turn left onto Horse Guards Avenue', 120), { wayId: 1, leftTraffic: true, egoOffset: 1.75 });
    const line = routeLine(r), q = smoothness(line);
    assert.equal(q.backwards, 0, 'never doubles back');
    assert.ok(q.maxTurnDeg < 12, `no kinks: the sharpest step turns ${q.maxTurnDeg.toFixed(1)} deg`);
    assert.ok(q.maxStep < 3, `points close enough to bend smoothly: ${q.maxStep}`);
    assert.ok(Math.abs(line.pts[0][1] - 1.75) < 0.3, `starts in the car's lane: ${line.pts[0]}`);
    const before = line.pts.find(p => p[0] > 95 && p[0] < 100);
    assert.ok(before && Math.abs(before[1] - 5.25) < 0.4, `in the left lane before the turn: ${before}`);
    // no S on the new road: in its kerb lane (1.75 m left of its centreline, which runs from x 121 to 122 here) once past the curve
    for (const p of line.pts.filter(p => p[1] > 14 && p[1] < 58)) {
      const cx = 121 + (p[1] - 4) / 56;
      assert.ok(Math.abs(p[0] - (cx - 1.75)) < 0.35, `in Horse Guards Avenue's lane: ${p}`);
    }
    // the lane change is gradual: sideways no more than 1 m per 3 m travelled
    for (let i = 1; i < line.pts.length && line.pts[i][0] < 100; i++) {
      const a = line.pts[i - 1], b = line.pts[i];
      assert.ok(Math.abs(b[1] - a[1]) <= Math.abs(b[0] - a[0]) / 3 + 0.05, `a gentle lane change at ${a}`);
    }
  });

  test("the car's lane carries on along its road, onto the road's next OSM way too", () => {
    const layer = { ways: [
      way(1, 'Strand', [[-50, 0], [0, 0], [80, 0]], { fwd: 2, bwd: 2, lanes: 4 }),
      way(5, 'Strand', [[80, 0], [160, 3], [300, 3]], { fwd: 2, bwd: 2, lanes: 4 }),   // the next way of the same road
      way(2, 'Side Road', [[300, 3], [300, 200]]),
    ] };
    const r = planRoute(layer, car, nav('Turn left onto Side Road', 300), { wayId: 1, leftTraffic: true, egoOffset: 1.75 });
    const line = routeLine(r);
    const before = line.pts.filter(p => p[0] > 2 && p[0] < 200);
    // still the inner lane (1.75 m left of the centreline), not moved to the kerb's at the way's end
    for (const p of before) {
      const cy = p[0] < 80 ? 0 : p[0] < 160 ? (p[0] - 80) * 3 / 80 : 3;
      assert.ok(Math.abs(p[1] - cy - 1.75) < 0.4, `kept the car's lane: ${p}`);
    }
    assert.equal(smoothness(line).backwards, 0);
  });

  test('the drawn line is smooth round a roundabout and out of it', () => {
    const ring = way(10, '', [[100, 0], [114, 6], [120, 20], [114, 34], [100, 40], [86, 34], [80, 20], [86, 6], [100, 0]], { oneWay: true, roundabout: true, fwd: 2, bwd: 0, lanes: 2 });
    const layer = { ways: [
      way(1, 'A Road', [[-50, 0], [0, 0], [100, 0]], { fwd: 2, bwd: 2, lanes: 4 }),
      ring,
      way(2, 'East Rd', [[120, 20], [300, 20]]),
      way(3, 'North Rd', [[100, 40], [100, 300]]),
    ] };
    const r = planRoute(layer, car, nav('At the roundabout, take the 2nd exit onto North Rd', 100), { wayId: 1, leftTraffic: false, egoOffset: -1.75 });
    const q = smoothness(routeLine(r));
    assert.equal(q.backwards, 0);
    assert.ok(q.maxTurnDeg < 15, `no kinks: ${q.maxTurnDeg.toFixed(1)} deg`);
  });

  test('past the turn, on its street: that road on, not back down its other carriageway', () => {
    // the car has turned left onto Horse Guards Avenue (one-way east), whose other carriageway runs back west from
    // the junction 30 m on, where Gardens Road leaves
    const layer = { ways: [
      way(1, 'Horse Guards Avenue', [[-20, 0], [0, 0], [30, 0]], { oneWay: true, fwd: 1, bwd: 0 }),
      way(2, 'Horse Guards Avenue', [[30, 0], [60, 0], [300, 0]]),
      way(3, 'Horse Guards Avenue', [[30, 0], [0, -6], [-20, -6]], { oneWay: true, fwd: 1, bwd: 0 }),
      way(4, 'Gardens Road', [[60, 0], [60, -200]]),
    ] };
    const r = planRoute(layer, car, nav('Turn left onto Horse Guards Avenue', -15), { wayId: 1, leftTraffic: true });
    assert.ok(r, 'a route');
    assert.ok(!at(r, -20, -6), 'not back down the other carriageway');
    assert.ok(Math.abs(r.sure - 60) < 3, `sure to Gardens Road: ${r.sure}`);
    assert.ok(r.total > 200 && at(r, 300, 0, 60), `likely on: ${r.total}`);
    // before the turn, a named way back the way the car came isn't the turn either
    assert.equal(planRoute(layer, car, nav('Turn left onto Horse Guards Avenue', 30), { wayId: 1 }).pts.some(p => p[1] < -3), false);
    // well past the turn and not on its street: missed
    const other = { ways: [way(5, 'Other Road', [[-20, 0], [0, 0], [300, 0]])] };
    assert.equal(planRoute(other, car, nav('Turn left onto Horse Guards Avenue', -120)), null);
  });

  test('ways from different tiles meet at points a little apart: still a junction', () => {
    const layer = { ways: [
      way(1, 'B4077', [[-50, 0], [0, 0], [200, 0], [400, 0]]),
      way(2, 'Kineton Hill', [[200.4, 0.5], [200, -300]]),   // its end 0.6 m off the B road's node
    ] };
    const r = planRoute(layer, car, nav('Turn right onto Kineton Hill', 200), { wayId: 1 });
    assert.ok(at(r, 200, -300, 5), 'down Kineton Hill');
  });

  test('no road under the car: no route', () => {
    assert.equal(planRoute({ ways: [way(1, 'A', [[0, 100], [100, 100]])] }, car, null), null);
  });
});
