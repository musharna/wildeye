#!/usr/bin/env node
/**
 * qa-species.mjs — real-browser checks for the biology details card, species search and "what lives here".
 * Run: node scripts/qa-species.mjs --url http://localhost:4488/wildeye/ [--checks panel-layout,left-stack,contrast,card-foot-rest,panel-fold,collapsed-pills,fuzzy-match,card,suggestion-fade,escape,search,panel-datasets,here,portal-link,card-a11y] [--shots <dir>]
 * Prints one JSON line per check; exits 1 when any check fails.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { GBIF_BACKBONE_CHECKLIST_KEY, SPECIES_MAP_LEGEND, SPECIES_TILE_SIZE_PX } from '../src/bio/gbif.js';
import { MORE_SLACK_PX } from '../src/bio/moreCue.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
// I2: a desktop window height at which the whole SPECIES panel body fits (round-10 build: nothing overflowed at 1,100, 1,300 and 1,700 px).
const TALL_DESKTOP_HEIGHT = 1100;
const CHECKS = new Set(arg('--checks', 'panel-layout,left-stack,contrast,card-foot-rest,panel-fold,collapsed-pills,fuzzy-match,card,suggestion-fade,escape,search,panel-datasets,here,portal-link,card-a11y').split(','));
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

// The contrast method (qa contrast, and the collapsed pills in qa collapsed-pills): see the contrast check's comment.
const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const addStyle = (id, css) => page.evaluate((id, css) => { const style = document.createElement('style'); style.id = id; style.textContent = css; document.head.appendChild(style); }, id, css);
const removeStyle = (id) => page.evaluate((id) => document.getElementById(id)?.remove(), id);
const hideText = (root) => `${root}, ${root} *, ${root} *::before, ${root} *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; transition: none !important; } ${root} input::placeholder { color: transparent !important; }`;
const installContrast = () => page.evaluate(() => {
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const parseColor = (text) => { const parts = (text.match(/[\d.]+/g) || []).map(Number); return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }; };
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + [...el.classList].map((name) => `.${name}`).join('');
  const opacityOf = (el) => { let opacity = 1; for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity); return opacity; };
  // A box clipped to the view of the element itself and of every ancestor that clips (an ellipsised name's line box runs on under the switch
  // beside it) and to the window; null when nothing of it can be seen.
  const clip = (box, el) => {
    let b = { ...box };
    for (let node = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const r = node.getBoundingClientRect();
      b = { left: Math.max(b.left, r.left + node.clientLeft), top: Math.max(b.top, r.top + node.clientTop), right: Math.min(b.right, r.left + node.clientLeft + node.clientWidth), bottom: Math.min(b.bottom, r.top + node.clientTop + node.clientHeight) };
    }
    b = { left: Math.max(b.left, 0), top: Math.max(b.top, 0), right: Math.min(b.right, innerWidth), bottom: Math.min(b.bottom, innerHeight) };
    return b.right - b.left >= 1 && b.bottom - b.top >= 1 ? b : null;
  };
  const decode = async (png) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { width: img.width, data: ctx.getImageData(0, 0, img.width, img.height).data, scale: img.width / innerWidth };
  };
  window.__qaContrast = {
    collect(rootSelector, parkedSelector, nonTextSelector) {
      const root = document.querySelector(rootSelector);
      if (!root) throw new Error(`contrast: ${rootSelector} is missing`);
      const rootBox = root.getBoundingClientRect();
      const items = new Map();
      // Text kept for screen readers only (a 1 px box, like the phone's "Find a species" label) is reported, not gated: nobody sees it.
      const screenReaderOnly = (el) => { const r = el.getBoundingClientRect(); return r.width <= 1 || r.height <= 1; };
      const add = (el, text, rects, color) => {
        // Text with no layout box (display: none, a hidden list) is not on the page. Text laid out but clipped out of view at this scroll
        // position is registered with no boxes, so text that no scroll position shows is reported unmeasured instead of being skipped.
        if (el.getClientRects().length === 0) return;
        const key = `${describe(el)}|${text.slice(0, 60)}`;
        const hiddenFromSight = screenReaderOnly(el);
        const item = items.get(key) || { key, label: describe(el), text: text.slice(0, 60), color, opacity: opacityOf(el), rects: [], gate: !hiddenFromSight && !(parkedSelector && el.closest(parkedSelector)), screenReaderOnly: hiddenFromSight, min: el.closest(nonTextSelector) ? 3 : 4.5, control: el.id === 'qa-contrast-control' ? 'dim' : el.id === 'qa-contrast-unseen-control' ? 'unseen' : false };
        item.rects.push(...rects);
        // Text drawn outside its surface's box is not on the surface's ground.
        item.outside = Boolean(item.outside) || rects.some((r) => r.left < rootBox.left - 0.5 || r.right > rootBox.right + 0.5 || r.top < rootBox.top - 0.5 || r.bottom > rootBox.bottom + 0.5);
        items.set(key, item);
      };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const el = node.parentElement;
        const cs = getComputedStyle(el);
        if (cs.visibility !== 'visible' || opacityOf(el) === 0) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        add(el, text, [...range.getClientRects()].map((r) => clip({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, el)).filter(Boolean), parseColor(cs.color));
      }
      // An input's value or placeholder: its content box, as wide as the text (the clear button sits to its right).
      for (const input of root.querySelectorAll('input')) {
        const cs = getComputedStyle(input);
        if (cs.visibility !== 'visible' || input.getClientRects().length === 0) continue;
        const text = input.value || input.placeholder;
        if (!text) continue;
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = cs.font;
        const r = input.getBoundingClientRect();
        const left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        const right = Math.min(left + ctx.measureText(text).width, r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight));
        const box = clip({ left, top: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop), right, bottom: r.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom) }, input);
        add(input, `${input.value ? 'value' : 'placeholder'}: ${text}`, box ? [box] : [], parseColor(input.value ? cs.color : getComputedStyle(input, '::placeholder').color));
      }
      return [...items.values()];
    },
    async analyse(png, items) {
      const { width, data, scale } = await decode(png);
      return items.map((item) => {
        const alpha = item.color.a * item.opacity;
        const text = [item.color.r, item.color.g, item.color.b];
        let worst = null;
        let pixels = 0;
        for (const r of item.rects) {
          for (let y = Math.ceil(r.top * scale); y < Math.floor(r.bottom * scale); y += 1) {
            for (let x = Math.ceil(r.left * scale); x < Math.floor(r.right * scale); x += 1) {
              const i = (y * width + x) * 4;
              const bg = [data[i], data[i + 1], data[i + 2]];
              const fg = text.map((channel, k) => alpha * channel + (1 - alpha) * bg[k]);
              const lf = lum(...fg);
              const lb = lum(...bg);
              const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
              pixels += 1;
              if (!worst || ratio < worst.ratio) worst = { ratio, bg };
            }
          }
        }
        return { key: item.key, label: item.label, text: item.text, color: item.color, opacity: item.opacity, gate: item.gate, screenReaderOnly: item.screenReaderOnly, outside: item.outside, min: item.min, control: item.control, pixels, ratio: worst ? +worst.ratio.toFixed(2) : null, worstBg: worst?.bg ?? null };
      });
    },
    async behind(png, box) {
      const { width, data, scale } = await decode(png);
      const values = [];
      for (let y = Math.ceil(box.top * scale); y < Math.floor(box.bottom * scale); y += 2) {
        for (let x = Math.ceil(box.left * scale); x < Math.floor(box.right * scale); x += 2) { const i = (y * width + x) * 4; values.push(lum(data[i], data[i + 1], data[i + 2])); }
      }
      values.sort((p, q) => p - q);
      if (!values.length) return { pixels: 0, medianL: null };
      return { pixels: values.length, p10L: +values[Math.floor(values.length * 0.1)].toFixed(3), medianL: +values[Math.floor(values.length / 2)].toFixed(3), maxL: +values.at(-1).toFixed(3) };
    },
  };
});

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

// R9-I1 and R10-I1: the left lane follows the data panel's visibility, including while it changes. The data panel is visibility: hidden without
// .active, which the F key toggles, and in clean view and recording mode; its visibility, opacity and transform transition over 300 ms. At
// 1400x900, with the data panel expanded and the other stack panels collapsed:
// - the shown panel puts the lane in focus mode (its list is taller than the lane), the positive control;
// - hiding it (F, clean view on, recording mode on) settles the lane out of focus mode with the SCENE and SPECIES pills laid out;
// - showing it (F, clean view off, recording mode off) has no frame, sampled on every animation frame, where the panel is visible with opacity
//   above 0 and the lane is not in the shown mode, the panel is under 100 px tall or a pill is laid out: it fades in at full height;
// - clean view on and off from the F-hidden state keeps the lane's mode.
// Each step waits for a visibility transition on a stack panel where one is expected and throws when none arrives in 3 s. panel-layout checks
// that the SPECIES body does not overflow on a window at least 1,000 px tall.
if (CHECKS.has('left-stack')) {
  await page.setViewport({ width: 1400, height: 900 });
  await sleep(2000);
  const initial = await page.evaluate(() => {
    const data = document.getElementById('data-panel');
    const open = ['scene-panel', 'species-panel', 'cctv-panel'].filter((id) => { const panel = document.getElementById(id); return panel && !panel.classList.contains('collapsed'); });
    return { collapsed: data.classList.contains('collapsed'), active: data.classList.contains('active'), cleanView: document.body.classList.contains('ui-clean-view'), recording: document.body.classList.contains('recording-mode'), open };
  });
  await page.evaluate(() => {
    // Samples the lane on every animation frame until a visibility transition on a stack panel has ended and 10 more frames have drawn, or,
    // when none is expected, for 1.2 s; 3 s at most.
    window.__qaSampleLane = (expectTransition) => new Promise((resolve) => {
      const stack = document.getElementById('left-panel-stack');
      const data = document.getElementById('data-panel');
      const frames = [];
      const started = performance.now();
      let ended = null;
      let framesAfterEnd = 0;
      const onEnd = (event) => { if (ended === null && event.propertyName === 'visibility' && event.target.parentElement === stack) ended = Math.round(performance.now() - started); };
      stack.addEventListener('transitionend', onEnd);
      const pill = (id) => { const el = document.getElementById(id); return { display: getComputedStyle(el).display, height: +el.getBoundingClientRect().height.toFixed(1) }; };
      const tick = () => {
        const cs = getComputedStyle(data);
        frames.push({ t: Math.round(performance.now() - started), visibility: cs.visibility, opacity: +Number(cs.opacity).toFixed(3), height: +data.getBoundingClientRect().height.toFixed(1), mode: stack.dataset.layoutMode, scene: pill('scene-panel'), species: pill('species-panel') });
        if (ended !== null) framesAfterEnd += 1;
        const elapsed = performance.now() - started;
        if ((ended !== null && framesAfterEnd > 10) || (!expectTransition && elapsed > 1200) || elapsed > 3000) {
          stack.removeEventListener('transitionend', onEnd);
          resolve({ ended, frames });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  const stackState = () => page.evaluate(() => {
    const stack = document.getElementById('left-panel-stack');
    const panel = (id) => {
      const el = document.getElementById(id);
      const cs = getComputedStyle(el);
      return { collapsed: el.classList.contains('collapsed'), active: el.classList.contains('active'), display: cs.display, visibility: cs.visibility, opacity: Number(cs.opacity), height: +el.getBoundingClientRect().height.toFixed(1), ariaHidden: el.getAttribute('aria-hidden'), allocated: el.style.getPropertyValue('--left-panel-allocated-height') || null };
    };
    return { mode: stack.dataset.layoutMode, focusClass: stack.classList.contains('layout-focus'), cleanView: document.body.classList.contains('ui-clean-view'), recording: document.body.classList.contains('recording-mode'), data: panel('data-panel'), scene: panel('scene-panel'), species: panel('species-panel') };
  });
  const pressKey = (key) => () => page.keyboard.press(key);
  const setRecording = (on) => () => page.evaluate((on) => window.__godsEyeView.styleManager.setRecordingMode(on), on);
  // Runs one step with the lane sampled from before it, then reads the settled state. A missing expected transition throws.
  const step = async (label, act, { transition }) => {
    const sampling = page.evaluate((expect) => window.__qaSampleLane(expect), transition);
    await act();
    const sampled = await sampling;
    if (transition && sampled.ended === null) throw new Error(`left-stack: no visibility transition on a stack panel within 3 s after ${label}`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await sleep(800);
    const settled = await stackState();
    const visible = sampled.frames.filter((frame) => frame.visibility === 'visible' && frame.opacity > 0);
    return { label, ended: sampled.ended, frames: sampled.frames.length, firstVisible: visible[0] ?? null, visibleFrames: visible, settled };
  };
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    const sm = window.__godsEyeView.styleManager;
    if (document.body.classList.contains('recording-mode')) sm.setRecordingMode(false);
    if (document.body.classList.contains('ui-clean-view')) sm.toggleCleanView(false);
    for (const id of ['scene-panel', 'species-panel', 'cctv-panel']) {
      const panel = document.getElementById(id);
      if (panel && !panel.classList.contains('collapsed')) panel.querySelector(`[data-collapse-target="${id}"]`)?.click();
    }
    const data = document.getElementById('data-panel');
    if (data.classList.contains('collapsed')) data.querySelector('[data-collapse-target="data-panel"]').click();
  });
  // The positive control is read once the lane has laid out the expanded panel: an allocated height, and the same mode and panel height on 4
  // reads 250 ms apart. A fixed 1.5 s wait read it mid-expansion on a loaded host (251 px, no allocation, normal mode). 20 s at most, then throw.
  const settledLane = async (label) => {
    const started = Date.now();
    let last = null;
    let same = 0;
    while (Date.now() - started < 20000) {
      const state = await stackState();
      const key = `${state.mode} ${state.data.height} ${state.data.allocated}`;
      same = state.data.allocated !== null && key === last ? same + 1 : 0;
      last = key;
      if (same >= 3) return state;
      await sleep(250);
    }
    throw new Error(`left-stack: the lane did not settle within 20 s ${label} (last: ${last})`);
  };
  await settledLane('after expanding the data panel');
  const setup = (await page.evaluate(() => document.getElementById('data-panel').classList.contains('active'))) ? null : await step('F to show the panel before the check', pressKey('f'), { transition: true });
  const shown = await settledLane('with the data panel shown');
  const hideF = await step('F hide', pressKey('f'), { transition: true });
  await shot('left-stack-f-hidden');
  const cleanOnHidden = await step('clean view on from F-hidden', pressKey('v'), { transition: false });
  const cleanOffHidden = await step('clean view off to F-hidden', pressKey('v'), { transition: false });
  const showF = await step('F show', pressKey('f'), { transition: true });
  const cleanOnVisible = await step('clean view on from shown', pressKey('v'), { transition: true });
  const cleanOffVisible = await step('clean view off to shown', pressKey('v'), { transition: true });
  const recordingOn = await step('recording mode on from shown', setRecording(true), { transition: true });
  const recordingOff = await step('recording mode off to shown', setRecording(false), { transition: true });
  // A frame part-way through the F show fade, for the critic: F hides, then F shows. Two frames later, after the lane's passes at the start of
  // the show, the data panel's transitions are held at 150 ms, half their duration, because a capture under swiftshader takes longer than the
  // whole fade; its opacity and height are read just before and after the capture, and the transitions then play on.
  await step('F hide before the mid-fade shot', pressKey('f'), { transition: true });
  const midFadeRead = () => page.evaluate(() => {
    const data = document.getElementById('data-panel');
    const cs = getComputedStyle(data);
    const pill = (id) => { const el = document.getElementById(id); return { display: getComputedStyle(el).display, height: +el.getBoundingClientRect().height.toFixed(1) }; };
    return { visibility: cs.visibility, opacity: +Number(cs.opacity).toFixed(3), height: +data.getBoundingClientRect().height.toFixed(1), mode: document.getElementById('left-panel-stack').dataset.layoutMode, scene: pill('scene-panel'), species: pill('species-panel') };
  });
  await page.keyboard.press('f');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const held = await page.evaluate(() => { const animations = document.getElementById('data-panel').getAnimations(); for (const animation of animations) { animation.pause(); animation.currentTime = 150; } return animations.map((animation) => animation.transitionProperty); });
  const midFadeBefore = await midFadeRead();
  await shot('left-stack-f-show-midfade');
  const midFadeAfter = await midFadeRead();
  await page.evaluate(() => { for (const animation of document.getElementById('data-panel').getAnimations()) animation.play(); });
  await sleep(1500);
  const final = await stackState();
  // Back to the state before the check.
  if (final.data.active !== initial.active) await step('F back to the initial state', pressKey('f'), { transition: true });
  await page.evaluate((initial) => {
    const sm = window.__godsEyeView.styleManager;
    const data = document.getElementById('data-panel');
    if (data.classList.contains('collapsed') !== initial.collapsed) data.querySelector('[data-collapse-target="data-panel"]').click();
    for (const id of initial.open) { const panel = document.getElementById(id); if (panel?.classList.contains('collapsed')) panel.querySelector(`[data-collapse-target="${id}"]`)?.click(); }
    if (initial.cleanView) sm.toggleCleanView(true);
    if (initial.recording) sm.setRecordingMode(true);
  }, initial);
  await sleep(1000);
  const laidOut = (panel) => panel.collapsed && panel.display !== 'none' && panel.height > 0 && panel.ariaHidden === null;
  const pillShown = (panel) => laidOut(panel) && panel.visibility === 'visible';
  const shownOk = shown.data.active && !shown.data.collapsed && shown.data.visibility === 'visible' && shown.mode === 'focus';
  // A hiding step: the panel stays at its height while it can be seen, and the lane settles out of focus mode with the pills laid out.
  const hideOk = (result) => result.visibleFrames.every((frame) => frame.height >= 100) && result.settled.data.visibility === 'hidden' && result.settled.mode !== 'focus' && !result.settled.focusClass && laidOut(result.settled.scene) && laidOut(result.settled.species);
  // A showing step: every frame where the panel can be seen is already in the shown mode, at 100 px or more, with both pills out of layout.
  const showOk = (result) => result.firstVisible !== null && result.visibleFrames.every((frame) => frame.mode === shown.mode && frame.height >= 100 && frame.scene.display === 'none' && frame.species.display === 'none') && result.settled.data.visibility === 'visible' && result.settled.mode === shown.mode;
  // R11-M1 (final review M7): the sampled show steps need a visible frame but not one mid-fade, and swiftshader can draw a 300 ms fade in no frame
  // at all. The frame held at 150 ms of the F show is mid-fade by construction, so it is gated: visible, 0 < opacity < 1, at least 100 px tall,
  // in the shown state's mode, and both pills out of layout, on the reads just before and just after its capture.
  const heldFrameOk = (frame) => frame.visibility === 'visible' && frame.opacity > 0 && frame.opacity < 1 && frame.height >= 100 && frame.mode === shown.mode && frame.scene.display === 'none' && frame.species.display === 'none';
  const checks = {
    shownOk,
    midFadeOk: heldFrameOk(midFadeBefore) && heldFrameOk(midFadeAfter),
    hideFOk: hideOk(hideF) && pillShown(hideF.settled.scene) && pillShown(hideF.settled.species),
    cleanFromHiddenOk: cleanOnHidden.settled.cleanView && !cleanOffHidden.settled.cleanView && cleanOnHidden.settled.mode === hideF.settled.mode && cleanOffHidden.settled.mode === hideF.settled.mode && pillShown(cleanOffHidden.settled.scene) && pillShown(cleanOffHidden.settled.species),
    showFOk: showOk(showF),
    cleanOnVisibleOk: cleanOnVisible.settled.cleanView && hideOk(cleanOnVisible),
    cleanOffVisibleOk: !cleanOffVisible.settled.cleanView && showOk(cleanOffVisible),
    recordingOnOk: recordingOn.settled.recording && hideOk(recordingOn),
    recordingOffOk: !recordingOff.settled.recording && showOk(recordingOff),
  };
  // The report keeps each step's first visible frame and every frame that breaks its rule, not the whole timeline.
  const summarize = (result, rule) => ({ label: result.label, ended: result.ended, frames: result.frames, firstVisible: result.firstVisible, broken: result.visibleFrames.filter((frame) => !rule(frame)).slice(0, 5), settled: { mode: result.settled.mode, data: result.settled.data, scene: result.settled.scene, species: result.settled.species } });
  const showRule = (frame) => frame.mode === shown.mode && frame.height >= 100 && frame.scene.display === 'none' && frame.species.display === 'none';
  const hideRule = (frame) => frame.height >= 100;
  report('left-stack', Object.values(checks).every(Boolean), {
    initial, setup: setup && setup.label, shown,
    steps: [summarize(hideF, hideRule), summarize(cleanOnHidden, hideRule), summarize(cleanOffHidden, hideRule), summarize(showF, showRule), summarize(cleanOnVisible, hideRule), summarize(cleanOffVisible, showRule), summarize(recordingOn, hideRule), summarize(recordingOff, showRule)],
    midFade: { held, before: midFadeBefore, after: midFadeAfter }, final: { mode: final.mode, data: final.data },
    ...checks,
  });
}

// I1 (final review): WCAG contrast of every text in the SPECIES panel and the details card, in forced error states, over the lightest basemap the
// app shows: the OSM street map from low altitude with the scope mask off (both are user settings), at 1400x900 and 375x667.
// - Failures are forced in the page's fetch, which answers HTTP 503 itself, so nothing reaches the network or no-failed-requests: the name
//   search and the Top datasets search in the panel; the what-lives-here search in a status card; and the name and dataset lookups in a list
//   card across the antimeridian, whose foot also carries its "can't show this area as a circle" note. The panel's species is chosen through a
//   real GBIF match that answers FUZZY (iNaturalist's suggestion is answered in the page as "Danaus plexippa"), so its note is measured too (M1).
// - Method: each text node's line boxes, clipped to their scroll view and the window, are read with the text's colour and opacity. The text is
//   then made transparent and the page captured, so each pixel under a line box is the ground that text is drawn on. The text colour is
//   composited over each of those pixels, and the lowest WCAG ratio is the text's. Each scroll container of a surface (the card's body and its
//   foot) is stepped through, and text that no position shows fails as unmeasured. Text needs 4.5:1, the card's close × (non-text) 3:1.
// - The host header (the SPECIES title and its button) is gated like the rest since brief B brought the shared pill and header text to 0.8
//   white (it was parked with R-7ii S2 at the shared 0.3 white).
// - Controls in the same check: each forced message is present; the map behind each surface, captured with the surface hidden, has a median
//   relative luminance of at least 0.5; a 0.3-white control line placed in each surface measures under 4.5:1; and a control line laid out where
//   no scroll position shows it comes back unmeasured.
if (CHECKS.has('contrast')) {
  const VIEWPORTS = [[1400, 900], [375, 667]];
  const AUSTIN = [-97.74, 30.27, 3000]; // central Austin from 3 km: OSM blocks, streets and parks
  const TAVEUNI = [179.97, -16.8, 10000]; // Taveuni, Fiji: a 50 km circle there crosses the antimeridian (the portal-link check's spot)
  const TEXT_MIN = 4.5;
  const MAP_BEHIND_MIN_L = 0.5;
  // One iNaturalist suggestion naming a misspelling, which the real strict GBIF match answers FUZZY (5133088 Danaus plexippus).
  const FUZZY_SUGGESTION = { total_results: 1, page: 1, per_page: 1, results: [{ id: 48662, name: 'Danaus plexippa', rank: 'species', preferred_common_name: 'Monarch', matched_term: 'Monarch' }] };
  const INAT_AUTOCOMPLETE = '^https://api\\.inaturalist\\.org/v1/taxa/autocomplete';
  const TAXON_DATASET_SEARCH = '^https://api\\.gbif\\.org/v1/occurrence/search\\?(?=.*taxonKey=)';
  // Each rule is a URL pattern the page's fetch answers with HTTP 503, or { pattern, body }, answered 200 with that JSON.
  const setFailures = (rules) => page.evaluate((rules) => {
    if (!window.__qaFetchOriginal) {
      window.__qaFetchOriginal = window.fetch;
      window.__qaFetchForced = [];
      window.fetch = (input, init) => {
        const url = String(input?.url ?? input);
        const rule = (window.__qaFetchRules || []).find((r) => new RegExp(typeof r === 'string' ? r : r.pattern).test(url));
        if (rule) {
          window.__qaFetchForced.push(url);
          return Promise.resolve(typeof rule === 'string'
            ? new Response('{"qa":"forced failure"}', { status: 503, headers: { 'content-type': 'application/json' } })
            : new Response(JSON.stringify(rule.body), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return window.__qaFetchOriginal.call(window, input, init);
      };
    }
    window.__qaFetchRules = rules;
    window.__qaFetchForced.length = 0;
  }, rules);
  const forcedCount = () => page.evaluate(() => window.__qaFetchForced?.length ?? 0);
  const canvasCentre = () => page.evaluate(() => { const rect = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
  const collapseSpecies = async () => { await page.evaluate(() => { const panel = document.getElementById('species-panel'); if (!panel.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click(); }); await sleep(800); };
  const closeCard = async () => { await page.evaluate(() => { const card = document.getElementById('bio-card'); if (card && !card.hidden) card.querySelector('.bio-card-close').click(); }); await sleep(500); };
  await installContrast();
  // One surface in its current state: the map behind it, then every text at each scroll position of each of its scroll containers, then a
  // capture for the critic.
  const measureSurface = async (name, { root, scrollers = [], parked = null, nonText = '.bio-card-close' }) => {
    const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.mouse.move(Math.round(width / 2), Math.round(height * 0.45)); // no hover on a surface
    await page.evaluate(() => document.activeElement?.blur?.());
    await addStyle('qa-contrast-hide-surface', `${root} { opacity: 0 !important; transition: none !important; }`);
    await frames();
    await sleep(300);
    const box = await page.evaluate((root) => { const r = document.querySelector(root).getBoundingClientRect(); return { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom) }; }, root);
    const behind = await page.evaluate((png, box) => window.__qaContrast.behind(png, box), await page.screenshot({ encoding: 'base64' }), box);
    await removeStyle('qa-contrast-hide-surface');
    await page.evaluate((root) => {
      const span = document.createElement('span');
      span.id = 'qa-contrast-control';
      span.textContent = 'qa control, 0.3 white';
      span.style.cssText = 'position: absolute; left: 16px; bottom: 3px; font: 11px/1 var(--font-sans); color: rgba(232, 234, 237, 0.3); pointer-events: none; white-space: nowrap;';
      document.querySelector(root).appendChild(span);
      // The unseen control: laid out far above the surface, where no scroll position shows it, so it must come back unmeasured.
      const unseen = document.createElement('span');
      unseen.id = 'qa-contrast-unseen-control';
      unseen.textContent = 'qa unseen control';
      unseen.style.cssText = 'position: absolute; left: 16px; top: -4000px; font: 11px/1 var(--font-sans); color: rgba(232, 234, 237, 0.8); pointer-events: none; white-space: nowrap;';
      document.querySelector(root).appendChild(unseen);
    }, root);
    await frames();
    await sleep(500);
    // Each scroll container is stepped through its range in turn, with the others at their top.
    const steps = [{ scroller: null, position: 0 }];
    for (const scroller of scrollers) {
      const range = await page.evaluate((s) => { const el = document.querySelector(s); return el ? { max: el.scrollHeight - el.clientHeight, step: Math.max(40, Math.floor(el.clientHeight * 0.8)) } : null; }, scroller);
      if (!range || range.max <= 0) continue;
      for (let p = range.step; p < range.max; p += range.step) steps.push({ scroller, position: p });
      steps.push({ scroller, position: range.max });
    }
    const merged = new Map();
    for (const { scroller, position } of steps) {
      await page.evaluate((scrollers, active, p) => { for (const s of scrollers) { const el = document.querySelector(s); if (el) el.scrollTop = s === active ? p : 0; } }, scrollers, scroller, position);
      await sleep(400);
      const items = await page.evaluate((root, parked, nonText) => window.__qaContrast.collect(root, parked, nonText), root, parked, nonText);
      await addStyle('qa-contrast-hide-text', hideText(root));
      await frames();
      await sleep(200);
      const png = await page.screenshot({ encoding: 'base64' });
      await removeStyle('qa-contrast-hide-text');
      for (const item of await page.evaluate((png, items) => window.__qaContrast.analyse(png, items), png, items)) {
        const prior = merged.get(item.key);
        const pixels = (prior?.pixels ?? 0) + item.pixels;
        const outside = Boolean(prior?.outside) || item.outside;
        if (!prior || (item.ratio !== null && (prior.ratio === null || item.ratio < prior.ratio))) merged.set(item.key, { ...item, pixels, outside });
        else Object.assign(prior, { pixels, outside });
      }
      await frames();
      await sleep(500); // the colours transition back before the next read
    }
    await page.evaluate((scrollers) => {
      for (const id of ['qa-contrast-control', 'qa-contrast-unseen-control']) document.getElementById(id)?.remove();
      for (const s of scrollers) { const el = document.querySelector(s); if (el) el.scrollTop = 0; }
    }, scrollers);
    await sleep(400);
    await shot(`contrast-${name}`);
    const items = [...merged.values()];
    const control = items.find((item) => item.control === 'dim') || null;
    const unseenControl = items.find((item) => item.control === 'unseen') || null;
    const gated = items.filter((item) => item.gate && !item.control);
    const classes = {};
    for (const item of gated) { if (!classes[item.label] || (item.ratio ?? 0) < (classes[item.label].ratio ?? Infinity)) classes[item.label] = { ratio: item.ratio, min: item.min, text: item.text, worstBg: item.worstBg }; }
    const failing = gated.filter((item) => item.ratio !== null && item.ratio < item.min).map(({ key, ratio, min, color, worstBg }) => ({ key, ratio, min, color, worstBg }));
    const unmeasured = gated.filter((item) => item.ratio === null).map((item) => item.key);
    const outside = gated.filter((item) => item.outside).map((item) => item.key);
    const ok = behind.medianL !== null && behind.medianL >= MAP_BEHIND_MIN_L && gated.length >= 4 && failing.length === 0 && unmeasured.length === 0 && outside.length === 0 && control?.ratio != null && control.ratio < TEXT_MIN && unseenControl !== null && unseenControl.ratio === null && unseenControl.pixels === 0;
    return { name, ok, behind, positions: steps.length, measured: gated.length, classes, failing, unmeasured, outside, control: control && { ratio: control.ratio, pixels: control.pixels }, unseenControl: unseenControl && { ratio: unseenControl.ratio, pixels: unseenControl.pixels }, parked: items.filter((item) => !item.gate && !item.control).map(({ key, ratio, screenReaderOnly }) => ({ key, ratio, ...(screenReaderOnly ? { screenReaderOnly } : {}) })) };
  };
  const initial = await page.evaluate(() => {
    const view = window.__godsEyeView;
    const c = view.viewer.camera;
    window.__qaContrastCamera = { position: c.position.clone(), heading: c.heading, pitch: c.pitch, roll: c.roll };
    return { stack: view.mapStackController.getState().activeId, scope: document.getElementById('scope-toggle')?.getAttribute('aria-pressed') ?? null, speciesCollapsed: document.getElementById('species-panel').classList.contains('collapsed'), speciesEnabled: view.dataManager.isEnabled('species'), params: view.dataManager.getLayerParams('species') };
  });
  const surfaces = [];
  const settings = {};
  let error = null;
  let restored = null;
  try {
    settings.stack = await page.evaluate(async () => (await window.__godsEyeView.mapStackController.setStack('osm')).activeId);
    if (settings.stack !== 'osm') throw new Error(`contrast: the OSM stack did not become active (${settings.stack})`);
    settings.scope = await page.evaluate(() => { const button = document.getElementById('scope-toggle'); if (!button) throw new Error('contrast: #scope-toggle is missing'); if (button.getAttribute('aria-pressed') === 'true') button.click(); return button.getAttribute('aria-pressed'); });
    if (settings.scope !== 'false') throw new Error(`contrast: the scope mask did not turn off (aria-pressed ${settings.scope})`);
    for (const [width, height] of VIEWPORTS) {
      const size = `${width}x${height}`;
      await page.setViewport({ width, height });
      await sleep(2500);
      // The panel: the monarch chosen through a real FUZZY match (its note shows), with years "all" (the panel keeps a finished monarch list
      // for the last 10 years from panel-layout); then the Top datasets search and the name search fail.
      await setFailures([{ pattern: INAT_AUTOCOMPLETE, body: FUZZY_SUGGESTION }, TAXON_DATASET_SEARCH]);
      await closeCard();
      await flyTo(...AUSTIN);
      await page.evaluate(() => { if (!window.__godsEyeView.dataManager.setLayerParams('species', { taxonKey: null, years: 'all', radiusKm: 10 }, { origin: 'user' })) throw new Error('species params rejected'); });
      await openSpeciesPanel();
      await page.evaluate(() => { document.getElementById('species-body').scrollTop = 0; });
      await page.click('#species-search', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type('#species-search', 'monarch', { delay: 30 });
      await page.waitForFunction(() => document.querySelector('#species-suggestions button')?.textContent.includes('Danaus plexippa'), { timeout: 20000 });
      await page.click('#species-suggestions button');
      await page.waitForFunction(() => /^GBIF dataset search failed/.test(document.getElementById('species-datasets-status')?.textContent || '') && document.getElementById('species-chosen-note')?.hidden === false, { timeout: 45000 });
      await setFailures([INAT_AUTOCOMPLETE, '^https://api\\.gbif\\.org/v1/species/suggest', TAXON_DATASET_SEARCH]);
      await page.click('#species-search', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type('#species-search', 'monarch', { delay: 30 });
      await page.waitForFunction(() => /^Name search failed/.test(document.getElementById('species-status')?.textContent || ''), { timeout: 30000 });
      const panelForced = await page.evaluate(() => ({ status: document.getElementById('species-status').textContent, datasets: document.getElementById('species-datasets-status').textContent, retry: Boolean(document.querySelector('#species-datasets .species-datasets-retry')), note: document.getElementById('species-chosen-note').textContent }));
      const panelTiles = await waitForMapTiles();
      const panel = await measureSurface(`panel-${size}`, { root: '#species-panel .species-panel-inner', scrollers: ['#species-body'], nonText: '.panel-collapse-btn' });
      surfaces.push({ ...panel, ok: panel.ok && panelForced.retry && panelForced.note === "shown as GBIF's Danaus plexippus" && Boolean(panel.classes['span#species-chosen-note.species-chosen-note']), viewport: size, forced: { ...panelForced, requests: await forcedCount() }, tiles: panelTiles.settled });
      // A status card: the what-lives-here search fails. The panel is collapsed, so the map is what shows behind the card.
      await setFailures(['^https://api\\.gbif\\.org/v1/occurrence/search\\?(?=.*facet=speciesKey)']);
      await page.evaluate(async () => { await window.__godsEyeView.dataManager.setEnabled('species', false, { origin: 'user' }); });
      await page.click('#species-what-lives-here');
      await collapseSpecies();
      const centre = await canvasCentre();
      await page.mouse.click(centre.x, centre.y);
      await page.waitForFunction(() => /^GBIF search failed/.test(document.querySelector('#bio-card .bio-card-status')?.textContent || ''), { timeout: 45000 });
      const statusForced = await page.evaluate(() => ({ status: document.querySelector('#bio-card .bio-card-status').textContent, retry: Boolean(document.querySelector('#bio-card .bio-card-retry')) }));
      const statusTiles = await waitForMapTiles();
      const statusCard = await measureSurface(`card-status-${size}`, { root: '#bio-card', scrollers: ['#bio-card .bio-card-body', '#bio-card .bio-card-foot', '#bio-card .bio-card-foot .dataset-list-rows'] });
      surfaces.push({ ...statusCard, ok: statusCard.ok && statusForced.retry, viewport: size, forced: { ...statusForced, requests: await forcedCount() }, tiles: statusTiles.settled });
      await closeCard();
      // A list card across the antimeridian: every name and dataset lookup fails, and the foot says gbif.org can't show the area as a circle.
      await setFailures(['^https://api\\.gbif\\.org/v1/species/\\d+(?:[?#]|$)', '^https://api\\.gbif\\.org/v1/dataset/']);
      await page.evaluate(() => { if (!window.__godsEyeView.dataManager.setLayerParams('species', { radiusKm: 50 }, { origin: 'user' })) throw new Error('species radius rejected'); });
      await flyTo(...TAVEUNI);
      await openSpeciesPanel();
      await page.click('#species-what-lives-here');
      await collapseSpecies();
      const centre2 = await canvasCentre();
      await page.mouse.click(centre2.x, centre2.y);
      await page.waitForFunction(() => document.querySelector('#bio-card .bio-card-foot-note') && document.querySelectorAll('#bio-card .bio-card-row').length > 0, { timeout: 60000 });
      const listForced = await page.evaluate(() => ({ rows: document.querySelectorAll('#bio-card .bio-card-row').length, rowNotes: document.querySelectorAll('#bio-card .bio-card-row-note').length, datasetNotes: document.querySelectorAll('#bio-card .dataset-row-note').length, footNote: document.querySelector('#bio-card .bio-card-foot-note')?.textContent ?? null }));
      const listTiles = await waitForMapTiles();
      const listCard = await measureSurface(`card-list-${size}`, { root: '#bio-card', scrollers: ['#bio-card .bio-card-body', '#bio-card .bio-card-foot', '#bio-card .bio-card-foot .dataset-list-rows'] });
      // The species rows themselves must be seen and measured, not only the foot.
      surfaces.push({ ...listCard, ok: listCard.ok && Boolean(listCard.classes['span.bio-card-row-primary']) && listForced.rowNotes > 0 && listForced.datasetNotes > 0 && listForced.footNote === "gbif.org can't show this area as a circle", viewport: size, forced: { ...listForced, requests: await forcedCount() }, tiles: listTiles.settled });
      await closeCard();
    }
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 600);
  } finally {
    restored = await page.evaluate(async (initial) => {
      if (window.__qaFetchOriginal) { window.fetch = window.__qaFetchOriginal; delete window.__qaFetchOriginal; }
      for (const id of ['qa-contrast-control', 'qa-contrast-hide-text', 'qa-contrast-hide-surface']) document.getElementById(id)?.remove();
      const view = window.__godsEyeView;
      const dm = view.dataManager;
      const card = document.getElementById('bio-card');
      if (card && !card.hidden) card.querySelector('.bio-card-close').click();
      await dm.setEnabled('species', initial.speciesEnabled, { origin: 'user' });
      dm.setLayerParams('species', { taxonKey: initial.params?.taxonKey ?? null, years: initial.params?.years ?? 'recent', radiusKm: initial.params?.radiusKm ?? 10, ...(initial.params?.name ? { name: initial.params.name } : {}) }, { origin: 'user' });
      const input = document.getElementById('species-search');
      input.value = '';
      input.dispatchEvent(new Event('input'));
      const scope = document.getElementById('scope-toggle');
      if (scope && initial.scope !== null && scope.getAttribute('aria-pressed') !== initial.scope) scope.click();
      const stack = (await view.mapStackController.setStack(initial.stack)).activeId;
      const saved = window.__qaContrastCamera;
      view.viewer.camera.setView({ destination: saved.position, orientation: { heading: saved.heading, pitch: saved.pitch, roll: saved.roll } });
      const panel = document.getElementById('species-panel');
      if (panel.classList.contains('collapsed') !== initial.speciesCollapsed) panel.querySelector('[data-collapse-target="species-panel"]').click();
      return { stack, scope: scope?.getAttribute('aria-pressed') ?? null, speciesEnabled: dm.isEnabled('species'), params: dm.getLayerParams('species'), fetchRestored: !window.__qaFetchOriginal };
    }, initial).catch((caught) => ({ error: String(caught?.stack || caught).slice(0, 300) }));
    await page.setViewport({ width: 1400, height: 900 });
    await sleep(2000);
  }
  const restoredOk = restored?.stack === initial.stack && restored.scope === initial.scope && restored.fetchRestored === true && restored.speciesEnabled === initial.speciesEnabled;
  report('contrast', error === null && restoredOk && surfaces.length === VIEWPORTS.length * 3 && surfaces.every((s) => s.ok), { settings, surfaces, restored, ...(error ? { error } : {}) });
}

// R12-I1 (re-review), critic 10 B1: the gbif.org credit link and its note are visible at rest. A what-lives-here list at Taveuni (a 50 km circle
// across the antimeridian, so the foot carries its note) is read with every scroll container in the card set to scroll 0, and nothing is scrolled
// after that: the link's box must be whole inside the card, the foot and every clipping ancestor, and the page must hit the link at the centre
// of each of its boxes; the note must be whole too. States: the list with every dataset lookup failed (HTTP 503 answered in the page's fetch) and the normal
// list, at 1400x900 and 375x667. Finished dataset lookups are cached for the session and panel-layout, which runs first in a default run,
// looks up the monarch's datasets, two of which Taveuni lists too: a cached title needs no request, so its row showed no failure note and the
// failed state never settled (the full-run timeouts brief A put down to the network). In the failed state the page's fetch therefore also
// renames the search's DATASET_KEY facet to fresh random dataset UUIDs, which no cache holds, keeping their order and counts. Positive
// control in the same check: at rest at least one species row and the first line of at least one dataset link are whole, so the credit is not
// bought by hiding the lists. qa contrast scrolls to find text and cannot see this.
// R13-M1: also just above 850 px (1400x851), on tall phones (393x852, 412x915, 430x932) and in phone landscape (667x375), where a window-height
// cap on the foot lost a species row. The species list and the dataset rows share the card from their floors up in equal steps: the list's
// floor is one whole species row (BODY_FLOOR_PX), the rows' floor only their focus-ring inset (ROWS_FLOOR_PX), so on a short card the dataset
// rows give way to their heading and "more ↓" cue before the species list does (brief B fix round 1, critic S1). While the list is cut the
// rows are no taller than the list minus the difference of the floors, and while the rows are cut the list is no taller than the rows plus it.
// At least one whole species row at every size: no size and no measured quantity waives it (review I-1). At least one whole dataset line at
// every size but LANDSCAPE, pinned: at 667x375 the 195 px card holds the fixed parts, one species row and the dataset heading with its cue,
// and no dataset line (the arithmetic is in B-report.md, fix round 1).
// R13-M2: at 1400x900 and 375x667, in both states, the first and the last dataset link take keyboard focus (Shift+Tab, then Tab back, so
// :focus-visible applies and the browser scrolls the rows as it would) and the focus ring (the link's box grown by its outline width and
// offset; Chrome paints the UA's auto 1px ring 2 px out from the box) is whole inside every clipping ancestor, the card and the window.
// Brief B S-1: while the dataset rows are cut at rest, the card shows the panel's "more ↓" cue for them (visible, aria-hidden, overlapping
// no text of the block), and it goes when the rows are scrolled to their end; with nothing cut there is no cue.
if (CHECKS.has('card-foot-rest')) {
  const RING_SIZES = new Set(['1400x900', '375x667']);
  const TAVEUNI = [179.97, -16.8, 10000];
  // --card-sizes narrows the sizes for a quicker run while developing; the default is every size above.
  const SIZES = arg('--card-sizes', '1400x900,375x667,1400x851,393x852,412x915,430x932,667x375').split(',').map((size) => size.split('x').map(Number));
  const STATES = [...SIZES.map(([width, height]) => [width, height, true]), ...SIZES.map(([width, height]) => [width, height, false])];
  const setDatasetFailures = (on) => page.evaluate((on) => {
    if (on && !window.__qaRestFetch) {
      window.__qaRestFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = String(input?.url ?? input);
        if (url.startsWith('https://api.gbif.org/v1/dataset/')) return Promise.resolve(new Response('{"qa":"forced failure"}', { status: 503, headers: { 'content-type': 'application/json' } }));
        let u = null;
        try { u = new URL(url); } catch { /* not a URL: passed through */ }
        if (u && u.hostname === 'api.gbif.org' && u.pathname === '/v1/occurrence/search' && u.searchParams.getAll('facet').includes('speciesKey')) {
          return window.__qaRestFetch.call(window, input, init).then(async (res) => {
            if (!res.ok) return res;
            const json = await res.json();
            for (const facet of json.facets || []) if (facet.field === 'DATASET_KEY') for (const c of facet.counts || []) c.name = crypto.randomUUID();
            return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
          });
        }
        return window.__qaRestFetch.call(window, input, init);
      };
    }
    if (!on && window.__qaRestFetch) { window.fetch = window.__qaRestFetch; delete window.__qaRestFetch; }
  }, on);
  const closeCard = () => page.evaluate(() => { const card = document.getElementById('bio-card'); if (card && !card.hidden) card.querySelector('.bio-card-close').click(); });
  const readRest = () => page.evaluate(() => {
    const card = document.getElementById('bio-card');
    const all = [card, ...card.querySelectorAll('*')];
    const scrolledBeforeReset = all.filter((el) => el.scrollTop !== 0).length;
    for (const el of all) el.scrollTop = 0;
    const cardBox = card.getBoundingClientRect();
    // What of a box can be seen: clipped by every clipping ancestor, the card and the window.
    const seenOf = (el, box) => {
      let b = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      for (let node = el.parentElement; node; node = node.parentElement) {
        const cs = getComputedStyle(node);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const r = node.getBoundingClientRect();
        b = { left: Math.max(b.left, r.left + node.clientLeft), top: Math.max(b.top, r.top + node.clientTop), right: Math.min(b.right, r.left + node.clientLeft + node.clientWidth), bottom: Math.min(b.bottom, r.top + node.clientTop + node.clientHeight) };
      }
      return { left: Math.max(b.left, cardBox.left, 0), top: Math.max(b.top, cardBox.top, 0), right: Math.min(b.right, cardBox.right, innerWidth), bottom: Math.min(b.bottom, cardBox.bottom, innerHeight) };
    };
    const wholeBox = (el, box) => { if (!el || !box || box.width === 0 || box.height === 0) return false; const s = seenOf(el, box); return s.left <= box.left + 0.5 && s.top <= box.top + 0.5 && s.right >= box.right - 0.5 && s.bottom >= box.bottom - 0.5; };
    const round = (box) => box && { top: +box.top.toFixed(1), bottom: +box.bottom.toFixed(1), height: +box.height.toFixed(1) };
    const link = card.querySelector('.bio-card-foot > a');
    const note = card.querySelector('.bio-card-foot-note');
    const foot = card.querySelector('.bio-card-foot');
    const body = card.querySelector('.bio-card-body');
    const rows = card.querySelector('.bio-card-foot .dataset-list-rows');
    const linkBox = link?.getBoundingClientRect() ?? null;
    // Each box of the link (one per line while it is inline) is what the page hits at its centre.
    const hit = Boolean(link) && [...link.getClientRects()].every((r) => { const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); return Boolean(at && (at === link || link.contains(at))); });
    const footCs = foot && getComputedStyle(foot);
    return {
      scrolledBeforeReset,
      link: link && { text: link.textContent, box: round(linkBox), seenBottom: +seenOf(link, linkBox).bottom.toFixed(1), whole: wholeBox(link, linkBox), hit },
      note: note && { text: note.textContent, box: round(note.getBoundingClientRect()), whole: wholeBox(note, note.getBoundingClientRect()) },
      card: round(cardBox),
      foot: foot && { box: round(foot.getBoundingClientRect()), maxHeight: footCs.maxHeight, overflowY: footCs.overflowY, scrollHeight: foot.scrollHeight, clientHeight: foot.clientHeight },
      body: body && { clientHeight: body.clientHeight, scrollHeight: body.scrollHeight },
      announce: document.getElementById('bio-card-announce')?.textContent ?? null,
      speciesRows: card.querySelectorAll('.bio-card-row').length,
      speciesRowsWhole: [...card.querySelectorAll('.bio-card-row')].filter((row) => wholeBox(row, row.getBoundingClientRect())).length,
      datasetRows: card.querySelectorAll('.bio-card-foot .dataset-row').length,
      datasetNotes: card.querySelectorAll('.bio-card-foot .dataset-row-note').length,
      // The first text line of each dataset link (a link is a flex item, so its own box holds every line it wraps to).
      datasetFirstLinesWhole: [...card.querySelectorAll('.bio-card-foot .dataset-row-link')].filter((a) => { const range = document.createRange(); range.selectNodeContents(a); return wholeBox(a, range.getClientRects()[0]); }).length,
      datasetList: rows && { overflowY: getComputedStyle(rows).overflowY, scrollHeight: rows.scrollHeight, clientHeight: rows.clientHeight, minHeight: parseFloat(getComputedStyle(rows).minHeight) || 0, fade: getComputedStyle(rows).getPropertyValue('--bio-card-datasets-fade').trim() },
      // Brief B fix round 1 (critic S3): a text line cut by a scroller's bottom edge at rest. Each such line must sit inside a fade at that
      // edge: the scroller carries a mask, and its fade is at least as tall as the part of the line that shows. A line cut with no fade read as
      // a rendering glitch, with the "more ↓" cue 100-130 px away on the heading line.
      sliced: [['.bio-card-body', '--bio-card-body-fade', '.bio-card-row-primary, .bio-card-row-secondary, .bio-card-row-count, .bio-card-row-note'], ['.bio-card-foot .dataset-list-rows', '--bio-card-datasets-fade', '.dataset-row-link, .dataset-row-count, .dataset-row-note']].flatMap(([scrollerSel, fadeVar, textSel]) => {
        const scroller = card.querySelector(scrollerSel);
        if (!scroller) return [];
        const r = scroller.getBoundingClientRect();
        const clipBottom = r.top + scroller.clientTop + scroller.clientHeight;
        const cs = getComputedStyle(scroller);
        const mask = cs.maskImage || cs.webkitMaskImage || 'none';
        const fade = parseFloat(cs.getPropertyValue(fadeVar)) || 0;
        return [...scroller.querySelectorAll(textSel)].flatMap((el) => { const range = document.createRange(); range.selectNodeContents(el); return [...range.getClientRects()]; })
          .filter((line) => line.top < clipBottom - 0.5 && line.bottom > clipBottom + 0.5)
          .map((line) => { const shows = clipBottom - line.top; return { scroller: scrollerSel, shows: +shows.toFixed(1), fade, mask: mask !== 'none', ok: mask !== 'none' && fade >= shows - 0.5 }; });
      }),
      cue: (() => {
        const cue = card.querySelector('.bio-card-foot .dataset-list-more');
        if (!cue) return null;
        const c = cue.getBoundingClientRect();
        const cs = getComputedStyle(cue);
        // Visible text of the block the cue could cover: the heading's text and every dataset link's and count's text inside the rows' view.
        const texts = [...card.querySelectorAll('.bio-card-foot .dataset-list-heading, .bio-card-foot .dataset-row-link, .bio-card-foot .dataset-row-count')].flatMap((el) => { const range = document.createRange(); range.selectNodeContents(el); return [...range.getClientRects()].map((r) => ({ el, r })); });
        const overlaps = texts.filter(({ r }) => Math.min(r.right, c.right) - Math.max(r.left, c.left) > 0.5 && Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 0.5).map(({ el }) => el.className);
        return { text: cue.textContent, visibility: cs.visibility, display: cs.display, ariaHidden: cue.getAttribute('aria-hidden'), box: round(c), overlaps };
      })(),
      cardMaxHeight: parseFloat(getComputedStyle(card).maxHeight),
      speciesRowHeight: card.querySelector('.bio-card-row')?.getBoundingClientRect().height ?? null,
    };
  });
  // R13-M1: the share between the list and the rows, and whether the card can hold a whole species row at all (see above).
  // One species row (12 px and 11 px lines at line-height 1.45, 5 px padding and a 1 px border each side, a 3 px margin), and the rows' 3 px
  // ring inset each side. Pinned here, not read from the page, so a build that changes the floors fails instead of moving the target.
  const BODY_FLOOR_PX = 12 * 1.45 + 11 * 1.45 + 15;
  const ROWS_FLOOR_PX = 6;
  const LANDSCAPE = '667x375';
  const share = (s, viewport) => {
    if (!s.body) return { ok: false, why: 'no body' };
    const bodyCut = s.body.scrollHeight - s.body.clientHeight > 1;
    const rows = s.datasetList;
    const rowsCut = Boolean(rows) && rows.scrollHeight - rows.clientHeight > 1;
    const listNotStarved = !bodyCut || !rows || rows.clientHeight <= s.body.clientHeight - (BODY_FLOOR_PX - ROWS_FLOOR_PX) + 2;
    const rowsNotStarved = !rowsCut || s.body.clientHeight <= rows.clientHeight + (BODY_FLOOR_PX - ROWS_FLOOR_PX) + 2;
    const speciesRowOk = s.speciesRowsWhole >= 1;
    const datasetLineOk = viewport === LANDSCAPE ? rowsCut : s.datasetFirstLinesWhole >= 1;
    return { ok: listNotStarved && rowsNotStarved && speciesRowOk && datasetLineOk, bodyCut, rowsCut, listNotStarved, rowsNotStarved, speciesRowOk, datasetLineOk, speciesRowHeight: s.speciesRowHeight && +s.speciesRowHeight.toFixed(1), cardMaxHeight: s.cardMaxHeight };
  };
  const focusRings = async (label) => {
    const count = await page.evaluate(() => document.querySelectorAll('#bio-card .bio-card-foot .dataset-row-link').length);
    const rings = [];
    for (const index of [...new Set([0, count - 1])]) {
      await page.evaluate((i) => document.querySelectorAll('#bio-card .bio-card-foot .dataset-row-link')[i].focus(), index);
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      await page.keyboard.press('Tab');
      await sleep(400);
      await shot(`card-focus-${index === 0 ? 'first' : 'last'}-${label}`);
      rings.push(await page.evaluate((i) => {
        const card = document.getElementById('bio-card');
        const a = card.querySelectorAll('.bio-card-foot .dataset-row-link')[i];
        const r = a.getBoundingClientRect();
        const cs = getComputedStyle(a);
        const out = (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0);
        const ring = { left: r.left - out, top: r.top - out, right: r.right + out, bottom: r.bottom + out };
        let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        const clippers = [];
        for (let node = a.parentElement; node; node = node.parentElement) {
          const ncs = getComputedStyle(node);
          if (ncs.overflowX === 'visible' && ncs.overflowY === 'visible' && node !== card) continue;
          const nr = node.getBoundingClientRect();
          const box = node === card && ncs.overflowX === 'visible' && ncs.overflowY === 'visible' ? nr : { left: nr.left + node.clientLeft, top: nr.top + node.clientTop, right: nr.left + node.clientLeft + node.clientWidth, bottom: nr.top + node.clientTop + node.clientHeight };
          clippers.push(node.className || node.id || node.tagName);
          clip = { left: Math.max(clip.left, box.left), top: Math.max(clip.top, box.top), right: Math.min(clip.right, box.right), bottom: Math.min(clip.bottom, box.bottom) };
        }
        const round = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, +v.toFixed(1)]));
        const inside = ring.left >= clip.left - 0.05 && ring.top >= clip.top - 0.05 && ring.right <= clip.right + 0.05 && ring.bottom <= clip.bottom + 0.05;
        return { index: i, focused: document.activeElement === a, focusVisible: a.matches(':focus-visible'), outline: `${cs.outlineStyle} ${cs.outlineWidth} offset ${cs.outlineOffset}`, ring: round(ring), clip: round(clip), clippers, inside };
      }, index));
    }
    await page.evaluate(() => { document.activeElement?.blur?.(); for (const el of document.querySelectorAll('#bio-card *')) el.scrollTop = 0; });
    return { rings, ok: rings.length >= 2 && rings.every((r) => r.focused && r.focusVisible && r.outline.startsWith('auto') && r.inside) };
  };
  // The cue while the rows are cut: shown at rest, gone at their scroll end; with nothing cut, not shown.
  const cueAtEnd = () => page.evaluate(async () => {
    const rows = document.querySelector('#bio-card .bio-card-foot .dataset-list-rows');
    const cue = document.querySelector('#bio-card .bio-card-foot .dataset-list-more');
    if (!rows || !cue) return null;
    rows.scrollTop = rows.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const visibility = getComputedStyle(cue).visibility;
    rows.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { visibility, backAtTop: getComputedStyle(cue).visibility };
  });
  const cueOk = (s) => {
    const cut = Boolean(s.datasetList) && s.datasetList.scrollHeight - s.datasetList.clientHeight > MORE_SLACK_PX;
    if (!cut) return !s.cue || s.cue.visibility === 'hidden';
    return Boolean(s.cue) && s.cue.visibility === 'visible' && s.cue.display !== 'none' && s.cue.text === 'more ↓' && s.cue.ariaHidden === 'true' && s.cue.overlaps.length === 0 && s.cue.box.height >= 10
      && s.cueEnd?.visibility === 'hidden' && s.cueEnd.backAtTop === 'visible';
  };
  const restOk = (s, failed, viewport) => Boolean(s.link?.whole && s.link.hit && s.note?.whole) && share(s, viewport).ok && cueOk(s) && s.sliced.every((line) => line.ok)
    && (failed ? s.datasetRows > 0 && s.datasetNotes === s.datasetRows : s.datasetNotes === 0)
    // Fix round 1, item 4: the status line says the failed dataset lookups (and only when some failed).
    && (failed ? new RegExp(`; ${s.datasetRows} dataset lookups? failed \\(HTTP`).test(s.announce ?? '') : !/dataset lookups? failed/.test(s.announce ?? ''));
  const saved = await page.evaluate(() => {
    const c = window.__godsEyeView.viewer.camera;
    window.__qaRestCamera = { position: c.position.clone(), heading: c.heading, pitch: c.pitch, roll: c.roll };
    return { speciesCollapsed: document.getElementById('species-panel').classList.contains('collapsed'), radiusKm: window.__godsEyeView.dataManager.getLayerParams('species')?.radiusKm ?? 10 };
  });
  const results = [];
  let error = null;
  let restored = null;
  try {
    for (const [width, height, failed] of STATES) {
      await page.setViewport({ width, height });
      await sleep(2500);
      await closeCard();
      await setDatasetFailures(failed);
      await page.evaluate(() => { if (!window.__godsEyeView.dataManager.setLayerParams('species', { radiusKm: 50 }, { origin: 'user' })) throw new Error('species radius rejected'); });
      await flyTo(...TAVEUNI);
      await openSpeciesPanel();
      // In phone landscape the left stack runs under the HUD, so the action is armed through its own click handler; the card, which this
      // check is about, still opens from a real click on the globe.
      await page.evaluate(() => document.getElementById('species-what-lives-here').click());
      await page.evaluate(() => { const panel = document.getElementById('species-panel'); if (!panel.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click(); });
      await sleep(800);
      const centre = await page.evaluate(() => { const rect = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
      await page.mouse.click(centre.x, centre.y);
      await page.waitForFunction((failed) => {
        const card = document.getElementById('bio-card');
        const rows = card.querySelectorAll('.bio-card-foot .dataset-row').length;
        const notes = card.querySelectorAll('.bio-card-foot .dataset-row-note').length;
        return Boolean(card.querySelector('.bio-card-foot-note')) && card.querySelectorAll('.bio-card-row').length > 0 && rows > 0 && (failed ? notes === rows : notes === 0);
      }, { timeout: 60000 }, failed).catch(async (caught) => {
        // What the card showed instead (a live GBIF failure shows its message and Retry), so a timeout names its cause.
        const shown = await page.evaluate(() => { const card = document.getElementById('bio-card'); return { hidden: card.hidden, text: card.innerText.slice(0, 300) }; }).catch(() => null);
        throw new Error(`card-foot-rest ${width}x${height} ${failed ? 'failed' : 'normal'}: the list did not settle (${String(caught).slice(0, 80)}); card: ${JSON.stringify(shown)}`);
      });
      await page.mouse.move(Math.round(width / 2), Math.round(height * 0.3));
      await sleep(1000);
      const rest = await readRest();
      rest.cueEnd = await cueAtEnd();
      await shot(`card-foot-rest-${failed ? 'failed' : 'normal'}-${width}x${height}`);
      const focus = RING_SIZES.has(`${width}x${height}`) ? await focusRings(`${failed ? 'failed' : 'normal'}-${width}x${height}`) : null;
      results.push({ viewport: `${width}x${height}`, failed, ok: restOk(rest, failed, `${width}x${height}`) && (focus === null || focus.ok), share: share(rest, `${width}x${height}`), focus, ...rest });
      await closeCard();
    }
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 500);
  } finally {
    restored = await page.evaluate(async (saved) => {
      if (window.__qaRestFetch) { window.fetch = window.__qaRestFetch; delete window.__qaRestFetch; }
      const card = document.getElementById('bio-card');
      if (card && !card.hidden) card.querySelector('.bio-card-close').click();
      const dm = window.__godsEyeView.dataManager;
      dm.setLayerParams('species', { radiusKm: saved.radiusKm }, { origin: 'user' });
      const s = window.__qaRestCamera;
      window.__godsEyeView.viewer.camera.setView({ destination: s.position, orientation: { heading: s.heading, pitch: s.pitch, roll: s.roll } });
      const panel = document.getElementById('species-panel');
      if (panel.classList.contains('collapsed') !== saved.speciesCollapsed) panel.querySelector('[data-collapse-target="species-panel"]').click();
      return { fetchRestored: !window.__qaRestFetch, radiusKm: dm.getLayerParams('species')?.radiusKm ?? null };
    }, saved).catch((caught) => ({ error: String(caught?.stack || caught).slice(0, 300) }));
    await page.setViewport({ width: 1400, height: 900 });
    await sleep(2000);
  }
  report('card-foot-rest', error === null && results.length === STATES.length && results.every((r) => r.ok) && restored?.fetchRestored === true, { results, restored, ...(error ? { error } : {}) });
}

// Critic 10 S1: the collapsed SPECIES pill is the material of the collapsed DATA LAYERS and SCENES pills. With all three collapsed, the scope mask
// off, over the OSM street map (central Austin from 3 km) and over open ocean (the Pacific from 800 km, OSM), at 1400x900 and 375x667: the three
// pills' computed backgrounds and backdrop filters are equal, and the SPECIES pill's fill (the median pixel of the pill 10 px in from its edges,
// with every header's contents hidden) is within 15 levels per channel of the mean of the other two pills' fills. Positive control in the same
// check: the open SPECIES panel's computed background is the 0.86 floor, not the pills' glass.
// Brief B (pill contrast): in the same states, every pill's label text (DATA LAYERS, SCENES, SPECIES) holds 4.5:1 and its + button 3:1 (a
// non-text control) over the ground it is drawn on, measured with qa contrast's method (the text made transparent, the page captured, the
// text colour composited over each pixel under its line boxes, the lowest ratio kept). Positive control in the same measurement: each label
// at 0.3 white (the pills' old --text-dim) over the same pixels comes out under 4.5:1.
if (CHECKS.has('collapsed-pills')) {
  await installContrast();
  const pillContrast = async (roots) => {
    await page.evaluate(() => document.activeElement?.blur?.());
    const items = [];
    for (const root of roots) items.push(...(await page.evaluate((root) => window.__qaContrast.collect(root, null, '.panel-collapse-btn'), root)).map((item) => ({ ...item, root })));
    const controls = items.filter((item) => item.label.includes('panel-title')).map((item) => ({ ...item, key: `control 0.3 white ${item.key}`, color: { ...item.color, a: 0.3 }, opacity: 1, control: 'dim' }));
    await addStyle('qa-pill-hide-text', roots.map(hideText).join(' '));
    await frames();
    await sleep(300);
    const png = await page.screenshot({ encoding: 'base64' });
    await removeStyle('qa-pill-hide-text');
    await sleep(300);
    const measured = await page.evaluate((png, items) => window.__qaContrast.analyse(png, items), png, [...items, ...controls]);
    const labels = measured.filter((item) => !item.control).map(({ key, text, ratio, min, pixels, worstBg }) => ({ key, text, ratio, min, pixels, worstBg }));
    const dim = measured.filter((item) => item.control === 'dim').map(({ key, ratio }) => ({ key, ratio }));
    const titles = labels.filter((item) => item.key.includes('panel-title'));
    const ok = titles.length === roots.length && labels.every((item) => item.pixels > 0 && item.ratio !== null && item.ratio >= item.min) && dim.length === titles.length && dim.every((item) => item.ratio !== null && item.ratio < 4.5);
    return { ok, labels, dim };
  };
  const PLACES = [['light', -97.74, 30.27, 3000], ['ocean', -140, -10, 800000]];
  const PILLS = [['data', 'data-panel', '.data-panel-inner'], ['scene', 'scene-panel', '.scene-panel-inner'], ['species', 'species-panel', '.species-panel-inner']];
  const MAX_LEVELS = 15;
  const setCollapsed = (id, collapsed) => page.evaluate((id, collapsed) => { const panel = document.getElementById(id); if (panel.classList.contains('collapsed') !== collapsed) panel.querySelector(`[data-collapse-target="${id}"]`).click(); }, id, collapsed);
  const initial = await page.evaluate(() => {
    const view = window.__godsEyeView;
    const c = view.viewer.camera;
    window.__qaPillCamera = { position: c.position.clone(), heading: c.heading, pitch: c.pitch, roll: c.roll };
    return { stack: view.mapStackController.getState().activeId, scope: document.getElementById('scope-toggle')?.getAttribute('aria-pressed') ?? null, collapsed: Object.fromEntries(['data-panel', 'scene-panel', 'species-panel'].map((id) => [id, document.getElementById(id).classList.contains('collapsed')])) };
  });
  const samples = [];
  let control = null;
  let error = null;
  let restored = null;
  try {
    const stack = await page.evaluate(async () => (await window.__godsEyeView.mapStackController.setStack('osm')).activeId);
    if (stack !== 'osm') throw new Error(`collapsed-pills: the OSM stack did not become active (${stack})`);
    const scope = await page.evaluate(() => { const button = document.getElementById('scope-toggle'); if (button.getAttribute('aria-pressed') === 'true') button.click(); return button.getAttribute('aria-pressed'); });
    if (scope !== 'false') throw new Error(`collapsed-pills: the scope mask did not turn off (aria-pressed ${scope})`);
    for (const [, id] of PILLS) await setCollapsed(id, true);
    await sleep(1000);
    for (const [width, height] of [[1400, 900], [375, 667]]) {
      await page.setViewport({ width, height });
      await sleep(2500);
      for (const [place, lon, lat, alt] of PLACES) {
        await flyTo(lon, lat, alt);
        const tiles = await waitForMapTiles();
        await page.evaluate(() => { const style = document.createElement('style'); style.id = 'qa-pill-hide'; style.textContent = '#left-panel-stack .panel-header > * { opacity: 0 !important; transition: none !important; }'; document.head.appendChild(style); });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await sleep(300);
        const png = await page.screenshot({ encoding: 'base64' });
        await page.evaluate(() => document.getElementById('qa-pill-hide')?.remove());
        await sleep(300);
        await shot(`collapsed-pills-${place}-${width}x${height}`);
        const pills = await page.evaluate(async (png, pills) => {
          const img = new Image();
          img.src = `data:image/png;base64,${png}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const scale = img.width / innerWidth;
          return pills.map(([name, id, inner]) => {
            const el = document.querySelector(`#${id} ${inner}`);
            const r = el.getBoundingClientRect();
            const x0 = Math.ceil((r.left + 10) * scale);
            const y0 = Math.ceil((r.top + 10) * scale);
            const w = Math.max(1, Math.floor((r.right - 10) * scale) - x0);
            const h = Math.max(1, Math.floor((r.bottom - 10) * scale) - y0);
            const { data } = ctx.getImageData(x0, y0, w, h);
            const channels = [[], [], []];
            for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k += 1) channels[k].push(data[i + k]);
            const rgb = channels.map((values) => { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)]; });
            const cs = getComputedStyle(el);
            return { name, rgb, box: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }, background: cs.backgroundColor, backdrop: cs.backdropFilter, collapsed: document.getElementById(id).classList.contains('collapsed') };
          });
        }, png, PILLS);
        const [data, scene, species] = pills;
        const mean = [0, 1, 2].map((k) => (data.rgb[k] + scene.rgb[k]) / 2);
        const maxLevels = Math.max(...species.rgb.map((value, k) => Math.abs(value - mean[k])));
        const contrast = await pillContrast(PILLS.map(([, id, inner]) => `#${id} ${inner}`));
        const ok = pills.every((p) => p.collapsed && p.box.width > 40 && p.box.height > 20 && p.background === data.background && p.backdrop === data.backdrop) && maxLevels <= MAX_LEVELS && contrast.ok;
        samples.push({ viewport: `${width}x${height}`, place, tiles: tiles.settled, ok, maxLevels: +maxLevels.toFixed(1), pills, contrast });
      }
    }
    await setCollapsed('species-panel', false);
    await sleep(1200);
    control = await page.evaluate(() => ({ open: !document.getElementById('species-panel').classList.contains('collapsed'), background: getComputedStyle(document.querySelector('#species-panel .species-panel-inner')).backgroundColor }));
    await setCollapsed('species-panel', true);
    await sleep(800);
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 500);
  } finally {
    restored = await page.evaluate(async (initial) => {
        for (const id of Object.keys(initial.collapsed)) { const panel = document.getElementById(id); if (panel.classList.contains('collapsed') !== initial.collapsed[id]) panel.querySelector(`[data-collapse-target="${id}"]`).click(); }
        const scope = document.getElementById('scope-toggle');
        if (scope && initial.scope !== null && scope.getAttribute('aria-pressed') !== initial.scope) scope.click();
        const view = window.__godsEyeView;
        const stack = (await view.mapStackController.setStack(initial.stack)).activeId;
        const s = window.__qaPillCamera;
        view.viewer.camera.setView({ destination: s.position, orientation: { heading: s.heading, pitch: s.pitch, roll: s.roll } });
        return { stack, scope: scope?.getAttribute('aria-pressed') ?? null };
      }, initial).catch((caught) => ({ error: String(caught?.stack || caught).slice(0, 300) }));
    await page.setViewport({ width: 1400, height: 900 });
    await sleep(2000);
  }
  const controlOk = Boolean(control?.open) && control.background === 'rgba(12, 12, 20, 0.86)' && samples.length > 0 && control.background !== samples[0].pills[0].background;
  report('collapsed-pills', error === null && samples.length === 4 && samples.every((s) => s.ok) && controlOk && restored?.stack === initial.stack && restored.scope === initial.scope, {
    samples: samples.map((s) => ({ viewport: s.viewport, place: s.place, tiles: s.tiles, ok: s.ok, maxLevels: s.maxLevels, pills: s.pills.map((p) => ({ name: p.name, rgb: p.rgb, background: p.background, box: p.box })), contrast: s.contrast })),
    initial, control, controlOk, restored, ...(error ? { error } : {}),
  });
}

