#!/usr/bin/env node
/**
 * qa-effort.mjs — real-browser checks for the species card's RECORDING EFFORT switch
 * (spec: docs/superpowers/specs/2026-09-30-effort-layer-design.md), against GBIF's live tiles.
 * Run: node scripts/qa-effort.mjs --url http://localhost:4488/wildeye/ [--checks off,on,years,other-class,no-class] [--shots <dir>]
 * Prints one JSON line per check; exits 1 when any check fails.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { bootSettled } from './bootSettled.mjs';
import { LICENSES } from '../src/bio/gbif.js';
import { effortNote, EFFORT_ALPHA } from '../src/data/effort.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'http://localhost:4488/wildeye/');
const CHECKS = new Set(arg('--checks', 'off,on,years,other-class,no-class').split(','));
const SHOTS = arg('--shots', null);
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
const match = async (name) => {
  const m = await gbif(`/v1/species/match?name=${encodeURIComponent(name)}&strict=true`);
  if (m.matchType !== 'EXACT' || !m.usageKey || !m.classKey) throw new Error(`GBIF match for ${name}: ${JSON.stringify(m).slice(0, 200)}`);
  return { name, key: m.usageKey, classKey: m.classKey, className: m.class };
};
const SPIDER = await match('Steatoda grossa');
const BIRD = await match('Anser cygnoides');
const NO_CLASS = await match('Araneus diadematus'); // a real species whose lookup the no-class check strips of its class
const NOW = new Date();

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
// Every GBIF effort tile the page asks for (adhoc, binned in hexagons), with its answer (status null while pending).
const tiles = new Map();
const isEffort = (url) => url.startsWith('https://api.gbif.org/v2/map/occurrence/adhoc/') && new URL(url).searchParams.get('bin') === 'hex';
page.on('request', (r) => { if (isEffort(r.url())) tiles.set(r.url(), tiles.get(r.url()) ?? null); });
page.on('response', (r) => { if (isEffort(r.url())) tiles.set(r.url(), r.status()); });
page.on('requestfailed', (r) => { if (isEffort(r.url())) tiles.set(r.url(), `failed: ${r.failure()?.errorText}`); });
const pending = () => [...tiles.values()].filter((s) => s === null).length;
const asked = () => [...tiles.entries()].map(([url, status]) => {
  const u = new URL(url);
  return { taxonKey: u.searchParams.get('taxonKey'), year: u.searchParams.get('year'), licenses: u.searchParams.getAll('license'), style: u.searchParams.get('style'), status };
});
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 120000 });
await bootSettled(page);

// The globe has drawn the view and no effort tile is in flight, for 4 polls 500 ms apart.
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
// The row as drawn: visibility is measured from the render, not read from the hidden attribute (LESSONS 2026-09-30).
const card = () => page.evaluate(() => {
  const toggle = document.getElementById('species-effort-toggle');
  const box = document.getElementById('species-effort');
  const drawn = (el) => Boolean(el) && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
  const layers = window.__godsEyeView.viewer.imageryLayers;
  const list = [];
  for (let i = 0; i < layers.length; i += 1) list.push({ index: i, url: String(layers.get(i).imageryProvider?.url ?? ''), alpha: layers.get(i).alpha });
  const status = window.__godsEyeView.effort.getStatus();
  return {
    rowShown: drawn(box),
    toggleShown: drawn(toggle),
    toggleText: toggle?.textContent ?? null,
    ariaChecked: toggle?.getAttribute('aria-checked') ?? null,
    toggleFits: Boolean(toggle) && toggle.scrollWidth <= toggle.clientWidth,
    note: document.getElementById('species-effort-note')?.textContent ?? null,
    enabled: window.__godsEyeView.effort.isEnabled(),
    status: { error: status.error, taxon: status.taxon, years: status.years },
    effort: list.filter((l) => l.url.includes('bin=hex')),
    species: list.filter((l) => l.url.includes('/v2/map/occurrence/adhoc/') && !l.url.includes('bin=hex')),
  };
});
const waitFor = (predicate, arg, timeout = 45000) => page.waitForFunction(predicate, { timeout, polling: 250 }, arg).then(() => null, (error) => String(error).slice(0, 160));
const waitForNote = (expected) => waitFor((text) => document.getElementById('species-effort-note')?.textContent === text, expected);
const noteFor = (taxon, years) => effortNote({ state: 'shown', className: taxon.className, years, now: NOW });

await page.evaluate(() => {
  const panel = document.getElementById('species-panel');
  if (panel?.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click();
});
await page.waitForFunction(() => !document.getElementById('species-panel').classList.contains('collapsed'), { timeout: 10000 });
// the species map on too, so the order of the two layers can be read
await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('species', true, { origin: 'programmatic' }));

const showSpider = async () => {
  await pick(SPIDER.key);
  return waitForNote(noteFor(SPIDER, 'recent'));
};
const switchOn = async () => {
  await page.click('#species-effort-toggle');
  return waitFor(() => window.__godsEyeView.effort.isEnabled());
};
const tileChecks = (taxon, year) => {
  const list = asked();
  return {
    tilesAsked: list.length > 0,
    thisClass: list.every((t) => t.taxonKey === String(taxon.classKey)),
    bothLicences: list.every((t) => JSON.stringify(t.licenses) === JSON.stringify(LICENSES)),
    years: list.every((t) => t.year === year),
    allServed: list.every((t) => t.status === 200),
  };
};

if (CHECKS.has('off') || CHECKS.has('on')) {
  tiles.clear();
  const waited = await showSpider();
  const before = await card();
  const offChecks = {
    switchShown: before.rowShown && before.toggleShown,
    offByDefault: before.toggleText === 'RECORDING EFFORT OFF' && before.ariaChecked === 'false' && !before.enabled && before.effort.length === 0,
    noTiles: tiles.size === 0,
    note: before.note === noteFor(SPIDER, 'recent'),
    labelFits: before.toggleFits,
  };
  report('off', !waited && Object.values(offChecks).every(Boolean), { ...offChecks, waited, spider: SPIDER, before });

  if (CHECKS.has('on')) {
    const on = await switchOn();
    await view(-95, 40, 9_000_000);
    const settled = await settle();
    const after = await card();
    const recent = `${NOW.getUTCFullYear() - 9},${NOW.getUTCFullYear()}`;
    const checks = {
      ...tileChecks(SPIDER, recent),
      on: after.enabled && after.toggleText === 'RECORDING EFFORT ON' && after.ariaChecked === 'true' && after.effort.length === 1,
      alpha: after.effort[0]?.alpha === EFFORT_ALPHA,
      underRecords: after.effort.length === 1 && after.species.length === 1 && after.effort[0].index < after.species[0].index,
      noError: after.status.error === null,
      labelFits: after.toggleFits,
    };
    await shot('effort-on');
    report('on', !on && settled.settled && Object.values(checks).every(Boolean), { ...checks, on, settled, tiles: tiles.size, after, asked: asked().slice(0, 3) });
  }
}

if (CHECKS.has('years')) {
  if (!(await page.evaluate(() => window.__godsEyeView.effort.isEnabled()))) { await showSpider(); await switchOn(); }
  tiles.clear();
  await page.click('#species-years [data-years="all"]');
  const waited = await waitForNote(noteFor(SPIDER, 'all'));
  const settled = await settle();
  const after = await card();
  const checks = { ...tileChecks(SPIDER, null), stillOn: after.enabled && after.effort.length === 1, statusYears: after.status.years === 'all' };
  await shot('effort-all-years');
  report('years', !waited && settled.settled && Object.values(checks).every(Boolean), { ...checks, waited, settled, tiles: tiles.size, note: after.note });
  await page.click('#species-years [data-years="recent"]');
  await waitForNote(noteFor(SPIDER, 'recent'));
}

if (CHECKS.has('other-class')) {
  if (!(await page.evaluate(() => window.__godsEyeView.effort.isEnabled()))) { await showSpider(); await switchOn(); }
  const wasOn = await card();
  await pick(BIRD.key);
  const waited = await waitForNote(noteFor(BIRD, 'recent'));
  const after = await card();
  tiles.clear();
  const on = await switchOn();
  const settled = await settle();
  const checks = {
    positiveControl: wasOn.enabled && wasOn.effort.length === 1,
    switchedOff: !after.enabled && after.effort.length === 0 && after.toggleText === 'RECORDING EFFORT OFF',
    note: after.note === noteFor(BIRD, 'recent'),
    ...tileChecks(BIRD, `${NOW.getUTCFullYear() - 9},${NOW.getUTCFullYear()}`),
  };
  report('other-class', !waited && !on && settled.settled && Object.values(checks).every(Boolean), { ...checks, waited, on, settled, bird: BIRD, after });
}

if (CHECKS.has('no-class')) {
  // GBIF's own answer for a real species, with its class taken out: the card must show no switch and say why.
  await page.setRequestInterception(true);
  const handler = async (r) => {
    if (r.url() !== `https://api.gbif.org/v1/species/${NO_CLASS.key}`) { r.continue(); return; }
    const res = await fetch(r.url());
    const json = await res.json();
    delete json.classKey;
    delete json.class;
    r.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify(json) });
  };
  page.on('request', handler);
  const wasShown = await card();
  await pick(NO_CLASS.key);
  const waited = await waitForNote('No effort map: GBIF lists no class for this species');
  const after = await card();
  page.off('request', handler);
  await page.setRequestInterception(false);
  const checks = { positiveControl: wasShown.toggleShown, noSwitch: after.rowShown && !after.toggleShown, nothingDrawn: !after.enabled && after.effort.length === 0 };
  await shot('effort-no-class');
  report('no-class', !waited && Object.values(checks).every(Boolean), { ...checks, waited, after });
}

await browser.close();
process.exit(bad ? 1 : 0);
