#!/usr/bin/env node
/**
 * qa-drape-swap.mjs — real-browser check that swapping one dated drape for another keeps the time bar's
 * selected instant. Before the fix the old drape's span was withdrawn before the new one's was declared,
 * the store re-clamped into the empty gap, and the bar went LIVE (src/observedTime.js holdClamp).
 * Run: node scripts/qa-drape-swap.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const SITE = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'https://musharna.github.io/wildeye/';
const AT = '2010-06-01T00:00:00Z';

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
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 300)));
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  const enable = (id) => page.evaluate(async (layerId) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(layerId, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === layerId)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
  }, id);
  const state = () => page.evaluate(() => {
    const { dataManager, observedTime } = window.__godsEyeView;
    const stats = (id) => dataManager.getAll().find((l) => l.id === id)?.stats ?? null;
    return {
      bar: observedTime.get(),
      biiOn: dataManager.isEnabled('bii'),
      footprintOn: dataManager.isEnabled('human-footprint'),
      biiTime: stats('bii')?.time ?? null,
      footprintTime: stats('human-footprint')?.time ?? null,
    };
  });

  await enable('bii');
  await page.evaluate((iso) => window.__godsEyeView.observedTime.set(iso), AT);
  const before = await state();
  report('scrubbed-on-nhm', before.bar === AT && before.biiOn && before.biiTime === '2010', before);

  await enable('human-footprint');
  // the extent lands after the enable settles: wait for the footprint layer to report the year it draws
  await page.waitForFunction(() => {
    const s = window.__godsEyeView.dataManager.getAll().find((l) => l.id === 'human-footprint')?.stats;
    return s?.time != null;
  }, { timeout: 60000, polling: 250 }).catch(() => null);
  const after = await state();
  report('swap-happened', !after.biiOn && after.footprintOn, after);
  report('bar-keeps-2010-across-the-swap', after.bar === AT && after.footprintTime === '2006', { want: { bar: AT, footprintTime: '2006' }, got: after });
} catch (e) {
  report('run', false, { error: String(e?.stack || e).slice(0, 500) });
} finally {
  await browser.close();
}
report('no-page-errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
