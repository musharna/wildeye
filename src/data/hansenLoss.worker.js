/**
 * Recolours Global Forest Watch tree-cover-loss data tiles off the main thread (hansenLoss.js). Message in:
 * `{id, url, maxCode}`; out: `{id, bitmap}` (transferred) or `{id, error}`. Raw tiles are cached as blobs so a
 * time-bar scrub re-recolours without re-downloading. No OffscreenCanvas → a named error, never a fallback.
 */
import { recolourPixels } from "./hansenPixels.js";

const BLOB_LIMIT = 256;
const blobs = new Map();

async function blobFor(url) {
  let p = blobs.get(url);
  if (p) blobs.delete(url);
  else
    p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`GFW tile HTTP ${res.status}`);
      return res.blob();
    });
  blobs.set(url, p);
  while (blobs.size > BLOB_LIMIT) blobs.delete(blobs.keys().next().value);
  try {
    return await p;
  } catch (error) {
    if (blobs.get(url) === p) blobs.delete(url);
    throw error;
  }
}

self.onmessage = async ({ data: { id, url, maxCode } }) => {
  try {
    if (typeof OffscreenCanvas === "undefined") throw new Error("forest loss needs OffscreenCanvas in a worker (Safari 16.4 or later)");
    const bitmap = await createImageBitmap(await blobFor(url), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    recolourPixels(image.data, maxCode);
    ctx.putImageData(image, 0, 0);
    const out = canvas.transferToImageBitmap();
    self.postMessage({ id, bitmap: out }, [out]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
