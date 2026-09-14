#!/usr/bin/env node
/**
 * species-legend-probe.mjs — capture the species map (monarch) as the globe draws it, for the legend colours in SPECIES_MAP_LEGEND
 * (src/bio/gbif.js) and the tile checks behind the spec's Implementation notes. Real browser, real GBIF tiles.
 *
 * Run against a preview build:
 *   bash scripts/build-static-preview.sh
 *   npx vite preview --base /wildeye/ --outDir .qa-static --port 4488 --strictPort     (in another shell or a systemd unit)
 *   node scripts/species-legend-probe.mjs --view global --out /tmp/legend/run1 [--years recent|all] [--settle 60000] [--url http://localhost:4488/wildeye/]
 *   python3 scripts/species-legend-colours.py /tmp/legend/run1 global '' centre > /tmp/legend/run1.json
 *   python3 scripts/species-legend-fit.py /tmp/legend/run1 [/tmp/legend/run2 ...]
 * python3 must have numpy and Pillow (/usr/bin/python3 may not; miniconda's does). The third argument of species-legend-colours.py is the
 * swatches JSON to compare against ('' for none), the fourth the sampling mode.
 * The legend colours were measured with --view global (camera straight down over lon -90, lat 30 at 12,000 km, 1400x900, Esri World
 * Imagery basemap), 2026-09-14: the three lowest classes with --years recent (three runs, colours mode centre), the two highest with
 * --years all (two runs, colours mode single, species-legend-fit.py --mode single).
 */
