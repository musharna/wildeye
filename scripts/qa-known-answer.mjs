#!/usr/bin/env node
/**
 * qa-known-answer.mjs — the measured half of the grill's Q6 known-answer control (GIBS stage 3).
 * Run: heavy-run node scripts/qa-known-answer.mjs [--url https://musharna.github.io/wildeye/] [--out table.json]
 *
 * If the overlapping layers mean anything, night lights must rank by land cover: cities bright, forest dark.
 * For a 20×20 grid in four regions (Nile delta + Cairo, Chicago, Delhi, Manaus / central Amazon) it reads the
 * land-cover class through the site's own readout and the VIIRS Black Marble (latest date) luminance
 * 0.2126R + 0.7152G + 0.0722B from the raw tile, decoded exactly, and groups by class.
 *
 * Pass criteria, PRE-REGISTERED in docs/superpowers/plans/2026-09-23-gibs-stage3-readout.md before any run:
 *   (a) Urban and Built-up Lands has the highest mean luminance of every class with n >= 30;
 *   (b) pooled forest (IGBP 1-5) has a lower mean than every other land class with n >= 30, excluding
 *       Water Bodies and Barren (unlit by construction).
 * A failure is a finding to report, not a threshold to retune. Exit 0 pass, 1 fail, 2 harness control failed.
 */
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const OUT = arg('--out', null);
const N_MIN = 30;
const REGIONS = {
  cairo: [29.8, 31.4, 30.2, 32.2],
  chicago: [41.4, 42.3, -88.4, -87.5],
  delhi: [28.3, 29.0, 76.8, 77.6],
  manaus: [-3.6, -2.6, -60.6, -59.4],
};
const FORESTS = ['Evergreen Needleleaf Forests', 'Evergreen Broadleaf Forests', 'Deciduous Needleleaf Forests', 'Deciduous Broadleaf Forests', 'Mixed Forests'];
const UNLIT = ['Water Bodies', 'Barren'];
const URBAN = 'Urban and Built-up Lands';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 1200000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
let code = 1;
try {
  const page = await browser.newPage();
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.styleManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await sleep(8000);
  if (!(await page.evaluate(() => typeof window.__godsEyeView.readoutAt === 'function'))) throw new Error('window.__godsEyeView.readoutAt is missing: this build has no readout');

  // In the page: exact luminance of one Black Marble pixel (raw tile, no colour conversion), tiles cached.
  await page.evaluate(async () => {
    const entry = (await (await fetch(`data/gibs.json?t=${Date.now()}`)).json()).layers['gibs-nightlights'];
    const date = entry.times.at(-1).split('/')[0];
    const tiles = new Map();
    const tile = (z, x, y) => {
      const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${entry.gibsId}/default/${date}/${entry.tileMatrixSet}/${z}/${y}/${x}.${entry.format}`;
      if (!tiles.has(url)) tiles.set(url, (async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Black Marble tile HTTP ${res.status} ${url}`);
        const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        return { w: c.width, data: ctx.getImageData(0, 0, c.width, c.height).data };
      })());
      return tiles.get(url);
    };
    window.__qaBm = { date, async lum(lat, lon) {
      const z = entry.maximumLevel, n = 2 ** z;
      const fx = ((lon + 180) / 360) * n, fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
      const x = Math.floor(fx), y = Math.floor(fy);
      const t = await tile(z, x, y);
      const i = (Math.floor((fy - y) * 256) * t.w + Math.floor((fx - x) * 256)) * 4;
      return 0.2126 * t.data[i] + 0.7152 * t.data[i + 1] + 0.0722 * t.data[i + 2];
    } };
  });

  // Harness control: the Chicago Loop must be bright; if not, the harness reads the wrong tile or pixel.
  const loop = await page.evaluate(() => window.__qaBm.lum(41.88, -87.63));
  console.log(JSON.stringify({ check: 'harness-control', chicagoLoopLuminance: Math.round(loop), ok: loop > 127 }));
  if (!(loop > 127)) {
    console.log(JSON.stringify({ summary: true, error: 'harness control failed' }));
    code = 2;
    throw null;
  }

  const samples = await page.evaluate(async (regions) => {
    const { dataManager } = window.__godsEyeView;
    for (const l of ['gibs-evi', 'gibs-lst', 'gibs-nightlights', 'gibs-biomass']) if (dataManager.isEnabled(l)) await dataManager.setEnabled(l, false);
    await dataManager.setEnabled('gibs-landcover', true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === 'gibs-landcover')?.stats;
    for (let i = 0; i < 120 && !stats()?.time; i += 1) await new Promise((r) => setTimeout(r, 500));
    const out = [];
    for (const [region, [la0, la1, lo0, lo1]] of Object.entries(regions)) {
      for (let i = 0; i < 20; i += 1) for (let j = 0; j < 20; j += 1) {
        const lat = la0 + ((la1 - la0) * (i + 0.5)) / 20, lon = lo0 + ((lo1 - lo0) * (j + 0.5)) / 20;
        const row = (await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === 'gibs-landcover');
        out.push({ region, lat, lon, status: row?.status, cls: row?.text ?? null, lum: await window.__qaBm.lum(lat, lon) });
      }
    }
    return { out, lcDate: stats()?.time, bmDate: window.__qaBm.date };
  }, REGIONS);

  const classed = samples.out.filter((s) => s.status === 'class');
  const by = new Map();
  for (const s of classed) by.set(s.cls, [...(by.get(s.cls) || []), s.lum]);
  const stat = (v) => { const a = [...v].sort((x, y) => x - y); return { n: a.length, mean: a.reduce((p, c) => p + c, 0) / a.length, median: a[Math.floor(a.length / 2)] }; };
  const table = [...by].map(([cls, v]) => ({ cls, ...stat(v) })).sort((a, b) => b.mean - a.mean);
  for (const r of table) console.log(JSON.stringify({ class: r.cls, n: r.n, mean: +r.mean.toFixed(1), median: +r.median.toFixed(1) }));

  const big = table.filter((r) => r.n >= N_MIN);
  const urban = big.find((r) => r.cls === URBAN);
  const a = !!urban && big[0].cls === URBAN;
  const forestLums = classed.filter((s) => FORESTS.includes(s.cls)).map((s) => s.lum);
  const forest = forestLums.length >= N_MIN ? stat(forestLums) : null;
  const rivals = big.filter((r) => !FORESTS.includes(r.cls) && !UNLIT.includes(r.cls));
  const b = !!forest && rivals.every((r) => forest.mean < r.mean);
  console.log(JSON.stringify({ check: 'a-urban-brightest', ok: a, urban: urban && { n: urban.n, mean: +urban.mean.toFixed(1) }, brightest: big[0]?.cls }));
  console.log(JSON.stringify({ check: 'b-forest-darkest-lit-land', ok: b, forest: forest && { n: forest.n, mean: +forest.mean.toFixed(1) }, rivals: rivals.map((r) => [r.cls, +r.mean.toFixed(1), r.n]) }));
  const other = samples.out.length - classed.length;
  console.log(JSON.stringify({ summary: true, samples: samples.out.length, classed: classed.length, notClassed: other, lcDate: samples.lcDate, bmDate: samples.bmDate, pass: a && b }));
  if (OUT) writeFileSync(OUT, JSON.stringify({ site: SITE, lcDate: samples.lcDate, bmDate: samples.bmDate, table, criteria: { a, b }, samples: samples.out }, null, 1));
  code = a && b ? 0 : 1;
} catch (e) {
  if (e !== null) console.log(JSON.stringify({ summary: true, error: String(e?.message || e).slice(0, 300) }));
} finally {
  await browser.close();
}
process.exit(code);
