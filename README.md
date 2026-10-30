# Oceanfront View

A Tesla-style car view for the Fisker Ocean's center screen: a 3D model of the car with the lanes, cars,
signs and lights its ADAS sees, the road from the map, live car state and controls, music and navigation.

It runs on Pulse (the add-on board) and reads the car's own IBUS1/IBUS2. A comma device running
[sunnypilot](https://github.com/moistpope/sunnypilot) is optional: it adds the full ADAS bus, the radar
and openpilot, and the app manages it over SSH.

## How it works

- **The page** (`static/`) is plain ES modules with no build step. CAN decoding, sensor fusion, pose
  estimation and map matching run in a web worker (`static/js/world/`).
- **On the car**, the Android app ([`android/`](android/README.md)) serves the page from its APK, reads
  IBUS1/IBUS2 through Pulse's CAN controllers and feeds the frames to the page. The gateway mirrors the
  ADAS bus onto IBUS2, so the full HUD works from the car alone.
- **With a comma**, sunnypilot's `webhud` bridge (*Settings → Developer → Web HUD*, port 8088) streams
  the ADAS bus, the radar's private bus and openpilot's services at 20 Hz over `/ws`. The worker merges
  them into the car's view (`static/js/world/merge.js`). The app finds the comma on the head unit's hotspot.
- **On a PC**, `python3 serve.py` serves the same page at `http://localhost:18088`; add
  `--bridge sunnypilot.local` to relay to a comma.

## Features

- **Driving view:** speed, gear, ACC/MADS state, speed limit, alerts, lane lines, tracked objects,
  parking sensors, traffic lights, signs, stop lines and crosswalks.
- **World model:** fuses radar, ADAS camera and openpilot leads with per-sensor calibration and
  confidence (*Display → Objects*).
- **Map road:** OpenStreetMap roads, junctions and street furniture around the car, matched to a
  GPS/odometry pose and aligned to the camera's lanes. Tiles are prefetched and cached (*Display → Map download*).
- **Live car controls:** locks, doors, windows, sunroof, mirrors, lights, climate, seats and energy,
  reflected on the 3D car. Controls send the head unit's own CAN messages; ones that can't are greyed out.
- **Music and navigation:** now-playing and next-turn cards from the head unit, with a turn arrow on the road.
- **Comma camera:** the comma's camera in a window over the 3D view (drag it anywhere, resize it from its corner, tap
  it for its controls), in one of three styles. **Road** and **Wide**: that camera's whole 16:9 picture with the
  path, lane lines, road edges and lead drawn over it. **Mirror**: the comma 4's own driving screen, in its 536 x 240
  shape -- the camera framed the way the comma frames it (and the camera it picks: wide in experimental mode at low
  speed), with everything its screen draws: the path and lane lines in the status colours, the curved torque bar, the
  steering wheel and turn intent, the set speed, alerts, the driver monitoring icon, blind spot icons and the
  confidence ball, ported from sunnypilot's `selfdrive/ui/mici/onroad` (`static/js/commaui.js`, with the screen's
  artwork and fonts in `static/comma/`). It comes from the bridge's `/video` socket (the video button beside the
  camera button turns it on and off): the comma's livestream H.264, decoded by the WebView (WebCodecs), with the
  overlay drawn on each frame from the model output computed from that frame (`static/js/roadcam.js`).
- **Comma tab:** SSH management of the comma (start/stop openpilot, logs, processes, routes and replay,
  updates, branch and fork switching, panda firmware).
- **Debug tools:** *Signals* tab (live CAN browser), object stats, radar tracks, frame-rate counter
  with auto render resolution, and demo modes for music, navigation, car state and parking.

See [INTERNALS.md](INTERNALS.md) for how each of these is decoded, fused and drawn, and the ADAS
signals used. [DESIGN.md](DESIGN.md) covers the car controls' design language.

## Layout

| Path | What |
|------|------|
| `static/` | The page; `js/world/` is the worker (DBC decoding, comma merge, world model, pose, map) and its tests |
| `android/` | The car app: Kotlin, local server, Go CAN helper, comma SSH management |
| `dbc/` | `fisker_ocean_adas_world.dbc` (ADAS subset), `fisker_ocean_ibus.dbc` (IBUS1/2), `fisker_ocean_mrr.dbc` (radar, reverse-engineered) |
| `third_party/` | three.js r160 and the Pulse Ocean model |
| `tools/` | DBC generators, Blender model export, tick recording/replay and eval tools, `release.sh` |
| `serve.py` | Dev server; `--bridge` relays `/api`, `/ws` and `/map` to a comma |

## Development

```bash
python3 serve.py --bridge sunnypilot.local     # page at http://localhost:18088, fed by the comma
npm test                                       # worker tests
cd android && ./gradlew assembleRelease        # the APK (JDK 17+, Android SDK)
```

Working on decoding and fusion without a browser:

```bash
node tools/record_ticks.mjs http://sunnypilot.local:8088 ticks.jsonl --seconds 120
node tools/replay_ticks.mjs ticks.jsonl
node tools/pose_eval.mjs ticks.jsonl
node tools/map_eval.mjs --tiles ~/.comma/media/0/osm/offline ticks.jsonl
```

Regenerating DBCs (outputs are checked in; copy the ADAS DBC to sunnypilot too):

```bash
python3 tools/gen_world_dbc.py FM29_ADASBUS_Matrix_CANFD_V390.8_20230524.dbc
python3 tools/gen_ibus.py FM29_IBUS1_Matrix.xlsx FM29_IBUS2_Matrix.xlsx
```

Rebuilding the car model with its parts split out (for the car controls):

```bash
blender -b Pulse-Ocean-Master.blend --python tools/export_ocean_glb.py -- --glb Pulse-Ocean-ADAS.glb --out third_party/models/pulse_ocean_v0.10_parts.glb
```

Running the bridge on a PC from a sunnypilot checkout (point `serve.py --bridge 127.0.0.1:8088` at it):

```bash
python -m openpilot.sunnypilot.webhud.server --demo
python -m openpilot.sunnypilot.webhud.server --replay <rlog.zst | segment dir | route dir>
pytest openpilot/sunnypilot/webhud/tests
```

## Releases

Each [release](https://github.com/moistpope/oceanfront-view/releases) carries a built APK, and the app
updates itself from the latest one. Always cut releases with `tools/release.sh`: it bumps the app's
version, which the cars need to see an update (see [android/README.md](android/README.md#cutting-a-release)).

## Bridge API

- `GET /api/status`, `GET /api/routes`, `POST /api/replay`, `PUT /api/upload?name=<file>`
- `GET|PUT /api/params`, `GET|PUT|DELETE /api/overrides`
- `GET /api/ssh`, `POST|DELETE /api/ssh/authorize`
- `GET /map/tile/<lat>/<lon>/<name>`, `GET /map/features/<klat>/<klon>`, `POST /map/prefetch`, `GET /map/status`
- WebSocket `/ws`: `{type: hello}`, then `{type: tick, data: {now, reset?, can, op, mode, replay, server}}` at 20 Hz

Writes are accepted only from private addresses and never cross-origin. CAN overrides, SSH keys and
replay are refused while the car is moving.
