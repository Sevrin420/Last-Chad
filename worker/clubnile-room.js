/**
 * Club Nile — social rooms + SHARED table games (Durable Object)
 *
 * One DO instance per room name:
 *   'lobby'      — casino-wide chat (every connected player)
 *   'craps'      — table presence + server-authoritative shared DICE
 *   'roulette'   — table presence + server-authoritative shared WHEEL
 *   'blackjack'  — table presence + server-authoritative shared DEALER
 *
 * Every table game is server-driven so play continues no matter what any
 * single client does (disconnects, tab closes, idle players). The server
 * owns the random OUTCOME and the clock; each client keeps its own chips
 * and resolves its own bets/hand against the shared outcome — exactly how
 * this will map onto Gamble.commitWager / oracle-signed claimWinnings.
 *
 *   craps:     betting(15s) → action(10s: shooter may roll; auto-roll on
 *              timeout) → dice broadcast → outcome(9s) → betting …
 *   roulette:  betting(15s) → server spins one shared number → outcome(7s)
 *              → betting … (no shooter; the wheel is on the table clock)
 *   blackjack: betting(15s) → server deals a shared dealer up-card, players
 *              play their own hands → action(15s) → server plays the shared
 *              dealer to 17 → outcome(7s) → betting …
 *
 * Protocol (JSON over WebSocket):
 *   client → server: {t:'chat', text} · {t:'emoji', e} · {t:'tip', to, amount}
 *                    {t:'song', file, title, by}          (jukebox — lobby room)
 *                    {t:'roll'}                          (craps shooter, action)
 *   server → client: {t:'welcome', id, seat, roster, history, game}
 *                    {t:'join', player} · {t:'leave', id} · {t:'full'}
 *                    {t:'chat', id, name, text} · {t:'emoji', id, e} · {t:'tip', …}
 *                    {t:'song', id, name, file, title, by}  (whole-casino jukebox)
 *                    {t:'phase', phase, ms, …}      (per-game extra fields)
 *                    {t:'dice', d:[a,b], point, seven, shooter}   (craps)
 *                    {t:'spin', n}                                (roulette)
 *   blackjack rides on {t:'phase'}: the 'action' phase carries the dealer
 *   up-card (up), the 'outcome' phase carries the full dealer hand (dealer).
 */

const MAX_SEATS = 4;
const HISTORY_LIMIT = 40;
const CHAT_COOLDOWN_MS = 700;
const EMOJI_COOLDOWN_MS = 400;
const SONG_COOLDOWN_MS = 3000;   // one jukebox request per player every few seconds

const BETTING_MS = 15000;
const CRAPS_ACTION_MS = 10000;
const CRAPS_OUTCOME_MS = 9000;   // covers the long client-side dice reveal (~4.8s) + reading
const ROU_OUTCOME_MS = 7000;     // covers the client-side wheel spin (~4s) + reading
const BJ_ACTION_MS = 15000;      // blackjack decision window
const BJ_OUTCOME_MS = 7000;      // blackjack result hold

const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

// ── Server-authoritative roulette settlement ──────────────────────────────
// Legal bet keys: straights n0..n36 + the outside bets. Mirrors the client.
const ROU_OUTSIDE = new Set(['red','black','odd','even','low','high','d1','d2','d3','c1','c2','c3']);
function rouBetKeyValid(k) {
  if (ROU_OUTSIDE.has(k)) return true;
  if (typeof k === 'string' && k[0] === 'n') {
    const v = Number(k.slice(1));
    return Number.isInteger(v) && v >= 0 && v <= 36;
  }
  return false;
}
const ROU_MAX_BET = 1_000_000;   // per-spot sanity cap

// Legal craps bet keys: pass, field, place p4..p10, hardways h4/h6/h8/h10.
const CR_BET_KEYS = new Set(['pass', 'field', 'p4', 'p5', 'p6', 'p8', 'p9', 'p10', 'h4', 'h6', 'h8', 'h10']);

