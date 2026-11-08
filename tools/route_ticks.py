#!/usr/bin/env python3
"""Turns recorded comma route segments into the bridge's tick stream (one JSON tick per line, as
tools/record_ticks.mjs saves from a live bridge), at full speed instead of in real time, plus what's needed to
line the page's world model up with the road camera: each camera frame's time and the camera calibration.

Runs in openpilot's environment (it uses the bridge's own log loading and StreamBuilder):

  cd ~/sunnypilot-1/openpilot && PYTHONPATH=.. ../.venv/bin/python \\
    ~/oceanfront-view/tools/route_ticks.py ~/comma-routes/000001ae--ebc6ee1523--{5,6,7} -o ~/comma-routes/out/ae5

writes <out>.ticks.jsonl and <out>.frames.json:
  {route, segments, deviceType, calib: {rpy, height}, frames: [[t, segment, index in that segment's qcamera.ts], ...]}
(t: the frame's capture time)
Ticks are stamped with the log's clock (logMonoTime, s), the same clock the frames' times are in.
"""
import argparse
import json
import os
import sys

from openpilot.cereal import log
from openpilot.sunnypilot.webhud.sources import REPLAY_SERVICES, find_log, read_log_bytes
from openpilot.sunnypilot.webhud.state import StreamBuilder

RATE_HZ = 20   # the bridge's tick rate (server.py RATE_HZ)


def events(seg_dir: str):
  path = find_log(seg_dir)
  if path is None:
    sys.exit(f"no log in {seg_dir}")
  for evt in log.Event.read_multiple_bytes(read_log_bytes(path)):
    try:
      which = evt.which()
    except Exception:   # a union member this schema doesn't know
      continue
    yield which, evt.logMonoTime * 1e-9, evt


def main() -> None:
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("segments", nargs="+", help="segment directories (route--N), in order")
  ap.add_argument("-o", "--out", required=True, help="output path prefix")
  ap.add_argument("--qcam-width", type=int, default=526)
  ap.add_argument("--qcam-height", type=int, default=330)
  args = ap.parse_args()

  builder = StreamBuilder()
  os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
  frames, calib, device, sensor = [], None, None, None
  next_tick = None
  n_ticks = 0
  skipped: dict[str, int] = {}
  with open(args.out + ".ticks.jsonl", "w") as out:
    first = True
    for k, seg_dir in enumerate(args.segments):
      evs = sorted(events(seg_dir), key=lambda e: e[1])
      for which, t, evt in evs:
        if which == "initData":
          try:
            device = str(evt.initData.deviceType)
          except Exception:   # a device newer than this schema
            device = f"#{evt.initData.deviceType.raw}"
        elif which in ("liveCalibration", "extrinsicsCalibration"):   # the newer name on newer openpilot
          c = getattr(evt, which)
          calib = {"rpy": list(c.rpyCalib), "height": list(c.height) if len(c.height) else None}
        elif which in ("roadCameraState", "narrowRoadCameraState") and sensor is None:
          try:
            sensor = str(getattr(evt, which).sensor)
          except Exception:
            pass
        elif which in ("qRoadEncodeIdx", "qNarrowRoadEncodeIdx"):
          # the frame's capture time (the middle of its exposure), on the logs' clock
          e = getattr(evt, which)
          frames.append([round((e.timestampSof + e.timestampEof) * 0.5e-9, 6), k, e.segmentId])
        if next_tick is None:
          if which not in ("can", "carState"):   # boot-time messages are stamped long before the drive
            continue
          next_tick = t
        if t - next_tick > 2.0:   # a gap (between segments, a dropped log): pick up at the next message
          next_tick = t
        while t >= next_tick:   # ticks at the bridge's rate, each with what was fed since the last
          tick = builder.take_tick(next_tick)
          if first:
            tick["reset"] = True
            first = False
          tick["mode"] = "replay"
          out.write(json.dumps(tick, separators=(",", ":")) + "\n")
          n_ticks += 1
          next_tick += 1.0 / RATE_HZ
        if which == "can":
          builder.feed_can([(m.address, m.dat, m.src) for m in evt.can], t)
        elif which in REPLAY_SERVICES:
          if which == "carParams" and builder.brand is None:
            builder.set_brand(evt.carParams.brand or None)
          try:
            builder.feed_service(which, getattr(evt, which), t)
          except Exception:   # a message newer than this checkout's schema: skipped, and counted
            skipped[which] = skipped.get(which, 0) + 1
  # the road camera's projection for the small video (qcamera.ts), as the bridge and openpilot's UI build it: K scaled
  # to the stream, M = K . view_from_calib (calibrated frame: x ahead, y right, z down, from the camera)
  cam = None
  if calib is not None:
    from openpilot.sunnypilot.webhud.video import camera_transforms
    size = (args.qcam_width, args.qcam_height)
    cam = camera_transforms(device or "tici", sensor or "ar0231", {"road": size}, calib["rpy"], None)["cameras"].get("road")
  meta = {"route": os.path.basename(args.segments[0]).rsplit("--", 1)[0], "camera": cam, "sensor": sensor,
          "segments": [os.path.basename(s) for s in args.segments],
          "deviceType": device, "calib": calib, "frames": frames}
  with open(args.out + ".frames.json", "w") as f:
    json.dump(meta, f, separators=(",", ":"))
  print(f"{n_ticks} ticks, {len(frames)} camera frames, device {device}, calib {calib}")
  if skipped:
    print(f"skipped (schema mismatch): {skipped}")


if __name__ == "__main__":
  main()
