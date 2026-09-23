#!/usr/bin/env node
/**
 * qa-gibs.mjs — real-browser acceptance for the NASA GIBS layers (stage 1, grill 2026-09-22).
 * Run: node scripts/qa-gibs.mjs [--url https://musharna.github.io/wildeye/] [--shots <dir>]
 * One JSON line per check; exits 1 when any fails.
 * The tile-date check is the one that matters: GIBS answers an unserved date with a neighbouring image and
 * HTTP 200, so "tiles loaded" passes on a wrong date — only comparing the URL's date to gibs.json fails.
 */
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (n, f) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : f);
const SITE = arg("--url", "https://musharna.github.io/wildeye/");
const SHOTS = arg("--shots", null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const IDS = [
  "gibs-landcover",
  "gibs-evi",
  "gibs-lst",
  "gibs-nightlights",
  "gibs-biomass",
];
const results = [];
const report = (check, ok, detail) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--window-size=1400,900",
  ],
  defaultViewport: { width: 1400, height: 900 },
  // SwiftShader can take minutes to paint a frame of fresh tiles; the default 180 s killed screenshots
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const tiles = [];
page.on("response", (r) => {
  if (r.url().startsWith("https://gibs.earthdata.nasa.gov/wmts/"))
    tiles.push({ url: r.url(), status: r.status() });
});
const pageErrors = [];
page.on("pageerror", (e) =>
  pageErrors.push(String(e?.message || e).slice(0, 160)),
);
try {
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime,
    { timeout: 180000 },
  );
  // boot flies to a first view after the manager is up; dismissing before it lands lets it move the camera
  await new Promise((r) => setTimeout(r, 12000));
  await page.evaluate(() => document.querySelector("[data-first-run-suppress]")?.click());
  await page.keyboard.press("Escape");
  const launcherGone = await page
    .waitForFunction(() => !document.querySelector("[data-first-run-choice]")?.offsetParent, { timeout: 15000 })
    .then(() => true, () => false);
  if (!launcherGone) throw new Error("first-run launcher still visible after 15 s; screenshots would be covered");
  const fetched = await page.evaluate(async () => {
    const res = await fetch(`data/gibs.json?t=${Date.now()}`);
    return {
      status: res.status,
      doc: res.ok ? await res.json().catch(() => null) : null,
    };
  });
  const manifest = fetched.doc ?? {};
  report("manifest", !!fetched.doc?.layers, {
    status: fetched.status,
    layers: Object.keys(manifest.layers ?? {}),
  });
  for (const id of IDS) {
    const from = tiles.length;
    const stats = await page.evaluate(async (id) => {
      const dm = window.__godsEyeView.dataManager;
      if (!dm.getAll().some((l) => l.id === id))
        return { error: "not registered" };
      await dm.setEnabled(id, true);
      const deadline = Date.now() + 60000;
      let s;
      while (Date.now() < deadline) {
        s = dm.getAll().find((l) => l.id === id).stats;
        if (s?.lastUpdate || s?.error) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      // getAll() rows carry no module (manager.js:1931-1941); the module lives in dm.layers
      const legend =
        dm.layers.get(id)?.module?.getRowControls?.().legend ?? null;
      return { ...s, legendRows: legend?.length ?? null };
    }, id);
    await new Promise((r) => setTimeout(r, 8000));
    const mine = tiles
      .slice(from)
      .filter((t) => t.url.includes(`/${manifest.layers?.[id]?.gibsId}/`));
    const dates = [
      ...new Set(mine.map((t) => t.url.split("/default/")[1]?.split("/")[0])),
    ];
    const want = stats.time;
    const expectLatest = await page.evaluate(
      (times) => times,
      manifest.layers?.[id]?.times ?? [],
    );
    report(
      `${id}:tiles`,
      mine.length > 0 && mine.every((t) => t.status === 200),
      {
        n: mine.length,
        bad: mine.filter((t) => t.status !== 200).slice(0, 3),
      },
    );
    report(`${id}:date`, dates.length === 1 && dates[0] === want && !!want, {
      urlDates: dates,
      shown: want,
      intervals: expectLatest.slice(-1),
    });
    report(`${id}:legend`, (stats.legendRows ?? 0) > 0, {
      legendRows: stats.legendRows,
    });
    report(`${id}:no-error`, !stats.error, { error: stats.error ?? null });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${id}.png`) });
    await page.evaluate(
      (id) => window.__godsEyeView.dataManager.setEnabled(id, false),
      id,
    );
  }
  // Review focus 5: land cover stretches the bar to 2001; LIVE must still come back.
  const live = await page.evaluate(async () => {
    const g = window.__godsEyeView;
    await g.dataManager.setEnabled("gibs-landcover", true);
    await new Promise((r) => setTimeout(r, 3000));
    const store = g.observedTime;
    const d = store.domain(); // {start, end, stepMs} or null (observedTime.js:121)
    // scrub away first, or the LIVE check passes on a bar that never moved
    store.set("2005-06-01T00:00:00Z");
    const scrubbed = store.get();
    store.set(null);
    await new Promise((r) => setTimeout(r, 1000));
    return {
      domainStart: d ? new Date(d.start).toISOString() : null,
      scrubbed,
      afterLive: store.get(),
    };
  });
  report(
    "live-return-with-landcover",
    live.scrubbed !== null &&
      live.afterLive === null &&
      (live.domainStart ?? "").startsWith("2001"),
    live,
  );
  report("no-page-errors", pageErrors.length === 0, {
    errors: pageErrors.slice(0, 5),
  });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(
  JSON.stringify({ summary: true, checks: results.length, failed }),
);
process.exit(failed ? 1 : 0);
