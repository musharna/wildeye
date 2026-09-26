#!/usr/bin/env node
/**
 * Wildlife workloads for the call-count ratchet (scripts/callcount-check.mjs,
 * bloat grill Q7): the per-step and per-frame paths a visitor drives, run in
 * Node against real Cesium with a stub viewer. Lives outside src/ so its own
 * functions are not counted.
 *
 * Every input is fixed, so the counts are too: the tracks fixture comes from a
 * seeded generator, occurrences read the committed seed snapshot (not the
 * cron-rewritten live file), Date.now is frozen, performance.now is a virtual
 * clock and Math.random is seeded (the birds layer draws particles from it).
 *
 *   tracks-step       load 60 deployments, time bar on, 104 weekly steps, off
 *   occurrences-step  load the seed snapshot, 30 daily steps, then back to now
 *   birds-tick        a 64x32 spawn field, 120 particle frames at 1 s each, so
 *                     every particle outlives its 90 s life and respawns
 *
 * Profile via GEV_WILDLIFE_PROFILE. Prints one JSON report line; exits 1 on an
 * unknown profile or a layer that refused its input.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXED_NOW_MS = Date.parse('2026-09-26T00:00:00Z');
const DAY_MS = 86_400_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260926);
Math.random = rng;
Date.now = () => FIXED_NOW_MS;
let virtualMs = 0;
Object.defineProperty(performance, 'now', { value: () => virtualMs, configurable: true });
console.log = () => {}; // the layers log each load; stdout carries only the report

const TRACK_GROUPS = ['whales & dolphins', 'seals', 'land mammals', 'birds', 'reptiles'];
const TRACKS_START_MS = Date.parse('2020-01-01T00:00:00Z');

/** 60 deployments of 1-3 segments, 30-119 fixes 12 h apart, starting anywhere in 2020-2021. */
function tracksFixture() {
  const features = [];
  for (let d = 0; d < 60; d++) {
    const group = TRACK_GROUPS[d % TRACK_GROUPS.length];
    let t = TRACKS_START_MS + Math.floor(rng() * 600) * DAY_MS;
    let lon = -170 + rng() * 340;
    let lat = -60 + rng() * 120;
    const segments = 1 + Math.floor(rng() * 3);
    for (let segment = 0; segment < segments; segment++) {
      const n = 30 + Math.floor(rng() * 90);
      const coords = [];
      const times = [];
      for (let k = 0; k < n; k++) {
        lon = Math.max(-179, Math.min(179, lon + (rng() - 0.5) * 0.8));
        lat = Math.max(-80, Math.min(80, lat + (rng() - 0.5) * 0.6));
        coords.push([lon, lat]);
        times.push(new Date(t).toISOString());
        t += 12 * 3_600_000;
      }
      t += 20 * DAY_MS; // a gap between segments, as tag duty cycles leave
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {
          species: `species ${d % 12}`, sci: `Genus species${d % 12}`, group, dataset: `d${d}`, segment, animal: `a${d}`,
          times, start: times[0], end: times.at(-1), n, source: 'movebank', source_name: 'Movebank',
          institution: 'fixture', citation: 'fixture', license: 'CC0', url: 'https://example.org',
        },
      });
    }
  }
  const species = [...new Set(features.map((f) => f.properties.species))].sort();
  return { type: 'FeatureCollection', generated_at: '2026-09-26T00:00:00Z', species, groups: TRACK_GROUPS, features };
}

/** Serve `data/<name>` from an in-memory body or the committed seed snapshot; anything else is a harness bug. */
function installFetch(bodies) {
  globalThis.fetch = async (url) => {
    const name = String(url).split('?')[0].replace(/^data\/(seed\/)?/, '');
    const body = name in bodies
      ? bodies[name]
      : JSON.parse(readFileSync(path.join(ROOT, 'public/data/seed', name), 'utf8'));
    return { ok: true, status: 200, json: async () => body };
  };
}

