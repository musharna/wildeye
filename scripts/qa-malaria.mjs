#!/usr/bin/env node
/**
 * qa-malaria.mjs — real-browser acceptance for the Malaria Atlas Project layer (spec 2026-10-03-map-malaria-design.md).
 * Run: node scripts/qa-malaria.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any fails.
 * Two halves: (1) MAP's live server still serves what src/data/malaria.js pins (the release's years, its style and the
 * style's colours); (2) the site draws that layer at the bar's year and reads values that match the cells read
 * independently, through WCS GetCoverage GeoTIFFs decoded with rasterio (2026-10-03), not through GetFeatureInfo.
 */
import puppeteer from "puppeteer";
import { bootSettled } from "./bootSettled.mjs";
import { MAP_WMS, MAP_LAYER, MAP_STYLE, YEARS, RAMP, SPARSE_COLOR, timeOf } from "../src/data/malaria.js";

const argv = process.argv.slice(2);
const arg = (n, f) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : f);
const SITE = arg("--url", "https://musharna.github.io/wildeye/");
const ID = "malaria";
// 1/24° cell centres; the rate, LCI and UCI are the WCS values, printed as malaria.js prints them
const KNOWN = [
  { what: "N Ghana 2025 (live)", lat: 10.0208333, lon: -0.0208333, status: "value", date: "2025",
    text: "26.1% of children aged 2–10 carry P. falciparum (95% interval 3.2% to 68.7%)" },
  { what: "N Ghana 2015", lat: 10.0208333, lon: -0.0208333, observed: "2015-07-01T00:00:00Z", status: "value", date: "2015",
    text: "60.2% of children aged 2–10 carry P. falciparum (95% interval 40.1% to 76.8%)" },
  { what: "Malawi 2010", lat: -13.4791667, lon: 33.4791667, observed: "2010-07-01T00:00:00Z", status: "value", date: "2010",
    text: "61.0% of children aged 2–10 carry P. falciparum (95% interval 49.7% to 73.1%)" },
  { what: "Paris: no estimate", lat: 48.8125, lon: 2.3125, status: "nodata", date: "2025" },
  { what: "Amazon: masked, sparsely populated", lat: -4.9791667, lon: -65.0208333, status: "value", date: "2025",
    text: "Sparsely populated: MAP masks the estimate here" },
  { what: "Manaus: 3e-8 is not 0.0%", lat: -2.9791667, lon: -60.0208333, status: "value", date: "2025",
    text: "< 0.1% of children aged 2–10 carry P. falciparum (95% interval < 0.1% to < 0.1%)" },
];
const results = [];
const report = (check, ok, detail) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

// (1) the live source still matches what the module pins
const caps = await (await fetch(`${MAP_WMS}?service=WMS&version=1.3.0&request=GetCapabilities`)).text();
const block = caps.split("<Layer").find((b) => b.includes(`<Name>${MAP_LAYER}</Name>`)) ?? "";
const times = (block.match(/<Dimension[^>]*name="time"[^>]*>([^<]*)</)?.[1] ?? "").split(",").filter(Boolean);
const want = YEARS.map(timeOf);
report("source:years", times.length === want.length && times.every((t, k) => t === want[k]), { served: [times[0], times.at(-1), times.length], pinned: [want[0], want.at(-1), want.length] });
report("source:style", block.includes(`<Name>${MAP_STYLE}</Name>`), { style: MAP_STYLE });
const sld = await (await fetch(`${MAP_WMS}?service=WMS&version=1.1.1&request=GetStyles&layers=${MAP_LAYER}`)).text();
const userStyle = sld.split("<sld:UserStyle>").find((s) => s.includes(`<sld:Name>${MAP_STYLE.split(":")[1]}</sld:Name>`)) ?? "";
// the style has a drawn FeatureTypeStyle (inclusion mapOnly) and a legend-graphic one (legendOnly): check what is drawn
const style = userStyle.split("<sld:FeatureTypeStyle>").filter((f) => f.includes('<sld:VendorOption name="inclusion">mapOnly</sld:VendorOption>')).join("");
const entries = [...style.matchAll(/<sld:ColorMapEntry color="(#[0-9A-Fa-f]{6})"(?: opacity="([\d.]+)")? quantity="([-\d.e]+)"/g)].map(
  ([, color, opacity, q]) => ({ color: color.toLowerCase(), opacity: opacity ?? "1", q: Number(q) }),
);
const drawn = entries.filter((e) => e.opacity !== "0.0" && e.q >= 0).map((e) => [e.q, e.color]);
const ramp = RAMP.map(([v, c]) => [v, c.toLowerCase()]);
// MAP's first data stop is quantity 1e-13 (just above zero); the legend calls it 0%
report("source:ramp", drawn.length === ramp.length && drawn.every(([q, c], k) => c === ramp[k][1] && Math.abs(q - ramp[k][0]) < 1e-9), { served: drawn, pinned: ramp });
report("source:sparse-grey", entries.some((e) => e.q === -1 && e.color === SPARSE_COLOR.toLowerCase() && e.opacity === "1.0"), { sparse: entries.find((e) => e.q === -1) ?? null });

