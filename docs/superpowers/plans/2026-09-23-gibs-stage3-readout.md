# GIBS stage 3: point readout + measured known-answer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WHAT LIVES HERE click also says what every enabled GIBS layer holds at that spot. Each value comes with its own date, e.g. "🗺️ Land cover: Evergreen Broadleaf Forests · 2024" or "♨️ Surface temp: 27.3 °C · 2026-08-21". A measured check then shows that night lights rank by land-cover class as expected.

**Architecture:** GIBS tiles are palette PNGs. Every opaque pixel is exactly one colormap entry, and no two entries share a colour (probe 2026-09-23: land cover 19/19, EVI 135/135, LST 253/253 unique colours; exact-match 1.0000 at native zoom and 3 levels below). GIBS sends `access-control-allow-origin: *` and exposes `layer-time-actual`. So a readout fetches the one tile under the point at the layer's `maximumLevel` for its shown date, reads the one pixel, and looks the RGB up in a decode table. The pipeline writes that table into `gibs.json`. The rendered globe is never read, because it is alpha-blended and filtered.

**Tech Stack:** vanilla JS ES modules, Cesium 1.138.0, `node:test` under node24, Python 3 + pytest for the pipeline, and puppeteer SwiftShader under `heavy-run` for live QA.

**Spec:** `~/.claude/projects/-home-mjarnold/memory/grill_wildeye_gibs_wave_2026-09-22.md`: Q2, Q6 (measured half), A7/A16, A8, A13, A14, A18, A19. Stage-2 plan for conventions: `docs/superpowers/plans/2026-09-23-gibs-stage2-compare.md`.

## Global Constraints

- Values come from GIBS colormaps (A13). Black Marble has no colormap, so it is listed as "view only" with no value (A8).
- Each value is labelled with ITS OWN date: the date the layer is showing (`getStats().time`). If the tile's `layer-time-actual` header disagrees, the header wins and a `console.error` names both (A7/A16).
- The readout extends WHAT LIVES HERE's armed one-shot click (A14, `src/bio/whatLivesHere.js:178-193`). No new click mode. GBIF behaviour is unchanged: the existing whatLivesHere/detailsCard tests stay green unedited.
- Tiles are fetched browser-direct from GIBS and never re-hosted (A1).
- Decoding must be exact: `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })` and a `getImageData` of one pixel. An RGB not in the table is reported as `unknown colour r,g,b` and never snapped to a nearest neighbour.
- Acceptance = `scripts/qa-readout.mjs` and `scripts/qa-known-answer.mjs` both exit 0 against the live site (A18). Deploy = merge to `main-wildeye`, then `pipeline/deploy_pages.sh` (A19).
- Tests: `PATH="$HOME/.local/node24/bin:$PATH" npm test` (baseline 3035 pass / 0 fail @3d16754); `python3 -m pytest pipeline/tests/test_gibs.py`.
- No new dependencies. No `text-transform: uppercase` over unit strings. House rules in `CLAUDE.md` §3.

## Review Focus

1. **Clouds and no-data pixels.** An 8-day LST composite has transparent holes (Delhi 2026-08-21 is one). The row must say "no data here on 2026-08-21", not show a blank, "0", or the previous composite's value. Test: Task 2 "a transparent pixel is no data".
2. **A gap in the time bar.** A layer scrubbed to before its first date shows no imagery (`_gap`). Its row must say "no data at or before <date>" and must not fetch a tile. Test: Task 3 "a layer in a gap reads no tile".
3. **The click lands while the tile is slow or GIBS is down.** The layer rows must not block or replace the GBIF list, and a failed fetch must show `⚠ <error>` on that row only. Test: Task 4 "a failed readout marks its row, the species list still shows".
4. **Clicks near ±180° and the poles.** Tile math must wrap longitude, and a latitude outside ±85.0511° (web-mercator limit) must be reported as "outside the map", not NaN. Test: Task 2 tile-math cases.
5. **Open-ended end bins.** LST's top bin is `[350.02, 652.00)` K. A midpoint of 501 K would be a lie, so a bin wider than 10× the median bin width reads "≥ lo" (top) or "< hi" (bottom). Test: Task 2 "an open-ended bin reads as a bound".

