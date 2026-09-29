/**
 * The bundle-string half of qa-bloat.mjs, pure so it can be unit tested (src/bundleStrings.test.mjs).
 *
 * `scripts` is every /assets/*.js the page loaded: [{ url: 'index-XXXX.js', text }]. Returns the
 * `${url}: ${needle}` pairs for each needle an APP chunk still contains. The needles name God's Eye
 * code, so vendor chunks (vite.config.js manualChunks, all named vendor-*) are not searched: Cesium
 * carries Google endpoints as inert defaults (tile.googleapis.com always; maps.googleapis.com since
 * 1.145), and whether any code calls them is the `requests` check's job.
 */
export const isVendorChunk = (url) => /^vendor-/.test(url);

export function bundleLeftovers(scripts, needles) {
  return scripts.filter((s) => !isVendorChunk(s.url))
    .flatMap((s) => needles.filter((needle) => s.text.includes(needle)).map((needle) => `${s.url}: ${needle}`));
}
