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
// The app's own failure reports (a side that did not enable, GIBS tiles failing): a failed check says why.
const consoleErrors = [];
const open = async (url) => {
  const page = await browser.newPage();
  page.on("pageerror", (e) =>
    pageErrors.push(String(e?.message || e).slice(0, 160)),
  );
  page.on("console", (m) => {
    if (m.type() === "error" && /compare|gibs|Data/.test(m.text()))
      consoleErrors.push(m.text().slice(0, 200));
  });
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
  // Dismissed the way qa-gibs does it; checking for the element's mere presence fails even when hidden.
  await sleep(12000);
  await page.evaluate(() =>
    document.querySelector("[data-first-run-suppress]")?.click(),
  );
  await page.keyboard.press("Escape");
  const launcherGone = await page
    .waitForFunction(
      () => !document.querySelector("[data-first-run-choice]")?.offsetParent,
      { timeout: 15000 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!launcherGone)
    throw new Error("first-run launcher still covers the globe after 15 s");
  return page;
};
const sides = (page) =>
  page.evaluate(() => {
    const g = window.__godsEyeView;
    return {
      state: g.compare?.getState() ?? null,
      stack: g.drapeStack ? g.drapeStack() : null,
      splitPosition: g.viewer.scene.splitPosition,
      enabled: [...g.dataManager.getEnabledLayerIds()], // a Set: would serialize as {}
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
    {
      state: r.state,
      left: splitOf(r, LEFT),
      right: splitOf(r, RIGHT),
      enabled: r.enabled.filter((id) => /gibs/.test(id)),
      consoleErrors: consoleErrors.slice(-4),
    },
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
