const env = import.meta.env || {};

/** Same-origin static asset URL under the build's base ("/" in dev, "/wildeye/" on Pages). */
export function assetUrl(name, base = env.BASE_URL || '/') {
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}${String(name).replace(/^\/+/, '')}`;
}
