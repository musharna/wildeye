// src/data/escapeHandled.test.mjs — species polish fix round 1, item 5: one key, one thing. The app's convention for a handled key is
// preventDefault (the species combobox, the biology card and WHAT LIVES HERE: src/bio/speciesPanel.js, detailsCard.js, whatLivesHere.js). Every
// document-level Escape handler that ends tracking or a selection leaves an Escape alone once another control has handled it. The vessel handler
// is driven for real in aisLiveVessels.test.mjs; these four are module-private, so their handler bodies are read here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const handlerBody = (file) => {
  const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  const start = src.indexOf('function _onKeyDown(');
  assert.ok(start >= 0, `${file} has _onKeyDown`);
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /'Escape'/, `positive control: ${file}'s _onKeyDown is its Escape handler`);
  return body;
};

test('the flight, military flight, satellite and bikeshare Escape handlers skip an Escape another control handled', () => {
  for (const file of ['flights.js', 'militaryFlights.js', 'satellites.js', 'bikeshare.js']) {
    assert.match(handlerBody(file), /!e\.defaultPrevented/, `${file}: _onKeyDown must skip e.defaultPrevented`);
  }
});
