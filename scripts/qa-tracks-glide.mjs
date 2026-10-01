#!/usr/bin/env node
/**
 * qa-tracks-glide.mjs — real-browser checks that animal tracks glide between the ticks of the time bar's play
 * (docs/superpowers/specs/2026-10-01-tracks-glide-design.md), against the tracks file the build serves.
 * Run: node scripts/qa-tracks-glide.mjs [--url https://musharna.github.io/wildeye/] [--samples 12]
 * Prints one JSON line per check; exits 1 when any check fails.
 *
 * A head's position says which instant it was drawn for: on the straight step between fixes k and k+1 of its own
 * segment, at a fraction f of the way, it stands for ts[k] + f·(ts[k+1] − ts[k]). So each sample reads every shown head
 * and asks:
 *  - on-own-segment: is the head on a step of the segment its id names? A head between two segments (a glide across
 *    a time gap or a land split) is on none.
 *  - one-instant: do all shown heads stand for one instant, inside the playing tick [t0, t0 + step]?
 *  - span: is a touched segment's head shown exactly when that instant is inside the segment's span?
 *  - glides: within one tick, does some head stand at two different places (step mode holds one)?
 *  - work: is the number of entities with per-frame callbacks the touched set the served file implies (2 per segment
 *    covering some moment of the tick, +1 per segment entering or leaving its span inside it), and 0 when paused?
 */
import puppeteer from 'puppeteer';
import { bootSettled } from './bootSettled.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const SITE = arg('--url', 'https://musharna.github.io/wildeye/');
const SAMPLES = Number(arg('--samples', 12));

const results = [];
// `ok` last, so a detail payload can never overwrite the verdict
const report = (check, ok, detail) => { const row = { check, ...detail, ok }; results.push(row); console.log(JSON.stringify(row)); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 160)));

