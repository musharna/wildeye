#!/usr/bin/env node
/**
 * css-dead-decls.mjs — find declarations in a stylesheet that can never apply.
 * Run: node scripts/css-dead-decls.mjs [style.css]   (exits 1 when it finds any)
 *
 * A declaration is dead when a LATER rule with the IDENTICAL selector sets the same property wherever the earlier one
 * could apply: the later rule has no condition, or its @media/@supports chain is a prefix of the earlier one's (same
 * or broader). Identical selectors match the same elements with the same specificity, so the later one always wins —
 * unless the earlier one is !important and the later is not. A declaration in a selector list is dead only when it is
 * dead for every selector in the list. Deliberately conservative: shorthand/longhand pairs (`inset` vs `bottom`) and
 * repeats inside one rule (the fallback idiom) are never flagged, and a stylesheet using @layer is refused.
 *
 * Why (2026-09-28): the file had grown one rule per fix, each placed after the last. The minimal HUD's bottom-left
 * corner had its `bottom` set five times and four could never apply; a dock transform was overridden 350 lines later.
 */
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const norm = (s) => s.replace(/\s+/g, ' ').trim();
// A browser that cannot parse one selector in a list drops the whole rule, and then an earlier rule is the one that
// applies (a fallback, not dead). So a later rule kills only when every pseudo it uses is long-supported or is also
// used by the earlier rule (which a browser without it drops just the same). `:has()` is the case in this file.
const OLD_PSEUDOS = new Set([':hover', ':focus', ':active', ':visited', ':link', ':not', ':first-child', ':last-child',
  ':nth-child', ':nth-of-type', ':first-of-type', ':last-of-type', ':only-child', ':empty', ':root', ':checked',
  ':disabled', ':enabled', ':target', '::before', '::after', ':before', ':after', '::placeholder', '::selection',
  ':focus-within', ':first-letter', ':first-line', '::first-letter', '::first-line']);
const pseudos = (selectors) => new Set(selectors.flatMap((s) => s.match(/::?[a-z-]+/gi) ?? []).map((p) => p.toLowerCase()));

/** @returns {{line:number, selector:string, prop:string, value:string, killedBy:number}[]} */
export function findDeadDeclarations(css) {
  const root = postcss.parse(css);
  let layered = false;
  root.walkAtRules('layer', () => { layered = true; });
  if (layered) throw new Error('css-dead-decls: @layer changes cascade order; this check assumes source order decides');
  // Every (selector, prop) setting in source order, with the condition chain it lives under.
  const settings = [];
  root.walkRules((rule) => {
    const chain = [];
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule') {
        if (/keyframes$/i.test(p.name)) return; // keyframe steps are not selectors
        chain.unshift(`@${p.name} ${norm(p.params)}`);
      }
    }
    const selectors = rule.selectors.map(norm);
    rule.each((decl) => {
      if (decl.type !== 'decl') return;
      settings.push({ rule, decl, selectors, chain, prop: decl.prop.toLowerCase(), important: decl.important, pseudos: pseudos(selectors) });
    });
  });
  const covers = (later, earlier) => later.chain.length <= earlier.chain.length && later.chain.every((c, i) => c === earlier.chain[i]);
  const dead = [];
  settings.forEach((s, i) => {
    let killer = null;
    const allDead = s.selectors.every((sel) => {
      for (let j = i + 1; j < settings.length; j++) {
        const t = settings[j];
        if (t.rule === s.rule || t.prop !== s.prop || !t.selectors.includes(sel) || !covers(t, s)) continue;
        if (s.important && !t.important) continue;
        if ([...t.pseudos].some((p) => !OLD_PSEUDOS.has(p) && !s.pseudos.has(p))) continue;
        killer = killer ?? t;
        return true;
      }
      return false;
    });
    if (allDead) dead.push({ line: s.decl.source.start.line, selector: s.selectors.join(', '), prop: s.prop, value: s.decl.value, killedBy: killer.decl.source.start.line });
  });
  return dead;
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  const file = process.argv[2] ?? 'style.css';
  const dead = findDeadDeclarations(readFileSync(file, 'utf8'));
  for (const d of dead) console.log(`${file}:${d.line}  ${d.selector} { ${d.prop}: ${d.value} }  — overridden at line ${d.killedBy}`);
  console.log(`${dead.length} dead declaration(s)`);
  process.exit(dead.length ? 1 : 0);
}
