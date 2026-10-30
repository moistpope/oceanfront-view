// The camera view's arithmetic (roadcam_geom.js): frames off the comma's /video socket, the codec string, the plain
// views' fit and projection, and the comma 4 screen's framing, projection, colours and torque bar, checked against its own code (fixtures/mici_golden.json
// is from sunnypilot selfdrive/ui/mici/onroad, run in Python).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BounceFilter, FRAME_HEADER_BYTES, Filter, accelColor, arcBarPts, avcCodec, blendColors, fitStream, interp, leadChevron,
  lengthIdx, lineRibbon, miciFrame, miciPolygon, modelFor, nalUnits, parseFrame, pathDistance, projectRaw, projector,
} from '../../roadcam_geom.js';

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/mici_golden.json', import.meta.url)));

// What webhud sends for a calibrated comma 4 road camera at rpy 0, 1280x720 (sunnypilot webhud/video.py)
const K = [[1087.14, 0, 640], [0, 1080.79, 360], [0, 0, 1]];
const M = [[0, 1087.14, 0], [0, 0, 1080.79], [1, 0, 0]].map((row, r) => row.map((_, c) => {
  // K . view_from_device: view x = device y, view y = device z, view z = device x
  const view = [[0, 1, 0], [0, 0, 1], [1, 0, 0]];
  return K[r][0] * view[0][c] + K[r][1] * view[1][c] + K[r][2] * view[2][c];
}));

function frameBuffer({ key = true, camera = 0, frameId = 0, ts = 0n, payload = [] }) {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + payload.length);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint8(1, key ? 1 : 0);
  v.setUint16(2, camera, true);
  v.setUint32(4, frameId, true);
  v.setBigUint64(8, ts, true);
  new Uint8Array(buf, FRAME_HEADER_BYTES).set(payload);
  return buf;
}

const SPS_PPS_IDR = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 1, 0x65, 0x88];

describe('roadcam frames', () => {
  test('the header and the access unit come apart', () => {
    const f = parseFrame(frameBuffer({ key: true, camera: 1, frameId: 1234, ts: 98765432101n, payload: SPS_PPS_IDR }));
    assert.equal(f.key, true);
    assert.equal(f.camera, 'wide');
    assert.equal(f.frameId, 1234);
    assert.equal(f.tsNs, 98765432101);
    assert.deepEqual([...f.data], SPS_PPS_IDR);
    assert.equal(parseFrame(new ArrayBuffer(4)), null);
  });

  test('NAL units and the codec string from the SPS', () => {
    const data = Uint8Array.from(SPS_PPS_IDR);
    assert.deepEqual(nalUnits(data).map(([t]) => t), [7, 8, 5]);
    assert.equal(avcCodec(data), 'avc1.64001F');
    assert.equal(avcCodec(Uint8Array.from([0, 0, 1, 0x65, 0x88])), null);   // a delta frame has none
  });
});