// Pure resolver — MUST match the client's rouResolve payout math exactly.
// `bets` maps bet key → staked amount (stakes already deducted from the stack
// when placed). Returns the amount to CREDIT back to the stack: stake+winnings
// on winning bets, 0 on losers. `profit` is winnings above stake (for display).
export function resolveRoulette(bets, n) {
  let returned = 0, profit = 0;
  if (!bets) return { returned, profit };
  const red = RED.has(n);
  const pay = (amt, mult) => { returned += amt * (mult + 1); profit += amt * mult; };
  for (let k = 0; k <= 36; k++) { const a = bets['n' + k]; if (a && k === n) pay(a, 35); }
  if (n !== 0) {
    if (bets.red   && red)         pay(bets.red, 1);
    if (bets.black && !red)        pay(bets.black, 1);
    if (bets.odd   && n % 2 === 1) pay(bets.odd, 1);
    if (bets.even  && n % 2 === 0) pay(bets.even, 1);
    if (bets.low   && n <= 18)     pay(bets.low, 1);
    if (bets.high  && n >= 19)     pay(bets.high, 1);
    const doz = n <= 12 ? 'd1' : n <= 24 ? 'd2' : 'd3';
    if (bets[doz]) pay(bets[doz], 2);
    const col = n % 3 === 0 ? 'c3' : n % 3 === 1 ? 'c1' : 'c2';
    if (bets[col]) pay(bets[col], 2);
  }
  return { returned, profit };
}

