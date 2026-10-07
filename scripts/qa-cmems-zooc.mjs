#!/usr/bin/env node
/**
 * qa-cmems-zooc.mjs — real-browser acceptance for the surface zooplankton carbon drape (spec
 * docs/superpowers/specs/2026-10-07-cmems-zooplankton.md).
 * Run: node scripts/qa-cmems-zooc.mjs --truth <json from scripts/qa_cmems_zooc_truth.py> [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers come from an independent route, not pipeline/raster.py: qa_cmems_zooc_truth.py reads each point's raw
 * value straight from Copernicus Marine with xarray and the interval of values the PNG's colour stands for, with its own
 * log rendering. Here each click must read the PNG's colour band at two significant figures (the clamped top reads
 * "≥ 5") and lie within 5% of the raw value; land reads no data.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const TRUTH_PATH = arg('--truth', null);
if (!TRUTH_PATH) {
  console.error('usage: node scripts/qa-cmems-zooc.mjs --truth <truth.json> [--url <site>]');
  process.exit(2);
}
const TRUTH = JSON.parse(fs.readFileSync(TRUTH_PATH, 'utf8'));
const ID = 'cmems-zooc';
const UNIT = ' mmol C/m³';
const LEGEND = ['0.05 mmol C/m³', '0.5 mmol C/m³', '5 mmol C/m³',
  'zooplankton carbon at the surface, daily, log scale: purple = little · yellow = a lot. A model value (PISCES biogeochemical model in the Copernicus global analysis), not an observation'];
const TOP = [253, 231, 37], BOTTOM = [68, 1, 84];
const same = (a, b) => a.every((v, i) => v === b[i]);
const sig2 = (v) => Number(v.toPrecision(2));

/** The readout text a point must show, from the truth file alone: a bound at a clamped end, else a 2-figure number. */
function check(p, row) {
  const c = p.png_rgba.slice(0, 3);
  if (same(c, TOP)) return { ok: row?.text === `≥ 5${UNIT}`, want: `≥ 5${UNIT}` };
  if (same(c, BOTTOM)) return { ok: row?.text === `≤ 0.05${UNIT}`, want: `≤ 0.05${UNIT}` };
  const m = /^([0-9.]+) mmol C\/m³$/.exec(row?.text ?? '');
  const v = m ? Number(m[1]) : NaN;
  const inBand = v >= sig2(p.png_lo) && v <= sig2(p.png_hi);
  const nearRaw = Math.abs(v - p.raw) / p.raw <= 0.05;
  return { ok: inBand && nearRaw, want: `${sig2(p.png_lo)}..${sig2(p.png_hi)}${UNIT}, raw ${p.raw}` };
}

const results = [];
const report = (name, ok, detail = {}) => {
  const row = { check: name, ...detail, ok };
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
    if (m.type() === 'error' && /cmems|zooc|Data|what-lives-here|readout/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  const onGlobe = () => page.evaluate((id) => {
    const { dataManager } = window.__godsEyeView;
    const layer = dataManager.layers.get(id)?.module;
    return Boolean(layer && dataManager.isEnabled(id) && layer.getStats().count === 1);
  }, ID);
  const before = await onGlobe() || (await page.evaluate(() => window.__godsEyeView.drapeStack())).some((e) => e.id === 'cmems-zooc' && e.onGlobe);
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.lastUpdate && !stats()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    const layer = dataManager.layers.get(id)?.module;
    const extent = layer?.getObservedExtent?.() ?? null;
    return { on: dataManager.isEnabled(id), stats: stats() ?? null, extent };
  }, ID);
  const s = enabled.stats;
  report('loaded', enabled.on && !s?.error && s?.count === 1 && String(s?.time).slice(0, 10) === TRUTH.day && !before,
    { time: s?.time ?? null, error: s?.error ?? null, before });
  const dayMs = Date.parse(`${TRUTH.day}T00:00:00Z`);
  report('on-time-bar', Boolean(enabled.extent) && enabled.extent.startMs <= dayMs && enabled.extent.endMs >= dayMs, { extent: enabled.extent });

  const stack = await page.evaluate(() => window.__godsEyeView.drapeStack());
  report('drawn', stack.some((e) => e.id === ID && e.onGlobe), { stack: stack.map((e) => `${e.id}:${e.onGlobe}`) });

  const read = (points) => page.evaluate(async (id, points) => {
    const out = [];
    for (const [lat, lon] of points) {
      const rows = await window.__godsEyeView.readoutAt(lat, lon);
      out.push(rows.find((r) => r.id === id) ?? null);
    }
    return out;
  }, ID, points);
  const rows = await read(TRUTH.points.map((p) => [p.lat, p.lon]));
  TRUTH.points.forEach((p, i) => {
    const row = rows[i];
    const c = check(p, row);
    report(`readout-${p.name}`, p.raw_in_png_interval && row?.status === 'value' && row.date === TRUTH.day && c.ok,
      { got: row?.text ?? row?.error ?? null, status: row?.status ?? null, date: row?.date ?? null, want: c.want, raw: p.raw });
  });
  const [land] = await read([[TRUTH.land.lat, TRUTH.land.lon]]);
  report('readout-land', TRUTH.land.raw_is_nan && TRUTH.land.png_alpha === 0 && land?.status === 'nodata' && land.date === TRUTH.day,
    { status: land?.status ?? null, error: land?.error ?? null });

  const shown = await page.evaluate((id) => {
    const items = [...document.querySelectorAll(`.data-toggle-row[data-layer-id="${id}"] .data-toggle-legend-item`)].map((e) => e.textContent.trim());
    const credit = [...document.querySelectorAll('[class*="credit"]')].filter((e) => !e.closest('.bio-card'));
    return { items, text: credit.map((e) => e.textContent).join(' '), html: credit.map((e) => e.innerHTML).join(' ') };
  }, ID);
  report('legend', JSON.stringify(shown.items) === JSON.stringify(LEGEND), { items: shown.items });
  report('credit', shown.text.includes('Ocean oxygen, pH and zooplankton carbon (model): Generated using E.U. Copernicus Marine Service Information')
    && shown.html.includes('https://doi.org/10.48670/moi-00015'), { credit: shown.text.match(/Ocean oxygen[^]{0,200}/)?.[0] ?? null });

  // the hash is rewritten on a debounce after a toggle: wait for this layer's token to appear (or 15 s), then judge it
  await page.waitForFunction(() => /[#&]l=[^&]/.test(decodeURIComponent(location.href)), { timeout: 15000, polling: 250 }).catch(() => null);
  const share = await page.evaluate(() => location.href);
  report('share-token', /[#&]l=([^&]*\.)?zc(\.|&|$)/.test(decodeURIComponent(share)), { url: share.slice(0, 220) });
  // round trip: the link opens with the layer on
  const second = await browser.newPage();
  second.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  await second.goto(share, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await second.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await second.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(second);
  const reopened = await second.evaluate((id) => window.__godsEyeView.dataManager.isEnabled(id), ID);
  report('share-round-trip', reopened === true, { reopened });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
