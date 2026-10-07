#!/usr/bin/env node
/**
 * qa-plants-wcvp.mjs — real-browser acceptance for the WCVP native plants layer (spec 2026-10-06-wcvp-plants-design.md).
 * Run: node scripts/qa-plants-wcvp.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, fixed 2026-10-06 from an independent route, not pipeline/wcvp_plants.py: the counts are a duckdb query
 * over the CSVs extracted from Kew's wcvp_dwca.zip (16.0), and each point's unit is read off the raw TDWG level3.geojson
 * with shapely. Ocean points read no unit. Proof it drew: a render pick at the screen centre hits the unit the readout
 * names there, with that unit's bin colour, and nothing of the layer is drawn before it is on.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'plants-wcvp';
const line = (name, native, endemic, introduced) => `${name} · ${native} native vascular plant species (${endemic} endemic, ${introduced} introduced)`;
const IN_UNIT = {
  colombia: [[4.6, -74.1], line('Colombia', '25,490', '7,935', '701')],
  brazilNortheast: [[-8.0, -40.0], line('Brazil Northeast', '11,692', '3,153', '289')],
  madagascar: [[-19.0, 46.7], line('Madagascar', '11,929', '9,907', '373')],
  hawaii: [[19.6, -155.5], line('Hawaii', '1,238', '1,063', '1,404')],
  greatBritain: [[52.5, -1.5], line('Great Britain', '2,948', '643', '2,356')],
  germany: [[51.0, 10.0], line('Germany', '4,469', '393', '2,846')],
  bouvet: [[-54.426, 3.418], 'Bouvet I. · no native vascular plant species recorded (0 introduced)'],
};
const NO_UNIT = { atlantic: [30.0, -30.0], pacific: [0.0, -140.0] };
const NO_UNIT_TEXT = 'Not in a botanical country';
// Render picks, with the bin colour each unit must be drawn in (8 viridis bins; Colombia and Madagascar 10,000+,
// Germany 3,000–9,999, Great Britain 1,000–2,999).
const PICKS = { colombia: [[4.6, -74.1], '#fde725'], madagascar: [[-19.0, 46.7], '#fde725'], germany: [[51.0, 10.0], '#a0da39'], greatBritain: [[52.5, -1.5], '#4ac16d'] };
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
    if (m.type() === 'error' && /plant|wcvp|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
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
    let unit = null;
    let fill = null;
    try {
      do {
        v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 6000000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
        await new Promise((r) => setTimeout(r, 1000));
        v.scene.render();
        const hit = v.scene.pick({ x: c.clientWidth / 2, y: c.clientHeight / 2 });
        id = hit?.id?.id ?? (hit ? hit.primitive?.constructor?.name ?? 'unnamed' : null);
        unit = hit?.id?.properties?.name?.getValue?.() ?? null;
        fill = hit?.id?.polygon?.material?.color?.getValue?.()?.toCssHexString?.() ?? null;
      } while (want !== null && unit !== want && Date.now() - t0 < waitMs);
    } catch (e) {
      return { error: `${e?.name}: ${e?.message ?? JSON.stringify(e)}`.slice(0, 300) };
    }
    return { id: id === null ? null : String(id), unit, fill, polls: Math.round((Date.now() - t0) / 1000) };
  }, lat, lon, waitMs, want);
  const ours = (p) => String(p.id ?? '').startsWith(`${ID}:`);

  const before = await pick(PICKS.colombia[0]);
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.lastUpdate && !stats()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: stats() ?? null };
  }, ID);
  const s = enabled.stats;
  report('loaded', enabled.on && !s?.error && s?.count === 369, { count: s?.count, error: s?.error });

  const read = (points) => page.evaluate(async (id, points) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(points)) {
      const rows = await window.__godsEyeView.readoutAt(lat, lon);
      out[name] = rows.find((r) => r.id === id) ?? null;
    }
    return out;
  }, ID, points);
  const inside = await read(Object.fromEntries(Object.entries(IN_UNIT).map(([k, [p]]) => [k, p])));
  for (const [name, [, want]] of Object.entries(IN_UNIT)) {
    report(`unit-${name}`, inside[name]?.status === 'class' && inside[name].text === want && inside[name].date === 'WCVP 16.0', { got: inside[name]?.text ?? inside[name]?.error ?? null, want });
  }
  const outside = await read(NO_UNIT);
  for (const name of Object.keys(NO_UNIT)) report(`no-unit-${name}`, outside[name]?.status === 'class' && outside[name].text === NO_UNIT_TEXT, { got: outside[name]?.text ?? outside[name]?.error ?? null });

  for (const [name, [p, colour]] of Object.entries(PICKS)) {
    const want = firstName(inside[name]?.text);
    const drawn = await pick(p, { waitMs: 90000, want });
    report(`drew-${name}`, want !== null && drawn.unit === want && ours(drawn) && drawn.fill?.slice(0, 7) === colour, { readout: inside[name]?.text ?? null, colour, pick: drawn });
  }
  report('not-drawn-before-on', !ours(before), { before });

  // The info box reaches the screen through the details card (Cesium's own info box is off).
  const card = await page.evaluate(async (id) => {
    const { viewer } = window.__godsEyeView;
    const ds = viewer.dataSources.getByName(id)[0] ?? null;
    const entity = ds?.entities.values.find((e) => e.properties?.name?.getValue?.() === 'Colombia');
    if (!entity) return { error: 'no Colombia entity' };
    viewer.selectedEntity = entity;
    const el = document.querySelector('.bio-card');
    for (let i = 0; i < 20 && el?.hidden !== false; i += 1) await new Promise((r) => setTimeout(r, 100));
    const body = el?.querySelector('.bio-card-body');
    const out = { open: el?.hidden === false, links: body ? [...body.querySelectorAll('a[href^="http"]')].map((a) => a.href) : [], text: (body?.textContent || '').trim() };
    viewer.selectedEntity = undefined;
    return out;
  }, ID);
  report('card', card.open && /Native vascular plant species: 25,490/.test(card.text) && /Endemic \(native here and nowhere else\): 7,935/.test(card.text)
    && /Introduced: 701/.test(card.text) && /Larger units hold more species/.test(card.text)
    && card.links.includes('https://sftp.kew.org/pub/data-repositories/WCVP/') && card.links.includes('https://doi.org/10.1038/s41597-021-00997-6')
    && card.links.includes('https://www.tdwg.org/standards/wgsrpd/'),
    { ...card, text: card.text?.slice(0, 400) });

  // Read each where it is shown: the legend in this layer's own row, the credit in Cesium's credit display (the card
  // repeats both phrases, so the page text cannot tell them apart).
  const shown = await page.evaluate((id) => {
    const items = [...document.querySelectorAll(`.data-toggle-row[data-layer-id="${id}"] .data-toggle-legend-item`)].map((e) => e.textContent.trim());
    const credits = [...document.querySelectorAll('[class*="credit"]')].filter((e) => !e.closest('.bio-card')).map((e) => e.textContent).join(' ');
    return { items, credits };
  }, ID);
  // Matched by label prefix: the shared row renderer appends each item's formatted count (manager.js), and prints
  // a null count as "null", for every layer that passes one.
  const has = (label) => shown.items.some((t) => t.startsWith(label));
  const legendOk = has('fill = native vascular plant species per botanical country, log scale (369 TDWG Level-3 units, WCVP 16.0). Larger units hold more species')
    && has('10,000+ native species') && has('1–9 native species') && has('none recorded') && shown.items.length === 10;
  const creditOk = shown.credits.includes('World Checklist of Vascular Plants (WCVP) 16.0') && shown.credits.includes('CC BY 3.0')
    && shown.credits.includes('TDWG World Geographical Scheme for Recording Plant Distributions') && shown.credits.includes('doi:10.1038/s41597-021-00997-6');
  report('legend-and-credit', legendOk && creditOk, { legend: legendOk, credit: creditOk, items: shown.items.map((t) => t.slice(0, 200)) });

  const share = await page.evaluate(() => location.href);
  report('share-token', /[#&]l=([^&]*\.)?vp(\.|&|$)/.test(decodeURIComponent(share)), { url: share.slice(0, 220) });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
