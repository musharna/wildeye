#!/usr/bin/env node
/**
 * qa-species.mjs — real-browser checks for the biology details card, species search and "what lives here".
 * Run: node scripts/qa-species.mjs --url http://localhost:4488/wildeye/ [--checks panel-layout,card,search,here,portal-link] [--shots <dir>]
 * Prints one JSON line per check; exits 1 when any check fails.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const CHECKS = new Set(arg('--checks', 'panel-layout,card,search,here,portal-link').split(','));
const SHOTS = arg('--shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const requests = [];
const failed = [];
page.on('request', (r) => requests.push(r.url()));
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
  report('panel-layout', collapsedOk && expandedOk && phoneOk && restoredOk, {
    collapsed: { species: collapsed.species.width, scene: collapsed.scene.width },
    expanded: { species: expanded.species.width, speciesExpandedVar: expanded.species.expandedVar },
    phone: { viewport: phone.viewport, speciesWidth: phone.species.width, speciesLeft: phone.species.left, speciesRight: phone.species.right },
    restored: { viewport: restored.viewport, speciesCollapsed: restored.species.collapsed, sceneCollapsed: restored.scene.collapsed },
    collapsedOk, expandedOk, phoneOk, restoredOk,
  });
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
  const params = await page.evaluate(() => window.__godsEyeView.dataManager.getLayerParams('species'));
  // Ruling R-2a: the species layer counts only real HTTP/network tile errors (GBIF answers empty tiles with 204),
  // so after the tiles load its status must carry no error.
  const stats = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('species')?.module?.getStats() ?? null);
  await shot('search');
  report('search', first.startsWith('Monarch') && params?.taxonKey === 5133088 && tiles.length > 0 && filtered.length === tiles.length && stats?.error === null, { first, params, stats, tiles: tiles.length, adhocWithBothLicences: filtered.length, srs: tiles[0] ? new URL(tiles[0]).searchParams.get('srs') : null, sample: tiles[0] || null });
}

let hereSearch = null;
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
    link: document.querySelector('#bio-card .bio-card-foot a')?.href || null,
  }));
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
  await shot('what-lives-here');
  const outlineOk = outline.count === 1 && outline.inPrimitives === 0 && outline.allowPicking === false && outline.controlHit === true && outline.outlineHit === false && click?.selectedAfter === null && click?.cardUnchanged === true;
  report('here', result.rows >= 1 && Boolean(result.link) && outlineOk, { ...result, outline, click, outlineOk });
}

if (CHECKS.has('portal-link')) {
  // gbif.org answers scripts with a bot check, so the footer link is compared with the GBIF search the page really sent
  // (R-7b): gbif.org's location filter is `geometry` and it drops `geo_distance`, so the link must carry the search's
  // geometry exactly, with the same licences and years.
  const href = await page.evaluate(() => document.querySelector('#bio-card .bio-card-foot a')?.getAttribute('href') ?? null);
  const parse = (url) => { try { return new URL(url); } catch { return null; } };
  const link = href ? parse(href) : null;
  const sent = hereSearch ? parse(hereSearch) : null;
  if (!link || !sent) {
    // Never pass by skipping: portal-link needs the here check's GBIF request and its footer link.
    report('portal-link', false, { reason: !sent ? 'no what-lives-here GBIF search request was captured (run the here check first)' : 'the what-lives-here card has no footer link', href, hereSearch });
  } else {
    const noDistance = (u) => !u.searchParams.has('geo_distance') && !u.searchParams.has('geoDistance');
    const rawGeometry = (url) => (url.match(/[?&]geometry=([^&]*)/) || [])[1] ?? null;
    const geometry = link.searchParams.get('geometry');
    const licences = (u) => u.searchParams.getAll('license');
    const checks = {
      portalPath: link.origin + link.pathname === 'https://www.gbif.org/occurrence/search',
      geometryIsPolygon: /^POLYGON\(\(/.test(geometry || ''),
      geometryEqual: geometry !== null && geometry === sent.searchParams.get('geometry'),
      licencesEqual: ['CC0_1_0', 'CC_BY_4_0'].every((l) => licences(sent).includes(l)) && JSON.stringify(licences(link)) === JSON.stringify(licences(sent)),
      yearEqual: sent.searchParams.get('year') !== null && link.searchParams.get('year') === sent.searchParams.get('year'),
      noDistanceParam: noDistance(link) && noDistance(sent),
    };
    report('portal-link', Object.values(checks).every(Boolean), {
      ...checks,
      rawGeometryEqual: rawGeometry(href) === rawGeometry(hereSearch),
      geometryVertices: geometry ? geometry.split(',').length : null,
      link: { length: href.length, params: [...link.searchParams.entries()] },
      search: { length: hereSearch.length, params: [...sent.searchParams.entries()] },
    });
  }
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
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('occurrences', true, { origin: 'user' }));
  await page.click('#species-what-lives-here');
  const centre = await page.evaluate(() => {
    const rect = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(centre.x, centre.y);
  await page.waitForFunction(() => document.querySelectorAll('#bio-card .bio-card-row').length > 0 || /failed|No CC0/.test(document.getElementById('bio-card')?.innerText || ''), { timeout: 45000 });
  const listed = { ...(await countOutlines()), rows: await page.evaluate(() => document.querySelectorAll('#bio-card .bio-card-row').length) };
  const spots = await page.evaluate(async () => {
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
  let detail = null;
  let closed = null;
  if (spots.marker?.picksMarker && spots.empty) {
    await page.mouse.click(spots.marker.page.x, spots.marker.page.y);
    await sleep(2000);
    detail = { ...(await cardState()), outlines: await countOutlines() };
    await page.mouse.click(spots.empty.page.x, spots.empty.page.y);
    await sleep(2000);
    closed = { ...(await cardState()), outlines: await countOutlines() };
  }
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    viewer.selectedEntity = undefined;
    for (let i = 0; i < viewer.dataSources.length; i += 1) if (viewer.dataSources.get(i).name === 'occurrences') viewer.dataSources.get(i).entities.removeById('qa-here-detail-marker');
  });
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('occurrences', false, { origin: 'user' }));
  const ok = listed.groundPrimitives === 1 && listed.rows >= 1
    && detail?.selected === 'qa-here-detail-marker' && detail.hidden === false && detail.text.includes('qa-here-detail marker') && detail.outlines.groundPrimitives === 0
    && closed?.selected === null && closed.hidden === true && closed.outlines.groundPrimitives === 0 && closed.outlines.primitives === 0;
  report('here-detail', ok, { listed, spots, detail, closed });
}

report('no-failed-requests', failed.length === 0, { failed: [...new Set(failed)].slice(0, 10), upstreamTileErrors: upstreamTileErrors.slice(0, 10) });
await browser.close();
process.exit(bad ? 1 : 0);
