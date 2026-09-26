#!/usr/bin/env node
/**
 * qa-perf — render-governor regression gate.
 *
 * Asserts the governor's observable contract with RELATIVE frame-count
 * assertions (SwiftShader-safe; no wall-clock GPU numbers):
 *
 *  1. Idle + zero layers + parked camera → the scene stops rendering
 *     (near-zero postRender fires over a settle-then-observe window).
 *  2. An animated style takes the style-anim hold, keeps frames flowing, and
 *     releases it when the style returns to normal.
 *  3. Camera movement while idle → a render on most moving frames (Cesium-native path).
 *  4. Birds enabled → continuous mode (its particle animator holds the loop):
 *     postRender cadence ≈ rAF cadence and ≥5× the idle count.
 *  5. Birds disabled again → back to idle (near-zero fires).
 *
 * The idle windows measure the STEADY-STATE floor, so counting starts only
 * after a quiet run longer than one HUD summary refresh (`HUD_SUMMARY_INTERVAL_MS`
 * in src/hud.js): disabling layers marks the summary dirty, and the tick that
 * notices it types new text into a HUD corner up to 15 s later. A scene that
 * renders every frame never produces an empty second, so a quiet run that never
 * arrives is a FAILURE, not a fall-through.
 *
 * Usage: node scripts/qa-perf.mjs [--url http://localhost:4173]
 * Requires a running server. Headless under SwiftShader; flags disable
 * occlusion throttling so rAF cadence is trustworthy (hidden-pane gotcha).
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:4173';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1440,900',
    // Never let background/occlusion throttling freeze rAF or timers — the
    // measurements below depend on an honest frame clock.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  // Boot flyTo + tile warm + all deferred init.
  await new Promise((r) => setTimeout(r, 15_000));

  // Park deterministically and disable every layer.
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    v.camera.cancelFlight();
    const ell = v.scene.globe.ellipsoid;
    v.camera.setView({
      destination: ell.cartographicToCartesian({
        longitude: -97.74 * Math.PI / 180, latitude: 30.27 * Math.PI / 180, height: 60_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled) { try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* gate reports via counts */ } }
    }
  });
  // Let tiles finish + fades settle + the settling frames drain.
  await new Promise((r) => setTimeout(r, 12_000));

  /** Count scene postRender fires and rAF ticks over windowMs. */
  const countFrames = (windowMs) => page.evaluate((ms) => new Promise((resolve) => {
    const scene = window.__godsEyeView.viewer.scene;
    let renders = 0; let rafs = 0;
    const remove = scene.postRender.addEventListener(() => { renders += 1; });
    const t0 = performance.now();
    const tick = () => {
      rafs += 1;
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else { remove(); resolve({ renders, rafs }); }
    };
    requestAnimationFrame(tick);
  }), windowMs);

  const diag = () => page.evaluate(() => window.__godsEyeView.getRenderGovernorDiagnostics?.()
    || window.__gevRenderGovernor?.getDiagnostics?.() || null);

  /** Mirrors `HUD_SUMMARY_INTERVAL_MS` in src/hud.js; this harness drives the built app, not the module. */
  const HUD_SUMMARY_INTERVAL_MS = 15_000;
  /** One full refresh period, plus a second of margin, in 1 s windows. */
  const QUIET_RUN_WINDOWS = Math.ceil(HUD_SUMMARY_INTERVAL_MS / 1_000) + 1;

  /**
   * Wait for a run of empty one-second windows at least one summary refresh
   * long; any activity restarts the run. `quiet: false` is the hot-loop failure.
   */
  const settleUntilQuiet = async (maxMs = 120_000, requiredConsecutive = QUIET_RUN_WINDOWS) => {
    const deadline = Date.now() + maxMs;
    let windows = 0;
    let consecutive = 0;
    let busiest = 0;
    let restarts = 0;
    while (Date.now() < deadline) {
      windows += 1;
      const { renders } = await countFrames(1_000);
      busiest = Math.max(busiest, renders);
      if (renders === 0) consecutive += 1;
      else { if (consecutive > 0) restarts += 1; consecutive = 0; }
      if (consecutive >= requiredConsecutive) {
        return { quiet: true, windows, busiest, restarts, ranFor: consecutive, needRun: requiredConsecutive };
      }
    }
    return { quiet: false, windows, busiest, restarts, ranFor: consecutive, needRun: requiredConsecutive };
  };

  // ── 1. idle: near-zero renders ────────────────────────────────────────
  const idleSettle = await settleUntilQuiet();
  const idle = await countFrames(5_000);
  const d1 = await diag();
  // Quiet that never arrives is the hot-loop failure — assert it, do not skip it.
  check('the parked scene holds a settled quiet run before the idle window is counted', idleSettle.quiet, idleSettle);
  check('governor reports idle mode with zero layers', d1?.mode === 'idle', d1);
  check('idle parked scene stops rendering (≤4 fires / 5s)', idle.renders <= 4, idle);

  // ── 2. animated style cycle: style-anim holds, then releases ─────────
  await page.evaluate(() => { window.__godsEyeView.styleManager.setStyle('retro'); });
  await new Promise((r) => setTimeout(r, 900)); // crossfade + first ticks
  const dAnim = await diag();
  check('animated style takes the style-anim hold (continuous)', dAnim?.mode === 'continuous' && dAnim.holds.includes('style-anim'), dAnim);
  const animFrames = await countFrames(2_000);
  check('animated style keeps frames flowing (≥50% rAF)', animFrames.renders >= animFrames.rafs * 0.5, animFrames);
  await page.evaluate(() => { window.__godsEyeView.styleManager.setStyle('normal'); });
  // The crossfade ends on an animation frame, so on a starved host a fixed wait read the hold before its last tick. Poll the governor instead;
  // a hold that never releases still fails at the ceiling.
  const released = await (async () => {
    const t0 = Date.now();
    for (;;) {
      const d = await diag();
      if (d?.mode === 'idle' && !d.holds.includes('style-anim')) return { ...d, waitedMs: Date.now() - t0 };
      if (Date.now() - t0 > 15_000) return { ...d, waitedMs: Date.now() - t0, timedOut: true };
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  check('style-anim hold releases and the scene goes idle (within 15 s)', !released.timedOut, released);

  // ── 3. camera movement renders (Cesium-native path) ───────────────────
  // One camera step per animation frame for 20 frames, counting renders over exactly those frames, so the ratio holds at any frame rate.
  const duringMove = await page.evaluate(() => new Promise((resolve) => {
    const v = window.__godsEyeView.viewer;
    let renders = 0; let rafs = 0;
    const remove = v.scene.postRender.addEventListener(() => { renders += 1; });
    const tick = () => {
      if (rafs === 20) { remove(); resolve({ renders, rafs }); return; }
      rafs += 1;
      v.camera.moveForward(50);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  check('camera movement while idle renders on ≥70% of the moving frames', duringMove.renders >= duringMove.rafs * 0.7, duringMove);
  await new Promise((r) => setTimeout(r, 3_000)); // settle

  // ── 4. birds enabled → continuous (particle animator hold) ────────────
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('birds', true, { origin: 'user' });
  });
  await new Promise((r) => setTimeout(r, 5_000));
  const active = await countFrames(5_000);
  const d4 = await diag();
  check('governor reports continuous mode with the birds hold', d4?.mode === 'continuous' && d4.holds.includes('birds'), d4);
  check('birds-on cadence ≈ rAF cadence (≥70%)', active.renders >= active.rafs * 0.7, active);
  check('birds-on renders ≥5× idle renders', active.renders >= Math.max(1, idle.renders) * 5, { active: active.renders, idle: idle.renders });

  // ── 5. birds disabled → idle again ────────────────────────────────────
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setEnabled('birds', false, { origin: 'user' });
  });
  // This teardown marks the HUD summary dirty too: same settle rule as step 1.
  const teardownSettle = await settleUntilQuiet();
  const idleAgain = await countFrames(5_000);
  const d5 = await diag();
  check('the scene holds a settled quiet run again before the second idle window', teardownSettle.quiet, teardownSettle);
  check('governor returns to idle after disable', d5?.mode === 'idle', d5);
  check('scene stops rendering again (≤4 fires / 5s)', idleAgain.renders <= 4, idleAgain);
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-perf: ${passed}/${results.length} passed`);
console.log(`RESULT: ${passed} passed, ${results.length - passed} failed, 0 skipped`);
process.exit(passed === results.length ? 0 : 1);
