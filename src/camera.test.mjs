// Globe-view preset and flight: the reset-globe button and the fresh-session start view.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { GLOBE_VIEW, flyToGlobeView } from './camera.js';

function stubViewer() {
  const flights = [];
  return {
    flights,
    camera: {
      positionCartographic: {
        longitude: Cesium.Math.toRadians(-97.7431),
        latitude: Cesium.Math.toRadians(30.2672),
        height: 1200,
      },
      cancelFlight() {},
      flyTo(options) { flights.push(options); },
    },
  };
}

// "Zoom out to a globe view" needs an ABSOLUTE full-earth framing. The preset
// must sit inside the app's 'global' view-scale band (>12,000 km camera height)
// and under the 20,000 km ceiling.
test('GLOBE_VIEW preset height sits in the global view band', () => {
  assert.ok(GLOBE_VIEW.heightM > 12000000, `must classify as global band, got ${GLOBE_VIEW.heightM}`);
  assert.ok(GLOBE_VIEW.heightM <= 20000000, `must stay under the 20,000 km ceiling, got ${GLOBE_VIEW.heightM}`);
  // Straight-down framing so the planet reads as a globe, not a horizon shot.
  assert.equal(GLOBE_VIEW.pitchDeg, -90);
});

// The globe flight's callbacks are what resolves Reset Globe. They were once
// published under this module's OWN option names (`onComplete` / `onCancel`),
// which Cesium's Camera.flyTo ignores — so neither ever fired and every caller
// resolved off its ~4.2 s watchdog timeout instead of the flight.
test('the globe flight publishes its callbacks under Cesium\'s own option names', () => {
  const viewer = stubViewer();
  const fired = [];
  flyToGlobeView(viewer, {
    onComplete: () => fired.push('complete'),
    onCancel: () => fired.push('cancel'),
  });

  const flight = viewer.flights[0];
  assert.equal(typeof flight.complete, 'function', 'Cesium resolves arrival through `complete`');
  assert.equal(typeof flight.cancel, 'function', 'Cesium reports supersession through `cancel`');
  // Not merely present under both spellings: the ignored names must be gone,
  // or a later reader can "fix" the wrong one back.
  assert.equal('onComplete' in flight, false, 'Cesium ignores onComplete — do not publish it');
  assert.equal('onCancel' in flight, false, 'Cesium ignores onCancel — do not publish it');

  flight.complete();
  flight.cancel();
  assert.deepEqual(fired, ['complete', 'cancel'], 'each hook reaches the caller it belongs to');
});

test('a globe flight without callbacks still flies (both hooks are optional) in the world frame', () => {
  const viewer = stubViewer();
  const target = flyToGlobeView(viewer);
  assert.equal(viewer.flights.length, 1);
  assert.equal(target.heightM, GLOBE_VIEW.heightM);
  assert.equal(viewer.flights[0].complete, undefined);
  assert.equal(viewer.flights[0].cancel, undefined);
  assert.equal(viewer.flights[0].endTransform, Cesium.Matrix4.IDENTITY);
});
