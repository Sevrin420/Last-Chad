/**
 * CrapsTable — Durable Object with Hibernation WebSocket API
 *
 * One instance per table (e.g. "public-1", "priv-ABC123").
 * ALL game logic lives here — bets, dice, resolution, state.
 * The main Worker only handles on-chain verification (/craps/start)
 * and cashout signing (/craps/cashout).
 *
 * ── REST endpoints (called by Worker only) ──
 *   GET  /info                                → { count, players }
 *   POST /register   { nonce, ... }           → register verified player
 *   POST /cashout    { nonce, sessionToken }   → return player state + remove
 *
 * ── WebSocket messages IN (from client) ──
 *   { type: 'auth',       nonce, sessionToken }
 *   { type: 'bet',        zone, amount }
 *   { type: 'clear-bets' }
 *   { type: 'roll' }
 *   { type: 'press',      zone }
 *   { type: 'pass-dice' }
 *   { type: 'chat',       text }
 *
 * ── WebSocket messages OUT (to client) ──
 *   { type: 'init',        players, shooter, game }
 *   { type: 'auth-ok',     stack, bets, comeBets, phase, point }
 *   { type: 'join',        playerId, name, chadId }
 *   { type: 'leave',       playerId }
 *   { type: 'bet-ok',      stack, bets, comeBets }
 *   { type: 'bet-rejected', reason }
 *   { type: 'state',       playerId, name, chadId, bets, comeBets, stack }
 *   { type: 'rolling',     playerId, name }
 *   { type: 'roll-result', dice, total, phase, point, resolution, stack,
 *                           bets, comeBets, pressOptions }
 *   { type: 'shooter',     playerId }
 *   { type: 'chat',        playerId, name, text }
 *   { type: 'error',       message }
 *   { type: 'full' }
 */

const MAX_PLAYERS = 4;

// Valid bet zones
const VALID_BET_ZONES = new Set([
  'pass', 'field', 'come', 'passOdds',
  'place4', 'place5', 'place6', 'place8', 'place9', 'place10',
  'hard4', 'hard6', 'hard8', 'hard10',
  'comeOdds4', 'comeOdds5', 'comeOdds6', 'comeOdds8', 'comeOdds9', 'comeOdds10',
]);

export class CrapsTable {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  HTTP fetch handler
  // ═══════════════════════════════════════════════════════════════════════

  async fetch(request) {
    const url = new URL(request.url);

    // ── Info (GET) — player count for /tables/list ──
    if (url.pathname === '/info') {
      const players = this._getPlayerList();
      return new Response(JSON.stringify({ count: players.length, players }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Register (POST) — Worker registers a verified player ──
    if (url.pathname === '/register' && request.method === 'POST') {
      const body = await request.json();
      return await this._handleRegister(body);
    }

    // ── Cashout (POST) — Worker requests player state for signing ──
    if (url.pathname === '/cashout' && request.method === 'POST') {
      const body = await request.json();
      return await this._handleCashout(body);
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

    // ── Purge ALL sockets that aren't this player ──
    // Hibernation API retains dead sockets (even authenticated ones)
    // after unclean disconnects. Socket state is unreliable for
    // detecting who's actually alive. Real players auto-reconnect
    // within 2 seconds, so purging is safe.
    const currentSockets = this.state.getWebSockets();
    let existingSocket = null;
    for (const ws of currentSockets) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.playerId === playerId) {
          existingSocket = ws;
        } else {
          try { ws.close(1000, 'Table reset'); } catch (_) {}
        }
      } catch (_) { try { ws.close(1011, 'Stale'); } catch (_e) {} }
    }

    // Enforce player cap (check post-purge sockets)
    const remainingSockets = this.state.getWebSockets();
    const otherLive = remainingSockets.filter(w => {
      try { const a = w.deserializeAttachment(); return a && a.playerId !== playerId; }
      catch (_) { return false; }
    }).length;
    if (!existingSocket && otherLive >= MAX_PLAYERS) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify({ type: 'full' }));
      server.close(4001, 'Table is full');
      return new Response(null, { status: 101, webSocket: client });
    }

    // Close old socket on reconnect
    if (existingSocket) {
      try { existingSocket.close(1000, 'Reconnecting'); } catch (_) {}
    }

