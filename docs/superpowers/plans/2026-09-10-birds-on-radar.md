# Birds-on-radar Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live nocturnal bird-migration density from NEXRAD radar, rendered as columns on the wildeye globe, refreshed every 10 min by a local cron pipeline.

**Architecture:** A Python pipeline (`pipeline/`) pulls the newest Level II volume per radar from the public AWS bucket `unidata-nexrad-level2`, runs `vol2bird` in Docker (`adokter/vol2bird`) to get a vertical profile, reduces it to one record per site, and atomically writes `public/data/birds.geojson`. A new layer module `src/data/birds.js` (copy of the earthquakes pattern) fetches that file and draws one cylinder per radar.

**Tech Stack:** Python 3 + boto3 (anonymous S3), Docker `adokter/vol2bird`, CesiumJS layer via `DataLayerManager`, `node:test` unit tests (`npm test`), pytest for pipeline.

**Spec:** `docs/superpowers/specs/2026-09-10-birds-on-radar-design.md`

## Global Constraints
- Upstream layers untouched; only add files + the five registration touchpoints.
- Pipeline fails loud: exceptions propagate to the log, never swallowed; per-site failure keeps last-good for that site only.
- Atomic write: tmp file + `os.replace`.
- Max 8 parallel sites. ~20 sites in `pipeline/sites.json`.
- Layer id `birds`, token `n` in `LAYER_STATE_REGISTRY` (must be a letter not already used: a b c e f q d w m g i r x s u t are taken).
- Node 24 runtime for `npm test`.

---

### Task 1: NEXRAD volume selection + download

**Files:**
- Create: `pipeline/__init__.py` (empty), `pipeline/nexrad.py`, `pipeline/sites.json`
- Test: `pipeline/tests/test_nexrad.py`

**Interfaces:**
- Produces: `pick_latest_key(keys: list[str]) -> str | None` (ignores `*_MDM` keys, picks lexicographically greatest `*_V06`); `latest_volume_key(site: str, now: datetime) -> str | None` (lists today then yesterday UTC prefix); `download_volume(key: str, dest_dir: Path) -> Path`.

- [ ] **Step 1: Write failing tests**

```python
# pipeline/tests/test_nexrad.py
from pipeline.nexrad import pick_latest_key

def test_pick_latest_ignores_mdm_and_returns_newest():
    keys = [
        "2026/09/11/KOKX/KOKX20260911_000512_V06",
        "2026/09/11/KOKX/KOKX20260911_001210_V06_MDM",
        "2026/09/11/KOKX/KOKX20260911_001210_V06",
    ]
    assert pick_latest_key(keys) == "2026/09/11/KOKX/KOKX20260911_001210_V06"

def test_pick_latest_empty_is_none():
    assert pick_latest_key([]) is None
    assert pick_latest_key(["x/KOKX20260911_000512_V06_MDM"]) is None
```

- [ ] **Step 2: Run to verify failure**
Run: `cd ~/wildeye && python3 -m pytest pipeline/tests/test_nexrad.py -q`
Expected: ImportError / ModuleNotFoundError.

- [ ] **Step 3: Implement**

```python
# pipeline/nexrad.py
"""Locate and download the newest NEXRAD Level II volume for a radar site."""
from __future__ import annotations
import datetime as dt
from pathlib import Path
import boto3, botocore

BUCKET = "unidata-nexrad-level2"

def _client():
    return boto3.client("s3", config=botocore.config.Config(signature_version=botocore.UNSIGNED))

def pick_latest_key(keys: list[str]) -> str | None:
    vols = [k for k in keys if k.endswith("_V06")]
    return max(vols) if vols else None

def latest_volume_key(site: str, now: dt.datetime | None = None) -> str | None:
    now = now or dt.datetime.now(dt.UTC)
    s3 = _client()
    for day in (now, now - dt.timedelta(days=1)):
        prefix = f"{day:%Y/%m/%d}/{site}/"
        keys, token = [], None
        while True:
            kw = {"Bucket": BUCKET, "Prefix": prefix, "MaxKeys": 1000}
            if token: kw["ContinuationToken"] = token
            r = s3.list_objects_v2(**kw)
            keys += [o["Key"] for o in r.get("Contents", [])]
            token = r.get("NextContinuationToken")
            if not token: break
        key = pick_latest_key(keys)
        if key: return key
    return None

def download_volume(key: str, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / Path(key).name
    if not dest.exists():
        _client().download_file(BUCKET, key, str(dest))
    return dest
```

