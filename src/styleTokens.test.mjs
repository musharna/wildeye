// The light look's colour tokens (grill_wildeye_visual_update_2026-10-20): every text token holds WCAG AA (4.5:1) on the paper the panels
// are made of and on the page behind the globe, and white holds it on the ink accent (the credit chip, active chips). Panels are opaque, so
// the token pair is the whole contrast question; the browser check (scripts/qa-scientific-look.mjs, axe) measures the rendered page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

/** The custom properties of the first :root block, with var() references resolved. */
function rootTokens(source) {
  const body = source.match(/:root\s*\{([^}]*)\}/)?.[1];
  if (!body) throw new Error('no :root block');
  const raw = Object.fromEntries([...body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  const resolve = (v, depth = 0) => {
    if (depth > 8) throw new Error(`var() cycle at ${v}`);
    return v.replace(/var\((--[\w-]+)\)/g, (_, k) => {
      if (!(k in raw)) throw new Error(`${k} is not defined in :root`);
      return resolve(raw[k], depth + 1);
    });
  };
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]));
}

/** [r, g, b, a] from #rgb, #rrggbb, rgb() or rgba(). */
function parseColour(v) {
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const fn = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])];
  throw new Error(`not a colour: ${v}`);
}

const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast of a (possibly translucent) foreground over an opaque ground. */
function contrast(fg, ground) {
  const g = parseColour(ground);
  const l1 = luminance(over(parseColour(fg), g));
  const l2 = luminance(g.slice(0, 3));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const tokens = rootTokens(css);

test('every text token holds 4.5:1 on the paper and on the page', () => {
  const grounds = ['--paper', '--page'];
  const texts = ['--text-primary', '--text-secondary', '--text-dim', '--accent', '--warn', '--error'];
  const low = [];
  for (const t of texts) for (const g of grounds) {
    const ratio = contrast(tokens[t], tokens[g]);
    if (ratio < 4.5) low.push(`${t} on ${g}: ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(low, []);
  // Positive control: the evaluator fails what the dark look used for secondary text, 0.5 white, once it sits on paper.
  assert.ok(contrast('rgba(232, 234, 237, 0.5)', tokens['--paper']) < 1.5, 'the old secondary text is invisible on paper');
});

test('white holds 4.5:1 on the ink accent (the credit chip and active chips)', () => {
  assert.ok(contrast('#ffffff', tokens['--accent']) >= 4.5, `${contrast('#ffffff', tokens['--accent']).toFixed(2)}:1`);
});

test('the header band holds its text: title and search text, the search placeholder, and the count badge', () => {
  const band = tokens['--band'];
  // The search box is white at 12% over the band (style.css, Atlas look); its text and placeholder sit on that.
  const field = '#' + over(parseColour('rgba(255, 255, 255, 0.12)'), parseColour(band)).map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
  const pairs = [
    ['--band-text on --band', tokens['--band-text'], band],
    ['--band-text on the search field', tokens['--band-text'], field],
    ['--band-muted on the search field', tokens['--band-muted'], field],
    ['--band on --band-accent (the count)', band, tokens['--band-accent']],
  ];
  for (const [name, fg, ground] of pairs) assert.ok(contrast(fg, ground) >= 4.5, `${name}: ${contrast(fg, ground).toFixed(2)}:1`);
});

test('the token reader resolves var() and refuses an undefined reference', () => {
  assert.equal(tokens['--bg-dark'], tokens['--page'], 'positive control: --bg-dark resolves through var(--page)');
  assert.throws(() => rootTokens(':root { --a: var(--missing); }'), /--missing is not defined/);
  assert.throws(() => parseColour('cyan'), /not a colour/);
});

/** Every rgb()/rgba()/#hex literal in a source text, with its line, skipping the :root token block. */
function colourLiterals(source, file) {
  const root = source.match(/:root\s*\{[^}]*\}/);
  const text = root ? source.replace(root[0], (m) => m.replace(/[^\n]/g, ' ')) : source;
  const out = [];
  for (const m of text.matchAll(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)|#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) {
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ where: `${file}:${line}`, literal: m[0], rgb: parseColour(m[0].replace(/\s+/g, ' ').replace(/,(?=\S)/g, ', ')).slice(0, 3) });
  }
  return out;
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Literals that are a near copy of the accent but not the accent or any other token: a tint left behind when the accent moved. */
function strayAccents(literals, toks) {
  const accent = parseColour(toks['--accent']).slice(0, 3);
  const known = Object.values(toks).flatMap((v) => { try { return [parseColour(v).slice(0, 3)]; } catch { return []; } });
  return literals
    .filter(({ rgb }) => distance(rgb, accent) > 0 && distance(rgb, accent) <= 30)
    .filter(({ rgb }) => !known.some((k) => distance(rgb, k) === 0))
    .map(({ where, literal }) => `${where} ${literal}`);
}

test('no colour literal is a stale near-copy of the accent (the accent moved in the Atlas look; its tints must move with it)', async () => {
  const { readdirSync } = await import('node:fs');
  const srcDir = new URL('./', import.meta.url);
  const files = [['style.css', css], ...readdirSync(srcDir, { recursive: true })
    .filter((f) => /\.js$/.test(f))
    .map((f) => [`src/${f}`, readFileSync(new URL(f, srcDir), 'utf8')])];
  // A data colour on the map is not chrome: it may sit near the accent by design. Each exception names its file and literal.
  const dataColours = new Set(['src/data/arbonet.js #134e4a']);
  const stray = files.flatMap(([f, text]) => strayAccents(colourLiterals(text, f), tokens))
    .filter((s) => !dataColours.has(s.replace(/:\d+ /, ' ')));
  assert.deepEqual(stray, []);
  // Positive controls: the old #111 ink is caught, the accent itself and a far colour are not.
  const probe = colourLiterals('a { color: rgba(22, 45, 61, 0.1); border: 1px solid rgba(29, 58, 79, 0.14); background: #a8323e; }', 'probe');
  assert.deepEqual(strayAccents(probe, tokens), ['probe:1 rgba(22, 45, 61, 0.1)']);
});
