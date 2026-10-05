#!/usr/bin/env node
/**
 * qa-seagrass.mjs — real-browser acceptance for the Seagrass layer (spec 2026-10-04-seagrass-design.md).
 * Run: node scripts/qa-seagrass.mjs [--url https://musharna.github.io/wildeye/] [--cache ~/.cache/wildeye/seagrass] [--python python3]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers come from scripts/qa_seagrass_truth.py, which reads both pinned release zips with rasterio and counts
 * the 10 m pixels in each ~150 m cell itself (not pipeline/seagrass.py or the tiles): six cells in each of six meadows
 * (highest share, nearest 50% and 30%, an exact n.5%, under 1.5%, none, picked from 2023–2024), each with its share in
 * both epochs. The same cells are read with the time bar unset (the latest epoch) and at a date in 2021 (2019–2020).
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { NONE_TEXT, shareText } from '../src/data/seagrass.js';
import { decodeTidalMarsh as decodeShare } from '../src/data/tidalMarsh.js';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const CACHE = arg('--cache', path.join(process.env.WILDEYE_CACHE || path.join(os.homedir(), '.cache', 'wildeye'), 'seagrass'));
const PYTHON = arg('--python', 'python3');
const ID = 'seagrass';
const LABEL = { '2019_2020': '2019–2020', '2023_2024': '2023–2024' };
// the real run of 2026-10-04: painted tiles over all levels, per epoch
const LISTED = { '2019_2020': 11499, '2023_2024': 11531 };
// unmapped: north of the release's GeoTIFFs; inland: no seagrass in its cell
const OUTSIDE = [74.0, 20.0];
const INLAND = [28.5, -81.4];

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = spawnSync(PYTHON, ['-B', path.join(import.meta.dirname, 'qa_seagrass_truth.py'), CACHE], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'inherit'] });
if (probe.status !== 0) {
  report('truth', false, { error: `qa_seagrass_truth.py exit ${probe.status}` });
  process.exit(1);
}
const TRUTH = JSON.parse(probe.stdout);
const kinds = ['highest', 'middle', 'near-30', 'exact-half', 'faint', 'clear'];
report('truth', TRUTH.members['2019_2020'] === 299 && TRUTH.members['2023_2024'] === 301 && TRUTH.points.length === 36 && kinds.every((k) => TRUTH.points.filter((p) => p.kind === k).length === 6),
  { members: TRUTH.members, points: TRUTH.points.length });

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
const tiles = { ok: 0, bad: [], urls: new Set() };
let manifest = null;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /seagrass|Data|what-lives-here/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('response', async (r) => {
    if (/\/data\/seagrass\.json(\?|$)/.test(r.url())) manifest = await r.json().catch(() => null);
    if (!/\/data\/seagrass\/\d{4}_\d{4}\/\d+\//.test(r.url())) return;
    tiles.urls.add(r.url());
    // 304: the browser revalidated a tile it already had; a 200 that is not a PNG is a server's HTML fallback for a
    // missing file (Vite's dev server answers so), which a status check alone reads as a good tile
    const png = r.status() === 304 || /^image\/png/.test(r.headers()['content-type'] ?? '');
    if ((r.status() === 200 || r.status() === 304) && png) tiles.ok += 1;
    else tiles.bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // The globe's centre, rendered and read back in one task: kept as the baseline, or the share of pixels that moved
  // by more than 60 (summed over RGB) from it.
  const centreChange = (keep) => page.evaluate(async (keep) => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < 90 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
    v.scene.render();
    const src = v.scene.canvas;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.drawImage(src, src.width / 2 - 100, src.height / 2 - 100, 200, 200, 0, 0, 200, 200);
    const d = g.getImageData(0, 0, 200, 200).data;
    if (keep) { window.__qaSeagrassBase = d; return 0; }
    const b = window.__qaSeagrassBase;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - b[i]) + Math.abs(d[i + 1] - b[i + 1]) + Math.abs(d[i + 2] - b[i + 2]) > 60) n += 1;
    return n / (d.length / 4);
  }, keep);
  const settle = async () => {
    let last = -1, still = 0;
    for (let i = 0; i < 180 && still < 8; i += 1) {
      await sleep(500);
      const n = tiles.ok + tiles.bad.length;
      still = n > 0 && n === last ? still + 1 : 0;
      last = n;
    }
  };
  const stats = () => page.evaluate((id) => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats ?? null, ID);
  const epochsOf = (urls) => [...new Set(urls.map((u) => /\/seagrass\/(\d{4}_\d{4})\//.exec(u)[1]))];

  // over Florida Bay's all-seagrass cell, 40 km up
  const full = TRUTH.points.find((p) => p.kind === 'highest' && p.region.startsWith('Florida'));
  await page.evaluate(([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 40000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, [full.lat, full.lon]);
  await centreChange(true);
  // Another drape first: switching seagrass on must switch it off (one drape at a time).
  const state = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled('surface-water', true, { origin: 'user' });
    const otherOn = dataManager.isEnabled('surface-water');
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), otherOn, otherAfter: dataManager.isEnabled('surface-water') };
  }, ID);
  await settle();
  const changed = await centreChange(false);
  const s1 = await stats();
  report('drew-latest', state.on && changed > 0.2 && !s1?.error && s1?.time === LABEL['2023_2024'] && s1?.count === 1 && tiles.ok > 0 && tiles.bad.length === 0
    && epochsOf([...tiles.urls]).join() === '2023_2024',
  { changed: changed.toFixed(4), stats: s1, tiles200: tiles.ok, tilesBad: tiles.bad.slice(0, 3), epochs: epochsOf([...tiles.urls]) });
  report('one-drape-at-a-time', state.otherOn === true && state.otherAfter === false, { surfaceWaterBefore: state.otherOn, surfaceWaterAfter: state.otherAfter });

  const byKey = Object.fromEntries((manifest?.epochs ?? []).map((e) => [e.key, e]));
  report('manifest-matches-the-release', Object.keys(byKey).join() === '2019_2020,2023_2024' && manifest?.maxLevel === 9
    && Object.entries(TRUTH.members).every(([k, n]) => byKey[k]?.members === n && byKey[k]?.label === LABEL[k]),
  { epochs: manifest?.epochs?.map((e) => ({ key: e.key, label: e.label, members: e.members, seagrassKm2: e.seagrassKm2 })), files: TRUTH.members, maxLevel: manifest?.maxLevel });

  const listedOf = (k) => new Set(Object.entries(byKey[k]?.tiles ?? {}).flatMap(([z, l]) => l.map(([x, y]) => `${z}/${x}/${y}`)));
  const unlistedIn = (urls) => urls.map((u) => /\/seagrass\/(\d{4}_\d{4})\/(\d+\/\d+\/\d+)\.png/.exec(u)).filter((m) => !listedOf(m[1]).has(m[2])).map((m) => m[0]);

  const readAll = (points) => page.evaluate(async (id, pts) => {
    const out = [];
    for (const [lat, lon] of pts) out.push((await window.__godsEyeView.readoutAt(lat, lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, points);
  const row = (r) => r && `${r.status}:${r.text ?? r.error} · ${r.date}`;
  const want = (p, k) => (p.share[k] ? shareText(p.share[k]) : NONE_TEXT);
  const checkCells = async (k) => {
    const got = await readAll(TRUTH.points.map((p) => [p.lat, p.lon]));
    for (const kind of kinds) {
      const idx = TRUTH.points.map((p, i) => (p.kind === kind ? i : -1)).filter((i) => i >= 0);
      const ok = idx.every((i) => got[i]?.status === 'class' && got[i].date === LABEL[k] && got[i].text === want(TRUTH.points[i], k));
      report(`${kind}-cells-${k}`, ok, { got: idx.map((i) => `${TRUTH.points[i].region} ${TRUTH.points[i].grass[k]}/${TRUTH.points[i].total} → ${want(TRUTH.points[i], k)}: ${row(got[i])}`) });
    }
  };
  await checkCells('2023_2024');
  const [outside, inland] = await readAll([OUTSIDE, INLAND]);
  report('outside-and-inland', outside?.status === 'outside' && inland?.status === 'class' && inland.text === NONE_TEXT && inland.date === LABEL['2023_2024'],
    { outside: row(outside), inland: row(inland) });

  // legend: the five share bins, then the note with the shown epoch's mapped area and the caveat on comparing epochs
  const legendNote = () => page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getRowControls().legend, ID);
  const legend = await legendNote();
  const km2 = (k) => Math.round(byKey[k]?.seagrassKm2 ?? -1).toLocaleString('en-US');
  report('legend', legend.length === 6 && legend.slice(0, 5).every((l) => / seagrass$/.test(l.label)) && legend.at(-1).label.includes(`${km2('2023_2024')} km² mapped in 2023–2024`)
    && legend.at(-1).label.includes('not on its own a change'), { legend: legend.map((l) => l.label) });

  // The time bar: it reaches back to 2019, and a date in 2021 draws the 2019–2020 epoch and reads its cells.
  const domainStart = await page.evaluate(() => window.__godsEyeView.observedTime.domain()?.start ?? null);
  report('time-bar-reaches-2019', domainStart !== null && domainStart <= Date.UTC(2019, 0, 1), { domainStart: domainStart && new Date(domainStart).toISOString() });
  const seen = new Set(tiles.urls);
  await page.evaluate(() => window.__godsEyeView.observedTime.set('2021-06-01T00:00:00Z'));
  await settle();
  const s2 = await stats();
  const fresh = [...tiles.urls].filter((u) => !seen.has(u));
  const changedThen = await centreChange(false);
  report('time-bar-steps-to-2019-2020', s2?.time === LABEL['2019_2020'] && !s2?.error && fresh.length > 0 && epochsOf(fresh).join() === '2019_2020',
    { stats: s2, newTiles: fresh.length, newEpochs: epochsOf(fresh), changed: changedThen.toFixed(4) });
  await checkCells('2019_2020');
  const legendThen = await legendNote();
  report('legend-follows-the-epoch', legendThen.at(-1).label.includes(`${km2('2019_2020')} km² mapped in 2019–2020`), { note: legendThen.at(-1).label });
  // the two epochs are read from their own tiles: the truth's cells differ between them, and so must the readouts
  const differ = TRUTH.points.filter((p) => p.share['2019_2020'] !== p.share['2023_2024']).length;
  report('epochs-differ-where-the-truth-does', differ >= 6, { cellsThatDiffer: differ, of: TRUTH.points.length });

  // The bar's span is the layers' own: a probe extent lets it reach a date before the first epoch.
  const at2018 = await page.evaluate(async (id) => {
    const t = window.__godsEyeView.observedTime;
    t.setLayerExtent('qa-probe', { startMs: Date.parse('2000-01-01T00:00:00Z'), endMs: Date.parse('2026-01-01T00:00:00Z') });
    t.set('2018-06-01T00:00:00Z');
    const s = () => window.__godsEyeView.dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 40 && s()?.time !== null; i += 1) await new Promise((r) => setTimeout(r, 250));
    return t.get();
  }, ID);
  const s3 = { ...(await stats()), at: at2018 };
  const [gap] = await readAll([[full.lat, full.lon]]);
  const shownBefore = await page.evaluate(() => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    const ours = [];
    for (let i = 0; i < layers.length; i += 1) if (/data\/seagrass\//.test(String(layers.get(i).imageryProvider?.url ?? ''))) ours.push(layers.get(i).show);
    return ours;
  });
  report('nothing-before-2019', s3.at?.startsWith('2018-06-01') && gap?.status === 'gap' && s3?.time === null && /no seagrass mapped before 2019/.test(s3?.error ?? '') && shownBefore.every((s) => s === false),
    { readout: row(gap), stats: s3, drapeShown: shownBefore });
  await page.evaluate(() => {
    window.__godsEyeView.observedTime.set(null);
    window.__godsEyeView.observedTime.setLayerExtent('qa-probe', null);
  });

  const all = [...tiles.urls];
  const unlisted = unlistedIn(all);
  report('only-listed-tiles-requested', Object.entries(LISTED).every(([k, n]) => listedOf(k).size === n) && all.length > 0 && unlisted.length === 0,
    { listed: Object.fromEntries(Object.keys(LISTED).map((k) => [k, listedOf(k).size])), requested: all.length, unlisted: unlisted.slice(0, 5) });

  // Every pixel of the real level-9 tiles the readouts used, decoded from the file's bytes by the site's own table.
  const urls = all.filter((u) => /\/seagrass\/\d{4}_\d{4}\/9\/\d+\/\d+\.png/.test(u));
  const counts = { share: 0, none: 0 };
  const shares = new Set();
  const unknown = {};
  for (const u of urls) {
    const res = await fetch(u);
    if (!res.ok) { unknown[`HTTP ${res.status} ${u}`] = 1; continue; }
    const { data } = await decodePng(new Uint8Array(await res.arrayBuffer()));
    for (let i = 0; i < data.length; i += 4) {
      const px = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const v = manifest ? decodeShare(px, manifest) : { kind: 'unknown' };
      if (v.kind in counts) counts[v.kind] += 1;
      else unknown[px.join(',')] = (unknown[px.join(',')] || 0) + 1;
      if (v.kind === 'share') shares.add(v.share);
    }
  }
  report('every-pixel-decodes', !!manifest && urls.length >= 10 && epochsOf(urls).length === 2 && counts.none > 0 && [1, 50, 100].every((s) => shares.has(s)) && shares.size > 50 && Object.keys(unknown).length === 0,
    { level9Tiles: urls.length, epochs: epochsOf(urls), ...counts, distinctShares: shares.size, unknown: Object.fromEntries(Object.entries(unknown).slice(0, 5)) });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-404-or-console-errors', tiles.bad.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0,
  { tilesBad: tiles.bad.slice(0, 5), consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed, tiles200: tiles.ok, tilesBad: tiles.bad.length }));
process.exit(failed ? 1 : 0);
