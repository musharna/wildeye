// MAP STACK chip row — the dropdown's replacement control surface.
//
// The owner's complaint was two clicks (open panel → open dropdown) to change
// basemap. These tests pin the three things that make the row a faithful swap:
// it projects the two-source allowlist from the controller's
// stack data, a click dispatches the same selection the `change` handler used
// to, and the lit chip tracks controller state rather than the click. Run with:
// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAP_STACK_CHIP_CLASS,
  PRESENTED_MAP_STACK_IDS,
  mapStackChipModel,
  mapStackChipModels,
  renderMapStackChips,
  syncMapStackChips,
} from './mapStackChips.js';
import { DEFAULT_MAP_STACK, MAP_STACKS, MapStackController } from './mapStackController.js';

/** Minimal element stand-in — the row only needs create/append/attr/class. */
function makeElement(tagName = 'div') {
  const element = {
    tagName,
    type: '',
    className: '',
    title: '',
    disabled: false,
    textContent: '',
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    classList: {
      toggle(name, force) {
        const classes = new Set(String(element.className).split(/\s+/).filter(Boolean));
        const next = force === undefined ? !classes.has(name) : !!force;
        if (next) classes.add(name);
        else classes.delete(name);
        element.className = [...classes].join(' ');
      },
      contains(name) {
        return String(element.className).split(/\s+/).includes(name);
      },
    },
    appendChild(child) { element.children.push(child); return child; },
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return element.attributes[name] ?? null; },
    addEventListener(type, handler) { (element.listeners[type] ||= []).push(handler); },
    click() { for (const handler of element.listeners.click || []) handler(); },
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set() { element.children.length = 0; },
  });
  return element;
}

const doc = { createElement: (tagName) => makeElement(tagName) };

/** Text a chip renders. */
const chipText = (chip) => chip.children.map((child) => child.textContent).join(' ');

// Shaped exactly like MapStackController.getStacks() output.
const CONTROLLER_STACKS = MAP_STACKS.map((stack) => ({ ...stack }));

test('the row renders exactly the two keyless sources', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'esri-imagery', doc });

  assert.deepEqual(container.children.map((chip) => chip.dataset.stackId), ['esri-imagery', 'osm']);
  assert.deepEqual(container.children.map(chipText), ['Esri Satellite', 'OSM']);
  assert.deepEqual(PRESENTED_MAP_STACK_IDS, ['esri-imagery', 'osm']);
  assert.ok(container.children.every((chip) => chip.tagName === 'button' && chip.type === 'button'));
  assert.ok(container.children.every((chip) => chip.classList.contains(MAP_STACK_CHIP_CLASS)));
  assert.deepEqual(container.children.map((chip) => chip.title), ['Esri Satellite', 'OSM']);
});

test('internal and future stacks stay outside the approved presentation set', () => {
  const container = makeElement();
  // A stack may land in the controller, but it must not appear until the
  // presentation allowlist explicitly includes it.
  const withHybrid = [...CONTROLLER_STACKS, { id: 'hybrid', label: 'Hybrid' }];
  renderMapStackChips(container, withHybrid, { activeId: 'esri-imagery', doc });

  assert.equal(container.children.length, 2);
  assert.doesNotMatch(container.children.map(chipText).join(' '), /Hybrid/);
});

test('re-rendering replaces the previous chips instead of stacking a second row', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'esri-imagery', doc });
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'osm', doc });

  assert.equal(container.children.length, PRESENTED_MAP_STACK_IDS.length);
});

test('clicking a chip dispatches that stack id — the same selection the dropdown made', () => {
  const container = makeElement();
  const selected = [];
  renderMapStackChips(container, CONTROLLER_STACKS, {
    activeId: 'esri-imagery',
    onSelect: (stackId) => selected.push(stackId),
    doc,
  });

  container.children[1].click();
  container.children[0].click();
  assert.deepEqual(selected, ['osm', 'esri-imagery']);
});

test('the active chip is the pressed chip, and exactly one is pressed', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'osm', doc });

  const pressed = container.children.filter((chip) => chip.getAttribute('aria-pressed') === 'true');
  assert.deepEqual(pressed.map((chip) => chip.dataset.stackId), ['osm']);
  assert.ok(pressed[0].classList.contains('active'));
  assert.ok(!container.children[0].classList.contains('active'));
});

