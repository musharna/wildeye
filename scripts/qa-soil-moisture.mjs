#!/usr/bin/env node
/**
 * qa-soil-moisture.mjs — real-browser acceptance for the soil moisture anomaly drape (rasters.json product
 * `soil-moisture`). Run: node scripts/qa-soil-moisture.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Two halves: (1) the live source still says what rasters.json pins (CC BY 4.0, the v3.0.1 directory, a recent file);
 * (2) the site's manifest and image are that product, the drape draws, and the click readout at one point per class
 * on the shown dekad, plus the sea, names the class GDO's own map shows there. GDO's map server cannot give numbers
 * and its drawn map resamples (docs/analysis/soil_moisture_vs_gdo_wms.md), so a point is used only where GDO's map
 * shows one class over the 5 x 5 native cells around it.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { decodePng } from '../src/data/pngDecode.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ID = 'soil-moisture';
const TOKEN = 'sm';
const pinned = JSON.parse(readFileSync(new URL('../pipeline/rasters.json', import.meta.url), 'utf8')).find((p) => p.id === ID);
const LABELS = pinned.classes.map((c) => c.label);
// GDO's smang colours as its WMS draws them, driest first (docs/analysis/soil_moisture_vs_gdo_wms.md)
const WMS_RGB = [[179, 88, 6], [241, 163, 64], [254, 224, 182], [255, 255, 255], [209, 229, 240], [103, 169, 207], [33, 102, 172]];
const wmsUrl = (s, w, n, e, size, day) => 'https://drought.emergency.copernicus.eu/gis/mswms.png?map=gdo_w_mf&LAYERS=smang'
  + '&ind_version=ca91ceac52de203d9b60be0704d3a9bd&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png'
  + `&TRANSPARENT=true&STYLES=&CRS=EPSG:4326&BBOX=${s},${w},${n},${e}&WIDTH=${size}&HEIGHT=${size}`
  + `&TIME=${day}&SELECTED_YEAR=${day.slice(0, 4)}&SELECTED_MONTH=${day.slice(5, 7)}&SELECTED_TENDAYS=${day.slice(8, 10)}`;

// GDO's map server sends a box of few colours as a 1-, 2- or 4-bit palette PNG (probe 2026-10-25), which the site's
// decoder rightly refuses (its sources are 8-bit); this reads only that: palette, non-interlaced, any bit depth, as RGBA
const decodePalettePng = (bytes) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, width = 0, height = 0, depth = 0, plte = null, trns = null;
  const idat = [];
  while (pos < bytes.length) {
    const len = v.getUint32(pos), kind = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)), data = bytes.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      [width, height, depth] = [v.getUint32(pos + 8), v.getUint32(pos + 12), data[8]];
      if (data[9] !== 3 || data[12] !== 0) throw new Error(`GDO PNG colour type ${data[9]}, interlace ${data[12]}: expected a non-interlaced palette PNG`);
    } else if (kind === 'PLTE') plte = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = Math.ceil((width * depth) / 8);
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) { // unfilter with 1 byte per pixel (palette PNGs below 8 bits round up to 1)
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i ? out[i - 1] : 0, b = up[i], c = i ? up[i - 1] : 0, p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[i] = (src[i] + [0, a, b, (a + b) >> 1, pr][f]) & 255;
      if (f > 4) throw new Error(`PNG filter ${f}`);
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const bit = x * depth, k = (rows[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    data.set([plte[3 * k], plte[3 * k + 1], plte[3 * k + 2], trns && k < trns.length ? trns[k] : 255], (y * width + x) * 4);
  }
  return { width, height, data };
};

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r;
};
const json = async (url) => (await get(url)).json();

// (1) the live source
const copyright = await (await get(`${pinned.catalog}copyright.txt`)).text();
report('source:licence', /Creative Commons Attribution 4\.0 International \(CC BY 4\.0\)/.test(copyright), { copyright: copyright.slice(0, 120) });
const listing = await (await get(pinned.catalog)).text();
const files = [...new Set(listing.match(new RegExp(pinned.file_regex, 'g')) ?? [])].sort();
const newest = files.at(-1) ?? '';
const last = newest.match(/_(\d{4})(\d{2})(\d{2})_t\.nc$/);
const lastDay = last ? Date.UTC(+last[1], +last[2] - 1, +last[3]) : NaN;
report('source:recent', /\/ver3-0-1\/$/.test(pinned.catalog) && Date.now() - lastDay < 35 * 86400e3, { newest });

// (2) the site's manifest and image
const manifest = await json(`${SITE}data/rasters.json?t=${Date.now()}`);
const entry = manifest.products.find((p) => p.id === ID);
report('manifest', Boolean(entry) && entry.kind === 'classes' && JSON.stringify(entry.classes) === JSON.stringify(pinned.classes)
  && entry.width === 1440 && entry.height === 600 && entry.history?.length > 1,
  { time: entry?.time, size: entry && `${entry.width}x${entry.height}`, frames: entry?.history?.length });
const png = await fetch(`${SITE}${entry.png}?t=${Date.now()}`);
const img = await decodePng(new Uint8Array(await png.arrayBuffer()));
report('image', png.ok && img.width === entry.width && img.height === entry.height, { status: png.status, size: `${img.width}x${img.height}` });

// a drape cell's class from its colour: the hidden near-normal class keeps its colour at alpha 0, no data is 0,0,0,0
const b = entry.bounds;
const day = entry.time.slice(0, 10);
const classAt = (px, py) => {
  const i = (py * img.width + px) * 4;
  const d = img.data;
  const k = pinned.classes.findIndex((c) => c.rgb[0] === d[i] && c.rgb[1] === d[i + 1] && c.rgb[2] === d[i + 2]);
  if (d[i + 3] === 0 && k < 0) return 'nodata';
  return k;
};
const centre = (px, py) => ({ lat: +(b.north - (py + 0.5) * (b.north - b.south) / img.height).toFixed(3), lon: +(b.west + (px + 0.5) * (b.east - b.west) / img.width).toFixed(3) });
// candidates per class: drape cells whose 8 neighbours share the class, every 7th found so they spread out
const candidates = new Map();
for (let py = 1; py < img.height - 1; py += 1) for (let px = 1; px < img.width - 1; px += 1) {
  const k = classAt(px, py);
  let same = true;
  for (let dy = -1; dy <= 1 && same; dy += 1) for (let dx = -1; dx <= 1 && same; dx += 1) same = classAt(px + dx, py + dy) === k;
  if (!same) continue;
  const list = candidates.get(k) ?? [];
  if (list.length < 40) list.push(centre(px, py));
  candidates.set(k, list);
}
// GDO's own class at each candidate: its map at the native 0.05° over the 5 x 5 cells around the drape cell, used only
// when all 25 are one class; transparent is no data
const gdoClass = async ({ lat, lon }) => {
  const h = 0.125;
  const r = await get(wmsUrl(lat - h, lon - h, lat + h, lon + h, 5, day));
  const g = decodePalettePng(new Uint8Array(await r.arrayBuffer()));
  const seen = new Set();
  for (let i = 0; i < g.width * g.height * 4; i += 4) {
    const d = g.data;
    seen.add(d[i + 3] === 0 ? 'nodata' : WMS_RGB.findIndex((c) => c[0] === d[i] && c[1] === d[i + 1] && c[2] === d[i + 2]));
  }
  return seen.size === 1 ? [...seen][0] : null;
};
const KNOWN = [];
const unsettled = [];
for (const k of ['nodata', ...LABELS.keys()]) {
  const list = (candidates.get(k) ?? []).filter((_, i) => i % 7 === 0).slice(0, 5);
  let point = null;
  for (const at of list) {
    const want = await gdoClass(at);
    if (want !== null) { point = { ...at, want: want === 'nodata' ? 'nodata' : LABELS[want], drape: k === 'nodata' ? 'nodata' : LABELS[k] }; break; }
  }
  if (point) KNOWN.push(point); else unsettled.push(k === 'nodata' ? 'nodata' : LABELS[k]);
}
report('known-points', KNOWN.length >= 6 && KNOWN.some((k) => k.want === 'nodata'),
  { points: KNOWN.map((k) => `${k.want} ${k.lat},${k.lon}`), noUniformGdoBox: unsettled });

// the browser
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
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /soil|Data:/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  const state = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const s = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 60 && !s()?.lastUpdate; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: s() };
  }, ID);
  report('loaded', state.on && !state.stats?.error && state.stats?.time === entry.time, { stats: state.stats });

  const read = await page.evaluate(async (id, points) => {
    const out = [];
    for (const p of points) out.push((await window.__godsEyeView.readoutAt(p.lat, p.lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, KNOWN);
  for (const [i, k] of KNOWN.entries()) {
    const r = read[i];
    const ok = k.want === 'nodata' ? r?.status === 'nodata' : r?.status === 'value' && r.text === k.want;
    report(`readout ${k.want}`, ok && (k.want === 'nodata' || r.date === day), { lat: k.lat, lon: k.lon, drape: k.drape, got: r && `${r.status}:${r.text ?? r.error ?? ''} · ${r.date}` });
  }

  const hooks = await page.evaluate((id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    return ['setObservedTime', 'getObservedExtent'].filter((k) => typeof mod?.[k] === 'function');
  }, ID);
  report('on-the-time-bar', hooks.length === 2, { hooks });

  const text = await page.evaluate(() => document.body.textContent);
  const want = {
    legend: LABELS.filter((l, k) => !pinned.classes[k].hidden).every((l) => text.includes(l)) && text.includes('1995–2024 mean'),
    credit: text.includes('contains modified Copernicus Emergency Management Service information 2026') && text.includes('doi:10.2905/JRC.NXWJPVG'),
  };
  report('legend-and-credit', Object.values(want).every(Boolean), want);
  const tokenRe = new RegExp(`[#&]l=([^&]*\\.)?${TOKEN}(\\.|&|$)`);
  const share = await page.waitForFunction((src) => new RegExp(src).test(decodeURIComponent(location.hash)) && location.href, { timeout: 15000 }, tokenRe.source)
    .then((h) => h.jsonValue(), () => page.evaluate(() => location.href));
  report('share-token', tokenRe.test(decodeURIComponent(share)), { url: share.slice(0, 220) });
  // drawn: centred on the 5° block with the most shown cells, the globe changes there when the drape is turned off
  let dense = null;
  for (let by = 0; by < img.height; by += 20) for (let bx = 0; bx < img.width; bx += 20) {
    let n = 0;
    for (let y = by; y < by + 20; y += 1) for (let x = bx; x < bx + 20; x += 1) if (img.data[(y * img.width + x) * 4 + 3] > 0) n += 1;
    if (!dense || n > dense.n) dense = { n, ...centre(bx + 10, by + 10) };
  }
  // real screenshots of the middle of the page (a WebGL canvas read back through a 2D canvas comes back unchanged)
  const grab = async () => decodePng(new Uint8Array(await page.screenshot({ type: 'png', clip: { x: 600, y: 350, width: 200, height: 200 } })));
  await page.evaluate(async ([lat, lon]) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, 2000000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    // tilesLoaded keeps the old view's value until the scene has drawn the new one: the first local run read it at once
    // and screenshot a blank page with the drape on and off alike (4 pixels changed); wait for drawn frames first
    for (let n = 0; n < 2; n += 1) await new Promise((r) => { const off = v.scene.postRender.addEventListener(() => { off(); r(); }); v.scene.requestRender(); });
    for (let i = 0; i < 120 && !v.scene.globe.tilesLoaded; i += 1) await new Promise((r) => setTimeout(r, 500));
  }, [dense.lat, dense.lon]);
  const on = (await grab()).data;
  const onColours = new Set();
  for (let i = 0; i < on.length; i += 4) onColours.add((on[i] << 16) | (on[i + 1] << 8) | on[i + 2]);
  await page.evaluate(async (id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), ID);
  await page.waitForFunction(() => {
    const il = window.__godsEyeView.viewer.imageryLayers;
    for (let i = 0; i < il.length; i += 1) if (/data\/rasters\/soil-moisture/.test(String(il.get(i).imageryProvider?.url ?? '')) && il.get(i).show) return false;
    return true;
  }, { timeout: 30000 });
  await page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    for (let n = 0; n < 2; n += 1) await new Promise((r) => { const off = v.scene.postRender.addEventListener(() => { off(); r(); }); v.scene.requestRender(); });
  });
  const off = (await grab()).data;
  let changed = 0;
  for (let i = 0; i < on.length; i += 4) if (Math.hypot(on[i] - off[i], on[i + 1] - off[i + 1], on[i + 2] - off[i + 2]) > 30) changed += 1;
  // a blank 'on' screenshot (one colour) would make 'off' meaningless, so it is reported and must not pass
  report('drawn', dense.n > 100 && onColours.size > 20 && changed > 4000, { at: `${dense.lat},${dense.lon}`, shownCellsInBlock: dense.n, coloursWhenOn: onColours.size, pixelsChangedWhenOff: changed });
} catch (e) {
  report('run', false, { error: String(e?.stack || e?.message || e).slice(0, 400) });
} finally {
  await browser.close();
}
report('no-page-or-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