    // Accept with Hibernation API
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({
      playerId,
      name: String(name).slice(0, 20),
      chadId,
      nonce: null,       // set after auth
      authenticated: false,
    });

    // Ensure a shooter exists
    let shooter = await this.state.storage.get('shooter');
    if (!shooter || !this._isPlayerConnected(shooter)) {
      shooter = playerId;
      await this.state.storage.put('shooter', shooter);
    }

    // Determine if the table is stale and should reset.
    // Socket state is unreliable (Hibernation retains dead sockets),
    // so we use a timestamp: if no roll in 2+ minutes, game is stale.
    const tableStale = await this._isTableStale();
    if (tableStale) {
      await this.state.storage.put('game', {
        phase: 'comeout', point: 0, rolling: false, rollCount: 0,
      });
      // Clean up any orphaned player data from previous sessions
      await this._cleanupOrphanedPlayers();
    }

    // Send init with current game state
    const game = await this._getGame();
    const players = await this._getPlayerListPublic();
    server.send(JSON.stringify({ type: 'init', players, shooter, game }));

    // Broadcast join to others
    this._broadcast({ type: 'join', playerId, name: String(name).slice(0, 20), chadId }, playerId);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  WebSocket message handler (Hibernation callback)
  // ═══════════════════════════════════════════════════════════════════════

  async webSocketMessage(ws, msg) {
    let data;
    try { data = JSON.parse(msg); } catch (_) { return; }

    const attachment = ws.deserializeAttachment();
    if (!attachment) return;
    const { playerId, name } = attachment;

    switch (data.type) {

      // ── Auth: link WS connection to registered player ──
      case 'auth': {
        const nonce = data.nonce;
        const token = data.sessionToken;
        if (!nonce || !token) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing nonce or sessionToken' }));
          break;
        }

        let playerData = await this.state.storage.get(`player:${nonce}`);

        // Self-register if not pre-registered (player picked table after /craps/start)
        if (!playerData) {
          // Verify the session token via HMAC before trusting client-supplied data
          const verified = await this._verifySessionToken(nonce, data.player, token);
          if (!verified) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid session token' }));
            break;
          }
          if (!data.stack || !data.player || !data.tokenId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing session data for registration' }));
            break;
          }
          playerData = {
            tokenId:  String(data.tokenId),
            player:   String(data.player).toLowerCase(),
            stack:    Number(data.stack) || 0,
            bets:     {},
            comeBets: {},
            comeOdds: {},
            buyIn:    Number(data.buyIn) || Number(data.stack) || 0,
            _expectedToken: token,
          };
          await this.state.storage.put(`player:${nonce}`, playerData);
        } else if (playerData._expectedToken !== token) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session token' }));
          break;
        }

        // Link this WS connection to the player data
        attachment.nonce = String(nonce);
        attachment.authenticated = true;
        ws.serializeAttachment(attachment);

        // Safety: if the table was stale (no activity in 2+ min), force comeout.
        // Check BEFORE recording activity so the timestamp reflects prior state.
        const game = await this._getGame();
        if (!game.rolling && game.phase !== 'comeout') {
          const tableStale = await this._isTableStale();
          if (tableStale) {
            game.phase = 'comeout';
            game.point = 0;
            await this.state.storage.put('game', game);
          }
        }

        // Record activity — this player is definitely alive
        await this.state.storage.put('lastActivity', Date.now());

        // Send current state back
        ws.send(JSON.stringify({
          type: 'auth-ok',
          stack:    playerData.stack,
          bets:     playerData.bets,
          comeBets: playerData.comeBets,
          comeOdds: playerData.comeOdds,
          phase:    game.phase,
          point:    game.point,
        }));

