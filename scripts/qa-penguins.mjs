#!/usr/bin/env node
/**
 * qa-penguins.mjs — real-browser acceptance for the Antarctic penguin colonies layer
 * (spec docs/superpowers/specs/2026-10-07-penguins-design.md).
 * Run: node scripts/qa-penguins.mjs [--url http://127.0.0.1:4173/] [--data <dir with penguin_obs.rda and sites.rda>]
 * One JSON line per check; exits 1 when any fails.
 * The known answers come from scripts/qa_penguins_truth.R, which reads the raw release with R and never touches the
 * pipeline or penguins.json. Each chosen colony is clicked for real (a mouse click on the canvas at the dot, or on its
 * ring where several species share a site) and the details card's text is compared with words built here from R's answer.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { bootSettled } from "./bootSettled.mjs";

const argv = process.argv.slice(2);
const arg = (n, f) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : f);
const SITE = arg("--url", "https://musharna.github.io/wildeye/");
const DATA = arg("--data", join(process.env.WILDEYE_CACHE || join(homedir(), ".cache", "wildeye"), "penguins", "v3.1", "data"));
const ID = "penguins";
// the layer's dot geometry (spec decision 5): 10 px dots; at a shared site on a circle round it, the first at the top
// and the rest clockwise, neighbours 12 px apart centre to centre; x1.4 when the camera is under 200 km away
const DOT_PX = 10;
const GAP_PX = 2;
const NEAR_SCALE = 1.4;
const slotOffset = (k, n) => {
  if (n === 1) return [0, 0];
  const r = (DOT_PX + GAP_PX) / (2 * Math.sin(Math.PI / n));
  const a = (2 * Math.PI * k) / n;
  return [r * Math.sin(a) * NEAR_SCALE, -r * Math.cos(a) * NEAR_SCALE];
};
const ORDER = ["ADPE", "CHPE", "EMPE", "GEPE", "KIPE", "MCPE"];
const LABEL = { ADPE: "Adélie penguin", CHPE: "chinstrap penguin", EMPE: "emperor penguin", GEPE: "gentoo penguin", KIPE: "king penguin", MCPE: "macaroni penguin" };
const VANTAGE = { aerial: "aerial count", "aerial photo": "aerial photo", ground: "ground count", "ground photo": "ground photo", landsat: "Landsat image",
  "offshore vessel": "count from a ship", sentinel: "Sentinel image", uav: "drone photo", vhr: "very-high-resolution satellite image" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const results = [];
const report = (check, ok, detail) => {
  const row = { check, ...detail, ok };
  results.push(row);
  console.log(JSON.stringify(row));
};

// ── R's answers, and the card words they must produce ───────────────────────
const truth = JSON.parse(execFileSync("Rscript", [join(import.meta.dirname, "qa_penguins_truth.R"), DATA], { maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "inherit"] }).toString("utf8"));
const season = (y) => `${y}/${String((y + 1) % 100).padStart(2, "0")}`;
const n = (x) => x.toLocaleString("en-US");
const typeWord = (c) => (c.count === 1 ? c.type.replace(/s$/, "") : c.type);
const countWords = (c) => `${n(c.count)} ${typeWord(c)}${c.count === 0 ? " (none found)" : ""}`;
const day = (iso) => { const [y, m, d] = iso.split("-"); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
const countItem = (c) => `${countWords(c)} (${[VANTAGE[c.vantage], c.date ? day(c.date) : null, c.accuracy ? `accuracy ${c.accuracy} of 5` : "accuracy not stated"].filter(Boolean).join(", ")})`;
const coord = (c) => `${Math.abs(c.lat).toFixed(3)}°S ${Math.abs(c.lon).toFixed(3)}°${c.lon < 0 ? "W" : "E"}`;
const plural = (k, one, many) => `${n(k)} ${k === 1 ? one : many}`;
/** the card's first lines, from R: head, place, latest, surveys; `items` = the latest count items (order checked apart) */
function expectedCard(c) {
  const label = LABEL[c.species];
  const lines = [`${label[0].toUpperCase()}${label.slice(1)} · ${c.name}`, `${c.region} · ${coord(c)}`];
  let items = [];
  if (c.latest) {
    const k = c.latest.counts.length;
    lines.push(`${k === 1 ? "Latest count" : `Latest counts (${k}, not added)`}, ${season(c.latest.season)} season: `);
    items = c.latest.counts.map(countItem);
  } else {
    lines.push(`No count in this release: recorded present, not counted, latest in ${season(c.presentOnly)}`);
  }
  if (c.latest && c.presentOnly) lines.push(`Recorded present, not counted, in ${season(c.presentOnly)}`);
  lines.push(`${plural(c.surveys, "survey", "surveys")} (${plural(c.records, "record", "records")}), ${c.first === c.last ? season(c.first) : `${season(c.first)} to ${season(c.last)}`}`);
  return { lines, items };
}
/** newest date first, undated last: the order the card must keep between items of different dates */
const datedOrderOk = (counts, shown) => {
  const pos = counts.map((c) => shown.indexOf(countItem(c)));
  return counts.every((a, i) => counts.every((b, j) => {
    const ka = a.date ?? "", kb = b.date ?? "";
    return ka === kb || (ka > kb) === (pos[i] < pos[j]);
  }));
};
report("truth:shape", truth.points === 918 && truth.sites === 726 && truth.colonies.length === 10, { points: truth.points, sites: truth.sites, colonies: truth.colonies.length });
const types = (c) => new Set((c.latest?.counts ?? []).map((x) => x.type));
report("truth:covers-the-cases", truth.colonies.some((c) => c.speciesHere.length === 4) && truth.colonies.some((c) => types(c).size > 1)
  && truth.colonies.some((c) => !c.latest) && truth.colonies.some((c) => c.latest?.counts.some((x) => x.count === 0))
  && truth.colonies.some((c) => c.latest?.counts[0].type === "chicks" && c.latest.counts.some((x) => x.type === "nests")), {});

