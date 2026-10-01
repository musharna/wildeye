/**
 * Exact PNG decoding for tile readouts. A 2D canvas stores colour premultiplied by alpha, so reading a
 * semi-transparent pixel back through one rounds its colour (JRC's 83% water, 43,0,211,212, read back as
 * 43,0,210,212: QA 2026-10-01). Decoding the file's own bytes returns exactly what the tile holds.
 * Every readout source is an 8-bit, non-interlaced RGB, RGBA or palette PNG (probe 2026-10-01: GIBS palette +
 * tRNS, GFW and JRC RGBA, JRC open-sea RGB); anything else is refused by name rather than guessed at.
 */
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 2: 3, 3: 1, 6: 4 };

async function inflateZlib(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** PNG bytes → `{width, height, data}` with `data` straight RGBA, 4 bytes a pixel. */
export async function decodePng(bytes) {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, type = -1, palette = null, alpha = null;
  const idat = [];
  for (let at = 8; ; ) {
    if (at + 12 > bytes.length) throw new Error("truncated PNG: no IEND");
    const length = view.getUint32(at);
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (data.length !== length) throw new Error(`truncated PNG: ${kind} chunk cut short`);
    if (kind === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (8 only)`);
      if (!(colour in CHANNELS)) throw new Error(`PNG colour type ${colour} is not supported (2, 3, 6 only)`);
      if (interlace !== 0) throw new Error("interlaced PNG is not supported");
      type = colour;
    } else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") alpha = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  if (type < 0) throw new Error("PNG has no IHDR");
  if (type === 3 && !palette) throw new Error("palette PNG has no PLTE");
  if (alpha && type !== 3) throw new Error(`PNG colour type ${type} with a tRNS colour key is not supported`);

  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((off, c) => (joined.set(c, off), off + c.length), 0);
  const raw = await inflateZlib(joined);
  const bpp = CHANNELS[type], stride = width * bpp;
  if (raw.length !== height * (stride + 1)) throw new Error(`PNG image data is ${raw.length} bytes, expected ${height * (stride + 1)}`);

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? pixels[dst + i - bpp] : 0;
      const b = y > 0 ? pixels[up + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[up + i - bpp] : 0;
      let pred;
      if (filter === 0) pred = 0;
      else if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) pred = paeth(a, b, c);
      else throw new Error(`PNG row ${y} has filter type ${filter}`);
      pixels[dst + i] = (raw[src + i] + pred) & 255;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    const o = p * 4;
    if (type === 6) data.set(pixels.subarray(o, o + 4), o);
    else if (type === 2) {
      data.set(pixels.subarray(p * 3, p * 3 + 3), o);
      data[o + 3] = 255;
    } else {
      const index = pixels[p];
      if (index * 3 + 2 >= palette.length) throw new Error(`PNG palette index ${index} is beyond its ${palette.length / 3} entries`);
      data.set(palette.subarray(index * 3, index * 3 + 3), o);
      data[o + 3] = alpha && index < alpha.length ? alpha[index] : 255;
    }
  }
  return { width, height, data };
}
