#!/usr/bin/env node
/**
 * qa-static-controls.mjs — on the static (GitHub Pages) build, click every visible control once and record
 * which ones trigger failed requests (4xx/5xx), request failures or page errors. Also submits a location search.
 * Run: node scripts/qa-static-controls.mjs --url https://musharna.github.io/wildeye/ [--sections <regex>] [--no-location]
 * --sections limits the crawl to headers whose label matches; run one section per process when the renderer runs out of memory.
 */
import puppeteer from 'puppeteer';
const argv = process.argv.slice(2);
const URL = argv[argv.indexOf('--url') + 1] || 'https://musharna.github.io/wildeye/';
const ONLY = argv.includes('--sections') ? new RegExp(argv[argv.indexOf('--sections') + 1], 'i') : null;
const WITH_LOCATION = !argv.includes('--no-location');
const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
const p = await b.newPage();
let events = [];
p.on('response', (r) => { if (r.status() >= 400) events.push(`${r.status()} ${r.request().method()} ${r.url().replace(/[?].*$/, '').replace(/^https?:\/\/[^/]+/, '')}`); });
p.on('requestfailed', (r) => { const u = r.url(); if (!/google|gstatic|cesium\.com|tile/.test(u)) events.push(`REQFAIL ${u.replace(/[?].*$/, '').replace(/^https?:\/\/[^/]+/, '')} ${r.failure()?.errorText}`); });
p.on('pageerror', (e) => events.push(`PAGEERROR ${String(e?.message || e).slice(0, 140)}`));
const ready = async () => {
  await p.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 12000));
  await p.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('[data-first-run-choice]')?.offsetParent, { timeout: 15000 }).catch(() => {});
  await p.evaluate(() => document.getElementById('location-bar')?.classList.remove('collapsed'));
};
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await ready();
// Some controls reload or navigate the page (a detached frame crashed earlier runs silently). Record them and recover.
const navigators = [];
// Headless Chromium renders with SwiftShader (CPU); leaving every clicked layer on grows the renderer past this
// shell's 14 GB cap and the page dies as a "detached Frame" (2026-09-13). Switch layers back off after each click.
let pageCrashed = false;
p.on('error', (e) => { pageCrashed = true; console.log(`PAGE CRASH (renderer): ${String(e?.message || e).slice(0, 120)}`); });
const layersOff = () => p.evaluate(() => { const dm = window.__godsEyeView?.dataManager; return dm ? Promise.all(dm.getEnabledLayerIds().map((id) => dm.setEnabled(id, false))) : null; }).catch(() => null);
const isNavError = (e) => /detached Frame|Execution context was destroyed|Target closed|Cannot find context/i.test(String(e?.message || e));
const recover = async (label) => {
  navigators.push(label);
  console.log(`NAVIGATES "${label}" — page reloaded or navigated; recovering`);
  await p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  if (!p.url().startsWith(URL.replace(/\/$/, ''))) await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await ready();
};
const flush = () => { const e = [...new Set(events)]; events = []; return e; };
await new Promise((r) => setTimeout(r, 3000));
console.log('baseline after load:', flush().join(' | ') || 'clean');

