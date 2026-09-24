# GIBS stage 2: swipe Compare panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put any two raster drapes side by side on the globe behind a draggable vertical divider, each side labelled with its own date, restorable from a share link.

**Architecture:** Cesium's native split (`ImageryLayer.splitDirection` + `scene.splitPosition`) does the rendering. A split map lives beside the shared drape stack in `rasterDrape.js` and is re-applied on every restack, so it survives each drape rebuilding its ImageryLayer. A small controller (`src/compare.js`) owns `{left, right, position}`, exempts the pair from the one-drape rule and ends itself when a side goes off. A DOM panel plus divider (`src/compareUi.js`) drives it. The share link carries `cmp=<tokL>.<tokR>.<pct>`.

**Tech Stack:** vanilla JS ES modules, Cesium 1.138.0, `node:test` under node24, puppeteer SwiftShader for live QA.

**Spec:** `~/.claude/projects/-home-mjarnold/memory/grill_wildeye_gibs_wave_2026-09-22.md` — Q5, A6, A7/A16, A9, A12, A15, A18, A19. Stage-1 plan for conventions: `docs/superpowers/plans/2026-09-22-gibs-stage1.md`.

## Global Constraints

- Swipe = Cesium native split: `Cesium.SplitDirection` LEFT −1, NONE 0, RIGHT 1; `viewer.scene.splitPosition` in 0..1 (Q3).
- UI = a Compare panel with left/right dropdowns; the state is share-link encoded (Q5).
- At most one drape per swipe side. With swipe off, the one-drape rule is byte-for-byte unchanged: the existing `src/data/drapeExclusive.test.mjs` tests stay green unedited (A6).
- Each side labels its OWN date (A7/A16). There is one shared observed-time bar; each side resolves its date from it independently (A9). This resolves the open fog "swipe + time bar when sides are years apart" as an assumption.
- Any of the 14 drapes can be a side: `crw-bleaching oisst chlor-a crw-dhw crw-hotspot crw-seaice ndvi cmems-o2 cmems-ph gibs-landcover gibs-evi gibs-lst gibs-nightlights gibs-biomass` (A15).
- Share tokens come from `LAYER_STATE_REGISTRY` (A12): `cmp=<leftToken>.<rightToken>.<positionPercent>`, written only while compare is active.
- Acceptance = `scripts/qa-compare.mjs` exits 0 against the live site (A18). Deploy = commit to `main-wildeye`, then `pipeline/deploy_pages.sh` (A19).
- Tests: `PATH="$HOME/.local/node24/bin:$PATH"`. Whole suite `npm test`, stage-1 baseline 3007 pass / 0 fail. Run SwiftShader Chrome under `heavy-run` (a shared 20 GiB scope OOM-kills it as "Target closed").
- No new dependencies. No `text-transform: uppercase`. House rules in `CLAUDE.md` §3.

## Review Focus

1. **A share link whose side fails to enable** (GIBS down, layer error) must not leave a half-split globe. The controller ends compare and logs loudly. Test: Task 4, "a side that does not enable ends compare and rejects".
2. **Scrubbing the time bar while comparing** must relabel each side with its new date. The labels must not read the date from before the drape rebuilt its image. Test: Task 2, "restack listeners run after the caller's synchronous bookkeeping"; Task 5, "side labels follow a restack".
3. **Touch drag and window resize.** The divider must follow a finger (`touch-action:none`, pointer events). Its position is a percentage, so a resize keeps it on the split line, and a drag past either edge clamps to 0..1. Test: Task 5, "drag past the edge clamps".
4. **A malformed or foreign `cmp=`** (unknown token, a non-drape token, same token twice, pct > 100) must be rejected with a message naming the raw value, and the page must still boot. Test: Task 4, codec test; Task 7 wiring catches and `console.error`s.
5. **A side in error or with no date** must say so instead of showing a blank or a stale date. Test: Task 5, "a side in error shows the error".

## File map

- Create `scripts/qa-compare.mjs`: the live acceptance check (Task 1), plus `--shots` for the critic (Task 8).
- Modify `src/data/rasterDrape.js`: add the split map, `setDrapeSplit`, `drapeStackState` and `onDrapeRestack` (Task 2).
- Modify `src/data/drapeExclusive.js`: add the optional `{ exempt }` (Task 3).
- Create `src/compare.js`: the controller plus the `cmp` codec (Task 4).
- Create `src/compareUi.js`: the pill, panel and divider (Task 5).
- Modify `src/sharelink.js` and `src/ui.js`: the provider, the parse field and the StyleManager getter (Task 6).
- Modify `src/main.js`: wiring (Task 7).
- Modify `LESSONS.md` only if a miss happens.

---

### Task 1: Acceptance check first — `scripts/qa-compare.mjs`

**Files:** Create `scripts/qa-compare.mjs`

**Interfaces:**

- Consumes (from Task 7, not yet built, which is why it must fail now):
  - `window.__godsEyeView.compare` (Task 4 API);
  - `window.__godsEyeView.drapeStack()` returning `[{id, splitDirection, onGlobe}]` (Task 2);
  - DOM ids `#compare-toggle`, `#compare-panel`, `#compare-divider`, and selects `.cmp-left` / `.cmp-right` (Task 5).
- Produces: exit 0 only when every check passes; `--url`, `--shots <dir>`.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/**
 * qa-compare.mjs — real-browser acceptance for the swipe Compare panel (GIBS stage 2, grill A18).
 * Run: heavy-run node scripts/qa-compare.mjs [--url https://musharna.github.io/wildeye/] [--shots <dir>]
 * One JSON line per check; exits 1 when any check fails.
 *
 * The split is asserted on the ImageryLayers actually on the globe (drapeStack()), not on the
 * controller's state: a controller that believes it is comparing while the layers draw full-globe
 * passes every state check and fails this one.
 */
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, fallback) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const SITE = arg("--url", "https://musharna.github.io/wildeye/");
const SHOTS = arg("--shots", null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const LEFT = "gibs-nightlights",
  RIGHT = "gibs-landcover";

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: "new",
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--disable-dev-shm-usage",
  ],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const open = async (url) => {
  const page = await browser.newPage();
  page.on("pageerror", (e) =>
    pageErrors.push(String(e?.message || e).slice(0, 160)),
  );
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager && window.__godsEyeView?.styleManager,
    { timeout: 180000 },
  );
  // .then(() => true): a resolved value puppeteer cannot serialize would reject the evaluate
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.initialRestorePromise.then(
      () => true,
      () => false,
    ),
  );
  // Boot flies the camera and shows a first-run launcher over the centre (stage-1 critic round 1).
  await sleep(12000);
  if (await page.$("[data-first-run-choice]"))
    throw new Error("first-run launcher still covers the globe");
  return page;
};
const sides = (page) =>
  page.evaluate(() => {
    const g = window.__godsEyeView;
    return {
      state: g.compare?.getState() ?? null,
      stack: g.drapeStack ? g.drapeStack() : null,
      splitPosition: g.viewer.scene.splitPosition,
      enabled: g.dataManager.getEnabledLayerIds(),
      hash: window.location.hash,
      divider: (() => {
        const d = document.getElementById("compare-divider");
        if (!d) return null;
        const b = d.getBoundingClientRect();
        return {
          display: getComputedStyle(d).display,
          x: b.left + b.width / 2,
        };
      })(),
      labels: [
        ...document.querySelectorAll(
          "#compare-panel .cmp-left-date, #compare-panel .cmp-right-date",
        ),
      ].map((e) => e.textContent),
    };
  });
const splitOf = (s, id) =>
  s.stack?.find((e) => e.id === id && e.onGlobe)?.splitDirection ?? null;

