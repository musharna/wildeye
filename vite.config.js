/**
 * Vite configuration for wildeye: Cesium bundling, the local dev server and
 * the production build. The site is static; there is no server-side API.
 *
 * @module vite.config
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import cesium from 'vite-plugin-cesium';

/** Resolve __dirname for ESM context. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Main Vite configuration factory.
 *
 * Loads .env files via Vite's loadEnv (HOST/PORT), registers the Cesium
 * plugin and configures the dev server and build.
 */
export default defineConfig(({ mode }) => {
  // Load only this checkout's dotenv files. Shell/Keychain values still win,
  // and no sibling workspace is consulted implicitly.
  const loaded = loadEnv(mode, __dirname, '');
  for (const [key, val] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
  const env = { ...process.env };
  const localAllowedHosts = ['localhost', '127.0.0.1', '.local'];
  return {
    plugins: [
      // rebuildCesium: bundle Cesium from npm so Rollup keeps only the ~100
      // members the app uses, instead of serving the prebuilt 5.7 MB Cesium.js
      // (1.69 MB gzip) whole. The plugin still copies Workers/Assets/ThirdParty/
      // Widgets to /cesium/ and links widgets.css. Startup JS: 2.19 -> 1.58 MB gzip.
      cesium({ rebuildCesium: true }),
    ],
    server: {
      host: env.HOST || 'localhost',
      port: parseInt(env.PORT, 10) || 4173,
      // When binding to all interfaces, allow any host; otherwise restrict to local names
      allowedHosts: (env.HOST === '0.0.0.0' || env.HOST === '::')
        ? true
        : localAllowedHosts,
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'],
      },
      // Framing protection on everything this dev server serves: a hostile page
      // cannot frame the app and lure clicks onto it.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    build: {
      // The Cesium engine bundle is inherently large; raise the warning ceiling
      // so the build log isn't dominated by an expected chunk-size notice.
      chunkSizeWarningLimit: 1500,
      // dist/.vite/manifest.json maps each built file to its source module;
      // scripts/load-budget-check.mjs keys the startup gate by it.
      manifest: true,
      rolldownOptions: {
        output: {
          // Cesium in its own chunk: its hash changes only when Cesium or the
          // set of Cesium members the app uses changes, so an app-only deploy
          // does not make every visitor re-download ~1.4 MB of engine.
          codeSplitting: {
            groups: [
              { name: 'vendor-cesium', test: /[\\/]node_modules[\\/](cesium|@cesium)[\\/]/ },
            ],
          },
        },
      },
    },
  };
});
