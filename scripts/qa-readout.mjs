#!/usr/bin/env node
/**
 * qa-readout.mjs — real-browser acceptance for the GIBS point readout (stage 3, grill A13/A14/A18).
 * Run: heavy-run node scripts/qa-readout.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known points were decoded 2026-09-23 by a Python probe straight from the same GIBS tiles, independent
 * of the site's decoder: forest (-5, -65) = Evergreen Broadleaf Forests, EVI 0.43, LST 298.7 K; Sahara
 * (23, 12) = Barren, EVI 0.07, LST 310.7 K; Chicago Loop = Urban and Built-up Lands. Ramp checks assert
 * ordering, not exact bins, because the composites move nightly.
 *
 * The one-drape rule shows one GIBS layer at a time (two while comparing), so each layer is read with
 * only itself on, and the real-click card check uses a Compare pair.
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const P = { forest: [-5.0, -65.0], sahara: [23.0, 12.0], chicago: [41.88, -87.63], delhi: [28.61, 77.21] };

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (text) => Number.parseFloat(String(text ?? '').replace(/^[≥<]\s*/, ''));

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
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error' && /gibs|Data|what-lives-here/.test(m.text())) consoleErrors.push(m.text().slice(0, 200)); });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  // QA_SELFTEST_CONSOLE=1 logs one readout-shaped console error, so the no-console-errors check can be seen to fail
  if (process.env.QA_SELFTEST_CONSOLE) await page.evaluate(() => console.error('[Data:gibs-selftest] injected by QA_SELFTEST_CONSOLE'));
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.styleManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  // Boot flies the camera and shows a first-run launcher over the centre (the qa-gibs / qa-compare pattern).
  await sleep(12000);
  await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-first-run-choice]')?.offsetParent, { timeout: 15000 }).catch(() => {});

  const hasReadout = await page.evaluate(() => typeof window.__godsEyeView.readoutAt === 'function');
  report('readout-exposed', hasReadout, {});
  if (!hasReadout) throw new Error('window.__godsEyeView.readoutAt is missing: this build has no readout');

  /** Only `id` on (the one-drape rule would turn the others off anyway), its date resolved, then read every point. */
  const readWith = (id, points) => page.evaluate(async (id, points) => {
    const { dataManager } = window.__godsEyeView;
    for (const l of ['gibs-landcover', 'gibs-evi', 'gibs-lst', 'gibs-nightlights', 'gibs-biomass']) if (l !== id && dataManager.isEnabled(l)) await dataManager.setEnabled(l, false);
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.time; i += 1) await new Promise((r) => setTimeout(r, 500));
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(points)) {
      const rows = await window.__godsEyeView.readoutAt(lat, lon);
      out[name] = rows.find((r) => r.id === id) ?? null;
    }
    return { rows: out, shown: stats()?.time ?? null };
  }, id, points);

  const lc = await readWith('gibs-landcover', { forest: P.forest, sahara: P.sahara, chicago: P.chicago });
  const want = { forest: 'Evergreen Broadleaf Forests', sahara: 'Barren', chicago: 'Urban and Built-up Lands' };
  report('class-known', Object.entries(want).every(([k, label]) => lc.rows[k]?.status === 'class' && lc.rows[k].text === label),
    { got: Object.fromEntries(Object.entries(lc.rows).map(([k, r]) => [k, r && `${r.status}:${r.text}`])) });

  const evi = await readWith('gibs-evi', { forest: P.forest, sahara: P.sahara });
  const lst = await readWith('gibs-lst', { forest: P.forest, sahara: P.sahara, delhi: P.delhi });
  const eF = num(evi.rows.forest?.text), eS = num(evi.rows.sahara?.text), tF = num(lst.rows.forest?.text), tS = num(lst.rows.sahara?.text);
  report('ramp-ordered', eF > 0.3 && eS < 0.3 && tS > tF, { eviForest: evi.rows.forest?.text, eviSahara: evi.rows.sahara?.text, lstForest: lst.rows.forest?.text, lstSahara: lst.rows.sahara?.text });

  // Each row's date is the date its layer is drawing, and GIBS's own layer-time-actual for that tile agrees
  // (fetched here independently of the site's reader).
  const header = await page.evaluate(async (lat, lon, date) => {
    const e = (await (await fetch(`data/gibs.json?t=${Date.now()}`)).json()).layers['gibs-lst'];
    const z = e.maximumLevel, n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    const res = await fetch(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${e.gibsId}/default/${date}/${e.tileMatrixSet}/${z}/${y}/${x}.${e.format}`);
    return { status: res.status, actual: (res.headers.get('layer-time-actual') || '').slice(0, 10) };
  }, ...P.forest, lst.shown);
  const dated = [[lc, 'forest'], [evi, 'forest'], [lst, 'forest']].every(([r, k]) => r.rows[k]?.date && r.rows[k].date === r.shown);
  report('own-date', dated && header.status === 200 && header.actual === lst.shown, {
    lc: [lc.rows.forest?.date, lc.shown], evi: [evi.rows.forest?.date, evi.shown], lst: [lst.rows.forest?.date, lst.shown], lstHeader: header,
  });

  // A cloud hole in the 8-day LST composite reads as "no data" on that date, never a value. Delhi was one on
  // 2026-08-21; if tonight's composite filled it, the first hole on a monsoon transect stands in (logged).
  let hole = lst.rows.delhi?.status === 'nodata' ? { point: 'delhi', row: lst.rows.delhi } : null;
  if (!hole) {
    const transect = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, [20 + i, 77 + (i % 3)]]));
    const t = await readWith('gibs-lst', transect);
    const k = Object.keys(t.rows).find((key) => t.rows[key]?.status === 'nodata');
    hole = k ? { point: `${k} ${transect[k]}`, row: t.rows[k] } : null;
  }
  report('nodata-honest', !!hole && hole.row.text === null && hole.row.date === lst.shown, { hole });

  const bm = await readWith('gibs-nightlights', { chicago: P.chicago });
  const gedi = await readWith('gibs-biomass', { forest: P.forest });
  report('viewonly-and-timeless', bm.rows.chicago?.status === 'viewonly' && gedi.rows.forest?.status === 'value' && num(gedi.rows.forest.text) > 50,
    { nightlights: bm.rows.chicago?.status, biomassForest: gedi.rows.forest?.text });

  // The real path: Compare land cover | LST, arm WHAT LIVES HERE with a real click, click the globe over the forest
  // point, and the card lists both layers with their dates.
  await page.evaluate(async () => { await window.__godsEyeView.compare.set('gibs-landcover', 'gibs-lst'); });
  await page.evaluate(async ([lat, lon]) => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.setView({ destination: viewer.camera.position.constructor.fromDegrees(lon, lat, 800000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    await new Promise((r) => setTimeout(r, 4000));
  }, P.forest);
  await page.evaluate(() => {
    const panel = document.getElementById('species-panel');
    if (panel?.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click();
  });
  await sleep(800);
  const arm = await page.evaluate(() => {
    const b = document.getElementById('species-what-lives-here');
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hits: !!hit && (hit === b || b.contains(hit)), hit: hit?.id || String(hit?.className || '') };
  });
  if (arm.hits) await page.mouse.click(arm.x, arm.y);
  await sleep(500);
  const centre = await page.evaluate(() => {
    const c = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
    const x = c.left + c.width / 2, y = c.top + c.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, onCanvas: hit === window.__godsEyeView.viewer.scene.canvas, hit: hit?.id || String(hit?.className || '') };
  });
  // the divider sits at the centre while comparing; click a little left of it, still over the forest
  if (centre.onCanvas || /compare/.test(centre.hit)) await page.mouse.click(centre.x - 30, centre.y);
  const card = await page.waitForFunction(() => {
    const items = [...document.querySelectorAll('#bio-card .bio-card-layers li')].map((li) => li.textContent);
    return items.length === 2 && items.every((t) => !t.includes('reading…')) ? items : false;
  }, { timeout: 30000 }).then((h) => h.jsonValue(), () => page.evaluate(() => [...document.querySelectorAll('#bio-card .bio-card-layers li')].map((li) => li.textContent)));
  report('card-shows', arm.hits && Array.isArray(card) && card.length === 2
    && card.some((t) => t.includes('Evergreen Broadleaf Forests · 20')) && card.some((t) => /°C · \d{4}-\d{2}-\d{2}$/.test(t)) && !card.some((t) => t.includes('⚠')),
  { arm, centre, card });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
// The readout logs every failure it swallows (tile HTTP errors, unknown colours, date mismatches); until
// 2026-09-24 these were printed in the summary and never failed the run.
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, pageErrors: pageErrors.slice(0, 5), consoleErrors: consoleErrors.slice(0, 8) }));
process.exit(failed ? 1 : 0);
