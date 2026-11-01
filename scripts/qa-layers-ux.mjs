#!/usr/bin/env node
/**
 * qa-layers-ux.mjs — real-browser acceptance check for the Layers panel follow-up (grill_wildeye_layers_ux_2026-10-20):
 *   node scripts/qa-layers-ux.mjs [--url http://127.0.0.1:8791/]
 * One JSON line per check; exits 1 when any check fails.
 *
 * At 1400x900 and 400x800 it opens a share link with three layers on that sat far down the old list (Malaria, Ticks and
 * mosquitoes, Penguin colonies) and checks, with the panel scrolled to its top:
 *   - the collapsed Layers header says "3 on";
 *   - each on layer's full name is in view (inside the viewport and every scrolling ancestor), not clipped;
 *   - one click on that layer's "Turn off" control turns it off, and the other two stay on (positive control);
 *   - every layer row sits in one of the nine authored groups, the groups come in their fixed order, each group's rows are
 *     contiguous and alphabetical, and no row is ungrouped;
 *   - group headings in view at the top of the open panel: all nine at 1400x900; on the phone, whose whole panel is 322 px
 *     (the lower half is the details card's, style.css "50vh + 8px"), at least the 4 whole entries the #111 list showed there
 *     with the same three layers on (measured on the live site 2026-10-20), so the strip does not cost the list entries;
 *   - search: "tick" leaves only Ticks and mosquitoes, in view; "cdc" finds both CDC layers by source; Escape clears it
 *     and the groups fold back.
 * The restore is the real share-link path and "on" is read from the layer manager, not from a label.
 * Software WebGL only (swiftshader): hardware-GPU headless Chrome crashed the laptop twice (2026-09-25).
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';
import { LAYER_GROUPS } from '../src/data/layerGroups.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'http://127.0.0.1:8791/');
const ON = { malaria: 'ml', 'neon-vectors': 'nv', penguins: 'pg' };
const VIEW = `#v=2&lat=20.0000&lon=0.0000&alt=20000000&heading=0&pitch=-90&roll=0&map=esri-imagery&l=${Object.values(ON).join('.')}`;
const GROUPS = ['Animal movement', 'Species records', 'Biodiversity patterns', 'Habitats', 'Land conditions',
  'Ocean conditions', 'Coral heat stress', 'Disease and vectors', 'Human impact'];
// Every row the panel should hold, read from the authored groups: a hard-coded 68 failed this check on a correct panel
// once a 75th layer shipped (2026-11-01 live sweep), and only a by-hand run would ever have seen it
const ROWS = LAYER_GROUPS.reduce((n, g) => n + g.layers.length, 0);

const results = [];
const report = (check, ok, detail = {}) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

// Page-side helpers, installed once per page: is an element really in view, and what is in view by name.
const HELPERS = () => {
  window.__qaInView = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5) return false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
      if (/(auto|scroll|hidden|clip)/.test(s.overflowY + s.overflowX)) {
        const b = a.getBoundingClientRect();
        if (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5 || r.left < b.left - 0.5 || r.right > b.right + 0.5) return false;
      }
    }
    return true;
  };
  window.__qaNameInView = (name) => [...document.querySelectorAll('#data-panel *')].some((el) => el.children.length === 0
    && el.textContent.trim() === name && el.scrollWidth <= el.clientWidth + 1 && window.__qaInView(el));
  window.__qaScrollTop = () => {
    for (const el of document.querySelectorAll('#data-panel, #data-panel *')) el.scrollTop = 0;
  };
};

async function openPage(browser, width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message || e).slice(0, 300)));
  await page.goto(new URL(VIEW, SITE).href, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await bootSettled(page);
  await page.evaluate(HELPERS);
  return { page, errors };
}

const enabledOf = (page) => page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, window.__godsEyeView.dataManager.isEnabled(id)])), Object.keys(ON));
const namesOf = (page) => page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, window.__godsEyeView.dataManager.layers.get(id).module.name])), Object.keys(ON));

// Whole group headings the open list must show at its top, per viewport width (see the header comment).
const MIN_HEADINGS = { 1400: 9, 400: 4 };

async function viewportChecks(browser, width, height) {
  const tag = `${width}x${height}`;
  const { page, errors } = await openPage(browser, width, height);
  const on = await enabledOf(page);
  report(`${tag}: share link restored the three layers on (positive control)`, Object.values(on).every(Boolean), { on });
  const names = await namesOf(page);

  const header = await page.evaluate(() => document.querySelector('#data-panel .panel-header')?.textContent.replace(/\s+/g, ' ').trim());
  report(`${tag}: collapsed Layers header says 3 on`, /(^|\D)3 on\b/.test(header || ''), { header });

  if (await page.evaluate(() => document.getElementById('data-panel').classList.contains('collapsed'))) {
    await page.click('[data-collapse-target="data-panel"]');
  }
  await page.waitForFunction(() => {
    const p = document.getElementById('data-panel');
    return !p.classList.contains('collapsed') && p.getAnimations({ subtree: true }).every((a) => a.playState !== 'running');
  }, { timeout: 15000 });
  await page.evaluate(() => window.__qaScrollTop());

  const inView = await page.evaluate((n) => Object.fromEntries(Object.entries(n).map(([id, name]) => [id, window.__qaNameInView(name)])), names);
  report(`${tag}: every on layer's full name is in view at the top of the panel`, Object.values(inView).every(Boolean), { inView });

  const headings = await page.evaluate(() => [...document.querySelectorAll('#data-panel .layer-group[data-group-id]')]
    .map((g) => ({ label: g.querySelector('.layer-group-label')?.textContent.trim(), inView: window.__qaInView(g.querySelector('.layer-group-head')) })));
  const shown = headings.filter((h) => h.inView).length;
  report(`${tag}: at least ${MIN_HEADINGS[width]} group headings in view at the top of the panel`,
    headings.length === GROUPS.length && shown >= MIN_HEADINGS[width], { shown, of: headings.length });

  // One click off, on the control that is in view.
  const offName = names.penguins;
  const clicked = await page.evaluate((name) => {
    const b = [...document.querySelectorAll('#data-panel button')].find((el) => el.getAttribute('aria-label') === `Turn off ${name}` && window.__qaInView(el));
    if (!b) return false;
    b.click();
    return true;
  }, offName);
  const off = clicked && await page.waitForFunction(() => !window.__godsEyeView.dataManager.isEnabled('penguins'), { timeout: 15000 }).then(() => true, () => false);
  const after = await enabledOf(page);
  const stillShown = await page.evaluate((name) => window.__qaNameInView(name), names.malaria);
  report(`${tag}: one click on Turn off turns that layer off and leaves the others on`,
    off && after.malaria && after['neon-vectors'] && stillShown, { clicked, after, stillShown });
  const header2 = await page.evaluate(() => document.querySelector('#data-panel .panel-header')?.textContent.replace(/\s+/g, ' ').trim());
  report(`${tag}: header count follows the change (2 on)`, /(^|\D)2 on\b/.test(header2 || ''), { header2 });

  report(`${tag}: no page errors`, errors.length === 0, { errors: errors.slice(0, 3) });
  return page;
}

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
try {
  const page = await viewportChecks(browser, 1400, 900);

  // Grouping, read from the desktop page's DOM order.
  const grouping = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#data-panel .data-toggle-row')];
    const seq = rows.map((r) => r.closest('.layer-group[data-group-id]')?.querySelector('.layer-group-label')?.textContent.trim() ?? null);
    const names = rows.map((r) => r.querySelector('.data-name')?.textContent.trim());
    return { count: rows.length, seq, names };
  });
  const order = [...new Set(grouping.seq)];
  const contiguous = order.every((g) => {
    const idx = grouping.seq.flatMap((s, i) => (s === g ? [i] : []));
    return idx[idx.length - 1] - idx[0] + 1 === idx.length;
  });
  const alphabetical = order.every((g) => {
    const n = grouping.names.filter((_, i) => grouping.seq[i] === g);
    return n.every((name, i) => i === 0 || n[i - 1].localeCompare(name, 'en', { sensitivity: 'base' }) <= 0);
  });
  report('every row is in one of the nine groups, in the fixed order, contiguous and alphabetical',
    grouping.count === ROWS && !grouping.seq.includes(null) && JSON.stringify(order) === JSON.stringify(GROUPS) && contiguous && alphabetical,
    { rows: grouping.count, expected: ROWS, ungrouped: grouping.seq.filter((s) => s === null).length, order, contiguous, alphabetical });

  // Search.
  const box = await page.$('#data-panel input[type="search"]');
  report('a search box is in the panel', Boolean(box));
  if (box) {
    const visibleRows = () => page.evaluate(() => [...document.querySelectorAll('#data-panel .data-toggle-row')]
      .filter((r) => r.getClientRects().length > 0).map((r) => ({ id: r.dataset.layerId, inView: window.__qaInView(r.querySelector('.data-name')) })));
    await box.click();
    await box.type('tick');
    await page.waitForFunction((rows) => [...document.querySelectorAll('#data-panel .data-toggle-row')].filter((r) => r.getClientRects().length).length < rows, { timeout: 5000 }, ROWS).catch(() => null);
    // The expected set is computed here from the manager's names and sources, not from the panel's own matcher.
    const expectTick = await page.evaluate(() => [...window.__godsEyeView.dataManager.layers.values()]
      .map((e) => e.module).filter((m) => m.showInTogglePanel !== false && `${m.name} ${m.source}`.toLowerCase().includes('tick'))
      .map((m) => m.id).sort());
    const tick = await visibleRows();
    const tickIds = tick.map((r) => r.id).sort();
    report('search "tick" shows exactly the layers naming ticks, Ticks and mosquitoes among them and in view',
      JSON.stringify(tickIds) === JSON.stringify(expectTick) && expectTick.includes('neon-vectors') && expectTick.length < 5
        && tick.find((r) => r.id === 'neon-vectors')?.inView === true, { tickIds, expectTick });
    await box.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await box.type('cdc');
    await page.waitForFunction(() => [...document.querySelectorAll('#data-panel .data-toggle-row')].filter((r) => r.getClientRects().length).length === 2, { timeout: 5000 }).catch(() => null);
    const cdc = (await visibleRows()).map((r) => r.id).sort();
    report('search "cdc" matches both CDC layers by source', JSON.stringify(cdc) === JSON.stringify(['arbonet', 'wastewater']), { cdc });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#data-panel input[type="search"]').value === '', { timeout: 5000 }).catch(() => null);
    const cleared = await page.evaluate(() => ({
      value: document.querySelector('#data-panel input[type="search"]').value,
      visibleRows: [...document.querySelectorAll('#data-panel .data-toggle-row')].filter((r) => r.getClientRects().length).length,
      groups: document.querySelectorAll('#data-panel .layer-group[data-group-id]').length,
    }));
    report('Escape clears the search and the groups fold back', cleared.value === '' && cleared.visibleRows === 0 && cleared.groups === 9, cleared);
  }
  await page.close();

  await viewportChecks(browser, 400, 800);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: `${results.length - failed.length}/${results.length} passed` }));
process.exit(failed.length ? 1 : 0);
