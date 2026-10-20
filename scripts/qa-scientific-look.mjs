#!/usr/bin/env node
/**
 * qa-scientific-look.mjs — real-browser acceptance check for the plain, scientific-tool look
 * (grill_wildeye_visual_update_2026-10-20). Run against a build with live data:
 *   node scripts/qa-scientific-look.mjs [--url http://127.0.0.1:8791/] [--shots <dir>]
 * One JSON line per check; exits 1 when any check fails.
 *
 * It opens the bird layer over Virginia with the radar columns on, clicks the KAKQ column and moves
 * the pointer over the globe, then sweeps every visible element in three states (Layers open with the
 * popup, Species open, the Basemap dock open: the left panels are an accordion, so never all at once)
 * for what the old HUD look was made of: a monospace face, glow (text-shadow, cyan box-shadow,
 * backdrop blur), uppercase transforms, wide letter-spacing, labels written in capitals (an acronym list aside), the eye logo,
 * the style presets and the corner readouts. axe-core's colour-contrast rule must find no violation
 * AND leave nothing undetermined: text on a see-through panel over the globe is undetermined, which
 * is how the old look passed a bare violation count. Positive controls in the same run: the radar
 * popup opens on a real click, the pointer readout shows a latitude and longitude, and the bird layer
 * is drawn.
 * Software WebGL only (swiftshader): hardware-GPU headless Chrome crashed the laptop twice (2026-09-25).
 */
