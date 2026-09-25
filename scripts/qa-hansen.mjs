#!/usr/bin/env node
/**
 * qa-hansen.mjs — real-browser acceptance for the forest-loss layer (grill_wildeye_next_wave_2026-09-25 A11).
 * Run: node scripts/qa-hansen.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answer, decoded 2026-09-25 by a Python probe straight from the GFW data tile (z12 1331/2162, pixel
 * 10,10), independent of the site's decoder: (-9.970626, -63.015776) lost tree cover in 2018, and the whole 5×5
 * block around it did too, so a one-pixel error in the tile math cannot change the answer. Negative control:
 * open Atlantic (-20, -30) has no loss. Proof it drew: the globe over Rondônia gains loss-coloured pixels when
 * the layer is on (the tiles are recoloured in a worker, whose requests the page may not see).
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'hansen-loss';
const P = { loss: [-9.970626, -63.015776], ocean: [-20.0, -30.0] };

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
const consoleErrors = [];
const tiles = { ok: 0, bad: [] };
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() !== 'error' || !/hansen|Data|what-lives-here|recolour/.test(m.text())) return;
    const at = consoleErrors.push(m.text().slice(0, 200)) - 1;
    m.args()[1]?.evaluate((o) => { const e = o?.error ?? o; return e?.message ? `${e.name}: ${e.message}` : String(e); })
      .then((why) => { consoleErrors[at] += ` — ${why}`; }, () => {});
  });
  page.on('response', (r) => {
    if (!r.url().includes('umd_tree_cover_loss')) return;
    if (r.status() === 200) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await sleep(12000);
  await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-first-run-choice]')?.offsetParent, { timeout: 60000 }).catch(() => {});

  // The globe's centre, rendered and read back in one task (no preserveDrawingBuffer needed).
  const lossPixels = () => page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 90 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 3000));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.drawImage(src, src.width / 2 - 100, src.height / 2 - 100, 200, 200, 0, 0, 200, 200);
    const d = g.getImageData(0, 0, 200, 200).data;
    let n = 0;
    // the ramp is yellow → orange → deep red: red well above blue, green not above red
    for (let i = 0; i < d.length; i += 4) if (d[i] - d[i + 2] > 90 && d[i + 1] <= d[i]) n += 1;
    return n / (d.length / 4);
  });

  await page.evaluate(async ([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 120000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, P.loss);
  const before = await lossPixels();
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !stats()?.time; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: stats() ?? null };
  }, ID);
  // Wait for the forest-loss tiles themselves (the worker's fetches reach the page's network log): the globe's
  // tilesLoaded is about terrain and read true before a single GFW response had arrived (first run, 2026-09-25).
  const settle = async () => {
    let last = -1, still = 0;
    for (let i = 0; i < 180 && still < 8; i += 1) {
      await sleep(500);
      const n = tiles.ok + tiles.bad.length;
      still = n > 0 && n === last ? still + 1 : 0;
      last = n;
    }
  };
  await settle();
  const after = await lossPixels();
  report('drew', enabled.on && after - before > 0.02 && !enabled.stats?.error, { before: before.toFixed(4), after: after.toFixed(4), stats: enabled.stats, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3) });

  const extent = await page.evaluate((id) => {
    const s = window.__godsEyeView.observedTime;
    return { mine: s.extents().get(id) ?? null, domainStart: s.domain()?.start ?? null };
  }, ID);
  report('time-bar-reaches-2001', extent.mine?.startMs === Date.UTC(2001, 0, 1) && extent.domainStart !== null && extent.domainStart <= Date.UTC(2001, 0, 1),
    { extent: extent.mine, domainStart: extent.domainStart && new Date(extent.domainStart).toISOString() });

  const read = (points) => page.evaluate(async (id, points) => {
    const out = {};
    for (const [name, [lat, lon]] of Object.entries(points)) {
      const rows = await window.__godsEyeView.readoutAt(lat, lon);
      out[name] = rows.find((r) => r.id === id) ?? null;
    }
    return out;
  }, ID, points);
  const live = await read(P);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  report('known-loss', live.loss?.status === 'class' && live.loss.text === 'Forest loss' && live.loss.date === '2018', { got: row(live.loss) });
  report('negative-ocean', live.ocean?.status === 'class' && live.ocean.text === 'No loss detected' && live.ocean.date === '2001–2024', { got: row(live.ocean) });

  // Cumulative: scrubbed to 2010, the 2018 loss is not drawn and the readout says it came later; LIVE restores it.
  const scrubbed = await page.evaluate(async (id) => {
    const { dataManager, observedTime } = window.__godsEyeView;
    observedTime.set('2010-06-01T00:00:00Z');
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 40 && stats()?.time !== '2001–2010'; i += 1) await new Promise((r) => setTimeout(r, 250));
    return stats()?.time ?? null;
  }, ID);
  const past = await read({ loss: P.loss });
  await settle();
  const livePx = after;
  const pastPx = await lossPixels();
  await page.evaluate(() => window.__godsEyeView.observedTime.set(null));
  report('cumulative-2010', scrubbed === '2001–2010' && past.loss?.text === 'Forest loss (after the date shown)' && past.loss.date === '2018' && pastPx < livePx,
    { shown: scrubbed, got: row(past.loss), lossPixelsLive: livePx.toFixed(4), lossPixels2010: pastPx.toFixed(4) });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, tiles200: tiles.ok }));
process.exit(failed ? 1 : 0);
