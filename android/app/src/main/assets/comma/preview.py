# What an update would bring (CommaManager /app/comma/preview), run with the AGNOS venv's python after prelude.sh:
# fetches the branch's upstream, then prints one JSON object with the commits the install is behind (and ahead), the
# areas of the tree they touch, the submodules they move and whether openpilot is built on the comma (so a restart
# rebuilds what changed). Nothing in the install changes.
import json
import os
import subprocess

OP = "/data/openpilot"


def sh(*cmd, timeout=30):
  try:
    r = subprocess.run(cmd, cwd=OP, capture_output=True, text=True, timeout=timeout)
  except subprocess.TimeoutExpired:
    return -1, "", f"{cmd[1] if len(cmd) > 1 else cmd[0]} took longer than {timeout} s"
  return r.returncode, r.stdout.strip(), r.stderr.strip()


out = {}
code, _, err = sh("git", "fetch", "--prune", "origin", timeout=120)
if code != 0:
  out["error"] = "couldn't fetch from origin: " + (err.splitlines()[-1] if err else f"exit {code}")
  print(json.dumps(out))
  raise SystemExit(0)

out["branch"] = sh("git", "rev-parse", "--abbrev-ref", "HEAD")[1]
code, upstream, _ = sh("git", "rev-parse", "--abbrev-ref", "@{u}")
if code != 0:
  out["error"] = f"{out['branch']} doesn't follow a branch on origin"
  print(json.dumps(out))
  raise SystemExit(0)
out["upstream"] = upstream
counts = sh("git", "rev-list", "--left-right", "--count", "HEAD...@{u}")[1].split()
out["ahead"], out["behind"] = (int(counts[0]), int(counts[1])) if len(counts) == 2 else (0, 0)

commits = []
log = sh("git", "log", "--format=%h%x1f%s%x1f%an%x1f%cI", "-n", "50", "HEAD..@{u}")[1]
for line in filter(None, log.splitlines()):
  h, subject, author, date = (line.split("\x1f") + ["", "", "", ""])[:4]
  commits.append({"hash": h, "subject": subject, "author": author, "date": date})
out["commits"] = commits

# the areas touched: the first path part (two under selfdrive/ and sunnypilot/, where the parts are the interesting
# level), with how many files each; a submodule shows as its own path
areas = {}
names = sh("git", "diff", "--name-only", "HEAD...@{u}")[1]
for path in filter(None, names.splitlines()):
  parts = path.split("/")
  key = "/".join(parts[:2]) if parts[0] in ("selfdrive", "sunnypilot", "system", "tools") and len(parts) > 2 else parts[0]
  areas[key] = areas.get(key, 0) + 1
out["areas"] = sorted(({"area": k, "files": n} for k, n in areas.items()), key=lambda a: -a["files"])
subs = {line.split()[-1] for line in sh("git", "config", "-f", ".gitmodules", "--get-regexp", r"\.path$")[1].splitlines() if line.strip()}
out["submodules"] = [a["area"] for a in out["areas"] if a["area"] in subs]
out["prebuilt"] = os.path.exists(os.path.join(OP, "prebuilt"))
print(json.dumps(out))
