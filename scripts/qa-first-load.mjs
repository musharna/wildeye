#!/usr/bin/env node
/**
 * qa-first-load.mjs — what a first visit downloads before the globe is usable (grill_wildeye_cesium_2026-09-27: A9-A12, Q4).
 * Run against a Pages build: node scripts/qa-first-load.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails. Headless Chrome on swiftshader only.
 *
 * Why this exists (2026-09-27): at slow 4G a first visit waited 22 s for a usable globe. Blocking request groups showed where
 * it went: Re:Earth terrain −5.2 s, Cesium's assets (the 1024 px star box is 867 KB of them) −5.2 s, Google Fonts −1.6 s,
 * against 0.6 s between two identical runs. The opening view is ~18,000 km up, where terrain relief is below a pixel, and
 * the icon font carried two glyphs. This counts requests and bytes, not milliseconds: a timing budget cannot tell a slow
 * host from a regression. Each check pairs its absence with a positive control, so a page that never loaded cannot pass.
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');

/** Terrain may load once the camera is below this height (Q4); the opening view must be well above it. */
const TERRAIN_ALTITUDE_M = 2_000_000;
const SKYBOX_BUDGET_KB = 300;
const GOOGLE_FONTS = /fonts\.(googleapis|gstatic)\.com/;
const TERRAIN = /terrain\.reearth\.land/;
const SKYBOX = /\/cesium\/Assets\/Textures\/SkyBox\//;

const results = [];
const report = (check, ok, detail) => { results.push({ check, ok }); console.log(JSON.stringify({ check, ok, ...detail })); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], protocolTimeout: 300000 });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const reqs = new Map();
  cdp.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, { url: e.request.url, bytes: 0, phase: 'first' }));
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });
  let phase = 'first';
  cdp.on('Network.requestWillBeSent', (e) => { reqs.get(e.requestId).phase = phase; });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));

  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView.styleManager, { timeout: 180000 });
  // usable globe: the surface has loaded its first view and stays loaded for 500 ms
  await page.waitForFunction(() => { const g = window.__godsEyeView.viewer.scene.globe;
    if (!g.tilesLoaded) { window.__qaTL = 0; return false; } window.__qaTL ||= performance.now(); return performance.now() - window.__qaTL > 500; },
  { timeout: 180000, polling: 100 });
  await new Promise((r) => setTimeout(r, 5000));
  const first = [...reqs.values()].filter((r) => r.phase === 'first');

  // Fonts: nothing from Google; the text faces are self-hosted and loaded; the two icons are drawn, not glyphs.
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/["']/g, '')} ${f.weight}`);
    const icons = ['#clear-selected-layers', '#reset-globe-view'].map((sel) => {
      const btn = document.querySelector(sel); const svg = btn?.querySelector('svg'); const b = svg?.getBoundingClientRect();
      return { sel, svg: Boolean(svg), w: b ? Math.round(b.width) : 0, h: b ? Math.round(b.height) : 0 };
    });
    return { faces: [...new Set(faces)], iconFontElements: document.querySelectorAll('.material-symbols-outlined, .material-icons-round, .material-icons').length, icons };
  });
  const googleFonts = first.filter((r) => GOOGLE_FONTS.test(r.url)).map((r) => r.url.slice(0, 90));
  const hasFace = (fam) => fonts.faces.some((f) => f.startsWith(fam));
  report('fonts-self-hosted', googleFonts.length === 0 && hasFace('Inter') && hasFace('JetBrains Mono')
    && fonts.iconFontElements === 0 && fonts.icons.every((i) => i.svg && i.w >= 12 && i.h >= 12),
  { googleFonts: googleFonts.length, sample: googleFonts.slice(0, 2), ...fonts });

  // Stars: all six faces still load (the sky is not blank), within the budget.
  const sky = first.filter((r) => SKYBOX.test(r.url));
  const skyKb = Math.round(sky.reduce((s, r) => s + r.bytes, 0) / 1024);
  report('skybox-budget', sky.length === 6 && sky.every((r) => r.bytes > 0) && skyKb <= SKYBOX_BUDGET_KB, { faces: sky.length, kb: skyKb, budgetKb: SKYBOX_BUDGET_KB });

  // Terrain: none at the opening view; below 2,000 km it loads, and it stays after zooming back out.
  const openingHeight = await page.evaluate(() => Math.round(window.__godsEyeView.viewer.camera.positionCartographic.height));
  const terrainFirst = first.filter((r) => TERRAIN.test(r.url)).length;
  phase = 'zoomed';
  const zoomed = await page.evaluate(async () => {
    const v = window.__godsEyeView.viewer; const h0 = v.camera.positionCartographic.height;
    v.camera.zoomIn(h0 - 1_000_000);
    const t0 = performance.now();
    while (!v.terrainProvider.availability && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
    const height = Math.round(v.camera.positionCartographic.height), real = Boolean(v.terrainProvider.availability);
    v.camera.zoomOut(h0 - v.camera.positionCartographic.height);
    await new Promise((r) => setTimeout(r, 3000));
    return { height, realTerrain: real, keptAfterZoomOut: Boolean(v.terrainProvider.availability), backTo: Math.round(v.camera.positionCartographic.height) };
  });
  await new Promise((r) => setTimeout(r, 3000));
  const terrainZoomed = [...reqs.values()].filter((r) => r.phase === 'zoomed' && TERRAIN.test(r.url)).length;
  report('terrain-deferred', openingHeight > TERRAIN_ALTITUDE_M && terrainFirst === 0 && zoomed.height < TERRAIN_ALTITUDE_M
    && zoomed.realTerrain && terrainZoomed > 0 && zoomed.keptAfterZoomOut,
  { openingHeight, terrainAtOpening: terrainFirst, ...zoomed, terrainRequestsAfterZoom: terrainZoomed });

  report('no-page-errors', errors.length === 0, { errors: errors.slice(0, 3) });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: true, checks: results.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