test('the lit chip tracks controller state, not the click', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'esri-imagery', doc });

  // A rejected/superseded switch reports the stack that is genuinely active.
  syncMapStackChips(container, 'esri-imagery');
  assert.ok(container.children[0].classList.contains('active'));
  assert.equal(container.children[1].getAttribute('aria-pressed'), 'false');

  // A landed switch moves both the class and the pressed state.
  syncMapStackChips(container, 'osm');
  assert.ok(container.children[1].classList.contains('active'));
  assert.equal(container.children[1].getAttribute('aria-pressed'), 'true');
  assert.ok(!container.children[0].classList.contains('active'));
  assert.equal(container.children[0].getAttribute('aria-pressed'), 'false');
});

test('models never invent an active chip', () => {
  assert.deepEqual(mapStackChipModels([{ id: 'osm', label: 'OSM' }], null), [{ id: 'osm', label: 'OSM', active: false }]);
  assert.deepEqual(mapStackChipModel({ id: 'osm', label: 'OSM' }, 'osm'), { id: 'osm', label: 'OSM', active: true });
  assert.deepEqual(mapStackChipModels(undefined, 'osm'), []);
});

test('a share link naming a retired or unknown stack switches to Esri; a known one switches to itself', async () => {
  // Google 3D, Bing Aerial/Labels and Bing Road were retired; old links still carry their ids.
  const controller = new MapStackController({ imageryLayers: {}, scene: {} });
  const switched = [];
  controller._activateGlobeStack = async (stack) => { switched.push(stack.id); return { effectiveStackId: stack.id }; };
  for (const id of ['photoreal', 'bing-aerial', 'bing-labels', 'bing-road', 'garbage', 'osm']) {
    const state = await controller.setStack(id, { silent: true });
    assert.equal(state.activeId, id === 'osm' ? 'osm' : DEFAULT_MAP_STACK, id);
  }
  assert.deepEqual(switched, ['esri-imagery', 'esri-imagery', 'esri-imagery', 'esri-imagery', 'esri-imagery', 'osm']);
  assert.equal(DEFAULT_MAP_STACK, 'esri-imagery');
});

test('a missing row or document is inert rather than throwing during boot', () => {
  assert.deepEqual(renderMapStackChips(null, CONTROLLER_STACKS, { doc }), []);
  assert.deepEqual(renderMapStackChips(makeElement(), CONTROLLER_STACKS, { doc: {} }), []);
  assert.doesNotThrow(() => syncMapStackChips(null, 'osm'));
});

test('the active cyan survives hover', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const hover = css.indexOf('.map-stack-chip:hover');
  const active = css.indexOf('.map-stack-chip.active {');

  assert.ok(hover > 0 && active > hover, 'active must follow hover so it wins at equal specificity');
  assert.doesNotMatch(
    css.slice(hover, active),
    /:not\(/,
    'a :not() in the hover selector outranks .active and washes the cyan out on hover',
  );
});

test('the keyboard focus ring survives on the ACTIVE chip', () => {
  // The bug this pins: `.active` legitimately wins the color/border/background/
  // box-shadow it shares with the focus rule, and the base rule sets
  // `outline: none` — so a focus state built only from those properties is
  // INVISIBLE on the active chip. The ring must live on a property no other
  // chip-state rule sets.
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
  const chipRules = [...css.matchAll(/([^{}]*\.map-stack-chip[^{}]*)\{([^{}]*)\}/g)]
    .map(([, selector, body], order) => ({
      selector: stripComments(selector).trim(),
      body: stripComments(body),
      order,
    }));
  assert.ok(chipRules.length >= 4, 'expected the chip state rules to be found');

  const ringIndex = chipRules.findIndex(({ selector, body }) => selector.includes(':focus-visible')
    && /outline:\s*(?!none)\S/.test(body)
    && /outline-offset:/.test(body));
  assert.ok(ringIndex >= 0, 'a :focus-visible rule must draw a real outline ring');

  // Nothing after it may touch outline again, so the ring cannot be erased by
  // .active or anything added later.
  for (const rule of chipRules.slice(ringIndex + 1)) {
    assert.doesNotMatch(
      rule.body,
      /outline/,
      `"${rule.selector}" must not touch outline — it would erase the focus ring`,
    );
  }
  assert.ok(
    chipRules.slice(ringIndex + 1).some((rule) => rule.selector.includes('.map-stack-chip.active')),
    'expected the .map-stack-chip.active rule after the ring for this check to mean anything',
  );

  // `transition: all` animates outline-width off the `outline: none` base, and
  // Chrome parks that transition at 0px for chips on a wrapped line — the ring
  // never appeared on rows 2 and 3. The base rule must list its properties.
  const base = chipRules.find((rule) => rule.selector.endsWith('.map-stack-chip'));
  assert.ok(base, 'expected the base .map-stack-chip rule');
  assert.doesNotMatch(
    base.body,
    /transition:\s*all\b/,
    'transition: all animates outline-width and kills the focus ring on wrapped rows',
  );
  assert.doesNotMatch(base.body, /transition:[^;]*outline/, 'the focus ring must not be animated');
  assert.match(base.body, /transition:\s*\n?\s*color/, 'the hover/active treatment still animates');
});