// (2) the site
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const maps = [];
page.on("response", (r) => {
  const u = r.url();
  if (u.startsWith(MAP_WMS) && /request=GetMap/i.test(u)) maps.push({ url: u, status: r.status(), type: r.headers()["content-type"] });
});
// a failed MAP request with the browser's own reason (a readout's "Failed to fetch" says nothing about why)
const failedMap = [];
page.on("requestfailed", (r) => {
  if (r.url().startsWith(MAP_WMS)) failedMap.push({ url: r.url().slice(0, 200), reason: r.failure()?.errorText ?? null, type: r.resourceType() });
});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 160)));
try {
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.observedTime, { timeout: 180000 });
  await bootSettled(page);
  const stats = await page.evaluate(async (id) => {
    const dm = window.__godsEyeView.dataManager;
    if (!dm.getAll().some((l) => l.id === id)) return { error: "not registered" };
    await dm.setEnabled(id, true);
    const deadline = Date.now() + 60000;
    let s;
    while (Date.now() < deadline) {
      s = dm.getAll().find((l) => l.id === id).stats;
      if (s?.lastUpdate || s?.error) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ...s, legendRows: dm.layers.get(id)?.module?.getRowControls?.().legend?.length ?? null };
  }, ID);
  report("registered-and-loaded", !!stats.lastUpdate && !stats.error, stats);
  // wait for the drape's first tiles rather than a fixed time
  const tilesBy = Date.now() + 60000;
  while (Date.now() < tilesBy && !maps.some((m) => m.url.includes(encodeURIComponent(timeOf(2025))) || m.url.includes(timeOf(2025)))) await new Promise((r) => setTimeout(r, 500));
  const at = (year) => maps.filter((m) => decodeURIComponent(m.url).includes(`time=${timeOf(year)}`));
  const live = at(2025);
  report("tiles:live-year", live.length > 0 && live.every((m) => m.status === 200 && /image\/png/.test(m.type)), { n: live.length, bad: live.filter((m) => m.status !== 200 || !/image\/png/.test(m.type)).slice(0, 3) });
  report("tiles:layer-and-style", live.length > 0 && live.every((m) => { const q = new URL(m.url).searchParams; return q.get("layers") === MAP_LAYER && q.get("styles") === MAP_STYLE; }), { sample: live[0]?.url.slice(0, 300) ?? null });
  for (const k of KNOWN) {
    const r = await page.evaluate(async (id, k) => {
      const g = window.__godsEyeView;
      const mod = g.dataManager.layers.get(id).module;
      if (k.observed) {
        g.observedTime.set(k.observed);
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && mod.getStats().time !== k.date) await new Promise((res) => setTimeout(res, 200));
      }
      try {
        return { got: await mod.readoutAt(k.lat, k.lon), bar: g.observedTime.get() };
      } finally {
        if (k.observed) g.observedTime.set(null);
      }
    }, ID, k);
    const ok = r.got?.status === k.status && r.got?.date === k.date && (k.text === undefined || r.got?.text === k.text);
    report(`readout ${k.what}`, ok, { want: k, got: r.got, bar: r.bar, ...(ok ? {} : { failedMap: failedMap.slice(-5) }) });
  }
  // a scrub must redraw the drape at the bar's year, not only read it: hold 2012 (no readout above uses it) until
  // MAP's 2012 tiles arrive, counting only requests made after the scrub
  const from = maps.length;
  await page.evaluate(() => window.__godsEyeView.observedTime.set("2012-07-01T00:00:00Z"));
  const scrubBy = Date.now() + 60000;
  const after2012 = () => maps.slice(from).filter((m) => decodeURIComponent(m.url).includes(`time=${timeOf(2012)}`));
  while (Date.now() < scrubBy && after2012().length === 0) await new Promise((r) => setTimeout(r, 500));
  const y2012 = after2012();
  const shownYear = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getStats().time, ID);
  await page.evaluate(() => window.__godsEyeView.observedTime.set(null));
  report("tiles:scrubbed-year", shownYear === "2012" && y2012.length > 0 && y2012.every((m) => m.status === 200), { shownYear, n: y2012.length });
  report("legend", (stats.legendRows ?? 0) >= 8, { legendRows: stats.legendRows });
  report("no-page-errors", pageErrors.length === 0, { errors: pageErrors.slice(0, 5) });
  report("no-failed-map-requests", failedMap.length === 0, { n: failedMap.length, sample: failedMap.slice(0, 5) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
