// Parity tests for the server blackjack + craps resolvers vs the client rules.
// Run: node worker/table-settlement.test.mjs
import { resolveBlackjack, resolveCraps } from './clubnile-room.js';

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) pass++; else { fail++; console.log('  FAIL ' + label); } }
const card = r => ({ r, s: 0 });
const hand = (...rs) => rs.map(card);

// ── Blackjack: hand-verified ──────────────────────────────────────────────
ok(resolveBlackjack(hand(10,10,5), hand(10,7), 10) === 0,  'player bust → 0');
ok(resolveBlackjack(hand(10,10),   hand(10,8), 10) === 20, 'P20 vs D18 → win 2x');
ok(resolveBlackjack(hand(10,8),    hand(10,10),10) === 0,  'P18 vs D20 → lose');
ok(resolveBlackjack(hand(10,9),    hand(10,9), 10) === 10, 'P19 vs D19 → push');
ok(resolveBlackjack(hand(1,13),    hand(10,7), 10) === 25, 'blackjack vs D17 → 3:2 (25)');
ok(resolveBlackjack(hand(1,13),    hand(1,12), 10) === 10, 'blackjack vs dealer blackjack → push');
ok(resolveBlackjack(hand(10,8),    hand(10,6,10),10) === 20,'dealer busts → win 2x');
ok(resolveBlackjack(hand(10,10),   hand(10,8), 20) === 40, 'doubled bet win → 40');

// Blackjack fuzz vs an independent reference
function refBJ(p, d, bet) {
  const val = h => { let v=0,a=0; for (const c of h){ if(c.r===1){a++;v+=11;} else v+=Math.min(c.r,10);} while(v>21&&a>0){v-=10;a--;} return v; };
  const pv=val(p), dv=val(d), pbj=pv===21&&p.length===2, dbj=dv===21&&d.length===2;
  if (pv>21) return 0;
  if (pbj && !dbj) return bet + Math.floor(bet*1.5);
  if (dv>21 || pv>dv) return bet*2;
  if (pv===dv) return bet;
  return 0;
}
const rr = () => 1 + Math.floor(Math.random()*13);
for (let t=0;t<20000;t++){
  const p = Array.from({length:2+Math.floor(Math.random()*3)}, rr).map(card);
  const d = Array.from({length:2+Math.floor(Math.random()*3)}, rr).map(card);
  const bet = 1 + Math.floor(Math.random()*100);
  if (resolveBlackjack(p,d,bet) !== refBJ(p,d,bet)) { fail++; console.log('  BJ FUZZ FAIL', JSON.stringify({p,d,bet})); break; } else pass++;
}

// ── Craps: hand-verified sequences ────────────────────────────────────────
const emptyCr = () => { const b={pass:0,field:0}; [4,5,6,8,9,10].forEach(n=>b['p'+n]=0); [4,6,8,10].forEach(n=>b['h'+n]=0); return b; };
function cr(setup, point, d1, d2) { const b = Object.assign(emptyCr(), setup); return resolveCraps(b, point, d1, d2); }

let r;
r = cr({pass:10}, 0, 3, 4); ok(r.credit===20 && r.point===0 && r.bets.pass===0, 'comeout 7 pass wins 20');
r = cr({pass:10}, 0, 1, 1); ok(r.credit===0  && r.point===0 && r.bets.pass===0, 'comeout craps 2 pass loses');
r = cr({pass:10}, 0, 2, 3); ok(r.credit===0  && r.point===5 && r.bets.pass===10,'comeout 5 sets point, pass rides');
r = cr({pass:10}, 5, 2, 3); ok(r.credit===20 && r.point===0 && r.bets.pass===0, 'point 5 hit pass wins 20');
r = cr({pass:10, p6:6}, 6, 3, 3); ok(r.credit===27 && r.point===0 && r.bets.p6===6, 'point6 hit + place6 pays (20+7), place stays');
r = cr({pass:10, p6:6, h8:5}, 8, 3, 4); ok(r.credit===0 && r.point===0 && r.bets.pass===0 && r.bets.p6===0 && r.bets.h8===0 && r.seven, 'seven-out clears all');
r = cr({field:10}, 0, 1, 1); ok(r.credit===20 && r.bets.field===10, 'field 2 pays 2x, stays');
r = cr({field:10}, 0, 6, 6); ok(r.credit===30 && r.bets.field===10, 'field 12 pays 3x, stays');
r = cr({field:10}, 0, 2, 3); ok(r.credit===0  && r.bets.field===0,  'field 5 loses, comes down');
r = cr({h8:5}, 8, 4, 4); ok(r.credit===45 && r.point===0 && r.bets.h8===5, 'hard 8 hit pays 45, point hit, stays');
r = cr({h8:5}, 8, 5, 3); ok(r.credit===0 && r.point===0 && r.bets.h8===0, 'easy 8 hits point, hard 8 comes down');

// Craps single-roll fuzz vs an independent reference
function refCraps(bets, point, d1, d2) {
  const sum=d1+d2, hard=d1===d2, b={...bets}; let credit=0, pt=point, seven=false;
  const PP={4:[9,5],5:[7,5],6:[7,6],8:[7,6],9:[7,5],10:[9,5]}, HP={4:7,6:9,8:9,10:7};
  if (b.field>0){ const m=(sum===2)?2:(sum===12)?3:([3,4,9,10,11].includes(sum)?1:0); if(m>0)credit+=b.field*m; else b.field=0; }
  if (pt===0){ if(sum===7||sum===11){ if(b.pass){credit+=2*b.pass;b.pass=0;} } else if(sum===2||sum===3||sum===12){ if(b.pass)b.pass=0; } else pt=sum; }
  else if (sum===7){ seven=true;b.pass=0;[4,5,6,8,9,10].forEach(n=>b['p'+n]=0);[4,6,8,10].forEach(n=>b['h'+n]=0);pt=0; }
  else { if(sum===pt){ if(b.pass){credit+=2*b.pass;b.pass=0;} pt=0; } if(b['p'+sum]){const[a,bb]=PP[sum];credit+=Math.floor(b['p'+sum]*a/bb);} if([4,6,8,10].includes(sum)&&b['h'+sum]){ if(hard)credit+=b['h'+sum]*HP[sum]; else b['h'+sum]=0; } }
  return {credit, point:pt, seven, bets:b};
}
const die = () => 1 + Math.floor(Math.random()*6);
const points = [0,4,5,6,8,9,10];
for (let t=0;t<30000;t++){
  const b = emptyCr();
  for (const k of Object.keys(b)) if (Math.random()<0.4) b[k] = 1 + Math.floor(Math.random()*100);
  const pt = points[Math.floor(Math.random()*points.length)];
  const d1=die(), d2=die();
  const got = resolveCraps({...b}, pt, d1, d2), exp = refCraps({...b}, pt, d1, d2);
  const same = got.credit===exp.credit && got.point===exp.point && got.seven===exp.seven &&
    Object.keys(b).every(k => (got.bets[k]||0) === (exp.bets[k]||0));
  if (!same) { fail++; console.log('  CRAPS FUZZ FAIL', JSON.stringify({b,pt,d1,d2,got,exp})); break; } else pass++;
}

console.log(`\ntable settlement: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
