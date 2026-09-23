import { extentFromDays } from "./observedExtent.js";

/**
 * Dates a GIBS layer serves, read off the ISO intervals in its capabilities Dimension
 * ("start/end/P16D", one per year for MODIS composites). GIBS answers a date it does not
 * serve with a neighbouring image and HTTP 200, so the date shown and labelled must be
 * resolved here, never passed through (probe 2026-09-22: EVI 2026-08-30 == 2026-08-29).
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseInterval(interval) {
  const parts = String(interval).split("/");
  if (
    parts.length !== 3 ||
    !DAY.test(parts[0].slice(0, 10)) ||
    !DAY.test(parts[1].slice(0, 10))
  ) {
    throw new Error(`malformed GIBS interval ${interval}`);
  }
  const m = /^P(\d+)([DMY])$/.exec(parts[2]);
  if (!m) throw new Error(`unsupported GIBS period ${parts[2]}`);
  return {
    start: Date.parse(`${parts[0].slice(0, 10)}T00:00:00Z`),
    end: Date.parse(`${parts[1].slice(0, 10)}T00:00:00Z`),
    n: Number(m[1]),
    unit: m[2],
  };
}

function step(ms, n, unit) {
  const d = new Date(ms);
  if (unit === "D") d.setUTCDate(d.getUTCDate() + n);
  else if (unit === "M") d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.getTime();
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Newest served day at or before `iso`; null when every served day is later. */
export function dateAtOrBefore(times, iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  let best = null;
  for (const interval of times || []) {
    const { start, end, n, unit } = parseInterval(interval);
    for (let ms = start; ms <= end && ms <= t; ms = step(ms, n, unit))
      if (best === null || ms > best) best = ms;
  }
  return best === null ? null : day(best);
}

export function latestDate(times) {
  let best = null;
  for (const interval of times || []) {
    const { start, end, n, unit } = parseInterval(interval);
    let last = start;
    for (let ms = start; ms <= end; ms = step(ms, n, unit)) last = ms;
    if (best === null || last > best) best = last;
  }
  return best === null ? null : day(best);
}

/** First served day through the last served day, each covering its whole UTC day. */
export function extentOfTimes(times) {
  if (!times?.length) return null;
  const first = Math.min(...times.map((i) => parseInterval(i).start));
  return extentFromDays([day(first), latestDate(times)]);
}