## Rulings made while planning (surface to the user at handoff)

- **LST is shown in °C.** Tenths of a degree, with K in the tooltip: `27.3 °C`. Kelvin is the source unit, but a reader thinks in °C. Cost if wrong: one format string.
- **The value shown is the bin midpoint,** at a precision of one significant figure of the bin width (EVI ≈0.0075 → 2 dp; LST 0.6 K → 1 dp). Cost if wrong: a format function.
- **Q6's measured pass criteria, pre-registered here, before any run:**
  - (a) Urban and Built-up (IGBP 13) has the highest mean Black Marble luminance of every class with n ≥ 30.
  - (b) Pooled forest (IGBP 1–5) has a lower mean luminance than every other land class with n ≥ 30, excluding Water (0/17) and Barren (16). Water and Barren are unlit by construction, and Q6's intent is the urban/forest contrast.
  - The full per-class ranking is printed either way. A failure is a finding to report, not a threshold to retune.
  - Cost if wrong: the literal "forest darkest" reading was stricter, and Barren could tie it.

## File map

- Modify `pipeline/gibs.py`: `parse_colormap` also returns `decode` (Task 1). Test: `pipeline/tests/test_gibs.py`.
- Create `src/data/gibsReadout.js`: tile math, decode, value format, and the browser tile-pixel loader (Task 2). Test: `src/data/gibsReadout.test.mjs`.
- Modify `src/data/gibsLayer.js`: `readoutAt(lat, lon)` on every GIBS layer (Task 3). Test: `src/data/gibsLayer.readout.test.mjs`.
- Modify `src/bio/detailsCard.js`: a `setLayers(rows)` block that survives `showStatus`/`showList` for one search (Task 4). Modify `src/bio/whatLivesHere.js`: take `readLayers({lat, lon, signal})`, call it at the start of `run` and push rows to the card. Modify `src/main.js`: wire it and expose `window.__godsEyeView.readoutAt(lat, lon)`.
- Create `scripts/qa-readout.mjs`: the live acceptance check (Task 5).
- Create `scripts/qa-known-answer.mjs`: the measured Q6 check (Task 6).

---

### Task 1: The pipeline ships a decode table

**Files:** Modify `pipeline/gibs.py:116-145` (`parse_colormap`). Test: `pipeline/tests/test_gibs.py`. Add the fixture `pipeline/tests/fixtures/gibs_colormap_evi.xml`, a verbatim copy of `https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_L3_EVI.xml` (real corpus, not hand-written).

**Interfaces — Produces:**

- `gibs.json` → `layers[id].decode`. For ramp layers it is a list of `[r, g, b, lo, hi]`, one per non-nodata entry of the data ColorMap, in file order. `lo`/`hi` are floats parsed from `value="[lo,hi)"`.
- For class layers, `decode` is absent: the existing `classes` list (`{label, rgb}`) is the table.
- Nightlights has neither.

- [ ] **Step 1: Write the failing tests**

```python
def test_ramp_decode_table_is_every_data_entry_with_its_interval():
    cm = g.parse_colormap((FIX / "gibs_colormap_ramp.xml").read_bytes())  # LST, K
    d = cm["decode"]
    assert len(d) == 252  # 253 entries minus the one nodata entry
    assert d[-1] == [255, 1, 0, 350.02, 652.0]
    assert all(len(e) == 5 and e[3] < e[4] for e in d)
    assert len({tuple(e[:3]) for e in d}) == len(d)  # exact lookup needs unique colours
    assert cm["ramp"]["stops"][-1] == [255, 1, 0]  # the legend is unchanged


def test_evi_decode_table_from_the_real_colormap():
    cm = g.parse_colormap((FIX / "gibs_colormap_evi.xml").read_bytes())
    d = cm["decode"]
    assert d[-1] == [0, 0, 1, 0.9751, 1.0001]
    assert not any(e[3] < -0.2 for e in d)  # the nodata "Classifications" map is not in it


def test_class_layers_carry_no_decode_table():
    cm = g.parse_colormap((FIX / "gibs_colormap_classes.xml").read_bytes())
    assert "decode" not in cm and len(cm["classes"]) == 18
```