// ── the site ────────────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const pageErrors = [];
const notFound = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 160)));
page.on("response", (r) => { if (r.status() >= 400 && /penguin/.test(r.url())) notFound.push(`${r.status()} ${r.url()}`); });
try {
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 180000 });
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
      await new Promise((r) => setTimeout(r, 250));
    }
    const ds = window.__godsEyeView.viewer.dataSources.getByName(id)[0];
    const per = {};
    for (const e of ds?.entities.values ?? []) per[e.properties.species.getValue()] = (per[e.properties.species.getValue()] || 0) + 1;
    return { stats: s, drawn: ds?.entities.values.length ?? 0, per, timeBar: typeof mod.setObservedTime, haedatTimeBar: typeof dm.layers.get("haedat")?.module.setObservedTime };
  }, ID);
  report("registered-and-loaded", !!loaded.stats?.lastUpdate && !loaded.stats?.error, loaded);
  const sorted = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  report("points-per-species-equal-R", loaded.drawn === truth.points && sorted(loaded.per) === sorted(truth.perSpecies),
    { drawn: loaded.drawn, per: loaded.per, R: truth.perSpecies });
  // not on the time bar: the bar reaches a layer only through setObservedTime (haedat, which is on it, is the control)
  report("not-on-the-time-bar", loaded.timeBar === "undefined" && loaded.haedatTimeBar === "function", { timeBar: loaded.timeBar, control: loaded.haedatTimeBar });

  const cardText = () => page.evaluate(() => {
    const el = document.querySelector(".bio-card");
    return el && el.hidden === false ? el.querySelector(".bio-card-body")?.innerText ?? "" : null;
  });
  // Two camera heights for a site with several species: from 60 km the dots are depth tested (beyond the layer's
  // 50 km disableDepthTestDistance), from 30 km they are not (the first build's concentric rings failed at 30 km only).
  const visits = truth.colonies.flatMap((c) => (c.speciesHere.length > 1 ? [[c, 60000], [c, 30000]] : [[c, 60000]]));
  for (const [c, height] of visits) {
    const slot = [...c.speciesHere].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).indexOf(c.species);
    const [dx, dy] = slotOffset(slot, c.speciesHere.length);
    await page.evaluate(async (lat, lon, h) => {
      const v = window.__godsEyeView.viewer;
      v.selectedEntity = undefined;
      v.camera.setView({ destination: v.camera.position.constructor.fromDegrees(lon, lat, h), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      // two frames drawn at the new view (the render governor may be in request mode), so tilesLoaded is about this view
      for (let i = 0; i < 2; i += 1) {
        v.scene.requestRender();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, c.lat, c.lon, height);
    await page.waitForFunction(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded && document.querySelector(".bio-card")?.hidden !== false, { timeout: 90000, polling: 250 });
    const at = await page.evaluate((lat, lon, ox, oy) => {
      const v = window.__godsEyeView.viewer;
      const C = v.camera.position.constructor;
      v.scene.render();
      const win = v.scene.cartesianToCanvasCoordinates(C.fromDegrees(lon, lat, 0));
      const rect = v.scene.canvas.getBoundingClientRect();
      const x = rect.left + win.x + ox, y = rect.top + win.y + oy;
      const hit = document.elementFromPoint(x, y);
      return { x, y, cx: win.x + ox, cy: win.y + oy, onCanvas: hit === v.scene.canvas, hit: hit ? `${hit.tagName}.${hit.className}` : null };
    }, c.lat, c.lon, dx, dy);
    const what = `${c.site} ${c.species} (slot ${slot} of ${c.speciesHere.length}, from ${height / 1000} km)`;
    // the dot's image is in once something can be picked there (a state, not a duration); what is picked is not checked
    // here: the real click below must open this species' card
    try {
      await page.waitForFunction((x, y) => {
        const v = window.__godsEyeView.viewer;
        v.scene.requestRender();
        return Boolean(v.scene.pick({ x, y }));
      }, { timeout: 15000, polling: 250 }, at.cx, at.cy);
    } catch {
      report(`card ${what}`, false, { error: "nothing can be picked where the dot should be", at });
      continue;
    }
    if (!at.onCanvas) { report(`card ${what}`, false, { error: "the click point is covered", at }); continue; }
    await page.mouse.click(at.x, at.y);
    const want = expectedCard(c);
    let got = null;
    try {
      await page.waitForFunction((head) => {
        const el = document.querySelector(".bio-card");
        return el && el.hidden === false && (el.querySelector(".bio-card-body")?.innerText ?? "").startsWith(head);
      }, { timeout: 15000 }, want.lines[0]);
      got = await cardText();
    } catch {
      got = await cardText();
      report(`card ${what}`, false, { error: "no card for this colony after the click", want: want.lines[0], got: got?.slice(0, 200) ?? null, at });
      continue;
    }
    const lines = got.split("\n").map((s) => s.trim()).filter(Boolean);
    const latestLine = lines[2] ?? "";
    let ok = lines[0] === want.lines[0] && lines[1] === want.lines[1];
    let shownItems = [];
    if (c.latest) {
      ok &&= latestLine.startsWith(want.lines[2]);
      shownItems = latestLine.slice(want.lines[2].length).split("; ");
      ok &&= JSON.stringify([...shownItems].sort()) === JSON.stringify([...want.items].sort()) && datedOrderOk(c.latest.counts, shownItems);
    } else {
      ok &&= latestLine === want.lines[2];
    }
    ok &&= JSON.stringify(lines.slice(3, want.lines.length)) === JSON.stringify(want.lines.slice(3));
    ok &&= /CC BY 4\.0/.test(got) && /Antarctic Penguin Biogeography Project/.test(got);
    report(`card ${what}`, ok, { want: want.lines, wantItems: want.items, got: lines.slice(0, want.lines.length), shownItems });
  }

  // WHAT LIVES HERE at the four-species site, from R's answers: every species, its own counts, nothing added
  const stra = truth.colonies.filter((c) => c.site === "STRA").sort((a, b) => ORDER.indexOf(a.species) - ORDER.indexOf(b.species));
  const short = (c) => `${LABEL[c.species].replace(/ penguin$/, "")} ${c.latest ? `${c.latest.counts.map(countWords).join(", ")} (${season(c.latest.season)})` : `present, not counted (${season(c.presentOnly)})`}`;
  const readout = await page.evaluate((lat, lon, id) => window.__godsEyeView.readoutAt(lat, lon).then((rows) => rows.find((r) => r?.id === id) ?? null), stra[0].lat, stra[0].lon, ID);
  const wantPrefix = `${stra[0].name} (under 1 km): ${stra.map(short).join("; ")}`;
  report("readout four-species site", readout?.status === "value" && readout.text.startsWith(wantPrefix), { want: wantPrefix, got: readout?.text ?? null });
  const sea = await page.evaluate((id) => window.__godsEyeView.readoutAt(-50, -30).then((rows) => rows.find((r) => r?.id === id) ?? null), ID);
  report("readout open ocean", sea?.status === "class" && sea.text === "no penguin breeding site recorded within 10 km", { got: sea });
  report("no-404s", notFound.length === 0, { notFound });
  report("no-page-errors", pageErrors.length === 0, { errors: pageErrors.slice(0, 5) });
} catch (e) {
  report("run", false, { error: String(e?.stack || e).slice(0, 400) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, checks: results.length, failed }));
process.exit(failed ? 1 : 0);
