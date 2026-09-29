/**
 * Wait until a freshly loaded wildeye page has finished booting: the loading screen has faded out and the globe has
 * loaded the tiles for the view. The loading screen hides only once the share restore (its camera flight included) has
 * terminated and at least 1 s has passed (src/main.js), and its fade ends with visibility: hidden (style.css).
 *
 * This replaced a fixed 12 s sleep and an Escape press in every QA script (2026-09-28). The sleep waited for a boot
 * camera flight that no longer runs (a fresh session opens with a setView, camera.js showWholeGlobe), and the Escape was a
 * leftover of the first-run launcher removed in 54192b3: probed on the live site, it changed no attribute, focus or hash.
 * @param {import('puppeteer').Page} page
 */
export async function bootSettled(page, { timeout = 180000 } = {}) {
  await page.waitForFunction(() => {
    const viewer = window.__godsEyeView?.viewer;
    const loader = document.getElementById('loading-screen');
    return Boolean(viewer && loader && getComputedStyle(loader).visibility === 'hidden' && viewer.scene.globe.tilesLoaded);
  }, { timeout, polling: 250 });
}