`pipeline/sites.json` — 20 eastern-flyway sites with lat/lon (from NOAA radar list):
```json
[
 {"id":"KOKX","name":"Upton NY","lat":40.8655,"lon":-72.8639},
 {"id":"KBOX","name":"Boston MA","lat":41.9558,"lon":-71.1369},
 {"id":"KDIX","name":"Philadelphia PA","lat":39.9470,"lon":-74.4108},
 {"id":"KLWX","name":"Sterling VA","lat":38.9753,"lon":-77.4778},
 {"id":"KAKQ","name":"Wakefield VA","lat":36.9840,"lon":-77.0073},
 {"id":"KRAX","name":"Raleigh NC","lat":35.6655,"lon":-78.4899},
 {"id":"KMHX","name":"Morehead City NC","lat":34.7759,"lon":-76.8762},
 {"id":"KLTX","name":"Wilmington NC","lat":33.9892,"lon":-78.4292},
 {"id":"KCLX","name":"Charleston SC","lat":32.6555,"lon":-81.0423},
 {"id":"KJAX","name":"Jacksonville FL","lat":30.4846,"lon":-81.7019},
 {"id":"KMLB","name":"Melbourne FL","lat":28.1133,"lon":-80.6542},
 {"id":"KTBW","name":"Tampa FL","lat":27.7055,"lon":-82.4017},
 {"id":"KBUF","name":"Buffalo NY","lat":42.9489,"lon":-78.7369},
 {"id":"KCLE","name":"Cleveland OH","lat":41.4131,"lon":-81.8597},
 {"id":"KPBZ","name":"Pittsburgh PA","lat":40.5317,"lon":-80.2183},
 {"id":"KILN","name":"Wilmington OH","lat":39.4203,"lon":-83.8217},
 {"id":"KLOT","name":"Chicago IL","lat":41.6045,"lon":-88.0847},
 {"id":"KGRR","name":"Grand Rapids MI","lat":42.8939,"lon":-85.5449},
 {"id":"KOHX","name":"Nashville TN","lat":36.2472,"lon":-86.5625},
 {"id":"KFFC","name":"Atlanta GA","lat":33.3636,"lon":-84.5658}
]
```

- [ ] **Step 4: Run tests; then real-execution check**
Run: `python3 -m pytest pipeline/tests -q` → PASS.
Run: `python3 -c "from pipeline.nexrad import *; from pathlib import Path; k=latest_volume_key('KOKX'); print(k); print(download_volume(k, Path('$CLAUDE_JOB_DIR/tmp/vol')))"` → prints a key and a file path; `ls -la` the file (expect 5–20 MB).

- [ ] **Step 5: Commit** `git add pipeline && git commit -m "feat(pipeline): NEXRAD latest-volume locator and downloader"`

---

### Task 2: vol2bird runner, profile parser, per-site reducer

**Files:**
- Create: `pipeline/vol2bird.py`, `pipeline/tests/fixtures/KOKX_profile.txt`
- Test: `pipeline/tests/test_vol2bird.py`

**Interfaces:**
- Consumes: volume `Path` from Task 1.
- Produces: `run_vol2bird(volume: Path) -> str` (stdout text); `parse_profile(text: str) -> list[dict]` (one dict per height bin: `height_m, u, v, ff, dd, dens, dbz, eta`, NaN → None); `reduce_profile(bins: list[dict]) -> dict` with keys `density_birds_km3` (mean dens over bins 0–3000 m where dens not None), `heading_deg` (dens-weighted mean of `dd`, circular), `speed_ms` (dens-weighted mean `ff`), `peak_altitude_m` (height of max dens), `bins` (count).