        // Broadcast updated state to others
        this._broadcast({
          type: 'state', playerId, name, chadId: attachment.chadId,
          stack: playerData.stack,
          bets: playerData.bets,
          comeBets: playerData.comeBets,
        }, playerId);
        break;
      }

      // ── Bet: validate and place (server-authoritative) ──
      case 'bet': {
        if (!attachment.authenticated || !attachment.nonce) {
          ws.send(JSON.stringify({ type: 'bet-rejected', reason: 'Not authenticated' }));
          break;
        }
        const pData = await this.state.storage.get(`player:${attachment.nonce}`);
        if (!pData) break;
        const game = await this._getGame();

        const zone = data.zone;
        const amount = Math.max(0, Math.floor(Number(data.amount) || 0));
        if (!VALID_BET_ZONES.has(zone) || amount <= 0) {
          ws.send(JSON.stringify({ type: 'bet-rejected', reason: 'Invalid bet' }));
          break;
        }
        if (amount > pData.stack) {
          ws.send(JSON.stringify({ type: 'bet-rejected', reason: 'Insufficient stack' }));
          break;
        }

        // Phase rules
        const phaseError = this._validateBetPhase(zone, game.phase, pData);
        if (phaseError) {
          ws.send(JSON.stringify({ type: 'bet-rejected', reason: phaseError }));
          break;
        }

        // Apply bet
        if (zone.startsWith('comeOdds')) {
          const num = zone.replace('comeOdds', '');
          pData.stack -= amount;
          if (!pData.comeOdds) pData.comeOdds = {};
          pData.comeOdds[num] = (pData.comeOdds[num] || 0) + amount;
        } else {
          pData.stack -= amount;
          pData.bets[zone] = (pData.bets[zone] || 0) + amount;
        }

        await this.state.storage.put(`player:${attachment.nonce}`, pData);
        await this.state.storage.put('lastActivity', Date.now());

        ws.send(JSON.stringify({
          type: 'bet-ok',
          stack: pData.stack,
          bets: pData.bets,
          comeBets: pData.comeBets,
          comeOdds: pData.comeOdds,
        }));

        // Broadcast visual state to others
        this._broadcast({
          type: 'state', playerId, name, chadId: attachment.chadId,
          stack: pData.stack,
          bets: pData.bets,
          comeBets: pData.comeBets,
        }, playerId);
        break;
      }

      // ── Clear bets: return all pending bets to stack ──
      case 'clear-bets': {
        if (!attachment.authenticated || !attachment.nonce) break;
        const pClear = await this.state.storage.get(`player:${attachment.nonce}`);
        if (!pClear) break;

        // Return all bets to stack
        for (const val of Object.values(pClear.bets || {})) pClear.stack += val;
        for (const val of Object.values(pClear.comeBets || {})) pClear.stack += val;
        for (const val of Object.values(pClear.comeOdds || {})) pClear.stack += val;
        pClear.bets = {};
        pClear.comeBets = {};
        pClear.comeOdds = {};

        await this.state.storage.put(`player:${attachment.nonce}`, pClear);
        ws.send(JSON.stringify({
          type: 'bet-ok',
          stack: pClear.stack,
          bets: pClear.bets,
          comeBets: pClear.comeBets,
          comeOdds: pClear.comeOdds,
        }));
        this._broadcast({
          type: 'state', playerId, name, chadId: attachment.chadId,
          stack: pClear.stack, bets: {}, comeBets: {},
        }, playerId);
        break;
      }

      // ── Roll: only shooter, generates dice, resolves ALL players ──
      case 'roll': {
        const shooter = await this.state.storage.get('shooter');
        if (playerId !== shooter) {
          ws.send(JSON.stringify({ type: 'error', message: 'Only the shooter can roll' }));
          break;
        }
        if (!attachment.authenticated || !attachment.nonce) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
          break;
        }

        const game = await this._getGame();

        // Prevent concurrent rolls
        if (game.rolling) {
          ws.send(JSON.stringify({ type: 'error', message: 'Roll in progress' }));
          break;
        }

        // Shooter must have at least one bet
        const shooterData = await this.state.storage.get(`player:${attachment.nonce}`);
        if (!shooterData) break;
        const shooterTotalBets = Object.values(shooterData.bets || {}).reduce((s, v) => s + v, 0)
          + Object.values(shooterData.comeBets || {}).reduce((s, v) => s + v, 0);
        if (shooterTotalBets === 0) {
          ws.send(JSON.stringify({ type: 'error', message: 'Place a bet first' }));
          break;
        }

        // Lock rolling & record activity
        game.rolling = true;
        await this.state.storage.put('game', game);
        await this.state.storage.put('lastActivity', Date.now());

        // ── Generate dice (server-side, crypto-secure) ──
        const arr = new Uint32Array(2);
        crypto.getRandomValues(arr);
        const d1 = (arr[0] % 6) + 1;
        const d2 = (arr[1] % 6) + 1;
        const total = d1 + d2;
        const isHard = (d1 === d2);

        // Broadcast rolling animation to all players
        this._broadcast({ type: 'rolling', playerId, name }, null);

        let wasPointPhase = false;
        try {
          // ── Pass 1: Resolve bets (uses OLD phase/point) & store results ──
          const prevPhase = game.phase;
          const prevPoint = game.point;
          const sockets = this.state.getWebSockets();
          const playerResults = new Map(); // nonce → { resolution, pd }

          for (const pws of sockets) {
            let att;
            try { att = pws.deserializeAttachment(); } catch (_) { continue; }
            if (!att || !att.authenticated || !att.nonce) continue;

            const pd = await this.state.storage.get(`player:${att.nonce}`);
            if (!pd) continue;

            const resolution = resolveBets(pd, d1, d2, total, isHard, prevPhase, prevPoint);
            await this.state.storage.put(`player:${att.nonce}`, pd);
            playerResults.set(att.nonce, { resolution, pd });
          }

          // ── Compute NEW phase/point BEFORE sending results ──
          wasPointPhase = prevPhase === 'point';
          if (prevPhase === 'comeout') {
            if (total === 7 || total === 11 || total === 2 || total === 3 || total === 12) {
              // Stay in comeout
            } else {
              game.point = total;
              game.phase = 'point';
            }
          } else {
            if (total === prevPoint || total === 7) {
              game.phase = 'comeout';
              game.point = 0;
            }
          }

          // ── Pass 2: Send results with NEW phase/point ──
          for (const pws of sockets) {
            let att;
            try { att = pws.deserializeAttachment(); } catch (_) { continue; }
            if (!att || !att.authenticated || !att.nonce) continue;

            const cached = playerResults.get(att.nonce);
            if (!cached) continue;

            try {
              pws.send(JSON.stringify({
                type: 'roll-result',
                dice: [d1, d2],
                total,
                prevPhase,
                prevPoint,
                phase: game.phase,
                point: game.point,
                resolution: cached.resolution,
                stack: cached.pd.stack,
                bets: cached.pd.bets,
                comeBets: cached.pd.comeBets,
                comeOdds: cached.pd.comeOdds,
                pressOptions: cached.resolution.pressOptions || {},
              }));
            } catch (_) { /* socket closed mid-roll — skip, don't abort others */ }
          }
        } finally {
          // ALWAYS unlock rolling — prevents permanent stuck state
          game.rolling = false;
          game.rollCount = (game.rollCount || 0) + 1;
          await this.state.storage.put('game', game);
        }

        // Send updated phase/point to all
        this._broadcast({
          type: 'phase-update',
          phase: game.phase,
          point: game.point,
        }, null);

        // Seven-out: was in point phase and rolled a 7 → rotate shooter
        if (wasPointPhase && total === 7) {
          await this._advanceShooter(playerId);
        }

        break;
      }

      // ── Press: double a winning bet ──
      case 'press': {
        if (!attachment.authenticated || !attachment.nonce) break;
        const pPress = await this.state.storage.get(`player:${attachment.nonce}`);
        if (!pPress) break;

        const zone = data.zone;
        if (!zone || !pPress.bets[zone]) break;

        const pressAmount = pPress.bets[zone]; // double the bet
        if (pPress.stack < pressAmount) {
          ws.send(JSON.stringify({ type: 'bet-rejected', reason: 'Not enough to press' }));
          break;
        }

        pPress.stack -= pressAmount;
        pPress.bets[zone] += pressAmount;
        await this.state.storage.put(`player:${attachment.nonce}`, pPress);

        ws.send(JSON.stringify({
          type: 'bet-ok',
          stack: pPress.stack,
          bets: pPress.bets,
          comeBets: pPress.comeBets,
          comeOdds: pPress.comeOdds,
        }));
        this._broadcast({
          type: 'state', playerId, name, chadId: attachment.chadId,
          stack: pPress.stack, bets: pPress.bets, comeBets: pPress.comeBets,
        }, playerId);
        break;
      }

      // ── Chat ──
      case 'chat': {
        const text = String(data.text || '').slice(0, 120);
        this._broadcast({ type: 'chat', playerId, name, text }, playerId);
        break;
      }

      // ── Pass dice ──
      case 'pass-dice': {
        const shooterPass = await this.state.storage.get('shooter');
        if (playerId !== shooterPass) break;
        await this._advanceShooter(playerId);
        break;
      }

      // ── Legacy state broadcast (for non-authenticated spectators) ──
      case 'state': {
        if (data.stack !== undefined) attachment.stack = Number(data.stack) || 0;
        if (data.bets) attachment.bets = data.bets;
        if (data.comeBets) attachment.comeBets = data.comeBets;
        ws.serializeAttachment(attachment);
        this._broadcast({
          type: 'state', playerId,
          name, chadId: attachment.chadId,
          stack: attachment.stack,
          bets: attachment.bets || {},
          comeBets: attachment.comeBets || {},
        }, playerId);
        break;
      }

      default:
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Hibernation callbacks
  // ═══════════════════════════════════════════════════════════════════════

  async webSocketClose(ws, code, reason, wasClean) {
    await this._handleDisconnect(ws);
  }

  async webSocketError(ws) {
    await this._handleDisconnect(ws);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  REST handlers (called by Worker, not clients)
  // ═══════════════════════════════════════════════════════════════════════

  async _handleRegister(body) {
    const { nonce, tokenId, player, stack, sessionToken, buyIn } = body;
    if (!nonce || !player || !sessionToken) {
      return jsonResp({ error: 'Missing fields' }, 400);
    }

    // Check if already registered (reconnect case)
    const existing = await this.state.storage.get(`player:${nonce}`);
    if (existing) {
      return jsonResp({ ok: true, stack: existing.stack, existing: true });
    }

    const game = await this._getGame();

    await this.state.storage.put(`player:${nonce}`, {
      tokenId:  String(tokenId),
      player:   player.toLowerCase(),
      stack:    Number(stack) || 0,
      bets:     {},
      comeBets: {},
      comeOdds: {},
      buyIn:    Number(buyIn) || 0,
      _expectedToken: sessionToken,
    });

    return jsonResp({ ok: true, stack: Number(stack) || 0, phase: game.phase, point: game.point });
  }

  async _handleCashout(body) {
    const { nonce, sessionToken } = body;
    if (!nonce || !sessionToken) {
      return jsonResp({ error: 'Missing nonce or sessionToken' }, 400);
    }

    const pd = await this.state.storage.get(`player:${nonce}`);
    if (!pd) {
      return jsonResp({ error: 'No player session' }, 404);
    }
    if (pd._expectedToken !== sessionToken) {
      return jsonResp({ error: 'Invalid session token' }, 403);
    }

    // Return all bets to stack
    let betsOnTable = 0;
    for (const val of Object.values(pd.bets || {})) betsOnTable += val;
    for (const val of Object.values(pd.comeBets || {})) betsOnTable += val;
    for (const val of Object.values(pd.comeOdds || {})) betsOnTable += val;
    const payout = pd.stack + betsOnTable;

    // Remove player from DO storage
    await this.state.storage.delete(`player:${nonce}`);

    // Disconnect their WebSocket
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.nonce === String(nonce)) {
          this._broadcast({ type: 'leave', playerId: att.playerId }, att.playerId);
          ws.close(1000, 'Cashed out');
          break;
        }
      } catch (_) {}
    }

    return jsonResp({
      ok: true,
      payout,
      tokenId:   pd.tokenId,
      player:    pd.player,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Internal helpers
  // ═══════════════════════════════════════════════════════════════════════

  async _getGame() {
    return (await this.state.storage.get('game')) || {
      phase: 'comeout',
      point: 0,
      rolling: false,
      rollCount: 0,
    };
  }

  // Returns true if no player activity in the last 2 minutes.
  // Socket state is unreliable (Hibernation retains dead sockets),
  // so we use a storage timestamp instead.
  async _isTableStale() {
    const lastActivity = await this.state.storage.get('lastActivity');
    if (!lastActivity) return true; // no activity ever recorded → stale
    return (Date.now() - lastActivity) > 60 * 1000;
  }

  // Remove player:* entries that don't belong to any connected socket.
  // Prevents orphaned data from building up across sessions.
  async _cleanupOrphanedPlayers() {
    const liveNonces = new Set();
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.nonce) liveNonces.add(att.nonce);
      } catch (_) {}
    }
    const allKeys = await this.state.storage.list({ prefix: 'player:' });
    for (const [key] of allKeys) {
      const nonce = key.replace('player:', '');
      if (!liveNonces.has(nonce)) {
        await this.state.storage.delete(key);
      }
    }
  }

  _validateBetPhase(zone, phase, playerData) {
    if (zone.startsWith('place') && phase === 'comeout') return 'Place bets open after point';
    if (zone === 'pass' && phase === 'point') return 'Pass line only on come-out roll';
    if (zone === 'passOdds' && phase === 'comeout') return 'Pass odds only after point is set';
    if (zone === 'come' && phase === 'comeout') return 'Come bets only after point is set';
    if (zone.startsWith('comeOdds')) {
      const num = zone.replace('comeOdds', '');
      if (!playerData.comeBets || !playerData.comeBets[num]) {
        return 'No come bet on ' + num + ' to back with odds';
      }
    }
    return null;
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
          });
        }
      } catch (_) {}
    }
    return players;
  }

  async _getPlayerListPublic() {
    // Returns player info including bets/stack from DO storage
    const players = [];
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (!att) continue;
        const entry = { playerId: att.playerId, name: att.name, chadId: att.chadId, stack: 0, bets: {}, comeBets: {} };
        if (att.nonce && att.authenticated) {
          const pd = await this.state.storage.get(`player:${att.nonce}`);
          if (pd) {
            entry.stack = pd.stack || 0;
            entry.bets = pd.bets || {};
            entry.comeBets = pd.comeBets || {};
          }
        }
        players.push(entry);
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

  _broadcast(data, excludePlayerId) {
    const msg = JSON.stringify(data);
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (excludePlayerId && att && att.playerId === excludePlayerId) continue;
        ws.send(msg);
      } catch (_) {}
    }
  }

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

    // If no other sockets remain at all, reset to comeout
    const otherSockets = this.state.getWebSockets().filter(w => {
      try {
        const a = w.deserializeAttachment();
        return a && a.playerId !== playerId;
      } catch (_) { return false; }
    });
    if (otherSockets.length === 0) {
      await this.state.storage.put('game', {
        phase: 'comeout', point: 0, rolling: false, rollCount: 0,
      });
      await this.state.storage.delete('lastActivity');
    }
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

    const nextShooter = playerIds[0];
    await this.state.storage.put('shooter', nextShooter);
    this._broadcast({ type: 'shooter', playerId: nextShooter }, null);
  }

  async _verifySessionToken(nonce, player, token) {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(this.env.ORACLE_PRIVATE_KEY),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const data = new TextEncoder().encode(`craps:${nonce}:${String(player).toLowerCase()}`);
      const sig = await crypto.subtle.sign('HMAC', key, data);
      const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
      return expected === token;
    } catch (_) {
      return false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Bet resolution (pure function — no side effects except mutating player)
// ═══════════════════════════════════════════════════════════════════════════

function resolveBets(player, d1, d2, total, isHard, phase, point) {
  const bets = player.bets || {};
  const comeBets = player.comeBets || {};
  const comeOdds = player.comeOdds || {};
  let netWin = 0;
  const wins = [];
  const losses = [];
  let message = '';

  // FIELD
  if (bets.field) {
    const fieldNums = [2, 3, 4, 9, 10, 11, 12];
    if (fieldNums.includes(total)) {
      let payout = bets.field;
      if (total === 2) payout = bets.field * 2;
      else if (total === 12) payout = bets.field * 3;
      netWin += payout;
      player.stack += payout;
      wins.push('field');
      message = 'FIELD ' + total + '! +' + payout;
    } else {
      losses.push('field');
      bets.field = 0;
    }
  }

  // HARDWAYS — OFF during comeout
  const hardMap = { hard4: 4, hard6: 6, hard8: 8, hard10: 10 };
  const hardPay = { hard4: 7, hard6: 9, hard8: 9, hard10: 7 };
  for (const [key, num] of Object.entries(hardMap)) {
    if (!bets[key]) continue;
    if (phase === 'comeout') continue;
    if (total === num && isHard) {
      const payout = bets[key] * hardPay[key];
      netWin += payout;
      player.stack += payout;
      wins.push(key);
      message = 'HARD ' + num + '! +' + payout;
    } else if (total === 7 || (total === num && !isHard)) {
      losses.push(key);
      bets[key] = 0;
    }
  }

  // COME BETS (on a number)
  for (const [numStr, amt] of Object.entries(comeBets)) {
    const num = parseInt(numStr);
    if (total === num) {
      netWin += amt;
      player.stack += amt + amt;
      message = 'COME ' + num + ' wins! +' + amt;
      if (comeOdds[numStr]) {
        const oddsPay = calcOdds(num, comeOdds[numStr]);
        netWin += oddsPay;
        player.stack += comeOdds[numStr] + oddsPay;
        delete comeOdds[numStr];
      }
      delete comeBets[numStr];
    } else if (total === 7) {
      delete comeBets[numStr];
      if (comeOdds[numStr]) delete comeOdds[numStr];
    }
  }

  // NEW COME BET
  if (bets.come) {
    if (total === 7 || total === 11) {
      netWin += bets.come;
      player.stack += bets.come + bets.come;
      wins.push('come');
      message = 'COME wins! +' + bets.come;
      bets.come = 0;
    } else if (total === 2 || total === 3 || total === 12) {
      losses.push('come');
      bets.come = 0;
    } else {
      const numKey = String(total);
      if (!comeBets[numKey]) comeBets[numKey] = 0;
      comeBets[numKey] += bets.come;
      message = 'Come bet moves to ' + total;
      bets.come = 0;
    }
  }

  // PLACE BETS — OFF during comeout
  const placePay = { 4: [9, 5], 5: [7, 5], 6: [7, 6], 8: [7, 6], 9: [7, 5], 10: [9, 5] };
  for (const num of [4, 5, 6, 8, 9, 10]) {
    const key = 'place' + num;
    if (!bets[key]) continue;
    if (phase === 'comeout') continue;
    if (total === num) {
      const [payNum, payDen] = placePay[num];
      const payout = Math.floor(bets[key] * payNum / payDen);
      netWin += payout;
      player.stack += payout;
      wins.push(key);
      message = 'PLACE ' + num + ' hits! +' + payout;
    } else if (total === 7) {
      losses.push(key);
      bets[key] = 0;
    }
  }

  // PASS LINE + ODDS
  if (phase === 'comeout') {
    if (bets.pass) {
      if (total === 7 || total === 11) {
        netWin += bets.pass;
        player.stack += bets.pass + bets.pass;
        wins.push('pass');
        message = total === 7 ? 'SEVEN! Winner!' : 'YO ELEVEN! Winner!';
        bets.pass = 0;
      } else if (total === 2 || total === 3 || total === 12) {
        losses.push('pass');
        message = total === 12 ? 'TWELVE! Craps!' : total === 2 ? 'SNAKE EYES! Craps!' : 'THREE CRAPS!';
        bets.pass = 0;
      }
    }
  } else {
    if (total === point) {
      if (bets.pass) {
        netWin += bets.pass;
        player.stack += bets.pass + bets.pass;
        wins.push('pass');
        message = 'WINNER! Point ' + point + '!';
        if (bets.passOdds) {
          const oddsPay = calcOdds(point, bets.passOdds);
          netWin += oddsPay;
          player.stack += bets.passOdds + oddsPay;
          bets.passOdds = 0;
        }
        bets.pass = 0;
      }
    } else if (total === 7) {
      if (bets.pass) { losses.push('pass'); bets.pass = 0; }
      if (bets.passOdds) { bets.passOdds = 0; }
      message = 'SEVEN OUT!';
    }
  }

  player.bets = bets;
  player.comeBets = comeBets;
  player.comeOdds = comeOdds;

  // Press options for winning standing bets
  const pressOptions = {};
  for (const zone of wins) {
    if (zone === 'pass') continue;
    if (bets[zone] && bets[zone] > 0) {
      pressOptions[zone] = bets[zone];
    }
  }

  return { netWin, wins, losses, message, pressOptions };
}

function calcOdds(pointNum, bet) {
  switch (pointNum) {
    case 4: case 10: return bet * 2;
    case 5: case 9:  return Math.floor(bet * 3 / 2);
    case 6: case 8:  return Math.floor(bet * 6 / 5);
    default: return 0;
  }
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