function stubViewer() {
  const listeners = { tick: [], preRender: [] };
  const event = (list) => ({ addEventListener(fn) { list.push(fn); return () => list.splice(list.indexOf(fn), 1); } });
  return {
    listeners,
    dataSources: { add(ds) { return ds; }, remove() {} },
    imageryLayers: { add() {}, remove() {} },
    camera: { positionCartographic: { height: 5_000_000 } },
    clock: { onTick: event(listeners.tick) },
    scene: { primitives: { add(p) { return p; }, remove() {} }, preRender: event(listeners.preRender) },
  };
}

async function tracksStep() {
  const { createTracksLayer } = await import('../src/data/tracks.js');
  const fixture = tracksFixture();
  installFetch({ 'tracks.geojson': fixture });
  const layer = createTracksLayer();
  layer.init(stubViewer());
  layer.enable();
  if (!(await layer.update())) throw new Error(`tracks refused the fixture: ${layer.getStats().error}`);
  const { startMs } = layer.getObservedExtent();
  let steps = 0;
  for (let week = 0; week < 104; week++, steps++) layer.setObservedTime(new Date(startMs + week * 7 * DAY_MS).toISOString());
  layer.setObservedTime(null);
  return { features: fixture.features.length, steps };
}

async function occurrencesStep() {
  const { createOccurrencesLayer } = await import('../src/data/occurrences.js');
  installFetch({});
  const layer = createOccurrencesLayer();
  layer.init(stubViewer());
  layer.enable();
  if (!(await layer.update())) throw new Error(`occurrences refused the seed: ${layer.getStats().error}`);
  const { endMs } = layer.getObservedExtent();
  let steps = 0;
  for (let day = 29; day >= 0; day--, steps++) layer.setObservedTime(new Date(endMs - day * DAY_MS).toISOString());
  layer.setObservedTime(null);
  return { features: layer.getStats().count, steps };
}

async function birdsTick() {
  const { createBirdsLayer } = await import('../src/data/birds.js');
  const layer = createBirdsLayer();
  const viewer = stubViewer();
  layer.init(viewer);
  layer.setParams({ drape: false, particles: true });
  const w = 64;
  const h = 32;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba[i * 4] = rng() < 0.3 ? Math.floor(rng() * 256) : 0; // spawn weight in red
  const sites = Array.from({ length: 8 }, (_, i) => ({
    site: `K${i}`, name: `site ${i}`, lon: -120 + i * 7, lat: 30 + (i % 3) * 5,
    u_ms: (rng() - 0.5) * 20, v_ms: (rng() - 0.5) * 20, density_birds_km3: rng() * 50,
  }));
  layer._applyField({ bounds: { west: -125, east: -65, south: 25, north: 50 }, sites }, { rgba, w, h });
  if (layer.getStats().particles === 0) throw new Error('birds field has no spawn weight: no particles to tick');
  layer.enable(viewer);
  if (viewer.listeners.tick.length !== 1) throw new Error(`birds registered ${viewer.listeners.tick.length} tick listeners, expected 1`);
  const [tick] = viewer.listeners.tick;
  let frames = 0;
  for (; frames < 121; frames++) { tick(); virtualMs += 1000; }
  layer.disable();
  return { particles: layer.getStats().particles, frames };
}

const PROFILES = { 'tracks-step': tracksStep, 'occurrences-step': occurrencesStep, 'birds-tick': birdsTick };

const profile = process.env.GEV_WILDLIFE_PROFILE;
try {
  if (!(profile in PROFILES)) throw new Error(`unknown GEV_WILDLIFE_PROFILE ${JSON.stringify(profile)}`);
  const report = await PROFILES[profile]();
  process.stdout.write(`${JSON.stringify({ ok: true, profile, ...report })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, profile, error: String(error?.stack || error) })}\n`);
  process.exitCode = 1;
}
