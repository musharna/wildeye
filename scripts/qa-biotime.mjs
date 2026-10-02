#!/usr/bin/env node
/**
 * qa-biotime.mjs — real-browser acceptance for the BioTIME 2.0 study-series layer (spec 2026-10-01-biotime-design.md).
 * Run: node scripts/qa-biotime.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers, read 2026-10-01 by an R script straight from biotime_v2_query_15April25.rds (base R: distinct
 * valid_name, distinct SAMPLE_DESC and distinct floor(coordinate × 100) grid cells per STUDY_ID and YEAR; not the
 * pipeline's code or output): see KNOWN. Study 166
 * (PIROP Northwest Atlantic, "ODbL (CC-by-NC)") is non-commercial and must never be drawn.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'biotime';
const KNOWN = [
  { study: 39, year: 2010, taxa: 23, samples: 1, gapYear: 1985 }, // Hubbard Brook forest birds; 1985 has no records
  { study: 246, year: 2005, taxa: 137, samples: 24 }, // fish impinged at a power-station intake
  { study: 75, year: 1985, wide: true, samples: 175, cells: 51 }, // Beaufort Sea shelf zooplankton, ~180,000 km²
];
const DROPPED = 166;
// independent of the pipeline's table: any of these in a shown study's licence means a non-open study got through
const NOT_OPEN = /non-?commercial|\bnc\b|odbl|share-?alike|\bsa\b|citation required|^\s*$|^public\s*$|^public - full access$/i;

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
const bad = [];
let manifest = null;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /biotime|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (!/\/data\/biotime(_locations)?\.json/.test(r.url())) return;
    if (r.status() !== 200 && r.status() !== 304) bad.push(`${r.status()} ${r.url()}`);
    else if (r.url().includes('/data/biotime.json')) manifest = await r.json().catch(() => null);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  const on = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !s()?.lastUpdate && !s()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: s() };
  }, ID);
  // What the layer draws now: its entities (one per small study, or a faded gap dot) and its cells (wide studies).
  const drawn = () => page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    const ds = v.dataSources.getByName('biotime')[0];
    const now = window.Cesium?.JulianDate?.now?.();
    const entities = (ds?.entities.values ?? []).filter((e) => e.id.startsWith('biotime:') && e.id !== 'biotime:cell-pick').map((e) => {
      const g = (k) => e.properties?.[k]?.getValue(now);
      return { id: e.id, study: g('study'), status: g('status'), year: g('year'), taxa: g('taxa'), samples: g('samples') };
    });
    const cells = {};
    const prims = v.scene.primitives;
    for (let i = 0; i < prims.length; i += 1) {
      const p = prims.get(i);
      if (typeof p?.length !== 'number' || typeof p.get !== 'function') continue;
      for (let j = 0; j < p.length; j += 1) {
        const id = p.get(j)?.id;
        if (typeof id === 'string' && id.startsWith('biotime-cell:')) cells[id.slice(13)] = (cells[id.slice(13)] || 0) + 1;
      }
    }
    return { entities, cells, show: ds?.show };
  });
  const setYear = (iso) => page.evaluate((t) => window.__godsEyeView.observedTime.set(t), iso);
  const live = await drawn();
  const studies = manifest?.studies ?? [];
  const nCells = Object.values(live.cells).reduce((a, b) => a + b, 0);
  report('drew', on.on && !on.stats?.error && studies.length > 500 && live.entities.length > 100 && nCells > 0 && live.show === true,
    { studies: studies.length, entities: live.entities.length, wideStudiesDrawn: Object.keys(live.cells).length, cells: nCells, stats: on.stats });

  const statesOf = (d, sid) => d.entities.filter((e) => e.study === sid);
  for (const k of KNOWN) {
    await setYear(`${k.year}-07-01T00:00:00Z`);
    const d = await drawn();
    if (k.wide) {
      report(`known-${k.study}-${k.year}-cells`, (d.cells[String(k.study)] ?? 0) === k.cells && statesOf(d, k.study).length === 0,
        { gotCells: d.cells[String(k.study)] ?? 0, wantCells: k.cells, centroids: statesOf(d, k.study).length });
      continue;
    }
    const [e] = statesOf(d, k.study);
    report(`known-${k.study}-${k.year}`, e?.status === 'sampled' && e.taxa === k.taxa && e.samples === k.samples,
      { got: e ?? null, want: { taxa: k.taxa, samples: k.samples } });
  }
  const gap = KNOWN.find((k) => k.gapYear);
  if (gap) {
    await setYear(`${gap.gapYear}-07-01T00:00:00Z`);
    const [e] = statesOf(await drawn(), gap.study);
    report('gap-year-named', e?.status === 'gap' && e.year === gap.gapYear, { study: gap.study, got: e ?? null });
  }

  // A real click on a wide study's cell opens that study's info box with its count for the year.
  const w = KNOWN.find((k) => k.wide);
  await setYear(`${w.year}-07-01T00:00:00Z`);
  const at = await page.evaluate(async (sid) => {
    const v = window.__godsEyeView.viewer;
    const C = v.camera.position.constructor;
    const prims = v.scene.primitives;
    const mine = [];
    for (let i = 0; i < prims.length; i += 1) {
      const p = prims.get(i);
      if (typeof p?.length !== 'number' || typeof p.get !== 'function') continue;
      for (let j = 0; j < p.length; j += 1) if (p.get(j)?.id === `biotime-cell:${sid}`) mine.push(p.get(j).position);
    }
    // Other studies' cells can sit on top of this study's; click the first cell where this study is the one on top.
    const rect = v.scene.canvas.getBoundingClientRect();
    for (const pos of mine.slice(0, 20)) {
      const carto = v.scene.globe.ellipsoid.cartesianToCartographic(pos);
      v.camera.setView({ destination: C.fromRadians(carto.longitude, carto.latitude, 300000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      for (let i = 0; i < 60 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
      v.scene.render();
      const win = v.scene.cartesianToCanvasCoordinates(pos);
      if (win && v.scene.pick(win)?.id === `biotime-cell:${sid}`) return [rect.left + win.x, rect.top + win.y];
    }
    return null;
  }, w.study);
  let picked = null;
  if (at) {
    await page.mouse.click(at[0], at[1]);
    picked = await page.waitForFunction((sid) => {
      const e = window.__godsEyeView.viewer.selectedEntity;
      return e?.id === 'biotime:cell-pick' && e.properties?.study?.getValue() === sid ? { html: e.description.getValue(), samples: e.properties.samples.getValue() } : false;
    }, { timeout: 15000, polling: 200 }, w.study).then((h) => h.jsonValue()).catch(() => null);
  }
  report('click-wide-cell', picked !== null && picked.samples === w.samples && /taxa in/.test(picked.html) && /places sampled in/.test(picked.html),
    { at, picked: picked && { samples: picked.samples, html: picked.html.slice(0, 160) } });

  // The non-commercial study: never drawn, live or in its own years.
  const seen = [];
  for (const iso of [null, '1965-07-01T00:00:00Z', '1980-07-01T00:00:00Z', '1992-07-01T00:00:00Z']) {
    await setYear(iso);
    const d = await drawn();
    if (statesOf(d, DROPPED).length || d.cells[String(DROPPED)]) seen.push(iso ?? 'live');
  }
  report('dropped-non-commercial-absent', seen.length === 0 && !studies.some((s) => s.id === DROPPED), { seenAt: seen });
  const notOpen = studies.filter((s) => NOT_OPEN.test(s.licence ?? ''));
  report('every-study-open-licence', studies.length > 0 && notOpen.length === 0, { notOpen: notOpen.slice(0, 5).map((s) => [s.id, s.licence]) });
  const domain = await page.evaluate(() => window.__godsEyeView.observedTime.domain()?.start ?? null);
  const first = Math.min(...studies.flatMap((s) => Object.keys(s.years).map(Number)));
  report('time-bar-reaches-first-year', domain !== null && domain <= Date.UTC(first, 0, 1), { first, domainStart: domain && new Date(domain).toISOString() });
  await setYear(null);
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-404-or-console-errors', bad.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0,
  { bad: bad.slice(0, 5), consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
