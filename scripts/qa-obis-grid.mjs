#!/usr/bin/env node
/**
 * qa-obis-grid.mjs — real-browser acceptance for the Marine records (OBIS) layer (spec 2026-10-02-obis-grid-design.md).
 * Run: node scripts/qa-obis-grid.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * The cells come from the site's own obis_grid.json; what is checked is that the browser puts them where they belong.
 * A cell whose 8 neighbours are each empty or in another record class is flown to and the globe's centre must turn its
 * class's colour, so an image flipped, shifted or stretched by even one cell shows another colour or none there; a cell
 * with no records within two cells must stay as it was. Independent of the pipeline: OBIS's own API counts every licence and leaves dropped and
 * absence records out, as the pipeline does, so the records the readout gives a cell can never exceed the API's count
 * for the same cell.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { cellText } from '../src/data/obisGrid.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'obis-grid';
const UA = { 'User-Agent': 'wildeye/0.1 (qa-obis-grid)' };

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const binOf = (records) => Math.min(String(records).length - 1, 6);

/** A cell with the most records whose 8 neighbours are each empty or in another record class, and a cell with none within two cells. */
function pickCells(m) {
  const at = new Map(m.cells.map((c) => [`${c[0]},${c[1]}`, c]));
  const unlike = (lat, lon, n) => [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => {
    if (!dy && !dx) return true;
    const o = at.get(`${lat + dy},${lon + dx}`);
    return !o || binOf(o[2]) !== binOf(n);
  }));
  const lone = m.cells
    .filter(([lat, lon, n]) => lat > -60 && lat < 60 && lon > -179 && lon < 178 && unlike(lat, lon, n))
    .sort((a, b) => b[2] - a[2])[0] ?? null;
  const emptyNear = ([lat, lon]) => [-2, -1, 0, 1, 2].every((dy) => [-2, -1, 0, 1, 2].every((dx) => !at.has(`${lat + dy},${lon + dx}`)));
  // open ocean first; the full build reaches every one of those, so then continental interiors (OBIS has records even in
  // the Sahara and the outback; Mongolia and central Siberia had none within two cells in the 2026-10-02 build)
  const empty = [[0, -150], [-40, -120], [30, -40], [-60, 80], [20, 160], [45, 100], [65, 100]].find(emptyNear) ?? null;
  return { lone, empty };
}

