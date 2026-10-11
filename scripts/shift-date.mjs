// Preload for the unit tests: moves Date ahead by SHIFT_DAYS days (default 400) so a test that pins a date against the
// wall clock fails in the weekly clock-shift workflow long before it fails in CI.
// Use: SHIFT_DAYS=400 NODE_OPTIONS="--import ./scripts/shift-date.mjs" npm test
const offset = Number(process.env.SHIFT_DAYS ?? 400) * 86_400_000;
const RealDate = Date;
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }
  static now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = ShiftedDate;
