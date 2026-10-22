#!/usr/bin/env node
/**
 * qa-drape-click.mjs — real-browser acceptance check: with the bird layer on as shipped (columns off, drape on), a click
 * on a radar's drape opens that radar's popup.
 *   node scripts/qa-drape-click.mjs [--url http://127.0.0.1:4488/wildeye/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * Over KAKQ (Wakefield VA) with the share link's bird defaults:
 *   - columns are hidden and the drape is shown (the default this fixes around);
 *   - Flow is turned off with its own chip, so no moving particle is under a click (a particle click opens the
 *     particle's popup, by design); each click also records that nothing pickable was under it;
 *   - a real mouse click 25-40 km from KAKQ selects the entity birds:KAKQ and the details card shows its popup
 *     ("Wakefield");
 *   - a real click on open ocean more than 150 km from every radar selects no radar (negative, same run);
 *   - with WHAT LIVES HERE armed, a click on the same drape spot is the search's, not the radar's.
 * The positions come from the page's own globe (pickEllipsoid / cartesianToCanvasCoordinates), not from pixels guessed
 * here. Software WebGL only (swiftshader): hardware-GPU headless Chrome crashed the laptop twice (2026-09-25).
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'http://127.0.0.1:4488/wildeye/');
const VIEW = '#v=2&lat=36.9000&lon=-75.5000&alt=1400000&heading=0&pitch=-90&roll=0&map=esri-imagery&l=n';

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
try {
  const page = await browser.newPage();
  await page.goto(`${SITE}${VIEW}`, { waitUntil: 'domcontentloaded' });
  await bootSettled(page);
  // the bird layer's columns are loaded (their entities exist even while hidden)
  await page.waitForFunction(() => {
    const v = window.__godsEyeView?.viewer;
    return v && [...Array(v.dataSources.length).keys()].some((i) => v.dataSources.get(i).entities.getById('birds:KAKQ'));
  }, { timeout: 120000 });

  // page-side: where a lon/lat is on the canvas, and which radar entity is selected
  await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    const r = Math.PI / 180;
    window.__qaCanvasAt = (lon, lat) => {
      const c = v.scene.globe.ellipsoid.cartographicToCartesian({ longitude: lon * r, latitude: lat * r, height: 0 });
      const p = v.scene.cartesianToCanvasCoordinates(c);
      const box = v.scene.canvas.getBoundingClientRect();
      return p ? { x: box.left + p.x, y: box.top + p.y } : null;
    };
    window.__qaSelected = () => v.selectedEntity?.id ?? null;
    window.__qaBirds = () => {
      for (let i = 0; i < v.dataSources.length; i++) {
        const ds = v.dataSources.get(i);
        if (ds.entities.getById('birds:KAKQ')) return { columnsShown: ds.show };
      }
      return null;
    };
    window.__qaDrapes = () => v.imageryLayers._layers.filter((l) => l.show && l.imageryProvider?.url?.includes?.('birds_ppi')).length;
  });

  const state = await page.evaluate(() => ({ birds: window.__qaBirds(), drapes: window.__qaDrapes() }));
  report('default view: columns hidden, drapes shown', state.birds?.columnsShown === false && state.drapes > 0, state);

  // Flow off, through its own chip: a moving 2 px particle under the cursor opens the particle's popup (by design), so
  // with flow on, whether a click lands on bare drape is luck. The first mutant run hit one twice.
  const flowOff = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[data-chip-id="particles"]')].find((x) => /migration flow/.test(x.title));
    if (!b) return 'no Flow chip';
    if (b.getAttribute('aria-pressed') === 'true') b.click();
    return null;
  });
  const flowOk = flowOff === null && await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button[data-chip-id="particles"]')].find((x) => /migration flow/.test(x.title));
    return b?.getAttribute('aria-pressed') === 'false';
  }, { timeout: 10000 }).then(() => true).catch(() => false);
  report('Flow chip turns the particles off', flowOk, { error: flowOff });

  const clickAt = async (lon, lat) => {
    const p = await page.evaluate((a, b) => window.__qaCanvasAt(a, b), lon, lat);
    if (!p) return null;
    // what is under the point just before the click: nothing pickable, so the click is a bare-globe click
    p.underBefore = await page.evaluate((x, y) => {
      const v = window.__godsEyeView.viewer;
      v.selectedEntity = undefined;
      const box = v.scene.canvas.getBoundingClientRect();
      const hit = v.scene.pick({ x: x - box.left, y: y - box.top });
      return hit === undefined ? null : String(hit.id?.id ?? hit.id ?? 'primitive');
    }, p.x, p.y);
    await page.mouse.click(p.x, p.y);
    return p;
  };
  const selectedAfterClick = async () => {
    // the click handler runs inside the click; wait for the frame that follows it, not a fixed time
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
    return page.evaluate(() => window.__qaSelected());
  };

  // KAKQ is at -77.0073, 36.984; this point is ~33 km south-east of it and far from the next radar (KMHX ~250 km)
  const near = await clickAt(-76.75, 36.80);
  const sel = await selectedAfterClick();
  const card = await page.waitForFunction(() => {
    const c = document.querySelector('.bio-card');
    return c && c.hidden === false && /Wakefield/.test(c.textContent) ? c.textContent.slice(0, 160) : null;
  }, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
  report('click on KAKQ drape opens KAKQ popup', near?.underBefore === null && sel === 'birds:KAKQ' && card !== null, { at: near, selected: sel, card });

  // open Atlantic ~400 km east of KAKQ, > 150 km from every radar
  const far = await clickAt(-72.3, 36.5);
  const selFar = await selectedAfterClick();
  report('click > 150 km from every radar selects no radar', far !== null && !String(selFar ?? '').startsWith('birds:'), { at: far, selected: selFar });

  // WHAT LIVES HERE armed: the same drape spot is the search's click
  await page.evaluate(() => document.getElementById('species-what-lives-here').click());
  const armed = await page.waitForFunction(() => window.__godsEyeView.viewer.scene.canvas.style.cursor === 'crosshair', { timeout: 10000 })
    .then(() => true).catch(() => false);
  const armedAt = await clickAt(-76.75, 36.80);
  const selArmed = await selectedAfterClick();
  report('armed WHAT LIVES HERE: a drape click is not a radar click', armed && armedAt?.underBefore === null && !String(selArmed ?? '').startsWith('birds:'), { armed, at: armedAt, selected: selArmed });
} finally {
  await browser.close();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
