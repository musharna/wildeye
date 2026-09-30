/**
 * Vite plugin: serve and ship the parts of Cesium that are loaded at runtime rather than bundled.
 *
 * The app imports Cesium from npm, so Rolldown bundles only the members it uses. Cesium still fetches
 * its web workers, assets (star catalogue, terrain heights, IAU tables), third-party WASM and widget CSS
 * at runtime from CESIUM_BASE_URL, which this plugin sets to `<base>cesium/`:
 *
 * - build: copies Build/Cesium/{Assets,ThirdParty,Workers,Widgets} to `<outDir>/cesium/` and starts
 *   every chunk with `window.CESIUM_BASE_URL = "<base>cesium/";`;
 * - dev: serves Build/CesiumUnminified at `<base>cesium/` and defines CESIUM_BASE_URL;
 * - both: links Widgets/widgets.css from index.html.
 *
 * Replaces vite-plugin-cesium 1.2.23 (2024, unmaintained), which copied to outDir + base + "cesium/" —
 * dist/wildeye/cesium for the Pages base /wildeye/, a path nothing serves — and caught a failed copy
 * with console.error, so a build with no Cesium workers still exited 0.
 *
 * @module scripts/viteCesium
 */

import { cp } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIRS = ['Assets', 'ThirdParty', 'Workers', 'Widgets'];
const CONTENT_TYPES = {
  '.js': 'text/javascript', '.cjs': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

/** `<base>cesium/`, the URL Cesium's runtime files are served from; Vite's base '' means './'. */
const cesiumUrl = (base = '/') => path.posix.join(base === '' ? './' : base, 'cesium/');

/**
 * Connect middleware serving files under `root`; anything that resolves outside it is refused.
 * Mounted at the Cesium URL, so `req.url` arrives with that prefix already stripped.
 */
const serveDir = (root) => (req, res, next) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://dev').pathname);
  } catch {
    res.statusCode = 400;
    return res.end();
  }
  const file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(root + path.sep)) {
    res.statusCode = 403;
    return res.end();
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return next();
  }
  if (!stat.isFile()) return next();
  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  createReadStream(file).on('error', next).pipe(res);
};

/**
 * @param {object} [options]
 * @param {string} [options.buildRoot] Cesium's Build directory (holds Cesium/ and CesiumUnminified/).
 * @returns {import('vite').Plugin}
 */
export default function cesium({ buildRoot = path.join(REPO, 'node_modules/cesium/Build') } = {}) {
  let url = cesiumUrl();
  let outDir = '';
  let isBuild = false;
  return {
    name: 'wildeye-cesium',
    config(config, { command }) {
      isBuild = command === 'build';
      url = cesiumUrl(config.base);
      return isBuild ? {} : { define: { CESIUM_BASE_URL: JSON.stringify(url) } };
    },
    configResolved(resolved) {
      outDir = path.resolve(resolved.root, resolved.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(url, serveDir(path.join(buildRoot, 'CesiumUnminified')));
    },
    intro() {
      return isBuild ? `window.CESIUM_BASE_URL = ${JSON.stringify(url)};` : '';
    },
    transformIndexHtml() {
      // First in <head>, so the app's own stylesheets come later and win the cascade.
      return [{ tag: 'link', attrs: { rel: 'stylesheet', href: `${url}Widgets/widgets.css` }, injectTo: 'head-prepend' }];
    },
    async closeBundle() {
      if (!isBuild) return;
      // The site is served from outDir at base, so base + "cesium/" is outDir/cesium. A failed copy throws:
      // a site without its workers boots to a blank globe.
      for (const dir of RUNTIME_DIRS) {
        await cp(path.join(buildRoot, 'Cesium', dir), path.join(outDir, 'cesium', dir), { recursive: true });
      }
    },
  };
}
