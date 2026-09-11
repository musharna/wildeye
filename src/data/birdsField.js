/**
 * Pure helpers for the radar particle field (no Cesium, no DOM).
 * Particles are ensemble contacts: each stands for ~N birds, never one bird.
 */
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON_EQ = 111320;

/** Cumulative weights over the red channel of an RGBA raster. */
export function buildSpawnCdf(rgba, w, h) {
  const n = w * h;
  const cdf = new Float32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) { total += rgba[i * 4]; cdf[i] = total; }
  return { cdf, total };
}

/** First cell whose cumulative weight exceeds u01·total; never a zero-weight cell. */
export function sampleCell(cdf, u01) {
  const total = cdf[cdf.length - 1];
  const target = Math.min(u01, 0.999999) * total;
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] > target) hi = mid; else lo = mid + 1; }
  return lo;
}

/** Inverse-distance-weighted u,v (m/s) from the k nearest sites (power p). */
export function idwVelocity(sites, lon, lat, k = 3, p = 2) {
  const usable = sites.filter((s) => Number.isFinite(s.u_ms) && Number.isFinite(s.v_ms));
  if (!usable.length) return { u: 0, v: 0 };
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const near = usable.map((s) => {
    const dx = (s.lon - lon) * cosLat, dy = s.lat - lat;
    return { s, d2: dx * dx + dy * dy };
  }).sort((a, b) => a.d2 - b.d2).slice(0, k);
  if (near[0].d2 === 0) return { u: near[0].s.u_ms, v: near[0].s.v_ms };
  let wu = 0, wv = 0, wt = 0;
  for (const { s, d2 } of near) { const w = 1 / Math.pow(d2, p / 2); wu += w * s.u_ms; wv += w * s.v_ms; wt += w; }
  return { u: wu / wt, v: wv / wt };
}

/** Advance one particle by dt seconds. Marks dead outside bounds or past life. */
export function stepParticle(p, dt, bounds, lifeSec) {
  const cosLat = Math.max(0.05, Math.cos((p.lat * Math.PI) / 180));
  const lon = p.lon + (p.u * dt) / (M_PER_DEG_LON_EQ * cosLat);
  const lat = p.lat + (p.v * dt) / M_PER_DEG_LAT;
  const age = p.age + dt;
  const dead = age >= lifeSec || lon < bounds.west || lon > bounds.east || lat < bounds.south || lat > bounds.north;
  return { ...p, lon, lat, age, dead };
}

/** Birds represented by one particle spawned in a cell. */
export function birdsPerParticle(densityKm3, lat, cellDeg, cellWeightShare, particleCount) {
  const cellKm2 = (cellDeg * M_PER_DEG_LAT / 1000) * (cellDeg * M_PER_DEG_LON_EQ * Math.cos((lat * Math.PI) / 180) / 1000);
  const particlesInCell = Math.max(1, cellWeightShare * particleCount);
  return (densityKm3 * cellKm2 * 1) / particlesInCell;
}

/** Deterministic 32-bit PRNG (mulberry32) so a replay frame reseeds identically every time. */
export function seededRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable integer seed from a frame id like "2026-09-09T03". */
export function frameSeed(frameId) {
  let h = 2166136261;
  for (const ch of String(frameId)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
