#!/usr/bin/env python3
"""Draws the world model over a route's road-camera video, beside a top-down view, for checking it by eye.

  python3 tools/route_overlay.py <out>.frames.json <out>.overlay.jsonl <segment dirs...> -o review.mp4
  python3 tools/route_overlay.py ... --compare <old>.overlay.jsonl     # the old model in a second row

Inputs from tools/route_ticks.py (frames.json: frame times, the camera's projection M, the calibration) and
tools/route_overlay.mjs (overlay.jsonl: what the world model shows at each frame). Needs ffmpeg, numpy, Pillow.

On the camera each object is a 3D box at its footprint (the model's center, heading and size) up to its height:
  green   a camera (the ADAS list) sees it          blue    the car we follow (the ADAS lead flag)
  orange  the radar alone                           red     a threat flag (blind spot, AEB, ...)
  yellow  openpilot's lead alone                    grey    too unsure to be drawn in the app (conf < 0.35)
with its id and speed; the raw measurements as dots on the ground: radar red, camera cyan, openpilot yellow.
The top-down view shows the same from above, our car at the bottom, 1 grid square = 10 m.
"""
import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

CAM_BEHIND_BUMPER = 1.7   # m: the comma camera behind our front bumper (world_model.js modelXOffset)
EGO_W, EGO_L, EGO_FRONT_TO_REAR = 1.98, 4.775, 3.85
SCALE = 2                 # the camera picture, enlarged
BEV_W, BEV_RANGE = 440, (-12.0, 70.0)   # top-down panel width (px), and what it covers ahead (m)
CONF_SHOWN = 0.35

COLORS = {"camera": (60, 220, 90), "radar": (255, 150, 30), "op": (250, 220, 40), "lead": (60, 140, 255),
          "threat": (255, 60, 60), "hidden": (130, 130, 130)}
RAW = {"radar": (255, 70, 70), "adas": (40, 230, 255), "op": (255, 230, 40)}


def color_of(o):
  if o["conf"] < CONF_SHOWN:
    return COLORS["hidden"]
  if o["threat"]:
    return COLORS["threat"]
  if o["lead"]:
    return COLORS["lead"]
  if "adas" in o["src"]:
    return COLORS["camera"]
  if "radar" in o["src"]:
    return COLORS["radar"]
  return COLORS["op"]


def font(size):
  for p in ("/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc", "/Library/Fonts/Arial.ttf"):
    if os.path.exists(p):
      try:
        return ImageFont.truetype(p, size)
      except OSError:
        pass
  return ImageFont.load_default()


class Camera:
  def __init__(self, cam, height):
    self.M = np.array(cam["M"])
    self.h = height

  def project(self, x, y, z):
    """Our car's frame (x ahead of the front bumper, y left, z up from the road) -> picture pixels, or None."""
    p = self.M @ np.array([x + CAM_BEHIND_BUMPER, -y, self.h - z])
    if p[2] < 1.0:
      return None
    return (p[0] / p[2] * SCALE, p[1] / p[2] * SCALE)


def box_corners(o):
  c, s = math.cos(o["h"]), math.sin(o["h"])
  pts = []
  for z in (0.0, o["hgt"]):
    for a, b in ((1, 1), (1, -1), (-1, -1), (-1, 1)):
      dx, dy = a * o["l"] / 2, b * o["w"] / 2
      pts.append((o["cx"] + c * dx - s * dy, o["cy"] + s * dx + c * dy, z))
  return pts


EDGES = [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7)]


def draw_camera(img, cam, ov, f_small):
  d = ImageDraw.Draw(img, "RGBA")
  for kind, pts in ov["raw"].items():
    for x, y in pts:
      p = cam.project(x, y, 0.3)
      if p:
        r = 3
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=RAW[kind] + (230,), outline=(0, 0, 0, 200))
  for o in sorted(ov["objs"], key=lambda o: -o["cx"]):   # far first, so near boxes draw over them
    pts = [cam.project(*q) for q in box_corners(o)]
    if any(p is None for p in pts):
      continue
    col = color_of(o)
    width = 3 if o["conf"] >= CONF_SHOWN else 1
    for a, b in EDGES:
      d.line([pts[a], pts[b]], fill=col + (255,), width=width)
    top = min(p[1] for p in pts)
    left = min(p[0] for p in pts)
    label = f"{o['id']} {o['cls'][:5]} {abs(o['v'] or 0) * 2.237:.0f}mph"
    d.text((left, top - 14), label, fill=col + (255,), font=f_small, stroke_width=2, stroke_fill=(0, 0, 0))


