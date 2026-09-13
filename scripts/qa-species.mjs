#!/usr/bin/env node
/**
 * qa-species.mjs — real-browser checks for the biology details card, species search and "what lives here".
 * Run: node scripts/qa-species.mjs --url http://localhost:4488/wildeye/ [--checks card,search,here,portal] [--shots <dir>]
 * Prints one JSON line per check; exits 1 when any check fails.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const CHECKS = new Set(arg('--checks', 'card,search,here,portal').split(','));
const SHOTS = arg('--shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const requests = [];
const failed = [];
page.on('request', (r) => requests.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400 && !/google|gstatic|cesium\.com/.test(r.url())) failed.push(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => { if (!/google|gstatic|cesium\.com|tile/.test(r.url())) failed.push(`REQFAIL ${r.url()} ${r.failure()?.errorText}`); });
page.on('pageerror', (e) => failed.push(`PAGEERROR ${String(e?.message || e).slice(0, 160)}`));
page.on('dialog', (d) => d.dismiss().catch(() => {}));

let bad = 0;
const report = (check, ok, detail = {}) => { if (!ok) bad += 1; console.log(JSON.stringify({ check, ok, ...detail })); };
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flyTo = (lon, lat, height) => page.evaluate(async (lon, lat, height) => {
  const viewer = window.__godsEyeView.viewer;
  const Cartesian3 = viewer.camera.position.constructor;
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 5000));
}, lon, lat, height);

await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
await sleep(12000);
await page.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
await page.keyboard.press('Escape');

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

if (CHECKS.has('search')) {
  await page.evaluate(() => {
    const panel = document.getElementById('species-panel');
    if (panel?.classList.contains('collapsed')) panel.querySelector('[data-collapse-target="species-panel"]').click();
  });
  await sleep(800);
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
  const filtered = tiles.filter((u) => {
    const q = new URL(u).searchParams;
    return u.includes('/v2/map/occurrence/adhoc/') && q.getAll('license').includes('CC0_1_0') && q.getAll('license').includes('CC_BY_4_0') && q.get('taxonKey') === '5133088';
  });
  const params = await page.evaluate(() => window.__godsEyeView.dataManager.getLayerParams('species'));
  // Ruling R-2a: the species layer counts only real HTTP/network tile errors (GBIF answers empty tiles with 204),
  // so after the tiles load its status must carry no error.
  const stats = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('species')?.module?.getStats() ?? null);
  await shot('search');
  report('search', first.startsWith('Monarch') && params?.taxonKey === 5133088 && tiles.length > 0 && filtered.length === tiles.length && stats?.error === null, { first, params, stats, tiles: tiles.length, adhocWithBothLicences: filtered.length, sample: tiles[0] || null });
}

let hereLink = null;
let hereTotal = null;
if (CHECKS.has('here')) {
  await flyTo(-110.83, 44.46, 40_000);
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
    link: document.querySelector('#bio-card .bio-card-foot a')?.href || null,
  }));
  hereLink = result.link;
  hereTotal = Number((result.filter.match(/([\d,]+) records/) || [])[1]?.replace(/,/g, '') || Number.NaN);
  await shot('what-lives-here');
  report('here', result.rows >= 1 && Boolean(result.link), result);
}

if (CHECKS.has('portal') && hereLink && Number.isFinite(hereTotal)) {
  const portal = await browser.newPage();
  await portal.goto(hereLink, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(5000);
  const text = await portal.evaluate(() => document.body.innerText);
  const expected = hereTotal.toLocaleString('en-US');
  report('portal', text.includes(expected), { link: hereLink, expected, pageSample: text.slice(0, 300) });
  await portal.close();
} else if (CHECKS.has('portal')) {
  // Never pass by skipping: portal needs the here check's footer link and its record total.
  report('portal', false, { reason: hereLink ? 'the what-lives-here filter line had no parsable record total' : 'no what-lives-here link to open (run the here check first, and it must produce a footer link)', hereLink, hereTotal: Number.isFinite(hereTotal) ? hereTotal : null });
}

report('no-failed-requests', failed.length === 0, { failed: [...new Set(failed)].slice(0, 10) });
await browser.close();
process.exit(bad ? 1 : 0);
