#!/usr/bin/env node
/**
 * qa-gap-layers.mjs — headless smoke for the 2026-09-12 biology gap layers.
 * Loads the REAL built app, enables each layer through the data manager, waits for its
 * first update, and FAILS on: update error, zero features, zero entities in the viewer,
 * or any page error raised while the layer was on. Screenshot per layer to qa-shots/.
 * Run: node scripts/qa-gap-layers.mjs --url http://localhost:4455
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(REPO, 'qa-shots', 'gap-layers');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL = opt('--url', 'http://localhost:4455');
const IDS = opt('--ids', 'arbonet,phenology,neon-vectors,cetaceans,drought,h5n1,fires,ecoregions,rivers').split(',');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
let pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
const baselineErrors = pageErrors.length;
console.log(`app ready; ${baselineErrors} console/page errors before any gap layer (not attributed)`);
pageErrors = [];

let failures = 0;
for (const id of IDS) {
  pageErrors = [];
  const t0 = Date.now();
  const res = await page.evaluate(async (id) => {
    const g = window.__godsEyeView; const dm = g.dataManager;
    const known = dm.getAll().some((l) => l.id === id);
    if (!known) return { error: 'not registered' };
    await dm.setEnabled(id, true);
    const deadline = Date.now() + 90000;
    let s;
    while (Date.now() < deadline) {
      s = dm.getAll().find((l) => l.id === id).stats;
      if (s?.lastUpdate || s?.error) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const ds = [];
    for (let i = 0; i < g.viewer.dataSources.length; i++) {
      const d = g.viewer.dataSources.get(i);
      if (d.show && d.entities?.values?.length) ds.push([d.name, d.entities.values.length]);
    }
    g.requestRender?.();
    return { stats: s, dataSources: ds };
  }, id);
  await new Promise((r) => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(SHOTS, `${id}.png`) });
  const s = res.stats || {};
  const ents = (res.dataSources || []).filter(([n]) => n === id || n.startsWith(id)).reduce((a, [, n]) => a + n, 0);
  const problems = [];
  if (res.error) problems.push(res.error);
  if (s.error) problems.push(`stats.error=${s.error}`);
  if (!s.lastUpdate) problems.push('no lastUpdate');
  if (!(s.count > 0)) problems.push(`count=${s.count}`);
  if (!(ents > 0)) problems.push(`entities=${ents} (shown sources: ${JSON.stringify(res.dataSources)})`);
  if (pageErrors.length) problems.push(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${id}: count=${s.count} entities=${ents} ${Date.now() - t0}ms${problems.length ? ' — ' + problems.join('; ') : ''}`);
  if (problems.length) failures++;
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false), id);
}
await browser.close();
console.log(`${IDS.length - failures}/${IDS.length} passed`);
process.exit(failures ? 1 : 0);