- [ ] **Step 2: Run them to see them fail.** Run `python3 -m pytest pipeline/tests/test_gibs.py -q`. Expected: 3 new failures, `KeyError: 'decode'` (and a missing fixture until it is copied: copy it first with `curl -s -o pipeline/tests/fixtures/gibs_colormap_evi.xml https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_L3_EVI.xml`).

- [ ] **Step 3: Implement.** In the ramp branch of `parse_colormap`, read every `ColorMapEntry` of the chosen data `cm` whose `nodata != "true"`, and parse `value` with `re.fullmatch(r"\[(-?[\d.]+),(-?[\d.]+)\)", v)`. A non-match raises `ValueError(f"unparseable colour-map value {v!r}")`. Return `{"ramp": {...}, "decode": [...]}`.

- [ ] **Step 4: Pass.** Run the same command. Expected: all pass. Then do the real-execution check: `python3 -m pipeline.gibs --out /tmp/gibs-check.json && python3 -c "import json;d=json.load(open('/tmp/gibs-check.json'))['layers'];print({k:len(v.get('decode',[])) for k,v in d.items()})"`. Expected: evi 134, lst 252, biomass > 0, landcover 0, nightlights 0.

- [ ] **Step 5: Commit.** `git add pipeline/gibs.py pipeline/tests/ && git commit -m "gibs.json carries each ramp layer's full decode table (value interval per colour)"`

### Task 2: Tile math, decode and format (`src/data/gibsReadout.js`)

**Interfaces — Produces:**

- `tilePixel(lat, lon, z) → {x, y, px, py} | null`: 256-px web-mercator tile and pixel. Returns null outside ±85.05112878°. Longitude is wrapped.
- `decodePixel(entry, [r,g,b,a]) → {kind:'class', label} | {kind:'value', lo, hi, text} | {kind:'nodata'} | {kind:'unknown', rgb}`.
- `formatValue(entry, lo, hi) → string`.
- `createTilePixelReader({ fetchImpl = fetch, cacheSize = 32 }) → async (url, px, py) → {rgba, timeActual}`. It uses the browser's `createImageBitmap` + `OffscreenCanvas`. It is injected so node tests pass a fake.
- `gibsTileRequest(entry, date, lat, lon) → {url, px, py} | null`: uses `gibsTileUrl` from `gibsLayer.js`, with `{z}/{y}/{x}` filled at `entry.maximumLevel`.

- [ ] **Step 1: Write the failing tests** (`src/data/gibsReadout.test.mjs`). Use real entries copied from the live `public/data/gibs.json`, trimmed to what each test needs:

```js
test("tile math matches the Python probe: Chicago at z8 and a wrap past 180", () => {
  assert.deepEqual(tilePixel(41.88, -87.63, 8), {
    x: 65,
    y: 95,
    px: 175,
    py: 37,
  }); // python probe math, 2026-09-23
  assert.deepEqual(tilePixel(0, 180, 2), tilePixel(0, -180, 2));
  assert.equal(tilePixel(86, 0, 5), null);
});
test("a class pixel decodes to its NASA label", () => {
  /* rgb 49,204,49 → Evergreen Broadleaf Forests */
});
test("a ramp pixel decodes to its interval and a midpoint text", () => {
  /* EVI [0.4251,0.4326) → "0.43" */
});
test("LST reads in °C with one decimal", () => {
  /* [298.40,299.00) K → "25.6 °C" (midpoint 298.7 K) */
});
test("an open-ended bin reads as a bound", () => {
  /* LST top bin → "≥ 76.9 °C" */
});
test("a transparent pixel is no data; an unknown colour is named, never snapped", () => {
  assert.equal(decodePixel(evi, [0, 26, 105, 0]).kind, "nodata");
  assert.deepEqual(decodePixel(evi, [1, 2, 3, 255]), {
    kind: "unknown",
    rgb: [1, 2, 3],
  });
  assert.equal(decodePixel(evi, [0, 0, 1, 255]).kind, "value"); // positive control in the same test
});
test("the tile reader caches by URL and returns the layer-time-actual header", async () => {
  /* fake fetchImpl counts calls */
});
```

