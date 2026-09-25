// DMS readout rounding (found 2026-09-25 while cleaning the HUD): the seconds were rounded on their own
// after degrees and minutes were cut, so 134°E printed as 133°59'60.00"E.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { IntelHUD } = await import('./hud.js');

test('DMS never prints 60 seconds or 60 minutes: rounding carries into the next minute and degree', () => {
  // Seen live 2026-09-25: 134°E printed as 133°59'60.00"E and 5°N as 04°59'60.00"N — the seconds were
  // rounded on their own after the degrees and minutes were already cut.
  const dms = (v, t) => IntelHUD.prototype._toDMS.call(null, v, t);
  assert.equal(dms(134, 'lon'), `134°00'00.00"E`);
  assert.equal(dms(4.999999999, 'lat'), `05°00'00.00"N`);
  assert.equal(dms(-25.000000001, 'lat'), `25°00'00.00"S`);
  assert.equal(dms(12.5125, 'lat'), `12°30'45.00"N`, 'positive control: an ordinary value keeps its minutes and seconds');
  assert.equal(dms(-0.0000001, 'lon'), `000°00'00.00"W`);
});
