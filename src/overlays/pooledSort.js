/**
 * @module pooledSort
 * @description Allocation-free stable sort over the live prefix of a pooled
 * array, for per-frame paths where `Array#sort` would allocate a work buffer
 * per call.
 */

/** Length of the insertion-sorted runs that the merge passes combine. */
export const POOLED_SORT_RUN = 16;

// Module-owned merge buffer. It only ever grows, so a steady frame reuses it.
const _scratch = [];

/**
 * Stable in-place sort of `items[0..count)`.
 *
 * The world-overlay paint queue is NOT nearly sorted: `solveDomains` fills it
 * in domain/solve order, and with every shared-host source live (~350 painted
 * items) it arrives with ~n²/3.4 inversions (measured 2026-09-24). A plain
 * insertion sort therefore spent ~36k comparisons per frame. Insertion-sorted
 * runs of `POOLED_SORT_RUN` merged bottom-up bound the work at O(n log n)
 * whatever the input order, and still cost O(n) on already-sorted input.
 *
 * @template T
 * @param {T[]} items
 * @param {number} count live prefix length; entries past it are untouched
 * @param {(a: T, b: T) => number} compare
 */
export function sortPooledRange(items, count, compare) {
  for (let lo = 0; lo < count; lo += POOLED_SORT_RUN) {
    const hi = Math.min(lo + POOLED_SORT_RUN, count);
    for (let i = lo + 1; i < hi; i++) {
      const item = items[i];
      let j = i - 1;
      while (j >= lo && compare(items[j], item) > 0) {
        items[j + 1] = items[j];
        j--;
      }
      items[j + 1] = item;
    }
  }
  if (count <= POOLED_SORT_RUN) return;

  let src = items;
  let dst = _scratch;
  for (let width = POOLED_SORT_RUN; width < count; width *= 2) {
    for (let lo = 0; lo < count; lo += 2 * width) {
      const mid = Math.min(lo + width, count);
      const hi = Math.min(lo + 2 * width, count);
      let i = lo;
      let j = mid;
      let k = lo;
      // Runs already in order (always true when the right run is empty) are
      // copied after one comparison, which keeps sorted input at O(n).
      if (j >= hi || compare(src[j - 1], src[j]) <= 0) {
        while (k < hi) dst[k++] = src[i++];
        continue;
      }
      // Take from the right run only when strictly smaller: ties keep their
      // input order, so the sort stays stable.
      while (i < mid && j < hi) dst[k++] = compare(src[j], src[i]) < 0 ? src[j++] : src[i++];
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
  if (src !== items) {
    for (let i = 0; i < count; i++) items[i] = src[i];
  }
}