- [ ] **Step 1: Produce a real fixture FIRST (this is the external control)**
Run vol2bird in Docker on the file from Task 1:
```bash
V=$CLAUDE_JOB_DIR/tmp/vol
docker run --rm -v "$V":/data adokter/vol2bird vol2bird /data/$(ls $V | head -1) > pipeline/tests/fixtures/KOKX_profile.txt
head -20 pipeline/tests/fixtures/KOKX_profile.txt
```
Read the header line. vol2bird prints columns like:
`# date time HGHT u v w ff dd sd_vvp gap dbz eta dens DBZH n n_dbz n_all n_dbz_all`
followed by rows; NaN appears as `nan` or `NaN`. Confirm the actual header and adjust column names in the parser to match what you see. If the container exits non-zero, print stderr and stop — do not fake a fixture.

- [ ] **Step 2: Write failing tests**

```python
# pipeline/tests/test_vol2bird.py
from pathlib import Path
import math
from pipeline.vol2bird import parse_profile, reduce_profile

FIX = Path(__file__).parent / "fixtures" / "KOKX_profile.txt"

def test_parse_profile_reads_real_fixture():
    bins = parse_profile(FIX.read_text())
    assert len(bins) >= 10
    assert all("height_m" in b and "dens" in b for b in bins)
    assert bins[0]["height_m"] < bins[-1]["height_m"]

def test_reduce_profile_positive_and_negative_control():
    bins = parse_profile(FIX.read_text())
    r = reduce_profile(bins)
    assert r["bins"] == len(bins)
    assert r["density_birds_km3"] is None or r["density_birds_km3"] >= 0
    assert r["heading_deg"] is None or 0 <= r["heading_deg"] < 360
    # negative control: all-None density → None summary, not a crash or 0
    empty = [{**b, "dens": None, "dd": None, "ff": None} for b in bins]
    e = reduce_profile(empty)
    assert e["density_birds_km3"] is None and e["heading_deg"] is None

def test_reduce_profile_circular_mean():
    bins = [
        {"height_m": 200, "dens": 1.0, "dd": 350.0, "ff": 10.0},
        {"height_m": 400, "dens": 1.0, "dd": 10.0, "ff": 10.0},
    ]
    r = reduce_profile(bins)
    assert abs(r["heading_deg"] - 0.0) < 1e-6 or abs(r["heading_deg"] - 360.0) < 1e-6
    assert r["peak_altitude_m"] == 200
```

- [ ] **Step 3: Run to verify failure** — `python3 -m pytest pipeline/tests/test_vol2bird.py -q` → ImportError.

- [ ] **Step 4: Implement**