try {
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await bootSettled(page);
  // tracks alone among the observed layers, so the bar's step is the tracks' step
  await page.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;
    for (const [id, e] of dataManager.layers)
      if (typeof e.module.getObservedExtent === 'function' && id !== 'tracks' && dataManager.isEnabled(id)) await dataManager.setEnabled(id, false);
    await dataManager.setEnabled('tracks', true, { origin: 'user' });
  });
  await page.waitForFunction(() => (window.__godsEyeView.dataManager.layers.get('tracks')?.module.getStats().count ?? 0) > 0
    && !!window.__godsEyeView.observedTime.domain(), { timeout: 180000, polling: 250 });

  // The served file, parsed in the page; the busiest instant (most segments in span) is where play starts.
  const setup = await page.evaluate(async (ahead) => {
    const gj = await (await fetch(`data/tracks.geojson?t=${Date.now()}`)).json();
    window.__qaTracks = gj.features.map((f) => ({ c: f.geometry.coordinates, ts: f.properties.times.map((t) => Date.parse(t)) }));
    const T = window.__qaTracks;
    const inSpan = (s, a) => s.c.length >= 2 && s.ts[0] <= a && a < s.ts[s.ts.length - 1];
    const store = window.__godsEyeView.observedTime;
    const d = store.domain();
    // room for every sample's tick before play reaches the end and stops
    const latest = d.end - ahead * d.stepMs;
    let best = { ms: null, n: -1 };
    for (let k = 0; k < T.length; k += Math.max(1, Math.floor(T.length / 300))) {
      const a = (T[k].ts[0] + T[k].ts[T[k].ts.length - 1]) / 2;
      if (a > latest) continue;
      const n = T.filter((s) => inSpan(s, a)).length;
      if (n > best.n) best = { ms: a, n };
    }
    store.set(best.ms);
    window.__qaTicks = [];
    store.subscribe(() => window.__qaTicks.push({ at: performance.now(), ms: store.getMs(), playing: store.isPlaying() }));
    return { segments: T.length, startMs: store.getMs(), inSpanAtStart: best.n, stepMs: d.stepMs, domainEnd: d.end };
  }, SAMPLES + 8);

  /** Everything the checks read off one moment: heads shown, the instants they stand for, and the dynamic entity count. */
  const sample = () => page.evaluate(() => {
    const view = window.__godsEyeView;
    const ds = view.viewer.dataSources.getByName('tracks')[0];
    const T = window.__qaTracks;
    const time = view.viewer.clock.currentTime;
    const deg = ({ x, y, z }) => { // Cartesian → geodetic lon/lat on WGS84 (the frame the layer interpolates in)
      const a = 6378137, e2 = 6.69437999014e-3, r = Math.hypot(x, y);
      let lat = Math.atan2(z, r * (1 - e2));
      for (let k = 0; k < 6; k++) {
        const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
        const h = r / Math.cos(lat) - n;
        lat = Math.atan2(z, r * (1 - e2 * n / (n + h)));
      }
      return [Math.atan2(y, x) * 180 / Math.PI, lat * 180 / Math.PI];
    };
    const dyn = ds.entities.values.filter((e) => [e.position, e.polyline?.positions, e.point?.show, e.polyline?.show].some((p) => p && !p.isConstant));
    const heads = [];
    const t0 = performance.now();
    for (const e of ds.entities.values) {
      if (!e.id.endsWith(':head') || !e.show) continue;
      const i = Number(e.id.split(':').at(-2));
      const shown = e.point.show === undefined || e.point.show.getValue(time) !== false;
      heads.push({ id: e.id, i, shown, pos: deg(e.position.getValue(time)) });
    }
    const readMs = performance.now() - t0; // each head's callback reads the clock as it is evaluated
    return { now: performance.now(), readMs, dyn: dyn.length, dynIds: dyn.slice(0, 5).map((e) => e.id), heads, nSeg: T.length };
  });

  /** Place each head on a step of its own segment and read the instant (or, on a still step, the interval) it stands for. */
  const placeHeads = (s) => page.evaluate((heads) => {
    const T = window.__qaTracks;
    const wrap = (d) => ((d + 540) % 360) - 180; // a head at ±180 may read back with the other sign
    return heads.map((h) => {
      const seg = T[h.i];
      if (!seg) return { ...h, on: false, lo: null, hi: null, span: null };
      const n = Math.min(seg.c.length, seg.ts.length);
      let lo = Infinity, hi = -Infinity, on = false;
      for (let k = 0; k + 1 < n; k++) {
        const p = seg.c[k], q = seg.c[k + 1];
        const hx = p[0] + wrap(h.pos[0] - p[0]), hy = h.pos[1];
        const dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy;
        const f = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((hx - p[0]) * dx + (hy - p[1]) * dy) / L2));
        if (Math.hypot(p[0] + f * dx - hx, p[1] + f * dy - hy) > 1e-6) continue;
        on = true;
        const t = seg.ts[k] + f * (seg.ts[k + 1] - seg.ts[k]);
        const [a, b] = L2 === 0 ? [seg.ts[k], seg.ts[k + 1]] : [t, t];
        lo = Math.min(lo, a); hi = Math.max(hi, b);
      }
      return { ...h, on, lo, hi, span: [seg.ts[0], seg.ts[n - 1]] };
    });
  }, s.heads);

  /** The touched set for the tick [t0, t1] from the served file: 2 per segment covering some moment, +1 if it changes state. */
  const expectedWork = (t0, t1) => page.evaluate((t0, t1) => {
    let n = 0;
    for (const s of window.__qaTracks) {
      const m = Math.min(s.c.length, s.ts.length);
      if (m < 2 || !(s.ts[0] <= t1 && t0 < s.ts[m - 1])) continue;
      n += 2;
      if (!(s.ts[0] <= t0 && t1 < s.ts[m - 1])) n += 1;
    }
    return n;
  }, t0, t1);

  // positive control first: paused at the busy instant nothing is dynamic and the heads do not move
  const pausedA = await sample();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const pausedB = await sample();
  const samePaused = JSON.stringify(pausedA.heads.map((h) => h.pos)) === JSON.stringify(pausedB.heads.map((h) => h.pos));
  report('paused-still', pausedA.dyn === 0 && samePaused && pausedA.heads.length > 0, {
    dynamic: pausedA.dyn, heads: pausedA.heads.length, samePositions: samePaused, setup,
  });

  // play through the real button; sample inside ticks
  await page.click('#observed-time .ot-play');
  await page.waitForFunction(() => window.__qaTicks.some((t) => t.playing), { timeout: 30000 });
  await page.waitForFunction((n) => window.__qaTicks.filter((t) => t.playing).length >= n, { timeout: 30000 }, 2);
  const rows = [];
  for (let k = 0; k < SAMPLES; k++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    const s = await sample();
    const tick = await page.evaluate((now) => window.__qaTicks.filter((t) => t.playing && t.at <= now).at(-1) ?? null, s.now);
    if (!tick) continue;
    const heads = await placeHeads(s);
    rows.push({ s, tick, heads, work: await expectedWork(tick.ms, tick.ms + setup.stepMs) });
  }
  await page.click('#observed-time .ot-play'); // pause
  await page.waitForFunction(() => !window.__godsEyeView.observedTime.isPlaying(), { timeout: 10000 });
  const pausedAfter = await sample();

  // A head's implied instant, in ms. While playing the instant runs step/tick ms of track time per ms of wall time (a
  // week a second: 604,800), and each head's callback reads the clock when it is evaluated, so heads read 0.1 ms apart
  // stand for instants ~60 s apart. The tolerance is the read loop's own wall time at that rate, plus a minute.
  const TOL = 60_000;
  const rate = setup.stepMs / 1000;
  const tolOf = (r) => TOL + (r.s.readMs + 0.05) * rate;
  const shown = rows.flatMap((r) => r.heads.filter((h) => h.shown).map((h) => ({ ...h, t0: r.tick.ms })));
  const offSeg = shown.filter((h) => !h.on);
  report('on-own-segment', rows.length > 0 && shown.length > 0 && offSeg.length === 0, {
    samples: rows.length, shownHeads: shown.length, offSegment: offSeg.slice(0, 5).map((h) => ({ id: h.id, pos: h.pos })),
  });

  const instants = rows.map((r) => {
    const hs = r.heads.filter((h) => h.shown && h.on);
    const lo = Math.max(...hs.map((h) => h.lo)), hi = Math.min(...hs.map((h) => h.hi));
    const tol = tolOf(r);
    return { t0: r.tick.ms, lo, hi, n: hs.length, tol: Math.round(tol), spread: Math.round(lo - hi), agree: hs.length > 0 && lo <= hi + tol, inTick: hi >= r.tick.ms - tol && lo <= r.tick.ms + setup.stepMs + tol };
  });
  report('one-instant', instants.length > 0 && instants.every((x) => x.agree && x.inTick), {
    bad: instants.filter((x) => !(x.agree && x.inTick)).slice(0, 3),
    spreadVsTolMs: instants.map((x) => [x.spread, x.tol]),
    fractions: instants.map((x) => +((x.lo - x.t0) / setup.stepMs).toFixed(3)),
  });

  const spanBad = [];
  let spanChecked = 0;
  for (const [r, x] of rows.map((r, k) => [r, instants[k]])) {
    // the instant the heads stand for: their median, so a few heads drawn at the wrong instant cannot move it
    const mids = r.heads.filter((h) => h.shown && h.on).map((h) => (h.lo + h.hi) / 2).sort((p, q) => p - q);
    if (!mids.length) continue;
    const a = mids[Math.floor(mids.length / 2)];
    for (const h of r.heads) {
      if (!h.span) continue;
      const near = Math.min(Math.abs(a - h.span[0]), Math.abs(a - h.span[1])) <= x.tol; // a boundary inside the tolerance: either is right
      const inside = h.span[0] <= a && a < h.span[1];
      if (near) continue;
      spanChecked++;
      if (h.shown !== inside) spanBad.push({ id: h.id, shown: h.shown, inside });
    }
  }
  report('span', spanChecked > 0 && spanBad.length === 0, { checked: spanChecked, bad: spanBad.slice(0, 5) });

  // a head that stands at two different places within one tick
  const byTick = new Map();
  for (const r of rows) for (const h of r.heads.filter((h) => h.shown)) {
    const key = `${r.tick.ms}|${h.id}`;
    byTick.set(key, (byTick.get(key) || new Set()).add(h.pos.map((v) => v.toFixed(6)).join(',')));
  }
  const moved = [...byTick.values()].filter((v) => v.size > 1).length;
  report('glides', moved > 0, { headTickPairs: byTick.size, movedWithinATick: moved });

  const workRows = rows.map((r) => ({ t0: r.tick.ms, dynamic: r.s.dyn, expected: r.work }));
  report('work', workRows.some((w) => w.expected > 0) && workRows.every((w) => w.dynamic === w.expected) && pausedAfter.dyn === 0, {
    rows: workRows.slice(0, 6), pausedAfter: pausedAfter.dyn, pausedBefore: pausedA.dyn,
  });

  report('no-page-errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
} catch (e) {
  report('run', false, { error: String(e?.stack || e).slice(0, 400), pageErrors: pageErrors.slice(0, 5) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