try {
  const page = await open(SITE);

  // 1. The control exists and is on screen.
  const toggle = await page.$("#compare-toggle");
  const box = toggle && (await toggle.boundingBox());
  report("toggle-on-screen", !!box && box.width > 0, { box });
  if (!box) throw new Error("no #compare-toggle: compare is not on this site");

  // 2. Drive the real UI: open, then choose both sides through the selects.
  await toggle.click();
  await page.waitForSelector("#compare-panel .cmp-left", {
    visible: true,
    timeout: 30000,
  });
  await page.select("#compare-panel .cmp-left", LEFT);
  await page.select("#compare-panel .cmp-right", RIGHT);
  await page.waitForFunction(
    (l, r) => {
      const g = window.__godsEyeView;
      return g.dataManager.isEnabled(l) && g.dataManager.isEnabled(r);
    },
    { timeout: 120000 },
    LEFT,
    RIGHT,
  );
  await sleep(3000);
  let s = await sides(page);
  report(
    "both-sides-split-on-globe",
    splitOf(s, LEFT) === -1 &&
      splitOf(s, RIGHT) === 1 &&
      s.divider?.display !== "none",
    {
      left: splitOf(s, LEFT),
      right: splitOf(s, RIGHT),
      state: s.state,
      enabled: s.enabled,
    },
  );
  report(
    "each-side-dated",
    s.labels.length === 2 &&
      s.labels.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)),
    { labels: s.labels },
  );

  // 3. Dragging the divider moves the split: mouse drag from its centre to 25% of the viewport.
  const y = 450;
  await page.mouse.move(s.divider.x, y);
  await page.mouse.down();
  await page.mouse.move(1400 * 0.25, y, { steps: 8 });
  await page.mouse.up();
  await sleep(1500);
  s = await sides(page);
  report(
    "divider-drag-moves-split",
    Math.abs(s.splitPosition - 0.25) < 0.02 && Math.abs(s.divider.x - 350) < 12,
    { splitPosition: s.splitPosition, dividerX: s.divider.x },
  );

  // 4. The share link carries the pair and position (debounced write).
  await page
    .waitForFunction(() => /(^|[#&])cmp=/.test(window.location.hash), {
      timeout: 15000,
    })
    .catch(() => {});
  s = await sides(page);
  const cmp = new URLSearchParams(s.hash.slice(1)).get("cmp");
  report("hash-encodes-compare", cmp === "bm.lc.25", { cmp });

  if (SHOTS) {
    for (const [name, lat, lon] of [
      ["cairo", 30.04, 31.24],
      ["chicago", 41.88, -87.63],
      ["delhi", 28.61, 77.21],
      ["amazon", -3.1, -60.0],
    ]) {
      // camera code verbatim from shots-gibs-known-answer.mjs: straight down, 600 km, wait for tiles
      await page.evaluate(
        async ([lon, lat, h]) => {
          const v = window.__godsEyeView.viewer;
          v.camera.cancelFlight();
          v.camera.setView({
            destination: v.scene.globe.ellipsoid.cartographicToCartesian({
              longitude: (lon * Math.PI) / 180,
              latitude: (lat * Math.PI) / 180,
              height: h,
            }),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          const deadline = Date.now() + 240000;
          await new Promise((r) => setTimeout(r, 2000));
          while (Date.now() < deadline && !v.scene.globe.tilesLoaded)
            await new Promise((r) => setTimeout(r, 500));
        },
        [lon, lat, 600000],
      );
      await sleep(3000);
      await page.screenshot({ path: `${SHOTS}/compare-${name}.png` });
    }
  }

  // 5. Reloading the link restores the same compare.
  const page2 = await open(
    `${new URL(SITE).origin}${new URL(SITE).pathname}${s.hash}`,
  );
  await page2
    .waitForFunction(() => !!window.__godsEyeView.compare?.getState(), {
      timeout: 120000,
    })
    .catch(() => {});
  await sleep(3000);
  const r = await sides(page2);
  report(
    "reload-restores-compare",
    r.state?.left === LEFT &&
      r.state?.right === RIGHT &&
      Math.abs(r.state.position - 0.25) < 1e-9 &&
      splitOf(r, LEFT) === -1 &&
      splitOf(r, RIGHT) === 1 &&
      Math.abs(r.splitPosition - 0.25) < 1e-9,
    { state: r.state, left: splitOf(r, LEFT), right: splitOf(r, RIGHT) },
  );

  // 6. A third drape ends compare: both sides off, splits cleared, divider hidden.
  await page2.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled("oisst", true, {
      origin: "user",
    }),
  );
  await sleep(3000);
  const t = await sides(page2);
  const anySplit = (t.stack || []).filter(
    (e) => e.onGlobe && e.splitDirection !== 0,
  );
  report(
    "third-drape-ends-compare",
    t.state === null &&
      !t.enabled.includes(LEFT) &&
      !t.enabled.includes(RIGHT) &&
      anySplit.length === 0 &&
      t.divider?.display === "none" &&
      !/(^|[#&])cmp=/.test(t.hash),
    {
      state: t.state,
      enabled: t.enabled.filter((id) => /gibs|oisst/.test(id)),
      anySplit,
      hash: t.hash.slice(0, 200),
    },
  );

  report("no-page-errors", pageErrors.length === 0, {
    errors: pageErrors.slice(0, 3),
  });
} catch (e) {
  report("run", false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify({
    summary: true,
    checks: results.length,
    failed: failed.length,
  }),
);
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: Watch it fail against the live (pre-change) site**

Run: `cd ~/wildeye-compare && PATH="$HOME/.local/node24/bin:$PATH" heavy-run node scripts/qa-compare.mjs; echo exit=$?`
Expected: `{"check":"toggle-on-screen",...,"ok":false}`, then `{"check":"run","error":"no #compare-toggle...","ok":false}`, then `exit=1`.

- [ ] **Step 3: Commit**

```bash
git add scripts/qa-compare.mjs
git commit -m "qa-compare: live acceptance for the swipe Compare panel, asserting the split on the globe's own ImageryLayers; fails against the current site (no compare)."
```

---

### Task 2: Split direction lives in the drape stack

**Files:** Modify `src/data/rasterDrape.js:18-31`; Test `src/data/rasterDrape.test.mjs`

**Interfaces:**

- Produces:
  - `setDrapeSplit(imageryLayers, id, direction:number)`: stores the value (0 deletes it) and restacks. Returns the restack order.
  - `drapeStackState(imageryLayers) → [{id, splitDirection, onGlobe:boolean}]`.
  - `onDrapeRestack(fn) → unsubscribe`: `fn()` runs in a microtask after each restack.
- Existing, unchanged: `restackDrapes(imageryLayers)`, `setStackedImagery(imageryLayers, id, layer, zrank)`, `_drapeStackForTest()`.

- [ ] **Step 1: Write the failing tests** (append to `src/data/rasterDrape.test.mjs`; reuse its existing imports and add the new names to the import from `./rasterDrape.js`)

```js
const fakeImagery = () => {
  const on = [];
  return {
    on,
    add(l) {
      on.push(l);
    },
    remove(l) {
      const i = on.indexOf(l);
      if (i >= 0) on.splice(i, 1);
      return i >= 0;
    },
    contains(l) {
      return on.includes(l);
    },
  };
};

test("a drape split survives the drape rebuilding its ImageryLayer; other drapes draw full-globe", () => {
  const il = fakeImagery();
  const a1 = { id: "a1" },
    a2 = { id: "a2" },
    b = { id: "b" };
  setStackedImagery(il, "split-a", a1, 10);
  setStackedImagery(il, "split-b", b, 20);
  setDrapeSplit(il, "split-a", -1);
  assert.equal(a1.splitDirection, -1);
  assert.equal(b.splitDirection, 0);
  // the layer rebuilds (new date / new frame): the new ImageryLayer must carry the split too
  setStackedImagery(il, "split-a", a2, 10);
  assert.equal(a2.splitDirection, -1);
  assert.deepEqual(
    drapeStackState(il).filter((e) => e.id.startsWith("split-")),
    [
      { id: "split-a", splitDirection: -1, onGlobe: true },
      { id: "split-b", splitDirection: 0, onGlobe: true },
    ],
  );
  setDrapeSplit(il, "split-a", 0);
  assert.equal(a2.splitDirection, 0);
  setStackedImagery(il, "split-a", null);
  setStackedImagery(il, "split-b", null);
});

test("restack listeners run after the caller's synchronous bookkeeping", async () => {
  const il = fakeImagery();
  let shown = "old";
  const seen = [];
  const off = onDrapeRestack(() => seen.push(shown));
  setStackedImagery(il, "listen-a", { id: "x" }, 10);
  shown = "new"; // gibsLayer.js sets _shownDate right AFTER stack(); rasterDrape sets _shown after restackDrapes
  await Promise.resolve();
  assert.deepEqual(seen, ["new"]);
  off();
  setStackedImagery(il, "listen-a", null);
  await Promise.resolve();
  assert.deepEqual(seen, ["new"]);
});
```

- [ ] **Step 2: Run, watch fail**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/data/rasterDrape.test.mjs`
Expected: FAIL. The import is missing `setDrapeSplit`, so it throws a SyntaxError about the requested module not providing the export.

- [ ] **Step 3: Implement** (replace lines 18–31 of `src/data/rasterDrape.js`)

```js
const _stack = new Map(); // id → { layer, zrank }
// id → Cesium.SplitDirection (-1 left, 1 right). Kept apart from the layer because every drape
// rebuilds its ImageryLayer on a new date or frame; restack re-applies it to whatever layer is current.
const _split = new Map();
const _restackListeners = new Set();
export function restackDrapes(imageryLayers) {
  const order = [..._stack.entries()].sort(
    ([ia, a], [ib, b]) => a.zrank - b.zrank || (ia < ib ? -1 : 1),
  );
  for (const [, e] of order)
    if (imageryLayers.contains?.(e.layer) ?? true)
      imageryLayers.remove(e.layer, false);
  for (const [id, e] of order) {
    e.layer.splitDirection = _split.get(id) ?? Cesium.SplitDirection.NONE;
    imageryLayers.add(e.layer);
  }
  // A microtask, not now: both callers record what they are showing (date, frame) just after this returns.
  if (_restackListeners.size)
    queueMicrotask(() => {
      for (const fn of _restackListeners) fn();
    });
  return order.map(([id]) => id);
}
export function _drapeStackForTest() {
  return _stack;
}
/** Put a non-drape ImageryLayer into the shared stack at `zrank` (or take it out with null), then restack. */
export function setStackedImagery(imageryLayers, id, layer, zrank = 50) {
  if (layer) _stack.set(id, { layer, zrank });
  else _stack.delete(id);
  return restackDrapes(imageryLayers);
}
/** Draw drape `id` on one side of the split only (Cesium.SplitDirection; 0 = whole globe). */
export function setDrapeSplit(imageryLayers, id, direction) {
  if (direction) _split.set(id, direction);
  else _split.delete(id);
  return restackDrapes(imageryLayers);
}
/** What the globe is drawing, per stacked drape: the split read off the live ImageryLayer. */
export function drapeStackState(imageryLayers) {
  return [..._stack.entries()].map(([id, e]) => ({
    id,
    splitDirection: e.layer.splitDirection ?? 0,
    onGlobe: Boolean(imageryLayers.contains?.(e.layer)),
  }));
}
/** Run `fn` after every restack (a drape changed image, split or order). Returns unsubscribe. */
export function onDrapeRestack(fn) {
  _restackListeners.add(fn);
  return () => _restackListeners.delete(fn);
}
```

- [ ] **Step 4: Run, watch pass; seen-to-fail mutant**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/data/rasterDrape.test.mjs`
Expected: PASS, all tests.
Mutant: change `e.layer.splitDirection = _split.get(id) ?? …` to `if (!('splitDirection' in e.layer)) e.layer.splitDirection = …` (applies once, never on a rebuild), re-run, expect the first test to fail at `a2.splitDirection` (undefined !== -1), then restore. Use `git diff --stat` to confirm only the intended lines changed.

- [ ] **Step 5: Commit**

```bash
git add src/data/rasterDrape.js src/data/rasterDrape.test.mjs
git commit -m "Drape stack carries a per-drape split direction, re-applied on every restack so it survives a drape rebuilding its ImageryLayer; drapeStackState reads it back off the live layers; onDrapeRestack notifies after the caller's bookkeeping."
```

---

### Task 3: The compare pair is exempt from the one-drape rule

**Files:** Modify `src/data/drapeExclusive.js`; Test `src/data/drapeExclusive.test.mjs` (append only; existing tests untouched, per A6)

**Interfaces:**

- Produces: `installDrapeExclusivity(dataManager, drapeIds, { exempt } = {})`. `exempt()` returns `[leftId, rightId]` or `null`.

- [ ] **Step 1: Write the failing test** (append)

```js
test("the compare pair may both be on; a third drape turns both off; no pair means the old rule", async () => {
  const mgr = new DataLayerManager({});
  for (const id of ["oisst", "chlor-a", "ndvi", "birds"])
    mgr.register(fakeLayer(id));
  let pair = ["oisst", "chlor-a"];
  installDrapeExclusivity(mgr, ["oisst", "chlor-a", "ndvi"], {
    exempt: () => pair,
  });
  await mgr.setEnabled("oisst", true, { origin: "user" });
  await mgr.setEnabled("chlor-a", true, { origin: "user" });
  assert.deepEqual(
    ["oisst", "chlor-a", "ndvi"].map((id) => mgr.isEnabled(id)),
    [true, true, false],
  );
  await mgr.setEnabled("ndvi", true, { origin: "user" });
  assert.deepEqual(
    ["oisst", "chlor-a", "ndvi"].map((id) => mgr.isEnabled(id)),
    [false, false, true],
  );
  pair = null; // compare off: back to one at a time
  await mgr.setEnabled("oisst", true, { origin: "user" });
  assert.deepEqual(
    ["oisst", "chlor-a", "ndvi"].map((id) => mgr.isEnabled(id)),
    [true, false, false],
  );
});
```

- [ ] **Step 2: Run, watch fail**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/data/drapeExclusive.test.mjs`
Expected: FAIL at the first deepEqual (`[false, true, false]` vs `[true, true, false]`).

- [ ] **Step 3: Implement** (full new body of `installDrapeExclusivity`; keep the header comment and add one line to it: "While compare is on, its two sides are exempt from each other (`exempt`), never from a third drape.")

```js
export function installDrapeExclusivity(
  dataManager,
  drapeIds,
  { exempt = () => null } = {},
) {
  const ids = new Set(drapeIds);
  if (typeof dataManager?.subscribeVisibilityRequests !== "function") {
    throw new Error(
      "installDrapeExclusivity: dataManager lacks subscribeVisibilityRequests",
    );
  }
  return dataManager.subscribeVisibilityRequests((change) => {
    if (
      change?.type !== "visibility-requested" ||
      !change.enabled ||
      !ids.has(change.layerId)
    )
      return;
    const pair = exempt();
    const keep = pair && pair.includes(change.layerId) ? new Set(pair) : null;
    for (const other of ids) {
      if (other === change.layerId || keep?.has(other)) continue;
      if (
        dataManager.isEffectivelyEnabled?.(other) ??
        dataManager.isEnabled(other)
      ) {
        dataManager.setEnabled(other, false, { origin: "programmatic" });
      }
    }
  });
}
```

- [ ] **Step 4: Run, watch pass (all tests in the file, old ones unedited)**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/data/drapeExclusive.test.mjs`
Expected: PASS, 4/4. Mutant: `keep = pair ? new Set(pair) : null` (drops the `includes` gate, so a third drape would keep the pair). Expect the second deepEqual to fail, then restore.

- [ ] **Step 5: Commit**

```bash
git add src/data/drapeExclusive.js src/data/drapeExclusive.test.mjs
git commit -m "One-drape rule exempts the active compare pair from each other; a third drape still turns both off, and with no pair the rule is unchanged."
```

---

### Task 4: Compare controller and `cmp` codec — `src/compare.js`

**Files:** Create `src/compare.js`, `src/compare.test.mjs`

**Interfaces:**

- Consumes: `installDrapeExclusivity(..., { exempt })` (Task 3); the manager API `setEnabled(id, bool, {origin})`, `isEnabled(id)`, `subscribe(fn)` (visibility events `{type:'visibility', layerId, enabled}`); `LAYER_STATE_REGISTRY` from `./data/layerState.js`.
- Produces:
  - `SPLIT = {LEFT:-1, NONE:0, RIGHT:1}`.
  - `createCompare({dataManager, drapeIds, setSplit(id, dir), setPosition(p)})` returns:
    - `set(left, right, position?) → Promise<void>`;
    - `move(p)` (clamped);
    - `off() → Promise<void>`;
    - `getState() → {left, right, position} | null`;
    - `subscribe(fn(stateOrNull)) → unsubscribe`;
    - `exempt() → [left, right] | null`.
  - `encodeCompareParam(state) → string | null`.
  - `decodeCompareParam(raw, drapeIds) → {left, right, position} | null`; throws on malformed input.

- [ ] **Step 1: Write the failing tests** (`src/compare.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Cesium from "cesium";
import { DataLayerManager } from "./data/manager.js";
import { installDrapeExclusivity } from "./data/drapeExclusive.js";
import {
  createCompare,
  SPLIT,
  encodeCompareParam,
  decodeCompareParam,
} from "./compare.js";

const DRAPES = ["oisst", "chlor-a", "ndvi"];
function fakeLayer(id, { failEnable = false } = {}) {
  return {
    id,
    name: id,
    icon: "",
    source: "t",
    updateInterval: -1,
    async init() {},
    enable() {
      if (failEnable) throw new Error(`${id} refused`);
    },
    disable() {},
    async update() {
      return true;
    },
    getStats() {
      return { count: 0, lastUpdate: null };
    },
  };
}
function setup(opts = {}) {
  const mgr = new DataLayerManager({});
  for (const id of [...DRAPES, "birds"])
    mgr.register(fakeLayer(id, { failEnable: opts.failing === id }));
  const splits = new Map();
  let position = null;
  const seen = [];
  const compare = createCompare({
    dataManager: mgr,
    drapeIds: DRAPES,
    setSplit: (id, dir) => {
      if (dir) splits.set(id, dir);
      else splits.delete(id);
    },
    setPosition: (p) => {
      position = p;
    },
  });
  installDrapeExclusivity(mgr, DRAPES, { exempt: compare.exempt });
  compare.subscribe((s) => seen.push(s));
  return { mgr, compare, splits, pos: () => position, seen };
}
const on = (mgr) => DRAPES.filter((id) => mgr.isEnabled(id));

test("SPLIT matches Cesium.SplitDirection", () => {
  assert.deepEqual(
    { ...SPLIT },
    {
      LEFT: Cesium.SplitDirection.LEFT,
      NONE: Cesium.SplitDirection.NONE,
      RIGHT: Cesium.SplitDirection.RIGHT,
    },
  );
});

test("set enables both sides, splits them left/right and places the divider", async () => {
  const { mgr, compare, splits, pos } = setup();
  await compare.set("oisst", "chlor-a");
  assert.deepEqual(on(mgr), ["oisst", "chlor-a"]);
  assert.deepEqual(
    [...splits],
    [
      ["oisst", -1],
      ["chlor-a", 1],
    ],
  );
  assert.equal(pos(), 0.5);
  assert.deepEqual(compare.getState(), {
    left: "oisst",
    right: "chlor-a",
    position: 0.5,
  });
});

test("changing a side swaps that drape out and keeps compare on", async () => {
  const { mgr, compare, splits } = setup();
  await compare.set("oisst", "chlor-a");
  await compare.set("ndvi", "chlor-a");
  assert.deepEqual(on(mgr), ["chlor-a", "ndvi"]);
  assert.deepEqual(Object.fromEntries(splits), { ndvi: -1, "chlor-a": 1 });
  assert.deepEqual(compare.getState(), {
    left: "ndvi",
    right: "chlor-a",
    position: 0.5,
  });
});

test("a third drape ends compare: both sides off, splits cleared, subscribers told null", async () => {
  const { mgr, compare, splits, seen } = setup();
  await compare.set("oisst", "chlor-a");
  await mgr.setEnabled("ndvi", true, { origin: "user" });
  assert.deepEqual(on(mgr), ["ndvi"]);
  assert.equal(compare.getState(), null);
  assert.equal(splits.size, 0);
  assert.equal(seen.at(-1), null);
});

test("turning a side off by hand ends compare and leaves the other side whole", async () => {
  const { mgr, compare, splits } = setup();
  await compare.set("oisst", "chlor-a");
  await mgr.setEnabled("oisst", false, { origin: "user" });
  assert.equal(compare.getState(), null);
  assert.deepEqual(on(mgr), ["chlor-a"]);
  assert.equal(splits.size, 0);
});

test("off keeps the left drape full-globe and turns the right off", async () => {
  const { mgr, compare, splits } = setup();
  await compare.set("oisst", "chlor-a");
  await compare.off();
  assert.deepEqual(on(mgr), ["oisst"]);
  assert.equal(splits.size, 0);
  assert.equal(compare.getState(), null);
  assert.equal(compare.exempt(), null);
});

test("move clamps to 0..1 and reaches the renderer", async () => {
  const { compare, pos } = setup();
  await compare.set("oisst", "chlor-a");
  compare.move(0.25);
  assert.equal(pos(), 0.25);
  compare.move(-3);
  assert.equal(pos(), 0);
  compare.move(7);
  assert.equal(pos(), 1);
  assert.equal(compare.getState().position, 1);
});

test("a side that does not enable ends compare and rejects", async () => {
  const { mgr, compare, splits } = setup({ failing: "chlor-a" });
  await assert.rejects(compare.set("oisst", "chlor-a"), /chlor-a/);
  assert.equal(compare.getState(), null);
  assert.equal(splits.size, 0);
  assert.equal(mgr.isEnabled("chlor-a"), false);
  assert.equal(mgr.isEnabled("oisst"), true); // positive control: the side that worked stays, full-globe
});

test("set rejects a non-drape, the same drape twice, a bad position — and a valid set still works", async () => {
  const { compare } = setup();
  await assert.rejects(compare.set("birds", "oisst"), /'birds' is not a drape/);
  await assert.rejects(compare.set("oisst", "oisst"), /both sides are 'oisst'/);
  await assert.rejects(compare.set("oisst", "ndvi", 1.5), /position 1.5/);
  assert.equal(compare.getState(), null);
  await compare.set("oisst", "ndvi", 0.3);
  assert.deepEqual(compare.getState(), {
    left: "oisst",
    right: "ndvi",
    position: 0.3,
  });
});

test("cmp codec: registry tokens round-trip for every one of the 14 drapes; malformed values throw with the raw value", () => {
  const ALL = [
    "crw-bleaching",
    "oisst",
    "chlor-a",
    "crw-dhw",
    "crw-hotspot",
    "crw-seaice",
    "ndvi",
    "cmems-o2",
    "cmems-ph",
    "gibs-landcover",
    "gibs-evi",
    "gibs-lst",
    "gibs-nightlights",
    "gibs-biomass",
  ];
  assert.equal(
    encodeCompareParam({
      left: "gibs-nightlights",
      right: "gibs-landcover",
      position: 0.25,
    }),
    "bm.lc.25",
  );
  for (const left of ALL)
    for (const right of ALL)
      if (left !== right) {
        assert.deepEqual(
          decodeCompareParam(
            encodeCompareParam({ left, right, position: 0.5 }),
            ALL,
          ),
          { left, right, position: 0.5 },
        );
      }
  assert.equal(encodeCompareParam(null), null);
  assert.equal(decodeCompareParam(null, ALL), null);
  for (const bad of [
    "bm.lc",
    "bm.lc.101",
    "bm.bm.50",
    "zz.lc.50",
    "n.lc.50",
    "BM.lc.50",
    "bm.lc.5x",
  ]) {
    assert.throws(
      () => decodeCompareParam(bad, ALL),
      new RegExp(`cmp='${bad.replace(/\./g, "\\.")}'`),
      bad,
    );
  }
});
```

Note: `'n'` is birds' token. It exists in the registry but is not a drape, so the codec must reject it, and that case is what the test pins. `'zz'` is not a token at all.

- [ ] **Step 2: Run, watch fail**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/compare.test.mjs`
Expected: FAIL, "Cannot find module … compare.js".

- [ ] **Step 3: Implement `src/compare.js`**

```js
/**
 * Swipe compare: two raster drapes side by side behind a divider (GIBS stage 2, grill Q5/A6/A15).
 * Rendering is Cesium's own split (ImageryLayer.splitDirection + scene.splitPosition); this module
 * owns only which drape is on which side and where the divider sits. It ends itself whenever
 * either side goes off — by hand, by a third drape (drapeExclusive.js), or by failing to enable —
 * so the globe is never left half-split over one layer.
 */
import { LAYER_STATE_REGISTRY } from "./data/layerState.js";

/** Cesium.SplitDirection values (pinned against Cesium in compare.test.mjs). */
export const SPLIT = Object.freeze({ LEFT: -1, NONE: 0, RIGHT: 1 });

export function createCompare({
  dataManager,
  drapeIds,
  setSplit,
  setPosition,
}) {
  const ids = new Set(drapeIds);
  const listeners = new Set();
  let state = null;
  const emit = () => {
    const s = state && { ...state };
    for (const fn of listeners) fn(s);
  };
  const end = () => {
    const s = state;
    if (!s) return;
    state = null;
    setSplit(s.left, SPLIT.NONE);
    setSplit(s.right, SPLIT.NONE);
    emit();
  };
  dataManager.subscribe((change) => {
    if (change?.type !== "visibility" || change.enabled || !state) return;
    if (change.layerId === state.left || change.layerId === state.right) end();
  });

  return {
    exempt: () => (state ? [state.left, state.right] : null),
    getState: () => (state ? { ...state } : null),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async set(left, right, position = state?.position ?? 0.5) {
      for (const id of [left, right])
        if (!ids.has(id)) throw new Error(`compare: '${id}' is not a drape`);
      if (left === right) throw new Error(`compare: both sides are '${left}'`);
      if (!(Number.isFinite(position) && position >= 0 && position <= 1))
        throw new Error(`compare: position ${position} is outside 0..1`);
      const prev = state;
      if (prev)
        for (const id of [prev.left, prev.right])
          if (id !== left && id !== right) setSplit(id, SPLIT.NONE);
      const next = { left, right, position };
      state = next; // before enabling: exclusivity reads exempt() inside setEnabled
      setSplit(left, SPLIT.LEFT);
      setSplit(right, SPLIT.RIGHT);
      setPosition(position);
      emit();
      // A failed enable resolves (manager.js finishFailedEnable) with the layer still off; it does not throw.
      await dataManager.setEnabled(left, true, { origin: "user" });
      await dataManager.setEnabled(right, true, { origin: "user" });
      if (state !== next) return; // superseded by a newer set/off, or a side went off meanwhile
      const dead = [left, right].filter((id) => !dataManager.isEnabled(id));
      if (dead.length) {
        end(); // the side that did enable stays on, full-globe: it was exempt, so nothing turned it off
        throw new Error(
          `compare: ${dead.map((id) => `'${id}'`).join(" and ")} did not enable`,
        );
      }
    },

    move(p) {
      if (!state) return;
      state.position = Math.min(1, Math.max(0, Number(p) || 0));
      setPosition(state.position);
      emit();
    },

    async off() {
      const s = state;
      if (!s) return;
      end();
      await dataManager.setEnabled(s.right, false, { origin: "user" });
    },
  };
}

const TOKEN_OF = new Map(LAYER_STATE_REGISTRY.map((e) => [e.id, e.token]));
const ID_OF = new Map(LAYER_STATE_REGISTRY.map((e) => [e.token, e.id]));

/** `cmp` share-link value for an active compare, or null when off. */
export function encodeCompareParam(state) {
  if (!state) return null;
  const [l, r] = [TOKEN_OF.get(state.left), TOKEN_OF.get(state.right)];
  if (!l || !r)
    throw new Error(
      `compare: no share token for '${l ? state.right : state.left}'`,
    );
  return `${l}.${r}.${Math.round(state.position * 100)}`;
}

/** Parse `cmp`; null when absent, throws (naming the raw value) when it cannot be a compare of two drapes. */
export function decodeCompareParam(raw, drapeIds) {
  if (raw == null || raw === "") return null;
  const m = /^([a-z0-9]{1,2})\.([a-z0-9]{1,2})\.(\d{1,3})$/.exec(raw);
  const bad = (why) => new Error(`compare: cmp='${raw}' ${why}`);
  if (!m) throw bad("is not <token>.<token>.<percent>");
  const [left, right] = [ID_OF.get(m[1]), ID_OF.get(m[2])];
  const drapes = new Set(drapeIds);
  if (!drapes.has(left) || !drapes.has(right))
    throw bad("names a layer that is not a drape");
  if (left === right) throw bad("names the same drape twice");
  const pct = Number(m[3]);
  if (pct > 100) throw bad("has a position over 100");
  return { left, right, position: pct / 100 };
}
```

The failing fake's `enable()` throws. `manager.js:905-912` catches that and routes it to `finishFailedEnable`, so `setEnabled` resolves with the layer still off. That is the path this test drives.

- [ ] **Step 4: Run, watch pass; mutants**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/compare.test.mjs`
Expected: PASS, 10/10.
Mutants, one at a time, each expected to fail the named test, then restore:

- (a) delete the `dataManager.subscribe(...)` block. Expected to fail: "a third drape ends compare".
- (b) move `state = next` below the enable loop. Expected to fail: "set enables both sides" (exclusivity turns oisst off).
- (c) in decode, drop the `drapes.has` check. Expected to fail: the codec test on `'n.lc.50'`.

- [ ] **Step 5: Commit**

```bash
git add src/compare.js src/compare.test.mjs
git commit -m "Compare controller: two drapes split left/right with the pair exempt from the one-drape rule, ending itself whenever a side goes off or fails to enable; cmp=<tok>.<tok>.<pct> codec over the layer-state registry."
```

---

### Task 5: Compare panel and divider — `src/compareUi.js`

**Files:** Create `src/compareUi.js`, `src/compareUi.test.mjs`

**Interfaces:**

- Consumes: `createCompare` from Task 4 (`set`, `move`, `off`, `getState`, `subscribe`); the manager's `getAll()`, which returns `[{id, stats:{time, error}}]`, plus `isEnabled` and `subscribe`; `onDrapeRestack` from Task 2.
- Produces: `installCompareUi({doc, compare, dataManager, drapes:[{id,name}], container, onRestack}) → {toggle, panel, divider, render}`. The DOM ids and classes are the ones qa-compare (Task 1) uses:
  - `#compare-toggle`, `#compare-panel`, `#compare-divider`;
  - `.cmp-left`, `.cmp-right`;
  - `.cmp-left-date`, `.cmp-right-date`;
  - `.cmp-close`.

- [ ] **Step 1: Write the failing tests** (`src/compareUi.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { DataLayerManager } from "./data/manager.js";
import { installDrapeExclusivity } from "./data/drapeExclusive.js";
import { createCompare } from "./compare.js";
import { installCompareUi } from "./compareUi.js";

// A DOM stub: `style` is a plain object, so a test reads back exactly what the code assigned.
function stubDoc() {
  const mk = (tag) => ({
    tag,
    children: [],
    style: {},
    handlers: {},
    textContent: "",
    value: "",
    className: "",
    id: "",
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener(ev, fn) {
      this.handlers[ev] = fn;
    },
    setPointerCapture() {},
  });
  return { body: mk("body"), createElement: mk };
}
const find = (root, pred) => {
  if (pred(root)) return root;
  for (const c of root.children) {
    const f = find(c, pred);
    if (f) return f;
  }
  return null;
};
const byClass = (root, cls) => find(root, (e) => e.className === cls);

const DRAPES = [
  { id: "oisst", name: "Sea surface temp" },
  { id: "chlor-a", name: "Chlorophyll" },
  { id: "ndvi", name: "NDVI" },
];
const time = {
  oisst: "2026-09-20T00:00:00Z",
  "chlor-a": "2026-09-18",
  ndvi: null,
};
const error = { oisst: null, "chlor-a": null, ndvi: null };
function setup() {
  const mgr = new DataLayerManager({});
  for (const { id } of DRAPES)
    mgr.register({
      id,
      name: id,
      icon: "",
      source: "t",
      updateInterval: -1,
      async init() {},
      enable() {},
      disable() {},
      async update() {
        return true;
      },
      getStats() {
        return { count: 1, lastUpdate: null, time: time[id], error: error[id] };
      },
    });
  const ids = DRAPES.map((d) => d.id);
  const compare = createCompare({
    dataManager: mgr,
    drapeIds: ids,
    setSplit() {},
    setPosition() {},
  });
  installDrapeExclusivity(mgr, ids, { exempt: compare.exempt });
  const doc = stubDoc();
  const container = {
    ...doc.createElement("div"),
    getBoundingClientRect: () => ({ left: 100, width: 800 }),
  };
  let restack = null;
  const ui = installCompareUi({
    doc,
    compare,
    dataManager: mgr,
    drapes: DRAPES,
    container,
    onRestack: (fn) => {
      restack = fn;
      return () => {};
    },
  });
  return { mgr, compare, doc, container, ui, fireRestack: () => restack() };
}
// the manager's enable lifecycle spans several awaits; one macrotask of slack settles it
const tick = () => new Promise((r) => setTimeout(r, 20));

test("the pill opens compare with the drape already on as the left side; panel and divider appear", async () => {
  const { mgr, compare, ui } = setup();
  assert.equal(ui.panel.style.display, "none");
  assert.equal(ui.divider.style.display, "none");
  await mgr.setEnabled("chlor-a", true, { origin: "user" });
  ui.toggle.handlers.click();
  await tick();
  assert.deepEqual(compare.getState(), {
    left: "chlor-a",
    right: "oisst",
    position: 0.5,
  });
  assert.equal(ui.panel.style.display, "flex");
  assert.equal(ui.divider.style.display, "block");
  assert.equal(ui.divider.style.left, "50%");
  assert.equal(ui.toggle.style.display, "none");
});

test("each side is labelled with its own date; a side with no date or in error says so", async () => {
  const { compare, ui } = setup();
  await compare.set("oisst", "chlor-a");
  assert.equal(byClass(ui.panel, "cmp-left-date").textContent, "2026-09-20");
  assert.equal(byClass(ui.panel, "cmp-right-date").textContent, "2026-09-18");
  await compare.set("oisst", "ndvi");
  assert.equal(byClass(ui.panel, "cmp-right-date").textContent, "no date");
  error.ndvi = "map tiles failing";
  ui.render();
  assert.equal(
    byClass(ui.panel, "cmp-right-date").textContent,
    "⚠ map tiles failing",
  );
  error.ndvi = null;
});

test("side labels follow a restack (a scrub rebuilt a drape's image)", async () => {
  const { compare, ui, fireRestack } = setup();
  await compare.set("oisst", "chlor-a");
  time["chlor-a"] = "2019-06-01";
  fireRestack();
  assert.equal(byClass(ui.panel, "cmp-right-date").textContent, "2019-06-01");
  time["chlor-a"] = "2026-09-18";
});

test("choosing a side in a select sets it; choosing the other side's drape swaps them", async () => {
  const { compare, ui } = setup();
  await compare.set("oisst", "chlor-a");
  const right = byClass(ui.panel, "cmp-right");
  right.value = "ndvi";
  right.handlers.change();
  await tick();
  assert.deepEqual(compare.getState(), {
    left: "oisst",
    right: "ndvi",
    position: 0.5,
  });
  const left = byClass(ui.panel, "cmp-left");
  left.value = "ndvi";
  left.handlers.change();
  await tick();
  assert.deepEqual(compare.getState(), {
    left: "ndvi",
    right: "oisst",
    position: 0.5,
  });
});

test("dragging the divider moves the split; drag past the edge clamps", async () => {
  const { compare, ui } = setup();
  await compare.set("oisst", "chlor-a");
  ui.divider.handlers.pointermove({ clientX: 300 }); // not dragging yet: ignored
  assert.equal(compare.getState().position, 0.5);
  ui.divider.handlers.pointerdown({ pointerId: 1, preventDefault() {} });
  ui.divider.handlers.pointermove({ clientX: 300 }); // (300-100)/800
  assert.equal(compare.getState().position, 0.25);
  assert.equal(ui.divider.style.left, "25%");
  ui.divider.handlers.pointermove({ clientX: 5000 });
  assert.equal(compare.getState().position, 1);
  ui.divider.handlers.pointerup({});
  ui.divider.handlers.pointermove({ clientX: 300 });
  assert.equal(compare.getState().position, 1);
  assert.match(ui.divider.style.cssText, /touch-action:none/);
});

test("close ends compare and hides the panel; compare ended elsewhere hides it too", async () => {
  const { mgr, compare, ui } = setup();
  await compare.set("oisst", "chlor-a");
  byClass(ui.panel, "cmp-close").handlers.click();
  await tick();
  assert.equal(compare.getState(), null);
  assert.equal(ui.panel.style.display, "none");
  assert.equal(ui.divider.style.display, "none");
  assert.equal(ui.toggle.style.display, "");
  await compare.set("oisst", "chlor-a");
  await mgr.setEnabled("ndvi", true, { origin: "user" });
  assert.equal(ui.panel.style.display, "none");
});
```

- [ ] **Step 2: Run, watch fail**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/compareUi.test.mjs`
Expected: FAIL, "Cannot find module … compareUi.js".

- [ ] **Step 3: Implement `src/compareUi.js`**

```js
/**
 * The Compare panel (grill Q5): a "⇆ Compare" pill above the observed-time bar opens two drape
 * pickers, each labelled with ITS OWN date (A7), and a draggable divider over the globe. All state
 * lives in the compare controller (compare.js); this only draws it and forwards input.
 */
const BTN =
  "background:#16233a;color:#cfe3ff;border:1px solid rgba(120,170,255,.4);border-radius:5px;padding:2px 7px;cursor:pointer;font:inherit";
const dateOf = (stats) =>
  stats?.error
    ? `⚠ ${stats.error}`
    : stats?.time
      ? String(stats.time).slice(0, 10)
      : "no date";

export function installCompareUi({
  doc = globalThis.document,
  compare,
  dataManager,
  drapes,
  container,
  onRestack = () => () => {},
}) {
  if (!doc || !container)
    throw new Error(
      "installCompareUi: needs a document and the globe container",
    );
  if (!drapes?.length || drapes.length < 2)
    throw new Error("installCompareUi: needs at least two drapes");
  const el = (tag, css, text) => {
    const e = doc.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  };
  const toggle = el(
    "button",
    `position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:30;${BTN}`,
    "⇆ Compare",
  );
  toggle.id = "compare-toggle";
  toggle.title = "Swipe between two map layers";
  const panel = el(
    "div",
    "position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:30;gap:8px;align-items:center;" +
      "padding:6px 10px;border-radius:8px;background:rgba(8,12,18,0.82);color:#cfe3ff;" +
      "font:12px/1.2 var(--font-mono, ui-monospace, monospace);border:1px solid rgba(120,170,255,0.35)",
  );
  panel.id = "compare-panel";
  const side = (cls) => {
    const select = el("select", BTN);
    select.className = `cmp-${cls}`;
    for (const d of drapes) {
      const o = el("option", null, d.name);
      o.value = d.id;
      select.appendChild(o);
    }
    const date = el("span", "min-width:7em;opacity:.8");
    date.className = `cmp-${cls}-date`;
    return { select, date };
  };
  const L = side("left");
  const R = side("right");
  const close = el("button", BTN, "✕");
  close.className = "cmp-close";
  close.title = "End compare";
  for (const n of [
    L.date,
    L.select,
    el("span", null, "⇆"),
    R.select,
    R.date,
    close,
  ])
    panel.appendChild(n);
  const divider = el(
    "div",
    "position:absolute;top:0;bottom:0;width:4px;margin-left:-2px;background:rgba(207,227,255,.9);" +
      "box-shadow:0 0 6px rgba(0,0,0,.6);cursor:ew-resize;touch-action:none;z-index:25",
  );
  divider.id = "compare-divider";
  doc.body.appendChild(toggle);
  doc.body.appendChild(panel);
  container.appendChild(divider);

  const statsOf = (id) => dataManager.getAll().find((l) => l.id === id)?.stats;
  const render = () => {
    const s = compare.getState();
    toggle.style.display = s ? "none" : "";
    panel.style.display = s ? "flex" : "none";
    divider.style.display = s ? "block" : "none";
    if (!s) return;
    L.select.value = s.left;
    R.select.value = s.right;
    L.date.textContent = dateOf(statsOf(s.left));
    R.date.textContent = dateOf(statsOf(s.right));
    divider.style.left = `${Math.round(s.position * 1000) / 10}%`;
  };
  const fail = (e) => console.error("[compare]", e);

  toggle.addEventListener("click", () => {
    const left =
      drapes.find((d) => dataManager.isEnabled(d.id))?.id ?? drapes[0].id;
    const right = drapes.find((d) => d.id !== left).id;
    compare.set(left, right).catch(fail);
  });
  const pick = (which) => () => {
    const s = compare.getState();
    if (!s) return;
    const other = which === "left" ? "right" : "left";
    const v = (which === "left" ? L : R).select.value;
    const next = { ...s, [which]: v };
    if (v === s[other]) next[other] = s[which]; // picked the other side's drape: swap
    compare.set(next.left, next.right).catch(fail);
  };
  L.select.addEventListener("change", pick("left"));
  R.select.addEventListener("change", pick("right"));
  close.addEventListener("click", () => compare.off().catch(fail));

  let dragging = false;
  divider.addEventListener("pointerdown", (e) => {
    dragging = true;
    divider.setPointerCapture?.(e.pointerId);
    e.preventDefault?.();
  });
  divider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = container.getBoundingClientRect();
    compare.move((e.clientX - r.left) / r.width);
  });
  const stop = () => {
    dragging = false;
  };
  divider.addEventListener("pointerup", stop);
  divider.addEventListener("pointercancel", stop);

  compare.subscribe(render);
  dataManager.subscribe(render);
  onRestack(render);
  render();
  return { toggle, panel, divider, render };
}
```

- [ ] **Step 4: Run, watch pass; mutants**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/compareUi.test.mjs`
Expected: PASS, 6/6. Mutants, each restored after:

- (a) delete `onRestack(render)`. Expected to fail: "side labels follow a restack".
- (b) `dateOf` returns `String(stats?.time).slice(0,10)` only. Expected to fail: the error and no-date test.
- (c) drop the `if (!dragging) return`. Expected to fail: the drag test's first assertion.

- [ ] **Step 5: Commit**

```bash
git add src/compareUi.js src/compareUi.test.mjs
git commit -m "Compare panel: pill above the time bar, two drape pickers each labelled with its own date (or its error), a swap when a side picks the other's drape, and a pointer-draggable divider clamped to the globe."
```

---

### Task 6: Share link carries `cmp`

**Files:** Modify:

- `src/sharelink.js`: the provider next to `setPanelStateProvider` (~l.368), the notify method next to `onPanelStateChange` (~l.382), `_buildHashParams` after the panel-state line (~l.515), and the `parseInitialHash` state object next to `panelState:` (~l.234).
- `src/ui.js`: after `this._initialShareState = this.shareLinkManager.parseInitialHash();` (~l.2590), plus a getter next to `get initialRestorePromise()` (~l.10119).

Test: create `src/sharelink.compare.test.mjs`.

**Interfaces:**

- Produces:
  - `ShareLinkManager#setCompareParamProvider(fn: () => string|null)`;
  - `ShareLinkManager#onCompareStateChange()`;
  - `parseInitialHash().compare` (the raw string, or null);
  - `StyleManager#initialCompareParam` (the raw string, or null).

- [ ] **Step 1: Write the failing tests** (copy `makeManager` verbatim from `src/sharelink.celestial.test.mjs:25-42`, re-reading those lines first)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ShareLinkManager } from "./sharelink.js";
// makeManager(hash) — verbatim from sharelink.celestial.test.mjs

test("cmp is written only while a compare provider returns a value", () => {
  const m = makeManager();
  assert.equal(m._buildHashParams().get("cmp"), null);
  let v = "bm.lc.25";
  m.setCompareParamProvider(() => v);
  assert.equal(m._buildHashParams().get("cmp"), "bm.lc.25");
  v = null;
  assert.equal(m._buildHashParams().has("cmp"), false);
});

test("parseInitialHash hands back cmp raw; absent is null", () => {
  assert.equal(
    makeManager("#lat=10&lon=20&cmp=bm.lc.25").parseInitialHash().compare,
    "bm.lc.25",
  );
  assert.equal(makeManager("#lat=10&lon=20").parseInitialHash().compare, null);
});

test("StyleManager keeps the initial cmp for main.js to restore after the share restore settles", () => {
  const ui = fs.readFileSync(new URL("./ui.js", import.meta.url), "utf8");
  assert.match(
    ui,
    /this\._initialCompareParam = this\._initialShareState\?\.compare \?\? null;/,
  );
  assert.match(
    ui,
    /get initialCompareParam\(\) \{\s*return this\._initialCompareParam \?\? null;\s*\}/,
  );
});
```

(The third test is a source pin, like `sharelink.celestial.test.mjs`'s `sourceBlock`, because `StyleManager` cannot be built under node. The live reload check in Task 1 is the behavioural test.)

- [ ] **Step 2: Run, watch fail**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/sharelink.compare.test.mjs`
Expected: 3 FAIL: `setCompareParamProvider is not a function`, `compare` undefined, and no match.

- [ ] **Step 3: Implement**

In `src/sharelink.js`, after `setPanelStateProvider`:

```js
  /** Install the swipe-compare source: returns the `cmp` value while compare is on, else null. */
  setCompareParamProvider(provider) {
    this._compareParamProvider = typeof provider === 'function' ? provider : null;
  }

  /** Called when compare starts, ends, changes a side, or moves its divider. */
  onCompareStateChange() {
    this._scheduleUpdate();
  }
```

In `_buildHashParams`, directly after `this._encodePanelStateParam(params, this._panelStateProvider?.());`:

```js
const cmp = this._compareParamProvider?.();
if (cmp) params.set("cmp", cmp);
```

In `parseInitialHash`, in the state object after `panelState: decodePanelStateParams(params),`:

```js
      compare: params.get('cmp'),
```

In `src/ui.js`, directly after `this._initialShareState = this.shareLinkManager.parseInitialHash();`:

```js
this._initialCompareParam = this._initialShareState?.compare ?? null;
```

and next to `get initialRestorePromise()`:

```js
  get initialCompareParam() {
    return this._initialCompareParam ?? null;
  }
```

- [ ] **Step 4: Run, watch pass; run the sharelink neighbours**

Run: `PATH="$HOME/.local/node24/bin:$PATH" node --test src/sharelink.compare.test.mjs src/sharelink.celestial.test.mjs`
Expected: PASS, all. Mutant: delete the `if (cmp) params.set(...)` line and expect test 1 to fail, then restore.

- [ ] **Step 5: Commit**

```bash
git add src/sharelink.js src/ui.js src/sharelink.compare.test.mjs
git commit -m "Share link writes cmp while compare is on and hands the initial cmp to main.js through StyleManager.initialCompareParam."
```

---

### Task 7: Wire it into the app; local acceptance

**Files:** Modify `src/main.js`: imports, the `installDrapeExclusivity` call (~l.258), and `window.__godsEyeView` (~l.417).

**Interfaces:**

- Consumes everything above:
  - `setDrapeSplit`, `drapeStackState`, `onDrapeRestack` (Task 2);
  - `installDrapeExclusivity(..., {exempt})` (Task 3);
  - `createCompare`, `encodeCompareParam`, `decodeCompareParam` (Task 4);
  - `installCompareUi` (Task 5);
  - `setCompareParamProvider`, `onCompareStateChange`, `initialCompareParam` (Task 6).
- Produces the page hooks qa-compare reads: `window.__godsEyeView.compare` and `window.__godsEyeView.drapeStack()`.

- [ ] **Step 1: Re-read** `src/main.js:250-262`, `:345-356` and `:415-425` (the Iron Law: line numbers drift), then edit.

Imports (next to the other `./data/` imports):

```js
import {
  setDrapeSplit,
  drapeStackState,
  onDrapeRestack,
} from "./data/rasterDrape.js";
import {
  createCompare,
  encodeCompareParam,
  decodeCompareParam,
} from "./compare.js";
import { installCompareUi } from "./compareUi.js";
```

Check first that `rasterDrape.js` is not already imported in `main.js`. If it is, extend that import instead (`grep -n "rasterDrape" src/main.js`).

Replace the `installDrapeExclusivity(...)` line with:

```js
// One drape at a time (W0-3) — except the two sides of a swipe compare (GIBS stage 2).
const drapeLayers = [
  crwBleachingLayer,
  oisstLayer,
  chlorALayer,
  crwDhwLayer,
  crwHotspotLayer,
  crwSeaIceLayer,
  ndviLayer,
  cmemsO2Layer,
  cmemsPhLayer,
  ...gibsLayers,
];
const drapeIds = drapeLayers.map((l) => l.id);
compare = createCompare({
  dataManager,
  drapeIds,
  setSplit: (id, dir) => setDrapeSplit(viewer.imageryLayers, id, dir),
  setPosition: (p) => {
    viewer.scene.splitPosition = p;
    viewer.scene.requestRender();
  },
});
installDrapeExclusivity(dataManager, drapeIds, { exempt: compare.exempt });
installCompareUi({
  doc: document,
  compare,
  dataManager,
  container: document.getElementById("cesiumContainer"),
  drapes: drapeLayers.map((l) => ({ id: l.id, name: l.name })),
  onRestack: onDrapeRestack,
});
styleManager.shareLinkManager.setCompareParamProvider(() =>
  encodeCompareParam(compare.getState()),
);
compare.subscribe(() => styleManager.shareLinkManager.onCompareStateChange());
const initialCmp = styleManager.initialCompareParam;
if (initialCmp) {
  // After the share restore: its layer lane would otherwise leave only the last-restored drape on.
  styleManager.initialRestorePromise
    .then(() => {
      const c = decodeCompareParam(initialCmp, drapeIds);
      return c && compare.set(c.left, c.right, c.position);
    })
    .catch((e) =>
      console.error(`[compare] share link cmp=${initialCmp} not restored:`, e),
    );
}
```

Declare `let compare = null;` next to where `speciesPanel` is declared (the same scope as `window.__godsEyeView`; check with grep), and add to `window.__godsEyeView`:

```js
      // swipe compare + what each stacked drape is drawing: qa-compare asserts the split on the live layers
      compare,
      drapeStack: () => drapeStackState(viewer.imageryLayers),
```

Check `viewer.scene.requestRender` exists (the scene may use `requestRenderMode`: `grep -n requestRenderMode src/main.js`). Without a render request, a moved divider may not redraw until the camera moves. The drag check in qa-compare would catch that only through `splitPosition`, not through pixels. The critic shots catch pixels.

- [ ] **Step 2: Full unit suite**

Run: `cd ~/wildeye-compare && PATH="$HOME/.local/node24/bin:$PATH" npm test > .superpowers/npm-test.log 2>&1; echo exit=$?; tail -5 .superpowers/npm-test.log`
Expected: exit=0, pass = 3007 + the new tests, fail 0.

- [ ] **Step 3: Build and serve locally; run the acceptance check against it**

Run:

```bash
cd ~/wildeye-compare && PATH="$HOME/.local/node24/bin:$PATH" npm run build > .superpowers/build.log 2>&1; echo build=$?
(cd dist && python3 -m http.server 8766 > /dev/null 2>&1 &)   # stop later with: pkill -f "http[.]server 876[6]"
PATH="$HOME/.local/node24/bin:$PATH" heavy-run node scripts/qa-compare.mjs --url http://localhost:8766/ ; echo exit=$?
```

Expected: build=0; all 8 checks `ok:true`; exit=0.

Check first whether `dist/data/gibs.json` exists after the build (stage 1 served it from `public/data/`). If the local build lacks the GIBS manifest, the GIBS sides cannot enable. In that case, rule and ledger either copying `~/wildeye/public/data/gibs.json` into `dist/data/` for the local run only, or switching the local run's pair to two pipeline drapes via a `--pair` flag.

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "Compare is live in the app: the 14 drapes are pickable, the pair is exempt from one-drape, the share link writes and restores cmp after the share restore settles, and the page exposes compare + drapeStack() for qa-compare."
```

---

### Task 8: Merge, deploy, live acceptance, critic

**Files:** `scripts/qa-compare.mjs` (only if `--shots` needs repair), the grill ledger (memory), `LESSONS.md` if a miss happens.

- [ ] **Step 1: Final whole-branch review** (per the executing skill): `review-package` from `git merge-base main-wildeye HEAD` to HEAD, with a fable reviewer, this plan's Review Focus verbatim, and the ledger rulings. Fix Critical and Important findings test-first; minors go to the ledger.

- [ ] **Step 2: Merge and deploy**

```bash
cd ~/wildeye && git merge --no-ff feat/gibs-stage2-compare -m "GIBS stage 2: swipe Compare panel" && git push origin main-wildeye
pipeline/deploy_pages.sh > /home/<user>/.claude/jobs/<job>/tmp/deploy-stage2.log 2>&1; echo deploy=$?; tail -5 /home/<user>/.claude/jobs/<job>/tmp/deploy-stage2.log
```

Expected: deploy=0. Then wait for Pages to publish: poll `curl -s https://musharna.github.io/wildeye/ | grep -c compareUi\|assets/` until the new asset hash is served (compare it with `ls dist/assets/index-*.js`).

- [ ] **Step 3: Live acceptance (A18)**

Run: `cd ~/wildeye && PATH="$HOME/.local/node24/bin:$PATH" heavy-run node scripts/qa-compare.mjs --shots /home/<user>/.claude/jobs/<job>/tmp/compare-shots; echo exit=$?`
Expected: 8/8 ok, exit=0. The same command exited 1 in Task 1 against the old site.

- [ ] **Step 4: Regressions still green live:** `heavy-run node scripts/qa-gibs.mjs` (23/23) and `heavy-run node scripts/qa-observed-time.mjs` (7/7).

- [ ] **Step 5: Independent critic (visual carve-out).** Copy the 4 shots to `C:\Users\<user>\Downloads\wildeye-compare-2026-09-23\`. Dispatch one critic subagent with the image paths and these criteria:
  - the left of the divider shows night lights and the right shows IGBP land cover;
  - the divider is visible and aligned with the colour boundary;
  - each side's date label is readable and matches its layer (night lights 2016-01-01, land cover 2024-01-01);
  - in Cairo, Chicago and Delhi, lit areas continue across the divider into red (Urban, rgb 255,0,0) land cover;
  - the Amazon is dark on the left and Evergreen Broadleaf (rgb 49,204,49) on the right, with Manaus lit and red.

  PASS/PARTIAL/FAIL per image. On a failure: fix, re-shoot, re-judge.

- [ ] **Step 6: Record.** Append a "Stage 2 result" section to `grill_wildeye_gibs_wave_2026-09-22.md`: SHAs, live check output, critic verdict and "What the grill missed". Mark the open-fog "swipe + time bar" line resolved by A7/A9. Remove the worktree after `git status --porcelain --ignored`.
