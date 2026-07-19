// Unit tests for the server-authoritative roulette resolver.
// Proves resolveRoulette (DO) pays out EXACTLY like the client's rouResolve.
// Run: node worker/roulette-settlement.test.mjs
import { resolveRoulette } from './clubnile-room.js';

const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const OUTSIDE = new Set(['red','black','odd','even','low','high','d1','d2','d3','c1','c2','c3']);

// An INDEPENDENTLY-structured reference (rule-per-key) to cross-check against.
function ref(bets, n) {
  let returned = 0, profit = 0;
  const red = RED.has(n);
  for (const [k, amt] of Object.entries(bets)) {
    if (!amt) continue;
    let win = false, mult = 0;
    if (k[0] === 'n' && !OUTSIDE.has(k)) { win = Number(k.slice(1)) === n; mult = 35; }
    else if (k === 'red')   { win = n !== 0 && red; mult = 1; }
    else if (k === 'black') { win = n !== 0 && !red; mult = 1; }
    else if (k === 'odd')   { win = n !== 0 && n % 2 === 1; mult = 1; }
    else if (k === 'even')  { win = n !== 0 && n % 2 === 0; mult = 1; }
    else if (k === 'low')   { win = n >= 1 && n <= 18; mult = 1; }
    else if (k === 'high')  { win = n >= 19 && n <= 36; mult = 1; }
    else if (k === 'd1')    { win = n >= 1 && n <= 12; mult = 2; }
    else if (k === 'd2')    { win = n >= 13 && n <= 24; mult = 2; }
    else if (k === 'd3')    { win = n >= 25 && n <= 36; mult = 2; }
    else if (k === 'c1')    { win = n !== 0 && n % 3 === 1; mult = 2; }
    else if (k === 'c2')    { win = n !== 0 && n % 3 === 2; mult = 2; }
    else if (k === 'c3')    { win = n !== 0 && n % 3 === 0; mult = 2; }
    if (win) { returned += amt * (mult + 1); profit += amt * mult; }
  }
  return { returned, profit };
}

let pass = 0, fail = 0;
function eq(got, exp, label) {
  const ok = got.returned === exp.returned && got.profit === exp.profit;
  if (ok) pass++; else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} exp ${JSON.stringify(exp)}`); }
}

// ── 1. Hand-verified scenarios ────────────────────────────────────────────
eq(resolveRoulette({ red: 10 }, 3),        { returned: 20,  profit: 10 },  '$10 red on 3 (red)');
eq(resolveRoulette({ red: 10 }, 4),        { returned: 0,   profit: 0 },   '$10 red on 4 (black)');
eq(resolveRoulette({ red: 10 }, 0),        { returned: 0,   profit: 0 },   '$10 red on 0 (green loses)');
eq(resolveRoulette({ n17: 5 }, 17),        { returned: 180, profit: 175 }, '$5 straight 17 hits (35:1)');
eq(resolveRoulette({ n17: 5 }, 18),        { returned: 0,   profit: 0 },   '$5 straight 17 misses');
eq(resolveRoulette({ n0: 5 }, 0),          { returned: 180, profit: 175 }, '$5 straight 0 hits');
eq(resolveRoulette({ d2: 10 }, 15),        { returned: 30,  profit: 20 },  '$10 dozen2 on 15 (2:1)');
eq(resolveRoulette({ d2: 10 }, 12),        { returned: 0,   profit: 0 },   '$10 dozen2 on 12 (miss)');
eq(resolveRoulette({ c1: 10 }, 34),        { returned: 30,  profit: 20 },  '$10 col1 on 34 (34%3=1)');
eq(resolveRoulette({ c3: 10 }, 36),        { returned: 30,  profit: 20 },  '$10 col3 on 36 (36%3=0)');
eq(resolveRoulette({ odd: 10, high: 10 }, 21), { returned: 40, profit: 20 }, '$10 odd + $10 high on 21');
eq(resolveRoulette({ low: 10, even: 10 }, 0),  { returned: 0,  profit: 0 },  'outside all lose on 0');
// mixed board: red+straight both win on 19 (19 is red)
eq(resolveRoulette({ red: 10, n19: 2 }, 19), { returned: 20 + 72, profit: 10 + 70 }, 'red + straight 19');

// ── 2. Fuzz cross-check vs the independent reference (all 37 numbers) ──────
const KEYS = [...OUTSIDE, ...Array.from({ length: 37 }, (_, i) => 'n' + i)];
function rnd(a) { return a[Math.floor(Math.random() * a.length)]; }
for (let t = 0; t < 30000; t++) {
  const bets = {};
  const count = 1 + Math.floor(Math.random() * 6);
  for (let i = 0; i < count; i++) bets[rnd(KEYS)] = 1 + Math.floor(Math.random() * 500);
  const n = Math.floor(Math.random() * 37);
  const got = resolveRoulette(bets, n);
  const exp = ref(bets, n);
  if (got.returned !== exp.returned || got.profit !== exp.profit) {
    fail++;
    console.log(`  FUZZ FAIL n=${n} bets=${JSON.stringify(bets)} got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`);
    break;
  } else pass++;
}

// ── 3. Stack-flow invariant: net change = returned - totalStaked ──────────
{
  const bets = { red: 30, n7: 5, d1: 20 };
  const staked = Object.values(bets).reduce((a, b) => a + b, 0);   // 55
  const startStack = 100;
  const afterPlace = startStack - staked;                          // stakes deducted at placement (45)
  const { returned } = resolveRoulette(bets, 7);                   // 7 red: red 30→60, n7 5→180, d1 20→60
  const finalStack = afterPlace + returned;                        // 45 + 300 = 345
  eq({ returned: finalStack, profit: 0 }, { returned: 345, profit: 0 }, 'stack flow on 7');
}

console.log(`\nroulette settlement: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
