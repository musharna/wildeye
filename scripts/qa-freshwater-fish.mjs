#!/usr/bin/env node
/**
 * qa-freshwater-fish.mjs — real-browser acceptance for the freshwater fish layer (spec 2026-10-03-freshwater-fish-design.md).
 * Run: node scripts/qa-freshwater-fish.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, fixed 2026-10-03 before the layer was written: the basins each point falls in on the raw Zenodo
 * shapes (10.5281/zenodo.19511163, read with pyshp + shapely, not through pipeline/freshwater_fish.py), with their
 * species counts; two points lie where the source's basins overlap, so both basins must be read. Ocean, ice and
 * desert points read no basin. Proof it drew: a render pick at the screen centre hits the basin the readout names
 * there, nothing of the layer is drawn before it is on, and the realm chip hides and shows it.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'freshwater-fish';
const OVERLAP = ' (the source’s basins overlap here)';
const IN_BASIN = {
  amazon: [[-3.0, -60.0], 'Amazon · 2,815 freshwater fish species'],
  congo: [[-1.0, 20.0], 'Congo · 1,232 freshwater fish species'],
  mississippi: [[35.0, -90.0], 'Mississippi · 490 freshwater fish species'],
  thames: [[51.6, -1.0], 'Thames UK · 31 freshwater fish species'],
  baikal: [[53.0, 108.0], 'Yenisey · 100 freshwater fish species'],
  komoMabelle: [[0.94, 10.065], `Komo River · 6 freshwater fish species; Mabelle River · 3 freshwater fish species${OVERLAP}`],
  charnleySale: [[-16.193, 125.47], `Charnley · 5 freshwater fish species; Sale River · 3 freshwater fish species${OVERLAP}`],
};
const NO_BASIN = { atlantic: [30.0, -30.0], greenland: [72.0, -40.0], antarctica: [-80.0, 0.0], inlandAustralia: [-25.0, 133.0] };
const NO_BASIN_TEXT = 'Not in a mapped drainage basin';
// Render picks: the readout's first basin is what is drawn at the centre.
const PICKS = { amazon: [-3.0, -60.0], congo: [-1.0, 20.0], mississippi: [35.0, -90.0] };
const firstName = (text) => String(text ?? '').split(' · ')[0] || null;

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
    if (m.type() === 'error' && /fish|basin|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // Polygons tessellate asynchronously (slow under swiftshader): poll the centre pick until it names `want` or `waitMs`.
  // The view is set on every poll, since app code may move the camera after load.
  const pick = ([lat, lon], { waitMs = 3000, want = null } = {}) => page.evaluate(async (lat, lon, waitMs, want) => {
    const v = window.__godsEyeView.viewer;
    const c = v.scene.canvas;
    const t0 = Date.now();
    let id = null;
    let basin = null;
    try {
      do {
        v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 9000000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
        await new Promise((r) => setTimeout(r, 1000));
        v.scene.render();
        const hit = v.scene.pick({ x: c.clientWidth / 2, y: c.clientHeight / 2 });
        id = hit?.id?.id ?? (hit ? hit.primitive?.constructor?.name ?? 'unnamed' : null);
        basin = hit?.id?.properties?.name?.getValue?.() ?? null;
      } while (want !== null && basin !== want && Date.now() - t0 < waitMs);
    } catch (e) {
      return { error: `${e?.name}: ${e?.message ?? JSON.stringify(e)}`.slice(0, 300) };
    }
    return { id: id === null ? null : String(id), basin, polls: Math.round((Date.now() - t0) / 1000) };
  }, lat, lon, waitMs, want);
  const ours = (p) => String(p.id ?? '').startsWith(`${ID}:`);

  const before = await pick(PICKS.amazon);
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.lastUpdate && !stats()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: stats() ?? null };
  }, ID);
  const s = enabled.stats;
  const wantRealms = { Palearctic: 1019, Australasia: 739, Neotropic: 510, Indomalayan: 467, Nearctic: 305, Afrotropic: 300, Oceania: 24 };
  const realmsOk = s?.realms && Object.entries(wantRealms).every(([k, v]) => s.realms[k] === v);
  report('loaded', enabled.on && !s?.error && s?.count === 3364 && realmsOk, { count: s?.count, realms: s?.realms, error: s?.error });

  const read = (points) => page.evaluate(async (id, points) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(points)) {
      const rows = await window.__godsEyeView.readoutAt(lat, lon);
      out[name] = rows.find((r) => r.id === id) ?? null;
    }
    return out;
  }, ID, points);
  const inside = await read(Object.fromEntries(Object.entries(IN_BASIN).map(([k, [p]]) => [k, p])));
  for (const [name, [, want]] of Object.entries(IN_BASIN)) {
    report(`basin-${name}`, inside[name]?.status === 'class' && inside[name].text === want && inside[name].date === '2024', { got: inside[name]?.text ?? inside[name]?.error ?? null, want });
  }
  const outside = await read(NO_BASIN);
  for (const name of Object.keys(NO_BASIN)) report(`no-basin-${name}`, outside[name]?.status === 'class' && outside[name].text === NO_BASIN_TEXT, { got: outside[name]?.text ?? outside[name]?.error ?? null });

  const picked = await read(PICKS);
  for (const [name, p] of Object.entries(PICKS)) {
    const want = firstName(picked[name]?.text);
    const drawn = await pick(p, { waitMs: 90000, want });
    report(`drew-${name}`, want !== null && drawn.basin === want && ours(drawn), { readout: picked[name]?.text ?? null, pick: drawn });
  }
  report('not-drawn-before-on', !ours(before), { before });

  // The realm chip hides the Amazon (Neotropic) and shows it again; the readout still names it while hidden.
  const clickChip = (chip) => page.evaluate(async (id, chip) => {
    const sel = `.data-toggle-row[data-layer-id="${id}"] .data-toggle-chip[data-chip-id="${chip}"]`;
    let b = null;
    for (let i = 0; i < 40 && !b; i += 1) {
      b = document.querySelector(sel);
      if (!b) await new Promise((r) => setTimeout(r, 250));
    }
    if (!b) return { error: `no chip ${sel}` };
    b.click();
    return { label: b.textContent, params: window.__godsEyeView.dataManager.getLayerParams(id) };
  }, ID, chip);
  const off = await clickChip('Neotropic');
  const hidden = await pick(PICKS.amazon, { waitMs: 3000 });
  const stillRead = await read({ amazon: PICKS.amazon });
  report('chip-hides-realm', !off.error && off.params?.Neotropic === false && hidden.basin !== 'Amazon' && firstName(stillRead.amazon?.text) === 'Amazon',
    { chip: off, pick: hidden, readout: stillRead.amazon?.text });
  const on = await clickChip('Neotropic');
  const shown = await pick(PICKS.amazon, { waitMs: 90000, want: 'Amazon' });
  report('chip-shows-realm', !on.error && on.params?.Neotropic === true && shown.basin === 'Amazon', { chip: on, pick: shown });

  // The info box reaches the screen through the details card (Cesium's own info box is off).
  const card = await page.evaluate(async (id) => {
    const { viewer } = window.__godsEyeView;
    const ds = viewer.dataSources.getByName(id)[0] ?? null;
    const entity = ds?.entities.values.find((e) => e.properties?.name?.getValue?.() === 'Amazon');
    if (!entity) return { error: 'no Amazon entity' };
    viewer.selectedEntity = entity;
    const el = document.querySelector('.bio-card');
    for (let i = 0; i < 20 && el?.hidden !== false; i += 1) await new Promise((r) => setTimeout(r, 100));
    const body = el?.querySelector('.bio-card-body');
    const out = { open: el?.hidden === false, links: body ? [...body.querySelectorAll('a[href^="http"]')].map((a) => a.href) : [], text: (body?.textContent || '').trim() };
    viewer.selectedEntity = undefined;
    return out;
  }, ID);
  report('card', card.open && /Realm: Neotropic · Countries: Bolivia, Brazil, Colombia/.test(card.text) && /Freshwater fish species: 2,815/.test(card.text)
    && /Largest families: Loricariidae 380, Acestrorhamphidae 323/.test(card.text) && /Basin area: [\d.]+ million km²/.test(card.text)
    && card.links.includes('https://doi.org/10.5281/zenodo.19511163') && card.links.includes('https://doi.org/10.1038/sdata.2017.141'),
    { ...card, text: card.text?.slice(0, 300) });

  const text = await page.evaluate(() => document.body.textContent);
  report('legend-and-credit', text.includes('fill = freshwater fish species in the basin') && text.includes('1,000+ species') && text.includes('doi:10.1038/sdata.2017.141'),
    { legend: text.includes('fill = freshwater fish species in the basin'), bins: text.includes('1,000+ species'), doi: text.includes('doi:10.1038/sdata.2017.141') });

  const share = await page.evaluate(() => location.href);
  report('share-token', /[#&]l=([^&]*\.)?ff(\.|&|$)/.test(decodeURIComponent(share)), { url: share.slice(0, 220) });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