import puppeteer from 'puppeteer';
import { createRequire } from 'node:module';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'http://127.0.0.1:8791/');
const SHOTS = arg('--shots', null);
// hv=1 asks for the old corner readouts, so their removal is tested rather than assumed.
const VIEW = '#v=2&lat=32.9000&lon=-77.0000&alt=450000&heading=0&pitch=-45&roll=0&map=esri-imagery&hv=1&l=n&lo=n.c.1';
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
// Words that are written in capitals because they are acronyms, codes or licence terms, not because of styling. A run of capitals made
// only of these (NOAA OISST, CC BY) is a name, not shouting; any other all-capitals word of two or more letters is a label left in caps.
const ACRONYMS = [
  'API', 'APHIS', 'BALTRAD', 'BY', 'CC', 'CC0', 'CDC', 'CI', 'DOI', 'EU', 'EVI', 'FIRMS', 'GBIF', 'GEDI', 'GFW', 'GIBS', 'HAB', 'HAEDAT', 'HTTP',
  'HTTPS', 'ID', 'IGBP', 'IOC', 'ISME', 'IUCN', 'LST', 'MDD', 'MODIS', 'NAS', 'NASA', 'NC', 'ND', 'NDVI', 'NE', 'NEON', 'NEXRAD', 'NOAA', 'NPN',
  'NSF', 'NW', 'NWSS', 'OBIS', 'OISST', 'OSM', 'OTN', 'RESOLVE', 'SA', 'SE', 'SEDAC', 'SW', 'UN', 'URL', 'US', 'USA', 'USDA', 'USGS', 'UTC',
  'VIIRS', 'VPTS', 'WMS',
  // US state codes (a radar is named "Wakefield VA (KAKQ)")
  ...'AL AK AZ AR CA CO CT DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY DC PR'.split(' '),
];

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e?.message || e).slice(0, 400)));
  await page.goto(new URL(VIEW, SITE).href, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 180000 });
  await page.evaluate(() => window.__godsEyeView.styleManager.initialRestorePromise.then(() => true, () => false));
  await bootSettled(page);
  const drawn = await page.waitForFunction(
    () => window.__godsEyeView.viewer.dataSources.getByName('birds')[0]?.entities.getById('birds:KAKQ')?.isShowing,
    { timeout: 120000 },
  ).then(() => true, () => false);
  report('bird columns drawn (positive control)', drawn);
  await page.waitForFunction(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded, { timeout: 120000, polling: 250 }).catch(() => null);

  // A real click on the KAKQ column opens its popup.
  const at = await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const e = viewer.dataSources.getByName('birds')[0].entities.getById('birds:KAKQ');
    const s = viewer.scene.cartesianToCanvasCoordinates(e.position.getValue(viewer.clock.currentTime));
    const r = viewer.canvas.getBoundingClientRect();
    return s && { x: s.x + r.left, y: s.y + r.top };
  });
  if (at) await page.mouse.click(at.x, at.y);
  const popup = await page.waitForFunction(() => {
    const t = document.querySelector('.bio-card-body')?.innerText ?? '';
    return /Wakefield VA \(KAKQ\)/.test(t) && t.split('\n')[0];
  }, { timeout: 30000 }).then((h) => h.jsonValue(), () => '');
  report('radar popup opens on a real click (positive control)', !!popup, { popup });

  // The pointer readout: one plain latitude/longitude line that follows the pointer.
  await page.mouse.move(520, 380);
  const readout = await page.waitForFunction(() => {
    const t = document.getElementById('pointer-readout')?.textContent ?? '';
    return /\d+\.\d+°\s?[NS],?\s+\d+\.\d+°\s?[EW]/.test(t) && t;
  }, { timeout: 15000 }).then((h) => h.jsonValue(), () => null);
  report('pointer readout shows latitude and longitude (positive control)', !!readout, { readout });
  // Its text is not enough: an unstyled readout fell into the page flow and still passed (2026-10-20). It is a fixed box on screen,
  // clear of the title and the globe actions.
  const placed = await page.evaluate(() => {
    const el = document.getElementById('pointer-readout');
    const r = el.getBoundingClientRect();
    const hits = ['title-bar', 'top-center-actions'].filter((id) => {
      const o = document.getElementById(id)?.getBoundingClientRect();
      return o && r.left < o.right && o.left < r.right && r.top < o.bottom && o.top < r.bottom;
    });
    return { position: getComputedStyle(el).position, rect: [r.left, r.top, r.right, r.bottom].map(Math.round), overlaps: hits,
      onScreen: r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  });
  report('pointer readout is a fixed box on screen, clear of the title and actions', placed.position === 'fixed' && placed.onScreen && placed.overlaps.length === 0, placed);

  await page.addScriptTag({ path: AXE });
  const merged = {};
  const axeBad = new Map();
  const axeUnknown = new Map();
  const axeMeasured = new Map();
  const axeOverlaps = new Set();
  const removed = {};
  let stars = null;
  let swept = 0;
  // Each state is reached by the buttons a visitor clicks: the left panels are an accordion, so the
  // open one is closed first; the state counts only once its own contents are visible.
  const STATES = [
    ['layers + popup', '[data-collapse-target="data-panel"]', 'data-panel', '#data-toggles button', null],
    ['species', '[data-collapse-target="species-panel"]', 'species-panel', '#species-search', '[data-collapse-target="data-panel"]'],
    ['basemap dock', '#control-panel-toggle', 'control-panel', '#map-stack-chips button', null],
  ];
  const shown = (sel) => {
    const el = document.querySelector(sel);
    const r = el?.getBoundingClientRect();
    return !!el?.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) && r.width > 0 && r.height > 0
      && parseFloat(getComputedStyle(el.closest('.panel-collapsible') ?? el).opacity) === 1;
  };
  for (const [label, button, panelId, content, closeFirst] of STATES) {
    const isOpen = (id) => page.evaluate((i) => !document.getElementById(i)?.classList.contains('collapsed'), id);
    if (closeFirst && await isOpen('data-panel')) {
      await page.click(closeFirst).catch(() => null);
      await page.waitForFunction(() => document.getElementById('data-panel')?.classList.contains('collapsed'), { timeout: 15000 }).catch(() => null);
      await page.waitForFunction(shown, { timeout: 15000 }, button).catch(() => null);
    }
    if (!(await isOpen(panelId))) await page.click(button).catch(() => null);
    const opened = await page.waitForFunction(shown, { timeout: 15000 }, content).then(() => true, () => false);
    // The dock's tray fades and scales in on its own transition after the panel reads opacity 1; axe run mid-transition looks through the
    // half-faded tray to the canvas and leaves its text undetermined. Wait for every animation in the panel to finish, not a fixed time.
    // A cancelled or replaced transition rejects `finished` (AbortError), and a looping one (a spinner) never finishes, so: finite ones
    // only, a rejection counts as over, and the panel is re-read until no finite animation is left running.
    const settledIn = await page.evaluate(async (id) => {
      const deadline = performance.now() + 15000;
      for (;;) {
        const running = (document.getElementById(id)?.getAnimations({ subtree: true }) ?? [])
          .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity);
        if (!running.length) return true;
        if (performance.now() > deadline) return false;
        await Promise.race([
          Promise.all(running.map((a) => a.finished.catch(() => null))),
          new Promise((r) => setTimeout(r, Math.max(0, deadline - performance.now()))),
        ]);
      }
    }, panelId);
    report(`${label}: panel open and its contents visible`, opened && settledIn, { settledIn });
    const one = await page.evaluate((acronyms) => {
      const allowed = new Set(acronyms);
      // A word that is an acronym, or a radar or station code (KAKQ: four capitals starting K, P or T).
      const isName = (w) => allowed.has(w) || /^[KPT][A-Z]{3}$/.test(w) || /\d/.test(w);
      const visible = (el) => {
        if (!el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      };
      const name = (el) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.classList.length ? '.' + [...el.classList].join('.') : ''}`;
      const els = [...document.querySelectorAll('body *')].filter((el) => el.tagName !== 'CANVAS' && visible(el));
      const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim();
      const hits = [];
      els.forEach((el) => {
        const cs = getComputedStyle(el);
        const text = ownText(el);
        const key = `${name(el)}|${text.slice(0, 24)}`;
        const hit = (k, v) => hits.push([k, key, v ? `${name(el)} ${v}` : name(el)]);
        if (text && /jetbrains|monospace|mono\b/i.test(cs.fontFamily)) hit('mono', cs.fontFamily.slice(0, 40));
        if (cs.textShadow !== 'none') hit('textShadow');
        if (/rgba?\(0, (212|255), 255/.test(cs.boxShadow)) hit('cyanShadow');
        if (cs.backdropFilter && cs.backdropFilter !== 'none') hit('blur', cs.backdropFilter);
        if (text && cs.textTransform === 'uppercase') hit('uppercase');
        if (text && parseFloat(cs.letterSpacing) > 0.5) hit('tracking', cs.letterSpacing);
        const runs = (text.match(/\b[A-Z]{2,}(?:\s+[A-Z0-9]{2,})+\b/g) ?? []).filter((run) => !run.split(/\s+/).every(isName));
        if (runs.length) hit('capsRuns', JSON.stringify(runs[0]));
        const words = (text.match(/\b[A-Z][A-Z]+\b/g) ?? []).filter((w) => !isName(w));
        if (words.length) hit('capsWords', JSON.stringify(words.slice(0, 3)));
        if (/\b\d+\s?KM\b/.test(text)) hit('kmCaps', JSON.stringify(text.slice(0, 30)));
      });
      const present = (sel) => [...document.querySelectorAll(sel)].some(visible);
      return {
        hits,
        swept: els.length,
        removed: Object.fromEntries(Object.entries({
          eyeLogo: '[data-logo-gaze]', styleIndicator: '#style-indicator', presets: '.style-btn', hudCorners: '#intel-hud .hud-corner',
        }).map(([k, sel]) => [k, present(sel)])),
        stars: window.__godsEyeView.viewer.scene.skyBox?.show ?? false,
      };
    }, ACRONYMS);
    swept += one.swept;
    for (const [k, key, lbl] of one.hits) (merged[k] ??= new Map()).set(key, lbl);
    for (const [k, v] of Object.entries(one.removed)) removed[k] = removed[k] || v;
    stars = stars || one.stars;
    // axe leaves a node undetermined when the element itself covers part of another (elmPartiallyObscuring): the popup card over the
    // time bar's end. That is a layout overlap, not an unknown ground, so the text is measured here against its own nearest opaque
    // ancestor (WCAG formula, 4.5:1); with no opaque ancestor it stays undetermined. The overlap is reported by name either way.
    const axe = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: ['color-contrast'] });
      const rgba = (s) => (s.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
        .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
      const ownGround = (el) => {
        for (let a = el; a; a = a.parentElement) {
          const bg = rgba(getComputedStyle(a).backgroundColor);
          if (bg.length >= 3 && (bg[3] ?? 1) === 1) return bg;
        }
        return null;
      };
      const label = (n) => `${n.target.join(' ')}: ${(n.any[0]?.message ?? '').slice(0, 110)}`;
      const nodes = (list) => list.flatMap((v) => v.nodes.map((n) => [n.target.join(' '), label(n)]));
      const unknown = [];
      const overlaps = [];
      const measured = [];
      for (const n of r.incomplete.flatMap((v) => v.nodes)) {
        const el = n.target.length === 1 ? document.querySelector(n.target[0]) : null;
        const ground = n.any[0]?.data?.messageKey === 'elmPartiallyObscuring' && el ? ownGround(el) : null;
        if (!ground) { unknown.push([n.target.join(' '), label(n)]); continue; }
        const fg = rgba(getComputedStyle(el).color);
        const a = fg[3] ?? 1;
        const comp = fg.slice(0, 3).map((c, i) => c * a + ground[i] * (1 - a));
        const [hi, lo] = [lum(comp), lum(ground)].sort((x, y) => y - x);
        const ratio = (hi + 0.05) / (lo + 0.05);
        overlaps.push(n.target.join(' '));
        measured.push([n.target.join(' '), `${n.target.join(' ')}: ${ratio.toFixed(2)}:1 on its own ground`, ratio]);
      }
      return { bad: nodes(r.violations), unknown, overlaps, measured };
    });
    axe.bad.forEach(([k, v]) => axeBad.set(k, v));
    axe.unknown.forEach(([k, v]) => axeUnknown.set(k, v));
    axe.measured.forEach(([k, v, ratio]) => { if (ratio < 4.5) axeBad.set(k, v); else axeMeasured.set(k, v); });
    axe.overlaps.forEach((k) => axeOverlaps.add(k));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/scientific-look-${label.replace(/\W+/g, '-')}.png` });
  }
  const show = (k, check) => {
    const m = merged[k] ?? new Map();
    report(check, m.size === 0, { n: m.size, eg: [...m.values()].slice(0, 8) });
  };
  report('swept visible elements', swept > 300, { swept });
  show('mono', 'no monospace text');
  show('textShadow', 'no glow: text-shadow');
  show('cyanShadow', 'no glow: cyan box-shadow');
  show('blur', 'no frosted-glass blur');
  show('uppercase', 'no uppercase transform');
  show('tracking', 'no wide letter-spacing');
  show('capsRuns', 'no runs of capitalised words (acronyms aside)');
  show('capsWords', 'no label written in capitals (acronyms and station codes aside)');
  show('kmCaps', 'km written lower case');
  report('eye logo, style indicator, presets and corner readouts gone', Object.values(removed).every((v) => !v), removed);
  report('no starfield behind the globe', stars === false, { stars });
  report('axe colour-contrast: no violations', axeBad.size === 0, { n: axeBad.size, eg: [...axeBad.values()].slice(0, 6) });
  report('axe colour-contrast: nothing undetermined', axeUnknown.size === 0, { n: axeUnknown.size, eg: [...axeUnknown.values()].slice(0, 6) });
  // Not a pass/fail on the look: the overlaps axe could not judge, each measured above against its own opaque ground.
  console.log(JSON.stringify({ note: 'elements that cover part of another (a layout overlap, measured on their own ground)', overlaps: [...axeOverlaps], measured: [...axeMeasured.values()] }));

} finally {
  await browser.close();
}
report('no page errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 3) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