- [ ] **Step 2: Run it to see it fail.** `node --test src/data/gibsReadout.test.mjs`. Expected: fails on the missing module. (Chicago z8 = tile 65/95, pixel 175,37, from the probe's own math.)

- [ ] **Step 3: Implement** `src/data/gibsReadout.js` to the interfaces above. The class lookup keys `entry.classes` by `rgb.join(',')`; the ramp lookup keys `entry.decode` the same way. Build both maps once per entry (WeakMap cache).

- [ ] **Step 4: Pass.** Run `node --test src/data/gibsReadout.test.mjs`. Expected: all pass.

- [ ] **Step 5: Commit.** `feat: exact GIBS pixel decode (palette tiles, colormap lookup)`

### Task 3: Every GIBS layer can read itself at a point

**Files:** Modify `src/data/gibsLayer.js` (factory `createGibsLayer`, add `readTilePixel` to its options, default `createTilePixelReader()`). Test: `src/data/gibsLayer.readout.test.mjs`.

**Interfaces:**

- Consumes: Task 2.
- Produces: `layer.readoutAt(lat, lon) → Promise<{id, name, icon, date, text | null, status: 'value'|'class'|'nodata'|'gap'|'viewonly'|'outside'|'error', error?}>`.

- [ ] **Step 1: Failing tests**:
  - "a layer reads its shown date's tile": the fake reader records the URL, and the URL contains `_shownDate`.
  - "a layer in a gap reads no tile": status `gap`, reader not called.
  - "night lights is view only": status `viewonly`, reader not called.
  - "a header date that disagrees wins and is logged".
  - "a disabled layer reads nothing" (the caller filters, but the layer also returns null).
- [ ] **Step 2: Run them.** Expected: FAIL, `readoutAt is not a function`.
- [ ] **Step 3: Implement.** It uses `_entry`, `_shownDate`, `_gap` and `_enabled`. There is no colormap when neither `classes` nor `decode` exists → `viewonly`.
- [ ] **Step 4: Run them.** Expected: pass. Also run `node --test src/data/gibsLayer*.test.mjs`: the stage-1 tests stay green unedited.
- [ ] **Step 5: Commit.**

### Task 4: "What's here": layer rows on the WHAT LIVES HERE card

**Files:**

- Modify `src/bio/detailsCard.js`: add `setLayers(rows)`. It renders a `<ul class="bio-card-layers">` above `body`. `reset()` does NOT clear it; `setLayers([])` and `close()` do.
- Modify `src/bio/whatLivesHere.js`: add the option `readLayers = null`. In `run()`, before the GBIF await, call `card.setLayers(pending rows)`, then call `readLayers({lat, lon, signal})` and `card.setLayers(rows)` when it settles. An abort drops the result silently.
- Modify `src/main.js`: `readLayers` = every enabled layer in `gibsLayers` → `readoutAt`, in `Promise.allSettled`. A rejected readout becomes an `error` row. Add `window.__godsEyeView.readoutAt = (lat, lon) => readLayers({lat, lon})`.
- Modify `style.css`: `.bio-card-layers` rows. Do not use uppercase.
- Tests: `src/bio/whatLivesHere.layers.test.mjs` and `src/bio/detailsCard.layers.test.mjs`.

**Row text:**

- `${icon} ${name}: ${text} · ${date}`.
- `nodata` → `no data here on ${date}`.
- `gap` → `no data at or before ${observed}`.
- `viewonly` → `view only (no values)`.
- `error` → `⚠ ${error}`.

- [ ] **Step 1: Failing tests**:
  - "the layer rows show while GBIF is still searching and stay when the list arrives";
  - "a failed readout marks its row, the species list still shows";
  - "a newer click drops the older click's late rows";
  - "no GIBS layer on → no layer block";
  - "close() clears the rows".
- [ ] **Step 2: Run them.** Expected: FAIL on `setLayers`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then run the whole suite.** Expected: pass; `npm test` 0 fail.
- [ ] **Step 5: Commit.**

### Task 5: Live acceptance `scripts/qa-readout.mjs`

The pattern is copied from `scripts/qa-compare.mjs`: first-run suppress + Escape + `offsetParent` wait, `report(check, ok, detail)`, and exit 1 on any failure.

Known points were measured 2026-09-23 by the Python probe against the same GIBS tiles:

| point   | lat, lon      | land cover                      | EVI (2026-08-13) | LST (2026-08-21)      |
| ------- | ------------- | ------------------------------- | ---------------- | --------------------- |
| forest  | -5.0, -65.0   | Evergreen Broadleaf Forests (2) | 0.4251–0.4326    | 298.4–299.0 K         |
| Sahara  | 23.0, 12.0    | Barren (16)                     | 0.0676–0.0713    | 310.4–311.0 K         |
| Chicago | 41.88, -87.63 | Urban and Built-up Lands (13)   | 0.0751–0.0789    | 298.4–299.0 K         |
| Delhi   | 28.61, 77.21  | Urban (13)                      | 0.2151–0.2226    | transparent → no data |

Checks:

1. `class-known`: `readoutAt` at forest/Sahara/Chicago gives those land-cover labels.
2. `ramp-ordered`: EVI forest > 0.3 > Sahara, and LST Sahara > forest. Ordering, not exact bins: the dates move nightly.
3. `own-date`: every row's date equals that layer's `getStats().time`, and a fresh `fetch` of the same tile returns an equal `layer-time-actual`.
4. `nodata-honest`: at least one LST no-data point prints "no data here". Delhi, or the first transparent point found on a 10-point Indian-monsoon transect; the script logs which.
5. `card-shows`: arm WHAT LIVES HERE, then do a real `page.mouse.click` on the globe at a screen point that `scene.cartesianToCanvasCoordinates` maps from the forest point. `.bio-card-layers` then lists the enabled layers with dates within 15 s.

- [ ] **Step 1: Write the script.** Run it against the live site BEFORE deploy. Expected: exit 1 (`readoutAt` missing), which is seen to fail.
- [ ] **Step 2: Run it against a local build of the branch.** Use `dist/data` symlinked from `~/wildeye/public/data`, and `python3 -m http.server 8777` from `dist` (port 8766 is taken). Expected: exit 0.
- [ ] **Step 3: Commit.**

### Task 6: Measured known-answer `scripts/qa-known-answer.mjs` (Q6)

In the page:

- For each region box (Nile delta + Cairo `29.8..31.4N, 30.2..32.2E`; Chicago metro `41.4..42.3N, -88.4..-87.5E`; Delhi `28.3..29.0N, 76.8..77.6E`; Manaus / central Amazon `-3.6..-2.6N, -60.6..-59.4E`), take a 20×20 grid.
- Get the land-cover class from `readoutAt`.
- Get the Black Marble luminance from the same tile reader on the `gibs-nightlights` 2016 tile: `0.2126R + 0.7152G + 0.0722B`, decoded exactly, with no rendering.
- Group by class. Print `class, n, mean, median` for every class.
- Pass = the pre-registered criteria (a) and (b) above. Write the full table to `--out` JSON when given.

- [ ] **Step 1: Write the script.** Before the pass/fail logic runs, add a **positive control**: the Chicago Loop point (41.88, -87.63) must have a luminance > 0.5 × 255, else the harness is reading the wrong tile, and the script exits 2 with "harness control failed".
- [ ] **Step 2: Run it against the local build.** Read the table. Whatever it says is recorded in the ledger, pass or fail. Do not edit the criteria after seeing it.
- [ ] **Step 3: Commit.**

### Task 7: Ship

- [ ] Full `npm test` + pytest. Final whole-branch review (fable).
- [ ] Merge `--no-ff` to `main-wildeye`, push, run `pipeline/run_gibs.sh` once so the live `gibs.json` carries `decode`, then `pipeline/deploy_pages.sh`.
- [ ] Wait for the new asset hash on live. Run `qa-readout`, `qa-known-answer`, `qa-gibs`, `qa-compare` and `qa-observed-time` against live. All must exit 0 (A18).
- [ ] Ledger: append a "Stage 3 result" section to the grill file with the Q6 table and "what the grill missed", and update the MEMORY.md line.

**Out of scope:** readout for the 9 pipeline drapes (they are not palette tiles); the land-cover alpha 0.85 darkening (`gibsLayer.js:213`, open); the mobile time-bar overflow (open).
