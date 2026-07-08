/**
 * Club Nile — social rooms (Durable Object)
 *
 * One DO instance per room name:
 *   'lobby'          — casino-wide chat (every connected player)
 *   'craps' / 'blackjack' — table presence rooms (max 4 seats each)
 *
 * The rooms are social-only for now: presence, chat, emoji reactions and
 * chip tips are relayed between clients. Game outcomes stay client-side
 * until wallet sign-in lands, at which point buy-ins/payouts move to the
 * Gamble contract flow (commitWager / oracle-signed claimWinnings) and
 * tips become ERC-1155 chip transfers.
 *
 * Protocol (JSON over WebSocket):
 *   client → server: {t:'chat', text} · {t:'emoji', e} · {t:'tip', to, amount}
 *   server → client: {t:'welcome', id, seat, roster, history}
 *                    {t:'join', player} · {t:'leave', id} · {t:'full'}
 *                    {t:'chat', id, name, text} · {t:'emoji', id, e}
 *                    {t:'tip', from, fromName, to, toName, amount}
 */

const MAX_SEATS = 4;
const HISTORY_LIMIT = 40;
const CHAT_COOLDOWN_MS = 700;
const EMOJI_COOLDOWN_MS = 400;

export class ClubNileRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();   // ws -> { id, name, sprite, seat, lastChat, lastEmoji }
    this.nextId = 1;
    this.history = null;         // lazy-loaded chat history (lobby only)
  }

  async loadHistory() {
    if (this.history === null) {
      this.history = (await this.state.storage.get('history')) || [];
    }
  }

  roster(exceptId) {
    return [...this.sessions.values()]
      .filter(s => s.id !== exceptId)
      .map(s => ({ id: s.id, name: s.name, sprite: s.sprite, seat: s.seat }));
  }

  broadcast(obj, exceptWs) {
    const raw = JSON.stringify(obj);
    for (const ws of this.sessions.keys()) {
      if (ws === exceptWs) continue;
      try { ws.send(raw); } catch (e) { /* dead socket, close handler cleans up */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Plain GET → occupancy info (handy for a future "tables" screen)
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response(JSON.stringify({ players: this.sessions.size }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await this.loadHistory();
    const room = (url.searchParams.get('room') || 'lobby').slice(0, 24);
    const isTable = room !== 'lobby';
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

    server.send(JSON.stringify({
      t: 'welcome',
      id: sess.id,
      seat,
      roster: this.roster(sess.id),
      history: isTable ? [] : this.history.slice(-30)
    }));
    this.broadcast({ t: 'join', player: { id: sess.id, name: sess.name, sprite: sess.sprite, seat: sess.seat } }, server);

    server.addEventListener('message', evt => this.onMessage(server, evt));
    const bye = () => {
      const s = this.sessions.get(server);
      if (!s) return;
      this.sessions.delete(server);
      this.broadcast({ t: 'leave', id: s.id });
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
      this.broadcast({ t: 'chat', id: sess.id, name: sess.name, text });   // echo to sender too
    }
    else if (msg.t === 'emoji') {
      if (now - sess.lastEmoji < EMOJI_COOLDOWN_MS) return;
      sess.lastEmoji = now;
      const e = String(msg.e || '').slice(0, 8);
      if (!e) return;
      this.broadcast({ t: 'emoji', id: sess.id, e }, ws);                  // sender pops it locally
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
      }, ws);                                                              // sender already settled locally
    }
  }
}