// One page session per run, on the build's own species layer (monarch via the data manager):
//   1. camera to the view, wait until the globe reports tiles loaded with no GBIF request pending, then settle --settle ms more;
//   2. canvas frames: on / off (species hidden) over the basemap, blackon / blackoff over a black globe, plus the page screenshot;
//   3. every GBIF tile URL's HTTP status, and every drawn species imagery tile: level, x, y, stand-in state, and its screen quad;
//   4. fetch each drawn (ready, not stand-in) tile's MVT with the layer's filters; each cell -> centre lon/lat, total, style class; the page
//      projects every cell centre to canvas pixels (same camera) with screen px per tile px, and whether it faces the camera;
//   5. --points "x,y;x,y": for each canvas point, its lon/lat, the drawn imagery tile covering it with its state and URL status.
// Usage: node scripts/species-legend-probe.mjs --view global|midwest|phone --out <dir> [--years recent|all] [--settle 60000] [--points "1150,780;1300,850"]
import puppeteer from 'puppeteer';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'http://localhost:4488/wildeye/');
const VIEW = arg('--view', 'global');
const OUT = arg('--out', null);
const SETTLE = Number(arg('--settle', '60000'));
// The species layer's years: 'recent' (the last 10 years, the app's default) or 'all'. The two highest classes appear only in 'all' at the global view.
const YEARS = arg('--years', 'recent');
if (!['recent', 'all'].includes(YEARS)) throw new Error(`--years must be recent or all, got ${YEARS}`);
const POINTS = (arg('--points', '') || '').split(';').filter(Boolean).map((p) => p.split(',').map(Number));
if (!OUT) throw new Error('--out is required');
mkdirSync(OUT, { recursive: true });
const CAMERAS = {
  global: { lon: -90, lat: 30, height: 12_000_000, viewport: [1400, 900], panel: false },
  midwest: { lon: -91.5, lat: 43.5, height: 1_700_000, viewport: [1400, 900], panel: false },
  phone: { lon: -90, lat: 30, height: 12_000_000, viewport: [400, 800], panel: true },
};
const cam = CAMERAS[VIEW];
if (!cam) throw new Error(`unknown view ${VIEW}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GBIF tile fetches from this script: one at a time, at least 600 ms apart; any status but 200 or 204 is an error.
let lastFetch = 0;
async function fetchTile(url) {
  const wait = lastFetch + 600 - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200 && res.status !== 204) throw new Error(`HTTP ${res.status} for ${url}`);
  return { status: res.status, buf: res.status === 200 ? buf : Buffer.alloc(0) };
}
const log = (o) => { const line = JSON.stringify(o); console.log(line.slice(0, 400)); return o; };

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: cam.viewport[0], height: cam.viewport[1] } });
const page = await browser.newPage();
const statusByUrl = new Map();
const pending = new Set();
page.on('request', (r) => { if (r.url().includes('/v2/map/occurrence/')) pending.add(r.url()); });
page.on('requestfailed', (r) => { if (pending.delete(r.url())) statusByUrl.set(r.url(), `failed ${r.failure()?.errorText}`); });
page.on('response', (r) => { if (r.url().includes('/v2/map/occurrence/')) { pending.delete(r.url()); statusByUrl.set(r.url(), r.status()); } });
page.on('pageerror', (e) => log({ pageerror: String(e?.message || e).slice(0, 200) }));
await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
await sleep(12000);
await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
await page.keyboard.press('Escape');
await sleep(1500);
const basemap = await page.evaluate(() => String(window.__godsEyeView.viewer.imageryLayers.get(0)?.imageryProvider?.url ?? ''));
if (!/arcgisonline\.com/.test(basemap)) {
  await page.evaluate(() => window.__godsEyeView.mapStackController.setStack('esri-imagery', { silent: true }));
  await sleep(4000);
}
await page.evaluate((open) => {
  const panel = document.getElementById('species-panel');
  if (panel.classList.contains('collapsed') === open) panel.querySelector('[data-collapse-target="species-panel"]').click();
}, cam.panel);
await page.evaluate(async (years) => {
  const dm = window.__godsEyeView.dataManager;
  if (!dm.setLayerParams('species', { taxonKey: 5133088, name: 'Monarch', years }, { origin: 'user' })) throw new Error('species params rejected');
  await dm.setEnabled('species', true, { origin: 'user' });
}, YEARS);
await page.evaluate(({ lon, lat, height }) => {
  const viewer = window.__godsEyeView.viewer;
  viewer.camera.setView({ destination: viewer.camera.position.constructor.fromDegrees(lon, lat, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
}, cam);
const t0 = Date.now();
let stable = 0;
while (Date.now() - t0 < 120000) {
  const loaded = await page.evaluate(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded);
  stable = loaded && pending.size === 0 ? stable + 1 : 0;
  if (stable >= 6) break;
  await sleep(500);
}
const loadedAfterMs = Date.now() - t0;
await sleep(SETTLE);
const stillPending = pending.size;
const esri = await page.evaluate(() => /arcgisonline\.com/.test(String(window.__godsEyeView.viewer.imageryLayers.get(0)?.imageryProvider?.url ?? '')));

const speciesLayerIndex = () => page.evaluate(() => { const l = window.__godsEyeView.viewer.imageryLayers; for (let i = 0; i < l.length; i += 1) if (String(l.get(i).imageryProvider?.url ?? '').includes('/v2/map/occurrence/')) return i; return -1; });
const setShown = (shown) => page.evaluate((shown) => { const v = window.__godsEyeView.viewer; const l = v.imageryLayers; for (let i = 0; i < l.length; i += 1) if (String(l.get(i).imageryProvider?.url ?? '').includes('/v2/map/occurrence/')) l.get(i).show = shown; v.scene.requestRender(); }, shown);
const setBasemap = (shown) => page.evaluate((shown) => { const v = window.__godsEyeView.viewer; const g = v.scene.globe; if (!window.__r8Base) window.__r8Base = g.baseColor; g.baseColor = shown ? window.__r8Base : new window.__r8Base.constructor(0, 0, 0, 1); v.imageryLayers.get(0).show = shown; v.scene.requestRender(); }, shown);
const grab = async (name) => {
  const data = await page.evaluate(async () => { const s = window.__godsEyeView.viewer.scene; const frame = () => new Promise((r) => { const rm = s.postRender.addEventListener(() => { rm(); r(); }); s.requestRender(); }); await frame(); await frame(); return s.canvas.toDataURL('image/png'); });
  writeFileSync(`${OUT}/${VIEW}__${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
};
const drawnTiles = () => page.evaluate(() => {
  const viewer = window.__godsEyeView.viewer; const scene = viewer.scene; const C3 = viewer.camera.position.constructor;
  const layers = viewer.imageryLayers; let species = null;
  for (let i = 0; i < layers.length; i += 1) if (String(layers.get(i).imageryProvider?.url ?? '').includes('/v2/map/occurrence/')) species = layers.get(i);
  const out = [];
  for (const tile of scene.globe._surface?._tilesToRender ?? []) {
    for (const ti of tile.data?.imagery ?? []) {
      const ready = ti.readyImagery ?? null; const loading = ti.loadingImagery ?? null;
      if ((ready ?? loading)?.imageryLayer !== species) continue;
      const r = tile.rectangle;
      const corners = [[r.west, r.north], [r.east, r.north], [r.east, r.south], [r.west, r.south]].map(([lo, la]) => { const p = scene.cartesianToCanvasCoordinates(C3.fromRadians(lo, la)); return p ? [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10] : null; });
      out.push({ terrain: `${tile.level}/${tile.x}/${tile.y}`, terrainRect: [r.west, r.south, r.east, r.north].map((v) => (v * 180) / Math.PI), terrainQuad: corners, ready: ready ? { level: ready.level, x: ready.x, y: ready.y, state: ready.state } : null, loading: loading ? { level: loading.level, x: loading.x, y: loading.y, state: loading.state } : null });
    }
  }
  return { url: species?.imageryProvider?.url ?? null, tileWidth: species?.imageryProvider?.tileWidth ?? null, tiles: out };
});

await setShown(true); await grab('on'); await page.screenshot({ path: `${OUT}/${VIEW}__page.png` });
const drawn = await drawnTiles();
await setShown(false); await sleep(1200); await grab('off');
await setBasemap(false); await sleep(1200); await grab('blackoff');
await setShown(true); await sleep(1200); await grab('blackon');
await setBasemap(true); await sleep(1200);
const template = drawn.url;
const urlFor = (z, x, y) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
const tileStatus = (z, x, y) => statusByUrl.get(urlFor(z, x, y)) ?? 'not requested';
for (const t of drawn.tiles) {
  if (t.ready) t.ready.http = tileStatus(t.ready.level, t.ready.x, t.ready.y);
  if (t.loading) t.loading.http = tileStatus(t.loading.level, t.loading.x, t.loading.y);
}

// 4. cells of the drawn ready (not stand-in) tiles, classified by the pinned style's upper bounds
const BOUNDS = [10, 100, 1000, 10000, Infinity];
const readyKeys = [...new Set(drawn.tiles.filter((t) => t.ready && !t.loading).map((t) => `${t.ready.level}/${t.ready.x}/${t.ready.y}`))];
const cells = [];
for (const key of readyKeys) {
  const [z, x, y] = key.split('/').map(Number);
  const mvt = urlFor(z, x, y).replace('@1x.png', '.mvt').replace(/style=[^&]*&?/, '');
  const got = await fetchTile(mvt);
  if (got.status !== 200 || !got.buf.length) continue;
  const layer = new VectorTile(new Pbf(got.buf)).layers.occurrence;
  for (let i = 0; i < (layer?.length ?? 0); i += 1) {
    const f = layer.feature(i);
    const pts = f.loadGeometry().flat();
    const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2 / layer.extent; const cy = (Math.min(...ys) + Math.max(...ys)) / 2 / layer.extent;
    if (cx < 0 || cx >= 1 || cy < 0 || cy >= 1) continue; // buffer cells belong to the neighbouring tile
    const n = 2 ** z;
    const lon = ((x + cx) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + cy)) / n))) * 180) / Math.PI;
    cells.push({ tile: key, lon, lat, total: f.properties.total, cls: BOUNDS.findIndex((b) => f.properties.total <= b) });
  }
}
const projected = await page.evaluate((cells, drawnTiles) => {
  const viewer = window.__godsEyeView.viewer; const scene = viewer.scene; const C3 = viewer.camera.position.constructor;
  const cam = viewer.camera.positionWC;
  return cells.map((c) => {
    const p = C3.fromDegrees(c.lon, c.lat); const q = scene.cartesianToCanvasCoordinates(p);
    const facing = ((cam.x - p.x) * p.x + (cam.y - p.y) * p.y + (cam.z - p.z) * p.z) > 0;
    // screen px per tile px here: project one tile pixel east of the centre
    const [z] = c.tile.split('/').map(Number); const degPerTilePx = 360 / (2 ** z) / 512;
    const e = scene.cartesianToCanvasCoordinates(C3.fromDegrees(c.lon + degPerTilePx, c.lat));
    const sc = q && e ? Math.hypot(e.x - q.x, e.y - q.y) : null;
    return { ...c, x: q ? q.x : null, y: q ? q.y : null, facing, screenPxPerTilePx: sc };
  });
}, cells, drawn.tiles);
writeFileSync(`${OUT}/${VIEW}__cells.json`, JSON.stringify(projected));