```python
# pipeline/vol2bird.py
"""Run vol2bird (Docker) and reduce its vertical profile to one record."""
from __future__ import annotations
import math, subprocess
from pathlib import Path

IMAGE = "adokter/vol2bird"
MAX_HEIGHT_M = 3000

def run_vol2bird(volume: Path, timeout_s: int = 300) -> str:
    cmd = ["docker", "run", "--rm", "-v", f"{volume.parent}:/data", IMAGE,
           "vol2bird", f"/data/{volume.name}"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    if p.returncode != 0:
        raise RuntimeError(f"vol2bird failed rc={p.returncode} on {volume.name}: {p.stderr[-2000:]}")
    return p.stdout

def _f(tok: str):
    try:
        v = float(tok)
    except ValueError:
        return None
    return None if math.isnan(v) else v

def parse_profile(text: str) -> list[dict]:
    header, rows = None, []
    for line in text.splitlines():
        s = line.strip()
        if not s: continue
        if s.startswith("#"):
            toks = s.lstrip("#").split()
            if "HGHT" in toks: header = toks
            continue
        if header is None: continue
        toks = s.split()
        if len(toks) < len(header): continue
        col = dict(zip(header, toks))
        rows.append({
            "height_m": _f(col["HGHT"]),
            "u": _f(col.get("u", "nan")), "v": _f(col.get("v", "nan")),
            "ff": _f(col.get("ff", "nan")), "dd": _f(col.get("dd", "nan")),
            "dens": _f(col.get("dens", "nan")), "dbz": _f(col.get("dbz", "nan")),
            "eta": _f(col.get("eta", "nan")),
        })
    rows.sort(key=lambda b: b["height_m"] if b["height_m"] is not None else 1e9)
    return rows

def reduce_profile(bins: list[dict]) -> dict:
    use = [b for b in bins if b.get("height_m") is not None and b["height_m"] <= MAX_HEIGHT_M
           and b.get("dens") is not None]
    out = {"bins": len(bins), "density_birds_km3": None, "heading_deg": None,
           "speed_ms": None, "peak_altitude_m": None}
    if not use: return out
    dens = [b["dens"] for b in use]
    out["density_birds_km3"] = sum(dens) / len(dens)
    peak = max(use, key=lambda b: b["dens"])
    out["peak_altitude_m"] = peak["height_m"]
    w = [(b["dens"], b) for b in use if b.get("dd") is not None and b["dens"] > 0]
    if w:
        sx = sum(d * math.sin(math.radians(b["dd"])) for d, b in w)
        sy = sum(d * math.cos(math.radians(b["dd"])) for d, b in w)
        out["heading_deg"] = math.degrees(math.atan2(sx, sy)) % 360
    ws = [(b["dens"], b["ff"]) for b in use if b.get("ff") is not None and b["dens"] > 0]
    if ws:
        tot = sum(d for d, _ in ws)
        out["speed_ms"] = sum(d * f for d, f in ws) / tot if tot else None
    return out
```

- [ ] **Step 5: Run tests** → PASS. Commit: `git add pipeline && git commit -m "feat(pipeline): vol2bird runner, profile parser, reducer with real fixture"`

---

### Task 3: Orchestrator — parallel sites, last-good, atomic GeoJSON

**Files:**
- Create: `pipeline/build_birds.py`
- Test: `pipeline/tests/test_build.py`

**Interfaces:**
- Consumes: Task 1 `latest_volume_key/download_volume`, Task 2 `run_vol2bird/parse_profile/reduce_profile`.
- Produces: `build_feature(site: dict, record: dict, scan_key: str) -> dict` (GeoJSON Point Feature); `merge_last_good(new: dict[str, dict], previous_geojson: dict | None) -> list[dict]`; `write_atomic(path: Path, obj: dict) -> None`; CLI `python3 -m pipeline.build_birds --out public/data/birds.geojson --workers 8`.

- [ ] **Step 1: Failing tests**

