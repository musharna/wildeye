#!/usr/bin/env node
/**
 * qa-card-timebar.mjs — real-browser check: the details card never covers the time bar.
 *   node scripts/qa-card-timebar.mjs [--url http://127.0.0.1:4489/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * With the bird layer on (it puts the time bar up) and a radar's popup open (birds:KAKQ selected):
 *   - 1400x900 and 1280x800: the card and the time bar do not overlap, and the card is wholly on screen
 *     (at 1400x900 the card's CSS bottom, 104 px, sat 18 px into the bar's right end: 2026-10-21);
 *   - 1920x1080: the centred bar ends left of the card, so the card keeps its CSS place (no inline bottom);
 *   - 667x375 (short viewport): the card hangs from the top with no inline bottom and is not stretched;
 *   - 1400x900 with the compare panel open: the card clears the panel and stays on screen.
 * Software WebGL only (swiftshader): hardware-GPU headless Chrome crashed the laptop twice (2026-09-25).
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const SITE = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://127.0.0.1:4489/wildeye/';
const VIEW = '#v=2&lat=36.9000&lon=-75.5000&alt=1400000&heading=0&pitch=-90&roll=0&map=esri-imagery&l=n';

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
// Only for boxes the check has already required to be on screen (w > 0): a 0x0 box overlaps nothing, so it would pass.
const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const shown = (...boxes) => boxes.every((b) => b?.w > 0);

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});

const measure = (page) => page.evaluate(() => {
  const r = (e) => {
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width) };
  };
  const card = document.getElementById('bio-card');
  return {
    vh: innerHeight, card: r(card), cardInlineBottom: card?.style.bottom ?? null,
    cardMaxHeight: card ? parseFloat(getComputedStyle(card).maxHeight) : null,
    bar: r(document.getElementById('observed-time')), comparePanel: r(document.getElementById('compare-panel')),
  };
});
// the stack re-places on resize and on watched boxes resizing; wait for the frame after that, not a fixed time
const frames = (page) => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));

try {
  const page = await browser.newPage();
  const compareErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && m.text().includes('[compare]')) compareErrors.push(m.text().slice(0, 200)); });
  await page.goto(`${SITE}${VIEW}`, { waitUntil: 'domcontentloaded', timeout: 180000 }); // a loaded laptop missed 30 s
  // Booted = the viewer is up and the loading screen has faded (bootSettled.mjs, less its tilesLoaded): this measures DOM
  // boxes, which no imagery tile moves, and under load the software-rendered globe can go minutes without loading them all.
  await page.waitForFunction(() => window.__godsEyeView?.viewer
    && getComputedStyle(document.getElementById('loading-screen')).visibility === 'hidden', { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => document.getElementById('observed-time')?.style.display === 'flex', { timeout: 120000 });
  await page.waitForFunction(() => {
    const v = window.__godsEyeView?.viewer;
    return v && [...Array(v.dataSources.length).keys()].some((i) => v.dataSources.get(i).entities.getById('birds:KAKQ'));
  }, { timeout: 120000 });
  await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < v.dataSources.length; i++) {
      const e = v.dataSources.get(i).entities.getById('birds:KAKQ');
      if (e) v.selectedEntity = e;
    }
  });
  await page.waitForFunction(() => {
    const c = document.getElementById('bio-card');
    return c && !c.hidden && /Wakefield/.test(c.textContent);
  }, { timeout: 15000 });

  for (const [w, h] of [[1400, 900], [1280, 800]]) {
    await page.setViewport({ width: w, height: h });
    await frames(page);
    const m = await measure(page);
    const ok = shown(m.card, m.bar) && !overlaps(m.card, m.bar) && m.card.t >= 0 && m.card.b <= m.vh;
    report(`${w}x${h}: card clear of the time bar and on screen`, ok, m);
  }

  await page.setViewport({ width: 1920, height: 1080 });
  await frames(page);
  const wide = await measure(page);
  report('1920x1080: card keeps its CSS place (bar ends left of it)', shown(wide.card, wide.bar) && !overlaps(wide.card, wide.bar) && wide.cardInlineBottom === '', wide);

  await page.setViewport({ width: 667, height: 375 });
  await frames(page);
  const short = await measure(page);
  const shortTop = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--short-card-top')) || 76);
  const notStretched = shown(short.card) && Math.abs(short.card.t - shortTop) <= 1 && short.card.b - short.card.t <= short.cardMaxHeight + 1;
  // coversBar is recorded, not asserted: the short card's region ends a constant 78 px up (style.css), and the bar can reach
  // higher (open question, not this check's).
  const coversBar = shown(short.card, short.bar) && overlaps(short.card, short.bar);
  report('667x375: card top-anchored, no inline bottom, not stretched', short.cardInlineBottom === '' && notStretched, { ...short, shortTop, coversBar });

  await page.setViewport({ width: 1400, height: 900 });
  await frames(page);
  await page.evaluate(() => document.getElementById('compare-toggle')?.click());
  // compare.set loads both drapes first; the panel shows once they are on, and closes again if a load fails
  await page.waitForFunction(() => (document.getElementById('compare-panel')?.getBoundingClientRect().height || 0) > 0, { timeout: 60000 })
    .catch(() => {});
  await frames(page);
  const cmp = await measure(page);
  report('1400x900, compare open: card clear of the panel and the bar, on screen',
    shown(cmp.card, cmp.bar, cmp.comparePanel) && !overlaps(cmp.card, cmp.comparePanel) && !overlaps(cmp.card, cmp.bar) && cmp.card.t >= 0,
    { ...cmp, compareErrors });
} finally {
  await browser.close();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