// Brief B (fold), fix round 1 (critic S2, review M-3): with a status line showing, nothing the person just used or needs next may leave the
// SPECIES body's view. At 375x667 and 400x800, panel open, body at its scroll top, the search box, the status line, the chosen species row
// with its MAP switch, and WHAT LIVES HERE are each whole inside the body's view and are what the page hits at their corners (a half-cut row
// fails), in three states per size: (1) a 1-line status, "No names match …" (both name sources answered empty in the page's fetch); (2) a
// 2-line status: a species chosen through a real FUZZY match (iNaturalist's suggestion answered in the page as "Danaus plexippa"), "No exact
// GBIF match …; shown as GBIF's …", with the chosen row's note; (3) a failed name search with that species still chosen. Positive controls in
// the same check: each state's status text is the expected one, with the stated line count, and the note is on screen.
if (CHECKS.has('panel-fold')) {
  const SIZES = [[375, 667], [400, 800]];
  const FUZZY_SUGGESTION = { total_results: 1, page: 1, per_page: 1, results: [{ id: 48662, name: 'Danaus plexippa', rank: 'species', preferred_common_name: 'Monarch', matched_term: 'Monarch' }] };
  const INAT_AUTOCOMPLETE = '^https://api\\.inaturalist\\.org/v1/taxa/autocomplete';
  const setRules = (rules) => page.evaluate((rules) => {
    if (!window.__qaFoldFetch) {
      window.__qaFoldFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = String(input?.url ?? input);
        const rule = (window.__qaFoldRules || []).find((r) => new RegExp(typeof r === 'string' ? r : r.pattern).test(url));
        if (rule) return Promise.resolve(typeof rule === 'string' ? new Response('{"qa":"forced failure"}', { status: 503, headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify(rule.body), { status: 200, headers: { 'content-type': 'application/json' } }));
        return window.__qaFoldFetch.call(window, input, init);
      };
    }
    window.__qaFoldRules = rules;
  }, rules);
  const typeQuery = async (text) => {
    await page.click('#species-search', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#species-search', text, { delay: 30 });
  };
  const measure = () => page.evaluate(() => {
    document.activeElement?.blur?.();
    const body = document.getElementById('species-body');
    body.scrollTop = 0;
    const b = body.getBoundingClientRect();
    const view = { top: b.top + body.clientTop, bottom: Math.min(b.bottom, b.top + body.clientTop + body.clientHeight) };
    const round = (v) => +v.toFixed(1);
    // Whole inside the view, and hit at points inset from its corners (rounded pills: inset by up to half their height).
    const seen = (id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      const inset = Math.min((r.bottom - r.top) / 2, 10);
      const corners = r.width > 0 && r.height > 0 && [[r.left + inset, r.top + 2], [r.right - inset, r.top + 2], [r.left + inset, r.bottom - 2], [r.right - inset, r.bottom - 2]].every(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && (hit === el || el.contains(hit))); });
      return { top: round(r.top), bottom: round(r.bottom), inside: r.height > 0 && r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5, corners };
    };
    const parts = Object.fromEntries(['species-search', 'species-status', 'species-chosen', 'species-toggle', 'species-what-lives-here'].map((id) => [id, seen(id)]));
    const status = document.getElementById('species-status');
    const note = document.getElementById('species-chosen-note');
    const lineHeight = parseFloat(getComputedStyle(status).lineHeight) || parseFloat(getComputedStyle(status).fontSize) * 1.2;
    const stack = document.getElementById('left-panel-stack');
    return {
      view: { top: round(view.top), bottom: round(view.bottom) }, parts, whole: Object.values(parts).every((part) => part.inside && part.corners),
      stackShown: [...stack.children].filter((el) => el.getClientRects().length > 0).map((el) => el.id),
      status: status.textContent, statusLines: round(status.getBoundingClientRect().height / lineHeight), note: note.hidden ? null : note.textContent,
      order: [...body.children].filter((el) => el.getClientRects().length > 0).map((el) => el.id || el.className).slice(0, 6),
    };
  });
  const initial = await page.evaluate(() => ({ speciesCollapsed: document.getElementById('species-panel').classList.contains('collapsed'), params: window.__godsEyeView.dataManager.getLayerParams('species'), enabled: window.__godsEyeView.dataManager.isEnabled('species') }));
  const states = [];
  let error = null;
  let restored = null;
  try {
    for (const [width, height] of SIZES) {
      await page.setViewport({ width, height });
      await sleep(2500);
      await openSpeciesPanel();
      // (1) the FUZZY choice first, so a species is chosen; its 2-line status is measured after the 1-line one below.
      await setRules([{ pattern: INAT_AUTOCOMPLETE, body: FUZZY_SUGGESTION }]);
      await typeQuery('monarch');
      await page.waitForFunction(() => document.querySelector('#species-suggestions button')?.textContent.includes('Danaus plexippa'), { timeout: 20000 });
      await page.click('#species-suggestions button');
      await page.waitForFunction(() => document.getElementById('species-chosen-note')?.hidden === false && /^No exact GBIF match for Danaus plexippa; shown as GBIF's Danaus plexippus\./.test(document.getElementById('species-status').textContent), { timeout: 45000 });
      await sleep(1000);
      const fuzzy = await measure();
      await shot(`panel-fold-2line-${width}x${height}`);
      states.push({ viewport: `${width}x${height}`, state: '2-line status (FUZZY)', ...fuzzy, ok: fuzzy.whole && fuzzy.statusLines >= 1.9 && fuzzy.statusLines <= 2.2 && fuzzy.note === "shown as GBIF's Danaus plexippus" });
      await setRules([{ pattern: INAT_AUTOCOMPLETE, body: { total_results: 0, page: 1, per_page: 0, results: [] } }, { pattern: '^https://api\\.gbif\\.org/v1/species/suggest', body: [] }]);
      await typeQuery('zzqx');
      await page.waitForFunction(() => document.getElementById('species-status').textContent === 'No names match "zzqx".', { timeout: 30000 });
      await sleep(1000);
      const oneLine = await measure();
      await shot(`panel-fold-1line-${width}x${height}`);
      states.push({ viewport: `${width}x${height}`, state: '1-line status', ...oneLine, ok: oneLine.whole && oneLine.statusLines >= 0.9 && oneLine.statusLines <= 1.2 && oneLine.note === "shown as GBIF's Danaus plexippus" });
      await setRules([INAT_AUTOCOMPLETE, '^https://api\\.gbif\\.org/v1/species/suggest']);
      await typeQuery('monarch');
      await page.waitForFunction(() => /^Name search failed/.test(document.getElementById('species-status').textContent), { timeout: 30000 });
      await sleep(1000);
      const failedSearch = await measure();
      await shot(`panel-fold-error-${width}x${height}`);
      states.push({ viewport: `${width}x${height}`, state: 'search failed', ...failedSearch, ok: failedSearch.whole && failedSearch.statusLines >= 0.9 && failedSearch.status === 'Name search failed: iNaturalist HTTP 503, GBIF HTTP 503' && failedSearch.note === "shown as GBIF's Danaus plexippus" });
    }
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 500);
  } finally {
    restored = await page.evaluate(async (initial) => {
      if (window.__qaFoldFetch) { window.fetch = window.__qaFoldFetch; delete window.__qaFoldFetch; }
      const input = document.getElementById('species-search');
      input.value = '';
      input.dispatchEvent(new Event('input'));
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('species', initial.enabled, { origin: 'user' });
      dm.setLayerParams('species', { taxonKey: initial.params?.taxonKey ?? null, years: initial.params?.years ?? 'recent', radiusKm: initial.params?.radiusKm ?? 10, ...(initial.params?.name ? { name: initial.params.name } : {}) }, { origin: 'user' });
      const panel = document.getElementById('species-panel');
      if (panel.classList.contains('collapsed') !== initial.speciesCollapsed) panel.querySelector('[data-collapse-target="species-panel"]').click();
      return { fetchRestored: !window.__qaFoldFetch, taxonKey: dm.getLayerParams('species')?.taxonKey ?? null };
    }, initial).catch((caught) => ({ error: String(caught?.stack || caught).slice(0, 300) }));
    await page.setViewport({ width: 1400, height: 900 });
    await sleep(2000);
  }
  report('panel-fold', error === null && states.length === SIZES.length * 3 && states.every((s) => s.ok) && restored?.fetchRestored === true, { states, restored, ...(error ? { error } : {}) });
}

