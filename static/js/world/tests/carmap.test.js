// The map pipeline from the car's own buses alone: the worker's `local` builder (the IBUS DBC, gear on 0x234, its
// own MapData over the tile loader) with NO comma: no ticks, no merge, no services. IBUS frames carry the wheel
// speed, yaw rate, gear, and the telematics box's GPS (0x526 on IBUS2) and heading (0x179 on IBUS1), driven along
// a real road of the fixture tile; the snapshot must anchor the pose and give scene.js's map-road condition.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBC } from '../dbc.js';
import { StateBuilder } from '../state.js';
import { MapData, keyOf } from '../mapdata.js';
import { decodeTile, tileFor } from '../osmtile.js';
import { FIXTURE } from './osmtile.test.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ibusDbc = new DBC(fs.readFileSync(path.join(here, '../../../../dbc/fisker_ocean_ibus.dbc'), 'latin1'));
const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
const DEG = Math.PI / 180, R = 6378137.0;
const LOCAL_STALE_S = 3.0;   // worker.js
const enc = (addr, values) => ibusDbc.messages.get(addr).encode(values);

/** worker.js's `local`, to the letter, with the tile fetch reading the fixture from disk. */
function carView() {
  const fetchTile = async (cell, file) => (`${cell}/${file}` === keyOf(tileFor(32.1, -83.3)) ? bytes : null);
  const local = new StateBuilder(ibusDbc, null, { gearMsg: 0x234, staleS: LOCAL_STALE_S,
    mapData: new MapData(fetchTile, async () => null, async () => {}, async () => null) });
  local.setCalibration(true);
  local.setPositionSource('car');
  local.setBrand('fisker');
  return local;
}

/** A way of the fixture and a 600 m run along it, as metric samples every 0.5 m: {lat, lon, hdg (compass deg)}. */
function route() {
  const ways = decodeTile(bytes).ways.filter(w => w.name === 'Rocky Springs Road');
  const way = ways.sort((a, b) => b.nodes.length - a.nodes.length)[0];
  const n = way.nodes.length / 2, mid = n >> 1;
  const pts = [];
  for (let i = mid; i < n; i++) pts.push([way.nodes[2 * i], way.nodes[2 * i + 1]]);
  const lat0 = pts[0][0], k = Math.cos(lat0 * DEG);
  const xy = pts.map(([la, lo]) => [(lo - pts[0][1]) * DEG * R * k, (la - lat0) * DEG * R]);
  const seg = [0];
  for (let i = 1; i < xy.length; i++) seg.push(seg[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const total = seg[seg.length - 1];
  assert.ok(total > 650, `the run is long enough: ${total}`);
  const at = (s) => {
    let i = 1; while (i < seg.length - 1 && seg[i] < s) i++;
    const f = (s - seg[i - 1]) / (seg[i] - seg[i - 1]), [x0, y0] = xy[i - 1], [x1, y1] = xy[i];
    const x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
    return { lat: lat0 + y / (DEG * R), lon: pts[0][1] + x / (DEG * R * k),
      hdg: (Math.atan2(x1 - x0, y1 - y0) / DEG + 360) % 360 };
  };
  return { way, at, total };
}

const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

/** Drive `seconds` at v m/s; fixes (TBOX or device) are made from the position 0.2 s earlier. */
async function drive(local, rt, { seconds = 30, v = 18, source = 'car' } = {}) {
  const kph = v / 1.031 * 3.6;
  let snap = null, lastHdg = rt.at(0).hdg;
  for (let t = 0; t <= seconds + 1e-9; t += 0.01) {
    const s = v * t, here_ = rt.at(s);
    const w = -angDiff(here_.hdg, lastHdg) / 0.01;   // compass heading falls on a left turn: CCW-positive yaw rate
    lastHdg = here_.hdg;
    const frames = [
      { bus: 'IBUS1', addr: 0x318, data: enc(0x318, { ESP_VehSpd: kph, ESP_VehSpdVld: 1 }) },
      { bus: 'IBUS1', addr: 0x112, data: enc(0x112, { YRS_YawRate: Math.max(-179, Math.min(179, w)) }) },
      { bus: 'IBUS1', addr: 0x234, data: enc(0x234, { VCU_GearSig: 4 }) },
    ];
    const tick = Math.round(t * 100) % 10 === 0;
    if (tick && source === 'car') {
      const p = rt.at(Math.max(0, v * (t - 0.2)));
      frames.push({ bus: 'IBUS2', addr: 0x526, data: enc(0x526, { TBOX_GPSLati: p.lat, TBOX_GPSLongi: p.lon }) },
                  { bus: 'IBUS1', addr: 0x179, data: enc(0x179, { TBOX_Heading: p.hdg, TBOX_HeadingStdDev: 0.2 }) });
    }
    // the worker feeds the decoder bus 0 for IBUS1 and 2 for IBUS2 (frames [[addr, bytes, bus]])
    local.feedCan(frames.map(f => [f.addr, f.data, f.bus === 'IBUS2' ? 2 : 0]), t);
    if (tick && source === 'device' && t >= 0.3) {
      const tf = t - 0.3, p = rt.at(Math.max(0, v * (tf - 0.2)));
      const q = rt.at(v * tf);
      local.feedLocation({ lat: q.lat, lon: q.lon, acc: 3, speed: v, bearing: q.hdg, fixT: tf }, t);
    }
    if (tick) {
      snap = local.snapshot(t);
      if (snap.map && snap.map.loading) await local.map.settle();   // the tile loads in the background
    }
  }
  return snap;
}

describe('the car-only map pipeline (no comma)', () => {
  for (const source of ['car', 'device']) {
    test(`position source '${source}': pose anchored, tile loaded, map road matched`, async () => {
      const rt = route();
      const local = carView();
      if (source === 'device') local.setPositionSource('device');
      const snap = await drive(local, rt, { source });
      const p = snap.pose;
      assert.equal(p.quality, 'gps', `pose quality ${p.quality}`);
      assert.ok(p.lat && p.lon, 'GPS-anchored origin');
      const end = rt.at(18 * 30);
      assert.ok(Math.abs(p.lat - end.lat) < 5e-4 && Math.abs(p.lon - end.lon) < 5e-4, `pose is where the car drove: ${p.lat}, ${p.lon}`);
      assert.ok(local.map.loaded >= 1, 'the tile was loaded through fetchTile');
      const m = snap.map;
      assert.ok(m && m.way, `map.way set: ${JSON.stringify(m && { loading: m.loading, tiles: m.tiles })}`);
      assert.ok(m.horizon.length >= 2, 'the same condition as scene.js _road()');
      assert.equal(m.way.name, 'Rocky Springs Road');
      assert.ok(m.conf > 0.5, `confidence ${m.conf}`);
      assert.ok(snap.map.roadsVersion >= 1 && snap.map.tiles >= 1);
    });
  }
});
