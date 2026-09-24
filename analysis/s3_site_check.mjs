#!/usr/bin/env node
/**
 * S3 pilot site agreement (docs/analysis/s3-heat-greenness-prereg.md): 50 random sampled points, read
 * through the live site's own readout, must agree exactly with the offline decode (analysis/out/points.csv).
 * Land cover by label; EVI and LST by the text the site's own formatValue gives the offline bin; an LST
 * cloud hole must be 'nodata' on both sides. Writes analysis/out/site_check.json.
 * Run: heavy-run node analysis/s3_site_check.mjs [--url https://musharna.github.io/wildeye/]
 */
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync } from 'node:fs';
import { formatValue } from '../src/data/gibsReadout.js';

const argv = process.argv.slice(2);
const SITE = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'https://musharna.github.io/wildeye/';
const N = 50;

// Seeded pick (mulberry32), so the same 50 points are checked on a rerun.
let seed = 20260924;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const [header, ...lines] = readFileSync('analysis/out/points.csv', 'utf8').trim().split(/\r?\n/);
const cols = header.split(',');
const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
const pick = Array.from({ length: N }, () => rows[Math.floor(rand() * rows.length)]);
const num = (v) => (v === '' ? null : Number(v));

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 600000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'] });
let out;
try {
  const page = await browser.newPage();
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && typeof window.__godsEyeView.readoutAt === 'function', { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  const manifest = await page.evaluate(async () => (await (await fetch(`data/gibs.json?t=${Date.now()}`)).json()).layers);
  const readAll = (id) => page.evaluate(async (id, pts) => {
    const { dataManager } = window.__godsEyeView;
    for (const l of ['gibs-landcover', 'gibs-evi', 'gibs-lst', 'gibs-nightlights', 'gibs-biomass']) if (l !== id && dataManager.isEnabled(l)) await dataManager.setEnabled(l, false);
    await dataManager.setEnabled(id, true, { origin: 'user' });
    for (let i = 0; i < 120 && !dataManager.getAll().find((l) => l.id === id)?.stats?.time; i += 1) await new Promise((r) => setTimeout(r, 500));
    const res = [];
    // a transport error (tile fetch failed) is re-read, up to 3 more times; it must still end in agreement
    const read = async (lat, lon) => ((await window.__godsEyeView.readoutAt(lat, lon)) || []).find((r) => r?.id === id) ?? null;
    for (const [lat, lon] of pts) {
      let r = await read(lat, lon);
      const errors = [];
      for (let k = 0; k < 3 && r?.status === 'error'; k += 1) {
        errors.push(r.error);
        await new Promise((ok) => setTimeout(ok, 3000));
        r = await read(lat, lon);
      }
      res.push(r && { ...r, retriedErrors: errors });
    }
    return res;
  }, id, pick.map((p) => [Number(p.lat), Number(p.lon)]));
  const site = { lc: await readAll('gibs-landcover'), evi: await readAll('gibs-evi'), lst: await readAll('gibs-lst') };
  const mismatches = [];
  pick.forEach((p, i) => {
    const want = {
      lc: { status: 'class', text: p.lc },
      evi: num(p.evi_lo) === null ? { status: 'nodata', text: null } : { status: 'value', text: formatValue(manifest['gibs-evi'], num(p.evi_lo), num(p.evi_hi)) },
      lst: p.lst_nodata === '1' ? { status: 'nodata', text: null } : { status: 'value', text: formatValue(manifest['gibs-lst'], num(p.lst_lo), num(p.lst_hi)) },
    };
    for (const k of ['lc', 'evi', 'lst']) {
      const got = site[k][i];
      if (!got || got.status !== want[k].status || got.text !== want[k].text) mismatches.push({ point: [p.region, p.lat, p.lon], layer: k, want: want[k], got: got && { status: got.status, text: got.text, date: got.date, error: got.error, retriedErrors: got.retriedErrors } });
    }
  });
  const retried = pick.flatMap((p, i) => ['lc', 'evi', 'lst'].filter((k) => site[k][i]?.retriedErrors?.length).map((k) => ({ point: [p.region, p.lat, p.lon], layer: k, errors: site[k][i].retriedErrors })));
  out = { site: SITE, n: N, compared: N * 3, mismatches, retried, agree: mismatches.length === 0 };
} catch (e) {
  out = { site: SITE, error: String(e?.message || e), agree: false };
} finally {
  await browser.close();
}
writeFileSync('analysis/out/site_check.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ agree: out.agree, compared: out.compared, mismatches: out.mismatches?.length, error: out.error }));
process.exit(out.agree ? 0 : 1);
