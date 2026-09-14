#!/usr/bin/env node
/**
 * qa-species.mjs — real-browser checks for the biology details card, species search and "what lives here".
 * Run: node scripts/qa-species.mjs --url http://localhost:4488/wildeye/ [--checks panel-layout,left-stack,card,suggestion-fade,search,panel-datasets,here,portal-link] [--shots <dir>]
 * Prints one JSON line per check; exits 1 when any check fails.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { GBIF_BACKBONE_CHECKLIST_KEY, SPECIES_MAP_LEGEND, SPECIES_TILE_SIZE_PX } from '../src/bio/gbif.js';
import { MORE_SLACK_PX } from '../src/bio/speciesPanel.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
// I2: a desktop window height at which the whole SPECIES panel body fits (round-10 build: nothing overflowed at 1,100, 1,300 and 1,700 px).
const TALL_DESKTOP_HEIGHT = 1100;
const CHECKS = new Set(arg('--checks', 'panel-layout,left-stack,card,suggestion-fade,search,panel-datasets,here,portal-link').split(','));
const SHOTS = arg('--shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const requests = [];
const failed = [];
page.on('request', (r) => requests.push(r.url()));
// Every dataset-facet occurrence search the page sends, never reset: the panel reuses a finished list when the same taxon and years return
// (panel-layout maps the monarch before the search check chooses it again), so a check cannot rely on a request after its own start.
const datasetSearches = [];
page.on('request', (r) => { let u; try { u = new URL(r.url()); } catch { return; } if (u.hostname === 'api.gbif.org' && u.pathname === '/v1/occurrence/search' && u.searchParams.getAll('facet').join() === 'datasetKey') datasetSearches.push(u); });
const tileStatus = new Map(); // species map tile URL -> HTTP status, so the search check decodes only tiles GBIF drew (200, not 204)
page.on('response', (r) => { if (r.url().includes('/v2/map/occurrence/')) tileStatus.set(r.url(), r.status()); });
const upstreamTileErrors = [];
// GBIF's maps backend sometimes fails one vector tile on its own side (seen: monarch adhoc/8/48/92 at EPSG:3857, a fast 503
// every time while its neighbours load). GBIF marks those with an `x-error: Error from backend (vector tile)…` header, so a
// 5xx map tile from api.gbif.org carrying that marker is reported under upstreamTileErrors instead of failing
// no-failed-requests (R-6c). The search check's stats.error === null still catches a run of tile failures.
const isUpstreamTileError = (url, status, xError) => { let u; try { u = new URL(url); } catch { return false; } return u.hostname === 'api.gbif.org' && u.pathname.startsWith('/v2/map/occurrence/') && status >= 500 && status <= 599 && typeof xError === 'string' && xError.startsWith('Error from backend'); };
page.on('response', (r) => {
  if (r.status() < 400 || /google|gstatic|cesium\.com/.test(r.url())) return;
  const xError = r.headers()['x-error'];
  if (isUpstreamTileError(r.url(), r.status(), xError)) upstreamTileErrors.push({ status: r.status(), url: r.url(), xError });
  else failed.push(`${r.status()} ${r.url()}`);
});
page.on('requestfailed', (r) => { if (!/google|gstatic|cesium\.com|tile/.test(r.url())) failed.push(`REQFAIL ${r.url()} ${r.failure()?.errorText}`); });
page.on('pageerror', (e) => failed.push(`PAGEERROR ${String(e?.message || e).slice(0, 160)}`));
page.on('dialog', (d) => d.dismiss().catch(() => {}));
// Species map tiles still in flight, for waitForMapTiles.
const pendingTiles = new Set();
page.on('request', (r) => { if (r.url().includes('/v2/map/occurrence/')) pendingTiles.add(r.url()); });
page.on('requestfinished', (r) => { pendingTiles.delete(r.url()); });
page.on('requestfailed', (r) => { pendingTiles.delete(r.url()); });
// The record count of every dataset-facet search the page got back, by URL: portal-link compares the panel's gbif.org link with it.
const datasetSearchCounts = new Map();
page.on('response', (r) => {
  let u; try { u = new URL(r.url()); } catch { return; }
  if (u.hostname !== 'api.gbif.org' || u.pathname !== '/v1/occurrence/search' || u.searchParams.getAll('facet').join() !== 'datasetKey' || r.status() !== 200) return;
  r.json().then((json) => { datasetSearchCounts.set(r.url(), json.count); }, (error) => { failed.push(`BODY ${r.url()} ${error}`); });
});

let bad = 0;
const report = (check, ok, detail = {}) => { if (!ok) bad += 1; console.log(JSON.stringify({ check, ok, ...detail })); };
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// R-7u: dataset rows link a DOI on doi.org or the dataset page on gbif.org, always https, in a new tab with no opener or referrer.
const DATASET_HREF = /^https:\/\/(?:doi\.org\/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+|www\.gbif\.org\/dataset\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const readDatasetRows = (selector) => page.evaluate((selector) => [...document.querySelectorAll(selector)].map((li) => {
  const a = li.querySelector('a');
  return { href: a?.getAttribute('href') ?? null, target: a?.getAttribute('target') ?? null, rel: a?.getAttribute('rel') ?? null, text: a?.textContent ?? '', count: li.querySelector('.dataset-row-count')?.textContent ?? null, note: li.querySelector('.dataset-row-note')?.textContent ?? null };
}), selector);
const datasetRowsOk = (rows, max) => rows.length >= 1 && rows.length <= max && rows.every((row) => DATASET_HREF.test(row.href || '') && row.target === '_blank' && /\bnoopener\b/.test(row.rel || '') && /\bnoreferrer\b/.test(row.rel || '') && row.text.trim() !== '' && /^[\d,]+$/.test(row.count || '') && row.note === null);
const flyTo = (lon, lat, height) => page.evaluate(async (lon, lat, height) => {
  const viewer = window.__godsEyeView.viewer;
  const Cartesian3 = viewer.camera.position.constructor;
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 5000));
}, lon, lat, height);
// Item 11: a screenshot with the species map on waits until the map has loaded: the globe reports its tiles loaded, Cesium's tile-load queue
// (tileLoadProgressEvent) is empty and no species tile request is pending, for 6 polls 500 ms apart. A timeout is returned, not swallowed:
// the checks that shoot the map fail on it.
const waitForMapTiles = async (timeoutMs = 90000) => {
  await page.evaluate(() => {
    if (window.__qaTileQueue) return;
    window.__qaTileQueue = { length: 0 };
    window.__godsEyeView.viewer.scene.globe.tileLoadProgressEvent.addEventListener((length) => { window.__qaTileQueue.length = length; });
  });
  const started = Date.now();
  let stable = 0;
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = { ...(await page.evaluate(() => ({ queue: window.__qaTileQueue.length, tilesLoaded: window.__godsEyeView.viewer.scene.globe.tilesLoaded }))), pendingSpeciesTiles: pendingTiles.size };
    stable = last.tilesLoaded && last.queue === 0 && last.pendingSpeciesTiles === 0 ? stable + 1 : 0;
    if (stable >= 6) return { settled: true, ms: Date.now() - started };
    await sleep(500);
  }
  return { settled: false, ms: Date.now() - started, last };
};

const openSpeciesPanel = async () => {
  await page.evaluate(() => {
    const panel = document.getElementById('species-panel');
    if (panel?.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click();
  });
  await sleep(800);
};

await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
await sleep(12000);
await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
await page.keyboard.press('Escape');

if (CHECKS.has('panel-layout')) {
  // CSS regex pins cannot see cascade results, so measure the stack panels in the page (R-6e): collapsed SPECIES is
  // the same pill as collapsed SCENES, expanded SPECIES is its --panel-expanded-width, and on a 400px phone it fits.
  const setOpen = (id, open) => page.evaluate((id, open) => {
    const panel = document.getElementById(id);
    if (panel && panel.classList.contains('collapsed') === open) panel.querySelector(`[data-collapse-target="${id}"]`)?.click();
  }, id, open);
  const measure = () => page.evaluate(() => {
    const info = (id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      return { collapsed: el.classList.contains('collapsed'), width: r.width, left: r.left, right: r.right, expandedVar: getComputedStyle(el).getPropertyValue('--panel-expanded-width').trim() };
    };
    return { viewport: window.innerWidth, species: info('species-panel'), scene: info('scene-panel') };
  });
  const initial = await page.evaluate(() => ({ species: document.getElementById('species-panel').classList.contains('collapsed'), scene: document.getElementById('scene-panel').classList.contains('collapsed') }));
  await setOpen('species-panel', false);
  await setOpen('scene-panel', false);
  await sleep(1000);
  const collapsed = await measure();
  await setOpen('species-panel', true);
  await sleep(1000);
  const expanded = await measure();
  await page.setViewport({ width: 400, height: 800 });
  await sleep(2000);
  await setOpen('species-panel', true);
  await sleep(1000);
  const phone = await measure();
  await shot('panel-layout-phone');
  await page.setViewport({ width: 1400, height: 900 });
  await sleep(2000);
  await setOpen('species-panel', !initial.species);
  await setOpen('scene-panel', !initial.scene);
  await sleep(800);
  const restored = await measure();
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const collapsedOk = collapsed.species.collapsed && collapsed.scene.collapsed && collapsed.species.width > 0 && collapsed.scene.width > 0 && near(collapsed.species.width, collapsed.scene.width);
  const expandedOk = !expanded.species.collapsed && near(expanded.species.width, Number.parseFloat(expanded.species.expandedVar));
  const phoneOk = !phone.species.collapsed && phone.species.right <= phone.viewport && phone.species.width >= 300;
  const restoredOk = restored.viewport === 1400 && restored.species.collapsed === initial.species && restored.scene.collapsed === initial.scene;
  // With a species mapped (legend and Top datasets showing), at the desktop default and on a 400x800 phone, WHAT LIVES HERE and both chip rows
  // are whole inside the body's scroll view without scrolling and are what the page hits at their corners, and no chip, action or legend
  // caption text is cut. B1: the scroll cue is a row of its own below the scroll container, inside the panel: laid out with its own height,
  // aria-hidden, overlapping no visible part of any element inside the scroll container, shown while more of the body is below and hidden
  // at the end, at 1400x900, 400x800 and 375x667. I2: on a desktop window tall enough for the whole body nothing overflows and the cue is
  // hidden. I1: at the end of the scroll every link in the Top datasets block is whole in view, is what the page hits at its centre, and
  // takes keyboard focus with its focus ring inside the view. The species is set through the data manager and cleared afterwards.
  const cueState = () => {
    const body = document.getElementById('species-body');
    const cue = document.getElementById('species-more');
    if (!body || !cue) return { present: false, body: Boolean(body) };
    const b = body.getBoundingClientRect();
    const view = { top: b.top + body.clientTop, bottom: Math.min(b.bottom, b.top + body.clientTop + body.clientHeight), left: b.left + body.clientLeft, right: b.left + body.clientLeft + body.clientWidth };
    const c = cue.getBoundingClientRect();
    const cs = getComputedStyle(cue);
    // The part of each element inside the scroll container a reader can see (its box clipped to the view), against the cue's box.
    const overlaps = [...body.querySelectorAll('*')].flatMap((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return [];
      const seen = { top: Math.max(r.top, view.top), bottom: Math.min(r.bottom, view.bottom), left: Math.max(r.left, view.left), right: Math.min(r.right, view.right) };
      const x = Math.min(seen.right, c.right) - Math.max(seen.left, c.left);
      const y = Math.min(seen.bottom, c.bottom) - Math.max(seen.top, c.top);
      return x > 0.5 && y > 0.5 ? [{ el: el.id || String(el.className) || el.tagName, x: +x.toFixed(1), y: +y.toFixed(1) }] : [];
    });
    return {
      present: true, display: cs.display, visibility: cs.visibility, text: cue.textContent, ariaHidden: cue.getAttribute('aria-hidden'),
      inPanel: document.querySelector('#species-panel .species-panel-inner').contains(cue) && !body.contains(cue),
      box: { top: +c.top.toFixed(1), bottom: +c.bottom.toFixed(1), height: +c.height.toFixed(1) }, viewBottom: +view.bottom.toFixed(1),
      rangeLeft: body.scrollHeight - body.clientHeight - body.scrollTop, overlapCount: overlaps.length, overlaps: overlaps.slice(0, 5),
    };
  };
  const linksAtEnd = async () => {
    const count = await page.evaluate(() => document.querySelectorAll('#species-datasets a').length);
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      // Keyboard focus (Shift+Tab, then Tab back), so :focus-visible and its ring apply; then the body goes back to the end of its scroll.
      await page.evaluate((i) => document.querySelectorAll('#species-datasets a')[i].focus(), i);
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      await page.keyboard.press('Tab');
      await page.evaluate(() => { const body = document.getElementById('species-body'); body.scrollTop = body.scrollHeight; });
      await sleep(300);
      rows.push(await page.evaluate((i) => {
        const a = document.querySelectorAll('#species-datasets a')[i];
        const body = document.getElementById('species-body');
        const b = body.getBoundingClientRect();
        const view = { top: b.top + body.clientTop, bottom: Math.min(b.bottom, b.top + body.clientTop + body.clientHeight), left: b.left + body.clientLeft, right: b.left + body.clientLeft + body.clientWidth };
        const r = a.getBoundingClientRect();
        const cs = getComputedStyle(a);
        const out = (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0);
        const ring = { top: r.top - out, bottom: r.bottom + out, left: r.left - out, right: r.right + out };
        const inside = (box) => box.top >= view.top - 0.5 && box.bottom <= view.bottom + 0.5 && box.left >= view.left - 0.5 && box.right <= view.right + 0.5;
        const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        const round = (box) => Object.fromEntries(Object.entries(box).map(([k, v]) => [k, +v.toFixed(1)]));
        return {
          text: a.textContent.slice(0, 40), atEnd: body.scrollHeight - body.clientHeight - body.scrollTop <= 1, whole: inside(r), hit: Boolean(hit && (hit === a || a.contains(hit))),
          focused: document.activeElement === a, focusVisible: a.matches(':focus-visible'), outline: `${cs.outlineStyle} ${cs.outlineWidth} offset ${cs.outlineOffset}`,
          ringInside: cs.outlineStyle !== 'none' && inside(ring), box: round({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }), view: round(view),
        };
      }, i));
    }
    return { rows, ok: rows.length >= 2 && rows.every((row) => row.atEnd && row.whole && row.hit && row.focused && row.focusVisible && row.ringInside) };
  };
  const fitAt = async (width, height, shotName, { shotAtTop = false, controls = true, links = true, overflow = true } = {}) => {
    await page.setViewport({ width, height });
    await sleep(2500);
    await setOpen('species-panel', true);
    await sleep(1000);
    await page.evaluate(() => { document.getElementById('species-body').scrollTop = 0; });
    // M-2: the datasets wait's outcome is recorded (a timeout or a failure in the block fails the fit), not discarded.
    const datasetsWait = await page.waitForFunction(() => document.querySelectorAll('#species-datasets .dataset-row').length > 0 || document.querySelector('#species-datasets .species-datasets-error'), { timeout: 45000 }).then(() => 'settled', (error) => String(error).slice(0, 120));
    const datasetsFailure = await page.evaluate(() => document.getElementById('species-datasets-status')?.textContent || null);
    const mapTiles = await waitForMapTiles();
    await sleep(1000);
    const fit = await page.evaluate(() => {
      const body = document.getElementById('species-body');
      const b = body.getBoundingClientRect();
      const view = { top: b.top + body.clientTop, bottom: Math.min(b.bottom, b.top + body.clientTop + body.clientHeight) };
      const whole = (el) => {
        const r = el.getBoundingClientRect();
        const inside = r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5;
        // Probe points inset by half the height from the rounded ends, as the round-5 shots did: the pill's square corners are outside it.
        const inset = Math.min((r.bottom - r.top) / 2, 10);
        const corners = [[r.left + inset, r.top + 2], [r.right - inset, r.top + 2], [r.left + inset, r.bottom - 2], [r.right - inset, r.bottom - 2]].every(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && (hit === el || el.contains(hit))); });
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), inside, corners };
      };
      const legend = document.getElementById('species-legend');
      const legendBg = getComputedStyle(legend).backgroundColor;
      const caption = document.getElementById('species-legend-caption');
      return {
        viewport: `${innerWidth}x${innerHeight}`, scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, view: { top: Math.round(view.top), bottom: Math.round(view.bottom) },
        action: whole(document.getElementById('species-what-lives-here')), years: whole(document.getElementById('species-years')), radius: whole(document.getElementById('species-radius')),
        legendHidden: legend.hidden, legendBg, legendOpaque: /^rgb\(/.test(legendBg) || /, 1\)$/.test(legendBg),
        datasetsHidden: document.getElementById('species-datasets').hidden,
        // no chip, action or caption text cut off inside its box
        clipped: [...document.querySelectorAll('#species-panel .species-chip, #species-what-lives-here, #species-legend-caption')].filter((el) => el.scrollWidth > el.clientWidth + 0.5).map((el) => ({ text: el.textContent, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })),
        caption: caption ? { text: caption.textContent, right: +caption.getBoundingClientRect().right.toFixed(1), legendContentRight: +(legend.getBoundingClientRect().right - parseFloat(getComputedStyle(legend).paddingRight)).toFixed(1) } : null,
      };
    });
    const cueTop = await page.evaluate(cueState);
    if (shotName && shotAtTop) await shot(shotName);
    await page.evaluate(() => { const body = document.getElementById('species-body'); body.scrollTop = body.scrollHeight; });
    await sleep(1200);
    const cueEnd = await page.evaluate(cueState);
    const endLinks = links ? await linksAtEnd() : null;
    if (shotName && !shotAtTop) await shot(shotName);
    await page.evaluate(() => { document.activeElement?.blur?.(); document.getElementById('species-body').scrollTop = 0; });
    const range = fit.scrollHeight - fit.clientHeight;
    const overflowOk = overflow ? range > MORE_SLACK_PX : range === 0;
    const cueLaidOut = (state) => state.present && state.display !== 'none' && state.inPanel && state.ariaHidden === 'true' && state.box.height >= 10 && state.overlapCount === 0;
    const cueOk = cueLaidOut(cueTop) && cueLaidOut(cueEnd) && cueTop.visibility === (overflow ? 'visible' : 'hidden') && cueEnd.rangeLeft <= MORE_SLACK_PX && cueEnd.visibility === 'hidden';
    const controlKeys = controls === true ? ['action', 'years', 'radius'] : controls || [];
    const controlsOk = controlKeys.every((key) => fit[key].inside && fit[key].corners);
    const captionOk = Boolean(fit.caption) && fit.caption.right <= fit.caption.legendContentRight + 0.5;
    const linksOk = !links || Boolean(endLinks?.ok);
    const ok = mapTiles.settled && datasetsWait === 'settled' && datasetsFailure === null && fit.scrollTop === 0 && controlsOk && !fit.legendHidden && fit.legendOpaque && !fit.datasetsHidden && fit.clipped.length === 0 && captionOk && overflowOk && cueOk && linksOk;
    return { ...fit, range, mapTiles, datasetsWait, datasetsFailure, cueTop, cueEnd, endLinks, overflowOk, cueOk, controlsOk, captionOk, linksOk, ok };
  };
  await page.evaluate(async () => {
    const dm = window.__godsEyeView.dataManager;
    if (!dm.setLayerParams('species', { taxonKey: 5133088, name: 'Monarch' }, { origin: 'user' })) throw new Error('species params rejected');
    await dm.setEnabled('species', true, { origin: 'user' });
  });
  const desktopFit = await fitAt(1400, 900, 'panel-scrolled-desktop');
  const phoneFit = await fitAt(400, 800, 'panel-scrolled-phone');
  // Critic 8 S1: at the page's starting camera (street level over Austin, pitched 30° down) the ground below the stack holds no monarch record
  // from the last 10 years (api.gbif.org v1: 0; its 12 species tiles answered 200 and the circles they draw sit at the horizon, under the
  // header), so the 375x667 capture looks straight down on central Texas from 400 km, where 875 such records lie below the stack. The camera
  // is put back afterwards.
  await page.evaluate(() => { const c = window.__godsEyeView.viewer.camera; window.__qaSavedCamera = { position: c.position.clone(), heading: c.heading, pitch: c.pitch, roll: c.roll }; });
  await flyTo(-97.74, 30.27, 400_000);
  // 375x667: the cue is required (critic S2), and WHAT LIVES HERE is whole inside the body's view at the scroll top and hit at its corners
  // (critic 8 B1: its bottom 4 px were cut). The chip rows and the end links are measured and reported, the fit criterion being 400x800.
  const smallPhoneFit = await fitAt(375, 667, 'panel-375x667', { shotAtTop: true, controls: ['action'], links: false });
  await page.evaluate(() => { const s = window.__qaSavedCamera; window.__godsEyeView.viewer.camera.setView({ destination: s.position, orientation: { heading: s.heading, pitch: s.pitch, roll: s.roll } }); });
  // I2: a desktop window at least 1,000 px tall where the whole body fits: nothing overflows, and the cue stays hidden.
  const tallDesktopFit = await fitAt(1400, TALL_DESKTOP_HEIGHT, null, { overflow: false, links: false });
  await page.setViewport({ width: 1400, height: 900 });
  await sleep(2000);
  await page.evaluate(async () => {
    const dm = window.__godsEyeView.dataManager;
    await dm.setEnabled('species', false, { origin: 'user' });
    dm.setLayerParams('species', { taxonKey: null }, { origin: 'user' });
  });
  await setOpen('species-panel', !initial.species);
  await sleep(800);
  const fitOk = desktopFit.ok && phoneFit.ok && smallPhoneFit.ok && tallDesktopFit.ok;
  report('panel-layout', collapsedOk && expandedOk && phoneOk && restoredOk && fitOk, {
    collapsed: { species: collapsed.species.width, scene: collapsed.scene.width },
    expanded: { species: expanded.species.width, speciesExpandedVar: expanded.species.expandedVar },
    phone: { viewport: phone.viewport, speciesWidth: phone.species.width, speciesLeft: phone.species.left, speciesRight: phone.species.right },
    restored: { viewport: restored.viewport, speciesCollapsed: restored.species.collapsed, sceneCollapsed: restored.scene.collapsed },
    desktopFit, phoneFit, smallPhoneFit, tallDesktopFit,
    collapsedOk, expandedOk, phoneOk, restoredOk, fitOk,
  });
}

// R9-I1: a panel hidden by its own visibility must not take the left lane. The data panel is visibility: hidden without .active, which the F
// key toggles, and every panel is hidden in clean view. At 1400x900, with the data panel expanded and the other stack panels collapsed, the
// shown data panel is measured in full (focus mode: its list is taller than the lane, the positive control). After F, once the visibility
// transition has ended, the lane is not in focus mode and the collapsed SCENE and SPECIES pills are shown with height. Clean view on and
// then off returns the lane to that mode, and F again brings back the shown panel's mode. panel-layout checks, on a window at least 1,000 px
// tall, that the SPECIES body does not overflow.
if (CHECKS.has('left-stack')) {
  await page.setViewport({ width: 1400, height: 900 });
  await sleep(2000);
  const initial = await page.evaluate(() => {
    const data = document.getElementById('data-panel');
    const open = ['scene-panel', 'species-panel', 'cctv-panel'].filter((id) => { const panel = document.getElementById(id); return panel && !panel.classList.contains('collapsed'); });
    return { collapsed: data.classList.contains('collapsed'), active: data.classList.contains('active'), cleanView: document.body.classList.contains('ui-clean-view'), open };
  });
  const stackState = () => page.evaluate(() => {
    const stack = document.getElementById('left-panel-stack');
    const panel = (id) => {
      const el = document.getElementById(id);
      const cs = getComputedStyle(el);
      return { collapsed: el.classList.contains('collapsed'), active: el.classList.contains('active'), display: cs.display, visibility: cs.visibility, height: +el.getBoundingClientRect().height.toFixed(1), ariaHidden: el.getAttribute('aria-hidden'), allocated: el.style.getPropertyValue('--left-panel-allocated-height') || null };
    };
    return { mode: stack.dataset.layoutMode, focusClass: stack.classList.contains('layout-focus'), cleanView: document.body.classList.contains('ui-clean-view'), data: panel('data-panel'), scene: panel('scene-panel'), species: panel('species-panel') };
  });
  // Presses a key, waits for a visibility transition on a stack panel to end (3 s at most, reported), then for the lane's next frames.
  const afterKey = async (key) => {
    const ended = page.evaluate(() => new Promise((resolve) => {
      const stack = document.getElementById('left-panel-stack');
      const finish = (how) => { stack.removeEventListener('transitionend', onEnd); resolve(how); };
      const onEnd = (event) => { if (event.propertyName === 'visibility' && event.target.parentElement === stack) finish('transitionend'); };
      stack.addEventListener('transitionend', onEnd);
      setTimeout(() => finish('no visibility transition in 3 s'), 3000);
    }));
    await page.keyboard.press(key);
    const how = await ended;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await sleep(800);
    return how;
  };
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    if (document.body.classList.contains('ui-clean-view')) window.__godsEyeView.styleManager.toggleCleanView(false);
    for (const id of ['scene-panel', 'species-panel', 'cctv-panel']) {
      const panel = document.getElementById(id);
      if (panel && !panel.classList.contains('collapsed')) panel.querySelector(`[data-collapse-target="${id}"]`)?.click();
    }
    const data = document.getElementById('data-panel');
    if (data.classList.contains('collapsed')) data.querySelector('[data-collapse-target="data-panel"]').click();
  });
  await sleep(1500);
  const shownBy = (await page.evaluate(() => document.getElementById('data-panel').classList.contains('active'))) ? 'already active' : await afterKey('f');
  const shown = await stackState();
  const hiddenBy = await afterKey('f');
  const hidden = await stackState();
  await shot('left-stack-f-hidden');
  const cleanOnBy = await afterKey('v');
  const cleanOn = await stackState();
  const cleanOffBy = await afterKey('v');
  const cleanOff = await stackState();
  const reshownBy = await afterKey('f');
  const reshown = await stackState();
  // Back to the state before the check.
  if (reshown.data.active !== initial.active) await afterKey('f');
  await page.evaluate((initial) => {
    const data = document.getElementById('data-panel');
    if (data.classList.contains('collapsed') !== initial.collapsed) data.querySelector('[data-collapse-target="data-panel"]').click();
    for (const id of initial.open) { const panel = document.getElementById(id); if (panel?.classList.contains('collapsed')) panel.querySelector(`[data-collapse-target="${id}"]`)?.click(); }
    if (initial.cleanView) window.__godsEyeView.styleManager.toggleCleanView(true);
  }, initial);
  await sleep(1000);
  const pillShown = (panel) => panel.collapsed && panel.display !== 'none' && panel.visibility === 'visible' && panel.height > 0 && panel.ariaHidden === null;
  const shownOk = shown.data.active && !shown.data.collapsed && shown.data.visibility === 'visible' && shown.mode === 'focus';
  const hiddenOk = !hidden.data.active && hidden.data.visibility === 'hidden' && hidden.mode !== 'focus' && !hidden.focusClass && pillShown(hidden.scene) && pillShown(hidden.species);
  const cleanOk = cleanOn.cleanView && !cleanOff.cleanView && cleanOff.mode === hidden.mode && pillShown(cleanOff.scene) && pillShown(cleanOff.species);
  const reshownOk = reshown.data.active && reshown.data.visibility === 'visible' && reshown.mode === shown.mode;
  report('left-stack', shownOk && hiddenOk && cleanOk && reshownOk, { initial, shownBy, shown, hiddenBy, hidden, cleanOnBy, cleanOn, cleanOffBy, cleanOff, reshownBy, reshown, shownOk, hiddenOk, cleanOk, reshownOk });
}

if (CHECKS.has('card')) {
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('occurrences', true, { origin: 'user' }));
  await page.waitForFunction(() => {
    const viewer = window.__godsEyeView.viewer;
    for (let i = 0; i < viewer.dataSources.length; i += 1) {
      const ds = viewer.dataSources.get(i);
      if (ds.name === 'occurrences' && ds.entities.values.some((e) => e.show)) return true;
    }
    return false;
  }, { timeout: 90000 });
  const target = await page.evaluate(async () => {
    const viewer = window.__godsEyeView.viewer;
    let ds = null;
    for (let i = 0; i < viewer.dataSources.length; i += 1) if (viewer.dataSources.get(i).name === 'occurrences') ds = viewer.dataSources.get(i);
    const entity = ds.entities.values.find((e) => e.show);
    await viewer.zoomTo(entity);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const time = viewer.clock.currentTime;
    const canvasXY = viewer.scene.cartesianToCanvasCoordinates(entity.position.getValue(time));
    const rect = viewer.scene.canvas.getBoundingClientRect();
    return { id: entity.id, name: entity.properties.name.getValue(time), x: rect.left + canvasXY.x, y: rect.top + canvasXY.y };
  });
  await page.mouse.click(target.x, target.y);
  await sleep(2500);
  const card = await page.evaluate(() => {
    const el = document.getElementById('bio-card');
    return el ? { visible: !el.hidden && el.getBoundingClientRect().width > 0, text: el.innerText, links: [...el.querySelectorAll('.bio-card-body a')].map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })) } : null;
  });
  await shot('card');
  // Positive control for the sanitizer: the layer's own https links (the DOI among them) survive, opening in a new tab with no opener.
  const httpsLinks = (card?.links || []).filter((link) => /^https:\/\//.test(link.href || ''));
  const doiLink = httpsLinks.find((link) => link.href.startsWith('https://doi.org/')) || null;
  const linksOk = httpsLinks.length > 0 && httpsLinks.every((link) => link.target === '_blank' && /\bnoopener\b/.test(link.rel || ''));
  report('card', Boolean(card?.visible) && card.text.includes(target.name) && /CC0|CC[ -]BY/i.test(card.text) && linksOk, { entity: target.id, name: target.name, doiLink, httpsLinks: httpsLinks.length, card: card && { visible: card.visible, text: card.text.slice(0, 240), links: card.links } });

  // Escape must deselect as well as close: Cesium raises selectedEntityChanged only when the value changes, so a
  // marker left selected could not reopen the card.
  await page.keyboard.press('Escape');
  await sleep(500);
  const afterEscape = await page.evaluate(() => ({ hidden: document.getElementById('bio-card')?.hidden ?? null, selected: window.__godsEyeView.viewer.selectedEntity?.id ?? null }));
  await page.mouse.click(target.x, target.y);
  await sleep(2500);
  const reopened = await page.evaluate(() => {
    const el = document.getElementById('bio-card');
    return el ? { visible: !el.hidden && el.getBoundingClientRect().width > 0, text: el.innerText.slice(0, 120) } : null;
  });
  report('card-reopen', afterEscape.hidden === true && afterEscape.selected === null && Boolean(reopened?.visible) && reopened.text.includes(target.name), { afterEscape, reopened });
  await page.keyboard.press('Escape');

  // A hostile description on a real occurrences entity: DOMPurify must drop the img and the javascript: href, keep the
  // https link (forced to a new tab with no opener), and nothing may run.
  const HOSTILE = '<b>hostile-ok</b><img src=x onerror="window.__bioXss=1"><a href="javascript:window.__bioXss=2">js</a><a href="https://example.org/">safe</a>';
  const sanitized = await page.evaluate(async (description) => {
    const viewer = window.__godsEyeView.viewer;
    let ds = null;
    for (let i = 0; i < viewer.dataSources.length; i += 1) if (viewer.dataSources.get(i).name === 'occurrences') ds = viewer.dataSources.get(i);
    delete window.__bioXss;
    viewer.selectedEntity = undefined;
    const entity = ds.entities.add({ id: 'qa-hostile-description', description });
    viewer.selectedEntity = entity;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const el = document.getElementById('bio-card');
    const anchors = el ? [...el.querySelectorAll('.bio-card-body a')] : [];
    const safe = anchors.find((a) => a.getAttribute('href') === 'https://example.org/');
    const result = {
      selected: viewer.selectedEntity?.id ?? null,
      visible: Boolean(el) && !el.hidden && el.getBoundingClientRect().width > 0,
      hasMarker: Boolean(el?.innerText.includes('hostile-ok')),
      imgs: el ? el.querySelectorAll('img').length : null,
      javascriptHrefs: el ? el.querySelectorAll('a[href^="javascript" i]').length : null,
      disallowedHrefs: anchors.filter((a) => a.hasAttribute('href') && !/^(?:https?|mailto):/i.test(a.getAttribute('href'))).length,
      safeLink: safe ? { target: safe.getAttribute('target'), rel: safe.getAttribute('rel') } : null,
      xss: typeof window.__bioXss,
      body: el?.querySelector('.bio-card-body')?.innerHTML.slice(0, 300) ?? null,
    };
    viewer.selectedEntity = undefined;
    ds.entities.remove(entity);
    return result;
  }, HOSTILE);
  report('card-sanitize', sanitized.visible && sanitized.hasMarker && sanitized.imgs === 0 && sanitized.javascriptHrefs === 0 && sanitized.disallowedHrefs === 0 && sanitized.safeLink?.target === '_blank' && /\bnoopener\b/.test(sanitized.safeLink?.rel || '') && sanitized.xss === 'undefined', sanitized);
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('occurrences', false, { origin: 'user' }));
}

if (CHECKS.has('suggestion-fade')) {
  // A suggestion list taller than its cap fades out at the bottom (a scroll-driven mask); a list that fits must not fade. Each list is
  // screenshotted, and rows compare by their brightest text pixels (99th-percentile luminance): the bottom visible row against the
  // first. Positive control in the same check: "hump" overflows the cap, so its bottom row must read dimmer; an unfaded short list
  // therefore cannot come from a blind probe. The short query must return at least two rows that fit the cap (one row compares with
  // itself, so its ratio is 1 by construction): "sialia currucoides" gives 3;
  // "megaptera nov" gives 4, but its subspecies names wrap past the cap and the list fades, as it should.
  const clearSearch = async () => {
    await page.click('#species-search', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => document.getElementById('species-suggestions').hidden, { timeout: 5000 });
  };
  const listFor = async (query) => {
    await clearSearch();
    await page.type('#species-search', query, { delay: 40 });
    await page.waitForFunction(() => { const list = document.getElementById('species-suggestions'); return !list.hidden && list.querySelectorAll('button').length > 0; }, { timeout: 20000 });
    await page.mouse.move(700, 120); // no hover highlight on a row
    await sleep(1000);
    const box = await page.evaluate(() => {
      const list = document.getElementById('species-suggestions');
      const r = list.getBoundingClientRect();
      const rows = [...list.querySelectorAll('li')]
        .map((li) => { const b = li.getBoundingClientRect(); return { top: Math.max(b.top, r.top) - r.top, bottom: Math.min(b.bottom, r.bottom) - r.top }; })
        .filter((row) => row.bottom - row.top >= 8);
      return { x: r.left, y: r.top, width: r.width, height: r.height, rows, total: list.querySelectorAll('li').length, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, fade: getComputedStyle(list).getPropertyValue('--species-suggestions-fade').trim(), texts: [...list.querySelectorAll('button')].map((b) => b.textContent) };
    });
    const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height }, encoding: 'base64' });
    const peaks = await page.evaluate(async (png, rows, cssWidth) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const scale = img.width / cssWidth;
      return rows.map(({ top, bottom }) => {
        const y0 = Math.round(top * scale);
        const { data } = ctx.getImageData(0, y0, img.width, Math.max(1, Math.round(bottom * scale) - y0));
        const lum = [];
        for (let i = 0; i < data.length; i += 4) lum.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
        lum.sort((a, b) => a - b);
        return Number(lum[Math.floor(lum.length * 0.99)].toFixed(1));
      });
    }, png, box.rows, box.width);
    return { query, rows: box.total, visibleRows: box.rows.length, overflows: box.scrollHeight > box.clientHeight, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight, fade: box.fade, peaks, bottomToFirst: Number((peaks.at(-1) / peaks[0]).toFixed(3)), texts: box.texts };
  };
  let control = null;
  let short = null;
  let error = null;
  await openSpeciesPanel();
  try {
    control = await listFor('hump');
    short = await listFor("sialia currucoides");
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 500);
  } finally {
    await clearSearch().catch((caught) => { error = `${error ?? ''} clearing the search box: ${caught}`; });
  }
  const controlOk = Boolean(control?.overflows) && control.fade !== '0px' && control.bottomToFirst < 0.85;
  const shortOk = short !== null && short.rows >= 2 && short.rows < 5 && !short.overflows && short.fade === '0px' && short.visibleRows === short.rows && short.bottomToFirst >= 0.95;
  report('suggestion-fade', error === null && controlOk && shortOk, { control, short, controlOk, shortOk, ...(error ? { error } : {}) });
}

if (CHECKS.has('search')) {
  await openSpeciesPanel();
  requests.length = 0;
  await page.click('#species-search');
  await page.type('#species-search', 'monarch', { delay: 40 });
  await page.waitForFunction(() => document.querySelectorAll('#species-suggestions button').length > 0, { timeout: 20000 });
  const first = await page.evaluate(() => document.querySelector('#species-suggestions button').textContent);
  await page.click('#species-suggestions button');
  await page.waitForFunction(() => window.__godsEyeView.dataManager.isEnabled('species'), { timeout: 20000 });
  await flyTo(-90, 30, 12_000_000);
  await sleep(6000);
  const tiles = requests.filter((u) => u.includes('/v2/map/occurrence/'));
  // A tile counts only with both licences, the taxon and srs=EPSG:3857: without srs GBIF serves EPSG:4326 tiles, which
  // Cesium's Web Mercator provider draws in the wrong place.
  const filtered = tiles.filter((u) => {
    const q = new URL(u).searchParams;
    return u.includes('/v2/map/occurrence/adhoc/') && q.getAll('license').includes('CC0_1_0') && q.getAll('license').includes('CC_BY_4_0') && q.get('taxonKey') === '5133088' && q.get('srs') === 'EPSG:3857';
  });
  // R-7t: unbinned circles laid out at the size GBIF serves. Every species tile request is an @1x PNG in the legend's style
  // (scaled.circles) with no bin parameter; the species provider declares SPECIES_TILE_SIZE_PX, and tiles GBIF drew (200), decoded in the
  // page, are exactly the declared size, so a mismatch between what is declared and what is served fails here.
  const zoomOf = (u) => new URL(u).pathname.split('/')[5];
  const styleMismatches = tiles.filter((u) => { const url = new URL(u); const q = url.searchParams; return q.get('style') !== SPECIES_MAP_LEGEND.style || ['bin', 'hexPerTile', 'squareSize'].some((key) => q.has(key)) || !url.pathname.endsWith('@1x.png'); });
  const drawnTiles = tiles.filter((u) => tileStatus.get(u) === 200).slice(0, 6);
  const layout = await page.evaluate(async (samples) => {
    const layers = window.__godsEyeView.viewer.imageryLayers;
    let provider = null;
    for (let i = 0; i < layers.length; i += 1) if (String(layers.get(i).imageryProvider?.url ?? '').includes('/v2/map/occurrence/')) provider = layers.get(i).imageryProvider;
    const served = [];
    for (const url of samples) {
      const img = new Image();
      img.src = url;
      try { await img.decode(); served.push({ z: new URL(url).pathname.split('/')[5], width: img.naturalWidth, height: img.naturalHeight }); } catch (error) { served.push({ url, error: String(error) }); }
    }
    return { declared: provider ? { tileWidth: provider.tileWidth, tileHeight: provider.tileHeight } : null, served };
  }, drawnTiles);
  const layoutOk = layout.declared?.tileWidth === SPECIES_TILE_SIZE_PX && layout.declared.tileHeight === SPECIES_TILE_SIZE_PX && layout.served.length > 0 && layout.served.every((tile) => tile.width === layout.declared.tileWidth && tile.height === layout.declared.tileHeight);
  const params = await page.evaluate(() => window.__godsEyeView.dataManager.getLayerParams('species'));
  // Ruling R-2a: the species layer counts only real HTTP/network tile errors (GBIF answers empty tiles with 204),
  // so after the tiles load its status must carry no error.
  const stats = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('species')?.module?.getStats() ?? null);
  const mapTiles = await waitForMapTiles();
  await shot('search');
  report('search', mapTiles.settled && first.startsWith('Monarch') && params?.taxonKey === 5133088 && tiles.length > 0 && filtered.length === tiles.length && styleMismatches.length === 0 && layoutOk && stats?.error === null, { mapTiles, first, params, stats, tiles: tiles.length, adhocWithBothLicences: filtered.length, zooms: [...new Set(tiles.map(zoomOf))].sort((a, b) => a - b), styleMismatches: styleMismatches.length, styleMismatchSample: styleMismatches.slice(0, 3), layout, layoutOk, srs: tiles[0] ? new URL(tiles[0]).searchParams.get('srs') : null, sample: tiles[0] || null });
}

let panelTaxon = null; // the panel's gbif.org link and the dataset search it sits under, for portal-link
if (CHECKS.has('panel-datasets')) {
  // R-7u: with the map of a taxon on, the panel lists that taxon's top 1-3 datasets for the years and licences, each a DOI or gbif.org
  // dataset link, then a link to the same records on gbif.org; the search the page sent carries the taxon, both licences, the years and a
  // 3-dataset facet. Never passes by skipping: without the map on it fails with a reason.
  const state = await page.evaluate(() => ({ enabled: window.__godsEyeView.dataManager.isEnabled('species'), params: window.__godsEyeView.dataManager.getLayerParams('species') }));
  let waited = null;
  if (state.enabled && state.params?.taxonKey) {
    // M-2: a failed search shows in the Top datasets block (its live region and Retry), so the wait ends on rows or on that failure.
    waited = await page.waitForFunction(() => document.querySelectorAll('#species-datasets .dataset-row').length > 0 || document.querySelector('#species-datasets .species-datasets-error'), { timeout: 45000 }).then(() => 'settled', (error) => String(error).slice(0, 120));
  }
  const panel = await page.evaluate(() => {
    const box = document.getElementById('species-datasets');
    const link = box?.querySelector('.species-datasets-link');
    return { hidden: box?.hidden ?? null, visible: Boolean(box && !box.hidden && box.getBoundingClientRect().height > 0), heading: box?.querySelector('.dataset-list-heading')?.textContent ?? null, link: link ? { href: link.getAttribute('href'), target: link.getAttribute('target'), rel: link.getAttribute('rel'), text: link.textContent } : null, status: document.getElementById('species-status')?.textContent ?? '' };
  });
  const rows = await readDatasetRows('#species-datasets .dataset-row');
  const failure = await page.evaluate(() => document.getElementById('species-datasets-status')?.textContent || null);
  const years = state.params?.years === 'all' ? null : `${new Date().getUTCFullYear() - 9},${new Date().getUTCFullYear()}`;
  const sent = datasetSearches.filter((u) => u.searchParams.get('taxonKey') === String(state.params?.taxonKey) && u.searchParams.get('year') === years).at(-1) || null;
  const link = panel.link ? new URL(panel.link.href) : null;
  const checks = {
    mapOn: state.enabled && Boolean(state.params?.taxonKey),
    noFailure: failure === null,
    rowsOk: datasetRowsOk(rows, 3),
    visible: panel.visible && panel.heading === 'Top datasets for this species',
    searchOk: Boolean(sent) && sent.searchParams.get('taxonKey') === String(state.params?.taxonKey) && sent.searchParams.get('hasCoordinate') === 'true' && !sent.searchParams.has('hasGeospatialIssue') && sent.searchParams.get('datasetKey.facetLimit') === '3' && sent.searchParams.get('limit') === '0' && JSON.stringify(sent.searchParams.getAll('license')) === JSON.stringify(['CC0_1_0', 'CC_BY_4_0']),
    // The link names the Backbone checklist its taxon key belongs to, in camelCase (portal-link compares its count with the API's).
    linkOk: Boolean(link) && link.origin + link.pathname === 'https://www.gbif.org/occurrence/search' && JSON.stringify([...link.searchParams.keys()]) === JSON.stringify(years ? ['taxonKey', 'checklistKey', 'hasCoordinate', 'license', 'license', 'year'] : ['taxonKey', 'checklistKey', 'hasCoordinate', 'license', 'license']) && link.searchParams.get('taxonKey') === String(state.params?.taxonKey) && link.searchParams.get('checklistKey') === GBIF_BACKBONE_CHECKLIST_KEY && link.searchParams.get('hasCoordinate') === 'true' && JSON.stringify(link.searchParams.getAll('license')) === JSON.stringify(['CC0_1_0', 'CC_BY_4_0']) && link.searchParams.get('year') === years && panel.link.target === '_blank' && /\bnoopener\b/.test(panel.link.rel || '') && /\bnoreferrer\b/.test(panel.link.rel || ''),
  };
  panelTaxon = panel.link ? { href: panel.link.href, sent: sent ? String(sent) : null } : null;
  const mapTiles = await waitForMapTiles();
  await shot('panel-datasets');
  report('panel-datasets', mapTiles.settled && Object.values(checks).every(Boolean), { mapTiles, ...(failure ? { failure } : {}), ...checks, waited, state, panel, rows, sent: sent ? String(sent) : null });
}

let hereSearch = null;
let hereCard = null; // the here check's card: its gbif.org link and filter line, for portal-link
const isHereSearch = (url) => { let u; try { u = new URL(url); } catch { return false; } return u.hostname === 'api.gbif.org' && u.pathname === '/v1/occurrence/search' && u.searchParams.get('facet') === 'speciesKey'; };
const AREA_OUTLINE_ROLE = 'what-lives-here-area'; // src/bio/whatLivesHere.js
const countOutlines = () => page.evaluate((role) => {
  const scene = window.__godsEyeView.viewer.scene;
  const count = (collection) => { let n = 0; for (let i = 0; i < collection.length; i += 1) if (collection.get(i)?.wildeyeRole === role) n += 1; return n; };
  return { groundPrimitives: count(scene.groundPrimitives), primitives: count(scene.primitives) };
}, AREA_OUTLINE_ROLE);
if (CHECKS.has('here')) {
  await openSpeciesPanel(); // so the here check also runs on its own (--checks here)
  await flyTo(-110.83, 44.46, 40_000);
  const hereRequestsFrom = requests.length;
  await page.click('#species-what-lives-here');
  const center = await page.evaluate(() => {
    const rect = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(center.x, center.y);
  await page.waitForFunction(() => document.querySelectorAll('#bio-card .bio-card-row').length > 0 || /failed|No CC0/.test(document.getElementById('bio-card')?.innerText || ''), { timeout: 45000 });
  const result = await page.evaluate(() => ({
    rows: document.querySelectorAll('#bio-card .bio-card-row').length,
    filter: document.querySelector('#bio-card .bio-card-filter')?.textContent || '',
    text: document.getElementById('bio-card').innerText.slice(0, 400),
    link: document.querySelector('#bio-card .bio-card-foot > a')?.href || null,
    footRel: document.querySelector('#bio-card .bio-card-foot > a')?.getAttribute('rel') ?? null,
    cardHeading: document.querySelector('#bio-card .bio-card-foot .dataset-list-heading')?.textContent ?? null,
    filterBox: (() => { const f = document.querySelector('#bio-card .bio-card-filter'); if (!f) return null; const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, color: getComputedStyle(f).color }; })(),
    body: (() => { const b = document.querySelector('#bio-card .bio-card-body'); return b ? { scrollHeight: b.scrollHeight, clientHeight: b.clientHeight, fade: getComputedStyle(b).getPropertyValue('--bio-card-body-fade').trim() } : null; })(),
    footOrder: [...(document.querySelector('#bio-card .bio-card-foot')?.children || [])].map((child) => child.className || child.tagName.toLowerCase()),
  }));
  const cardDatasets = await readDatasetRows('#bio-card .bio-card-foot .dataset-row');
  hereSearch = requests.slice(hereRequestsFrom).filter(isHereSearch).at(-1) || null;
  // The searched circle has one outline: a ground polyline that cannot be picked. The polygon vertices of the GBIF search lie
  // on it, so the probe uses one that no page element covers. Positive control: a pickable clamped polyline entity along the
  // same vertices is found by the same drillPick, so a miss on the outline is not a broken probe.
  const geometry = hereSearch ? new URL(hereSearch).searchParams.get('geometry') : null;
  const vertices = (geometry?.match(/^POLYGON\(\((.*)\)\)$/)?.[1] || '').split(',').filter(Boolean).map((pair) => pair.split(' ').map(Number));
  const outline = await page.evaluate(async (role, vertices) => {
    const viewer = window.__godsEyeView.viewer;
    const scene = viewer.scene;
    const Cartesian3 = viewer.camera.position.constructor;
    const Cartographic = viewer.camera.positionCartographic.constructor;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const found = [];
    for (let i = 0; i < scene.groundPrimitives.length; i += 1) if (scene.groundPrimitives.get(i)?.wildeyeRole === role) found.push(scene.groundPrimitives.get(i));
    const inPrimitives = [];
    for (let i = 0; i < scene.primitives.length; i += 1) if (scene.primitives.get(i)?.wildeyeRole === role) inPrimitives.push(i);
    if (found.length !== 1 || vertices.length < 4) return { count: found.length, inPrimitives: inPrimitives.length, vertices: vertices.length };
    const primitive = found[0];
    for (let t = 0; t < 100 && !primitive.ready; t += 1) await wait(100);
    const rect = scene.canvas.getBoundingClientRect();
    let probe = null;
    let probeXY = null;
    for (const [lon, lat] of vertices) {
      const height = scene.globe.getHeight(Cartographic.fromDegrees(lon, lat)) ?? 0;
      const xy = scene.cartesianToCanvasCoordinates(Cartesian3.fromDegrees(lon, lat, height));
      if (!xy) continue;
      const x = rect.left + xy.x;
      const y = rect.top + xy.y;
      if (document.elementFromPoint(x, y) === scene.canvas) { probe = { lon, lat, height, page: { x, y } }; probeXY = xy; break; }
    }
    if (!probe) return { count: 1, inPrimitives: inPrimitives.length, ready: primitive.ready, allowPicking: primitive.allowPicking, probe: null };
    const picks = () => scene.drillPick(probeXY, 10, 9, 9);
    const control = viewer.entities.add({ polyline: { positions: Cartesian3.fromDegreesArray(vertices.flat()), clampToGround: true, width: 4 } });
    let controlHit = false;
    for (let t = 0; t < 50 && !controlHit; t += 1) { await wait(200); controlHit = picks().some((picked) => picked?.id === control); }
    viewer.entities.remove(control);
    await wait(500);
    const outlineHit = picks().some((picked) => picked?.primitive === primitive);
    return { count: 1, inPrimitives: inPrimitives.length, ready: primitive.ready, allowPicking: primitive.allowPicking, probe, controlHit, outlineHit };
  }, AREA_OUTLINE_ROLE, vertices);
  // A real click on the outline changes neither the selection nor the card.
  let click = null;
  if (outline.probe) {
    const cardState = () => page.evaluate(() => ({ selected: window.__godsEyeView.viewer.selectedEntity?.id ?? null, hidden: document.getElementById('bio-card').hidden, text: document.getElementById('bio-card').innerText }));
    const before = await cardState();
    await page.mouse.click(outline.probe.page.x, outline.probe.page.y);
    await sleep(1500);
    const after = await cardState();
    click = { selectedBefore: before.selected, selectedAfter: after.selected, cardUnchanged: !after.hidden && after.text === before.text };
  }
  const mapTiles = await waitForMapTiles();
  await shot('what-lives-here');
  const outlineOk = outline.count === 1 && outline.inPrimitives === 0 && outline.allowPicking === false && outline.controlHit === true && outline.outlineHit === false && click?.selectedAfter === null && click?.cardUnchanged === true;
  hereCard = { href: result.link, filter: result.filter };
  report('here', mapTiles.settled && result.rows >= 1 && Boolean(result.link) && outlineOk, { mapTiles, ...result, outline, click, outlineOk });
  // R-7u: after a real search the card foot names 1-5 top datasets, each a DOI or gbif.org dataset link, above the gbif.org link; the search
  // asked for both facets with their own limits.
  const hereUrl = hereSearch ? new URL(hereSearch) : null;
  const facetsOk = Boolean(hereUrl) && hereUrl.searchParams.getAll('facet').join() === 'speciesKey,datasetKey' && hereUrl.searchParams.get('speciesKey.facetLimit') === '20' && hereUrl.searchParams.get('datasetKey.facetLimit') === '5' && !hereUrl.searchParams.has('facetLimit');
  const orderOk = result.footOrder.indexOf('dataset-list') === 0 && result.footOrder.at(-1) === 'a';
  // M3: the gbif.org link in the same foot opens with no opener and no referrer, like the dataset rows.
  const footRelOk = /\bnoopener\b/.test(result.footRel || '') && /\bnoreferrer\b/.test(result.footRel || '');
  // S3: the heading says whose datasets these are, and a species list taller than the card shows the scroll fade.
  const headingOk = result.cardHeading === 'Top datasets in this area';
  const cueOk = Boolean(result.body) && (result.body.scrollHeight <= result.body.clientHeight ? result.body.fade === '0px' : result.body.fade !== '0px');
  report('card-datasets', datasetRowsOk(cardDatasets, 5) && facetsOk && orderOk && footRelOk && headingOk && cueOk, { rows: cardDatasets, facetsOk, footOrder: result.footOrder, orderOk, footRel: result.footRel, footRelOk, cardHeading: result.cardHeading, headingOk, body: result.body, cueOk });
}

if (CHECKS.has('here')) {
  // Dismissing the card (Escape → onDismiss → cancel) removes the outline.
  const before = await countOutlines();
  await page.keyboard.press('Escape');
  await sleep(800);
  const after = await countOutlines();
  const cardHidden = await page.evaluate(() => document.getElementById('bio-card')?.hidden ?? null);
  report('here-dismiss', before.groundPrimitives === 1 && after.groundPrimitives === 0 && after.primitives === 0 && cardHidden === true, { before, after, cardHidden });
}

if (CHECKS.has('here')) {
  // R-7e: the outline lives exactly as long as the card shows that search's list. With a list showing, a real click on a marker
  // replaces it with the marker's details (the outline must go), and a real click on empty globe then deselects and closes the card
  // (nothing may come back). The marker is a point added to the occurrences data source inside the circle; the empty spot is one
  // where the canvas is on top and the scene picks nothing.
  // Any error becomes a failing line, and the cleanup runs in finally, so the occurrences layer, the selection and the qa marker are
  // restored either way; the line reports what the cleanup left.
  let listed = null;
  let spots = null;
  let detail = null;
  let closed = null;
  let error = null;
  let restored = null;
  try {
    await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('occurrences', true, { origin: 'user' }));
    await page.click('#species-what-lives-here');
    const centre = await page.evaluate(() => {
      const rect = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(centre.x, centre.y);
    await page.waitForFunction(() => document.querySelectorAll('#bio-card .bio-card-row').length > 0 || /failed|No CC0/.test(document.getElementById('bio-card')?.innerText || ''), { timeout: 45000 });
    listed = { ...(await countOutlines()), rows: await page.evaluate(() => document.querySelectorAll('#bio-card .bio-card-row').length) };
    spots = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const scene = viewer.scene;
      const Cartesian3 = viewer.camera.position.constructor;
      const Cartographic = viewer.camera.positionCartographic.constructor;
      let ds = null;
      for (let i = 0; i < viewer.dataSources.length; i += 1) if (viewer.dataSources.get(i).name === 'occurrences') ds = viewer.dataSources.get(i);
      if (!ds) return { error: 'no occurrences data source' };
      const rect = scene.canvas.getBoundingClientRect();
      const onScreen = (lon, lat) => {
        const height = scene.globe.getHeight(Cartographic.fromDegrees(lon, lat)) ?? 0;
        const xy = scene.cartesianToCanvasCoordinates(Cartesian3.fromDegrees(lon, lat, height));
        return xy ? { lon, lat, height, xy, page: { x: rect.left + xy.x, y: rect.top + xy.y } } : null;
      };
      const centreCarto = Cartographic.fromCartesian(viewer.camera.pickEllipsoid({ x: rect.width / 2, y: rect.height / 2 }, scene.globe.ellipsoid));
      const lon0 = centreCarto.longitude * (180 / Math.PI);
      const lat0 = centreCarto.latitude * (180 / Math.PI);
      const marker = onScreen(lon0, lat0 + 0.045); // about 5 km north of the clicked point, inside the 10 km circle
      ds.entities.removeById('qa-here-detail-marker');
      ds.entities.add({ id: 'qa-here-detail-marker', position: Cartesian3.fromDegrees(marker.lon, marker.lat, marker.height + 10), point: { pixelSize: 18, disableDepthTestDistance: Number.POSITIVE_INFINITY }, description: '<b>qa-here-detail marker</b>' });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let empty = null;
      for (const [dLon, dLat] of [[0, -0.05], [0.06, -0.05], [-0.06, -0.05], [0.06, 0.02], [-0.06, 0.02], [0, -0.09]]) {
        const spot = onScreen(lon0 + dLon, lat0 + dLat);
        if (!spot || document.elementFromPoint(spot.page.x, spot.page.y) !== scene.canvas) continue;
        if (scene.pick(spot.xy) === undefined) { empty = spot; break; }
      }
      const markerPick = scene.pick(marker.xy);
      return {
        marker: { page: marker.page, onCanvas: document.elementFromPoint(marker.page.x, marker.page.y) === scene.canvas, picksMarker: markerPick?.id?.id === 'qa-here-detail-marker' },
        empty: empty && { page: empty.page, lon: empty.lon, lat: empty.lat },
      };
    });
    const cardState = () => page.evaluate(() => ({ selected: window.__godsEyeView.viewer.selectedEntity?.id ?? null, hidden: document.getElementById('bio-card').hidden, text: document.getElementById('bio-card').innerText.slice(0, 120) }));
    if (spots.marker?.picksMarker && spots.empty) {
      await page.mouse.click(spots.marker.page.x, spots.marker.page.y);
      await sleep(2000);
      detail = { ...(await cardState()), outlines: await countOutlines() };
      await page.mouse.click(spots.empty.page.x, spots.empty.page.y);
      await sleep(2000);
      closed = { ...(await cardState()), outlines: await countOutlines() };
    }
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 500);
  } finally {
    restored = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      viewer.selectedEntity = undefined;
      let qaMarkerLeft = false;
      for (let i = 0; i < viewer.dataSources.length; i += 1) {
        const ds = viewer.dataSources.get(i);
        if (ds.name !== 'occurrences') continue;
        ds.entities.removeById('qa-here-detail-marker');
        qaMarkerLeft = ds.entities.getById('qa-here-detail-marker') !== undefined;
      }
      await window.__godsEyeView.dataManager.setEnabled('occurrences', false, { origin: 'user' });
      return { occurrencesEnabled: window.__godsEyeView.dataManager.isEnabled('occurrences'), selected: viewer.selectedEntity?.id ?? null, qaMarkerLeft };
    }).catch((caught) => ({ error: String(caught?.stack || caught).slice(0, 300) }));
  }
  const restoredOk = restored?.occurrencesEnabled === false && restored.selected === null && restored.qaMarkerLeft === false;
  const ok = error === null && restoredOk && listed?.groundPrimitives === 1 && listed.rows >= 1
    && detail?.selected === 'qa-here-detail-marker' && detail.hidden === false && detail.text.includes('qa-here-detail marker') && detail.outlines.groundPrimitives === 0
    && closed?.selected === null && closed.hidden === true && closed.outlines.groundPrimitives === 0 && closed.outlines.primitives === 0;
  report('here-detail', ok, { listed, spots, detail, closed, restored, ...(error ? { error } : {}) });
}

if (CHECKS.has('portal-link')) {
  // The gbif.org links a person opens. A script can check what each link says: its parameters, its length, and the record count api.gbif.org
  // v1 gives for the same parameters (taxonKey, checklistKey, hasCoordinate, hasGeospatialIssue, license, year, geometry), which must be the count the app showed
  // or used. It cannot check gbif.org's own page: www.gbif.org answers scripts with a bot check, and on 2026-09-14 it showed 0 results for
  // links whose API count was right (a Backbone taxon key read under its default Catalogue of Life XR checklist; a 1,508-character polygon).
  // Only a person clicking the links in forPeople verifies that.
  const MAX_PORTAL_URL = 1000; // a margin under the 1,508-character link gbif.org failed in a real browser, not a documented GBIF limit
  const PORTAL_TO_API = ['taxonKey', 'checklistKey', 'hasCoordinate', 'hasGeospatialIssue', 'license', 'year', 'geometry'];
  const parse = (url) => { try { return new URL(url); } catch { return null; } };
  const apiCount = async (href) => {
    const link = parse(href);
    if (!link || link.origin + link.pathname !== 'https://www.gbif.org/occurrence/search') return { error: `not a gbif.org occurrence search link: ${href}` };
    const unmapped = [...new Set(link.searchParams.keys())].filter((key) => !PORTAL_TO_API.includes(key));
    if (unmapped.length) return { error: `gbif.org parameters with no API mapping: ${unmapped.join(', ')}` };
    const api = new URL('https://api.gbif.org/v1/occurrence/search');
    for (const [key, value] of link.searchParams) api.searchParams.append(key, value);
    api.searchParams.set('limit', '0');
    try {
      const res = await fetch(api, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return { api: String(api), error: `HTTP ${res.status}` };
      return { api: String(api), count: (await res.json()).count };
    } catch (error) {
      return { api: String(api), error: String(error) };
    }
  };
  const cardTotal = (filter) => { const m = /· ([\d,]+) records$/.exec(filter || ''); return m ? Number(m[1].replace(/,/g, '')) : null; };
  const noDistance = (u) => !u.searchParams.has('geo_distance') && !u.searchParams.has('geoDistance');
  const licencesOk = (u) => JSON.stringify(u.searchParams.getAll('license')) === JSON.stringify(['CC0_1_0', 'CC_BY_4_0']);
  // An area link carries the search's own polygon, geospatial-issue filter, licences and years, no checklist, and its API count is the card's
  // record total.
  const areaLink = async (label, card, searchHref) => {
    const link = parse(card?.href);
    const sent = parse(searchHref);
    if (!link || !sent) return { label, ok: false, reason: !sent ? 'no what-lives-here GBIF search was captured' : 'the card has no gbif.org link', href: card?.href ?? null };
    const api = await apiCount(card.href);
    const total = cardTotal(card.filter);
    const checks = {
      geometryIsPolygon: /^POLYGON\(\(/.test(link.searchParams.get('geometry') || ''),
      geometryEqual: link.searchParams.get('geometry') === sent.searchParams.get('geometry'),
      issueFilterEqual: link.searchParams.get('hasGeospatialIssue') === 'false' && sent.searchParams.get('hasGeospatialIssue') === 'false',
      licencesEqual: licencesOk(link) && licencesOk(sent),
      yearEqual: sent.searchParams.get('year') !== null && link.searchParams.get('year') === sent.searchParams.get('year'),
      noDistanceParam: noDistance(link) && noDistance(sent),
      noChecklist: !link.searchParams.has('checklistKey'),
      lengthOk: card.href.length <= MAX_PORTAL_URL,
      countEqual: Number.isInteger(api.count) && api.count > 0 && api.count === total,
    };
    return { label, ok: Object.values(checks).every(Boolean), ...checks, href: card.href, length: card.href.length, vertices: (link.searchParams.get('geometry') || '').split(',').length, cardTotal: total, api };
  };
  // A new what-lives-here search from the SPECIES panel at a place and radius (its chip); the card is dismissed afterwards.
  const searchAt = async ({ lon, lat, radiusKm }) => {
    await openSpeciesPanel();
    await page.click(`#species-radius [data-radius="${radiusKm}"]`);
    await flyTo(lon, lat, 40_000);
    const from = requests.length;
    await page.click('#species-what-lives-here');
    const centre = await page.evaluate(() => { const rect = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
    await page.mouse.click(centre.x, centre.y);
    await page.waitForFunction(() => document.querySelectorAll('#bio-card .bio-card-row').length > 0 || /failed|No CC0/.test(document.getElementById('bio-card')?.innerText || ''), { timeout: 45000 });
    const card = await page.evaluate(() => ({ rows: document.querySelectorAll('#bio-card .bio-card-row').length, filter: document.querySelector('#bio-card .bio-card-filter')?.textContent || '', href: document.querySelector('#bio-card .bio-card-foot > a')?.getAttribute('href') ?? null, note: document.querySelector('#bio-card .bio-card-foot-note')?.textContent ?? null, text: document.getElementById('bio-card').innerText.slice(0, 200) }));
    const search = requests.slice(from).filter(isHereSearch).at(-1) || null;
    await page.keyboard.press('Escape');
    await sleep(800);
    return { ...card, search };
  };
  const results = [];
  let error = null;
  try {
    // 1. the here check's 10 km card
    results.push(await areaLink('card 10 km', hereCard, hereSearch));
    // 2. a 50 km search at the same spot: the longest polygon link
    const wide = await searchAt({ lon: -110.83, lat: 44.46, radiusKm: 50 });
    results.push({ ...(await areaLink('card 50 km', wide, wide.search)), rows: wide.rows, filter: wide.filter });
    // 3. a 50 km search across the antimeridian (Taveuni, Fiji): searched with geoDistance, so the link carries the licences and years only
    const across = await searchAt({ lon: 179.97, lat: -16.8, radiusKm: 50 });
    const acrossLink = parse(across.href);
    const acrossSent = parse(across.search);
    const acrossApi = across.href ? await apiCount(across.href) : null;
    const acrossChecks = {
      searchUsedDistance: Boolean(acrossSent) && acrossSent.searchParams.has('geoDistance') && !acrossSent.searchParams.has('geometry'),
      linkHasNoLocation: Boolean(acrossLink) && JSON.stringify([...acrossLink.searchParams.keys()]) === JSON.stringify(['license', 'license', 'year']) && licencesOk(acrossLink) && acrossLink.searchParams.get('year') === acrossSent?.searchParams.get('year'),
      noteShown: across.note === "gbif.org can't show this area as a circle",
      lengthOk: Boolean(across.href) && across.href.length <= MAX_PORTAL_URL,
      countPositive: Number.isInteger(acrossApi?.count) && acrossApi.count > 0,
    };
    results.push({ label: 'no-location card (50 km across 180°)', ok: Object.values(acrossChecks).every(Boolean), ...acrossChecks, href: across.href, length: across.href?.length ?? null, rows: across.rows, filter: across.filter, api: acrossApi });
    // 4. the SPECIES panel's link to the mapped taxon's records: the Backbone checklist, and the count of the dataset search the panel used
    const taxonLink = parse(panelTaxon?.href);
    const used = panelTaxon?.sent ? datasetSearchCounts.get(panelTaxon.sent) : undefined;
    const taxonApi = taxonLink ? await apiCount(panelTaxon.href) : null;
    const taxonChecks = {
      checklistKey: taxonLink?.searchParams.get('checklistKey') === GBIF_BACKBONE_CHECKLIST_KEY,
      lengthOk: Boolean(panelTaxon?.href) && panelTaxon.href.length <= MAX_PORTAL_URL,
      countEqual: Number.isInteger(taxonApi?.count) && taxonApi.count > 0 && taxonApi.count === used,
    };
    results.push({ label: 'panel taxon link', ok: Object.values(taxonChecks).every(Boolean), ...taxonChecks, href: panelTaxon?.href ?? null, length: panelTaxon?.href?.length ?? null, datasetSearch: panelTaxon?.sent ?? null, datasetSearchCount: used ?? null, api: taxonApi });
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 500);
  } finally {
    await page.click('#species-radius [data-radius="10"]').catch((caught) => { error = `${error ?? ''} restoring the 10 km radius: ${caught}`; });
  }
  report('portal-link', error === null && results.length === 4 && results.every((r) => r.ok), { results, ...(error ? { error } : {}), forPeople: { card50km: results[1]?.href ?? null, panelTaxon: results[3]?.href ?? null, noLocation: results[2]?.href ?? null } });
}

report('no-failed-requests', failed.length === 0, { failed: [...new Set(failed)].slice(0, 10), upstreamTileErrors: upstreamTileErrors.slice(0, 10) });
await browser.close();
process.exit(bad ? 1 : 0);