```python
# pipeline/tests/test_build.py
import json
from pathlib import Path
from pipeline.build_birds import build_feature, merge_last_good, write_atomic

SITE = {"id": "KOKX", "name": "Upton NY", "lat": 40.8655, "lon": -72.8639}
REC = {"density_birds_km3": 12.5, "heading_deg": 200.0, "speed_ms": 9.0, "peak_altitude_m": 600, "bins": 20}

def test_build_feature_shape():
    f = build_feature(SITE, REC, "2026/09/11/KOKX/KOKX20260911_001210_V06")
    assert f["type"] == "Feature"
    assert f["geometry"] == {"type": "Point", "coordinates": [-72.8639, 40.8655]}
    assert f["properties"]["site"] == "KOKX"
    assert f["properties"]["density_birds_km3"] == 12.5
    assert f["properties"]["scan_time"] == "2026-09-11T00:12:10Z"
    assert f["properties"]["stale"] is False

def test_merge_last_good_keeps_failed_site_marked_stale():
    prev = {"type": "FeatureCollection", "features": [
        {**build_feature(SITE, REC, "2026/09/10/KOKX/KOKX20260910_235959_V06")}]}
    new = {}  # KOKX failed this run
    feats = merge_last_good(new, prev)
    assert len(feats) == 1 and feats[0]["properties"]["stale"] is True

def test_merge_new_overrides_prev():
    prev = {"type": "FeatureCollection", "features": [build_feature(SITE, REC, "2026/09/10/KOKX/KOKX20260910_235959_V06")]}
    fresh = build_feature(SITE, {**REC, "density_birds_km3": 1.0}, "2026/09/11/KOKX/KOKX20260911_001210_V06")
    feats = merge_last_good({"KOKX": fresh}, prev)
    assert feats[0]["properties"]["density_birds_km3"] == 1.0 and feats[0]["properties"]["stale"] is False

def test_write_atomic(tmp_path: Path):
    p = tmp_path / "b.geojson"
    write_atomic(p, {"a": 1})
    assert json.loads(p.read_text()) == {"a": 1}
    assert not list(tmp_path.glob("*.tmp"))
```

- [ ] **Step 2: Run → ImportError.**

- [ ] **Step 3: Implement**

```python
# pipeline/build_birds.py
"""Build public/data/birds.geojson from the newest NEXRAD volume per site."""
from __future__ import annotations
import argparse, datetime as dt, json, logging, os, re, tempfile, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from .nexrad import latest_volume_key, download_volume
from .vol2bird import run_vol2bird, parse_profile, reduce_profile

log = logging.getLogger("birds")
HERE = Path(__file__).parent
SITES = json.loads((HERE / "sites.json").read_text())
_TS = re.compile(r"(\d{8})_(\d{6})")

def scan_time_from_key(key: str) -> str:
    m = _TS.search(key)
    if not m: raise ValueError(f"no timestamp in key {key}")
    d, t = m.groups()
    return f"{d[:4]}-{d[4:6]}-{d[6:]}T{t[:2]}:{t[2:4]}:{t[4:]}Z"

def build_feature(site: dict, record: dict, scan_key: str) -> dict:
    return {"type": "Feature",
            "geometry": {"type": "Point", "coordinates": [site["lon"], site["lat"]]},
            "properties": {"site": site["id"], "name": site["name"],
                           "scan_time": scan_time_from_key(scan_key), "stale": False, **record}}

def merge_last_good(new: dict[str, dict], previous_geojson: dict | None) -> list[dict]:
    out = dict(new)
    for f in (previous_geojson or {}).get("features", []):
        sid = f["properties"]["site"]
        if sid not in out:
            g = json.loads(json.dumps(f)); g["properties"]["stale"] = True; out[sid] = g
    return [out[k] for k in sorted(out)]

def write_atomic(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w") as fh: json.dump(obj, fh, separators=(",", ":"))
    os.replace(tmp, path)

def process_site(site: dict, workdir: Path) -> dict:
    key = latest_volume_key(site["id"])
    if not key: raise RuntimeError(f"{site['id']}: no volume found for today/yesterday")
    vol = download_volume(key, workdir / site["id"])
    rec = reduce_profile(parse_profile(run_vol2bird(vol)))
    return build_feature(site, rec, key)

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--workdir", type=Path, default=Path(os.environ.get("WILDEYE_WORK", "/tmp/wildeye-nexrad")))
    ap.add_argument("--sites", type=int, default=None, help="limit to first N sites")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sites = SITES[: a.sites] if a.sites else SITES
    prev = json.loads(a.out.read_text()) if a.out.exists() else None
    t0 = time.time(); new, failures = {}, {}
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(process_site, s, a.workdir): s for s in sites}
        for fut in as_completed(futs):
            s = futs[fut]
            try:
                new[s["id"]] = fut.result(); log.info("%s ok dens=%s", s["id"], new[s["id"]]["properties"]["density_birds_km3"])
            except Exception as e:  # logged loud, last-good keeps the site
                failures[s["id"]] = repr(e); log.error("%s FAILED: %r", s["id"], e)
    fc = {"type": "FeatureCollection",
          "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
          "site_count": len(sites), "fresh_count": len(new), "failures": failures,
          "features": merge_last_good(new, prev)}
    write_atomic(a.out, fc)
    log.info("wrote %s fresh=%d stale=%d wall=%.0fs", a.out, len(new), len(fc["features"]) - len(new), time.time() - t0)
    if not new: raise SystemExit("every site failed")

if __name__ == "__main__": main()
```

