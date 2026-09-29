#!/usr/bin/env node
/**
 * lint-qa-waits.mjs — a QA script must not sleep a fixed time and then interact.
 * Run: node scripts/lint-qa-waits.mjs [files...]   (default: every scripts/*.mjs; exits 1 on any finding)
 *
 * Flags a statement that awaits a fixed sleep — sleep/delay/wait/pause(N), `new Promise(r => setTimeout(r, N))`,
 * `x.waitForTimeout(N)` — when the NEXT statement in the same block clicks, focuses, hovers or taps anything (a
 * puppeteer call or a DOM call inside page.evaluate). The sleep stands in for "the thing is ready", and on a busy page
 * it is not: three QA misses in one day (2026-09-27: the held frame, the tray keyboard focus, the tray tile click)
 * were each a fixed sleep lost to a transition or a pending timer. Wait for the state instead (waitForFunction,
 * waitForSelector with a visibility/hit test). A deliberate sleep is allowed with a reason on its line:
 * `// qa-wait-ok: <why a duration, not a state, is the point>`.
 * Not counted (yet): key presses. Sixteen scripts sleep 12 s at boot and then press Escape — a leftover of the first-run
 * launcher removed in 54192b3; whether that Escape still does anything was not traced, so it stays and is not flagged.
 * Parser: rollup's (`rollup/parseAst`, installed with vite) — current syntax incl. top-level await and `?.`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseAst } from 'rollup/parseAst';

const SLEEP_NAMES = new Set(['sleep', 'delay', 'wait', 'pause']);
const ACTIONS = new Set(['click', 'focus', 'hover', 'tap']);
const MARKER = /\/\/\s*qa-wait-ok:\s*\S.{3,}/;

const walk = (node, visit) => {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'parent') continue;
    if (Array.isArray(v)) for (const c of v) walk(c, visit);
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, visit);
  }
};
const some = (node, pred) => { let hit = false; walk(node, (n) => { if (!hit && pred(n)) hit = true; }); return hit; };

const isSleepCall = (e) => {
  if (e?.type === 'CallExpression') {
    if (e.callee.type === 'Identifier' && SLEEP_NAMES.has(e.callee.name) && e.arguments.length) return true;
    if (e.callee.type === 'MemberExpression' && e.callee.property?.name === 'waitForTimeout') return true;
  }
  if (e?.type === 'NewExpression' && e.callee.type === 'Identifier' && e.callee.name === 'Promise')
    return some(e, (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'setTimeout');
  return false;
};
const isSleepStatement = (s) => s.type === 'ExpressionStatement' && s.expression.type === 'AwaitExpression' && isSleepCall(s.expression.argument);
const interacts = (s) => some(s, (n) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
  && ACTIONS.has(n.callee.property?.name) && !n.callee.computed);

/** @returns {{line:number, next:number}[]} */
export function findSleepThenInteract(source) {
  const ast = parseAst(source, { allowReturnOutsideFunction: true });
  const lineOf = (pos) => source.slice(0, pos).split('\n').length;
  const lines = source.split('\n');
  const out = [];
  walk(ast, (node) => {
    const list = node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock' ? node.body
      : node.type === 'SwitchCase' ? node.consequent : null;
    if (!list) return;
    for (let i = 0; i + 1 < list.length; i++) {
      if (!isSleepStatement(list[i]) || !interacts(list[i + 1])) continue;
      const line = lineOf(list[i].start);
      if (MARKER.test(lines[line - 1])) continue;
      out.push({ line, next: lineOf(list[i + 1].start) });
    }
  });
  return out;
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invoked) {
  const files = process.argv.length > 2 ? process.argv.slice(2)
    : readdirSync('scripts').filter((f) => f.endsWith('.mjs')).map((f) => path.join('scripts', f));
  let n = 0;
  for (const f of files) for (const hit of findSleepThenInteract(readFileSync(f, 'utf8'))) {
    n++;
    console.log(`${f}:${hit.line}: fixed sleep, then an interaction at line ${hit.next}; wait for the state instead`);
  }
  console.log(`${n} finding(s)`);
  process.exit(n ? 1 : 0);
}
