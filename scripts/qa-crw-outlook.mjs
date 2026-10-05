#!/usr/bin/env node
/**
 * qa-crw-outlook.mjs — real-browser acceptance for the NOAA CRW four-month bleaching outlook
 * (spec docs/superpowers/specs/2026-10-03-crw-outlook-design.md).
 * Run: node scripts/qa-crw-outlook.mjs [--url https://musharna.github.io/wildeye/]
 * One JSON line per check; exits 1 when any fails.
 * The independent source is CRW's own published maps of the same issue (image_plain GIFs, one pixel per 0.5° cell,
 * 0..360° longitude), not the NetCDF the pipeline reads: the site's drape and readout image must equal them cell for
 * cell, and clicks on cells picked from them must read their levels.
 */
import puppeteer from "puppeteer";
import { bootSettled } from "./bootSettled.mjs";
import { cellIndex, outlookText } from "../src/data/crwOutlook.js";

const argv = process.argv.slice(2);
const arg = (n, f) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : f);
const SITE = arg("--url", "https://musharna.github.io/wildeye/");
const ID = "crw-outlook";
const CRW = "https://www.star.nesdis.noaa.gov/pub/socd/mecb/crw/data/outlook/v5";
// CRW's map colours (sampled from its GIFs 2026-10-03, equal to the NetCDF classes on every water cell); land is grey
const PALETTE = { "255,255,255": 0, "255,210,160": 1, "250,170,10": 2, "240,0,0": 3, "150,0,0": 4, "150,150,150": 255 };
const results = [];
const report = (check, ok, detail) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};
const text = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
  return r.text();
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 160)));
try {
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
  await bootSettled(page);
  const loaded = await page.evaluate(async (id) => {
    const dm = window.__godsEyeView.dataManager;
    if (!dm.getAll().some((l) => l.id === id)) return { error: "not registered" };
    await dm.setEnabled(id, true);
    const mod = dm.layers.get(id).module;
    const deadline = Date.now() + 60000;
    let s;
    while (Date.now() < deadline) {
      s = mod.getStats();
      if (s?.lastUpdate || s?.error) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { stats: s, entry: mod.getEntry(), legend: mod.getRowControls().legend.map((l) => l.label) };
  }, ID);
  const o = loaded.entry?.outlook;
  report("registered-and-loaded", !!loaded.stats?.lastUpdate && !loaded.stats?.error && !!o, { stats: loaded.stats, outlook: o ?? null });
  if (!o) throw new Error("no outlook in the manifest entry; nothing further can be checked");

  // (1) the issue shown is CRW's newest with both probabilities
  const years = [...(await text(`${CRW}/nc/v1/outlook/`)).matchAll(/href="(\d{4})\/"/g)].map((m) => m[1]).sort();
  const listing = await text(`${CRW}/nc/v1/outlook/${years.at(-1)}/`);
  const issues = (p) => new Set([...listing.matchAll(new RegExp(`cfsv2_outlook-0${p}perc_4mon-and-wkly_v5_icwk(\\d{8})_`, "g"))].map((m) => m[1]));
  const both = [...issues(o.probabilities[0])].filter((k) => issues(o.probabilities[1]).has(k)).sort();
  report("source:newest-issue", both.at(-1) === o.icwk, { newest: both.at(-1) ?? null, shown: o.icwk });

  // (2) CRW's own maps of that issue, decoded in the browser from data URLs (no canvas taint), against the site's images
  const gifDir = `${CRW}/image_plain/${o.icwk.slice(0, 4)}/`;
  const gifs = await text(gifDir);
  const gifUrl = (p) => {
    const f = gifs.match(new RegExp(`cfsv2-outlook-4mon_v5_icwk${o.icwk}_0${p}pct_for_\\d{8}to\\d{8}\\.gif`))?.[0];
    if (!f) throw new Error(`no CRW map for ${o.icwk} at ${p}% in ${gifDir}`);
    return gifDir + f;
  };
  const b64 = async (u) => Buffer.from(await (await fetch(u)).arrayBuffer()).toString("base64");
  const [g60, g90] = await Promise.all(o.probabilities.map(async (p) => b64(gifUrl(p))));
  const cmp = await page.evaluate(async ({ g60, g90, drapeUrl, dataUrl, PALETTE }) => {
    const pixels = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, d: ctx.getImageData(0, 0, img.width, img.height).data };
    };
    const fromSite = async (u) => {
      const blob = await (await fetch(u, { cache: "no-store" })).blob();
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return { w: bmp.width, h: bmp.height, d: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
    };
    const [a, b, drape, data] = [await pixels(`data:image/gif;base64,${g60}`), await pixels(`data:image/gif;base64,${g90}`), await fromSite(drapeUrl), await fromSite(dataUrl)];
    const sizes = [a, b, drape, data].map((x) => `${x.w}x${x.h}`);
    if (sizes.some((s) => s !== "720x360")) return { sizes };
    // CRW's maps run 0..360°: site column x is CRW column (x + 360) % 720
    const crwClass = (img, i) => {
      const y = Math.floor(i / 720), x = (i % 720 + 360) % 720, k = (y * 720 + x) * 4;
      return PALETTE[`${img.d[k]},${img.d[k + 1]},${img.d[k + 2]}`] ?? -1;
    };
    const colours = { 1: [255, 210, 160], 2: [250, 170, 10], 3: [240, 0, 0], 4: [150, 0, 0] };
    let unknown = 0, drapeBad = 0, dataBad = 0;
    const classes = [];
    const examples = [];
    for (let i = 0; i < 720 * 360; i++) {
      const lo = crwClass(a, i), hi = crwClass(b, i);
      if (lo < 0 || hi < 0) { unknown++; continue; }
      classes.push([lo, hi]);
      const k = i * 4;
      const want = colours[lo];
      const drapeOk = want ? drape.d[k + 3] === 255 && drape.d[k] === want[0] && drape.d[k + 1] === want[1] && drape.d[k + 2] === want[2] : drape.d[k + 3] === 0;
      if (!drapeOk) { drapeBad++; if (examples.length < 3) examples.push({ i, lo, drape: [...drape.d.slice(k, k + 4)] }); }
      if (data.d[k] !== lo || data.d[k + 1] !== hi || data.d[k + 3] !== 255) dataBad++;
    }
    return { sizes, unknown, drapeBad, dataBad, examples, cells: classes.length, grid: classes };
  }, { g60, g90, drapeUrl: new URL(loaded.entry.png, SITE).href, dataUrl: new URL(o.data_png, SITE).href, PALETTE });
  const { grid, ...summary } = cmp;
  report("crw-map:colours-known", cmp.unknown === 0 && cmp.cells === 720 * 360, summary);
  report("drape-equals-crw-60pct-map", cmp.drapeBad === 0 && cmp.cells === 720 * 360, { drapeBad: cmp.drapeBad, examples: cmp.examples });
  report("readout-image-equals-crw-maps", cmp.dataBad === 0 && cmp.cells === 720 * 360, { dataBad: cmp.dataBad });

  // (3) clicks on cells picked from CRW's maps: two levels that differ, one level at both, no stress, land
  const centre = (i) => ({ lat: 90 - 0.5 * (Math.floor(i / 720) + 0.5), lon: -180 + 0.5 * ((i % 720) + 0.5) });
  const pick = (what, test) => {
    const i = (grid ?? []).findIndex(([lo, hi]) => test(lo, hi));
    return i < 0 ? { what, missing: true } : { what, i, ...centre(i), lo: grid[i][0], hi: grid[i][1] };
  };
  const KNOWN = [
    pick("60% and 90% differ", (lo, hi) => lo >= 2 && hi >= 1 && hi < lo),
    pick("90% below Watch", (lo, hi) => lo >= 1 && lo < 255 && hi === 0),
    pick("the same level at both", (lo, hi) => lo >= 1 && lo === hi && lo < 255),
    pick("no stress", (lo) => lo === 0),
    pick("land", (lo) => lo === 255),
  ];
  const date = `outlook ${o.start} to ${o.end}`;
  for (const k of KNOWN) {
    if (k.missing) { report(`readout ${k.what}`, false, { missing: "no such cell in this issue" }); continue; }
    if (cellIndex(k.lat, k.lon) !== k.i) { report(`readout ${k.what}`, false, { cellIndex: cellIndex(k.lat, k.lon), want: k.i }); continue; }
    const got = await page.evaluate((id, lat, lon) => window.__godsEyeView.dataManager.layers.get(id).module.readoutAt(lat, lon), ID, k.lat, k.lon);
    const want = k.lo === 255 ? { status: "nodata", text: null } : { status: "value", text: outlookText(k.lo, k.hi, o.probabilities) };
    report(`readout ${k.what}`, got?.status === want.status && got?.text === want.text && got?.date === date, { cell: k, want, got });
  }
  // the same cell through the WHAT LIVES HERE path (main.js readGibsLayers), which is what a click on the globe reads
  const first = KNOWN[0];
  if (!first.missing) {
    const rows = await page.evaluate((lat, lon) => window.__godsEyeView.readoutAt(lat, lon), first.lat, first.lon);
    const row = rows.find((r) => r?.id === ID);
    report("what-lives-here-reads-the-outlook", row?.text === outlookText(first.lo, first.hi, o.probabilities), { row: row ?? null, ids: rows.map((r) => r?.id) });
  }
  report("legend", loaded.legend.join("|").startsWith("Watch|Warning|Alert Level 1|Alert Level 2|Four-month outlook " + o.start), { legend: loaded.legend });
  const stack = await page.evaluate((id) => window.__godsEyeView.dataManager.layers.get(id).module.getStats(), ID);
  report("drape-shows-the-issue", stack.time === `${o.issued}T00:00:00Z` && !stack.error, { stats: stack });
  report("no-page-errors", pageErrors.length === 0, { errors: pageErrors.slice(0, 5) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