// ── Signed money-seat sessions (HMAC over the payload with the oracle key) ──
// A connection may only play with real chips if it presents a token issued by
// the Worker's /cage/session (which checks a wallet signature + a funded cage
// stack). Same algorithm on both sides.
function b64urlStr(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlBytes(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function hmacB64(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return b64urlBytes(new Uint8Array(sig));
}
export async function issueSessionToken(secret, payload) {
  const b64 = b64urlStr(JSON.stringify(payload));
  return b64 + '.' + await hmacB64(secret, b64);
}
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ── Server-authoritative blackjack + craps settlement (pure, mirror client) ──
// Blackjack: final hands + (possibly doubled) bet → chips credited to the stack.
export function resolveBlackjack(playerHand, dealerHand, bet) {
  const pv = bjValue(playerHand), dv = bjValue(dealerHand);
  const natural  = pv === 21 && playerHand.length === 2;
  const dealerBJ = dv === 21 && dealerHand.length === 2;
  if (pv > 21) return 0;                                   // player bust
  if (natural && !dealerBJ) return bet + Math.floor(bet * 1.5);   // blackjack 3:2 (stake back + 1.5x)
  if (dv > 21 || pv > dv) return bet * 2;                  // win (stake back + even)
  if (pv === dv) return bet;                               // push (stake back)
  return 0;                                                // dealer wins
}

// Craps: resolve one roll against a seat's standing bet ledger + shared point.
// Stakes were deducted at placement; standing bets ride, so this returns the
// WINNINGS credited this roll plus the updated ledger + point. Mirrors crResolve.
const CR_PLACE_NUMS = [4, 5, 6, 8, 9, 10];
const CR_HARD_NUMS  = [4, 6, 8, 10];
const CR_PLACE_PAY  = { 4: [9, 5], 5: [7, 5], 6: [7, 6], 8: [7, 6], 9: [7, 5], 10: [9, 5] };
const CR_HARD_PAY   = { 4: 7, 6: 9, 8: 9, 10: 7 };
export function resolveCraps(bets, point, d1, d2) {
  const sum = d1 + d2, hard = d1 === d2;
  const b = { ...bets };
  let credit = 0, seven = false, pt = point;
  if (b.field > 0) {                                       // field: one-roll, always working
    let mult = 0;
    if (sum === 2) mult = 2; else if (sum === 12) mult = 3;
    else if ([3, 4, 9, 10, 11].includes(sum)) mult = 1;
    if (mult > 0) credit += b.field * mult;               // pays; stake rides
    else b.field = 0;                                      // loses; comes down
  }
  if (pt === 0) {                                          // come-out
    if (sum === 7 || sum === 11) { if (b.pass) { credit += b.pass * 2; b.pass = 0; } }
    else if (sum === 2 || sum === 3 || sum === 12) { if (b.pass) b.pass = 0; }
    else pt = sum;                                         // point established
  } else {
    if (sum === 7) {                                       // seven out — everything down
      seven = true; b.pass = 0;
      CR_PLACE_NUMS.forEach(n => b['p' + n] = 0);
      CR_HARD_NUMS.forEach(n => b['h' + n] = 0);
      pt = 0;
    } else {
      if (sum === pt) { if (b.pass) { credit += b.pass * 2; b.pass = 0; } pt = 0; }
      if (b['p' + sum]) { const [a, bb] = CR_PLACE_PAY[sum]; credit += Math.floor(b['p' + sum] * a / bb); }
      if (CR_HARD_NUMS.includes(sum) && b['h' + sum]) {
        if (hard) credit += b['h' + sum] * CR_HARD_PAY[sum];   // hard hit; stays
        else b['h' + sum] = 0;                                 // easy; hard comes down
      }
    }
  }
  return { credit, bets: b, point: pt, seven };
}

function bjValue(hand) {
  let v = 0, aces = 0;
  for (const c of hand) {
    if (c.r === 1) { aces++; v += 11; }
    else v += Math.min(c.r, 10);
  }
  while (v > 21 && aces > 0) { v -= 10; aces--; }
  return v;
}

export class ClubNileRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();   // ws -> { id, name, sprite, seat, lastChat, lastEmoji }
    this.nextId = 1;
    this.history = null;
    this.room = '';
    this.game = null;            // { type, phase, deadline, timer, ...typeState }
  }

  async loadHistory() {
    if (this.history === null) {
      this.history = (await this.state.storage.get('history')) || [];
    }
  }

  gameType() {
    return (this.room === 'craps' || this.room === 'roulette' || this.room === 'blackjack') ? this.room : null;
  }
  isGame() { return this.gameType() !== null; }

  roster(exceptId) {
    return [...this.sessions.values()]
      .filter(s => s.id !== exceptId)
      .map(s => ({ id: s.id, name: s.name, sprite: s.sprite, seat: s.seat }));
  }

  broadcast(obj, exceptWs) {
    const raw = JSON.stringify(obj);
    for (const ws of this.sessions.keys()) {
      if (ws === exceptWs) continue;
      try { ws.send(raw); } catch (e) { /* close handler cleans up */ }
    }
  }

  /* ── money seats: verify the signed session, load/persist the cage stack ── */
  async verifySession(tok) {
    try {
      if (!tok || typeof tok !== 'string' || !this.env.ORACLE_PRIVATE_KEY) return null;
      const dot = tok.indexOf('.');
      if (dot <= 0) return null;
      const b64 = tok.slice(0, dot), sig = tok.slice(dot + 1);
      const expect = await hmacB64(this.env.ORACLE_PRIVATE_KEY, b64);
      if (!timingSafeEq(expect, sig)) return null;
      const p = JSON.parse(decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/')))));
      if (!p || p.tokenId == null || !p.player || !p.exp || Date.now() > p.exp) return null;
      return { tokenId: String(p.tokenId), player: String(p.player).toLowerCase() };
    } catch (e) { return null; }
  }
  async bindStack(sess, tokenId, player) {
    try {
      const rec = await this.env.RUNNER_KV.get('cage:' + tokenId, { type: 'json' });
      if (!rec || rec.pendingCashout) return;                       // no buy-in, or mid-cashout
      if (rec.player && rec.player.toLowerCase() !== player) return; // not this wallet's token
      sess.tokenId = String(tokenId);
      sess.player  = player;
      sess.stack   = rec.stack || 0;
      sess.funded  = true;
    } catch (e) { /* unfunded seat */ }
  }
  async flushStack(sess) {
    if (!sess || !sess.funded || sess.tokenId == null) return;
    try {
      const key = 'cage:' + sess.tokenId;
      const rec = (await this.env.RUNNER_KV.get(key, { type: 'json' })) || { player: sess.player, stack: 0 };
      if (rec.pendingCashout) return;   // a cash-out is in flight — never overwrite / double-credit
      rec.player = sess.player || rec.player;
      rec.stack  = sess.stack;
      await this.env.RUNNER_KV.put(key, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 7 });
    } catch (e) { /* best-effort persist */ }
  }
  rouRefundBets(sess) {
    let r = 0; for (const k in sess.bets) r += sess.bets[k] || 0;
    sess.stack += r; sess.bets = {};
    return r;
  }
  /* leaving craps: come-down bets (place/hard/field, and a come-out pass) are
     returned; a pass bet with the point ON is a contract bet and forfeits, so
     you can't dodge a live loss by disconnecting. */
  crRefundOnLeave(sess) {
    let r = 0;
    for (const k in sess.bets) {
      if (k === 'pass' && this.game && this.game.point !== 0) continue;
      r += sess.bets[k] || 0; sess.bets[k] = 0;
    }
    sess.stack += r;
    return r;
  }

  /* ── shared game engine ───────────────────────────────────────────── */
  ensureGame() {
    if (!this.game) this.game = {
      type: this.gameType(), phase: 'idle', deadline: 0, timer: null,
      point: 0, shooter: null,        // craps
      n: -1,                          // roulette
      up: null, hole: null, dealer: []// blackjack
    };
  }
  drawCard() {
    const buf = new Uint8Array(2); crypto.getRandomValues(buf);
    return { r: (buf[0] % 13) + 1, s: buf[1] % 4 };
  }
  phaseFields(extra) {
    const type = this.gameType(), g = this.game, f = {};
    if (type === 'craps') { f.point = g.point; f.shooter = g.shooter; }
    else if (type === 'roulette') { f.n = g.n; }
    return { ...f, ...(extra || {}) };
  }
  gameSnapshot() {
    const type = this.gameType();
    if (!type) return null;
    this.ensureGame();
    const g = this.game;
    const base = { type, phase: g.phase, ms: Math.max(0, g.deadline - Date.now()) };
    if (type === 'craps') { base.point = g.point; base.shooter = g.shooter; }
    else if (type === 'roulette') { base.n = g.n; }
    else if (type === 'blackjack') {
      if (g.phase === 'action') base.up = g.up;
      if (g.phase === 'outcome') base.dealer = g.dealer;
    }
    return base;
  }
  seatedBySeat() {
    return [...this.sessions.values()].sort((a, b) => a.seat - b.seat);
  }
  startPhase(phase, ms, extra) {
    this.ensureGame();
    if (this.game.timer) clearTimeout(this.game.timer);
    this.game.phase = phase;
    this.game.deadline = Date.now() + ms;
    this.game.timer = setTimeout(() => this.phaseExpired(), ms);
    this.broadcast({ t: 'phase', phase, ms, ...this.phaseFields(extra) });
  }
  startGameIfIdle(sessId) {
    this.ensureGame();
    if (this.game.phase !== 'idle') return;
    if (this.gameType() === 'craps') { this.game.shooter = sessId; this.game.point = 0; }
    this.startPhase('betting', BETTING_MS);
  }
  phaseExpired() {
    if (!this.game) return;
    if (this.sessions.size === 0) { this.resetGame(); return; }
    const type = this.gameType(), phase = this.game.phase;
    if (type === 'craps') {
      if (phase === 'betting') this.startPhase('action', CRAPS_ACTION_MS);
      else if (phase === 'action') this.doRoll();          // shooter slept — table rolls
      else if (phase === 'outcome') this.startPhase('betting', BETTING_MS);
    } else if (type === 'roulette') {
      if (phase === 'betting') this.doSpin();
      else if (phase === 'outcome') this.startPhase('betting', BETTING_MS);
    } else if (type === 'blackjack') {
      if (phase === 'betting') this.dealBlackjack();
      else if (phase === 'action') this.playDealer();
      else if (phase === 'outcome') this.startPhase('betting', BETTING_MS);
    }
  }

  /* craps */
  doRoll() {
    if (!this.game) return;
    if (this.game.timer) clearTimeout(this.game.timer);
    const buf = new Uint8Array(2); crypto.getRandomValues(buf);
    const d1 = (buf[0] % 6) + 1, d2 = (buf[1] % 6) + 1, sum = d1 + d2;
    const pointBefore = this.game.point;                   // resolve money seats against the pre-roll point
    let seven = false;
    if (this.game.point === 0) {
      if (![2, 3, 7, 11, 12].includes(sum)) this.game.point = sum;
    } else if (sum === this.game.point) {
      this.game.point = 0;                                 // point hit, shooter keeps dice
    } else if (sum === 7) {
      this.game.point = 0; seven = true; this.rotateShooter();
    }
    this.broadcast({ t: 'dice', d: [d1, d2], point: this.game.point, seven, shooter: this.game.shooter });
    this.settleCraps(pointBefore, d1, d2);
    this.startPhase('outcome', CRAPS_OUTCOME_MS);
  }
  /* resolve every money seat's standing bets against this roll, credit + persist
     the stack, and send an authoritative settlement. Legacy seats unaffected. */
  settleCraps(pointBefore, d1, d2) {
    for (const [ws, s] of this.sessions) {
      if (!s.funded) continue;
      const { credit, bets, seven } = resolveCraps(s.bets || {}, pointBefore, d1, d2);
      s.stack += credit;
      s.bets = bets;
      this.flushStack(s);
      try { ws.send(JSON.stringify({ t: 'crsettle', d: [d1, d2], credit, stack: s.stack, bets: s.bets, seven })); } catch (e) {}
    }
  }
  rotateShooter() {
    const seated = this.seatedBySeat();
    if (!seated.length) { this.game.shooter = null; return; }
    const idx = seated.findIndex(s => s.id === this.game.shooter);
    this.game.shooter = seated[(idx + 1) % seated.length].id;
  }

  /* roulette */
  doSpin() {
    if (!this.game) return;
    if (this.game.timer) clearTimeout(this.game.timer);
    const buf = new Uint32Array(1); crypto.getRandomValues(buf);
    const n = buf[0] % 37;                                 // 0..36, single-zero wheel
    this.game.n = n;
    this.broadcast({ t: 'spin', n });
    this.settleRoulette(n);
    this.startPhase('outcome', ROU_OUTCOME_MS);
  }
  /* resolve every money seat's bets against the number, update + persist their
     stack, and send each an authoritative settlement. Client-side (legacy)
     seats are untouched — they resolve their own bets as before. */
  settleRoulette(n) {
    for (const [ws, s] of this.sessions) {
      if (!s.funded) continue;
      const { returned, profit } = resolveRoulette(s.bets, n);
      s.stack += returned;
      s.bets = {};
      this.flushStack(s);   // persist to the cage (best-effort; also flushed on leave)
      try { ws.send(JSON.stringify({ t: 'rsettle', n, stack: s.stack, profit })); } catch (e) {}
    }
  }

  /* blackjack — server owns the shared dealer; clients play their own hands */
  dealBlackjack() {
    if (!this.game) return;
    if (this.game.timer) clearTimeout(this.game.timer);
    this.game.up = this.drawCard();
    this.game.hole = this.drawCard();
    this.game.dealer = [this.game.up, this.game.hole];
    this.startPhase('action', BJ_ACTION_MS, { up: this.game.up });
  }
  playDealer() {
    if (!this.game) return;
    if (this.game.timer) clearTimeout(this.game.timer);
    const d = [this.game.up, this.game.hole];
    while (bjValue(d) < 17) d.push(this.drawCard());
    this.game.dealer = d;
    this.startPhase('outcome', BJ_OUTCOME_MS, { dealer: d });
  }

  resetGame() {
    if (this.game && this.game.timer) clearTimeout(this.game.timer);
    this.game = null;
  }

  /* ── connections ──────────────────────────────────────────────────── */
  async fetch(request) {
    const url = new URL(request.url);
    this.room = (url.searchParams.get('room') || 'lobby').slice(0, 24);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response(JSON.stringify({ players: this.sessions.size, game: this.gameSnapshot() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await this.loadHistory();
    const isTable = this.room !== 'lobby';
    const name = (url.searchParams.get('name') || 'CHAD')
      .replace(/[^\w\-#]/g, '').slice(0, 12) || 'CHAD';
    const sprite = Math.abs(parseInt(url.searchParams.get('sprite') || '0', 10) || 0) % 3;
    // Opt-in money seat: a signed session (from /cage/session) binds this
    // connection to a funded NFT stack. Legacy clients omit `auth` and play the
    // classic client-side way — this whole path stays dormant for them.
    const authClaim = await this.verifySession(url.searchParams.get('auth'));

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();

    let seat = -1;
    if (isTable) {
      const taken = new Set([...this.sessions.values()].map(s => s.seat));
      for (let i = 0; i < MAX_SEATS; i++) if (!taken.has(i)) { seat = i; break; }
      if (seat === -1) {
        server.send(JSON.stringify({ t: 'full' }));
        server.close(1000, 'table full');
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    const sess = { id: 'p' + (this.nextId++), name, sprite, seat, lastChat: 0, lastEmoji: 0, lastSong: 0,
                   tokenId: null, player: null, stack: 0, bets: {}, funded: false };
    this.sessions.set(server, sess);
    // load the authoritative cage stack for a verified money seat
    if (authClaim && isTable) await this.bindStack(sess, authClaim.tokenId, authClaim.player);

    /* the first player at a table starts the shared clock */
    if (this.isGame()) this.startGameIfIdle(sess.id);

    server.send(JSON.stringify({
      t: 'welcome',
      id: sess.id,
      seat,
      roster: this.roster(sess.id),
      history: isTable ? [] : this.history.slice(-30),
      game: this.gameSnapshot(),
      funded: sess.funded,
      stack: sess.stack
    }));
    this.broadcast({ t: 'join', player: { id: sess.id, name: sess.name, sprite: sess.sprite, seat: sess.seat } }, server);

    server.addEventListener('message', evt => this.onMessage(server, evt));
    const bye = () => {
      const s = this.sessions.get(server);
      if (!s) return;
      // money seat: refund any un-spun bets and persist the stack before leaving
      if (s.funded) {
        if (this.game && this.gameType() === 'roulette' && this.game.phase === 'betting') this.rouRefundBets(s);
        if (this.gameType() === 'craps') this.crRefundOnLeave(s);
        this.flushStack(s);
      }
      this.sessions.delete(server);
      this.broadcast({ t: 'leave', id: s.id });
      /* failsafes: the table keeps playing without them */
      if (this.isGame() && this.game) {
        if (this.sessions.size === 0) {
          this.resetGame();
        } else if (this.gameType() === 'craps' && this.game.shooter === s.id) {
          this.rotateShooter();
          if (this.game.phase === 'action') this.startPhase('action', CRAPS_ACTION_MS);
          else this.broadcast({
            t: 'phase', phase: this.game.phase,
            ms: Math.max(0, this.game.deadline - Date.now()),
            point: this.game.point, shooter: this.game.shooter
          });
        }
      }
    };
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, evt) {
    const sess = this.sessions.get(ws);
    if (!sess) return;
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    const now = Date.now();

    if (msg.t === 'chat') {
      if (now - sess.lastChat < CHAT_COOLDOWN_MS) return;
      sess.lastChat = now;
      const text = String(msg.text || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80).trim();
      if (!text) return;
      this.history.push({ name: sess.name, text });
      if (this.history.length > HISTORY_LIMIT) this.history = this.history.slice(-HISTORY_LIMIT);
      this.state.storage.put('history', this.history);
      this.broadcast({ t: 'chat', id: sess.id, name: sess.name, text });
    }
    else if (msg.t === 'emoji') {
      if (now - sess.lastEmoji < EMOJI_COOLDOWN_MS) return;
      sess.lastEmoji = now;
      const e = String(msg.e || '').slice(0, 8);
      if (!e) return;
      this.broadcast({ t: 'emoji', id: sess.id, e }, ws);
    }
    else if (msg.t === 'tip') {
      const amount = Math.floor(Number(msg.amount));
      if (!(amount >= 1 && amount <= 10000)) return;
      const target = [...this.sessions.values()].find(s => s.id === msg.to);
      if (!target || target.id === sess.id) return;
      this.broadcast({
        t: 'tip',
        from: sess.id, fromName: sess.name,
        to: target.id, toName: target.name,
        amount
      }, ws);
    }
    else if (msg.t === 'song') {
      // a jukebox request: relay the picked track to everyone else in the
      // casino so the whole house plays it together. The requester already
      // started it locally, so exclude them from the broadcast.
      if (now - sess.lastSong < SONG_COOLDOWN_MS) return;
      sess.lastSong = now;
      const file = String(msg.file || '').replace(/[^\w./-]/g, '').slice(0, 80);
      if (!file) return;
      const title = String(msg.title || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40);
      const by = String(msg.by || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40);
      this.broadcast({ t: 'song', id: sess.id, name: sess.name, file, title, by }, ws);
    }
    else if (msg.t === 'rbet') {
      // place a roulette bet against the server-held stack (money seats only)
      if (this.gameType() !== 'roulette' || !sess.funded) return;
      if (!this.game || this.game.phase !== 'betting') return;   // bets only while betting is open
      const spot = String(msg.spot || '');
      const amount = Math.floor(Number(msg.amount));
      if (!rouBetKeyValid(spot)) return;
      if (!(amount >= 1 && amount <= ROU_MAX_BET)) return;
      if ((sess.stack || 0) < amount) { try { ws.send(JSON.stringify({ t: 'rbal', stack: sess.stack, bets: sess.bets, err: 'insufficient' })); } catch (e) {} return; }
      sess.bets[spot] = (sess.bets[spot] || 0) + amount;
      sess.stack -= amount;
      try { ws.send(JSON.stringify({ t: 'rbal', stack: sess.stack, bets: sess.bets })); } catch (e) {}
    }
    else if (msg.t === 'rclear') {
      // take every un-spun bet back down (money seats only)
      if (this.gameType() !== 'roulette' || !sess.funded) return;
      if (!this.game || this.game.phase !== 'betting') return;
      this.rouRefundBets(sess);
      try { ws.send(JSON.stringify({ t: 'rbal', stack: sess.stack, bets: sess.bets })); } catch (e) {}
    }
    else if (msg.t === 'crbet') {
      // place a craps bet against the server-held stack (money seats only)
      if (this.gameType() !== 'craps' || !sess.funded) return;
      if (!this.game || this.game.phase !== 'betting') return;
      const spot = String(msg.spot || '');
      const amount = Math.floor(Number(msg.amount));
      if (!CR_BET_KEYS.has(spot)) return;
      if (spot === 'pass' && this.game.point !== 0) { try { ws.send(JSON.stringify({ t: 'crbal', stack: sess.stack, bets: sess.bets, err: 'point is on' })); } catch (e) {} return; }
      if (!(amount >= 1 && amount <= ROU_MAX_BET)) return;
      if ((sess.stack || 0) < amount) { try { ws.send(JSON.stringify({ t: 'crbal', stack: sess.stack, bets: sess.bets, err: 'insufficient' })); } catch (e) {} return; }
      sess.bets[spot] = (sess.bets[spot] || 0) + amount;
      sess.stack -= amount;
      try { ws.send(JSON.stringify({ t: 'crbal', stack: sess.stack, bets: sess.bets })); } catch (e) {}
    }
    else if (msg.t === 'crclear') {
      // take down every bet that's allowed to come down (not a live pass on a point)
      if (this.gameType() !== 'craps' || !sess.funded) return;
      if (!this.game || this.game.phase !== 'betting') return;
      let r = 0;
      for (const k in sess.bets) {
        if (k === 'pass' && this.game.point !== 0) continue;   // contract bet with the point on stays up
        r += sess.bets[k] || 0; sess.bets[k] = 0;
      }
      sess.stack += r;
      try { ws.send(JSON.stringify({ t: 'crbal', stack: sess.stack, bets: sess.bets })); } catch (e) {}
    }
    else if (msg.t === 'roll') {
      if (this.gameType() === 'craps' && this.game &&
          this.game.phase === 'action' && this.game.shooter === sess.id) {
        this.doRoll();
      }
    }
  }
}
