/**
 * Whether this build talks to the local Vite server's /api/* proxies.
 * The GitHub Pages build is a static host: `pipeline/deploy_pages.sh` sets VITE_STATIC_HOST=1, and
 * every feature that needs a server (AI HUD summary, voice agent, key setup, live flight/vessel/
 * satellite/traffic feeds) stays off instead of firing requests that 404/405 on every page load.
 */
const env = import.meta.env || {};

export const HAS_BACKEND = env.VITE_STATIC_HOST !== '1';

/** Same-origin static asset URL under the build's base ("/" in dev, "/wildeye/" on Pages). */
export function assetUrl(name, base = env.BASE_URL || '/') {
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}${String(name).replace(/^\/+/, '')}`;
}
