#!/usr/bin/env node
/**
 * qa-surface-water.mjs — real-browser acceptance for the surface-water layer (spec 2026-10-01-surface-water-design.md).
 * Run: node scripts/qa-surface-water.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, decoded 2026-10-01 by a Python probe straight from JRC's z13 tiles (its own colour table, not
 * the site's decoder), each the centre of a 5×5 block so a one-pixel error in the tile math cannot change the
 * answer: open Lake Victoria reads 97–99% (block 97–99, centre 98; cloudy months keep it under 100), Tonle Sap's
 * flood plain 83% (whole block), the open Atlantic 100% (the sea is permanent water), the Sahara no water (whole
 * block). 80°N is beyond the data (a 404 tile). Proof it drew: the globe over Lake Victoria gains JRC's saturated
 * blue when the layer is on. Every water pixel of the real tiles the readout used must decode.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { decodeOccurrence, PERIOD } from '../src/data/surfaceWater.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'surface-water';
const P = {
  victoria: [-0.987433, 32.97967],
  tonleSap: [12.811048, 103.97624],
  atlantic: [10.0, -35.0],
  sahara: [23.523307, 11.997499],
  north: [80.0, 20.0],
};

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
const tiles = { ok: 0, notFound: 0, bad: [], urls: new Set() };
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /surface|Data|what-lives-here|JRC/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', (r) => {
    if (!r.url().includes('global-surface-water/tiles2021')) return;
    tiles.urls.add(r.url());
    if (r.status() === 200) tiles.ok += 1;
    else if (r.status() === 404) tiles.notFound += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // Share of JRC's saturated water blue at the globe's centre, rendered and read back in one task.
  const bluePixels = () => page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 90 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.drawImage(src, src.width / 2 - 100, src.height / 2 - 100, 200, 200, 0, 0, 200, 200);
    const d = g.getImageData(0, 0, 200, 200).data;
    let n = 0;
    // satellite water is dark; JRC's permanent water is near (0,0,255)
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 150 && d[i] < 90 && d[i + 1] < 90) n += 1;
    return n / (d.length / 4);
  });
  // Wait until the JRC tile responses stop arriving (the globe's tilesLoaded is about terrain).
  const settle = async () => {
    let last = -1, still = 0;
    for (let i = 0; i < 180 && still < 8; i += 1) {
      await sleep(500);
      const n = tiles.ok + tiles.notFound + tiles.bad.length;
      still = n > 0 && n === last ? still + 1 : 0;
      last = n;
    }
  };

  await page.evaluate(async ([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 150000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, P.victoria);
  const before = await bluePixels();
  // Another drape first: switching surface water on must switch it off (one drape at a time).
  const state = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled('gibs-landcover', true, { origin: 'user' });
    const otherOn = dataManager.isEnabled('gibs-landcover');
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !stats()?.lastUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), otherOn, otherAfter: dataManager.isEnabled('gibs-landcover'), stats: stats() ?? null };
  }, ID);
  await settle();
  const after = await bluePixels();
  report('drew', state.on && after - before > 0.2 && !state.stats?.error && tiles.ok > 0 && tiles.bad.length === 0,
    { before: before.toFixed(4), after: after.toFixed(4), stats: state.stats, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { landcoverBefore: state.otherOn, landcoverAfter: state.otherAfter });

  // The data stop at 78°N: over Svalbard the globe loads JRC tiles south of the edge and asks for none past it
  // (a 404 there is no data, and enough of them used to mark a working layer "map tiles failing").
  const atEdge = { ok: tiles.ok, notFound: tiles.notFound };
  await page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(16, 78.5, 900000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  });
  await settle();
  const edgeStats = await page.evaluate((id) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats ?? null, ID);
  report('polar-edge-no-404', tiles.ok - atEdge.ok > 0 && tiles.notFound === atEdge.notFound && !edgeStats?.error,
    { tiles200: tiles.ok - atEdge.ok, tiles404: tiles.notFound - atEdge.notFound, error: edgeStats?.error ?? null });

  const live = await page.evaluate(async (id, points) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(points)) {
      const rows = await window.__godsEyeView.readoutAt(lat, lon);
      out[name] = rows.find((r) => r.id === id) ?? null;
    }
    return out;
  }, ID, P);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const percent = (r) => Number(/^Water in (\d+)% of months$/.exec(r?.text ?? '')?.[1]);
  const isValue = (r) => r?.status === 'value' && r.date === PERIOD;
  report('permanent-victoria', isValue(live.victoria) && percent(live.victoria) >= 97 && percent(live.victoria) <= 99, { got: row(live.victoria) });
  report('seasonal-tonle-sap', isValue(live.tonleSap) && percent(live.tonleSap) === 83, { got: row(live.tonleSap) });
  report('open-sea', isValue(live.atlantic) && percent(live.atlantic) === 100, { got: row(live.atlantic) });
  report('negative-sahara', live.sahara?.status === 'class' && live.sahara.text === 'No surface water seen' && live.sahara.date === PERIOD, { got: row(live.sahara) });
  report('outside-north', live.north?.status === 'outside', { got: row(live.north) });

  // Every pixel of the real z13 tiles the readout fetched, decoded by the site's own table: none unrecognised.
  const urls = [...tiles.urls].filter((u) => /\/13\/\d+\/\d+\.png$/.test(u));
  // Decoded from the file's bytes, as the readout does: a 2D canvas would round every semi-transparent colour.
  const colours = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) continue;
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const k = `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`;
      colours[k] = (colours[k] || 0) + 1;
    }
  }
  let water = 0;
  const unknown = {};
  for (const [k, n] of Object.entries(colours)) {
    water += n;
    if (decodeOccurrence(k.split(',').map(Number)).kind !== 'value') unknown[k] = n;
  }
  report('every-pixel-decodes', urls.length >= 3 && water > 0 && Object.keys(unknown).length === 0,
    { z13Tiles: urls.length, waterPixels: water, colours: Object.keys(colours).length, unknown });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, tiles200: tiles.ok, tiles404: tiles.notFound }));
process.exit(failed ? 1 : 0);
