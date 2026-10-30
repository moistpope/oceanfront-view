// The world-model worker: folds the car's own buses (IBUS1/IBUS2, through the Android app) and, when it is
// connected, the comma bridge's ticks (raw CAN frames + openpilot service extracts) into the HUD's state
// snapshots, off the page's main thread so the 3D view keeps its frame budget.
//
// The car's buses are the primary source: their builder (`local`, the IBUS DBC) runs whenever frames arrive.
// A live comma tick is merged into it (merge.js: the ADAS bus, the radar, openpilot), so the car's view gains
// what only the comma has. The comma's own builder (`builder`, the ADASBUS DBC) is fed too and draws only when
// the car's buses are silent (a browser on a PC with serve.py --bridge) or the comma is replaying a drive.
//
// Messages in:  {type:'init', worldDbc, radarDbc, ibusDbc}   the DBC texts (radarDbc and ibusDbc may be null)
//               {type:'tick', data}                  a bridge tick (see server.py: now, reset, brand, can, op, mode, replay, server)
//               {type:'ibus', t, frames}             frames from the car's own buses through the Android app ([{bus, addr, data}]),
//                                                    t = Date.now()/1000
//               {type:'raw', source, addrs}          which messages the signal browser watches: source 'ibus' (the car's
//                                                    buses) or 'adas' (the comma's ADAS bus); [] for none
//               {type:'calibration', on}             the world model's measured sensor calibration on/off
//               {type:'position', source}            where the pose's fixes come from: 'car' (the TBOX) or 'device' (below)
//               {type:'location', t, fix}            a fix from the screen's own location, through the Android app
//                                                    ({lat, lon, acc, speed, bearing, fixT}, fixT and t on the Date.now()/1000 clock)
// Messages out: {type:'state', data}                 the comma's own snapshot (replay, or no car buses)
//               {type:'local', data}                 the car's view: 10 Hz from IBUS alone, at the tick rate with the comma
//                                                    merged in (data.comma true then; mode 'car')
//               {type:'raw', source, data}           the watched messages' decoded signals, ~5 Hz
import { DBC, hexToBytes } from './dbc.js';
import { StateBuilder, wireFrames } from './state.js';
import { MapData } from './mapdata.js';
import { CommaMerge } from './merge.js';

const RAW_RATE_HZ = 5;

const EARLY_TICKS = 200;   // ticks kept while the DBCs are still loading (the first is the bridge's snapshot)

const LOCAL_HZ = 10;
const LOCAL_GAP_S = 0.15;    // the timer posts the car's view when no merged comma tick has for this long
const LOCAL_QUIET_S = 3.0;   // no IBUS frames this long: the car's view stops (the app repeats every message once a second)
const LOCAL_STALE_S = 3.0;   // a message's last frame counts this long: longer than the app's one-second repeat and its bridge's delay

let builder = null;
let local = null;            // the car's own buses (IBUS1 = bus 0, IBUS2 = bus 2 for the decoder)
let merge = null;            // the comma's ticks folded into `local` (merge.js)
const tileBytes = new Map(); // cell/file -> Uint8Array: both builders read the same tiles

/** GET /map/tile/<cell>/<file> from the page's server (maptiles.py, LocalServer.kt); null when it hasn't got it. */
async function fetchTile(cell, file) {
  const key = cell + '/' + file;
  const have = tileBytes.get(key);
  if (have) return have;
  const r = await fetch(`/map/tile/${cell}/${encodeURIComponent(file)}`);
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  tileBytes.set(key, bytes);
  if (tileBytes.size > 12) tileBytes.delete(tileBytes.keys().next().value);
  return bytes;
}
/** GET /map/features/<klat>/<klon>: the point features of a FEAT_DEG cell (mapdata.js), or null. */
async function fetchFeatures(klat, klon) {
  const r = await fetch(`/map/features/${klat}/${klon}`);
  if (!r.ok) return null;
  return r.json();
}
/** GET /map/ways/<tlat>/<tlon>: a road tile's full OSM way tags (roaddetail.js: lanes each way, width, turn arrows), or
 *  null. Shared by both builders; after a miss (a server without the endpoint, or Overpass busy) nothing is asked for a minute. */
