/**
 * CrapsTable — Durable Object with Hibernation WebSocket API
 *
 * One instance per table (e.g. "public-1", "priv-ABC123").
 * Handles: player presence, state broadcasting, chat, shooter rotation.
 * Game logic (roll, bet, cashout) stays in the main Worker REST endpoints.
 *
 * WebSocket messages IN (from client):
 *   { type: 'state',       bets, comeBets, stack }       — player state update
 *   { type: 'rolling' }                                   — shooter started roll animation
 *   { type: 'roll-result', dice, phase, point, total, resolution, message }
 *   { type: 'chat',        text }                         — chat message
 *   { type: 'pass-dice' }                                 — shooter passes dice
 *
 * WebSocket messages OUT (to client):
 *   { type: 'init',        players, shooter }              — sent on connect
 *   { type: 'join',        playerId, name, chadId }        — new player joined
 *   { type: 'leave',       playerId }                      — player left
 *   { type: 'state',       playerId, bets, comeBets, stack }
 *   { type: 'rolling',     playerId, name }                — dice spinning
 *   { type: 'roll-result', playerId, name, dice, phase, point, total, resolution, message }
 *   { type: 'chat',        playerId, name, text }
 *   { type: 'shooter',     playerId }                      — new shooter assigned
 *   { type: 'error',       message }
 *   { type: 'full' }                                       — table is full (before close)
 */

const MAX_PLAYERS = 4;

