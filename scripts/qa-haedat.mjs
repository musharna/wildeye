#!/usr/bin/env node
/**
 * qa-haedat.mjs — real-browser acceptance for the HAEDAT harmful algal events layer
 * (spec docs/superpowers/specs/2026-10-03-haedat-design.md).
 * Run: node scripts/qa-haedat.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any fails.
 * The independent source is the raw archive itself, downloaded here from the OBIS HAB IPT and parsed in this script
 * (event.txt and extendedmeasurementorfact.txt, with `unzip`), not haedat.json: the drawn positions, their event
 * counts, colours and ring/dot form, the counts in a scrubbed year, the legend totals and the click readouts must all
 * equal what the archive says.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { bootSettled } from "./bootSettled.mjs";

const argv = process.argv.slice(2);
const arg = (n, f) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : f);
const SITE = arg("--url", "https://musharna.github.io/wildeye/");
const ID = "haedat";
const ARCHIVE = "https://ipt.iobis.org/hab/archive.do?r=haedat&v=3.35";
const SHA256 = "d44c61e7e7042c816c92988f699f274644bdd29451373542c5c1d11d34866414"; // version 3.35, as pinned in pipeline/haedat.py
// the archive's "HAB associated illness" values, in legend order (spec decision 2)
const ILL = { PSP: "PSP", DSP: "DSP", ASP: "ASP", NSP: "NSP", AZP: "AZP", "CFP (Ciguatera Fish Poisoning)": "CFP",
  "Cyanobacterial toxins effects": "Cyano", "Aerosolized toxins effects": "Aerosol", OTHER: "Other" };
const ORDER = ["PSP", "DSP", "ASP", "NSP", "AZP", "CFP", "Cyano", "Aerosol", "Other", "None"];
const results = [];
const report = (check, ok, detail) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

// ── the archive, parsed here ────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "qa-haedat-"));
const res = await fetch(ARCHIVE);
if (!res.ok) throw new Error(`${ARCHIVE}: HTTP ${res.status}`);
const zip = Buffer.from(await res.arrayBuffer());
const sha = createHash("sha256").update(zip).digest("hex");
if (sha !== SHA256) throw new Error(`${ARCHIVE}: ${zip.length} bytes, ${res.headers.get("content-type")}, sha256 ${sha} is not the pinned ${SHA256}; starts ${JSON.stringify(zip.subarray(0, 60).toString("latin1"))}`);
writeFileSync(join(dir, "a.zip"), zip);
const member = (name) => execFileSync("unzip", ["-p", join(dir, "a.zip"), name], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] }).toString("utf8");
const raw = Object.fromEntries(["eml.xml", "event.txt", "extendedmeasurementorfact.txt"].map((n) => [n, member(n)]));
rmSync(dir, { recursive: true, force: true });
const tsv = (name) => {
  const [head, ...rows] = raw[name].split("\n").filter((l) => l.length);
  const cols = head.split("\t");
  return rows.map((r) => Object.fromEntries(r.split("\t").map((v, i) => [cols[i], v])));
};
const eml = raw["eml.xml"];
const thisYear = new Date().getUTCFullYear();
const yearOf = (d) => {
  const m = /^(\d{4})(?:$|[-/])/.exec(d.trim());
  return m && +m[1] >= 1700 && +m[1] <= thisYear ? +m[1] : null;
};
const illness = new Map();
for (const f of tsv("extendedmeasurementorfact.txt")) {
  if (f.measurementType !== "HAB associated illness") continue;
  if (!(f.measurementValue in ILL)) throw new Error(`unknown illness in the archive: ${f.measurementValue}`);
  if (!illness.has(f.id)) illness.set(f.id, new Set());
  illness.get(f.id).add(ILL[f.measurementValue]);
}
const events = tsv("event.txt").map((e) => ({
  id: e.id, lat: parseFloat(e.decimalLatitude), lon: parseFloat(e.decimalLongitude), m: parseFloat(e.coordinateUncertaintyInMeters),
  year: yearOf(e.eventDate), ill: illness.has(e.id) ? [...illness.get(e.id)] : ["None"],
}));
const onGlobe = events.filter((e) => Math.abs(e.lat) <= 90 && Math.abs(e.lon) <= 180);
const positions = new Map();
for (const e of onGlobe) {
  const k = `${e.lat},${e.lon}`;
  if (!positions.has(k)) positions.set(k, { lat: e.lat, lon: e.lon, km: 0, events: [] });
  const p = positions.get(k);
  p.km = Math.max(p.km, e.m / 1000);
  p.events.push(e);
}
const scope = (p, year) => p.events.filter((e) => year === null || e.year === year);
const tally = (es) => {
  const t = {};
  for (const e of es) for (const i of e.ill) t[i] = (t[i] || 0) + 1;
  return t;
};
const dominantOf = (t) => ORDER.reduce((best, k) => ((t[k] || 0) > (best ? t[best] : 0) ? k : best), null);
const expectedAt = (year) => new Map([...positions].map(([k, p]) => {
  const es = scope(p, year);
  return [k, { n: es.length, dominant: dominantOf(tally(es)), regional: p.km > 100 }];
}).filter(([, v]) => v.n > 0));
const haversine = (a, b, c, d) => {
  const r = Math.PI / 180;
  const h = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const fmt = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
/** what a click at (lat, lon) must say, from the archive: events at positions whose range (≥ 25 km) covers it */
const expectedReadout = (lat, lon, year) => {
  const hits = [...positions.values()].map((p) => ({ p, km: haversine(lat, lon, p.lat, p.lon), es: scope(p, year) }))
    .filter(({ p, km, es }) => es.length && km <= Math.max(p.km, 25)).sort((a, b) => a.km - b.km);
  if (!hits.length) return { status: "class", text: "no event recorded at a HAEDAT position whose range covers this spot" };
  const n = hits.reduce((s, h) => s + h.es.length, 0);
  const t = tally(hits.flatMap((h) => h.es));
  const ill = ORDER.filter((k) => t[k]).sort((a, b) => t[b] - t[a]).map((k) => `${k} ${t[k]}`).join(", ");
  const near = hits[0];
  return { status: "value", text: `${fmt(n, "event", "events")} at ${fmt(hits.length, "HAEDAT position", "HAEDAT positions")} whose range covers this spot (${ill}); nearest ${Math.round(near.km)} km away, ${near.p.km > 100 ? "a regional record" : "a monitoring point"}` };
};
report("archive:cc-by-and-shape", /creativecommons\.org\/licenses\/by\/4\.0/.test(eml) && events.length === 14341 && onGlobe.length === 14332,
  { events: events.length, onGlobe: onGlobe.length, positions: positions.size });

