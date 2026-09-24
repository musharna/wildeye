#!/usr/bin/env node
/**
 * S3 season site agreement (docs/analysis/s3_season_prereg.md): the live site is scrubbed to the check date
 * through its own time bar store, and each of 50 offline-decoded points (analysis/out_season/check_points.json)
 * is read through the site's readout with land cover, EVI and LST enabled one at a time (one-drape rule). Class
 * and value text must agree exactly, and each layer must be showing the requested date (land cover 2024-01-01,
 * EVI the check date, LST its first 8-day composite). A transport error is re-read up to 3 times.
 * Writes analysis/out_season/site_check.json.
 * Run: heavy-run node analysis/s3_season_site_check.mjs [--url https://musharna.github.io/wildeye/]
 */
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync } from 'node:fs';
import { formatValue } from '../src/data/gibsReadout.js';

const argv = process.argv.slice(2);
const SITE = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'https://musharna.github.io/wildeye/';
const CP = JSON.parse(readFileSync('analysis/out_season/check_points.json', 'utf8'));
const WANT_DATE = { 'gibs-landcover': CP.lc_date, 'gibs-evi': CP.date, 'gibs-lst': CP.lst_date };
const KEY = { 'gibs-landcover': 'lc', 'gibs-evi': 'evi', 'gibs-lst': 'lst' };

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 600000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'] });
let out;
try {
  const page = await browser.newPage();
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView.observedTime && typeof window.__godsEyeView.readoutAt === 'function', { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  const manifest = await page.evaluate(async () => (await (await fetch(`data/gibs.json?t=${Date.now()}`)).json()).layers);
  const readAll = (id) => page.evaluate(async (id, iso, want, pts) => {
    const { dataManager, observedTime } = window.__godsEyeView;
    for (const l of ['gibs-landcover', 'gibs-evi', 'gibs-lst', 'gibs-nightlights', 'gibs-biomass']) if (l !== id && dataManager.isEnabled(l)) await dataManager.setEnabled(l, false);
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    // the store clamps to the enabled layers' span, so scrub after enabling, and until the layer shows the date
    for (let i = 0; i < 120 && stats()?.time !== want; i += 1) {
      observedTime.set(iso);
      await new Promise((r) => setTimeout(r, 500));
    }
    const read = async (lat, lon) => ((await window.__godsEyeView.readoutAt(lat, lon)) || []).find((r) => r?.id === id) ?? null;
    const res = [];
    for (const [lat, lon] of pts) {
      let r = await read(lat, lon);
      const errors = [];
      for (let k = 0; k < 3 && r?.status === 'error'; k += 1) {
        errors.push(r.error);
        await new Promise((ok) => setTimeout(ok, 3000));
        r = await read(lat, lon);
      }
      res.push(r && { status: r.status, text: r.text, date: r.date, error: r.error, retriedErrors: errors });
    }
    return { shown: stats()?.time ?? null, rows: res };
  }, id, `${CP.date}T12:00:00Z`, WANT_DATE[id], CP.points.map((p) => [p.lat, p.lon]));

  const mismatches = [];
  const shown = {};
  const retried = [];
  for (const id of Object.keys(KEY)) {
    const k = KEY[id];
    const { shown: s, rows } = await readAll(id);
    shown[id] = s;
    if (s !== WANT_DATE[id]) mismatches.push({ layer: k, shownDate: s, wantDate: WANT_DATE[id] });
    CP.points.forEach((p, i) => {
      const v = p[k];
      const want = v[0] === 'class' ? { status: 'class', text: v[1] }
        : v[0] === 'value' ? { status: 'value', text: formatValue(manifest[id], v[1], v[2]) }
          : { status: 'nodata', text: null };
      const got = rows[i];
      if (got?.retriedErrors?.length) retried.push({ point: [p.region, p.lat, p.lon], layer: k, errors: got.retriedErrors });
      if (!got || got.status !== want.status || got.text !== want.text || got.date !== WANT_DATE[id]) {
        mismatches.push({ point: [p.region, p.lat, p.lon], layer: k, want, got });
      }
    });
  }
  out = { site: SITE, date: CP.date, shown, n: CP.points.length, compared: CP.points.length * 3, mismatches, retried, agree: mismatches.length === 0 };
} catch (e) {
  out = { site: SITE, error: String(e?.message || e), agree: false };
} finally {
  await browser.close();
}
writeFileSync('analysis/out_season/site_check.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ agree: out.agree, shown: out.shown, compared: out.compared, mismatches: out.mismatches?.length, error: out.error }));
process.exit(out.agree ? 0 : 1);
