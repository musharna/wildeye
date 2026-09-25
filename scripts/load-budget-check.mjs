#!/usr/bin/env node
/**
 * load-budget-check — what a fresh load fetches during startup.
 *
 * Serves the built `dist/` with `vite preview`, drives fresh headless loads
 * (cache disabled, new browser context each), waits for
 * `window.__godsEyeView.styleManager`, then until no new same-origin
 * script/data file has arrived for 3 s, and records every one fetched. The
 * ready signal alone is not a cut: the HUD's first-tick geoid fetch lands on
 * either side of it from load to load. Two things are gated, both exact:
 *
 *   1. the SET of files on the startup path, keyed by the source module each
 *      came from (Vite's build manifest; Cesium's static tree by path), so a
 *      module pulled onto it — the way the 2.77 MB egm96-universal grid was
 *      fetched on the HUD's first tick until it was replaced — is a red build, not a silent regression;
 *   2. the bytes of VENDOR files (sources under `node_modules/`, and
 *      `/cesium/*`), which change only on a dependency bump.
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
const SETTLE_QUIET_MS = 3_000;
const SETTLE_MAX_MS = 30_000;
/**
 * Cesium's web workers (/cesium/Workers/*) are started by the engine as terrain
 * tiles stream in, so WHICH of them a load starts depends on how far streaming
 * got, not on the app's code: under load one run started
 * incrementallyBuildTerrainPicker.js and the next did not. They are out of the
 * file set and the settle count. Their bytes move only with the Cesium version,
 * which the gated vendor-cesium chunk already tracks.
 */
export const STREAMING_DRIVEN = /^\/cesium\/Workers\//;

/**
 * Map each built file to the source module it came from, using Vite's build
 * manifest (`build.manifest: true`): `/assets/index-DB4WOJsT.js` → `index.html`,
 * `/assets/egm96-universal.esm-D6y_VLZc.js` →
 * `node_modules/egm96-universal/dist/egm96-universal.esm.js`. Keying by source
 * rather than by a hash-stripped file name keeps two chunks that share a name
 * distinct, and tells vendor code from app code by where it actually lives.
 *
 * A chunk with no source module (a `manualChunks` group such as Cesium's) has
 * a manifest key like `_vendor-cesium-CNfq2d1x.js`, which changes with every
 * content hash; it is keyed by its chunk NAME instead, `chunk:vendor-cesium`.
 * @param {Record<string, {file: string, src?: string, name?: string}>} manifest
 */
export function manifestSources(manifest) {
  const sources = {};
  for (const [key, chunk] of Object.entries(manifest)) {
    if (!chunk.src) {
      if (!chunk.name) throw new Error(`manifest chunk ${key} has neither src nor name: cannot key it stably`);
      sources[`/${chunk.file}`] = `chunk:${chunk.name}`;
      continue;
    }
    // A symlinked node_modules resolves to e.g. `../wildeye/node_modules/...`;
    // key from the last node_modules/ so the baseline is checkout-independent.
    const source = chunk.src;
    const at = source.lastIndexOf('node_modules/');
    sources[`/${chunk.file}`] = at >= 0 ? source.slice(at) : source;
  }
  return sources;
}

/**
 * Stable key for a served file: its manifest source when it is a build output,
 * else the served path (Cesium's static tree is copied, not bundled). A build
 * output missing from the manifest means dist/ and its manifest disagree.
 */
