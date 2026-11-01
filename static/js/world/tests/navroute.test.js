// The nav app's next step laid on the map's roads (navroute.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planRoute, routeLine, streetKey, exitNumber, laneOffset, FAINT_M } from '../../navroute.js';

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

  test('no road under the car: no route', () => {
    assert.equal(planRoute({ ways: [way(1, 'A', [[0, 100], [100, 100]])] }, car, null), null);
  });
});