// ── the site ────────────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const pageErrors = [];
const notFound = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 160)));
page.on("response", (r) => { if (r.status() === 404 && /haedat/.test(r.url())) notFound.push(r.url()); });
try {
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await bootSettled(page);
  const loaded = await page.evaluate(async (id) => {
    const dm = window.__godsEyeView.dataManager;
    if (!dm.getAll().some((l) => l.id === id)) return { error: "not registered" };
    await dm.setEnabled(id, true, { origin: "user" });
    const mod = dm.layers.get(id).module;
    const deadline = Date.now() + 60000;
    let s;
    while (Date.now() < deadline) {
      s = mod.getStats();
      if (s?.lastUpdate || s?.error) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { stats: s };
  }, ID);
  report("registered-and-loaded", !!loaded.stats?.lastUpdate && !loaded.stats?.error, loaded);
  const drawn = () => page.evaluate((id) => {
    const ds = window.__godsEyeView.viewer.dataSources.getByName(id)[0];
    return (ds?.entities.values ?? []).map((e) => {
      const g = (k) => e.properties[k].getValue();
      return [e.id.slice(id.length + 1), { n: g("n"), dominant: g("dominant"), regional: g("regional"), show: ds.show }];
    });
  }, ID);
  const compare = (name, got, want) => {
    const bad = [];
    for (const [k, w] of want) {
      const g = got.get(k);
      if (!g || g.n !== w.n || g.dominant !== w.dominant || g.regional !== w.regional || !g.show) bad.push({ k, want: w, got: g ?? null });
    }
    const extra = [...got.keys()].filter((k) => !want.has(k));
    report(name, bad.length === 0 && extra.length === 0 && got.size === want.size,
      { drawn: got.size, archive: want.size, bad: bad.length, extra: extra.length, examples: [...bad.slice(0, 3), ...extra.slice(0, 3)] });
  };
  const live = expectedAt(null);
  compare("live:positions-counts-colours-rings-equal-archive", new Map(await drawn()), live);
  const regional = [...live.values()].filter((v) => v.regional).length;
  report("both-forms-drawn", regional > 0 && regional < live.size, { rings: regional, dots: live.size - regional });

  // legend totals = the archive's illness links over every on-globe event
  const legend = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getRowControls().legend, ID);
  const all = tally(onGlobe);
  const legendCounts = legend.filter((l) => l.count !== null).map((l) => l.count);
  const undatedN = onGlobe.filter((e) => e.year === null).length;
  const offN = events.length - onGlobe.length;
  report("legend:caption-live", legend.at(-1)?.label.includes(`all years · ${offN} events placed off the globe not drawn · archive 3.35`), { caption: legend.at(-1)?.label, undated: undatedN, off: offN });
  report("legend:illness-totals-equal-archive", JSON.stringify(legendCounts) === JSON.stringify(ORDER.map((k) => all[k] || 0)),
    { legend: legendCounts, archive: ORDER.map((k) => all[k] || 0), caption: legend.at(-1)?.label });

  // clicks through the WHAT LIVES HERE path (main.js readGibsLayers): a monitoring point, inside a ring, open ocean
  const read = async (lat, lon) => (await page.evaluate((a, b) => window.__godsEyeView.readoutAt(a, b), lat, lon)).find((r) => r?.id === ID) ?? null;
  const ring = [...positions.values()].find((p) => p.km > 300 && scope(p, null).length);
  const spots = [
    { what: "Gulf of Maine monitoring point", lat: 44.14, lon: -67.53 },
    { what: `inside the ring at ${ring.lat},${ring.lon} (${ring.km} km)`, lat: ring.lat + (0.5 * ring.km) / 111.195, lon: ring.lon },
    { what: "open Pacific", lat: -30, lon: -130 },
  ];
  const checkSpot = async (s, year, label) => {
    const want = expectedReadout(s.lat, s.lon, year);
    const got = await read(s.lat, s.lon);
    const date = year === null ? "all years" : String(year);
    const ok = got?.status === want.status && got?.date === date && got?.text === want.text;
    report(`readout ${s.what} ${label}`, ok, { want, got });
  };
  for (const s of spots) await checkSpot(s, null, "live");

  // a scrubbed year: 1988 (the Gulf of Maine's busiest year in the archive) then live again
  await page.evaluate(() => window.__godsEyeView.observedTime.set("1988-07-01T00:00:00Z"));
  await page.waitForFunction((id) => window.__godsEyeView.dataManager.layers.get(id).module.getStats().observed === 1988, { timeout: 30000 }, ID);
  compare("1988:positions-counts-colours-equal-archive", new Map(await drawn()), expectedAt(1988));
  await checkSpot(spots[0], 1988, "in 1988");
  const caption1988 = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getRowControls().legend.at(-1).label, ID);
  report("legend:caption-1988", caption1988.includes(`1988 · ${undatedN} undated events in no year · ${offN} events placed off the globe not drawn`), { caption: caption1988 });
  await page.evaluate(() => window.__godsEyeView.observedTime.set(null));
  await page.waitForFunction((id) => window.__godsEyeView.dataManager.layers.get(id).module.getStats().observed === null, { timeout: 30000 }, ID);

  // a click on a dot opens the details card (Cesium's info box is off) with the counts and the DOI
  const card = await page.evaluate(async (id) => {
    const { viewer } = window.__godsEyeView;
    const entity = viewer.dataSources.getByName(id)[0].entities.getById(`${id}:44.14,-67.53`);
    if (!entity) return { error: "no Gulf of Maine entity" };
    viewer.selectedEntity = entity;
    const el = document.querySelector(".bio-card");
    for (let i = 0; i < 20 && el?.hidden !== false; i += 1) await new Promise((r) => setTimeout(r, 100));
    const body = el?.querySelector(".bio-card-body");
    const out = { open: el?.hidden === false, doi: !!body?.querySelector('a[href="https://doi.org/10.25607/k68d5v"]'), text: (body?.textContent || "").slice(0, 160) };
    viewer.selectedEntity = undefined;
    return out;
  }, ID);
  const maine = scope(positions.get("44.14,-67.53"), null).length;
  report("card-opens-with-counts-and-doi", card.open && card.doi && card.text.startsWith(`${fmt(maine, "harmful algal event", "harmful algal events")} · all years`), { card, maine });
  report("no-404s", notFound.length === 0, { notFound });
  report("no-page-errors", pageErrors.length === 0, { errors: pageErrors.slice(0, 5) });
} catch (e) {
  report("run", false, { error: String(e?.message || e).slice(0, 300) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
