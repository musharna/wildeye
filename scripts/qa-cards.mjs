#!/usr/bin/env node
/**
 * qa-cards.mjs — real-browser check that a click on a BioTIME study, a mangrove country (GMW) or a GRIIS country opens the
 * details card with its citation. Cesium's info box is off, so the card is the only way a layer's description reaches
 * the screen; these three were left off its list and a click showed nothing.
 * Run: node scripts/qa-cards.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails. Selecting an entity is what a click on it does
 * (viewer.selectedEntity), so the check does not depend on where on screen the entity is drawn.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const LAYERS = ['biotime', 'gmw', 'griis'];

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
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  for (const id of LAYERS) {
    const got = await page.evaluate(async (layerId) => {
      const { dataManager, viewer } = window.__godsEyeView;
      await dataManager.setEnabled(layerId, true, { origin: 'user' });
      let ds = null;
      for (let i = 0; i < 120 && !ds?.entities.values.some((e) => e.description); i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        ds = viewer.dataSources.getByName(layerId)[0] ?? null;
      }
      const entity = ds?.entities.values.find((e) => e.show !== false && e.description);
      if (!entity) return { error: `no ${layerId} entity with a description` };
      viewer.selectedEntity = entity;
      const card = document.querySelector('.bio-card');
      for (let i = 0; i < 20 && card?.hidden !== false; i += 1) await new Promise((r) => setTimeout(r, 100));
      const body = card?.querySelector('.bio-card-body');
      const out = { open: card?.hidden === false, links: body ? body.querySelectorAll('a[href^="http"]').length : 0, text: (body?.textContent || '').trim().slice(0, 120) };
      viewer.selectedEntity = undefined;
      await dataManager.setEnabled(layerId, false, { origin: 'user' });
      return out;
    }, id);
    report(`card-opens-${id}`, !got.error && got.open && got.links > 0 && got.text.length > 0, got);
  }
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-page-errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
