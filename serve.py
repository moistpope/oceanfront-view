#!/usr/bin/env python3
"""
Oceanscape dev server: serves the HUD page from this checkout the way the Android app's LocalServer
does on the car, and relays the comma bridge's endpoints to a sunnypilot device.

  python3 serve.py                              # http://localhost:18088, the page alone (it shows "offline")
  python3 serve.py --bridge sunnypilot.local    # relay /api, /ws and /map to the comma (port 8088)
  python3 serve.py --bridge 127.0.0.1:8088      # a bridge on this PC: python -m openpilot.sunnypilot.webhud.server --replay ...

URL roots match the app and the bridge: "/" the page (static/), /vendor/ three.js, /models/ the Ocean model,
/dbc/ the DBCs; unknown paths fall back to index.html so deep links work. A relayed request is forwarded
byte for byte after its head, one request per connection, so the WebSocket upgrade passes unchanged.
Stdlib only.
"""
import argparse
import os
import socket
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_ROOTS = {   # URL prefix -> directory ("" = the page itself; checked in order)
  "vendor/": os.path.join(ROOT, "third_party", "three"),
  "models/": os.path.join(ROOT, "third_party", "models"),
  "dbc/": os.path.join(ROOT, "dbc"),
  "": os.path.join(ROOT, "static"),
}
DEFAULT_PORT = 18088          # the Android app's local port, so the page's origin matches the car's
BRIDGE_PORT = 8088            # the comma bridge
BRIDGE: tuple[str, int] | None = None


def relayed(path: str) -> bool:
  return path in ("/ws", "/video") or path.startswith(("/api/", "/map/"))


def pump(src: socket.socket, dst: socket.socket) -> None:
  try:
    while True:
      data = src.recv(65536)
      if not data:
        break
      dst.sendall(data)
  except OSError:
    pass
  finally:
    for s in (src, dst):
      try:
        s.shutdown(socket.SHUT_RDWR)
      except OSError:
        pass


class Handler(SimpleHTTPRequestHandler):
  protocol_version = "HTTP/1.1"
  rbufsize = 0   # unbuffered: bytes after the request head (a WebSocket's first frames) must reach the relay
  extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                    ".glb": "model/gltf-binary", ".dbc": "text/plain", ".json": "application/json", ".webmanifest": "application/json"}

  def translate_path(self, path: str) -> str:
    rel = unquote(urlparse(path).path).lstrip("/") or "index.html"
    prefix = next(p for p in STATIC_ROOTS if rel.startswith(p))
    root = os.path.realpath(STATIC_ROOTS[prefix])
    full = os.path.realpath(os.path.join(root, rel[len(prefix):]))
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
      return os.path.join(STATIC_ROOTS[""], "index.html")   # deep links (and traversal attempts) get the app shell
    return full

  def end_headers(self) -> None:
    self.send_header("Cache-Control", "no-cache")   # a dev server: always revalidate (Last-Modified is sent)
    super().end_headers()

  def do_GET(self) -> None:
    if relayed(urlparse(self.path).path):
      return self.relay()
    super().do_GET()

  def do_HEAD(self) -> None:
    if relayed(urlparse(self.path).path):
      return self.relay()
    super().do_HEAD()

  def do_POST(self) -> None:
    self.relay() if relayed(urlparse(self.path).path) else self.send_error(404)

  do_PUT = do_DELETE = do_POST

  def relay(self) -> None:
    self.close_connection = True
    if BRIDGE is None:
      return self.send_error(503, "no bridge: start with --bridge <host[:port]>")
    try:
      up = socket.create_connection(BRIDGE, timeout=5)
    except OSError as e:
      return self.send_error(502, f"bridge {BRIDGE[0]}:{BRIDGE[1]}: {e}")
    up.settimeout(None)
    upgrade = self.headers.get("Upgrade", "").lower() == "websocket"
    head = [f"{self.command} {self.path} {self.request_version}"]
    for k, v in self.headers.items():
      if k.lower() == "connection" and not upgrade:
        continue
      head.append(f"{k}: {v}")
    if not upgrade:
      head.append("Connection: close")   # one request per connection: the bridge's EOF ends the relay
    up.sendall(("\r\n".join(head) + "\r\n\r\n").encode("latin-1"))
    client = self.connection
    threading.Thread(target=pump, args=(client, up), daemon=True).start()   # request body, WebSocket frames up
    pump(up, client)                                                        # the response down

  def log_message(self, fmt, *args) -> None:   # noqa: A002
    if not str(args[0]).startswith(("GET /ws", "GET /video", "GET /api/")):
      super().log_message(fmt, *args)


def main() -> None:
  global BRIDGE
  ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("--port", type=int, default=DEFAULT_PORT)
  ap.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 to reach it from another device)")
  ap.add_argument("--bridge", help="the comma bridge, host or host:port (default port 8088)")
  args = ap.parse_args()
  if args.bridge:
    host, _, port = args.bridge.rpartition(":") if ":" in args.bridge else (args.bridge, "", "")
    BRIDGE = (host, int(port or BRIDGE_PORT))
  ThreadingHTTPServer.daemon_threads = True
  ThreadingHTTPServer.allow_reuse_address = True
  httpd = ThreadingHTTPServer((args.host, args.port), Handler)
  print(f"Oceanscape at http://{args.host}:{args.port}/" + (f", bridge {BRIDGE[0]}:{BRIDGE[1]}" if BRIDGE else ", no bridge (offline)"))
  try:
    httpd.serve_forever()
  except KeyboardInterrupt:
    pass


if __name__ == "__main__":
  main()