- [ ] **Step 4: Tests PASS; real-execution run on 2 sites**
`python3 -m pipeline.build_birds --out public/data/birds.geojson --sites 2 --workers 2` → log shows both ok, wall time noted; `python3 -c "import json;d=json.load(open('public/data/birds.geojson'));print(d['fresh_count'],[f['properties']['density_birds_km3'] for f in d['features']])"`.
Add `public/data/birds.geojson` to `.gitignore`? No — commit it so the layer has data on a fresh clone; the cron overwrites it. Add `/tmp/wildeye-nexrad` nothing needed.

- [ ] **Step 5: Commit** `git add pipeline public/data/birds.geojson && git commit -m "feat(pipeline): orchestrator with parallel sites, last-good merge, atomic write"`

---

### Task 4: `birds.js` layer + registration

**Files:**
- Create: `src/data/birds.js`, `src/data/birds.test.mjs`
- Modify: `src/main.js:210-228` (register), `src/data/layerState.js:278-295` (registry entry), `src/data/dataCredits.js` (credit), `src/voice/gevActions.js:145` (`LAYER_ALIASES`)

**Interfaces:**
- Consumes: `data/birds.geojson` as written by Task 3.
- Produces: `export function mapBirdRecord(raw, index)`; `export function birdColumn(density) -> number` (height m); `export function headingColor(deg) -> Cesium.Color`; `createBirdsLayer()`; default export layer with id `'birds'`.

- [ ] **Step 1: Failing test**

```js
// src/data/birds.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBirdRecord, birdColumn, headingColor, createBirdsLayer } from './birds.js';

test('birds: analyst record maps fields and nulls', () => {
  const r = mapBirdRecord({ site: 'KOKX', name: 'Upton NY', density_birds_km3: 12.5, heading_deg: 200, speed_ms: 9, peak_altitude_m: 600, scan_time: '2026-09-11T00:12:10Z', stale: false, lat: 40.9, lon: -72.9 }, 0);
  assert.deepEqual(r, { id: 'KOKX', name: 'Upton NY', densityBirdsKm3: 12.5, headingDeg: 200, speedMs: 9, peakAltitudeM: 600, scanTime: '2026-09-11T00:12:10Z', stale: false, lat: 40.9, lon: -72.9 });
  const n = mapBirdRecord({ density_birds_km3: NaN }, 4);
  assert.equal(n.id, 'RADAR-0004'); assert.equal(n.densityBirdsKm3, null);
});

test('birds: column height is monotone, floored, capped', () => {
  assert.equal(birdColumn(null), 0);
  assert.ok(birdColumn(1) < birdColumn(50));
  assert.ok(birdColumn(1e6) <= 200000);
});

test('birds: layer contract', () => {
  const l = createBirdsLayer();
  assert.equal(l.id, 'birds');
  for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords']) assert.equal(typeof l[k], 'function');
  assert.deepEqual(l.getAnalystRecords(), []);
});
```

- [ ] **Step 2: `npm test` → fails on missing module.**

- [ ] **Step 3: Implement `src/data/birds.js`**