async function obisTotal(lat, lon) {
  const e = 1e-7; // [lat, lat+1) x [lon, lon+1): a point on the north/east edge belongs to the next cell
  const wkt = `POLYGON((${lon} ${lat}, ${lon + 1 - e} ${lat}, ${lon + 1 - e} ${lat + 1 - e}, ${lon} ${lat + 1 - e}, ${lon} ${lat}))`;
  const res = await fetch(`https://api.obis.org/v3/occurrence?size=0&geometry=${encodeURIComponent(wkt)}`, { headers: UA });
  if (!res.ok) throw new Error(`OBIS API HTTP ${res.status}`);
  return (await res.json()).total;
}

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
const image = { ok: 0, bad: [] };
let manifest = null;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /obis|Data|what-lives-here/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (r.url().includes('/data/obis_grid.json')) manifest = await r.json().catch(() => null);
    if (!r.url().includes('/data/obis_grid.png')) return;
    if (r.status() === 200 || r.status() === 304) image.ok += 1;
    else image.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  const look = ([lat, lon]) => page.evaluate(([la, lo]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lo, la, 300000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, [lat, lon]);
  // Share of the globe's centre within 40 of an RGB colour, and the centre's mean colour, rendered and read in one task.
  const centre = (rgb) => page.evaluate(async (want) => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 90 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 60; c.height = 60;
    const g = c.getContext('2d');
    g.drawImage(src, src.width / 2 - 30, src.height / 2 - 30, 60, 60, 0, 0, 60, 60);
    const d = g.getImageData(0, 0, 60, 60).data;
    let near = 0;
    const mean = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      if (Math.hypot(d[i] - want[0], d[i + 1] - want[1], d[i + 2] - want[2]) < 40) near += 1;
      for (let k = 0; k < 3; k += 1) mean[k] += d[i + k] / (d.length / 4);
    }
    return { near: near / (d.length / 4), mean: mean.map(Math.round) };
  }, rgb);
  const stats = () => page.evaluate((id) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats ?? null, ID);

  // The manifest the site serves, before the layer is on, to choose where to look.
  const served = await page.evaluate(async () => (await fetch('data/obis_grid.json')).json());
  const { lone, empty } = pickCells(served);
  if (!lone || !empty) throw new Error(`no cell to check: lone ${JSON.stringify(lone)}, empty ${JSON.stringify(empty)}`);
  const colour = served.palette[binOf(lone[2])];
  const mid = (c) => [c[0] + 0.5, c[1] + 0.5];

  await look(mid(lone));
  const before = await centre(colour);
  await look(mid(empty));
  const emptyBefore = await centre(colour);

  // Another drape first: switching marine records on must switch it off (one drape at a time).
  const state = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled('surface-water', true, { origin: 'user' });
    const otherOn = dataManager.isEnabled('surface-water');
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate && !s()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), otherOn, otherAfter: dataManager.isEnabled('surface-water') };
  }, ID);
  const emptyAfter = await centre(colour);
  await look(mid(lone));
  const after = await centre(colour);
  const s1 = await stats();
  report('drew', state.on && !s1?.error && s1?.time === served.asOf && image.ok > 0 && image.bad.length === 0 && manifest?.asOf === served.asOf,
    { stats: s1, image200: image.ok, imageBad: image.bad.slice(0, 3) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });
  report('cell-in-its-place', before.near <= 0.1 && after.near >= 0.5,
    { cell: lone.slice(0, 3), colour, nearBefore: before.near.toFixed(3), nearAfter: after.near.toFixed(3), meanAfter: after.mean });
  const shift = Math.hypot(...emptyAfter.mean.map((v, k) => v - emptyBefore.mean[k]));
  report('negative-empty-cell-unpainted', emptyAfter.near <= 0.05 && shift < 12,
    { at: empty, nearAfter: emptyAfter.near.toFixed(3), meanBefore: emptyBefore.mean, meanAfter: emptyAfter.mean });

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(pts)) out[name] = (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null;
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const first = served.cells[0], last = served.cells.at(-1);
  const live = await readAll({ lone: mid(lone), first: mid(first), last: mid(last), empty: mid(empty) });
  const date = `OBIS ${served.asOf}`;
  for (const [name, c] of [['lone', lone], ['first', first], ['last', last]]) {
    report(`reads-${name}-cell`, live[name]?.status === 'value' && live[name].text === cellText(c) && live[name].date === date, { cell: c, got: row(live[name]) });
  }
  report('negative-empty-reads-no-records', live.empty?.status === 'value' && live.empty.text === 'no records' && live.empty.date === date, { got: row(live.empty) });

  const api = await obisTotal(lone[0], lone[1]);
  report('within-obis-api-count', lone[2] <= api && lone[2] > 0, { cell: lone.slice(0, 2), ours: lone[2], obisAllLicences: api });

  // A fixed snapshot: moving the time bar neither reloads the image nor changes what it reads.
  const seen = image.ok + image.bad.length;
  await page.evaluate(() => window.__godsEyeView.observedTime.set('2010-06-01T00:00:00Z'));
  await sleep(3000);
  const s2 = await stats();
  const past = await readAll({ lone: mid(lone) });
  report('ignores-the-time-bar', s2?.time === served.asOf && !s2?.error && image.ok + image.bad.length === seen && past.lone?.text === cellText(lone),
    { stats: s2, newImages: image.ok + image.bad.length - seen, lone: row(past.lone) });
  await page.evaluate(() => window.__godsEyeView.observedTime.set(null));

  const legend = await page.evaluate(() => document.body.textContent.includes('records track survey effort, not richness'));
  report('legend-names-the-share', legend);
  const listing = await page.evaluate(async () => {
    const r = await fetch('data/obis_grid_datasets.json');
    return r.ok ? (await r.json()).datasets.length : `HTTP ${r.status}`;
  });
  report('dataset-listing-served', listing === served.share.datasets_in, { listed: listing, datasetsIn: served.share.datasets_in });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-404-or-console-errors', image.bad.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0,
  { imageBad: image.bad.slice(0, 5), consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, image200: image.ok, imageBad: image.bad.length }));
process.exit(failed ? 1 : 0);
