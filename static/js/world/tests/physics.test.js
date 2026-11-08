// The physical models behind the world model's tracks (static/js/world/physics.js): what a road user can't do,
// and that the tracker and the drawn bodies hold to it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PhysFilter, SimBody, LIMITS, propagate, separate, overlap, centerOf, faceOf, massOf, wrap } from '../physics.js';
import { WorldModel, NO_CALIBRATION, adasMeasurement } from '../world_model.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);
const I2 = (s) => [[s * s, 0], [0, s * s]];

describe('the motion model', () => {
  test('a car turns only by driving: standing on full lock, its heading stays put', () => {
    let X = [0, 0, 0.3, 0, 0, LIMITS.car.kMax];
    for (let i = 0; i < 20; i++) X = propagate(X, 0.1);
    near(X[2], 0.3, 1e-9);
    // rolling 5 m on the same lock turns it by 5 m of its curvature
    X = [0, 0, 0, 5, 0, 0.1];
    X = propagate(X, 1.0);
    near(X[2], 0.5, 1e-9);
  });

  test('braking stops a car, it does not reverse it', () => {
    let X = [0, 0, 0, 2, -8, 0];
    X = propagate(X, 1.0);
    assert.equal(X[3], 0);
    near(X[0], 0.25, 1e-9, 'it stops after v^2/2a');
  });

  test('its velocity is always along its heading: it cannot slide sideways', () => {
    const f = new PhysFilter(0, 0, I2(0.5), 0.7, 0.1, 10, 1, 'car');
    const [vx, vy] = f.vel;
    near(Math.atan2(vy, vx), 0.7, 1e-12);
    // a position that steps sideways moves it; its velocity still points where it faces
    f.updatePos([0, 1.5], I2(0.3));
    const [ux, uy] = f.vel;
    near(wrap(Math.atan2(uy, ux) - f.X[2]), 0, 1e-12);
  });

  test('held to its class: tightest turn, tyre grip, power and braking', () => {
    const f = new PhysFilter(0, 0, I2(0.5), 0, 0.1, 30, 1, 'car');
    f.X[5] = 0.5; f.X[4] = 8; f.limit();
    near(f.X[5], LIMITS.car.latMax / 900, 1e-9, 'v^2 k within grip at 30 m/s');
    near(f.X[4], LIMITS.car.power / (f.mass * 30), 1e-9, 'acceleration within power at 30 m/s');
    f.X[4] = -20; f.limit();
    near(f.X[4], -LIMITS.car.brake, 1e-9);
    f.X[3] = 2; f.X[5] = 1; f.limit();
    near(f.X[5], LIMITS.car.kMax, 1e-9, 'slow: the tightest circle');
    const truck = new PhysFilter(0, 0, I2(0.5), 0, 0.1, 25, 1, 'truck');
    truck.X[4] = 4; truck.limit();
    assert.ok(truck.X[4] < 1.5, `a loaded truck pulls slowly: ${truck.X[4]}`);
  });

  test('mass grows with the footprint a class is seen at', () => {
    assert.ok(massOf('car', [2.0, 5.2, 1.7]) > massOf('car', [1.7, 4.0, 1.5]));
    assert.equal(massOf('truck', null), LIMITS.truck.mass);
  });
});

describe('the filter', () => {
  test('a car first taken to face our way turns round once it is seen coming at us', () => {
    const f = new PhysFilter(60, 0, I2(0.5), 0, 1.2, 10, 8, 'car');
    for (let i = 1; i <= 25; i++) {
      f.predict(0.04);
      f.updatePos([60 - 15 * i * 0.04, 0], I2(0.5));
      f.settle();
    }
    near(Math.abs(wrap(f.X[2])), Math.PI, 0.25, 'heading');
    near(f.X[3], 15, 2.5, 'speed forward');
    assert.ok(f.flips >= 1);
  });

  test('positions that jump about do not make a standing car spin', () => {
    const f = new PhysFilter(20, 5, I2(0.5), 0, 0.1, 0, 0.5, 'car');
    let s = 1;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
    for (let i = 0; i < 100; i++) { f.predict(0.04); f.updatePos([20 + rnd(), 5 + rnd()], I2(0.5)); }
    assert.ok(Math.abs(wrap(f.X[2])) < 0.35, `heading ${f.X[2]}`);
    assert.ok(Math.abs(f.X[3]) < 1.5, `speed ${f.X[3]}`);
  });
});

