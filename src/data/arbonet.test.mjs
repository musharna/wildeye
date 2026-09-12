// src/data/arbonet.test.mjs — polygon contract: case classes, disease chips, info box, layer contract + observed time.
// Mutants verified 2026-09-12 (each made the named assertion fail):
//  M1 caseClass `n <= 4` → `n <= 5` (few/many boundary)         → thresholds test fails at n=5.
//  M2 sumBins ignores `visible` (drop the `=== false` guard)    → chip test: n stays 17 after hiding wnv.
//  M3 binsAt import swapped for a live-only stub                → observed-time class counts fail.
//  M4 stateEntities emits only polys[0]                         → entity count 3 → 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  caseClass,
  sumBins,
  describeState,
  createArbonetLayer,
  NO_DATA,
} from "./arbonet.js";
import { binsAt } from "./hpai.js";

// bins shaped from the live file (Texas, 2026-09-12 run): {w, n:{disease: cases added}}
const weeks = [
  { w: "2026-08-29", n: { wnv: 3 } },
  { w: "2026-08-22", n: { wnv: 14 } },
  { w: "2026-08-15", n: { wnv: 8, den: 2 } },
  { w: "2026-05-16", n: { wnv: 1 } },
];
const diseases = {
  wnv: { name: "West Nile", vector: "mosquito" },
  den: { name: "Dengue", vector: "mosquito" },
  pow: { name: "Powassan", vector: "tick" },
};
const tx = {
  fips: "48",
  name: "Texas",
  st: "TX",
  n: 28,
  by: { wnv: 26, den: 2 },
  ytd: { wnv: 48, den: 8, pow: 0 },
  prev_ytd: { wnv: 98, den: 55 },
  asof: "2026-09-05",
  weeks,
};

test("caseClass thresholds and per-disease sums with chip filter (positive control: unfiltered sum)", () => {
  assert.deepEqual(
    [0, 1, 2, 4, 5, 14, 15, 99, NaN].map((n) => caseClass(n).key),
    ["none", "one", "few", "few", "many", "many", "surge", "surge", "none"],
  );
  assert.deepEqual(sumBins(weeks.slice(0, 2)), { n: 17, by: { wnv: 17 } });
  assert.deepEqual(sumBins(weeks.slice(0, 3), { wnv: false }), { n: 2, by: { den: 2 } });
});

test("describeState lists diseases in scope, year-to-date with last year, and the provisional caveat", () => {
  const live = binsAt(weeks, null, "2026-09-12");
  const html = describeState(tx, live, sumBins(live.bins), diseases, {
    name: "NNDSS",
    url: "https://u",
    licence: "PD",
  });
  assert.match(
    html,
    /Texas.*last 8 weeks to 2026-09-12: 27 cases.*West Nile: 25 · Dengue: 2.*Year to date as of 2026-09-05: West Nile 48 \(98 by this week last year\) · Dengue 8 \(55 by this week last year\).*back-filled.*https:\/\/u.*PD/s,
  );
  assert.doesNotMatch(html, /Powassan/, "zero YTD diseases are not listed");
  const may = binsAt(weeks, "2026-05-12T12:00:00Z", "2026-09-12");
  assert.match(describeState(tx, may, sumBins(may.bins), diseases), /week ending 2026-05-16: 1 case<br>West Nile: 1/);
  const none = binsAt(weeks, "2026-06-20T00:00:00Z", "2026-09-12");
  assert.match(describeState(tx, none, sumBins(none.bins), diseases), /no detections in the week of 2026-06-20: 0 cases/);
});

test("layer: contract, MultiPolygon parts, observed-time recolour, disease chips, records", async () => {
  const poly = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
  const gj = {
    type: "FeatureCollection",
    today: "2026-09-12",
    newest: "2026-09-05",
    diseases,
    source: { name: "NNDSS", licence: "PD", url: "https://u" },
    features: [
      { type: "Feature", geometry: { type: "Polygon", coordinates: poly }, properties: tx },
      {
        type: "Feature",
        geometry: { type: "MultiPolygon", coordinates: [poly, poly] },
        properties: { fips: "12", name: "Florida", st: "FL", n: 3, by: { den: 3 }, ytd: { den: 3 }, prev_ytd: {}, asof: "2026-09-05", weeks: [{ w: "2026-05-16", n: { den: 3 } }] },
      },
    ],
  };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createArbonetLayer();
    for (const k of ["init", "enable", "disable", "update", "destroy", "getStats", "getAnalystRecords", "getRowControls", "setObservedTime", "setParams", "getParams"])
      assert.equal(typeof l[k], "function");
    assert.equal(l.id, "arbonet");
    let ds;
    l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(ds.entities.values.length, 3, "one entity per polygon part");
    assert.deepEqual(l.getStats().classes, { surge: 1, none: 1 });
    assert.deepEqual(l.getStats().diseases, { wnv: 25, den: 2 });
    assert.ok(ds.entities.getById("arbonet:12:1").polygon.material.getValue().color.alpha < 0.3, "Florida faded live");
    // observed time in May: Texas 1 WNV case, Florida 3 dengue
    assert.equal(l.setObservedTime("2026-05-12T00:00:00Z"), true);
    assert.deepEqual(l.getStats().classes, { one: 1, few: 1 });
    const rc = l.getRowControls();
    assert.equal(rc.legend.find((i) => i.label === "2–4 cases").count, 1);
    assert.equal(rc.legend.find((i) => i.label === NO_DATA.label).count, 0);
    assert.match(rc.legend.at(-1).label, /report week of the observed time/);
    assert.deepEqual(rc.chips.map((c) => [c.id, c.label, c.active]), [["wnv", "WEST NILE 1", true], ["den", "DENGUE 3", true], ["pow", "POWASSAN 0", true]]);
    assert.deepEqual(rc.chips[0].params, { wnv: false });
    // chip: hide dengue → Florida drops to none, Texas keeps its 1 WNV
    assert.equal(l.setParams({ den: false }), true);
    assert.equal(l.setParams({ den: false }), false, "no change → false");
    assert.equal(l.setParams({ nope: false }), false, "unknown disease ignored");
    assert.deepEqual(l.getStats().classes, { one: 1, none: 1 });
    assert.deepEqual(l.getParams(), { wnv: true, den: false, pow: true });
    assert.equal(l.getRowControls().chips[1].state, "idle");
    assert.equal(l.setObservedTime("bad"), false);
    l.enable();
    assert.equal(l.getAnalystRecords().length, 1);
    assert.deepEqual(l.getAnalystRecords()[0].by, { wnv: 1 });
    assert.equal(l.setParams({ den: true }), true);
    assert.equal(l.setObservedTime(null), true);
    const recs = l.getAnalystRecords();
    assert.equal(recs.length, 1, "live: only Texas has cases in the last 8 weeks");
    assert.equal(recs[0].cases, 27);
    assert.match(l.getRowControls().legend.at(-1).label, /newest report week 2026-09-05/);
    l.disable();
    assert.equal(l.getAnalystRecords().length, 0);
  } finally {
    globalThis.fetch = saved;
  }
});
