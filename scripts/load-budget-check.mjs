#!/usr/bin/env node
/**
 * load-budget-check — what a fresh load fetches before the app is ready.
 *
 * Serves the built `dist/` with `vite preview`, drives fresh headless loads
 * (cache disabled, new browser context each), and records every same-origin
 * script/data file whose fetch STARTED before `window.__godsEyeView.styleManager`
 * existed. Two things are gated, both exact:
 *
 *   1. the SET of files on the startup path (content hashes stripped), so a
 *      module pulled onto it — the way the 2.7 MB EGM96 grid is fetched on the
 *      HUD's first tick — is a red build, not a silent regression;
 *   2. the bytes of VENDOR files (`/cesium/*`, and chunks named after a
 *      package.json dependency), which change only on a dependency bump.
 *
 * The app's own chunks are printed but not byte-gated: their size moves with
 * nearly every edit, and a gate that fails on every PR teaches people to
 * rubber-stamp `--update`. Timing is never gated (see
 * `~/wiki/methods/deterministic-perf-ratchet.md`): milliseconds on a shared
 * runner cannot tell a slow host from a regression.
 *
 * Every run loads twice and fails if the two loads disagree, so the gate's own
 * determinism is checked on every run rather than assumed.
 *
 * Ratchet (same contract as callcount-check.mjs): an added file or a vendor
 * byte rise fails; a removed file or a vendor byte drop also fails until it is
 * locked in with `--update`; raising needs `--update --allow-increase`.
 *
 * Usage: npm run build && node scripts/load-budget-check.mjs [--update [--allow-increase]] [--json]
 * Chrome: $PUPPETEER_EXECUTABLE_PATH, else Puppeteer's download, else a system
 * google-chrome (GitHub's ubuntu runners ship one).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BASELINE_PATH = path.join(ROOT, 'scripts/load-budget-baseline.json');
const LOADS = 2;
const READY_TIMEOUT_MS = 120_000;

/** `/assets/index-DB4WOJsT.js` → `index.js`; `/cesium/Cesium.js` unchanged. */
export function resourceKey(pathname) {
  const clean = pathname.split(/[?#]/)[0];
  if (clean.startsWith('/assets/')) {
    return clean.slice('/assets/'.length).replace(/-[A-Za-z0-9_-]{8}(?=\.[A-Za-z0-9]+$)/, '');
  }
  return clean;
}

/** Vendor = Cesium's static tree, or a chunk named after a runtime dependency. */
export function isVendorKey(key, dependencyNames) {
  if (key.startsWith('/cesium/')) return true;
  const stem = key.replace(/\.[^.]+$/, '').replace(/\.esm$/, '');
  return dependencyNames.includes(stem);
}

/**
 * Compare one measured load to the baseline. Pure, so the ratchet's verdicts
 * are unit-testable without a browser.
 * @param {{files: string[], vendorBytes: Record<string, number>}} baseline
 * @param {{files: string[], vendorBytes: Record<string, number>}} measured
 */
export function compareLoad(baseline, measured) {
  const before = new Set(baseline.files);
  const after = new Set(measured.files);
  const added = measured.files.filter((file) => !before.has(file));
  const removed = baseline.files.filter((file) => !after.has(file));
  const vendorDeltas = Object.keys({ ...baseline.vendorBytes, ...measured.vendorBytes })
    .map((key) => ({ key, delta: (measured.vendorBytes[key] ?? 0) - (baseline.vendorBytes[key] ?? 0) }))
    .filter((row) => row.delta !== 0);
  const rose = added.length > 0 || vendorDeltas.some((row) => row.delta > 0);
  const dropped = removed.length > 0 || vendorDeltas.some((row) => row.delta < 0);
  const verdict = rose ? 'regressed' : dropped ? 'improved' : 'equal';
  return { verdict, added, removed, vendorDeltas };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite preview exited ${child.exitCode} before serving ${url}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`vite preview did not serve ${url} within ${timeoutMs} ms`);
}

async function chromePath(puppeteer) {
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH];
  try { candidates.push(puppeteer.executablePath()); } catch { /* download skipped */ }
  candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error(`no Chrome found; tried ${candidates.filter(Boolean).join(', ')}`);
  return found;
}

