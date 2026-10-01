#!/usr/bin/env node
/**
 * qa-modeled-range.mjs — real-browser checks for the species card's MODELED RANGE switch
 * (spec: docs/superpowers/specs/2026-09-30-modeled-range-design.md).
 * Run: node scripts/qa-modeled-range.mjs --url http://localhost:4488/wildeye/ [--checks shown,readout,other-group,throttled,session] [--shots <dir>]
 * The species come from the site's own data/geomodel_species.json and GBIF, so the checks follow each month's verdicts: the shown species is
 * the listed one with the highest tile agreement, and the other-group species' expected line is computed from the list (placeTaxon).
 * Prints one JSON line per check; exits 1 when any check fails.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { bootSettled } from './bootSettled.mjs';
import { parseSpeciesName } from '../src/bio/gbif.js';
import { MODELED_ALPHA, MODELED_MAX_LEVEL, THROTTLED_MESSAGE, modeledNote, placeTaxon, validationMonth } from '../src/data/modeledRange.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'http://localhost:4488/wildeye/');
const CHECKS = new Set(arg('--checks', 'shown,readout,other-group,throttled,session').split(','));
const SHOTS = arg('--shots', null);
const OTHER_SPECIES = arg('--other', 'Anser cygnoides'); // a bird: Aves, with a known tile mismatch (IoU 0.03) whatever its verdict
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
Error.stackTraceLimit = 50;

let bad = 0;
const report = (check, ok, detail = {}) => { if (!ok) bad += 1; console.log(JSON.stringify({ check, ok, ...detail })); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gbif = async (path) => {
  const res = await fetch(`https://api.gbif.org${path}`);
  if (!res.ok) throw new Error(`GBIF ${path}: HTTP ${res.status}`);
  return res.json();
};

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
// Every iNaturalist geomodel tile the page asks for, with its answer (status null while pending).
const tiles = new Map();
const isGeomodel = (url) => url.startsWith('https://api.inaturalist.org/v2/geomodel/');
page.on('request', (r) => { if (isGeomodel(r.url())) tiles.set(r.url(), tiles.get(r.url()) ?? null); });
page.on('response', (r) => { if (isGeomodel(r.url())) tiles.set(r.url(), r.status()); });
page.on('requestfailed', (r) => { if (isGeomodel(r.url())) tiles.set(r.url(), `failed: ${r.failure()?.errorText}`); });
const pending = () => [...tiles.values()].filter((s) => s === null).length;
const tileParts = (url) => { const u = new URL(url); const [, , , id, z, x, y] = u.pathname.split('/'); return { id: Number(id), z: Number(z), x: Number(x), y: Number(y.replace('.png', '')), thresholded: u.searchParams.get('thresholded') }; };
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 120000 });
await bootSettled(page);

// The globe has drawn the view and no geomodel tile is in flight, for 4 polls 500 ms apart.
const settle = async (timeoutMs = 90000) => {
  const started = Date.now();
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const loaded = await page.evaluate(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded);
    stable = loaded && pending() === 0 ? stable + 1 : 0;
    if (stable >= 4) return { settled: true, ms: Date.now() - started };
    await sleep(500);
  }
  return { settled: false, ms: Date.now() - started, pending: pending() };
};
const view = (lon, lat, height) => page.evaluate((lon, lat, height) => {
  const viewer = window.__godsEyeView.viewer;
  const Cartesian3 = viewer.camera.position.constructor;
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
}, lon, lat, height);
const pick = (taxonKey) => page.evaluate((taxonKey) => {
  window.__godsEyeView.dataManager.setLayerParams('species', { taxonKey, name: null }, { origin: 'programmatic' });
}, taxonKey);
const card = () => page.evaluate(() => {
  const toggle = document.getElementById('species-modeled-toggle');
  const layer = window.__godsEyeView.modeledRange;
  const layers = window.__godsEyeView.viewer.imageryLayers;
  const drawn = [];
  for (let i = 0; i < layers.length; i += 1) drawn.push({ index: i, url: String(layers.get(i).imageryProvider?.url ?? ''), alpha: layers.get(i).alpha, show: layers.get(i).show });
  return {
    rowShown: !document.getElementById('species-modeled').hidden,
    // drawn, whatever its hidden attribute says: a later display rule of equal specificity once drew a hidden switch (09-30)
    toggleShown: Boolean(toggle && toggle.getBoundingClientRect().height > 0 && getComputedStyle(toggle).display !== 'none'),
    toggleText: toggle?.textContent ?? null,
    // the label stays inside its pill: in a flex row the switch shrank to 133 px under 148 px of text (09-30 screenshot)
    toggleFits: Boolean(toggle) && toggle.scrollWidth <= toggle.clientWidth,
    ariaChecked: toggle?.getAttribute('aria-checked') ?? null,
    note: document.getElementById('species-modeled-note')?.textContent ?? null,
    enabled: layer.isEnabled(),
    status: { error: layer.getStatus().error, taxon: layer.getStatus().taxon },
    modeled: drawn.filter((l) => l.url.includes('api.inaturalist.org/v2/geomodel/')),
    species: drawn.filter((l) => l.url.includes('/v2/map/occurrence/')),
  };
});
const waitForCard = (predicate, arg, timeout = 45000) => page.waitForFunction(predicate, { timeout, polling: 250 }, arg).then(() => null, (error) => String(error).slice(0, 160));

// The species under test, from the site's list and GBIF.
const list = await page.evaluate(async () => { const r = await fetch('data/geomodel_species.json'); return r.ok ? r.json() : { error: `HTTP ${r.status}` }; });
if (list.error) {
  report('list', false, { error: list.error, why: 'data/geomodel_species.json is not served; run pipeline/geomodel_species.py first' });
  await browser.close();
  process.exit(1);
}
const MONTH = validationMonth(list.verdicts_generated_at);
const candidates = Object.entries(list.species).filter(([, s]) => s.iou !== null && s.iou >= list.species_iou_min).sort((a, b) => b[1].iou - a[1].iou);
let shown = null;
for (const [name, entry] of candidates.slice(0, 10)) {
  const m = await gbif(`/v1/species/match?name=${encodeURIComponent(name)}&strict=true`);
  if (m.matchType === 'EXACT' && m.rank === 'SPECIES' && m.canonicalName === name && m.usageKey) { shown = { name, gbifKey: m.usageKey, ...entry }; break; }
}
const otherMatch = await gbif(`/v1/species/match?name=${encodeURIComponent(OTHER_SPECIES)}&strict=true`);
const otherRecord = parseSpeciesName(await gbif(`/v1/species/${otherMatch.usageKey}`));
const otherExpected = modeledNote(placeTaxon(otherRecord, list));
report('species', Boolean(shown) && Boolean(otherMatch.usageKey), { listed: Object.keys(list.species).length, shown, other: { name: OTHER_SPECIES, gbifKey: otherMatch.usageKey, expected: otherExpected } });
if (!shown) { await browser.close(); process.exit(1); }

await page.evaluate(() => {
  const panel = document.getElementById('species-panel');
  if (panel?.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click();
});
await page.waitForFunction(() => !document.getElementById('species-panel').classList.contains('collapsed'), { timeout: 10000 });

const showSpider = async () => {
  await pick(shown.gbifKey);
  return waitForCard((id) => { const t = document.getElementById('species-modeled-toggle'); return t && !t.hidden && t.getBoundingClientRect().height > 0 && window.__godsEyeView.modeledRange.getStatus().taxon?.id === id; }, shown.id);
};
const switchOn = async () => {
  await page.click('#species-modeled-toggle');
  return waitForCard(() => window.__godsEyeView.modeledRange.isEnabled());
};

if (CHECKS.has('shown')) {
  // Species map on too, so the order of the two fields can be read.
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('species', true, { origin: 'programmatic' }));
  const waited = await showSpider();
  const before = await card();
  const tilesBefore = tiles.size;
  const on = await switchOn();
  await view(0, 20, 20_000_000);
  const settled = await settle();
  const after = await card();
  const asked = [...tiles.entries()].map(([url, status]) => ({ ...tileParts(url), status }));
  const credits = await page.evaluate(() => [...document.querySelectorAll('.cesium-credit-textContainer, .cesium-credit-lightbox, #cesium-credits')].map((n) => n.textContent).join(' '));
  const checks = {
    offByDefault: before.toggleText === 'MODELED RANGE OFF' && before.ariaChecked === 'false' && !before.enabled && before.modeled.length === 0 && tilesBefore === 0,
    shownNote: before.note === `iNaturalist Geomodel · ${shown.group} passed validation ${MONTH}`,
    on: after.enabled && after.toggleText === 'MODELED RANGE ON' && after.ariaChecked === 'true' && after.modeled.length === 1,
    tilesAsked: asked.length > 0,
    onlyThisTaxonThresholded: asked.every((t) => t.id === shown.id && t.thresholded === 'true'),
    zCapped: asked.every((t) => t.z <= MODELED_MAX_LEVEL),
    allServed: asked.every((t) => t.status === 200),
    noError: after.status.error === null,
    styledApart: after.modeled[0]?.alpha === MODELED_ALPHA && after.species.length === 1 && after.species[0].alpha === 1,
    underRecords: after.modeled.length === 1 && after.species.length === 1 && after.modeled[0].index < after.species[0].index,
    credited: credits.includes('iNaturalist Geomodel'),
    labelFits: before.toggleFits && after.toggleFits,
  };
  await shot('modeled-shown');
  report('shown', !waited && !on && settled.settled && Object.values(checks).every(Boolean), { ...checks, waited, on, settled, before, after: { ...after, modeled: after.modeled, species: after.species }, tiles: asked.length, zooms: [...new Set(asked.map((t) => t.z))].sort(), statuses: [...new Set(asked.map((t) => t.status))] });
}

if (CHECKS.has('readout')) {
  if (!(await page.evaluate(() => window.__godsEyeView.modeledRange.isEnabled()))) { await showSpider(); await switchOn(); }
  // A point well inside the range and one well outside it (every pixel of a 5x5 block drawn, or none), found on the z3 tile the readout
  // reads. The z0 tile only locates the range: it is a coarse render, and a z0 pixel drawn at a range's edge can be empty at z3 (seen).
  const points = await page.evaluate(async (id) => {
    const tile = async (z, x, y) => {
      const res = await fetch(`https://api.inaturalist.org/v2/geomodel/${id}/${z}/${x}/${y}.png?thresholded=true`);
      if (!res.ok) throw new Error(`tile ${z}/${x}/${y} HTTP ${res.status}`);
      const bitmap = await createImageBitmap(await res.blob());
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data, width } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return { size: width, drawn: (px, py) => data[(py * width + px) * 4 + 3] > 0 };
    };
    const z0 = await tile(0, 0, 0);
    let sx = 0, sy = 0, n = 0;
    for (let py = 0; py < z0.size; py += 1) for (let px = 0; px < z0.size; px += 1) if (z0.drawn(px, py)) { sx += px; sy += py; n += 1; }
    if (!n) return { error: 'the z0 tile draws nothing' };
    const z = 3, scale = 2 ** z;
    const gx = ((sx / n + 0.5) / z0.size) * scale, gy = ((sy / n + 0.5) / z0.size) * scale; // the range's centre, in z3 tile units
    const tx = Math.floor(gx), ty = Math.floor(gy);
    const t3 = await tile(z, tx, ty);
    const block = (px, py, want) => { for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) if (t3.drawn(px + dx, py + dy) !== want) return false; return true; };
    const toLonLat = (px, py) => {
      const fx = (tx + (px + 0.5) / t3.size) / scale, fy = (ty + (py + 0.5) / t3.size) / scale;
      return { lon: fx * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * fy))) * 180) / Math.PI };
    };
    let inside = null;
    let outside = null;
    for (let py = 2; py < t3.size - 2 && !(inside && outside); py += 3) {
      for (let px = 2; px < t3.size - 2 && !(inside && outside); px += 3) {
        if (!inside && block(px, py, true)) inside = toLonLat(px, py);
        if (!outside && block(px, py, false)) outside = toLonLat(px, py);
      }
    }
    return { tile: `${z}/${tx}/${ty}`, inside, outside };
  }, shown.id);
  const readAt = async (p) => (p ? page.evaluate(async ({ lat, lon }) => (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r?.id === 'modeled-range') ?? null, p) : null);
  const inside = await readAt(points.inside);
  const outside = await readAt(points.outside);
  const checks = {
    pointsFound: Boolean(points.inside && points.outside),
    inside: inside?.status === 'class' && inside.text === 'Inside modeled range — expected nearby' && inside.date === `${shown.group} passed validation ${MONTH}` && inside.name.includes('iNaturalist Geomodel'),
    outside: outside?.status === 'class' && outside.text === 'Outside modeled range',
  };
  if (points.inside) {
    // a picture of the range itself (the shown check's view is the whole globe from over Africa)
    await view(points.inside.lon, points.inside.lat, 7_000_000);
    await settle();
    await shot('modeled-on-range');
  }
  report('readout', Object.values(checks).every(Boolean), { ...checks, points, inside, outside });
}

if (CHECKS.has('other-group')) {
  if (!(await page.evaluate(() => window.__godsEyeView.modeledRange.isEnabled()))) { await showSpider(); await switchOn(); }
  const wasOn = await card();
  await pick(otherMatch.usageKey);
  const waited = await waitForCard((expected) => document.getElementById('species-modeled-note')?.textContent === expected, otherExpected);
  const after = await card();
  const checks = {
    positiveControl: wasOn.enabled && wasOn.modeled.length === 1,
    reason: after.note === otherExpected && after.rowShown,
    noSwitch: !after.toggleShown,
    rangeGone: !after.enabled && after.modeled.length === 0 && after.status.taxon === null,
  };
  await shot('modeled-other-group');
  report('other-group', !waited && Object.values(checks).every(Boolean), { ...checks, waited, expected: otherExpected, after });
}

if (CHECKS.has('throttled')) {
  // iNaturalist's error answers carry Access-Control-Allow-Origin: * (a 500 probed 2026-09-30); without it the browser hides the status and
  // the page could only count failures, so the fake 429 carries it too.
  await page.setRequestInterception(true);
  const handler = (r) => (isGeomodel(r.url()) ? r.respond({ status: 429, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/plain', body: 'Too Many Requests' }) : r.continue());
  page.on('request', handler);
  await pick(otherMatch.usageKey); // a different species first, so the spider is a new pick with the switch off
  await waitForCard((expected) => document.getElementById('species-modeled-note')?.textContent === expected, otherExpected);
  const waitedShow = await showSpider();
  const on = await switchOn();
  await view(10, 10, 18_000_000);
  const waited = await waitForCard((message) => document.getElementById('species-modeled-note')?.textContent === message, THROTTLED_MESSAGE);
  const after = await card();
  page.off('request', handler);
  await page.setRequestInterception(false);
  await shot('modeled-throttled');
  report('throttled', !waitedShow && !on && !waited && after.note === THROTTLED_MESSAGE && after.status.error === THROTTLED_MESSAGE, { waitedShow, on, waited, after });
  // back to a clean switch for the session check
  await page.click('#species-modeled-toggle');
}

if (CHECKS.has('session')) {
  // Grill Q4 flip check: a realistic pan and zoom session with the field on draws no HTTP 429 from iNaturalist.
  await pick(otherMatch.usageKey);
  await waitForCard((expected) => document.getElementById('species-modeled-note')?.textContent === expected, otherExpected);
  tiles.clear();
  const waitedShow = await showSpider();
  const on = await switchOn();
  const route = [[0, 20, 22_000_000], [-100, 40, 9_000_000], [-75, 5, 6_000_000], [-60, -20, 3_000_000], [20, 0, 8_000_000], [100, 30, 7_000_000], [135, -25, 4_000_000], [10, 50, 2_000_000], [10, 50, 12_000_000], [-120, 45, 1_500_000]];
  const legs = [];
  for (const [lon, lat, h] of route) {
    await view(lon, lat, h);
    legs.push({ lon, lat, h, ...(await settle()) });
  }
  const asked = [...tiles.entries()].map(([url, status]) => ({ ...tileParts(url), status }));
  const throttled = asked.filter((t) => t.status === 429).length;
  const after = await card();
  report('session', !waitedShow && !on && legs.every((l) => l.settled) && throttled === 0 && asked.every((t) => t.z <= MODELED_MAX_LEVEL) && after.status.error === null, {
    views: legs.length, tiles: asked.length, throttled, statuses: [...new Set(asked.map((t) => t.status))], maxZ: Math.max(...asked.map((t) => t.z)), error: after.status.error, legs,
  });
}

await browser.close();
process.exit(bad ? 1 : 0);
