#!/usr/bin/env node
/**
 * qa-marine-realms.mjs — real-browser acceptance for the marine realms layer (spec 2026-10-03-marine-realms-design.md).
 * Run: node scripts/qa-marine-realms.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, fixed 2026-10-03 before the layer was written: the realm each sea point falls in on the raw figshare
 * shapes (10.17608/k6.auckland.5596840, read with pyshp + shapely, not through pipeline/marine_realms.py), with that
 * realm's name, % unique species and species count from Fig. 1 of Costello et al. 2017. Islands and continents read
 * as land. Proof it drew: a render pick at the screen centre hits the realm the readout names there, including over
 * both poles and on the antimeridian, and nothing of the layer before it is on or after its group's chip hides it.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'marine-realms';
const SEA = {
  blackSea: [[43.0, 34.0], 'Black Sea (realm 2) · 84% of its 192 species unique to it'],
  redSea: [[20.0, 38.5], 'Red Sea (realm 14) · 74% of its 997 species unique to it'],
  innerBaltic: [[60.5, 20.5], 'Inner Baltic Sea (realm 1) · 63% of its 458 species unique to it'],
  mediterranean: [[35.0, 18.0], 'Mediterranean (realm 5) · 45% of its 3,096 species unique to it'],
  gulfOfMexico: [[25.0, -90.0], 'Tropical W Atlantic (realm 11) · 30% of its 13,281 species unique to it'],
  offChile: [[-33.0, -72.5], 'Chile (realm 25) · 68% of its 584 species unique to it'],
  southernOcean: [[-62.0, 0.0], 'Southern Ocean (realm 30) · 17% of its 4,256 species unique to it'],
  midSouthPacific: [[-30.0, -130.0], 'South-east Pacific (realm 10) · 59% of its 1,618 species unique to it'],
};
const LAND = { kansas: [38.0, -98.0], borneo: [0.5, 114.0], madagascar: [-20.0, 46.5], britain: [53.0, -1.5], honshu: [36.5, 138.5] };
const LAND_TEXT = 'Land: not in a marine realm';
// Render picks: realm 18 (mid North Atlantic, group 6), realm 8 at 80° N, realm 30 at 62° S (a ring around the pole),
// and four antimeridian points.
const PICKS = {
  atlantic: [40.0, -40.0], arctic: [80.0, 0.0], southern: [-62.0, 0.0],
  // either side of the antimeridian, off the seam itself (simplified edges need not lie exactly on ±180°)
  antimeridianNE: [10.0, 179.9], antimeridianNW: [10.0, -179.9], antimeridianSE: [-60.0, 179.9], antimeridianSW: [-60.0, -179.9],
};
const realmOf = (text) => Number(/\(realm (\d+)\)/.exec(text ?? '')?.[1] ?? NaN);

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /realm|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // Polygons tessellate asynchronously (slow under swiftshader): poll the centre pick until `want(id)` or `waitMs`.
  // The view is set on every poll, since app code may move the camera after load.
  const pick = ([lat, lon], { waitMs = 3000, want = null } = {}) => page.evaluate(async (lat, lon, waitMs, wantRealm) => {
    const v = window.__godsEyeView.viewer;
    const c = v.scene.canvas;
    const t0 = Date.now();
    let id = null;
    try {
    do {
      v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 9000000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      await new Promise((r) => setTimeout(r, 1000));
      v.scene.render();
      const hit = v.scene.pick({ x: c.clientWidth / 2, y: c.clientHeight / 2 });
      id = hit?.id?.id ?? (hit ? hit.primitive?.constructor?.name ?? 'unnamed' : null);
    } while (wantRealm !== null && !String(id ?? '').startsWith(`marine-realms:${wantRealm}:`) && Date.now() - t0 < waitMs);
    } catch (e) {
      return { error: `${e?.name}: ${e?.message ?? JSON.stringify(e)}`.slice(0, 300), stack: String(e?.stack ?? '').slice(0, 300) };
    }
    return { id: id === null ? null : String(id), polls: Math.round((Date.now() - t0) / 1000) };
  }, lat, lon, waitMs, want);
  const ours = (p) => String(p.id ?? '').startsWith('marine-realms:');
  const pickedRealm = (p) => Number(/^marine-realms:(\d+):/.exec(p.id ?? '')?.[1] ?? NaN);

  const before = await pick(PICKS.atlantic);
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.lastUpdate && !stats()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: stats() ?? null };
  }, ID);
  const s = enabled.stats;
  const wantGroups = { 1: 1, 2: 1, 3: 6, 4: 1, 5: 1, 6: 18, 7: 1, 8: 1 };
  report('loaded', enabled.on && !s?.error && s?.count === 30 && JSON.stringify(s?.groups) === JSON.stringify(wantGroups), { count: s?.count, groups: s?.groups, error: s?.error });

  const read = (points) => page.evaluate(async (id, points) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(points)) {
      const rows = await window.__godsEyeView.readoutAt(lat, lon);
      out[name] = rows.find((r) => r.id === id) ?? null;
    }
    return out;
  }, ID, points);
  const sea = await read(Object.fromEntries(Object.entries(SEA).map(([k, [p]]) => [k, p])));
  for (const [name, [, want]] of Object.entries(SEA)) {
    report(`sea-${name}`, sea[name]?.status === 'class' && sea[name].text === want && sea[name].date === '2017', { got: sea[name]?.text ?? sea[name]?.error ?? null, want });
  }
  const land = await read(LAND);
  for (const name of Object.keys(LAND)) report(`land-${name}`, land[name]?.status === 'class' && land[name].text === LAND_TEXT, { got: land[name]?.text ?? land[name]?.error ?? null });

  // What is drawn under each point is the realm the readout names there; nothing of the layer was drawn before it was on.
  const picked = await read(PICKS);
  const drawn = {};
  for (const [name, p] of Object.entries(PICKS)) {
    const want = realmOf(picked[name]?.text);
    drawn[name] = await pick(p, { waitMs: 90000, want: Number.isFinite(want) ? want : 0 });
    report(`drew-${name}`, Number.isFinite(want) && pickedRealm(drawn[name]) === want, { readout: picked[name]?.text ?? null, pick: drawn[name] });
  }
  report('drew-fixed-realms', realmOf(picked.atlantic?.text) === 18 && realmOf(picked.arctic?.text) === 8 && realmOf(picked.southern?.text) === 30,
    { atlantic: picked.atlantic?.text, arctic: picked.arctic?.text, southern: picked.southern?.text });
  report('not-drawn-before-on', !ours(before), { before });

  // The group chip in the layer's row hides realm 18's group (6) and shows it again; the readout still names the realm.
  const clickChip = (g) => page.evaluate(async (id, g) => {
    const sel = `.data-toggle-row[data-layer-id="${id}"] .data-toggle-chip[data-chip-id="${g}"]`;
    let b = null;
    for (let i = 0; i < 40 && !b; i += 1) {
      b = document.querySelector(sel);
      if (!b) await new Promise((r) => setTimeout(r, 250));
    }
    if (!b) return { error: `no chip ${sel}` };
    b.click();
    return { label: b.textContent, params: window.__godsEyeView.dataManager.getLayerParams(id) };
  }, ID, g);
  const off = await clickChip(6);
  const hidden = await pick(PICKS.atlantic, { waitMs: 3000 });
  const stillRead = await read({ atlantic: PICKS.atlantic });
  report('chip-hides-group', !off.error && off.params?.[6] === false && pickedRealm(hidden) !== 18 && realmOf(stillRead.atlantic?.text) === 18,
    { chip: off, pick: hidden, readout: stillRead.atlantic?.text });
  const on = await clickChip(6);
  const shown = await pick(PICKS.atlantic, { waitMs: 90000, want: 18 });
  report('chip-shows-group', !on.error && on.params?.[6] === true && pickedRealm(shown) === 18, { chip: on, pick: shown });

  // The info box reaches the screen through the details card (Cesium's own info box is off).
  const card = await page.evaluate(async (id) => {
    const { viewer } = window.__godsEyeView;
    const ds = viewer.dataSources.getByName(id)[0] ?? null;
    const entity = ds?.entities.values.find((e) => e.id === 'marine-realms:2:0');
    if (!entity) return { error: 'no marine-realms:2:0 entity' };
    viewer.selectedEntity = entity;
    const el = document.querySelector('.bio-card');
    for (let i = 0; i < 20 && el?.hidden !== false; i += 1) await new Promise((r) => setTimeout(r, 100));
    const body = el?.querySelector('.bio-card-body');
    const out = { open: el?.hidden === false, links: body ? [...body.querySelectorAll('a[href^="http"]')].map((a) => a.href) : [], text: (body?.textContent || '').trim() };
    viewer.selectedEntity = undefined;
    return out;
  }, ID);
  report('card', card.open && /Black Sea \(realm 2 of 30\)/.test(card.text) && /84% found in no other realm/.test(card.text) && /Sea area: [\d,]+ km²/.test(card.text)
    && card.links.includes('https://doi.org/10.17608/k6.auckland.5596840'), { ...card, text: card.text?.slice(0, 240) });

  const text = await page.evaluate(() => document.body.textContent);
  report('legend-and-credit', text.includes('fill = marine biogeographic realm') && text.includes('doi:10.1038/s41467-017-01121-2') && text.includes('Natural Earth'),
    { legend: text.includes('fill = marine biogeographic realm'), doi: text.includes('doi:10.1038/s41467-017-01121-2') });

  const share = await page.evaluate(() => location.href);
  report('share-token', /[?#&].*\bmr\b/.test(decodeURIComponent(share)), { url: share.slice(0, 200) });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