def draw_bev(ov, height, f_small, title):
  img = Image.new("RGB", (BEV_W, height), (18, 20, 24))
  d = ImageDraw.Draw(img, "RGBA")
  ppm = height / (BEV_RANGE[1] - BEV_RANGE[0])
  def to_px(x, y):
    return (BEV_W / 2 - y * ppm, height - (x - BEV_RANGE[0]) * ppm)
  for gx in range(-40, 80, 10):   # grid every 10 m
    d.line([to_px(gx, -30), to_px(gx, 30)], fill=(45, 48, 55), width=1)
  for gy in range(-30, 31, 10):
    d.line([to_px(BEV_RANGE[0], gy), to_px(BEV_RANGE[1], gy)], fill=(45, 48, 55), width=1)
  # our car: the front bumper at x 0
  ex0, ex1 = -EGO_L, 0.0
  d.polygon([to_px(ex1, -EGO_W / 2), to_px(ex1, EGO_W / 2), to_px(ex0, EGO_W / 2), to_px(ex0, -EGO_W / 2)], fill=(200, 200, 210))
  for kind, pts in ov["raw"].items():
    for x, y in pts:
      p = to_px(x, y)
      d.ellipse([p[0] - 2.5, p[1] - 2.5, p[0] + 2.5, p[1] + 2.5], fill=RAW[kind] + (220,))
  for o in ov["objs"]:
    col = color_of(o)
    c = box_corners(o)[:4]
    d.polygon([to_px(x, y) for x, y, _ in c], outline=col + (255,), width=2)
    # its heading: a line from the center to the front
    hx, hy = o["cx"] + math.cos(o["h"]) * o["l"] / 2, o["cy"] + math.sin(o["h"]) * o["l"] / 2
    d.line([to_px(o["cx"], o["cy"]), to_px(hx, hy)], fill=col + (255,), width=2)
    p = to_px(o["cx"], o["cy"])
    d.text((p[0] + 8, p[1] - 6), str(o["id"]), fill=col + (255,), font=f_small)
  d.text((10, 8), title, fill=(230, 230, 235), font=f_small)
  return img


def legend(d, x, y, f):
  items = [("camera", "camera"), ("radar only", "radar"), ("openpilot only", "op"), ("lead", "lead"), ("threat", "threat"), ("conf<0.35", "hidden")]
  for i, (name, key) in enumerate(items):
    d.rectangle([x, y + i * 16, x + 10, y + i * 16 + 10], fill=COLORS[key])
    d.text((x + 16, y + i * 16 - 2), name, fill=(230, 230, 235), font=f)
  j = len(items)
  for i, (name, key) in enumerate([("raw radar", "radar"), ("raw camera", "adas"), ("raw openpilot", "op")]):
    d.ellipse([x, y + (j + i) * 16, x + 10, y + (j + i) * 16 + 10], fill=RAW[key])
    d.text((x + 16, y + (j + i) * 16 - 2), name, fill=(230, 230, 235), font=f)


def decode(seg_dir, w, h):
  """The segment's camera frames, in order, as HxWx3 arrays."""
  src = os.path.join(seg_dir, "qcamera.ts")
  p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
  n = w * h * 3
  while True:
    buf = p.stdout.read(n)
    if len(buf) < n:
      break
    yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
  p.wait()


def load_overlay(path):
  out = {}
  with open(path) as f:
    for line in f:
      ov = json.loads(line)
      out[ov["i"]] = ov
  return out


def main():
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("frames")
  ap.add_argument("overlay")
  ap.add_argument("segments", nargs="+")
  ap.add_argument("-o", "--out", required=True)
  ap.add_argument("--compare", help="a second overlay (e.g. the old model) drawn in a row below")
  ap.add_argument("--labels", default="physical model,constant-velocity model")
  ap.add_argument("--start", type=float, default=0, help="s into the route to start at")
  ap.add_argument("--seconds", type=float, default=None, help="how much to render")
  args = ap.parse_args()

  meta = json.load(open(args.frames))
  cam_meta = meta["camera"]
  cam = Camera(cam_meta, (meta["calib"]["height"] or [1.22])[0])
  w, h = cam_meta["width"], cam_meta["height"]
  ovs = [load_overlay(args.overlay)] + ([load_overlay(args.compare)] if args.compare else [])
  names = args.labels.split(",")
  index = {(k, j): i for i, (_, k, j) in enumerate(meta["frames"])}
  t0 = meta["frames"][0][0]
  row_h = h * SCALE
  out_w, out_h = w * SCALE + BEV_W, row_h * len(ovs)
  out_w += out_w % 2
  out_h += out_h % 2
  enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{out_w}x{out_h}", "-r", "20", "-i", "-",
                          "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", args.out], stdin=subprocess.PIPE)
  f_small, f_big = font(12), font(15)
  done = 0
  for k, seg in enumerate(args.segments):
    for j, pic in enumerate(decode(seg, w, h)):
      i = index.get((k, j))
      if i is None:
        continue
      t = meta["frames"][i][0] - t0
      if t < args.start or (args.seconds is not None and t > args.start + args.seconds):
        continue
      frame = Image.new("RGB", (out_w, out_h), (0, 0, 0))
      for r, ov_map in enumerate(ovs):
        ov = ov_map.get(i, {"objs": [], "raw": {}, "v": 0})
        img = Image.fromarray(pic).resize((w * SCALE, h * SCALE), Image.BILINEAR)
        draw_camera(img, cam, ov, f_small)
        d = ImageDraw.Draw(img)
        d.text((10, 8), f"{meta['route']}  t={t:6.1f}s  frame {i}  ego {ov.get('v', 0) * 2.237:4.1f} mph   {names[r] if r < len(names) else ''}",
               fill=(255, 255, 255), font=f_big, stroke_width=2, stroke_fill=(0, 0, 0))
        if r == 0:
          legend(d, 10, 34, f_small)
        frame.paste(img, (0, r * row_h))
        frame.paste(draw_bev(ov, row_h, f_small, names[r] if r < len(names) else ""), (w * SCALE, r * row_h))
      enc.stdin.write(frame.tobytes())
      done += 1
  enc.stdin.close()
  enc.wait()
  print(f"{done} frames -> {args.out}")


if __name__ == "__main__":
  main()
