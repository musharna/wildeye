/**
 * IUCN Red List category per sightings taxon (pipeline/iucn.py, monthly).
 * Not a layer: `loadIucn()` reads the seed once, `iucnBadge(taxonKey)` returns
 * a chip the sightings info box appends. Absent seed → no badges, no error.
 *
 * Terms of Use §3: IUCN "places no restrictions on use of the IUCN Red List
 * Categories associated with each named taxonomic entity"; §6 asks for the
 * citation incl. version, which the chip carries in its title and link.
 */
const DATA_URL = "data/seed/iucn.json";

/** Official Red List category colours (iucnredlist.org legend). */
export const IUCN_COLORS = Object.freeze({
  LC: "#60c659",
  NT: "#cce226",
  VU: "#f9e814",
  EN: "#fc7f3f",
  CR: "#d81e05",
  EW: "#000000",
  EX: "#000000",
  DD: "#d1d1c6",
});
const LIGHT_CHIPS = new Set(["LC", "NT", "VU", "DD", "NE"]);
const LABELS = Object.freeze({
  LC: "Least Concern",
  NT: "Near Threatened",
  VU: "Vulnerable",
  EN: "Endangered",
  CR: "Critically Endangered",
  EW: "Extinct in the Wild",
  EX: "Extinct",
  DD: "Data Deficient",
  NE: "Not Evaluated",
});

let _map = {};

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** Chip colour + text colour for a category code; unknown codes get the DD grey. */
export function iucnStyle(code) {
  const c = String(code || "").toUpperCase();
  const bg = IUCN_COLORS[c] || IUCN_COLORS.DD;
  const fg = LIGHT_CHIPS.has(c) || !IUCN_COLORS[c] ? "#111" : "#fff";
  return { bg, fg };
}

/**
 * Fetch the seed. Missing file (404) or an empty seed → {} and no throw; a
 * malformed body throws so a broken pipeline is visible, not silent.
 */
export async function loadIucn(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${DATA_URL}?t=${Date.now()}`);
  if (res.status === 404) {
    _map = {};
    return _map;
  }
  if (!res.ok) throw new Error(`iucn.json HTTP ${res.status}`);
  const j = await res.json();
  if (!j || typeof j !== "object" || Array.isArray(j))
    throw new Error("Malformed iucn.json");
  _map = j;
  return _map;
}

/** Entry for a taxon key, or null. The reserved `_meta` key has no `category`, so the category check excludes it. */
export function iucnEntry(taxonKey) {
  const e = taxonKey ? _map[taxonKey] : null;
  return e && e.category ? e : null;
}

/** HTML chip for the sightings info box; "" when the taxon has no category. */
export function iucnBadge(taxonKey) {
  const e = iucnEntry(taxonKey);
  if (!e) return "";
  const code = String(e.category).toUpperCase();
  const { bg, fg } = iucnStyle(code);
  const label = e.category_label || LABELS[code] || code;
  const year = e.year ? ` ${e.year}` : "";
  const title = esc(e.citation || `${label} — IUCN Red List${year}`);
  const chip = `<span class="iucn-chip" style="display:inline-block;padding:0 6px;border-radius:3px;font-weight:700;font-size:11px;line-height:16px;background:${bg};color:${fg}" title="${title}">${esc(code)}</span>`;
  const text = ` IUCN ${esc(label)}${esc(year)}`;
  return e.url
    ? `<a href="${esc(e.url)}" target="_blank" rel="noopener" style="text-decoration:none">${chip}</a>${text}`
    : `${chip}${text}`;
}

/** Test hook. */
export function _resetIucn(map = {}) {
  _map = map;
}
