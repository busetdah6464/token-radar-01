#!/usr/bin/env python3
"""Local gate check for token-radar-01. Usage: check-gate.py <output-dir> <snapshot.json>
Checks (from RULES.txt): board rows/shape/rank order/watchlist/farm_steps,
dashboard files + no http(s) addresses, screenshots size/dimensions,
dossier.json byte-identical to buildDossier(dir, {text_max_bytes: 65536})."""
import json, os, re, struct, subprocess, sys, tempfile

fails, passes = [], []
def check(name, ok, detail=""):
    (passes if ok else fails).append(name)
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

out, snap_path = sys.argv[1], sys.argv[2]
snap = json.load(open(snap_path))
slugs = {p["slug"] for p in snap["protocols"]}
watchlist = snap["watchlist"]

board = json.load(open(os.path.join(out, "board.json")))
rows = board["rows"] if isinstance(board, dict) else board
check("board: 100-4000 rows", 100 <= len(rows) <= 4000, f"{len(rows)} rows")
check("board: <=8MiB", os.path.getsize(os.path.join(out, "board.json")) <= 8 * 1024 * 1024)
ok = True
seen = set()
for r in rows:
    if (not isinstance(r.get("slug"), str) or not r["slug"] or re.search(r"\s", r["slug"])
            or r["slug"] not in slugs or r["slug"] in seen
            or not isinstance(r.get("name"), str) or not r["name"]
            or not isinstance(r.get("rank"), int) or r["rank"] < 1
            or not isinstance(r.get("implied_value_usd"), int) or not 0 < r["implied_value_usd"] <= 10**14
            or not isinstance(r.get("farm_steps"), list)):
        ok = False; print("  bad row:", {k: r.get(k) for k in ("slug", "rank", "implied_value_usd")}); break
    seen.add(r["slug"])
check("board: rows well-formed, slugs unique + in snapshot", ok)
check("board: ranks exactly 1..N", sorted(r["rank"] for r in rows) == list(range(1, len(rows) + 1)))
check("board: implied non-increasing with rank",
      all(rows[i]["implied_value_usd"] <= rows[i-1]["implied_value_usd"]
          for i in range(1, len(rows)) if rows[i]["rank"] == rows[i-1]["rank"] + 1)
      and len({r["implied_value_usd"] for r in rows}) > 1,
      f"top {rows[0]['implied_value_usd']:,} -> bottom {rows[-1]['implied_value_usd']:,}")
covered = {r["slug"] for r in rows}
check("coverage: watchlist 40/40", all(s in covered for s in watchlist),
      f"{sum(s in covered for s in watchlist)}/{len(watchlist)}")
bad = [(r["slug"], len(s.strip())) for r in rows for s in r["farm_steps"]
       if not (20 <= len(s.strip()) <= 600)]
badn = [(r["slug"], len(r["farm_steps"])) for r in rows if not 3 <= len(r["farm_steps"]) <= 12]
check("farm_steps: 3-12 steps, each 20-600 chars", not bad and not badn,
      f"{len(rows)} rows, {sum(len(r['farm_steps']) for r in rows)} steps" +
      (f"; bad: {bad[:3]} {badn[:3]}" if bad or badn else ""))

dash = os.path.join(out, "dashboard")
files = [os.path.join(dp, f) for dp, _, fs in os.walk(dash) for f in fs]
check("dashboard: index.html + >=1 css + >=1 js",
      os.path.exists(os.path.join(dash, "index.html"))
      and any(f.endswith(".css") for f in files) and any(f.endswith(".js") for f in files),
      f"{len(files)} files, {sum(os.path.getsize(f) for f in files)} bytes")
check("dashboard: <=400 files, <=4MiB", len(files) <= 400 and sum(os.path.getsize(f) for f in files) <= 4 * 1024 * 1024)
badhttp = [f for f in files if "http://" in open(f, errors="ignore").read() or "https://" in open(f, errors="ignore").read()]
check("dashboard: no http:// or https:// anywhere in source", not badhttp, str(badhttp))

def png_size(path):
    with open(path, "rb") as fh:
        head = fh.read(33)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])

shots = sorted(f for f in os.listdir(os.path.join(out, "screenshots")) if not f.startswith("."))
check("screenshots: 3-4 images", 3 <= len(shots) <= 4, str(shots))
sok = True
for s in shots:
    p = os.path.join(out, "screenshots", s)
    dim = png_size(p)
    if not (os.path.getsize(p) <= 512 * 1024 and dim and max(dim) <= 1440 and min(dim) >= 800):
        sok = False; print("  bad shot:", s, os.path.getsize(p), dim)
check("screenshots: each <=512KiB, long side <=1440, short side >=800", sok)

dossier = open(os.path.join(out, "dossier.json"), "rb").read()
check("dossier: <=1.5MiB", len(dossier) <= 1_500_000, f"{len(dossier)} bytes")
repo = os.path.dirname(os.path.abspath(__file__))
mjs = ("import { writeFileSync } from 'node:fs';\n"
       f"import {{ buildDossier }} from '{repo}/vendor/makefun-board.ts';\n"
       "writeFileSync(process.argv[3], buildDossier(process.argv[2], { text_max_bytes: 65536 }));\n")
with tempfile.NamedTemporaryFile("w", suffix=".mjs", dir="/tmp", delete=False) as tf:
    tf.write(mjs); mjs_path = tf.name
rebuilt_path = mjs_path + ".dossier.json"
r = subprocess.run(["node", mjs_path, out, rebuilt_path], cwd=repo, capture_output=True, text=True)
if r.returncode != 0:
    check("dossier: rebuilds with buildDossier", False, r.stderr.strip()[:300])
else:
    rebuilt = open(rebuilt_path, "rb").read()
    check("dossier: byte-identical to buildDossier(out, {text_max_bytes: 65536})", rebuilt == dossier,
          f"ours {len(dossier)} bytes, rebuilt {len(rebuilt)} bytes")

print(f"\n{len(passes)} passed, {len(fails)} failed" + (f": {fails}" if fails else " — ALL GATE CHECKS PASS"))
sys.exit(1 if fails else 0)