// Two levels: open each section/tray header, then click every control that became visible inside it
// (a single pass with Escape after each click closed every panel before its contents could be reached).
const visibleControls = () => p.evaluate(() => {
  const out = [];
  document.querySelectorAll('[data-qa-idx]').forEach((e) => e.removeAttribute('data-qa-idx'));
  let i = 0;
  for (const el of document.querySelectorAll('button, [role="button"], input[type="checkbox"], select')) {
    if (!el.offsetParent || el.disabled) continue;
    const label = (el.getAttribute('aria-label') || el.title || el.textContent || el.id || el.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!label) continue;
    el.setAttribute('data-qa-idx', String(i));
    out.push({ idx: i++, key: `${el.id ? '#' + el.id : ''}|${label}`, id: el.id || null, label });
  }
  return out;
});
const SKIP = /import|export|download|reset|clear|delete|copy share|collapse|close|pin /i;
const clickIdx = (i) => p.evaluate((i) => { const el = document.querySelector(`[data-qa-idx="${i}"]`); if (!el || !el.offsetParent) return false; el.click(); return true; }, i).catch(() => false);
const top = await visibleControls();
const headers = top.filter((c) => (/^Expand |^Open compact|toggle/i.test(c.label) || /toggle/i.test(c.id || '')) && (!ONLY || ONLY.test(c.label)));
// Location tray lives behind a dock item; open it explicitly.
await p.evaluate(() => document.getElementById('location-bar')?.classList.remove('collapsed'));
console.log(`${top.length} top-level controls; opening ${headers.length} sections: ${headers.map((h) => h.label).join(' · ')}`);
const bad = [];
const clicked = new Set(top.map((c) => c.key));
let total = 0;
const probeInside = async (section) => {
  const inner = (await visibleControls()).filter((c) => !clicked.has(c.key) && !SKIP.test(c.label));
  for (const c of inner) {
    clicked.add(c.key);
    try {
      const fresh = (await visibleControls()).find((x) => x.key === c.key);
      if (!fresh || !(await clickIdx(fresh.idx))) continue;
      total++;
      await new Promise((r) => setTimeout(r, 2500));
      await p.evaluate(() => 1); // throws if the click navigated
      await layersOff();
      const ev = flush();
      if (ev.length) { bad.push({ section, ...c, ev }); console.log(`ISSUE [${section}] ${c.id ? '#' + c.id + ' ' : ''}"${c.label}" → ${ev.join(' | ')}`); }
    } catch (e) {
      if (!isNavError(e)) throw e;
      if (pageCrashed) { console.log(`STOP: renderer crashed after "[${section}] ${c.label}" (test-host memory, not a navigation)`); process.exit(3); }
      await recover(`[${section}] ${c.label}`);
      flush();
      return { count: inner.length, navigated: true };
    }
  }
  return { count: inner.length, navigated: false };
};
let sectionNo = 0;
for (const h of headers) {
  // Fresh page per section: Visual Presets post-processing left on under SwiftShader plus one more layer
  // crashed the renderer (Dams alone in a fresh page was fine, 2026-09-13), so no state carries over.
  if (sectionNo++ > 0) { await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); await ready(); flush(); }
  const fresh = (await visibleControls()).find((x) => x.key === h.key);
  if (!fresh) continue;
  await clickIdx(fresh.idx);
  await new Promise((r) => setTimeout(r, 1500));
  const opened = flush();
  if (opened.length) { bad.push({ section: h.label, label: '(opening)', ev: opened }); console.log(`ISSUE opening "${h.label}" → ${opened.join(' | ')}`); }
  let res = await probeInside(h.label);
  for (let tries = 0; res.navigated && tries < 10; tries++) {
    const reopened = (await visibleControls()).find((x) => x.key === h.key);
    if (!reopened) break;
    await clickIdx(reopened.idx);
    await new Promise((r) => setTimeout(r, 1500));
    flush();
    res = await probeInside(h.label);
  }
  console.log(`  ${h.label}: ${res.count} inner controls${res.navigated ? ' (stopped after repeated navigation)' : ''}`);
  const again = (await visibleControls()).find((x) => x.key === h.key);
  if (again) { await clickIdx(again.idx); await new Promise((r) => setTimeout(r, 800)); flush(); }
}
if (WITH_LOCATION) {
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); await ready(); flush();
const loc = await probeInside('location tray');
console.log(`  location tray: ${loc.count} inner controls`);
}
console.log(`clicked ${total} inner controls`);
const controls = top;
// Location search: type and submit
await p.evaluate(() => { document.getElementById('location-bar')?.classList.remove('collapsed'); document.getElementById('search-toggle')?.click(); });
await new Promise((r) => setTimeout(r, 1000));
const hasSearch = WITH_LOCATION && await p.evaluate(() => { const i = document.getElementById('location-search'); if (!i) return false; i.scrollIntoView(); return !!i.offsetParent; });
if (hasSearch) {
  await p.evaluate(() => document.getElementById('search-toggle')?.click());
  await new Promise((r) => setTimeout(r, 800));
  await p.click('#location-search').catch(() => {});
  await p.type('#location-search', 'Yellowstone National Park', { delay: 20 }).catch(() => {});
  await p.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 8000));
  const ev = flush();
  const msg = await p.evaluate(() => [...document.querySelectorAll('[role="status"], .toast, .search-status, .location-status')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 3).join(' / '));
  console.log(`SEARCH "Yellowstone National Park" → ${ev.join(' | ') || 'no failed requests'}${msg ? ` · UI: ${msg.slice(0, 160)}` : ''}`);
} else if (WITH_LOCATION) console.log('SEARCH input not visible');
console.log(`${bad.length} controls produced failed requests or errors; ${navigators.length} reloaded or navigated the page: ${navigators.join(' · ') || 'none'}`);
await b.close();
