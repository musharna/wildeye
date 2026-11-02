// Tile servers answer some requests with an error and the same tile 200 a few seconds later: GIBS gave the amphibian
// layer's tile 3/6/4 a 500 on one of three tries, 3 s apart (2026-11-01), and the weekly sweep saw 3 of 48 such tiles
// fail twice. Cesium never asks again for a tile that failed, so one bad answer left a hole until the layer was rebuilt.
// A 5xx, or a failure with no status at all, is worth asking again; a 4xx is an answer, except where a source is
// known to give spurious ones (gibsWorthRetrying).
export const TILE_RETRIES = 2;
export const TILE_RETRY_MS = 1500;

export const worthRetrying = (status) => status === undefined || status === null || status >= 500;

// GIBS answers a tile outside the matrix 400 (row 9 at level 3, probe 2026-11-01) and a missing date with a
// neighbouring image, but it has answered 404 for tiles it serves: the laptop got 404 for amphibians 3/4/3 while
// msi-4080 got 200 for it the same minute, and one run on msi-4080 saw 404s on 9 of 10 layers that all served 200
// on asking again. So for GIBS a 404 is asked again too.
export const gibsWorthRetrying = (status) => status === 404 || worthRetrying(status);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Cesium `Resource` retryCallback, (resource, error) → whether to ask again after a pause, for statuses `worth`. */
export function retryCallback(worth = worthRetrying, wait = sleep) {
  return (_resource, error) => (worth(error?.statusCode) ? wait(TILE_RETRY_MS).then(() => true) : false);
}