const wayTags = new Map();   // "tlat,tlon" -> Promise
let waysMissingAt = -1e9;
async function fetchWays(tlat, tlon) {
  const key = tlat + ',' + tlon;
  if (wayTags.has(key)) return wayTags.get(key);
  if (performance.now() - waysMissingAt < 60e3) return null;
  const p = fetch(`/map/ways/${tlat}/${tlon}`).then((r) => {
    if (!r.ok) { waysMissingAt = performance.now(); return null; }
    return r.json();
  });
  wayTags.set(key, p);
  p.then((v) => { if (!v) wayTags.delete(key); }, () => wayTags.delete(key));
  if (wayTags.size > 12) wayTags.delete(wayTags.keys().next().value);
  return p;
}
/** POST /map/prefetch: have the server download the map within km of the point (maptiles.py MapPrefetch). */
async function fetchPrefetch(lat, lon, km) {
  await fetch('/map/prefetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat, lon, radius_km: km }) });
}
let prefetchKm = 25;
let localT = -1e9;           // when the last IBUS frame came in (page clock, s)
let localPostT = -1e9;       // when the car's view was last posted
let rawAddrs = [];
let rawSource = 'ibus';
let rawNext = 0;
let calibrationOn = true;
let positionSource = 'car';
let early = [];

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      builder = new StateBuilder(new DBC(msg.worldDbc), msg.radarDbc ? new DBC(msg.radarDbc) : null, { mapData: new MapData(fetchTile, fetchFeatures, fetchPrefetch, fetchWays) });
      builder.map.setPrefetchKm(prefetchKm);
      builder.setCalibration(calibrationOn);
      builder.setPositionSource(positionSource);
      if (msg.ibusDbc) {
        local = new StateBuilder(new DBC(msg.ibusDbc), msg.radarDbc ? new DBC(msg.radarDbc) : null,
          { gearMsg: 0x234, staleS: LOCAL_STALE_S, mapData: new MapData(fetchTile, fetchFeatures, fetchPrefetch, fetchWays) });
        local.map.setPrefetchKm(prefetchKm);
        local.setCalibration(calibrationOn);
        local.setPositionSource(positionSource);
        local.setBrand('fisker');
        merge = new CommaMerge(local);
        setInterval(() => { if (Date.now() / 1000 - localPostT > LOCAL_GAP_S) localTick(); }, 1000 / LOCAL_HZ);   // merged ticks post their own
      }
      const messages = (b) => (b ? [...b.world.dbc.messages.values()].sort((x, y) => x.address - y.address).map(m => m.toJSON()) : []);
      self.postMessage({ type: 'ready', dbc: { messages: messages(builder) }, ibusDbc: { messages: messages(local) } });
      for (const tick of early) onTick(tick);
      early = [];
    } else if (msg.type === 'tick') {
      if (builder) onTick(msg.data);
      else {
        // a reset tick (the bridge's snapshot for a new viewer) makes everything before it moot
        if (msg.data.reset) early = [];
        early.push(msg.data);
        if (early.length > EARLY_TICKS) early.shift();
      }
    } else if (msg.type === 'ibus') {
      if (local) {
        local.feedCan(merge.filterIbus(msg.frames.map(f => [f.addr, hexToBytes(f.data), f.bus === 'IBUS2' ? 2 : 0]), msg.t), msg.t);
        localT = msg.t;
      }
    } else if (msg.type === 'raw') {
      rawAddrs = (msg.addrs || []).map(a => (typeof a === 'string' ? parseInt(a, 16) : a)).slice(0, 200);
      rawSource = msg.source === 'adas' ? 'adas' : 'ibus';
      rawNext = 0;
    } else if (msg.type === 'calibration') {
      calibrationOn = !!msg.on;
      if (builder) builder.setCalibration(calibrationOn);
      if (local) local.setCalibration(calibrationOn);
    } else if (msg.type === 'position') {
      positionSource = msg.source === 'device' ? 'device' : 'car';
      if (builder) builder.setPositionSource(positionSource);
      if (local) local.setPositionSource(positionSource);
    } else if (msg.type === 'location') {
      if (local) local.feedLocation(msg.fix, msg.t);   // the car's own view only: the comma's replays have fixes of their own
    } else if (msg.type === 'mapPrefetch') {
      prefetchKm = Number(msg.km) || 0;
      if (builder && builder.map) builder.map.setPrefetchKm(prefetchKm);
      if (local && local.map) local.map.setPrefetchKm(prefetchKm);
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.stack || e) });
  }
};

function onTick(tick) {
  const wall = Date.now() / 1000;
  if (tick.reset) builder.reset();
  if (tick.brand !== undefined) builder.setBrand(tick.brand);
  for (const [t, frames] of tick.can || []) builder.feedCan(wireFrames(frames), t);
  for (const [which, t, data] of tick.op || []) builder.feedService(which, data, t);
  // the car's buses are live: the comma's live data joins their view, and its own snapshot isn't drawn
  if (local && tick.mode === 'live' && wall - localT <= LOCAL_QUIET_S) {
    merge.feed(tick, wall);
    localTick(tick.server ?? null);
  } else {
    const snap = builder.snapshot(tick.now);
    snap.mode = tick.mode;
    snap.replay = tick.replay ?? null;
    snap.server = tick.server ?? null;
    self.postMessage({ type: 'state', data: snap });
  }
  if (rawSource === 'adas') postRaw(builder, tick.now);
}

/** The watched messages' signals, at most RAW_RATE_HZ. */
function postRaw(b, now) {
  if (!rawAddrs.length || !b) return;
  const wall = Date.now();
  if (wall < rawNext) return;
  rawNext = wall + 1000 / RAW_RATE_HZ;
  const data = b.world.rawMessages(rawAddrs, now);
  if (b === local) {
    for (const hex in data) if (merge.fromComma(parseInt(hex, 16), wall / 1000)) data[hex].via = 'comma';
  }
  self.postMessage({ type: 'raw', source: rawSource, data });
}

// The car's own view, from what the app read on IBUS1/IBUS2 since the last one (and the comma's last tick, when
// it is merged in). Its clock is the wall clock (Date.now), the same the main thread stamps the frames with: a
// worker's performance.now() has an origin of its own.
function localTick(server = null) {
  if (!local) return;
  const now = Date.now() / 1000;
  if (now - localT > LOCAL_QUIET_S) return;
  const snap = local.snapshot(now);
  snap.mode = 'car';
  snap.replay = null;
  snap.comma = merge.active(now);
  snap.server = snap.comma ? server : null;
  self.postMessage({ type: 'local', data: snap });
  localPostT = now;
  if (rawSource === 'ibus') postRaw(local, now);
}
