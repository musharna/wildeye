/**
 * What span of observation time a layer can actually serve.
 *
 * Every time-varying layer answers `getObservedExtent()` with `{startMs, endMs}`
 * read off the data it holds (or `{rollingDays}` when its pipeline keeps a
 * rolling window). The shared bar's domain is the union of those answers, so it
 * offers exactly the hours some enabled layer can show — see src/observedTime.js
 * for why a constant here was the wrong model.
 *
 * These helpers turn each layer's own time shape into that pair. They are pure,
 * and every one returns null rather than a half-known range when it is handed
 * nothing usable: a layer with no data must declare no extent, not an empty one.
 */

const DAY_MS = 86_400_000;
const END_OF_DAY = 86_399_999; // 23:59:59.999, so a whole day's last instant is inside the extent

const span = (startMs, endMs) =>
  Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? { startMs, endMs }
    : null;

/** ISO strings or epoch ms (mixed is fine); invalid entries are skipped. */
export function extentFromTimes(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values || []) {
    const ms = typeof v === "number" ? v : Date.parse(v);
    if (!Number.isFinite(ms)) continue;
    if (ms < lo) lo = ms;
    if (ms > hi) hi = ms;
  }
  return span(lo, hi);
}

/** 'YYYY-MM-DD' days, each covering its whole UTC day. */
export function extentFromDays(days) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of days || []) {
    const ms = Date.parse(`${d}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    if (ms < lo) lo = ms;
    if (ms > hi) hi = ms;
  }
  return span(lo, hi + END_OF_DAY);
}

/**
 * Week-bin dates, where each `w` is the bin's LAST day and the bin covers
 * (w − (binDays−1) days … w]. That is the convention binsAt() in hpai.js
 * matches an instant against, so the extent has to include the bin's own tail
 * or the earliest bin would sit outside the span that can select it.
 */
export function extentFromWeekDates(dates, binDays = 7) {
  const e = extentFromDays(dates);
  return e ? { startMs: e.startMs - (binDays - 1) * DAY_MS, endMs: e.endMs } : null;
}

/** 'YYYY-MM' months, each covering its whole calendar month. */
export function extentFromMonths(months) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of months || []) {
    const start = Date.parse(`${m}-01T00:00:00Z`);
    if (!Number.isFinite(start)) continue;
    const d = new Date(start);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
    if (start < lo) lo = start;
    if (end > hi) hi = end;
  }
  return span(lo, hi);
}

/** Union of extents; nulls are ignored, and all-null is null. */
export function unionExtents(extents) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of extents || []) {
    if (!e) continue;
    if (Number.isFinite(e.startMs) && e.startMs < lo) lo = e.startMs;
    if (Number.isFinite(e.endMs) && e.endMs > hi) hi = e.endMs;
  }
  return span(lo, hi);
}

/** Pull `key` off every feature's properties and flatten (features hold arrays of bins). */
export function pluck(features, key, field) {
  const out = [];
  for (const f of features || []) {
    const v = f?.properties?.[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        const x = field ? item?.[field] : item;
        if (x !== undefined && x !== null) out.push(x);
      }
    } else if (field && typeof v === "object") {
      for (const arr of Object.values(v))
        for (const item of arr || []) {
          const x = item?.[field];
          if (x !== undefined && x !== null) out.push(x);
        }
    } else out.push(v);
  }
  return out;
}