/** One fresh load: same-origin files whose fetch started before app-ready. */
async function measureLoad(browser, url, dependencyNames) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCacheEnabled(false);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT_MS });
    try {
      await page.waitForFunction(() => !!window.__godsEyeView?.styleManager, { timeout: READY_TIMEOUT_MS, polling: 50 });
    } catch (error) {
      // Fail loud: say why the app never became ready, not just that it didn't.
      const state = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const info = gl?.getExtension('WEBGL_debug_renderer_info');
        return { webgl2: gl ? gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null, app: typeof window.__godsEyeView };
      }).catch((probeError) => ({ probeError: probeError.message }));
      throw new Error(`${error.message}\n  page state: ${JSON.stringify(state)}\n  ${pageErrors.slice(0, 8).join('\n  ') || '(no page or console errors)'}`);
    }
    const entries = await page.evaluate(() => {
      const readyAt = performance.now();
      return performance.getEntriesByType('resource')
        .filter((entry) => entry.startTime < readyAt)
        .map((entry) => ({ url: entry.name, bytes: entry.decodedBodySize || 0 }));
    });
    const origin = new URL(url).origin;
    const files = [];
    const vendorBytes = {};
    const appBytes = {};
    for (const entry of entries) {
      const resource = new URL(entry.url);
      if (resource.origin !== origin) continue;
      if (!/\.(m?js|json|geojsonl?|wasm|bin)$/i.test(resource.pathname)) continue;
      const key = resourceKey(resource.pathname);
      if (files.includes(key)) continue;
      files.push(key);
      if (isVendorKey(key, dependencyNames)) vendorBytes[key] = entry.bytes;
      else appBytes[key] = entry.bytes;
    }
    files.sort();
    // Harness assertion: the real app bundle loaded, not an error page that
    // happened to define nothing.
    if (!files.includes('index.js')) {
      throw new Error(`app entry index.js not among startup files: ${files.join(', ') || '(none)'}`);
    }
    return { files, vendorBytes, appBytes };
  } finally {
    await context.close();
  }
}

function formatDiff(result, measured) {
  const lines = [`${result.verdict.toUpperCase()}: ${measured.files.length} startup files`];
  for (const file of result.added) lines.push(`  + ${file}`);
  for (const file of result.removed) lines.push(`  - ${file}`);
  for (const { key, delta } of result.vendorDeltas) lines.push(`  ${delta > 0 ? '+' : ''}${delta} B  ${key}`);
  const app = Object.entries(measured.appBytes).map(([key, bytes]) => `${key} ${Math.round(bytes / 1024)} KB`).join(', ');
  const vendor = Object.values(measured.vendorBytes).reduce((sum, bytes) => sum + bytes, 0);
  lines.push(`  vendor ${Math.round(vendor / 1024)} KB (gated) · app ${app || 'none'} (reported only)`);
  return lines.join('\n');
}

async function main(argv) {
  const update = argv.includes('--update');
  const allowIncrease = argv.includes('--allow-increase');
  if (!existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('dist/ is missing: run `npm run build` first');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dependencyNames = Object.keys(pkg.dependencies || {});
  const { default: puppeteer } = await import('puppeteer');

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const preview = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  let browser;
  try {
    await waitForHttp(url, preview, 60_000);
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: await chromePath(puppeteer),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--window-size=1440,900'],
    });
    const loads = [];
    for (let index = 0; index < LOADS; index += 1) loads.push(await measureLoad(browser, url, dependencyNames));
    const [measured, repeat] = loads;
    const agreement = compareLoad(measured, repeat);
    if (agreement.verdict !== 'equal') {
      throw new Error(`two fresh loads disagreed, so this gate is not deterministic here:\n${formatDiff(agreement, repeat)}`);
    }

    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const result = compareLoad({ files: baseline.files || [], vendorBytes: baseline.vendorBytes || {} }, measured);
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ...result, measured })}\n`);
    else console.log(formatDiff(result, measured));

    if (update) {
      if (result.verdict === 'regressed' && !allowIncrease) {
        console.error('refusing to raise the baseline; pass --allow-increase if the extra startup weight is intended');
        return 1;
      }
      writeFileSync(BASELINE_PATH, `${JSON.stringify({ note: baseline.note, files: measured.files, vendorBytes: measured.vendorBytes }, null, 2)}\n`);
      console.log(`wrote ${path.relative(ROOT, BASELINE_PATH)}`);
      return 0;
    }
    if (result.verdict === 'improved') console.error('startup got lighter: lock it in with `npm run perf:load -- --update` and commit the baseline');
    if (result.verdict === 'regressed') console.error('startup got heavier: find the added file or vendor bytes above, or accept with `--update --allow-increase`');
    return result.verdict === 'equal' ? 0 : 1;
  } finally {
    if (browser) await browser.close();
    preview.kill();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.stack || String(error));
    process.exitCode = 2;
  });
}
