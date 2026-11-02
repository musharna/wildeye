// Tile servers answer some requests 5xx and the same tile 200 a few seconds later: GIBS gave the amphibian layer's
// tile 3/6/4 a 500 on one of three tries, 3 s apart (2026-11-01), and the weekly sweep saw 3 of 48 such tiles fail
// twice. Cesium never asks again for a tile that failed, so one bad answer left a hole until the layer was rebuilt.
// A 4xx is an answer; a 5xx, or a failure with no status at all, is worth asking again.
export const TILE_RETRIES = 2;
export const TILE_RETRY_MS = 1500;

export const worthRetrying = (status) => status === undefined || status === null || status >= 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Cesium `Resource` retryCallback: (resource, error) → whether to ask again, after a pause. */
export function retryTileError(_resource, error, wait = sleep) {
  return worthRetrying(error?.statusCode) ? wait(TILE_RETRY_MS).then(() => true) : false;
}
