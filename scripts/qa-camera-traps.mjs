#!/usr/bin/env node
/**
 * qa-camera-traps.mjs — real-browser acceptance for the Camera traps and eDNA (GBIF) layers (spec
 * 2026-10-03-camera-traps-edna-design.md). Run: node scripts/qa-camera-traps.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * The cells come from the site's own camera_traps.json; what is checked is that the browser puts each method's cells
 * where they belong (as qa-obis-grid.mjs: a cell whose 8 neighbours are each empty or in another record class must turn
 * its class's colour; a cell with none within two cells must stay as it was), that each layer reads its own method only,
 * and that one drape shows at a time, the two of them included. Independent of the pipeline, GBIF's search API brackets
 * a cell's records: its count for the commonest exact protocol values (case-insensitive whole-value match, OR within the
 * parameter) cannot exceed ours, which match substrings; its count with no protocol filter cannot be below ours. And a
 * cell where GBIF holds DNA-derived animal records but no protocol names eDNA must read no eDNA records.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { METHODS, cellText } from '../src/data/gbifMethodGrid.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const UA = { 'User-Agent': 'wildeye/0.1 (qa-camera-traps)' };
// `license`, US spelling: GBIF ignores an unknown parameter, and `licence=` silently counted every licence (2026-10-03)
const GBIF = 'https://api.gbif.org/v1/occurrence/search?limit=0&license=CC0_1_0&license=CC_BY_4_0&kingdomKey=1'
  + '&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT';
// exact values among the commonest protocols (GBIF facet, 2026-10-03); each contains one of the pipeline's phrases
const EXACT = {
  camera: ['camera trap', 'camera trapping', 'cameratrap', 'camera - surveillance/remote', 'observed-remote camera', 'photo trap'],
  edna: ['edna expeditions citizen science sampling', 'edna sampling from soil', 'edna sampling from rhizosphere soil'],
};
// DNA-barcoding centres and bulk-trap sites (iBOL Guelph, the Smithsonian, Costa Rica's ACG), tried in order for a cell
// GBIF holds DNA-derived animal records in and no protocol there names eDNA
const DNA_NOT_EDNA = [[43, -81], [38, -77], [10, -86], [-35, 149], [51, 0]];
// a CC BY-NC camera-trap dataset (Piedemont, Colombia; 108,093 records 2026-10-03): the licence filter must leave none of it
const NC_CAMERA_DATASET = '3856c01f-5031-4cc1-a5b2-2daa9537411b';

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const binOf = (records) => Math.min(String(records).length - 1, 6);
const mid = (c) => [c[0] + 0.5, c[1] + 0.5];
const keyOf = (c) => `${c[0]},${c[1]}`;

/** A cell with the most records whose 8 neighbours are each empty or in another record class, and a cell with none within two cells. */
function pickCells(cells) {
  const at = new Map(cells.map((c) => [keyOf(c), c]));
  const unlike = (lat, lon, n) => [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => {
    if (!dy && !dx) return true;
    const o = at.get(`${lat + dy},${lon + dx}`);
    return !o || binOf(o[2]) !== binOf(n);
  }));
  const lone = cells
    .filter(([lat, lon, n]) => lat > -60 && lat < 60 && lon > -179 && lon < 178 && unlike(lat, lon, n))
    .sort((a, b) => b[2] - a[2])[0] ?? null;
  const emptyNear = ([lat, lon]) => [-2, -1, 0, 1, 2].every((dy) => [-2, -1, 0, 1, 2].every((dx) => !at.has(`${lat + dy},${lon + dx}`)));
  const empty = [[0, -150], [-40, -120], [30, -40], [-50, 80], [20, 160]].find(emptyNear) ?? null;
  return { lone, empty };
}

async function gbifCount(lat, lon, extra = '') {
  const e = 1e-7; // [lat, lat+1) x [lon, lon+1): a point on the north/east edge belongs to the next cell
  const wkt = `POLYGON((${lon} ${lat},${lon + 1 - e} ${lat},${lon + 1 - e} ${lat + 1 - e},${lon} ${lat + 1 - e},${lon} ${lat}))`;
  await sleep(1000);
  const res = await fetch(`${GBIF}&geometry=${encodeURIComponent(wkt)}${extra}`, { headers: UA });
  if (!res.ok) throw new Error(`GBIF API HTTP ${res.status}`);
  return (await res.json()).count;
}
const protocols = (method) => EXACT[method].map((p) => `&samplingProtocol=${encodeURIComponent(p)}`).join('');