export function startupKey(pathname, sources) {
  const clean = pathname.split(/[?#]/)[0];
  if (sources[clean]) return sources[clean];
  if (clean.startsWith('/assets/')) {
    throw new Error(`${clean} is a build output missing from dist/.vite/manifest.json: rebuild dist/`);
  }
  return clean;
}

/** Vendor = code that lives in a dependency: a node_modules source or Cesium's static tree. */
export function isVendorKey(key) {
  return key.startsWith('node_modules/') || key.startsWith('/cesium/') || key.startsWith('chunk:vendor-');
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

/**
 * Collapse resource-timing entries into the startup file set and per-file
 * bytes. A file can appear more than once — Cesium's workers each import the
 * same shared chunks — and a repeat fetch served from a coalesced or cached
 * request records decodedBodySize 0. Taking the FIRST entry made the bytes
 * depend on which fetch finished first, so two loads disagreed; a file's size
 * is a property of the file, so the largest body seen is used.
 * @param {{url: string, bytes: number}[]} entries
 */
export function summarizeEntries(entries, origin, sources) {
  const vendorBytes = {};
  const appBytes = {};
  for (const entry of entries) {
    const resource = new URL(entry.url);
    if (resource.origin !== origin) continue;
    if (!/\.(m?js|json|geojsonl?|wasm|bin)$/i.test(resource.pathname)) continue;
    if (STREAMING_DRIVEN.test(resource.pathname)) continue;
    const key = startupKey(resource.pathname, sources);
    const bucket = isVendorKey(key) ? vendorBytes : appBytes;
    bucket[key] = Math.max(bucket[key] ?? 0, entry.bytes);
  }
  const files = [...Object.keys(vendorBytes), ...Object.keys(appBytes)].sort();
  return { files, vendorBytes, appBytes };
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
async function measureLoad(browser, url, sources) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCacheEnabled(false);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`); });
    // A worker started from a blob: or data: URL loads its code with
    // importScripts inside the worker, which never reaches the page's resource
    // timeline — the prebuilt Cesium.js ran its workers that way and ~360 KB of
    // /cesium/Workers/* went uncounted. Such a load cannot be measured, so fail.
    const opaqueWorkers = [];
    page.on('workercreated', (worker) => { if (!/^https?:/.test(worker.url())) opaqueWorkers.push(worker.url().slice(0, 80)); });
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
    // "Before ready" is a race: the HUD requests the geoid grid on its first
    // tick, which lands either side of the ready signal from load to load.
    // Count every static file startup fetches instead: wait until no new one
    // has arrived for SETTLE_QUIET_MS. Quiet that never arrives is a failure.
    const staticCount = () => page.evaluate((origin, streamingPrefix) => performance.getEntriesByType('resource')
      .filter((entry) => entry.name.startsWith(origin)
        && /\.(m?js|json|geojsonl?|wasm|bin)(\?|#|$)/i.test(new URL(entry.name).pathname)
        && !new URL(entry.name).pathname.startsWith(streamingPrefix))
      .length, new URL(url).origin, '/cesium/Workers/');
    const settleDeadline = Date.now() + SETTLE_MAX_MS;
    let lastCount = await staticCount();
    let quietSince = Date.now();
    while (Date.now() - quietSince < SETTLE_QUIET_MS) {
      if (Date.now() > settleDeadline) {
        throw new Error(`startup never went quiet: same-origin static files still arriving after ${SETTLE_MAX_MS} ms (${lastCount} so far)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const count = await staticCount();
      if (count !== lastCount) {
        lastCount = count;
        quietSince = Date.now();
      }
    }
    if (opaqueWorkers.length > 0) {
      throw new Error(`${opaqueWorkers.length} worker(s) started from a non-http URL (${opaqueWorkers[0]}…): what they load is invisible to this gate`);
    }
    const entries = await page.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => ({ url: entry.name, bytes: entry.decodedBodySize || 0 })));
    const { files, vendorBytes, appBytes } = summarizeEntries(entries, new URL(url).origin, sources);
    // Harness assertion: the real app bundle loaded, not an error page that
    // happened to define nothing.
    if (!files.includes('index.html')) {
      throw new Error(`app entry (manifest source index.html) not among startup files: ${files.join(', ') || '(none)'}`);
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
  const manifestPath = path.join(ROOT, 'dist/.vite/manifest.json');
  if (!existsSync(manifestPath)) throw new Error('dist/.vite/manifest.json is missing: vite.config.js must keep build.manifest on');
  const sources = manifestSources(JSON.parse(readFileSync(manifestPath, 'utf8')));
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
      // Software WebGL everywhere: GitHub's GPU-less runner gets no context
      // otherwise, and the gate measures fetches, not rendering.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--window-size=1440,900'],
    });
    const loads = [];
    for (let index = 0; index < LOADS; index += 1) loads.push(await measureLoad(browser, url, sources));
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
