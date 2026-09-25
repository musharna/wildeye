#!/usr/bin/env node
/**
 * qa-command-dock.mjs — real-browser checks that the bottom command dock is usable at phone widths.
 * Run: node scripts/qa-command-dock.mjs [--url https://musharna.github.io/wildeye/] [--shots <dir>]
 * Prints one JSON line per check; exits 1 when any check fails.
 *
 * Why this exists (2026-09-24): at 900 px and below each tray was centred on the dock by a formula that
 * assumed the dock is two tabs plus the voice control. This fork has no voice control, so every tray sat
 * 70 px off centre — at 390 px the presets tray began off the left edge and the location tray ran off
 * the right. The tabs were also fixed at 52-68 px, narrower than "VISUAL PRESETS", so their labels were
 * clipped to "ESETS" and "L". Every existing dock check ran at desktop width or against a dev server.
 * A tray must lie wholly on screen, its first control must take a real tap, and a tab's label must not
 * be cut.
 */
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const SHOTS = arg('--shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results = [];
const report = (check, ok, detail) => { results.push({ check, ok }); console.log(JSON.stringify({ check, ok, ...detail })); };

const TABS = { presets: '#control-panel', location: '#location-bar' };

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], protocolTimeout: 300000 });
try {
  for (const [w, h] of [[390, 844], [480, 900], [844, 390], [1400, 900]]) {
    const m = await browser.newPage();
    const touch = w < 1000;
    await m.setViewport({ width: w, height: h, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1 });
    await m.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await m.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView.styleManager, { timeout: 180000 });
    // the first-run launcher arrives after boot and covers the bottom of a phone; dismissed as qa-compare does
    await new Promise((r) => setTimeout(r, 12000));
    await m.evaluate(() => document.querySelector('[data-first-run-suppress]')?.click());
    await m.keyboard.press('Escape');
    const launcherGone = await m.waitForFunction(() => !document.querySelector('[data-first-run-choice]')?.offsetParent, { timeout: 15000 }).then(() => true, () => false);
    if (!launcherGone) { report(`dock-${w}x${h}`, false, { error: 'first-run launcher still up after 15 s' }); await m.close(); continue; }

    // Closed dock: whole dock on screen, each tab's label uncut and inside its tab.
    const closed = await m.evaluate(async (TABS) => {
      // two frames so the restacked dock is painted; bounded, since a stalled software renderer once hung this
      await Promise.race([new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))), new Promise((res) => setTimeout(res, 1000))]);
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      const R = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right) }; };
      const dock = document.getElementById('command-dock');
      const tabs = {};
      for (const [k, sel] of Object.entries(TABS)) {
        const tab = dock.querySelector(sel);
        const label = tab.querySelector('.panel-title, .location-toolbar-label');
        const t = R(tab), l = R(label);
        // The rendered text's own box, not scrollWidth: a centred label overflows both ways and scrollWidth
        // counts only the right side, so it read "VISUAL PRESETS" clipped to "ESETS" as uncut.
        const range = document.createRange(); range.selectNodeContents(label); const tb = range.getBoundingClientRect();
        const text = { x: Math.round(tb.left), r: Math.round(tb.right) };
        tabs[k] = { tab: t, label: l, textBox: text, text: label.textContent.trim(),
          cut: text.x < l.x - 1 || text.r > l.r + 1 || text.x < t.x - 1 || text.r > t.r + 1 };
      }
      const d = R(dock);
      return { vw, dock: d, dockInside: d.x >= 0 && d.r <= vw && d.y >= 0 && d.y + d.h <= vh, tabs };
    }, TABS);
    const closedOk = closed.dockInside && Object.values(closed.tabs).every((t) => !t.cut);
    report(`dock-closed-${w}x${h}`, closedOk, closed);
    if (SHOTS) await m.screenshot({ path: `${SHOTS}/dock-${w}x${h}-closed.png` });

    // Each tray, opened by a real tap/click on its tab: wholly on screen, first control takes a real pointer.
    for (const [k, sel] of Object.entries(TABS)) {
      const at = await m.evaluate((sel) => { const b = document.querySelector(`#command-dock ${sel}`).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel);
      if (touch) await m.touchscreen.tap(at[0], at[1]); else await m.mouse.click(at[0], at[1]);
      await new Promise((r) => setTimeout(r, 1200));
      const tray = await m.evaluate(async (sel) => {
        const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
        const panel = document.querySelector(`#command-dock ${sel}`);
        const pop = panel.querySelector('.dock-popover-content');
        // Measure the settled tray, not its entrance: under the software renderer the tray can start opening
        // ~2.4 s after the tap, and a fixed sleep caught it mid-transition (scale 0.985, 10 px low) and its buttons
        // mid-`visibility` — a miss the page never shows a person. Settled = visible, opaque, untransformed, idle.
        const settled = () => { const cs = getComputedStyle(pop);
          return cs.visibility === 'visible' && cs.opacity === '1' && (cs.transform === 'none' || cs.transform === 'matrix(1, 0, 0, 1, 0, 0)')
            && pop.getAnimations({ subtree: true }).every((a) => a.playState !== 'running'); };
        const t0 = performance.now();
        while (!settled() && performance.now() - t0 < 8000) await new Promise((res) => setTimeout(res, 100));
        if (!settled()) return { open: !panel.classList.contains('collapsed'), vw, settled: false, inside: false, firstControl: 'tray never settled in 8 s' };
        // two frames so the settled tray is painted; bounded, since a stalled software renderer once hung this
        await Promise.race([new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))), new Promise((res) => setTimeout(res, 1000))]);
        const b = pop.getBoundingClientRect();
        // first real control in the tray (not the pin): a style button or a location pill / search toggle
        // a control counts only if its whole box is on screen and a pointer at its centre reaches it
        const hitTest = (e) => {
          if (!e) return 'none';
          const f = e.getBoundingClientRect(); const x = f.left + f.width / 2, y = f.top + f.height / 2;
          if (f.left < 0 || f.right > vw || f.top < 0 || f.bottom > vh) return 'off-screen';
          const t = document.elementFromPoint(x, y); return t === e || e.contains(t) ? 'ok' : (t?.id || String(t?.className || t?.tagName).slice(0, 30));
        };
        // the pin floats past the tray's top-right corner, so the tray being on screen does not cover it
        const pin = pop.querySelector('.dock-pin-btn'); const pr = pin?.getBoundingClientRect();
        return { open: !panel.classList.contains('collapsed'), vw, tray: { x: Math.round(b.left), r: Math.round(b.right), y: Math.round(b.top), w: Math.round(b.width) },
          inside: b.left >= 0 && b.right <= vw && b.top >= 0 && b.bottom <= vh,
          firstControl: hitTest(pop.querySelector('.style-btn, .location-pill, .search-toggle-btn')),
          pin: hitTest(pin), pinBox: pr && { x: Math.round(pr.left), r: Math.round(pr.right), y: Math.round(pr.top) } };
      }, sel);
      report(`dock-tray-${k}-${w}x${h}`, tray.open && tray.inside && tray.firstControl === 'ok' && tray.pin === 'ok', tray);
      if (SHOTS) await m.screenshot({ path: `${SHOTS}/dock-${w}x${h}-${k}.png` });
      // close it again through the same tab so the next tray opens alone
      if (tray.open) {
        if (touch) await m.touchscreen.tap(at[0], at[1]); else await m.mouse.click(at[0], at[1]);
        await m.waitForFunction((sel) => document.querySelector(`#command-dock ${sel}`).classList.contains('collapsed'), { timeout: 5000 }, sel).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    await m.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: true, checks: results.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