// The bracket's licence filter engages: an NC dataset counts nothing under it and something without it.
try {
  const count = async (q) => {
    await sleep(1000);
    const r = await fetch(`https://api.gbif.org/v1/occurrence/search?limit=0&datasetKey=${NC_CAMERA_DATASET}${q}`, { headers: UA });
    if (!r.ok) throw new Error(`GBIF API HTTP ${r.status}`);
    return (await r.json()).count;
  };
  const without = await count('');
  const within = await count('&license=CC0_1_0&license=CC_BY_4_0');
  report('gbif-api-licence-filter-engages', without > 0 && within === 0, { dataset: NC_CAMERA_DATASET, anyLicence: without, cc0OrCcBy: within });
} catch (e) {
  report('gbif-api-licence-filter-engages', false, { error: String(e?.message || e).slice(0, 200) });
}

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
const images = { 'camera_traps.png': { ok: 0, bad: [] }, 'edna.png': { ok: 0, bad: [] } };
const imageBad = () => Object.values(images).flatMap((i) => i.bad);
const imageSeen = () => Object.values(images).reduce((s, i) => s + i.ok + i.bad.length, 0);
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /camera|edna|gbif|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', (r) => {
    const name = Object.keys(images).find((n) => r.url().includes(`/data/${n}`));
    if (!name) return;
    if (r.status() === 200 || r.status() === 304) images[name].ok += 1;
    else images[name].bad.push(`${r.status()} ${r.url()}`);
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
  // Two renders first, so tilesLoaded speaks for the new view, not the last one.
  const centre = (rgb) => page.evaluate(async (want) => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 2; i += 1) { v.scene.render(); await new Promise((r) => requestAnimationFrame(r)); }
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
  const stats = (id) => page.evaluate((i) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === i)?.stats ?? null, id);
  const enable = (id, on = true) => page.evaluate(async (i, o) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(i, o, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === i)?.stats;
    for (let k = 0; o && k < 60 && !s()?.lastUpdate && !s()?.error; k += 1) await new Promise((r) => setTimeout(r, 500));
    return dataManager.isEnabled(i);
  }, id, on);
  const isOn = (id) => page.evaluate((i) => window.__godsEyeView.dataManager.isEnabled(i), id);
  const readAll = (id, points) => page.evaluate(async (i, pts) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(pts)) out[name] = (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === i) ?? null;
    return out;
  }, id, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;

  // The manifest the site serves, before either layer is on, to choose where to look.
  const served = await page.evaluate(async () => (await fetch('data/camera_traps.json')).json());
  const date = `GBIF ${served.asOf}`;
  const picks = {};
  for (const method of Object.keys(METHODS)) {
    picks[method] = pickCells(served.methods[method].cells);
    if (!picks[method].lone || !picks[method].empty) throw new Error(`${method}: no cell to check: ${JSON.stringify(picks[method])}`);
  }
  // a cell one method has and the other lacks, so each layer is seen to read its own method only
  const only = (method, other) => {
    const theirs = new Set(served.methods[other].cells.map(keyOf));
    return served.methods[method].cells.find((c) => !theirs.has(keyOf(c))) ?? null;
  };
  const cameraOnly = only('camera', 'edna');
  const ednaOnly = only('edna', 'camera');

  const before = {};
  for (const [method, { lone, empty }] of Object.entries(picks)) {
    const colour = served.methods[method].palette[binOf(lone[2])];
    await look(mid(lone));
    const cell = await centre(colour);
    await look(mid(empty));
    before[method] = { colour, cell, empty: await centre(colour) };
  }

  // Another drape first: each method's layer switches it off, and the second method's layer switches the first off.
  const otherOn = await enable('surface-water');
  for (const [method, { lone, empty }] of Object.entries(picks)) {
    const { id } = METHODS[method];
    const on = await enable(id);
    const { colour } = before[method];
    await look(mid(empty));
    const emptyHere = await centre(colour);
    await look(mid(lone));
    const after = await centre(colour);
    const s = await stats(id);
    const img = images[served.methods[method].image.replace('data/', '')];
    report(`${method}-drew`, on && !s?.error && s?.time === served.asOf && s?.count === served.methods[method].cells.length && img.ok > 0 && img.bad.length === 0,
      { stats: s, image200: img.ok, imageBad: img.bad.slice(0, 3) });
    report(`${method}-cell-in-its-place`, before[method].cell.near <= 0.1 && after.near >= 0.5,
      { cell: lone.slice(0, 3), colour, nearBefore: before[method].cell.near.toFixed(3), nearAfter: after.near.toFixed(3), meanAfter: after.mean });
    const shift = Math.hypot(...emptyHere.mean.map((v, k) => v - before[method].empty.mean[k]));
    report(`${method}-negative-empty-cell-unpainted`, emptyHere.near <= 0.05 && shift < 12,
      { at: empty, nearAfter: emptyHere.near.toFixed(3), meanBefore: before[method].empty.mean, meanAfter: emptyHere.mean });

    const first = served.methods[method].cells[0], last = served.methods[method].cells.at(-1);
    const theirs = method === 'camera' ? ednaOnly : cameraOnly;
    const points = { lone: mid(lone), first: mid(first), last: mid(last), empty: mid(empty) };
    if (theirs) points.theirs = mid(theirs);
    const live = await readAll(id, points);
    for (const [name, c] of [['lone', lone], ['first', first], ['last', last]]) {
      report(`${method}-reads-${name}-cell`, live[name]?.status === 'value' && live[name].text === cellText(c) && live[name].date === date, { cell: c, got: row(live[name]) });
    }
    report(`${method}-negative-empty-reads-none`, live.empty?.status === 'value' && live.empty.text === METHODS[method].none && live.empty.date === date, { got: row(live.empty) });
    report(`${method}-negative-other-method-cell-reads-none`, Boolean(theirs) && live.theirs?.text === METHODS[method].none,
      { cell: theirs?.slice(0, 3) ?? null, got: row(live.theirs) });

    const [low, high] = [await gbifCount(lone[0], lone[1], protocols(method)), await gbifCount(lone[0], lone[1])];
    report(`${method}-within-gbif-api-bracket`, low > 0 && low <= lone[2] && lone[2] <= high,
      { cell: lone.slice(0, 2), exactProtocols: low, ours: lone[2], anyProtocol: high });
  }
  report('one-drape-at-a-time', otherOn === true && !(await isOn('surface-water')) && !(await isOn(METHODS.camera.id)) && (await isOn(METHODS.edna.id)),
    { surfaceWaterBefore: otherOn });

  // DNA-derived records are not eDNA: a barcoding cell without an eDNA protocol reads none.
  const ednaCells = new Set(served.methods.edna.cells.map(keyOf));
  let dna = null;
  for (const c of DNA_NOT_EDNA) {
    if (ednaCells.has(keyOf(c))) continue;
    const n = await gbifCount(c[0], c[1], '&dwcaExtension=http%3A%2F%2Frs.gbif.org%2Fterms%2F1.0%2FDNADerivedData');
    if (n > 0) { dna = { cell: c, dnaDerived: n }; break; }
  }
  const dnaRead = dna && (await readAll(METHODS.edna.id, { c: mid(dna.cell) })).c;
  report('negative-dna-derived-is-not-edna', Boolean(dna) && dnaRead?.text === METHODS.edna.none, { ...dna, got: row(dnaRead) });

  // A fixed snapshot: moving the time bar neither redraws the drape nor changes what it reads. A redraw is told by the
  // imagery layer object, which a redraw replaces, and by a new image request.
  const imagery = () => page.evaluate(() => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    const ours = [];
    for (let i = 0; i < layers.length; i += 1) if (/data\/edna\.png/.test(String(layers.get(i).imageryProvider?.url ?? ''))) ours.push(layers.get(i));
    if (ours.length !== 1) return `imagery layers drawing edna.png: ${ours.length}`;
    if (!window.__qaEdnaImagery) window.__qaEdnaImagery = ours[0];
    return window.__qaEdnaImagery === ours[0] ? 'same' : 'replaced';
  });
  const imageryBefore = await imagery();
  const seen = imageSeen();
  // With no time-aware layer on, the bar has no domain and set() is a no-op: a probe extent gives it one, and the
  // check requires the instant to have moved, so a bar that never moved cannot pass it.
  const moved = await page.evaluate(() => {
    const t = window.__godsEyeView.observedTime;
    t.setLayerExtent('qa-probe', { startMs: Date.parse('2000-01-01T00:00:00Z'), endMs: Date.parse('2026-01-01T00:00:00Z') });
    t.set('2010-06-01T00:00:00Z');
    return t.get();
  });
  await sleep(3000);
  const s2 = await stats(METHODS.edna.id);
  const lone = picks.edna.lone;
  const past = await readAll(METHODS.edna.id, { lone: mid(lone) });
  const imageryAfter = await imagery();
  report('ignores-the-time-bar', moved?.startsWith('2010-06-01') && imageryBefore === 'same' && imageryAfter === 'same' && imageSeen() === seen
    && s2?.time === served.asOf && !s2?.error && past.lone?.text === cellText(lone),
    { moved, imageryBefore, imageryAfter, newImages: imageSeen() - seen, stats: s2, lone: row(past.lone) });
  await page.evaluate(() => {
    window.__godsEyeView.observedTime.set(null);
    window.__godsEyeView.observedTime.setLayerExtent('qa-probe', null);
  });

  const legend = await page.evaluate((doi) => {
    const t = document.body.textContent;
    return t.includes('Where the method was used, not where animals are') && t.includes(`doi:${doi}`);
  }, served.download.doi);
  report('legend-says-effort-and-cites-the-download', legend, { doi: served.download.doi });
  const listing = await page.evaluate(async () => {
    const r = await fetch('data/camera_traps_datasets.json');
    if (!r.ok) return `HTTP ${r.status}`;
    const { datasets } = await r.json();
    return { camera: datasets.filter((d) => d.camera > 0).length, edna: datasets.filter((d) => d.edna > 0).length };
  });
  report('dataset-listing-served', listing?.camera === served.methods.camera.datasets && listing?.edna === served.methods.edna.datasets,
    { listed: listing, manifest: { camera: served.methods.camera.datasets, edna: served.methods.edna.datasets } });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-404-or-console-errors', imageBad().length === 0 && consoleErrors.length === 0 && pageErrors.length === 0,
  { imageBad: imageBad().slice(0, 5), consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, images: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v.ok])) }));
process.exit(failed ? 1 : 0);