// M1 (final review): a strict GBIF match that answers FUZZY is mapped and says so. The page's fetch answers iNaturalist's autocomplete with one
// row naming "Danaus plexippa" (a misspelling), so the choice goes through the real /v1/species/match, which answered FUZZY 5133088 Danaus
// plexippus (confidence 97) on 2026-09-14: the chosen row and the status must say it is shown as GBIF's Danaus plexippus, with 5133088 mapped.
// Positive control in the same check: iNaturalist's real first suggestion for "monarch" matches EXACT and shows no note.
if (CHECKS.has('fuzzy-match')) {
  const FUZZY_ROW = { total_results: 1, page: 1, per_page: 1, results: [{ id: 48662, name: 'Danaus plexippa', rank: 'species', preferred_common_name: 'Monarch', matched_term: 'Monarch' }] };
  const matches = [];
  const onMatch = (r) => { if (r.url().startsWith('https://api.gbif.org/v1/species/match')) r.json().then((json) => matches.push({ name: new URL(r.url()).searchParams.get('name'), matchType: json.matchType, usageKey: json.usageKey ?? null, canonicalName: json.canonicalName ?? null }), (error) => failed.push(`BODY ${r.url()} ${error}`)); };
  page.on('response', onMatch);
  const read = () => page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    const note = document.getElementById('species-chosen-note');
    return { name: document.getElementById('species-chosen-name').textContent, note: note ? { hidden: note.hidden, text: note.textContent } : null, status: document.getElementById('species-status').textContent, taxonKey: dm.getLayerParams('species')?.taxonKey ?? null, enabled: dm.isEnabled('species') };
  });
  const chooseFirst = async (expected) => {
    await page.evaluate(() => { if (!window.__godsEyeView.dataManager.setLayerParams('species', { taxonKey: null }, { origin: 'user' })) throw new Error('species params rejected'); });
    await page.click('#species-search', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#species-search', 'monarch', { delay: 40 });
    await page.waitForFunction((expected) => document.querySelector('#species-suggestions button')?.textContent.includes(expected), { timeout: 20000 }, expected);
    const suggestion = await page.evaluate(() => document.querySelector('#species-suggestions button').textContent);
    await page.click('#species-suggestions button');
    await page.waitForFunction(() => window.__godsEyeView.dataManager.getLayerParams('species')?.taxonKey === 5133088 && !/^Looking up/.test(document.getElementById('species-status').textContent), { timeout: 30000 });
    await sleep(500);
    return { suggestion, ...(await read()) };
  };
  let exact = null;
  let fuzzy = null;
  let mapTiles = null;
  let error = null;
  try {
    await openSpeciesPanel();
    exact = await chooseFirst('Danaus plexippus');
    await page.evaluate((body) => {
      window.__qaFuzzyFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = String(input?.url ?? input);
        if (url.startsWith('https://api.inaturalist.org/v1/taxa/autocomplete')) return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
        return window.__qaFuzzyFetch.call(window, input, init);
      };
    }, FUZZY_ROW);
    fuzzy = await chooseFirst('Danaus plexippa');
    mapTiles = await waitForMapTiles();
    await shot('fuzzy-match');
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 500);
  } finally {
    await page.evaluate(async () => {
      if (window.__qaFuzzyFetch) { window.fetch = window.__qaFuzzyFetch; delete window.__qaFuzzyFetch; }
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('species', false, { origin: 'user' });
      dm.setLayerParams('species', { taxonKey: null }, { origin: 'user' });
      const input = document.getElementById('species-search');
      input.value = '';
      input.dispatchEvent(new Event('input'));
    }).catch((caught) => { error = `${error ?? ''} restoring: ${caught}`; });
    page.off('response', onMatch);
  }
  const NOTE = "shown as GBIF's Danaus plexippus";
  const exactOk = Boolean(exact) && exact.suggestion.includes('Danaus plexippus') && exact.taxonKey === 5133088 && exact.note?.hidden === true && exact.status === '' && matches.some((m) => m.name === 'Danaus plexippus' && m.matchType === 'EXACT' && m.usageKey === 5133088);
  const fuzzyOk = Boolean(fuzzy) && fuzzy.taxonKey === 5133088 && fuzzy.enabled && fuzzy.name === 'Monarch' && fuzzy.note?.hidden === false && fuzzy.note.text === NOTE && fuzzy.status.includes(NOTE) && matches.some((m) => m.name === 'Danaus plexippa' && m.matchType === 'FUZZY' && m.usageKey === 5133088);
  report('fuzzy-match', error === null && exactOk && fuzzyOk && Boolean(mapTiles?.settled), { exact, fuzzy, matches, mapTiles, exactOk, fuzzyOk, ...(error ? { error } : {}) });
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
    return el ? { announce: document.getElementById('bio-card-announce')?.textContent ?? null, visible: !el.hidden && el.getBoundingClientRect().width > 0, text: el.innerText, links: [...el.querySelectorAll('.bio-card-body a')].map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })) } : null;
  });
  await shot('card');
  // Positive control for the sanitizer: the layer's own https links (the DOI among them) survive, opening in a new tab with no opener.
  const httpsLinks = (card?.links || []).filter((link) => /^https:\/\//.test(link.href || ''));
  const doiLink = httpsLinks.find((link) => link.href.startsWith('https://doi.org/')) || null;
  const linksOk = httpsLinks.length > 0 && httpsLinks.every((link) => link.target === '_blank' && /\bnoopener\b/.test(link.rel || ''));
  report('card', Boolean(card?.visible) && card.text.includes(target.name) && /CC0|CC[ -]BY/i.test(card.text) && linksOk, { entity: target.id, name: target.name, doiLink, httpsLinks: httpsLinks.length, card: card && { visible: card.visible, text: card.text.slice(0, 240), links: card.links } });
  // Fix round 1, item 3: the hidden status line names the record that opened (the first bold line of a GBIF occurrence's details).
  // Brief B fix round 1, item 6: the line starts with the name itself, not the layer's icon ("🐋 Blue whale details opened" before).
  report('card-announce', typeof card?.announce === 'string' && card.announce.includes(target.name) && card.announce.endsWith(' details opened') && !/^[\p{Extended_Pictographic}\p{Regional_Indicator}\s]/u.test(card.announce), { announce: card?.announce ?? null, name: target.name });

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
  // Fix round 1, item 3: two records of the same name, one after the other: the second line is identical, so it is cleared and set again, two
  // separate changes a screen reader hears; a record of another name is set at once. Recorded by a MutationObserver on the status line.
  const repeat = await page.evaluate(async () => {
    const viewer = window.__godsEyeView.viewer;
    let ds = null;
    for (let i = 0; i < viewer.dataSources.length; i += 1) if (viewer.dataSources.get(i).name === 'occurrences') ds = viewer.dataSources.get(i);
    const line = document.getElementById('bio-card-announce');
    const seen = [];
    const observer = new MutationObserver(() => seen.push(line.textContent));
    observer.observe(line, { childList: true, characterData: true, subtree: true });
    const add = (id, name) => ds.entities.add({ id, name, description: `<b>${name}</b> qa repeat` });
    const a = add('qa-repeat-a', 'QA Twin');
    const b = add('qa-repeat-b', 'QA Twin');
    const c = add('qa-repeat-c', 'QA Other');
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    viewer.selectedEntity = undefined;
    await pause(300);
    seen.length = 0;
    viewer.selectedEntity = a;
    await pause(300);
    viewer.selectedEntity = b;
    await pause(300);
    viewer.selectedEntity = c;
    await pause(300);
    observer.disconnect();
    viewer.selectedEntity = undefined;
    for (const e of [a, b, c]) ds.entities.remove(e);
    return { seen, final: line.textContent };
  });
  report('card-announce-repeat', JSON.stringify(repeat.seen) === JSON.stringify(['QA Twin details opened', '', 'QA Twin details opened', 'QA Other details opened']), repeat);
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

// M2 (final review), R12-M1 and R12-M2 (re-review): Escape in the real page, where the search box's keydown listener runs before the document's.
// WHAT LIVES HERE is armed (its prompt card showing) and suggestions for "monarch" show; "s" is typed and Escape pressed at once, then 2.5 s pass.
// The first Escape only hides the list, and the search for "monarchs" it ended does not reopen it (R12-M1); the text, the card and the armed
// state stay. The second Escape, with text and no list, only clears the text (R12-M2). The third, with neither, closes the card and disarms: the
// positive control that Escape still reaches them.
// R13-M5: before that sequence, Tab moves focus from the box to the first suggestion and Escape is pressed there: it only hides the list and
// puts focus back in the box, keeping the text, the card and the armed state. Typing then brings the list back for the sequence above.
if (CHECKS.has('escape')) {
  const read = () => page.evaluate(() => ({
    listHidden: document.getElementById('species-suggestions').hidden,
    cardHidden: document.getElementById('bio-card').hidden,
    card: document.getElementById('bio-card').innerText.slice(0, 60),
    armed: document.getElementById('species-what-lives-here').getAttribute('aria-pressed') === 'true',
    cursor: window.__godsEyeView.viewer.scene.canvas.style.cursor,
    value: document.getElementById('species-search').value,
    focused: document.activeElement?.id || document.activeElement?.tagName || null,
    focusedSuggestion: Boolean(document.activeElement?.classList?.contains('species-suggestion')),
  }));
  const listShowing = () => page.waitForFunction(() => { const list = document.getElementById('species-suggestions'); return !list.hidden && list.querySelectorAll('button').length > 0; }, { timeout: 20000 });
  const states = {};
  let error = null;
  try {
    await openSpeciesPanel();
    await page.click('#species-what-lives-here');
    await page.waitForFunction(() => !document.getElementById('bio-card').hidden, { timeout: 10000 });
    await page.click('#species-search', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#species-search', 'mona', { delay: 40 });
    await listShowing();
    await page.keyboard.press('Tab');
    states.tabbed = await read();
    await page.keyboard.press('Escape');
    await sleep(700);
    states.fromSuggestion = await read();
    await page.keyboard.type('rch', { delay: 40 });
    await listShowing();
    states.before = await read();
    await page.keyboard.type('s');
    await page.keyboard.press('Escape');
    await sleep(2500);
    states.first = await read();
    await page.keyboard.press('Escape');
    await sleep(700);
    states.second = await read();
    await page.keyboard.press('Escape');
    await sleep(700);
    states.third = await read();
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 500);
  } finally {
    await page.evaluate(() => {
      const input = document.getElementById('species-search');
      input.value = '';
      input.dispatchEvent(new Event('input'));
      const card = document.getElementById('bio-card');
      if (!card.hidden) card.querySelector('.bio-card-close').click();
      const arm = document.getElementById('species-what-lives-here');
      if (arm.getAttribute('aria-pressed') === 'true') arm.click();
    }).catch((caught) => { error = `${error ?? ''} restoring: ${caught}`; });
    await sleep(500);
  }
  const suggestionOk = Boolean(states.fromSuggestion) && states.tabbed.focusedSuggestion && states.tabbed.listHidden === false && states.fromSuggestion.listHidden === true && states.fromSuggestion.focused === 'species-search' && states.fromSuggestion.value === 'mona' && states.fromSuggestion.cardHidden === false && states.fromSuggestion.armed;
  const firstOk = Boolean(states.first) && states.before.listHidden === false && states.before.cardHidden === false && states.before.armed && states.first.listHidden === true && states.first.value === 'monarchs' && states.first.cardHidden === false && states.first.armed;
  const secondOk = Boolean(states.second) && states.second.value === '' && states.second.listHidden === true && states.second.cardHidden === false && states.second.armed;
  const thirdOk = Boolean(states.third) && states.third.cardHidden === true && states.third.armed === false;
  report('escape', error === null && suggestionOk && firstOk && secondOk && thirdOk, { ...states, suggestionOk, firstOk, secondOk, thirdOk, ...(error ? { error } : {}) });
}

// Fix round 1, I-1: the card is a landmark named by its title in the browser's accessibility tree (not only an aria-labelledby string), and it is
// not a live region; the hidden status line beside it says what opened. The card is an <aside> beside the globe, so its role is complementary
// (content that supports the map and stands on its own), a role that takes a name; a role-less <div> would be generic and drop the name. WHAT LIVES HERE's prompt card is opened, read through the page's
// accessibility tree, then closed.
if (CHECKS.has('card-a11y')) {
  let error = null;
  let tree = null;
  let dom = null;
  try {
    await openSpeciesPanel();
    await page.click('#species-what-lives-here');
    await page.waitForFunction(() => !document.getElementById('bio-card').hidden, { timeout: 10000 });
    await sleep(300);
    const handle = await page.$('#bio-card');
    const node = await page.accessibility.snapshot({ root: handle, interestingOnly: false });
    tree = node && { role: node.role, name: node.name };
    dom = await page.evaluate(() => ({ title: document.querySelector('#bio-card .bio-card-title').textContent, live: document.getElementById('bio-card').getAttribute('aria-live'), announce: document.getElementById('bio-card-announce')?.textContent ?? null }));
  } catch (caught) {
    error = String(caught?.stack || caught).slice(0, 500);
  } finally {
    await page.evaluate(() => {
      const card = document.getElementById('bio-card');
      if (!card.hidden) card.querySelector('.bio-card-close').click();
      const arm = document.getElementById('species-what-lives-here');
      if (arm.getAttribute('aria-pressed') === 'true') arm.click();
    }).catch((caught) => { error = `${error ?? ''} restoring: ${caught}`; });
    await sleep(500);
  }
  const ok = error === null && tree?.role === 'complementary' && tree.name === dom?.title && dom.title !== '' && dom.live === null && dom.announce === `${dom.title}: Click a spot on the globe. Esc cancels.`;
  report('card-a11y', ok, { tree, dom, ...(error ? { error } : {}) });
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
  // An area link carries the search's own polygon, geospatial-issue filter, licences, years and checklist (brief B item 7: the search names
  // the Backbone, which drops records with no Backbone taxon), and its API count is the card's record total.
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
      checklistEqual: link.searchParams.get('checklistKey') === GBIF_BACKBONE_CHECKLIST_KEY && sent.searchParams.get('checklistKey') === GBIF_BACKBONE_CHECKLIST_KEY,
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
    // 3. a 50 km search across the antimeridian (Taveuni, Fiji): searched with geoDistance, so the link carries the checklist, licences and
    //    years only
    const across = await searchAt({ lon: 179.97, lat: -16.8, radiusKm: 50 });
    const acrossLink = parse(across.href);
    const acrossSent = parse(across.search);
    const acrossApi = across.href ? await apiCount(across.href) : null;
    const acrossChecks = {
      searchUsedDistance: Boolean(acrossSent) && acrossSent.searchParams.has('geoDistance') && !acrossSent.searchParams.has('geometry'),
      linkHasNoLocation: Boolean(acrossLink) && JSON.stringify([...acrossLink.searchParams.keys()]) === JSON.stringify(['checklistKey', 'license', 'license', 'year']) && acrossLink.searchParams.get('checklistKey') === GBIF_BACKBONE_CHECKLIST_KEY && licencesOk(acrossLink) && acrossLink.searchParams.get('year') === acrossSent?.searchParams.get('year'),
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
