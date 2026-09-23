#!/usr/bin/env node
/**
 * shots-gibs-known-answer.mjs — the visual half of the GIBS known-answer check (grill 2026-09-22, Q6):
 * night lights and IGBP land cover over the same four places, for a reviewer to judge whether the bright
 * areas fall on the "Urban and Built-up Lands" class and the Amazon is dark forest.
 * Run: node scripts/shots-gibs-known-answer.mjs --out <dir> [--url https://musharna.github.io/wildeye/]
 * Exits 1 if a layer fails to load or the globe never finishes loading tiles for a view.
 */
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (n, f) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : f);
const SITE = arg("--url", "https://musharna.github.io/wildeye/");
const OUT = arg("--out", null);
if (!OUT) throw new Error("--out <dir> is required");
mkdirSync(OUT, { recursive: true });
// --layers picks a subset; SwiftShader Chrome needs several GB, so run it in its own memory budget (jobd / heavy-run)
const LAYERS = arg("--layers", "gibs-nightlights,gibs-landcover").split(",");
const PLACES = {
  cairo: [31.24, 30.04],
  chicago: [-87.63, 41.88],
  delhi: [77.21, 28.61],
  amazon: [-62.0, -4.0],
};
const HEIGHT_M = 600000;

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
  protocolTimeout: 600000,
});
let failed = 0;
try {
  const page = await browser.newPage();
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  // boot flies to a first view after the manager is up; dismissing before it lands lets it move the camera
  await new Promise((r) => setTimeout(r, 12000));
  await page.evaluate(() => document.querySelector("[data-first-run-suppress]")?.click());
  await page.keyboard.press("Escape");
  const launcherGone = await page
    .waitForFunction(() => !document.querySelector("[data-first-run-choice]")?.offsetParent, { timeout: 15000 })
    .then(() => true, () => false);
  if (!launcherGone) throw new Error("first-run launcher still visible after 15 s; screenshots would be covered");
  for (const id of LAYERS) {
    const stats = await page.evaluate(async (id) => {
      const dm = window.__godsEyeView.dataManager;
      for (const other of ["gibs-nightlights", "gibs-landcover"]) if (other !== id) await dm.setEnabled(other, false);
      await dm.setEnabled(id, true);
      const deadline = Date.now() + 60000;
      let s;
      while (Date.now() < deadline) {
        s = dm.getAll().find((l) => l.id === id)?.stats;
        if (s?.lastUpdate || s?.error) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return s ?? { error: "not registered" };
    }, id);
    if (stats.error || !stats.time) {
      console.log(JSON.stringify({ id, ok: false, error: stats.error ?? "no date shown" }));
      failed += 1;
      continue;
    }
    for (const [place, [lon, lat]] of Object.entries(PLACES)) {
      const loaded = await page.evaluate(async ([lon, lat, h]) => {
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
        while (Date.now() < deadline && !v.scene.globe.tilesLoaded) await new Promise((r) => setTimeout(r, 500));
        return v.scene.globe.tilesLoaded;
      }, [lon, lat, HEIGHT_M]);
      await new Promise((r) => setTimeout(r, 3000));
      const file = path.join(OUT, `${place}-${id}.png`);
      await page.screenshot({ path: file });
      console.log(JSON.stringify({ id, place, date: stats.time, tilesLoaded: loaded, file, ok: loaded }));
      if (!loaded) failed += 1;
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
