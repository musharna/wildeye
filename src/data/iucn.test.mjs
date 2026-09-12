// src/data/iucn.test.mjs — IUCN Red List enrichment: seed loading + info-box chip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIucn, iucnBadge, iucnEntry, iucnStyle, IUCN_COLORS, _resetIucn } from './iucn.js';

// shape written by pipeline/iucn.py (citation verbatim from a real v4 assessment response)
const SEED = {
  puffin: { category: 'EN', category_label: 'Endangered', year: 2021, assessment_id: 166290968,
    url: 'https://www.iucnredlist.org/species/22694927/166290968',
    citation: 'BirdLife International 2021. Fratercula arctica (Europe assessment). The IUCN Red List of Threatened Species 2021: e.T22694927A166290968. https://dx.doi.org/10.2305/IUCN.UK.2021-3.RLTS.T22694927A166290968.en. Accessed on 18 September 2024.' },
  humpback: { category: 'LC', year: 2018, url: null, citation: null },
  dodo: { category: 'EX', year: 2016, url: 'https://www.iucnredlist.org/species/1/2', citation: 'x' },
  odd: { category: 'ZZ', year: 2000 },
  _meta: { generated_at: '2026-09-12T00:00:00Z', skipped: { bumblebees: 'genus-level' } },
};

test('iucnStyle: official colours, dark text on light chips, white on EN/CR/EX, grey for unknown', () => {
  assert.deepEqual(iucnStyle('LC'), { bg: '#60c659', fg: '#111' });
  assert.deepEqual(iucnStyle('NT'), { bg: '#cce226', fg: '#111' });
  assert.deepEqual(iucnStyle('VU'), { bg: '#f9e814', fg: '#111' });
  assert.deepEqual(iucnStyle('EN'), { bg: '#fc7f3f', fg: '#fff' });
  assert.deepEqual(iucnStyle('CR'), { bg: '#d81e05', fg: '#fff' });
  assert.deepEqual(iucnStyle('EX'), { bg: '#000000', fg: '#fff' });
  assert.deepEqual(iucnStyle('ew'), { bg: '#000000', fg: '#fff' });
  assert.deepEqual(iucnStyle('DD'), { bg: '#d1d1c6', fg: '#111' });
  assert.deepEqual(iucnStyle('ZZ'), iucnStyle('DD'), 'unknown code falls back to DD grey');
  assert.equal(Object.keys(IUCN_COLORS).length, 8);
  // mutant: swapping EN/CR hexes fails the EN and CR lines above
});

test('iucnBadge: chip carries code, colour, label, year, citation title and assessment link; nothing for unknown taxa', () => {
  _resetIucn(SEED);
  const html = iucnBadge('puffin');
  assert.match(html, /class="iucn-chip"/);
  assert.match(html, /background:#fc7f3f;color:#fff/);
  assert.match(html, />EN<\/span>/);
  assert.match(html, /IUCN Endangered 2021/);
  assert.match(html, /href="https:\/\/www\.iucnredlist\.org\/species\/22694927\/166290968" target="_blank" rel="noopener"/);
  assert.match(html, /title="BirdLife International 2021\. Fratercula arctica \(Europe assessment\)\. The IUCN Red List of Threatened Species 2021: e\.T22694927A166290968/);
  // no url → no anchor; no citation → generated title; label from the code table
  const lc = iucnBadge('humpback');
  assert.doesNotMatch(lc, /<a /);
  assert.match(lc, /IUCN Least Concern 2018/);
  assert.match(lc, /title="Least Concern — IUCN Red List 2018"/);
  assert.match(iucnBadge('dodo'), /background:#000000;color:#fff.*>EX</);
  assert.match(iucnBadge('odd'), /background:#d1d1c6/);
  // negatives with the positives above as control (mutant: returning the LC chip for unknown keys fails these)
  assert.equal(iucnBadge('nope'), '');
  assert.equal(iucnBadge('_meta'), '', 'reserved meta key is not a taxon');
  assert.equal(iucnBadge(undefined), '');
  assert.equal(iucnEntry('_meta'), null); // mutant: `e && e.category ? e : null` → `e || null` returns the _meta object here and a non-empty badge above
  // HTML from the seed is escaped
  _resetIucn({ evil: { category: 'CR', citation: '<img src=x>', url: 'javascript:"<x>"' } });
  const ev = iucnBadge('evil');
  assert.match(ev, /title="&lt;img src=x&gt;"/);
  assert.doesNotMatch(ev, /<img/);
  assert.match(ev, /href="javascript:&quot;&lt;x&gt;&quot;"/);
  _resetIucn({});
});

test('loadIucn: reads the seed, tolerates 404 and an empty seed, surfaces other failures', async () => {
  const mk = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  assert.deepEqual(await loadIucn(mk(200, SEED)), SEED);
  assert.match(iucnBadge('puffin'), />EN</, 'positive control: loaded map drives the badge');
  assert.deepEqual(await loadIucn(mk(404, null)), {});
  assert.equal(iucnBadge('puffin'), '', 'a missing seed clears the previous map (mutant: keeping _map on 404 fails here)');
  assert.deepEqual(await loadIucn(mk(200, {})), {});
  await assert.rejects(loadIucn(mk(500, null)), /HTTP 500/);
  await assert.rejects(loadIucn(mk(200, [1, 2])), /Malformed/);
  await assert.rejects(loadIucn(mk(200, null)), /Malformed/);
  // real seed file on disk, as the integrator ships it
  const { readFile } = await import('node:fs/promises');
  const real = JSON.parse(await readFile(new URL('../../public/data/seed/iucn.json', import.meta.url), 'utf8'));
  const m = await loadIucn(mk(200, real));
  assert.equal(typeof m, 'object');
  for (const [k, v] of Object.entries(m)) if (!k.startsWith('_')) assert.match(String(v.category), /^(LC|NT|VU|EN|CR|EW|EX|DD|NE|LR\/\w+)$/, k);
  _resetIucn({});
});
