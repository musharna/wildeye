#!/usr/bin/env node
/**
 * qa-bloat.mjs — real-browser acceptance for removing God's Eye inheritance wildeye does not need
 * (grill_wildeye_bloat_2026-09-26: Q4-Q6, A6, A9-A12, A18; step 2: Q11, A19-A20, A23). Headless Chrome on swiftshader only.
 * Run against a Pages build: node scripts/qa-bloat.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Every denylist check is paired with a positive control in the same row, so a page that failed to
 * load (nothing registered, no HUD) cannot read as "nothing left to remove".
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');

/** God's Eye layers (all registered on 76bacb1, 12 of them hidden on Pages but still shipped). */
const CUT_LAYERS = ['flights', 'military', 'satellites', 'rocket-launches', 'traffic', 'cctv', 'radio', 'bikeshare',
  'ais-live-vessels', 'military-installations', 'military-awareness', 'local-firms', 'local-dams', 'local-datacenters',
  'earthquakes', 'telegeography-submarine-cables'];
/** Every layer wildeye added (A7): all must stay registered and shown. `species` is registered but not a toggle. */
const KEEP_LAYERS = ['aloft', 'arbonet', 'birds', 'cetaceans', 'chlor-a', 'cmems-o2', 'cmems-ph', 'crw-bleaching', 'crw-dhw',
  'crw-hotspot', 'crw-seaice', 'drought', 'ecoregions', 'fires', 'gfw', 'gibs-biomass', 'gibs-evi', 'gibs-landcover',
  'gibs-lst', 'gibs-nightlights', 'gmw', 'griis', 'h5n1', 'hansen-loss', 'hpai', 'ndvi', 'neon', 'neon-vectors',
  'occurrences', 'oisst', 'otn', 'phenology', 'rivers', 'tracks', 'wastewater', 'whispers'];
const CUT_STYLES = ['surveillance', 'thermal'];
const KEEP_STYLES = ['normal', 'retro', 'anime', 'noir', 'snow'];
/** Elements of God's Eye machinery (scenes, scope mask, celestial ring, cockpit, key setup). */
const CUT_ELEMENTS = ['#scene-panel', '#scope-mask', '#celestial-ring-overlay', '#cockpit-context-toggle',
  '#cockpit-signal-toggle', '[data-cockpit-brief-index]', '[data-key-setup-apply]', '#hud-ais-vessel',
  // Step 2, Q11: the LOCATION panel with God's Eye's city pills and the Google place search.
  '#location-bar', '#location-pills', '#search-toggle', '[data-requires-backend]'];