test('the Visual Presets tray owns Map Source and the retired left panel is absent', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

  assert.doesNotMatch(html, /map-stack-select/, 'the SOURCE dropdown is replaced by the chip row');
  assert.match(
    html,
    /<section class="map-source-section"[\s\S]*?<div id="map-stack-chips" class="map-stack-chip-row" role="group" aria-label="Map source"><\/div>/,
  );
  assert.doesNotMatch(html, /id="stack-panel"/, 'the duplicate left MAP STACK panel is retired');
  assert.match(html, /id="map-source-label">MAP SOURCE<[\s\S]*?id="map-stack-status"/);
  assert.match(
    html,
    /<button id="control-panel-toggle"[\s\S]*?data-dock-toggle-target="control-panel"[\s\S]*?aria-controls="control-panel-popover"/,
    'the compact wing must expose a semantic keyboard disclosure',
  );
  assert.match(ui, /event\.key !== 'Escape'[\s\S]*?disclosure\?\.focus/);
  assert.match(ui, /map-stack-chip\.active, \.map-stack-chip/);

  assert.match(
    ui,
    /renderMapStackChips\(this\._mapStackChips, this\.mapStackController\.getStacks\(\), \{[\s\S]*?onSelect: \(stackId\) => \{ this\._setMapStack\(stackId\); \}/,
    'chips must dispatch through the same _setMapStack path the dropdown used',
  );
  assert.match(
    ui,
    /_renderMapStackState\(state\) \{[\s\S]*?syncMapStackChips\(this\._mapStackChips, state\.activeId\)/,
    'the active chip must be re-synced from controller state',
  );
  assert.match(
    ui,
    /window\.addEventListener\('gev:map-stack-changed', this\._mapStackChangeHandler\)/,
    'provider-driven fallback must re-sync the UI without a user click',
  );
  assert.match(
    ui,
    /window\.removeEventListener\('gev:map-stack-changed', this\._mapStackChangeHandler\)/,
    'the provider-driven state listener must be released with StyleManager',
  );
});

test('Esri fallbacks report and attribute the imagery source actually rendered', () => {
  const controller = readFileSync(new URL('./mapStackController.js', import.meta.url), 'utf8');
  assert.match(
    controller,
    /effectiveStackId = 'osm';[\s\S]*?fallbackMessage = 'Esri Satellite is unavailable; using OSM'/,
    'construction failure must resolve truthfully to OSM',
  );
  assert.match(
    controller,
    /this\._activeId = activation\?\.effectiveStackId \|\| stack\.id/,
    'the active chip must follow the effective provider, not the requested stack',
  );
  assert.match(
    controller,
    /this\._syncEsriAttribution\(resolution\.effectiveStackId\)/,
    'Esri credit must follow the effective provider',
  );
});

test('repeated active Esri tile failures fall back to OSM and one transient does not', () => {
  const controller = readFileSync(new URL('./mapStackController.js', import.meta.url), 'utf8');
  assert.match(controller, /let failures = 0/);
  assert.match(controller, /if \(failures < 2 \|\| this\._esriFallbackPending\) return/);
  assert.match(controller, /this\.setStack\('osm', \{ silent: true \}\)/);
  assert.match(controller, /state\?\.activeId === 'osm'[\s\S]*?this\._emitChange\('error'\)/);
  assert.match(
    controller,
    /gen !== this\._switchGen \|\| this\._activeImageryProvider !== resolution\.provider/,
    'a stale provider error must not replace a newer user selection',
  );
});