export class CrapsTable {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /**
   * HTTP fetch handler — two paths:
   *   GET /info       → returns { count, players } (used by /tables/list)
   *   WebSocket upgrade → accepts player connection
   */
  async fetch(request) {
    const url = new URL(request.url);

    // ── Info endpoint (REST, no WebSocket) ──
    if (url.pathname === '/info') {
      const players = this._getPlayerList();
      return new Response(JSON.stringify({ count: players.length, players }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Last-roll endpoint (used by /craps/apply-roll to verify dice) ──
    if (url.pathname === '/last-roll') {
      const lastRoll = await this.state.storage.get('lastRoll');
      return new Response(JSON.stringify(lastRoll || null), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── WebSocket upgrade ──
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const playerId = url.searchParams.get('playerId');
    const name     = url.searchParams.get('name') || 'Unknown';
    const chadId   = Number(url.searchParams.get('chadId')) || 0;

    if (!playerId) {
      return new Response('Missing playerId', { status: 400 });
    }

    // Enforce player cap
    const currentSockets = this.state.getWebSockets();
    // Check if this player already has a connection (reconnect)
    let existingSocket = null;
    for (const ws of currentSockets) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.playerId === playerId) { existingSocket = ws; break; }
      } catch (_) {}
    }
    if (!existingSocket && currentSockets.length >= MAX_PLAYERS) {
      // Return a WebSocket that immediately sends 'full' and closes
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify({ type: 'full' }));
      server.close(4001, 'Table is full');
      return new Response(null, { status: 101, webSocket: client });
    }

    // Preserve state from old connection if reconnecting
    let prevState = null;
    if (existingSocket) {
      try { prevState = existingSocket.deserializeAttachment(); } catch (_) {}
      try { existingSocket.close(1000, 'Reconnecting'); } catch (_) {}
    }

    // Accept new WebSocket with Hibernation API
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({
      playerId,
      name: String(name).slice(0, 20),
      chadId,
      stack:    prevState ? prevState.stack    : 0,
      bets:     prevState ? prevState.bets     : {},
      comeBets: prevState ? prevState.comeBets : {},
    });

    // Ensure a shooter exists
    let shooter = await this.state.storage.get('shooter');
    if (!shooter || !this._isPlayerConnected(shooter)) {
      shooter = playerId;
      await this.state.storage.put('shooter', shooter);
    }

    // Send init to the new player
    const players = this._getPlayerList();
    server.send(JSON.stringify({ type: 'init', players, shooter }));

    // Broadcast join to others
    this._broadcast({ type: 'join', playerId, name: String(name).slice(0, 20), chadId }, playerId);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Hibernation callback — called when a client sends a message.
   * The DO wakes from hibernation, processes the message, then sleeps again.
   */
  async webSocketMessage(ws, msg) {
    let data;
    try { data = JSON.parse(msg); } catch (_) { return; }

    const attachment = ws.deserializeAttachment();
    if (!attachment) return;
    const { playerId, name } = attachment;

    switch (data.type) {

      case 'state': {
        // Player updated bets/stack
        if (data.stack !== undefined) attachment.stack = Number(data.stack) || 0;
        if (data.bets) attachment.bets = data.bets;
        if (data.comeBets) attachment.comeBets = data.comeBets;
        ws.serializeAttachment(attachment);
        this._broadcast({
          type: 'state', playerId,
          name, chadId: attachment.chadId,
          stack: attachment.stack,
          bets: attachment.bets,
          comeBets: attachment.comeBets,
        }, playerId);
        break;
      }

      case 'rolling': {
        // Only the shooter can broadcast rolling
        const shooterRolling = await this.state.storage.get('shooter');
        if (playerId !== shooterRolling) break;
        this._broadcast({ type: 'rolling', playerId, name }, null);
        break;
      }

      case 'roll-result': {
        // Only the shooter can broadcast roll results
        const shooterResult = await this.state.storage.get('shooter');
        if (playerId !== shooterResult) break;
        // Validate dice are two integers 1-6
        if (!Array.isArray(data.dice) || data.dice.length !== 2) break;
        const d1 = Number(data.dice[0]);
        const d2 = Number(data.dice[1]);
        if (d1 < 1 || d1 > 6 || d2 < 1 || d2 > 6 || !Number.isInteger(d1) || !Number.isInteger(d2)) break;

        // Store the last roll so /craps/apply-roll can verify dice for remote players
        // prePhase/prePoint = table state BEFORE this roll (needed for correct bet resolution)
        // phase/point = table state AFTER this roll resolved
        const rollId = Date.now();
        const prePhase = data.prevPhase === 'point' ? 'point' : 'comeout';
        const prePoint = Number(data.prevPoint) || 0;
        const postPhase = data.phase === 'point' ? 'point' : 'comeout';
        const postPoint = Number(data.point) || 0;

        await this.state.storage.put('lastRoll', {
          rollId,
          dice: [d1, d2],
          total: d1 + d2,
          isHard: d1 === d2,
          prePhase,
          prePoint,
          phase: postPhase,
          point: postPoint,
          shooterId: playerId,
        });

        this._broadcast({
          type: 'roll-result', playerId, name,
          dice:    [d1, d2],
          phase:   postPhase,
          point:   postPoint,
          total:   d1 + d2,
          resolution: data.resolution,
          message: String(data.message || '').slice(0, 80),
          rollId,
        }, null);
        break;
      }

      case 'chat': {
        const text = String(data.text || '').slice(0, 120);
        this._broadcast({ type: 'chat', playerId, name, text }, playerId);
        break;
      }

      case 'pass-dice': {
        // Only the current shooter can pass dice
        const shooterPass = await this.state.storage.get('shooter');
        if (playerId !== shooterPass) break;
        await this._advanceShooter(playerId);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Hibernation callback — WebSocket closed.
   */
  async webSocketClose(ws, code, reason, wasClean) {
    await this._handleDisconnect(ws);
  }

  /**
   * Hibernation callback — WebSocket error.
   */
  async webSocketError(ws) {
    await this._handleDisconnect(ws);
  }

  // ── Internal helpers ──

  async _handleDisconnect(ws) {
    let playerId = null;
    try {
      const att = ws.deserializeAttachment();
      if (att) playerId = att.playerId;
    } catch (_) {}

    if (!playerId) return;

    this._broadcast({ type: 'leave', playerId }, playerId);

    // If the shooter left, rotate
    const shooter = await this.state.storage.get('shooter');
    if (shooter === playerId) {
      await this._advanceShooter(playerId);
    }
  }

  _broadcast(data, excludePlayerId) {
    const msg = JSON.stringify(data);
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (excludePlayerId && att && att.playerId === excludePlayerId) continue;
        ws.send(msg);
      } catch (_) {
        // Socket dead — will be cleaned up by webSocketClose/Error
      }
    }
  }

  _getPlayerList() {
    const players = [];
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (att) {
          players.push({
            playerId: att.playerId,
            name:     att.name,
            chadId:   att.chadId,
            stack:    att.stack || 0,
            bets:     att.bets || {},
            comeBets: att.comeBets || {},
          });
        }
      } catch (_) {}
    }
    return players;
  }

  _isPlayerConnected(playerId) {
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.playerId === playerId) return true;
      } catch (_) {}
    }
    return false;
  }

  async _advanceShooter(currentShooterId) {
    const sockets = this.state.getWebSockets();
    const playerIds = [];
    for (const ws of sockets) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.playerId !== currentShooterId) playerIds.push(att.playerId);
      } catch (_) {}
    }

    if (playerIds.length === 0) {
      await this.state.storage.delete('shooter');
      return;
    }

    // Pick next player (first one that isn't the current shooter)
    const nextShooter = playerIds[0];
    await this.state.storage.put('shooter', nextShooter);
    this._broadcast({ type: 'shooter', playerId: nextShooter }, null);
  }
}