const KEEP_ELEMENTS = ['#intel-hud', '#hud-latlon', '#hud-alt', '#hud-timestamp', '#data-panel', '#reset-globe-view', '#map-stack-chips'];
/** Step 2, A20: map sources that need a key the site never has (Google 3D Tiles, Cesium ion's Bing). */
const KEEP_MAP_SOURCES = ['Esri Satellite', 'OSM'];
/** Step 2, A19-A20 and Q11: server routes, Google and ion endpoints, and the deleted key panel, in any script the page loaded. */
const CUT_BUNDLE_STRINGS = ['/api/openai', '/api/google', '/api/overpass', 'maps.googleapis.com', 'Provider Settings', 'createGooglePhotorealistic3DTileset'];
/** Requests to a local server route or a keyed Google Maps/Tiles or ion endpoint (Google Fonts is keyless and stays). */
const CUT_REQUEST = /\/api\/|maps\.googleapis\.com|tile\.googleapis\.com|api\.cesium\.com/;
/** Control labels that only make sense for God's Eye features (checked on every visible control). */
const CUT_LABELS = /cockpit weather|Live Signals|Regional News|Local Info|Google 3D|Bing (Aerial|Labels)|LIVE CONTACTS|SPACE MISSIONS|earthquake|aircraft|vessel|CAPTURE SHOT|SAVE KEYS/i;
/** Subsystems that announce themselves at startup and run every frame. */
const CUT_LOGS = ['Detection', 'TrackedReadout'];
const CUT_HANDLES = ['sceneDirector', 'cockpitCloudEffects', 'voiceCommands'];

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
const logPrefixes = new Set();
const requests = [];
let step = 'launch';
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 200)));
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => { const k = m.text().match(/^\[([A-Za-z][\w-]{1,30})/); if (k) logPrefixes.add(k[1]); });
  step = 'load';
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await sleep(12000);
  step = 'inventory';
  const inv = await page.evaluate((CUT_ELEMENTS, KEEP_ELEMENTS) => {
    const g = window.__godsEyeView;
    const visible = (el) => getComputedStyle(el).display !== 'none';
    const all = g.dataManager.getAll();
    const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.title || '').replace(/\s+/g, ' ').trim();
    return {
      registered: all.map((l) => l.id),
      shown: all.filter((l) => l.showInTogglePanel).map((l) => l.id),
      styles: [...document.querySelectorAll('.style-btn')].filter(visible).map((b) => b.dataset.style),
      cutElements: CUT_ELEMENTS.filter((s) => document.querySelector(s)),
      keepElements: KEEP_ELEMENTS.filter((s) => document.querySelector(s)),
      labels: [...document.querySelectorAll('button,[role=button],label,option')].filter(visible).map(label).filter(Boolean),
      handles: Object.keys(g),
      mapSources: [...document.querySelectorAll('.map-stack-chip')].map((c) => ({ label: c.textContent.replace(/\s+/g, ' ').trim(), title: c.title })),
      hudSummary: (document.getElementById('hud-summary')?.textContent || '').trim(),
    };
  }, CUT_ELEMENTS, KEEP_ELEMENTS);
  // Every script the page loaded, fetched again as text (lazy chunks that never loaded are not scanned).
  const scripts = await page.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /\/assets\/[^/]+\.js(\?|$)/.test(u)))];
    return Promise.all(urls.map(async (u) => ({ url: u.split('/').pop(), text: await (await fetch(u)).text() })));
  });
  const leftLayers = CUT_LAYERS.filter((id) => inv.registered.includes(id));
  const missingKeep = KEEP_LAYERS.filter((id) => !inv.shown.includes(id));
  report('layers', leftLayers.length === 0 && missingKeep.length === 0 && inv.registered.includes('species'),
    { godsEyeLeft: leftLayers, wildlifeMissing: missingKeep, wildlifeShown: KEEP_LAYERS.length - missingKeep.length });
  report('styles', CUT_STYLES.every((s) => !inv.styles.includes(s)) && KEEP_STYLES.every((s) => inv.styles.includes(s)), { styles: inv.styles });
  report('machinery-elements', inv.cutElements.length === 0 && inv.keepElements.length === KEEP_ELEMENTS.length,
    { godsEyeLeft: inv.cutElements, keptPresent: inv.keepElements });
  const badLabels = [...new Set(inv.labels.filter((l) => CUT_LABELS.test(l)))];
  report('controls', badLabels.length === 0 && inv.labels.some((l) => /Animal tracks/.test(l)),
    { godsEyeLeft: badLabels.slice(0, 12), controls: inv.labels.length });
  const leftHandles = CUT_HANDLES.filter((h) => inv.handles.includes(h));
  report('handles', leftHandles.length === 0 && inv.handles.includes('dataManager'), { godsEyeLeft: leftHandles });
  const sourceLabels = inv.mapSources.map((c) => c.label);
  report('map-sources', sourceLabels.length === KEEP_MAP_SOURCES.length && KEEP_MAP_SOURCES.every((l) => sourceLabels.includes(l))
    && !inv.mapSources.some((c) => /Provider Settings/.test(c.title)), { mapSources: inv.mapSources });
  const bundleLeft = scripts.flatMap((s) => CUT_BUNDLE_STRINGS.filter((needle) => s.text.includes(needle)).map((needle) => `${s.url}: ${needle}`));
  report('bundle-strings', bundleLeft.length === 0 && scripts.some((s) => s.text.includes('api.gbif.org')),
    { godsEyeLeft: bundleLeft, scanned: scripts.length });
  const cutRequests = [...new Set(requests.filter((u) => CUT_REQUEST.test(u)).map((u) => u.slice(0, 120)))];
  // Positive control: the keyless basemap imagery loaded (no layer is on at first load, so no data file is fetched). Terrain
  // is not in it: since 2026-09-27 it waits for the camera to come below 2,000 km, which qa-first-load checks.
  const basemap = ['services.arcgisonline.com'].filter((host) => requests.some((u) => new URL(u).host === host));
  report('requests', cutRequests.length === 0 && basemap.length === 1,
    { godsEyeLeft: cutRequests.slice(0, 8), basemap, total: requests.length });
  // The HUD keeps its plain line (A19): after the load wait it shows a composed readout, not its placeholder.
  report('hud-line', /UTC/.test(inv.hudSummary) && !/Awaiting/.test(inv.hudSummary), { hudSummary: inv.hudSummary.slice(0, 160) });
  const leftLogs = CUT_LOGS.filter((p) => logPrefixes.has(p));
  report('startup-subsystems', leftLogs.length === 0, { godsEyeLeft: leftLogs, seen: [...logPrefixes].sort() });
} catch (e) {
  report('run', false, { step, error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
report('no-page-errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
