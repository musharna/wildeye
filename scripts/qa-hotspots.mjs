#!/usr/bin/env node
/**
 * qa-hotspots.mjs — real-browser acceptance for the biodiversity hotspots layer (spec 2026-10-07-hotspots-design.md).
 * Run: node scripts/qa-hotspots.mjs [--url https://musharna.github.io/wildeye/] [--zip <hotspots_2016_1.zip>]
 *      [--python python3] [--clicks all|<n>]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Known answers come from scripts/qa_hotspots_truth.py, which reads the pinned Zenodo zip itself with GDAL and shapely
 * (not pipeline/hotspots.py, not the published file): for named places and for 46 points 0.04–0.10° from a hotspot
 * edge (inside and outside, 6 of them beyond ±175°), the hotspot areas and outer limits that hold each point, and each
 * hotspot's geodesic area. Each point is checked twice: the layer's readout, and a real click. The click arms WHAT
 * LIVES HERE and clicks the canvas straight below the camera over the point: inside a hotspot it lands on the drawn
 * polygon and opens that hotspot's card (the polygon is first seen under the centre pixel by a render pick); elsewhere
 * it reaches the ground and the card lists this layer's row. The answers must include all three outcomes (hotspot,
 * outer limit only, none), so a layer that reads one constant cannot pass.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const ZIP = arg('--zip', path.join(process.env.WILDEYE_CACHE || path.join(os.homedir(), '.cache', 'wildeye'), 'hotspots', 'hotspots_2016_1.zip'));
const PYTHON = arg('--python', 'python3');
const CLICKS = arg('--clicks', 'all');
const ID = 'hotspots';
const LAYER_NAME = 'Biodiversity hotspots (CI 2016.1)';
const DATE = '2016.1';
const TOKEN = LAYER_STATE_REGISTRY.find((e) => e.id === ID)?.token;
const HERE = path.dirname(fileURLToPath(import.meta.url));
// the readout lines, written here from the spec rather than imported from the layer
const NONE = 'Not in a biodiversity hotspot';
const OUTER = (names) => (names.length === 1
  ? `In the outer limit of ${names[0]}, which groups the hotspot's islands; not part of the hotspot`
  : `In the outer limits of ${names.join(' and ')}, which group each hotspot's islands; not part of these hotspots`);
// "1.49 million km²" or "18,920 km²"; the pipeline's areas are spherical, the truth's geodesic: they agree within 1.5%
const km2Of = (s) => {
  const m = /([\d.,]+)( million)? km²/.exec(s ?? '');
  return m ? Number(m[1].replace(/,/g, '')) * (m[2] ? 1e6 : 1) : NaN;
};
const AREA_TOL = 0.015;

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

const run = spawnSync(PYTHON, ['-B', path.join(HERE, 'qa_hotspots_truth.py'), ZIP], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 600000 });
if (run.status !== 0) {
  report('truth', false, { status: run.status, stderr: String(run.stderr).slice(-600) });
  process.exit(1);
}
const TRUTH = JSON.parse(run.stdout);
const kindOf = (p) => (p.areas.length ? 'area' : p.outer.length ? 'outer' : 'none');
const outcomes = TRUTH.points.reduce((acc, p) => ({ ...acc, [kindOf(p)]: (acc[kindOf(p)] || 0) + 1 }), {});
report('truth', TRUTH.points.length >= 60 && outcomes.area >= 20 && outcomes.outer >= 10 && outcomes.none >= 10, { points: TRUTH.points.length, outcomes });
const areaOk = (p, text) => {
  const name = p.areas[0];
  const want = TRUTH.area_km2[name];
  return Math.abs(km2Of(text) - want) / want <= AREA_TOL;
};

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 900000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const consoleErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /hotspot|what-lives-here|bio-card/i.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);

  // The entity under the canvas centre with the camera `alt` m straight above (lat, lon), after a fresh render.
  const look = ([lat, lon], alt) => page.evaluate((lat, lon, alt) => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, alt), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  }, lat, lon, alt);
  const centrePick = () => page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    const c = v.scene.canvas;
    v.scene.render();
    const hit = v.scene.pick({ x: c.clientWidth / 2, y: c.clientHeight / 2 });
    const id = hit?.id?.id ?? null;
    return { id: id === null ? null : String(id), name: hit?.id?.properties?.name?.getValue?.() ?? null };
  });
  // Polygons tessellate asynchronously (slow under swiftshader): wait until the centre pick names `name`.
  const waitDrawn = (name, timeout = 120000) => page.waitForFunction((id, name) => {
    const v = window.__godsEyeView.viewer;
    const c = v.scene.canvas;
    v.scene.render();
    const hit = v.scene.pick({ x: c.clientWidth / 2, y: c.clientHeight / 2 });
    return String(hit?.id?.id ?? '').startsWith(`${id}:area:`) && hit.id.properties?.name?.getValue?.() === name;
  }, { timeout, polling: 1000 }, ID, name).then(() => true, () => false);

  const borneo = TRUTH.points.find((p) => p.name === 'borneo');
  await look([borneo.lat, borneo.lon], 6000000);
  const before = await centrePick();
  const enabled = await page.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled(id, true, { origin: 'user' });
    const stats = () => dataManager.getAll().find((l) => l.id === id)?.stats;
    for (let i = 0; i < 120 && !stats()?.lastUpdate && !stats()?.error; i += 1) await new Promise((r) => setTimeout(r, 500));
    return { on: dataManager.isEnabled(id), stats: stats() ?? null };
  }, ID);
  const s = enabled.stats;
  report('loaded', enabled.on && !s?.error && s?.count === 36 && s?.outerLimits === 17, { count: s?.count, outerLimits: s?.outerLimits, error: s?.error });
  report('not-drawn-before-on', !String(before.id ?? '').startsWith(`${ID}:`), { before });

  // 1. the readout at every truth point
  const got = await page.evaluate(async (id, points) => {
    const out = [];
    for (const p of points) out.push((await window.__godsEyeView.readoutAt(p.lat, p.lon)).find((r) => r.id === id) ?? null);
    return out;
  }, ID, TRUTH.points.map(({ lat, lon }) => ({ lat, lon })));
  TRUTH.points.forEach((p, i) => {
    const r = got[i];
    const text = r?.text ?? r?.error ?? null;
    const ok = r?.status === 'class' && r.date === DATE && (p.areas.length
      ? text.startsWith(`${p.areas[0]} biodiversity hotspot · `) && areaOk(p, text)
      : text === (p.outer.length ? OUTER(p.outer) : NONE));
    report(`readout-${p.name}`, ok, { lat: p.lat, lon: p.lon, got: text, areas: p.areas, outer: p.outer, km2: p.areas.length ? TRUTH.area_km2[p.areas[0]] : undefined });
  });

  // 2. what is drawn: hotspots on both sides of the antimeridian and the outer limits as dashed lines
  for (const name of ['borneo', 'cusco', 'madagascar', 'viti-levu', 'antimeridian-in-1']) {
    const p = TRUTH.points.find((q) => q.name === name);
    await look([p.lat, p.lon], 3000000);
    const drawn = await waitDrawn(p.areas[0]);
    report(`drew-${name}`, drawn, { want: p.areas[0], pick: await centrePick() });
  }
  // Every outer-limit part is drawn, dashed, and no drawn segment runs along ±180° or the long way round the globe:
  // the source cuts New Zealand's and Polynesia-Micronesia's limits at the meridian, and that cut is no limit.
  const lines = await page.evaluate(async (id) => {
    const C = window.__godsEyeView.viewer.camera.position.constructor; // Cesium.Cartesian3
    const ds = window.__godsEyeView.viewer.dataSources.getByName(id)[0];
    const gj = await (await fetch('data/hotspots.geojson')).json();
    const outer = gj.features.filter((f) => f.properties.kind === 'outer');
    const parts = outer.reduce((n, f) => n + (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.length : 1), 0);
    const polylines = ds.entities.values.filter((e) => e.polyline);
    const lonOf = (c) => (Math.atan2(c.y, c.x) * 180) / Math.PI;
    let onMeridian = 0;
    let longWay = 0;
    let segments = 0;
    for (const e of polylines) {
      const lons = e.polyline.positions.getValue().map((c) => lonOf(C.clone(c)));
      for (let k = 1; k < lons.length; k += 1) {
        segments += 1;
        if (Math.abs(Math.abs(lons[k]) - 180) < 1e-6 && Math.abs(Math.abs(lons[k - 1]) - 180) < 1e-6) onMeridian += 1;
        if (Math.abs(lons[k] - lons[k - 1]) > 180) longWay += 1;
      }
    }
    const parted = new Set(polylines.map((e) => String(e.id).split(':').slice(0, 4).join(':'))).size;
    return { parts, parted, polylines: polylines.length, dashed: polylines.filter((e) => e.polyline.material?.getType?.() === 'PolylineDash').length, segments, onMeridian, longWay };
  }, ID);
  report('outer-limits-dashed', lines.parts > 17 && lines.parted === lines.parts && lines.dashed === lines.polylines && lines.segments > 1000
    && lines.onMeridian === 0 && lines.longWay === 0, lines);

  // 3. a real click at every truth point (or the first --clicks n)
  const clickPoints = CLICKS === 'all' ? TRUTH.points : TRUTH.points.slice(0, Number(CLICKS));
  await page.evaluate(() => {
    const panel = document.getElementById('species-panel');
    if (panel?.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click();
  });
  const hittable = (sel) => {
    const b = document.querySelector(sel);
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return r.width > 0 && hit && (hit === b || b.contains(hit)) ? { x, y } : false;
  };
  const centreAt = () => {
    const c = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
    const x = c.left + c.width / 2;
    const y = c.top + c.height / 2;
    return document.elementFromPoint(x, y) === window.__godsEyeView.viewer.scene.canvas ? { x, y } : false;
  };
  const cardText = () => page.evaluate(() => {
    const el = document.getElementById('bio-card');
    return {
      open: el?.hidden === false,
      body: (el?.querySelector('.bio-card-body')?.textContent || '').trim(),
      layers: [...(el?.querySelectorAll('.bio-card-layers li') || [])].map((li) => li.textContent),
    };
  });
  let clicked = 0;
  for (const p of clickPoints) {
    // a clean start: no card open (closing it also disarms), then armed
    if ((await cardText()).open) {
      const close = await page.waitForFunction(hittable, { timeout: 30000 }, '#bio-card .bio-card-close').then((h) => h.jsonValue(), () => null);
      if (close) await page.mouse.click(close.x, close.y);
      await page.waitForFunction(() => document.getElementById('bio-card')?.hidden !== false, { timeout: 30000 }).catch(() => null);
    }
    await look([p.lat, p.lon], 600000);
    await page.waitForFunction(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded, { timeout: 120000, polling: 250 }).catch(() => null);
    const drawn = p.areas.length ? await waitDrawn(p.areas[0]) : true;
    const pressed = () => document.getElementById('species-what-lives-here')?.getAttribute('aria-pressed') === 'true';
    if (!(await page.evaluate(pressed))) {
      const arm = await page.waitForFunction(hittable, { timeout: 30000 }, '#species-what-lives-here').then((h) => h.jsonValue(), () => null);
      if (arm) await page.mouse.click(arm.x, arm.y);
    }
    const armed = await page.waitForFunction(pressed, { timeout: 10000 }).then(() => true, () => false);
    const centre = await page.waitForFunction(centreAt, { timeout: 30000 }).then((h) => h.jsonValue(), () => null);
    if (centre && armed) await page.mouse.click(centre.x, centre.y);
    clicked += 1;
    let ok = false;
    let seen = null;
    if (p.areas.length) {
      // the click lands on the polygon: that hotspot's card
      const head = `${p.areas[0]}: biodiversity hotspot`;
      seen = await page.waitForFunction((head) => {
        const el = document.getElementById('bio-card');
        const body = (el?.querySelector('.bio-card-body')?.textContent || '').trim();
        return el?.hidden === false && body.startsWith(head) ? body : false;
      }, { timeout: 30000 }, head).then((h) => h.jsonValue(), async () => (await cardText()).body);
      ok = drawn && String(seen).startsWith(head) && areaOk(p, /Land area: ([^\n]*?km²)/.exec(seen)?.[1]);
    } else {
      // the click reaches the ground: WHAT LIVES HERE lists this layer's row
      const want = `${LAYER_NAME}: ${p.outer.length ? OUTER(p.outer) : NONE} · ${DATE}`;
      seen = await page.waitForFunction((name) => {
        const items = [...document.querySelectorAll('#bio-card .bio-card-layers li')].map((li) => li.textContent);
        const row = items.find((t) => t.includes(`${name}:`));
        return row && !row.includes('reading…') ? row : false;
      }, { timeout: 60000 }, LAYER_NAME).then((h) => h.jsonValue(), async () => (await cardText()).layers.join(' | '));
      ok = String(seen).endsWith(want);
    }
    report(`click-${p.name}`, ok && armed && !!centre, { lat: p.lat, lon: p.lon, expect: kindOf(p), areas: p.areas, outer: p.outer, drawn, armed, seen: String(seen).slice(0, 260) });
  }
  report('clicks-all-made', clicked === clickPoints.length && clickPoints.length >= (CLICKS === 'all' ? TRUTH.points.length : 1), { clicked, of: clickPoints.length });

  // 4. an outer limit's card, legend and credit, share token
  const card = await page.evaluate(async (id) => {
    const { viewer } = window.__godsEyeView;
    const ds = viewer.dataSources.getByName(id)[0];
    const entity = ds.entities.values.find((e) => e.polyline && e.properties?.name?.getValue?.() === 'Wallacea');
    if (!entity) return { error: 'no Wallacea outer limit entity' };
    viewer.selectedEntity = entity;
    const el = document.getElementById('bio-card');
    for (let i = 0; i < 40 && !(el?.hidden === false && /Outer limit of Wallacea/.test(el.textContent)); i += 1) await new Promise((r) => setTimeout(r, 100));
    const body = el?.querySelector('.bio-card-body');
    const out = { open: el?.hidden === false, links: body ? [...body.querySelectorAll('a[href^="http"]')].map((a) => a.href) : [], text: (body?.textContent || '').trim() };
    viewer.selectedEntity = undefined;
    return out;
  }, ID);
  report('outer-limit-card', card.open && /^Outer limit of Wallacea/.test(card.text) && /not part of the hotspot itself/.test(card.text)
    && /CC BY-SA 4\.0/.test(card.text) && card.links.includes('https://doi.org/10.5281/zenodo.3261807'), { ...card, text: card.text?.slice(0, 300) });

  const shown = await page.evaluate((id) => {
    const items = [...document.querySelectorAll(`.data-toggle-row[data-layer-id="${id}"] .data-toggle-legend-item`)].map((e) => e.textContent.trim());
    const credits = [...document.querySelectorAll('[class*="credit"]')].filter((e) => !e.closest('#bio-card')).map((e) => e.textContent).join(' ');
    return { items, credits };
  }, ID);
  // matched exactly: every entry is key-only (count: null), shown as its label alone
  const has = (label) => shown.items.some((t) => t === label);
  const legendOk = shown.items.length === 38 && has('Sundaland') && has('North American Coastal Plain')
    && has("dashed line = outer limit: groups a hotspot's islands and patches into one unit for display; not part of the hotspot")
    && has('fill = biodiversity hotspot (Conservation International 2016.1, 36 hotspots): at least 1,500 endemic vascular plant species and at least 70% of primary native vegetation lost. Boundaries simplified; an IUCN-led re-evaluation has been under way since October 2025.');
  const creditOk = shown.credits.includes('Biodiversity Hotspots (version 2016.1)') && shown.credits.includes('CC BY-SA 4.0')
    && shown.credits.includes('doi:10.1038/35002501') && shown.credits.includes('shared under the same CC BY-SA 4.0');
  report('legend-and-credit', legendOk && creditOk, { legend: legendOk, credit: creditOk, items: shown.items.slice(-2).map((t) => t.slice(0, 200)), n: shown.items.length });

  const share = await page.evaluate(() => location.href);
  report('share-token', Boolean(TOKEN) && new RegExp(`[#&]l=([^&]*\\.)?${TOKEN}(\\.|&|$)`).test(decodeURIComponent(share)), { token: TOKEN, url: share.slice(0, 220) });
} catch (e) {
  report('run', false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-console-errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
