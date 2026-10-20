import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentenceCase } from './textCase.js';

test('the first letter is capitalised and the rest keeps the source case', () => {
  assert.equal(sentenceCase('whales & dolphins'), 'Whales & dolphins');
  assert.equal(sentenceCase('Aedes albopictus'), 'Aedes albopictus');   // a binomial keeps its lower-case epithet
  assert.equal(sentenceCase('SE Pacific'), 'SE Pacific');               // an acronym is not lowered
});

test('empty and missing input give an empty label', () => {
  assert.equal(sentenceCase(''), '');
  assert.equal(sentenceCase(null), '');
  assert.equal(sentenceCase(undefined), '');
});