describe('roadcam projection', () => {
  test('straight ahead is the principal point, and the road ahead is below it', () => {
    const [u, v] = projectRaw(M, 1000, 0, 0);
    assert.ok(Math.abs(u - 640) < 1e-6 && Math.abs(v - 360) < 1e-6);
    const [u2, v2] = projectRaw(M, 20, 0, 1.22);
    assert.equal(u2, 640);
    assert.ok(v2 > 400);
    assert.equal(projectRaw(M, -5, 0, 0), null);   // behind the camera
  });

  test('the stream covers the view, centred on the vanishing point as far as it can', () => {
    const fit = fitStream(1280, 720, 1920, 720, M, 1);
    assert.equal(fit.scale, 1.5);
    assert.equal(fit.tx, 0);
    assert.ok(fit.ty <= 0 && fit.ty >= 720 - 1.5 * 720);
    const p = projector(M, fit)(1000, 0, 0);
    assert.ok(Math.abs(p[0] - 960) < 1e-6);
  });

  test('a line becomes a ribbon out to the draw distance', () => {
    const line = [[0, 0, 1.2], [10, 0, 1.2], [20, 0, 1.2], [40, 0, 1.2]];
    const proj = projector(M, { scale: 1, tx: 0, ty: 0 });
    const poly = lineRibbon(line, 0.5, 0, 15, proj);
    // 10 and 15 (interpolated) each side; x = 0 is in the camera's own plane and can't be drawn
    assert.equal(poly.length, 4);
    assert.ok(poly[0][0] < 640 && poly[3][0] > 640);              // left edge, then the right edge back
    assert.ok(Math.abs(poly[1][1] - (360 + 1080.79 * 1.2 / 15)) < 1e-6);
    assert.deepEqual(lineRibbon([], 0.5, 0, 15, proj), []);
  });

  test('the path stops short of the lead', () => {
    const path = [[0, 0, 0], [50, 0, 0], [150, 0, 0]];
    assert.equal(pathDistance(path, null), 100);
    assert.equal(pathDistance(path, { d: 20 }), 30);               // 2 x 20 - min(14, 10)
    assert.equal(pathDistance([[0, 0, 0], [5, 0, 0]], null), 10);
  });

  test('the lead chevron fills as the lead gets close', () => {
    const far = leadChevron({ d: 60, v: 0 }, [500, 300], 1280, 720);
    const near = leadChevron({ d: 10, v: -5 }, [500, 300], 1280, 720);
    assert.equal(far.alpha, 0);
    assert.equal(near.alpha, 1);
    assert.equal(near.chevron[1][0], 500);
  });

  test('experimental colours: green speeding up, red slowing, fading up the path', () => {
    assert.match(accelColor(2, 0.2), /^hsla\(120,/);
    assert.match(accelColor(-2, 0.2), /^hsla\(0,/);
    assert.match(accelColor(0, 0.9), /, 0\.000\)$/);
  });

  test('the comma 4 frames its camera the way its own screen does, zooming in with speed', () => {
    for (const c of GOLDEN.cases) {
      const fr = miciFrame(GOLDEN.K, GOLDEN.M, 476, 240, false, c.vEgo);
      assert.ok(Math.abs(fr.zoom - c.zoom) < 1e-9 && Math.abs(fr.tx - c.tx) < 1e-6 && Math.abs(fr.ty - c.ty) < 1e-6, `at ${c.vEgo} m/s`);
    }
    assert.equal(miciFrame(GOLDEN.K, GOLDEN.M, 476, 240, true, 0).zoom, 0.7 * 1.5);
  });

  test('the path and lane lines are the same polygons the comma draws', () => {
    const near = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 0.05 && Math.abs(p[1] - b[i][1]) < 0.05);
    for (const c of GOLDEN.cases) {
      const fr = miciFrame(GOLDEN.K, GOLDEN.M, 476, 240, false, c.vEgo);
      assert.ok(near(miciPolygon(c.path, 0.9, 1.22, 20, GOLDEN.M, fr, 476, 240, false), c.pathPoly), `path at ${c.vEgo} m/s`);
      assert.ok(near(miciPolygon(c.lane, 0.16 * 0.8, 0, 25, GOLDEN.M, fr, 476, 240), c.lanePoly), `lane at ${c.vEgo} m/s`);
    }
    assert.equal(lengthIdx([[0], [10], [20]], 15), 1);
    assert.equal(lengthIdx([[5]], 1), 0);
  });

  test('the torque bar is the same arc as on the comma', () => {
    const pts = arcBarPts(1207, 14, -96.35, -90);
    assert.equal(pts.length, 98);
    const top = pts.reduce((m, p) => Math.min(m, p[1]), Infinity);
    assert.ok(Math.abs(top + 1214) < 0.01);                       // the outer edge, rMid + half the thickness, straight up
    assert.ok(pts.every(p => p[0] < 8));                           // -96 to -90 degrees: left of the centre, but for the end's cap
  });

  test('colours blend through HSV the short way round, opaque as raylib gives them back', () => {
    assert.deepEqual(blendColors([255, 255, 255, 100], [255, 115, 0, 100], 0), [255, 255, 255, 255]);
    assert.deepEqual(blendColors([0, 255, 64], [255, 115, 0], 1), [255, 115, 0, 255]);
    assert.deepEqual(blendColors([255, 255, 255], [255, 115, 0], 0.5), [255, 156, 128, 255]);
  });

  test('filters settle the way the screen\'s do', () => {
    const f = new Filter(0, 0.1);
    for (let i = 0; i < 60; i++) f.update(1);
    assert.ok(f.x > 0.99 && f.x < 1);
    assert.equal(new Filter(0, 0.1, false).update(5), 5);          // an uninitialized one takes the first value
    const b = new BounceFilter(-50, 0.1);
    let over = false;
    for (let i = 0; i < 120; i++) if (b.update(0) > 0) over = true;
    assert.ok(over && Math.abs(b.x) < 1);                          // overshoots a little, then settles
    assert.equal(interp(20, [10, 30], [0.8, 1]), 0.9);
    assert.equal(interp(50, [10, 30], [0.8, 1]), 1);
  });

  test('each frame gets the model output computed from it', () => {
    const models = [{ frameId: 10, frameIdExtra: 10 }, { frameId: 11, frameIdExtra: 12 }, { frameId: 13, frameIdExtra: 13 }];
    assert.equal(modelFor(models, 11, 'road'), models[1]);
    assert.equal(modelFor(models, 12, 'road'), models[1]);          // none for 12: the latest before it
    assert.equal(modelFor(models, 12, 'wide'), models[1]);          // the wide camera's frame is frameIdExtra
    assert.equal(modelFor(models, 9, 'road'), null);
  });
});