```js
import * as Cesium from 'cesium';

/**
 * Nocturnal bird migration density per NEXRAD radar, produced by
 * pipeline/build_birds.py (vol2bird on Level II volumes). One column per
 * radar: height ∝ density, hue = heading. Static geometry between polls.
 */
const DATA_URL = 'data/birds.geojson';
const MAX_COLUMN_M = 200000;
const BASE_RADIUS_M = 25000;

export function birdColumn(density) {
  const d = Number(density);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.min(MAX_COLUMN_M, 8000 * Math.log1p(d));
}

export function headingColor(deg) {
  const h = Number(deg);
  if (!Number.isFinite(h)) return Cesium.Color.GRAY;
  return Cesium.Color.fromHsl(((h % 360) + 360) % 360 / 360, 0.9, 0.55);
}

export function mapBirdRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  return {
    id: text(raw?.site) || `RADAR-${String(index).padStart(4, '0')}`,
    name: text(raw?.name),
    densityBirdsKm3: num(raw?.density_birds_km3),
    headingDeg: num(raw?.heading_deg),
    speedMs: num(raw?.speed_ms),
    peakAltitudeM: num(raw?.peak_altitude_m),
    scanTime: text(raw?.scan_time),
    stale: Boolean(raw?.stale),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
  };
}

export function createBirdsLayer() {
  let _dataSource = null, _count = 0, _lastUpdate = null, _lastError = null, _generatedAt = null;
  const layer = {
    id: 'birds',
    name: 'Bird migration (radar)',
    icon: '🐦',
    source: 'NEXRAD via vol2bird',
    updateInterval: 600000,
    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('birds');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:Birds] Initialized');
    },
    enable() { if (_dataSource) _dataSource.show = true; },
    disable() { if (_dataSource) _dataSource.show = false; },
    async update() {
      try {
        const res = await fetch(`${DATA_URL}?t=${Date.now()}`);
        if (!res.ok) { _lastError = `birds.geojson HTTP ${res.status}`; return false; }
        const gj = await res.json();
        if (!gj || !Array.isArray(gj.features)) { _lastError = 'Malformed birds.geojson'; return false; }
        _dataSource.entities.removeAll();
        let count = 0;
        for (const f of gj.features) {
          const [lon, lat] = f.geometry.coordinates;
          const p = f.properties || {};
          const h = birdColumn(p.density_birds_km3);
          const color = headingColor(p.heading_deg).withAlpha(p.stale ? 0.25 : 0.6);
          count++;
          _dataSource.entities.add({
            id: `birds:${p.site}`,
            position: Cesium.Cartesian3.fromDegrees(lon, lat, h / 2),
            cylinder: { length: Math.max(h, 500), topRadius: BASE_RADIUS_M, bottomRadius: BASE_RADIUS_M,
              material: new Cesium.ColorMaterialProperty(color), outline: true, outlineColor: color.withAlpha(0.9) },
            description: `<b>${p.name ?? p.site}</b> (${p.site})<br>` +
              (h > 0 ? `${Number(p.density_birds_km3).toFixed(1)} birds/km³, heading ${Math.round(p.heading_deg)}°, ${Number(p.speed_ms ?? 0).toFixed(0)} m/s, peak ${p.peak_altitude_m} m`
                     : 'Quiet — no migration signal (daytime or clear)') +
              `<br>scan ${p.scan_time}${p.stale ? ' (stale, last good)' : ''}`,
            properties: { ...p, lat, lon },
          });
        }
        _count = count; _generatedAt = gj.generated_at ?? null; _lastUpdate = Date.now(); _lastError = null;
        console.log(`[Data:Birds] Updated: ${count} radars, generated ${_generatedAt}`);
        return true;
      } catch (e) {
        console.warn('[Data:Birds] Fetch error:', e); _lastError = 'birds.geojson network error'; return false;
      }
    },
    destroy(viewer) {
      if (_dataSource) { viewer.dataSources.remove(_dataSource, true); _dataSource = null; }
      _count = 0; _lastUpdate = null; _lastError = null;
    },
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const now = Cesium.JulianDate.now();
      return _dataSource.entities.values.slice(0, maxCount).map((e, i) => {
        const p = e.properties;
        const get = (k) => p?.[k]?.getValue(now);
        return mapBirdRecord({ site: get('site'), name: get('name'), density_birds_km3: get('density_birds_km3'),
          heading_deg: get('heading_deg'), speed_ms: get('speed_ms'), peak_altitude_m: get('peak_altitude_m'),
          scan_time: get('scan_time'), stale: get('stale'), lat: get('lat'), lon: get('lon') }, i);
      });
    },
    getStats() { return { count: _count, lastUpdate: _lastUpdate, error: _lastError, generatedAt: _generatedAt }; },
  };
  return layer;
}

const birdsLayer = createBirdsLayer();
export default birdsLayer;
```