// 5. canvas points: lon/lat and the covering drawn tile
const points = [];
for (const [px, py] of POINTS) {
  const info = await page.evaluate(([px, py]) => {
    const viewer = window.__godsEyeView.viewer; const Cartographic = viewer.camera.positionCartographic.constructor;
    const c = viewer.camera.pickEllipsoid({ x: px, y: py }, viewer.scene.globe.ellipsoid);
    if (!c) return null;
    const g = Cartographic.fromCartesian(c);
    return { lon: (g.longitude * 180) / Math.PI, lat: (g.latitude * 180) / Math.PI };
  }, [px, py]);
  const covering = info ? drawn.tiles.filter((t) => info.lon >= t.terrainRect[0] && info.lon <= t.terrainRect[2] && info.lat >= t.terrainRect[1] && info.lat <= t.terrainRect[3]) : [];
  points.push({ canvas: [px, py], ...info, covering });
}
const levels = {};
for (const t of drawn.tiles) { const k = `ready z${t.ready?.level ?? '-'}${t.loading ? ` loading z${t.loading.level} state ${t.loading.state}` : ''}`; levels[k] = (levels[k] || 0) + 1; }
const httpCounts = {}; for (const s of statusByUrl.values()) httpCounts[s] = (httpCounts[s] || 0) + 1;
const record = { view: VIEW, years: YEARS, camera: cam, settleMs: SETTLE, loadedAfterMs, stillPendingAfterSettle: stillPending, esri, template, tileWidth: drawn.tileWidth, levels, httpCounts, drawnTiles: drawn.tiles, cells: projected.length, points };
writeFileSync(`${OUT}/${VIEW}__probe.json`, JSON.stringify(record, null, 1));
log({ view: VIEW, years: YEARS, loadedAfterMs, stillPending, esri, levels, httpCounts, cells: projected.length, points: points.map((p) => ({ canvas: p.canvas, lon: p.lon, lat: p.lat, covering: p.covering.map((t) => ({ terrain: t.terrain, ready: t.ready, loading: t.loading })) })) });
await browser.close();
