#!/usr/bin/env node
/**
 * qa-hud-plain.mjs — real-browser check that the camera HUD speaks plainly (grill_wildeye_next_wave_2026-09-25, item 6).
 * Run: node scripts/qa-hud-plain.mjs [--url http://127.0.0.1:8781/] [--shots <dir>]
 * One JSON line per check; exits 1 when any check fails. Switches to NVG (a style that shows the HUD), then reads the
 * HUD's rendered text: lat/lon, ALT/SUN, the UTC clock and the summary must be there (positive control), and none of
 * the removed spy-satellite readouts. The page title and the loading screen must say wildeye.
 * Software WebGL only (swiftshader): hardware-GPU headless Chrome crashed the laptop twice (2026-09-25).
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const SHOTS = arg('--shots', null);
const REMOVED = [/TOP SECRET/, /NOFORN/, /SI-TK/, /KH11/, /\bOPS-\d/, /PAGE 1\/1/, /\bREC\b/, /ORB:/, /PASS:/, /MGRS/, /GSD/, /NIIRS/, /\bONA\b/, /COLL:/, /BAND:/, /BITS:/, /LVL:/, /SECTOR/, /WINDOW/, /GOD'S EYE/i, /NO PLACE LEFT BEHIND/i];

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const loader = await page.evaluate(() => document.querySelector('#loading-screen h2')?.textContent.trim() ?? null);
  report('loading screen says wildeye', loader === 'wildeye', { loader });
  await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await sleep(12000);
  await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
  await page.keyboard.press('Escape');

  const title = await page.evaluate(() => ({ doc: document.title, bar: document.querySelector('#title-bar h1 > span:not(.brand-logo)')?.textContent.trim(), tagline: !!document.querySelector('#title-bar .subtitle') }));
  report('page is titled wildeye, no tagline', title.doc === 'wildeye' && title.bar === 'wildeye' && !title.tagline, title);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/hud-plain-normal.png` });

  await page.evaluate(() => window.__godsEyeView.styleManager.setStyle('surveillance'));
  // The telemetry tick is 250 ms and the clock 1 s; swiftshader frames are slow, so poll for a filled readout.
  const hud = await page.waitForFunction(() => {
    const el = document.getElementById('intel-hud');
    const latlon = document.getElementById('hud-latlon')?.textContent ?? '';
    return el && getComputedStyle(el).visibility !== 'hidden' && /\d/.test(latlon) ? true : null;
  }, { timeout: 120000, polling: 1000 }).then(() => true, () => false);
  const read = await page.evaluate(() => {
    const t = (id) => document.getElementById(id)?.textContent ?? null;
    const el = document.getElementById('intel-hud');
    return {
      visible: !!el && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none',
      latlon: t('hud-latlon'), alt: t('hud-alt'), clock: t('hud-timestamp'), mode: t('hud-mode'), summary: t('hud-summary'),
      text: el?.innerText ?? '',
    };
  });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/hud-plain-nvg.png` });
  report('HUD shows under NVG', hud && read.visible, { visible: read.visible });
  report('lat/lon, ALT/SUN, clock and summary are filled', /^\d\d°\d\d'\d\d\.\d\d"[NS] \d{3}°\d\d'\d\d\.\d\d"[EW]$/.test(read.latlon ?? '')
    && /ALT: -?\d+m .*SUN: -?\d+\.\d° EL/.test(read.alt ?? '') && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ$/.test(read.clock ?? '')
    && !!read.summary && read.summary !== 'Awaiting telemetry...', { latlon: read.latlon, alt: read.alt, clock: read.clock, mode: read.mode, summary: read.summary });
  const hits = REMOVED.filter((re) => re.test(read.text)).map(String);
  report('no spy-satellite readout on screen', hits.length === 0, { hits });
  report('no page errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 3) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