describe('the drawn body', () => {
  test('a lane change: it steers across within grip, pointing where it goes', () => {
    const f = new PhysFilter(0, 0, I2(0.3), 0, 0.05, 20, 0.5, 'car');
    const b = new SimBody(f);
    let prevV = b.X[3];
    for (let i = 0; i < 100; i++) {
      const T = [20 * (i + 1) * 0.05, 3.5, 0, 20, 0, 0];   // the estimate one lane over
      f.X = T.slice();
      b.follow(f, T, 0.05);
      assert.ok(Math.abs(b.X[3] * b.X[3] * b.X[5]) <= LIMITS.car.latMax + 1e-9, 'within grip');
      assert.ok(Math.abs(b.X[3] - prevV) / 0.05 <= LIMITS.car.brake + 1e-9, 'within braking / power');
      prevV = b.X[3];
    }
    near(b.X[1], 3.5, 0.3, 'it got there');
    near(b.X[2], 0, 0.05, 'straightened out');
  });

  test('a standing body turns toward a newly known heading gently, and stays where it stands', () => {
    const f = new PhysFilter(0, 0, I2(0.3), 0, 0.05, 0, 0.3, 'car');
    const b = new SimBody(f);
    const T = [0, 0, Math.PI / 2, 0, 0, 0];
    let prev = b.X[2];
    for (let i = 0; i < 20; i++) {   // 1 s
      b.follow(f, T, 0.05);
      assert.ok(Math.abs(b.X[2] - prev) <= 25 * Math.PI / 180 * 0.05 + 1e-9, 'no faster than 25 deg/s');
      prev = b.X[2];
    }
    near(b.X[2], 25 * Math.PI / 180, 1e-6, 'a second in');
    assert.equal(b.X[0], 0); assert.equal(b.X[1], 0);
    for (let i = 0; i < 80; i++) b.follow(f, T, 0.05);
    near(b.X[2], Math.PI / 2, 0.06, 'there in the end');
  });

  test('a slow body goes to its estimate, not off along a wrong heading', () => {
    const f = new PhysFilter(0, 0, I2(0.3), -0.6, 0.05, 0, 0.3, 'car');
    const b = new SimBody(f);   // facing 35 deg right
    for (let i = 0; i < 60; i++) b.follow(f, [0.05 * i, 0, 0, 1.0, 0, 0], 0.05);   // the estimate creeps straight ahead
    near(b.X[1], 0, 0.35, 'still in its lane');
  });
});

describe('no two in one place', () => {
  test('overlapping cars are pushed apart, the less certain moving more', () => {
    const a = new PhysFilter(0, 0, I2(0.2), 0, 0.1, 10, 1, 'car');
    const c = new PhysFilter(0.5, 1.2, I2(1.0), 0, 0.1, 10, 1, 'car');
    c.X[3] = 4;   // moving differently, so not one object seen twice
    separate([{ f: a, id: 1 }, { f: c, id: 2 }]);
    assert.equal(overlap([a.X[0], a.X[1], 1.85, 4.6, 0], [c.X[0], c.X[1], 1.85, 4.6, 0]), null);
    assert.ok(Math.abs(c.X[1] - 1.2) > Math.abs(a.X[1]), 'the uncertain one moved more');
  });

  test('none in our car', () => {
    const a = new PhysFilter(1.0, 1.0, I2(0.5), 0, 0.1, 10, 1, 'car');
    const ego = [0, 0, 1.98, 4.775, 0];
    separate([{ f: a, id: 1 }], ego);
    assert.equal(overlap([a.X[0], a.X[1], 1.85, 4.6, 0], ego), null);
  });

  test('two copies of one car are reported as the same object', () => {
    const a = new PhysFilter(10, 0, I2(0.5), 0, 0.1, 10, 1, 'car');
    const c = new PhysFilter(10.4, 0.2, I2(0.5), 0, 0.1, 10.5, 1, 'car');
    assert.deepEqual(separate([{ f: a, id: 1 }, { f: c, id: 2 }]), [[1, 2]]);
  });

  test('the world model keeps two cars side by side apart even when their measurements overlap', () => {
    const m = new WorldModel(NO_CALIBRATION);
    let out = [];
    for (let i = 0; i < 40; i++) {
      const t = i * 0.05;
      m.odo.update(t, 0, 0);
      m.add([adasMeasurement(t, { id: 1, x: 15, y: 0.3, cls: 'car', w: 1.9, l: 4.6, h: 1.5 }, NO_CALIBRATION),
        adasMeasurement(t, { id: 2, x: 16, y: 1.9, cls: 'car', w: 1.9, l: 4.6, h: 1.5 }, NO_CALIBRATION)]);
      out = m.step(t + 0.3);
    }
    if (out.length === 2) {
      const box = (o) => [o.cx, o.cy, o.fw, o.fl, o.heading * Math.PI / 180];
      assert.equal(overlap(box(out[0]), box(out[1])), null);
    } else assert.equal(out.length, 1, 'or merged into one');
  });
});

describe('line of sight', () => {
  test('center and near face are inverses', () => {
    for (const psi of [0, 0.7, Math.PI / 2, 2.5]) {
      const c = centerOf(20, 3, 0, 0, 1.9, 4.6, psi);
      const f = faceOf(c[0], c[1], 0, 0, 1.9, 4.6, psi);
      near(f[0], 20, 1e-9); near(f[1], 3, 1e-9);
    }
    // end-on, the center is half a length beyond the face; side-on, half a width
    near(centerOf(20, 0, 0, 0, 1.9, 4.6, 0)[0], 22.3, 1e-9);
    near(centerOf(20, 0, 0, 0, 1.9, 4.6, Math.PI / 2)[0], 20.95, 1e-9);
  });
});