- [ ] **Step 4: Registration edits (exact)**
  - `src/main.js`: add `import birdsLayer from './data/birds.js';` next to the earthquakes import; add `dataManager.register(birdsLayer);` after `dataManager.register(earthquakesLayer);`.
  - `src/data/layerState.js` registry: insert `Object.freeze({ id: 'birds', token: 'n', disposition: 'enabled-only' }),` after the `bikeshare` line (alphabetical). Check `grep -n "token: 'n'" src/data/layerState.js` returns only the new line.
  - `src/data/dataCredits.js`: add `{ key: 'nexrad-vol2bird', html: 'Bird migration: NOAA NEXRAD Level II (AWS Open Data) processed with <a href="https://github.com/adokter/vol2bird" target="_blank" rel="noopener">vol2bird</a>' },` after the `usgs` entry.
  - `src/voice/gevActions.js` `LAYER_ALIASES`: add `['birds', 'birds'], ['bird migration', 'birds'], ['migration', 'birds'], ['radar birds', 'birds'],`.

- [ ] **Step 5: `npm test` → all PASS (existing layerState tests may assert registry size/tokens — if one fails, update its expected list to include `birds`/`n`, that is a legitimate pinned-test update because the registry deliberately grew).** Then `npm run dev`, open the app, toggle "Bird migration (radar)", confirm columns appear at the two sites written in Task 3. Screenshot via the Windows viewer rule if needed.

- [ ] **Step 6: Commit** `git add src && git commit -m "feat(layer): bird migration radar layer with registry, credits, voice aliases"`

---

### Task 5: Cron + docs

**Files:**
- Create: `pipeline/run_birds.sh`, `pipeline/README.md`
- Modify: `README.md` (one "wildeye" section at top), `DATA_SOURCES.md` (NEXRAD row)

- [ ] **Step 1: Launcher**
```bash
#!/usr/bin/env bash
# pipeline/run_birds.sh — cron entry: refresh public/data/birds.geojson
set -euo pipefail
cd "$(dirname "$0")/.."
exec timeout 540 python3 -m pipeline.build_birds --out public/data/birds.geojson --workers 8
```
`chmod +x pipeline/run_birds.sh`; run it once by hand on all 20 sites, record wall time in `pipeline/README.md`. If wall > 480 s, lower `--workers` or sites and record why.

- [ ] **Step 2: Cron** — `crontab -l` first, then append `*/10 * * * * ~/wildeye/pipeline/run_birds.sh >> ~/wildeye/pipeline/cron.log 2>&1`. Add `pipeline/cron.log` and `/tmp` workdir to `.gitignore`. Verify after 10 min: `tail pipeline/cron.log` shows a "wrote" line and `generated_at` advanced.

- [ ] **Step 3: Docs** — `pipeline/README.md`: prerequisites (docker, boto3), commands, output schema (property names from Task 3), cadence, known limits (CONUS, nocturnal, 20 sites). README top section: what wildeye is, upstream credit, the birds layer. DATA_SOURCES.md row for NEXRAD (public domain) + vol2bird (LGPL).

- [ ] **Step 4: Commit** `git add -A && git commit -m "feat(pipeline): cron launcher and docs for birds layer"`
