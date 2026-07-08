/**
 * Club Nile — social rooms + shared craps clock (Durable Object)
 *
 * One DO instance per room name:
 *   'lobby'      — casino-wide chat (every connected player)
 *   'craps'      — table presence + SERVER-AUTHORITATIVE shared dice
 *   'blackjack'  — table presence (hands are per-player vs the dealer)
 *
 * Craps game clock (server-driven, so gameplay continues no matter what
 * any single client does — disconnects, tab closes, idle players):
 *   betting (15s) → action (10s: shooter may roll; auto-roll on timeout)
 *   → dice broadcast → outcome (5s) → betting ...
 *   Shooter = first seated player; rotates on seven-out; passes to the
 *   next seated player if the shooter leaves; table resets when empty.
 *
 * Chips stay client-side until wallet sign-in lands; the server only
 * owns dice, phases and timers. Clients resolve their own bets from the
 * shared dice (deterministic rules), mirroring how buy-ins will move to
 * Gamble.commitWager / oracle-signed claimWinnings later.
 *
 * Protocol (JSON over WebSocket):
 *   client → server: {t:'chat', text} · {t:'emoji', e} · {t:'tip', to, amount}
 *                    {t:'roll'}                    (craps shooter, action phase)
 *   server → client: {t:'welcome', id, seat, roster, history, game}
 *                    {t:'join', player} · {t:'leave', id} · {t:'full'}
 *                    {t:'chat', id, name, text} · {t:'emoji', id, e}
 *                    {t:'tip', from, fromName, to, toName, amount}
 *                    {t:'phase', phase, ms, point, shooter}
 *                    {t:'dice', d:[a,b], point, seven, shooter}
 */

const MAX_SEATS = 4;
const HISTORY_LIMIT = 40;
const CHAT_COOLDOWN_MS = 700;
const EMOJI_COOLDOWN_MS = 400;

const BETTING_MS = 15000;
const ACTION_MS = 10000;
const OUTCOME_MS = 9000;   // covers the long client-side dice reveal (~4.8s) + reading time

export class ClubNileRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();   // ws -> { id, name, sprite, seat, lastChat, lastEmoji }
    this.nextId = 1;
    this.history = null;
    this.room = '';
    this.game = null;            // craps only: { phase, point, shooter, deadline, timer }
  }

  async loadHistory() {
    if (this.history === null) {
      this.history = (await this.state.storage.get('history')) || [];
    }
  }

  isCraps() { return this.room === 'craps'; }

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

  /* ── craps game clock ─────────────────────────────────────────────── */
  ensureGame() {
    if (!this.game) this.game = { phase: 'idle', point: 0, shooter: null, deadline: 0, timer: null };
  }
  gameSnapshot() {
    if (!this.isCraps()) return null;
    this.ensureGame();
    return {
      phase: this.game.phase,
      ms: Math.max(0, this.game.deadline - Date.now()),
      point: this.game.point,
      shooter: this.game.shooter
    };
  }
  seatedBySeat() {
    return [...this.sessions.values()].sort((a, b) => a.seat - b.seat);
  }
  startPhase(phase, ms) {
    this.ensureGame();
    if (this.game.timer) clearTimeout(this.game.timer);
    this.game.phase = phase;
    this.game.deadline = Date.now() + ms;
    this.game.timer = setTimeout(() => this.phaseExpired(), ms);
    this.broadcast({ t: 'phase', phase, ms, point: this.game.point, shooter: this.game.shooter });
  }
  phaseExpired() {
    if (!this.game) return;
    if (this.sessions.size === 0) { this.resetGame(); return; }
    if (this.game.phase === 'betting') this.startPhase('action', ACTION_MS);
    else if (this.game.phase === 'action') this.doRoll();       // shooter slept — table rolls
    else if (this.game.phase === 'outcome') this.startPhase('betting', BETTING_MS);
  }
  doRoll() {
    if (!this.game) return;
    if (this.game.timer) clearTimeout(this.game.timer);
    const buf = new Uint8Array(2);
    crypto.getRandomValues(buf);
    const d1 = (buf[0] % 6) + 1, d2 = (buf[1] % 6) + 1;
    const sum = d1 + d2;
    let seven = false;
    if (this.game.point === 0) {
      if (![2, 3, 7, 11, 12].includes(sum)) this.game.point = sum;
    } else if (sum === this.game.point) {
      this.game.point = 0;                                      // point hit, shooter keeps dice
    } else if (sum === 7) {
      this.game.point = 0;
      seven = true;
      this.rotateShooter();
    }
    this.broadcast({ t: 'dice', d: [d1, d2], point: this.game.point, seven, shooter: this.game.shooter });
    this.startPhase('outcome', OUTCOME_MS);
  }
  rotateShooter() {
    const seated = this.seatedBySeat();
    if (!seated.length) { this.game.shooter = null; return; }
    const idx = seated.findIndex(s => s.id === this.game.shooter);
    this.game.shooter = seated[(idx + 1) % seated.length].id;
  }
  resetGame() {
    if (this.game && this.game.timer) clearTimeout(this.game.timer);
    this.game = { phase: 'idle', point: 0, shooter: null, deadline: 0, timer: null };
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

    const sess = { id: 'p' + (this.nextId++), name, sprite, seat, lastChat: 0, lastEmoji: 0 };
    this.sessions.set(server, sess);

    /* first player at the craps table starts the clock and holds the dice */
    if (this.isCraps()) {
      this.ensureGame();
      if (this.game.phase === 'idle') {
        this.game.shooter = sess.id;
        this.game.point = 0;
        this.startPhase('betting', BETTING_MS);
      }
    }

    server.send(JSON.stringify({
      t: 'welcome',
      id: sess.id,
      seat,
      roster: this.roster(sess.id),
      history: isTable ? [] : this.history.slice(-30),
      game: this.gameSnapshot()
    }));
    this.broadcast({ t: 'join', player: { id: sess.id, name: sess.name, sprite: sess.sprite, seat: sess.seat } }, server);

    server.addEventListener('message', evt => this.onMessage(server, evt));
    const bye = () => {
      const s = this.sessions.get(server);
      if (!s) return;
      this.sessions.delete(server);
      this.broadcast({ t: 'leave', id: s.id });
      /* failsafes: table keeps playing without them */
      if (this.isCraps() && this.game) {
        if (this.sessions.size === 0) {
          this.resetGame();
        } else if (this.game.shooter === s.id) {
          this.rotateShooter();
          if (this.game.phase === 'action') this.startPhase('action', ACTION_MS);
          else this.broadcast({
            t: 'phase',
            phase: this.game.phase,
            ms: Math.max(0, this.game.deadline - Date.now()),
            point: this.game.point,
            shooter: this.game.shooter
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
    else if (msg.t === 'roll') {
      if (this.isCraps() && this.game &&
          this.game.phase === 'action' && this.game.shooter === sess.id) {
        this.doRoll();
      }
    }
  }
}
