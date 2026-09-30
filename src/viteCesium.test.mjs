import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build, createServer } from 'vite';
import cesium from '../scripts/viteCesium.mjs';

// A stand-in for node_modules/cesium/Build: the four directories the site needs at runtime, one file each,
// in both the minified tree (copied into builds) and the unminified one (served by the dev server).
const DIRS = ['Assets', 'ThirdParty', 'Workers', 'Widgets'];
const fixture = ({ omit } = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wildeye-cesium-'));
  const buildRoot = path.join(root, 'Build');
  for (const tree of ['Cesium', 'CesiumUnminified']) {
    for (const dir of DIRS.filter((d) => d !== omit)) {
      mkdirSync(path.join(buildRoot, tree, dir), { recursive: true });
      writeFileSync(path.join(buildRoot, tree, dir, dir === 'Widgets' ? 'widgets.css' : 'f.js'), `/* ${tree}/${dir} */`);
    }
  }
  writeFileSync(path.join(buildRoot, 'secret.txt'), 'outside the served tree');
  const app = path.join(root, 'app');
  mkdirSync(app);
  writeFileSync(path.join(app, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><script type="module" src="/main.js"></script></body></html>');
  writeFileSync(path.join(app, 'app.css'), '.cesium-widget { color: red; }');
  writeFileSync(path.join(app, 'main.js'), 'console.log(typeof CESIUM_BASE_URL === "undefined" ? "unset" : CESIUM_BASE_URL);');
  return { root, buildRoot, app };
};
const pagesBuild = (fx, outDir) => build({
  root: fx.app, base: '/wildeye/', configFile: false, logLevel: 'silent',
  build: { outDir, emptyOutDir: true },
  plugins: [cesium({ buildRoot: fx.buildRoot })],
});

test('a Pages build puts Cesium where base + cesium/ serves it, and a failed copy fails the build', async () => {
  const fx = fixture();
  const out = path.join(fx.root, 'dist');
  try {
    await pagesBuild(fx, out);
    // The site is served from out/ at /wildeye/, so /wildeye/cesium/ is out/cesium/, not out/wildeye/cesium/.
    for (const dir of DIRS) assert.ok(existsSync(path.join(out, 'cesium', dir)), `dist/cesium/${dir} missing`);
    assert.equal(existsSync(path.join(out, 'wildeye')), false, 'Cesium copied under the base path again');
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    // widgets.css must come before the app's stylesheets, or its rules beat the app's overrides of them.
    const widgets = html.indexOf('<link rel="stylesheet" href="/wildeye/cesium/Widgets/widgets.css">');
    const appCss = html.search(/<link rel="stylesheet"[^>]*href="\/wildeye\/assets\/[^"]+\.css"/);
    assert.ok(widgets >= 0 && appCss >= 0, html);
    assert.ok(widgets < appCss, `widgets.css linked after the app's stylesheet:\n${html}`);
    const js = readdirSync(path.join(out, 'assets')).filter((f) => f.endsWith('.js'));
    assert.equal(js.length, 1);
    assert.match(readFileSync(path.join(out, 'assets', js[0]), 'utf8'), /window\.CESIUM_BASE_URL\s*=\s*(["`])\/wildeye\/cesium\/\1/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }

  const broken = fixture({ omit: 'Workers' });
  try {
    await assert.rejects(pagesBuild(broken, path.join(broken.root, 'dist')), /Workers/);
  } finally {
    rmSync(broken.root, { recursive: true, force: true });
  }
});

const get = (port, urlPath) => new Promise((resolve, reject) => {
  // node:http sends the path as written; fetch() would resolve the dot segments before they reach the server.
  const req = request({ host: '127.0.0.1', port, path: urlPath }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
  });
  req.on('error', reject);
  req.end();
});

test('the dev server serves unminified Cesium at /cesium/ and nothing outside it', async () => {
  const fx = fixture();
  const server = await createServer({
    root: fx.app, configFile: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [cesium({ buildRoot: fx.buildRoot })],
  });
  try {
    await server.listen();
    const { port } = server.httpServer.address();
    const worker = await get(port, '/cesium/Workers/f.js');
    assert.equal(worker.status, 200);
    assert.equal(worker.body, '/* CesiumUnminified/Workers */');
    assert.match(worker.type, /^(text|application)\/javascript/);
    assert.match((await get(port, '/cesium/Widgets/widgets.css')).type, /^text\/css/);
    // Vite resolves plain and %2e dot segments before routing (those get its index.html fallback); an encoded
    // slash survives routing and only decodes inside the middleware, so it is the case the containment check meets.
    for (const escape of ['/cesium/../secret.txt', '/cesium/..%2fsecret.txt', '/cesium/%2e%2e/secret.txt', '/cesium/..%5csecret.txt']) {
      assert.doesNotMatch((await get(port, escape)).body, /outside the served tree/, escape);
    }
    assert.equal((await get(port, '/cesium/..%2fsecret.txt')).status, 403);
    // In dev Vite does not substitute `define` into modules: its env module assigns each one to globalThis.
    assert.match((await get(port, '/@vite/env')).body, /"CESIUM_BASE_URL": "\/cesium\/"/, 'CESIUM_BASE_URL is not defined in dev');
  } finally {
    await server.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});
