#!/usr/bin/env node
/**
 * qa-hud-plain.mjs — real-browser check that the camera HUD speaks plainly (grill_wildeye_next_wave_2026-09-25, item 6).
 * Run: node scripts/qa-hud-plain.mjs [--url http://127.0.0.1:8781/] [--shots <dir>]
 * One JSON line per check; exits 1 when any check fails. Switches to CRT (the style that shows the HUD), then reads the
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

  await page.evaluate(() => window.__godsEyeView.styleManager.setStyle('retro'));
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
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/hud-plain-crt.png` });
  report('HUD shows under CRT', hud && read.visible, { visible: read.visible });
  report('lat/lon, ALT/SUN, clock and summary are filled', /^\d\d°\d\d'\d\d\.\d\d"[NS] \d{3}°\d\d'\d\d\.\d\d"[EW]$/.test(read.latlon ?? '')
    && /ALT: -?\d+m .*SUN: -?\d+\.\d° EL/.test(read.alt ?? '') && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ$/.test(read.clock ?? '')
    && !!read.summary && read.summary !== 'Awaiting telemetry...', { latlon: read.latlon, alt: read.alt, clock: read.clock, mode: read.mode, summary: read.summary });
  const hits = REMOVED.filter((re) => re.test(read.text)).map(String);
  report('no spy-satellite readout on screen', hits.length === 0, { hits });

  // The summary re-types itself every 15 s. The HUD corner is an obstacle the left panel stack lays out around
  // (src/ui.js), so if the box changes size while typing, the stack slides again (the qa-species left-stack flake).
  // Every text change is measured in a MutationObserver callback, so a 24 ms empty state cannot fall between frames.
  // Positive control: the visible text (innerText skips visibility:hidden) really grows during the re-type.
  const retype = await page.evaluate(() => new Promise((resolve) => {
    const el = document.getElementById('hud-summary');
    const box = document.querySelector('#intel-hud .hud-top-left');
    const stack = document.getElementById('left-panel-stack');
    const samples = [];
    let started = null;
    let last = el.innerText.length;
    const sample = () => {
      const len = el.innerText.length;
      if (started === null && len < last) started = performance.now();
      last = len;
      if (started === null) return;
      const r = box.getBoundingClientRect();
      samples.push({ t: Math.round(performance.now() - started), len, width: +r.width.toFixed(1), height: +r.height.toFixed(1), safeTop: stack?.style.getPropertyValue('--left-stack-safe-top') || null });
    };
    const observer = new MutationObserver(sample);
    observer.observe(el, { childList: true, characterData: true, subtree: true });
    const deadline = performance.now() + 20000;
    const tick = () => {
      sample();
      const done = started !== null && performance.now() - started > 2500;
      if (done || performance.now() > deadline) {
        observer.disconnect();
        resolve({ samples, timedOut: !done });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const spread = (key) => {
    const values = retype.samples.map((s) => s[key]);
    return values.length ? +(Math.max(...values) - Math.min(...values)).toFixed(1) : null;
  };
  const lengths = [...new Set(retype.samples.map((s) => s.len))];
  const typed = !retype.timedOut && lengths.length >= 3 && retype.samples.at(-1).len === Math.max(...lengths);
  const safeTops = [...new Set(retype.samples.map((s) => s.safeTop))];
  report('summary re-type keeps the HUD box size', typed && spread('width') <= 0.5 && spread('height') <= 0.5 && safeTops.length <= 1, {
    typed, timedOut: retype.timedOut, samples: retype.samples.length, lengths: lengths.slice(0, 8), widthSpread: spread('width'), heightSpread: spread('height'), safeTops,
  });

  // Two corners share each row. On a phone their one-line readouts are wider than half the screen: lat/lon printed over
  // ALT/SUN at 390 px and the summary ran 69 px off the right edge (live, 2026-09-28). Each readout's own text extent
  // (a Range; the summary clips, so its box) must be on screen and clear of every other readout. Positive control: all
  // five readouts have text, and 1400 px, where the corners always fit, is checked the same way.
  const READOUTS = ['hud-mode', 'hud-summary', 'hud-timestamp', 'hud-latlon', 'hud-alt'];
  for (const [width, height] of [[390, 844], [360, 740], [1400, 900]]) {
    await page.setViewport({ width, height });
    await page.waitForFunction((w) => innerWidth === w, { timeout: 10000 }, width);
    await sleep(1500);
    const layout = await page.evaluate((ids) => {
      const boxes = ids.map((id) => {
        const el = document.getElementById(id);
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = id === 'hud-summary' ? el.getBoundingClientRect() : range.getBoundingClientRect();
        return { id, l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), chars: el.textContent.trim().length };
      });
      const offscreen = boxes.filter((b) => b.l < -0.5 || b.r > innerWidth + 0.5 || b.t < -0.5 || b.b > innerHeight + 0.5).map((b) => b.id);
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5) overlaps.push(`${a.id}/${b.id}`);
      }
      return { boxes, offscreen, overlaps, empty: boxes.filter((b) => !b.chars).map((b) => b.id) };
    }, READOUTS);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/hud-plain-${width}.png` });
    report(`HUD readouts on screen and apart at ${width} px`, !layout.offscreen.length && !layout.overlaps.length && !layout.empty.length, layout);
  }
  report('no page errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 3) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
