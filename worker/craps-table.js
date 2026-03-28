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
 *   { type: 'pong' }                       ← heartbeat response
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
 *   { type: 'ping' }                       ← heartbeat (every 30s)
 *   { type: 'kick',        reason }         ← AFK/timeout removal
 *   { type: 'error',       message }
 *   { type: 'full' }
 */

const MAX_PLAYERS = 4;
const BET_TIME_SOLO = 15;
const BET_TIME_MULTI = 20;
const ROLL_TIME = 10;
const RESULT_DELAY = 10; // seconds after roll — covers dice animation (5s) + announcer (3.5s) + buffer

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
    // Uses storage (player:* keys) as source of truth, NOT sockets.
    // Hibernation API retains zombie sockets, making socket count unreliable.
    if (url.pathname === '/info') {
      const playerKeys = await this.state.storage.list({ prefix: 'player:' });
      const players = [];
      const now = Date.now();
      const STALE_MS = 15 * 60 * 1000; // match idle timeout
      for (const [key, pd] of playerKeys) {
        const lastActive = Math.max(pd.lastBetTime || 0, pd.lastActivity || 0);
        if (pd._disconnectedAt) continue; // disconnected, awaiting reconnect
        if (lastActive > 0 && (now - lastActive) >= STALE_MS) {
          // Stale player — clean up orphaned key
          await this.state.storage.delete(key);
          continue;
        }
        players.push({ playerId: pd.player, name: pd.tokenId });
      }
      return new Response(JSON.stringify({ count: players.length, players }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Reset (POST) — nuke all state, used before WS connect when table is empty ──
    if (url.pathname === '/reset' && request.method === 'POST') {
      // Close every WebSocket the Hibernation API retained
      for (const ws of this.state.getWebSockets()) {
        try { ws.close(1000, 'Table reset'); } catch (_) {}
      }
      // Wipe ALL storage — game state, player data, shooter, everything
      await this.state.storage.deleteAll();
      return new Response(JSON.stringify({ ok: true }), {
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

    // Close stale sockets for this player (Hibernation retains zombies)
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.playerId === playerId) ws.close(1000, 'Reconnecting');
      } catch (_) {}
    }

    // Storage = truth. Count other players, clean up own orphaned sessions.
    const playerKeys = await this.state.storage.list({ prefix: 'player:' });
    let otherCount = 0;
    let selfReconnect = false;
    for (const [key, pd] of playerKeys) {
      if (pd && pd.player && playerId.startsWith(pd.player)) {
        selfReconnect = true;
        // Don't delete — auth handler will reuse the existing session with bets intact
      } else {
        otherCount++;
      }
    }

    // Truly empty table (no players at all) → fresh start
    if (otherCount === 0 && !selfReconnect) {
      await this.state.storage.put('game', { phase: 'comeout', point: 0, rolling: false, rollCount: 0, turnPhase: 'idle', turnDeadline: 0 });
      await this.state.storage.delete('shooter');
    } else if (otherCount === 0 && selfReconnect) {
      // Solo reconnect — preserve game state (point/bets) but clear rolling flag
      const game = await this._getGame();
      if (game.rolling) {
        game.rolling = false;
        await this.state.storage.put('game', game);
      }
    }

    if (otherCount >= MAX_PLAYERS) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify({ type: 'full' }));
      server.close(4001, 'Table is full');
      return new Response(null, { status: 101, webSocket: client });
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

    // Ensure a shooter exists (after cleanup, shooter may have been deleted)
    let shooter = await this.state.storage.get('shooter');
    if (!shooter) {
      shooter = playerId;
      await this.state.storage.put('shooter', shooter);
    }

    // Send init with current game state
    // (Worker calls /reset before WS upgrade when table is empty,
    //  so game state is guaranteed clean for first player.)
    const game = await this._getGame();
    const players = await this._getPlayerListFromStorage();
    server.send(JSON.stringify({
      type: 'init', players, shooter, game,
      turnPhase: game.turnPhase || 'betting',
      turnDeadline: game.turnDeadline || 0,
    }));

    // Broadcast join to others
    this._broadcast({ type: 'join', playerId, name: String(name).slice(0, 20), chadId }, playerId);

    // Start heartbeat alarm if not already running
    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      await this.state.storage.setAlarm(Date.now() + 30_000);
    }

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

      // ── Heartbeat pong ──
      case 'pong': {
        attachment.lastPong = Date.now();
        ws.serializeAttachment(attachment);
        // Also update lastActivity in player storage to prevent false idle kicks
        if (attachment.nonce) {
          const pPong = await this.state.storage.get(`player:${attachment.nonce}`);
          if (pPong) {
            pPong.lastActivity = Date.now();
            await this.state.storage.put(`player:${attachment.nonce}`, pPong);
          }
        }
        break;
      }

      // ── Auth: link WS connection to registered player ──
      case 'auth': {
        const nonce = data.nonce;
        const token = data.sessionToken;
        const tokenTs = data.sessionTokenTs != null ? Number(data.sessionTokenTs) : null;
        if (!nonce || !token) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing nonce or sessionToken' }));
          break;
        }

        let playerData = await this.state.storage.get(`player:${nonce}`);

        // Self-register if not pre-registered (player picked table after /craps/start)
        if (!playerData) {
          // Verify the session token via HMAC (includes timestamp expiry check)
          const verified = await this._verifySessionToken(nonce, data.player, token, tokenTs);
          if (!verified) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired session token' }));
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
            _expectedTokenTs: tokenTs,
          };
          await this.state.storage.put(`player:${nonce}`, playerData);
        } else if (playerData._expectedToken !== token) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session token' }));
          break;
        } else if (playerData._disconnectedAt) {
          // Reconnecting — clear disconnected flag, restore session
          delete playerData._disconnectedAt;
          playerData.lastActivity = Date.now();
          await this.state.storage.put(`player:${nonce}`, playerData);
        }

        // Link this WS connection to the player data
        attachment.nonce = String(nonce);
        attachment.authenticated = true;
        ws.serializeAttachment(attachment);

        const game = await this._getGame();

        // Send current state back
        ws.send(JSON.stringify({
          type: 'auth-ok',
          stack:    playerData.stack,
          bets:     playerData.bets,
          comeBets: playerData.comeBets,
          comeOdds: playerData.comeOdds,
          phase:    game.phase,
          point:    game.point,
          turnPhase: game.turnPhase || 'betting',
          turnDeadline: game.turnDeadline || 0,
        }));

        // Broadcast updated state to others
        this._broadcast({
          type: 'state', playerId, name, chadId: attachment.chadId,
          stack: playerData.stack,
          bets: playerData.bets,
          comeBets: playerData.comeBets,
        }, playerId);

        // If no active turn phase, start betting
        if (!game.turnPhase || game.turnPhase === 'idle' || !game.turnDeadline || game.turnDeadline < Date.now()) {
          await this._startBetPhase();
        }
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

        // Server-authoritative: only accept bets during betting phase
        if (game.turnPhase && game.turnPhase !== 'betting') {
          ws.send(JSON.stringify({ type: 'bet-rejected', reason: 'Bets are locked', stack: pData.stack, bets: pData.bets }));
          break;
        }

        const zone = data.zone;
        const amount = Math.max(0, Math.floor(Number(data.amount) || 0));
        if (!VALID_BET_ZONES.has(zone) || amount <= 0) {
          ws.send(JSON.stringify({ type: 'bet-rejected', reason: 'Invalid bet', stack: pData.stack, bets: pData.bets }));
          break;
        }
        if (amount > pData.stack) {
          ws.send(JSON.stringify({ type: 'bet-rejected', reason: 'Insufficient stack', stack: pData.stack, bets: pData.bets }));
          break;
        }

        // Phase rules
        const phaseError = this._validateBetPhase(zone, game.phase, pData);
        if (phaseError) {
          ws.send(JSON.stringify({ type: 'bet-rejected', reason: phaseError, stack: pData.stack, bets: pData.bets }));
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

        pData.lastBetTime = Date.now();
        await this.state.storage.put(`player:${attachment.nonce}`, pData);

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

        // Return clearable bets to stack — pass and passOdds are locked (contract bets)
        const lockedZones = new Set(['pass', 'passOdds']);
        const keptBets = {};
        for (const [zone, val] of Object.entries(pClear.bets || {})) {
          if (lockedZones.has(zone)) { keptBets[zone] = val; }
          else { pClear.stack += val; }
        }
        for (const val of Object.values(pClear.comeBets || {})) pClear.stack += val;
        for (const val of Object.values(pClear.comeOdds || {})) pClear.stack += val;
        pClear.bets = keptBets;
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


        // ── Generate dice (server-side, crypto-secure) ──
        const arr = new Uint32Array(2);
        crypto.getRandomValues(arr);
        const d1 = (arr[0] % 6) + 1;
        const d2 = (arr[1] % 6) + 1;
        const total = d1 + d2;
        const isHard = (d1 === d2);

        // Broadcast rolling animation to all players
        this._broadcast({ type: 'rolling', playerId, name }, null);

        // prevPhase captured above — used later for seven-out shooter rotation
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

        // phase/point is already included in each roll-result message,
        // so no separate phase-update broadcast needed here.

        // Seven-out: was in point phase and rolled a 7 → rotate shooter
        if (prevPhase === 'point' && total === 7) {
          await this._advanceShooter(playerId);
        }

        // Transition to result phase — alarm will start next bet phase
        await this._startResultPhase();

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
    const { nonce, tokenId, player, stack, sessionToken, sessionTokenTs, buyIn } = body;
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
      lastBetTime: Date.now(),
      _expectedToken: sessionToken,
      _expectedTokenTs: sessionTokenTs != null ? Number(sessionTokenTs) : null,
    });

    return jsonResp({ ok: true, stack: Number(stack) || 0, phase: game.phase, point: game.point });
  }

  async _handleCashout(body) {
    const { nonce, sessionToken, sessionTokenTs } = body;
    if (!nonce || !sessionToken) {
      return jsonResp({ error: 'Missing nonce or sessionToken' }, 400);
    }

    // Idempotency: if this nonce was already cashed out, return the cached result.
    // The DO is single-threaded so this check-then-set is atomic.
    const doneKey = `cashout_done:${nonce}`;
    const cached = await this.state.storage.get(doneKey);
    if (cached) {
      return jsonResp(cached);
    }

    const pd = await this.state.storage.get(`player:${nonce}`);
    if (!pd) {
      return jsonResp({ error: 'No player session' }, 404);
    }
    if (pd._expectedToken !== sessionToken) {
      return jsonResp({ error: 'Invalid session token' }, 403);
    }
    // Reject expired tokens (24-hour window)
    const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const storedTs = pd._expectedTokenTs;
    if (!storedTs || typeof storedTs !== 'number' || Date.now() - storedTs > TOKEN_MAX_AGE_MS) {
      return jsonResp({ error: 'Session token expired' }, 403);
    }

    // Return clearable bets to stack — pass and passOdds are forfeited (contract bets)
    const lockedCashout = new Set(['pass', 'passOdds']);
    let betsReturned = 0;
    for (const [zone, val] of Object.entries(pd.bets || {})) {
      if (!lockedCashout.has(zone)) betsReturned += val;
    }
    for (const val of Object.values(pd.comeBets || {})) betsReturned += val;
    for (const val of Object.values(pd.comeOdds || {})) betsReturned += val;
    const payout = pd.stack + betsReturned;

    const result = {
      ok: true,
      payout,
      tokenId:   pd.tokenId,
      player:    pd.player,
    };

    // Atomically cache result and remove player in a single storage transaction
    await this.state.storage.put(doneKey, result);
    await this.state.storage.delete(`player:${nonce}`);

    // Close their WebSocket — this triggers webSocketClose → _handleDisconnect
    // which broadcasts 'leave', rotates shooter, and resets if table is empty.
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.nonce === String(nonce)) {
          ws.close(1000, 'Cashed out');
          break;
        }
      } catch (_) {}
    }

    return jsonResp(result);
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
      turnPhase: 'betting',   // betting | no-more-bets | rolling | result | idle
      turnDeadline: 0,        // unix ms — when current turnPhase expires
    };
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

  async _getPlayerListFromStorage() {
    // Storage-based player list — immune to zombie sockets.
    const playerKeys = await this.state.storage.list({ prefix: 'player:' });
    const players = [];
    for (const [key, pd] of playerKeys) {
      const nonce = key.replace('player:', '');
      players.push({
        playerId: pd.player + '-' + pd.tokenId,
        name:     pd.tokenId,
        chadId:   Number(pd.tokenId) || 0,
        stack:    pd.stack || 0,
        bets:     pd.bets || {},
        comeBets: pd.comeBets || {},
      });
    }
    return players;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Heartbeat alarm — pings all sockets, kills zombies
  // ═══════════════════════════════════════════════════════════════════════

  async alarm() {
    const sockets = this.state.getWebSockets();
    const now = Date.now();
    let activeSockets = 0;

    for (const ws of sockets) {
      let att;
      try { att = ws.deserializeAttachment(); } catch (_) { continue; }
      if (!att) continue;

      // If lastPong was set and is older than 120s, socket is zombie
      if (att.lastPong && (now - att.lastPong) > 120_000) {
        try { ws.close(4002, 'Heartbeat timeout'); } catch (_) {}
        continue;
      }

      try {
        ws.send(JSON.stringify({ type: 'ping' }));
        if (!att.lastPong) {
          att.lastPong = now;
          ws.serializeAttachment(att);
        }
        activeSockets++;
      } catch (_) {}
    }

    // ── Phase deadline check (server-authoritative game loop) ──
    const game = await this._getGame();
    if (game.turnDeadline && now >= game.turnDeadline) {
      if (game.turnPhase === 'betting') {
        // Bet timer expired — check if shooter has a pass bet
        // Use storage (not sockets) for reliability — sockets can be hibernated/stale
        const shooter = await this.state.storage.get('shooter');
        let shooterHasBet = false;
        if (shooter) {
          const playerKeys = await this.state.storage.list({ prefix: 'player:' });
          for (const [, pd] of playerKeys) {
            const pid = (pd.player || '') + '-' + (pd.tokenId || '');
            if (pid === shooter && pd.bets && pd.bets.pass > 0) {
              shooterHasBet = true;
              break;
            }
          }
        }
        if (shooterHasBet) {
          // Transition: betting → rolling
          await this._startRollPhase();
        } else {
          // Shooter didn't bet — pass dice or restart bet phase
          const count = await this._getPlayerCount();
          if (count > 1 && shooter) {
            await this._advanceShooter(shooter);
          }
          await this._startBetPhase();
        }
      } else if (game.turnPhase === 'rolling') {
        // Roll timer expired — auto-roll for the shooter
        const shooter = await this.state.storage.get('shooter');
        let rolled = false;
        for (const ws of sockets) {
          try {
            const att = ws.deserializeAttachment();
            if (att && att.playerId === shooter && att.authenticated) {
              await this.webSocketMessage(ws, JSON.stringify({ type: 'roll' }));
              rolled = true;
              break;
            }
          } catch (_) {}
        }
        // If couldn't find shooter's socket, force next bet phase
        if (!rolled) {
          await this._startBetPhase();
        }
      } else if (game.turnPhase === 'result') {
        // Result display time elapsed — start next bet phase
        await this._startBetPhase();
      }
    }

    // ── Disconnected player cleanup: remove after 2 min grace period ──
    const DISCONNECT_GRACE_MS = 10 * 60 * 1000;
    const playerKeysForDisconnect = await this.state.storage.list({ prefix: 'player:' });
    for (const [key, pd] of playerKeysForDisconnect) {
      if (pd._disconnectedAt && (now - pd._disconnectedAt) >= DISCONNECT_GRACE_MS) {
        const dcPlayerId = pd.player + '-' + pd.tokenId;
        await this.state.storage.delete(key);
        // Rotate shooter if needed
        const shooter = await this.state.storage.get('shooter');
        if (shooter === dcPlayerId) {
          const rem = await this.state.storage.list({ prefix: 'player:' });
          const conn = [...rem].filter(([, p]) => !p._disconnectedAt);
          if (conn.length > 0) {
            const [, nextPd] = conn[0];
            const ns = nextPd.player + '-' + nextPd.tokenId;
            await this.state.storage.put('shooter', ns);
            this._broadcast({ type: 'shooter', playerId: ns }, null);
          } else if (rem.size === 0) {
            await this.state.storage.deleteAll();
          }
        }
      }
    }

    // ── Idle check: kick players with no activity for 15 minutes ──
    // Also cleans up orphaned player keys (zombie sockets from Hibernation API)
    const IDLE_MS = 15 * 60 * 1000;
    const playerKeys = await this.state.storage.list({ prefix: 'player:' });
    for (const [key, pd] of playerKeys) {
      if (pd._disconnectedAt) continue; // handled by disconnect cleanup above
      const lastActive = Math.max(pd.lastBetTime || 0, pd.lastActivity || 0);
      if (lastActive > 0 && (now - lastActive) < IDLE_MS) continue;
      // Player is idle or has no activity timestamp — find their socket
      const idlePlayerId = pd.player + '-' + pd.tokenId;
      const nonce = key.replace('player:', '');
      let foundSocket = false;
      for (const ws of sockets) {
        try {
          const att = ws.deserializeAttachment();
          if (att && att.nonce === nonce) {
            foundSocket = true;
            await this._kickPlayer(ws, idlePlayerId, nonce, 'Idle for 15 minutes — removed from table');
            break;
          }
        } catch (_) {}
      }
      // No socket found for this player — orphaned storage key (zombie disconnect)
      // Clean up directly since there's no socket to kick
      if (!foundSocket && lastActive > 0 && (now - lastActive) >= IDLE_MS) {
        await this.state.storage.delete(key);
        this._broadcast({ type: 'leave', playerId: idlePlayerId }, null);
        // Rotate shooter if this was the shooter
        const shooter = await this.state.storage.get('shooter');
        if (shooter === idlePlayerId) {
          const remaining = await this.state.storage.list({ prefix: 'player:' });
          if (remaining.size > 0) {
            const [, nextPd] = [...remaining][0];
            const nextShooter = nextPd.player + '-' + nextPd.tokenId;
            await this.state.storage.put('shooter', nextShooter);
            this._broadcast({ type: 'shooter', playerId: nextShooter }, null);
          } else {
            await this.state.storage.deleteAll();
          }
        }
      }
    }

    // Reschedule: shorter interval when game phase is active
    if (activeSockets > 0) {
      const freshGame = await this._getGame();
      const freshNow = Date.now();
      if (freshGame.turnDeadline && freshGame.turnDeadline > freshNow) {
        // Active phase — poll frequently to catch deadline
        const delay = Math.max(500, Math.min(2000, freshGame.turnDeadline - freshNow + 100));
        await this.state.storage.setAlarm(freshNow + delay);
      } else {
        // Idle — heartbeat every 30s
        await this.state.storage.setAlarm(freshNow + 30_000);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Kick a player (AFK, etc.) — notify them, then close socket
  // ═══════════════════════════════════════════════════════════════════════

  async _kickPlayer(ws, playerId, nonce, reason) {
    // Log the kick + lost cells to KV for admin review
    const pd = await this.state.storage.get(`player:${nonce}`);
    if (pd) {
      let cellsLost = pd.stack || 0;
      for (const v of Object.values(pd.bets || {})) cellsLost += v;
      for (const v of Object.values(pd.comeBets || {})) cellsLost += v;
      for (const v of Object.values(pd.comeOdds || {})) cellsLost += v;
      const logEntry = {
        wallet:    pd.player,
        tokenId:   pd.tokenId,
        cellsLost,
        stack:     pd.stack || 0,
        bets:      pd.bets || {},
        reason,
        kickedAt:  new Date().toISOString(),
      };
      try {
        const logKey = `kick:${Date.now()}:${pd.player}`;
        await this.env.RUNNER_KV.put(logKey, JSON.stringify(logEntry), { expirationTtl: 90 * 86400 });
      } catch (_) {}
    }

    try {
      ws.send(JSON.stringify({ type: 'kick', reason }));
    } catch (_) {}
    try {
      ws.close(4003, reason);
    } catch (_) {}
  }

  async _advanceShooter(currentShooterId) {
    const remaining = await this.state.storage.list({ prefix: 'player:' });
    if (remaining.size === 0) return;

    // Build ordered list of playerIds from storage
    const playerIds = [];
    for (const [, pd] of remaining) {
      playerIds.push(pd.player + '-' + pd.tokenId);
    }

    // Pick next player after current shooter (round-robin)
    const idx = playerIds.indexOf(currentShooterId);
    const nextIdx = (idx + 1) % playerIds.length;
    const nextShooter = playerIds[nextIdx];

    await this.state.storage.put('shooter', nextShooter);
    this._broadcast({ type: 'shooter', playerId: nextShooter }, null);
  }

  // ── Server-authoritative phase transitions ──

  async _getPlayerCount() {
    return (await this.state.storage.list({ prefix: 'player:' })).size;
  }

  async _startBetPhase() {
    const count = await this._getPlayerCount();
    if (count === 0) return;
    const game = await this._getGame();
    const seconds = count > 1 ? BET_TIME_MULTI : BET_TIME_SOLO;
    game.turnPhase = 'betting';
    game.turnDeadline = Date.now() + seconds * 1000;
    game.rolling = false;
    await this.state.storage.put('game', game);
    this._broadcast({
      type: 'turn-phase',
      turnPhase: 'betting',
      deadline: game.turnDeadline,
      phase: game.phase,
      point: game.point,
    }, null);
    // Schedule alarm to check deadline
    await this._ensureAlarm(2000);
  }

  async _startRollPhase() {
    const game = await this._getGame();
    game.turnPhase = 'rolling';
    game.turnDeadline = Date.now() + ROLL_TIME * 1000;
    await this.state.storage.put('game', game);
    this._broadcast({
      type: 'turn-phase',
      turnPhase: 'rolling',
      deadline: game.turnDeadline,
      phase: game.phase,
      point: game.point,
    }, null);
    await this._ensureAlarm(2000);
  }

  async _startResultPhase() {
    const game = await this._getGame();
    game.turnPhase = 'result';
    game.turnDeadline = Date.now() + RESULT_DELAY * 1000;
    await this.state.storage.put('game', game);
    // No broadcast needed — roll-result already sent
    await this._ensureAlarm(2000);
  }

  async _ensureAlarm(minDelayMs) {
    const current = await this.state.storage.getAlarm();
    if (!current || current > Date.now() + minDelayMs + 500) {
      await this.state.storage.setAlarm(Date.now() + minDelayMs);
    }
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

  // ── Single authoritative cleanup when ANY player leaves ──
  // Called by: webSocketClose, webSocketError
  // 1. Mark player as disconnected (grace period for reconnect)
  // 2. Broadcast 'leave' to remaining players
  // 3. Rotate shooter if needed (using storage, not sockets)
  // 4. If table empty and no disconnected players → nuke all state
  async _handleDisconnect(ws) {
    let playerId = null;
    let nonce = null;
    try {
      const att = ws.deserializeAttachment();
      if (att) { playerId = att.playerId; nonce = att.nonce; }
    } catch (_) {}
    if (!playerId) return;

    // 1. Mark player as disconnected instead of deleting immediately.
    //    This preserves bets/stack for reconnect within the grace period.
    //    The idle alarm cleans up players who don't reconnect.
    if (nonce) {
      const pd = await this.state.storage.get(`player:${nonce}`);
      if (pd) {
        pd._disconnectedAt = Date.now();
        await this.state.storage.put(`player:${nonce}`, pd);
      }
    }

    // 2. Notify others
    this._broadcast({ type: 'leave', playerId }, playerId);

    // 3. Check remaining players (storage = truth) and handle shooter
    const remaining = await this.state.storage.list({ prefix: 'player:' });
    // Filter to only connected (non-disconnected) players
    const connected = [...remaining].filter(([, pd]) => !pd._disconnectedAt);

    if (remaining.size === 0) {
      // Table truly empty — full reset
      await this.state.storage.deleteAll();
      return;
    }

    // Rotate shooter if needed — only pick from connected players
    const shooter = await this.state.storage.get('shooter');
    if (shooter === playerId && connected.length > 0) {
      const [, nextPd] = connected[0];
      const nextShooter = nextPd.player + '-' + nextPd.tokenId;
      await this.state.storage.put('shooter', nextShooter);
      this._broadcast({ type: 'shooter', playerId: nextShooter }, null);
    }
  }

  async _verifySessionToken(nonce, player, token, timestamp) {
    try {
      // Reject tokens older than 24 hours
      const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
      if (!timestamp || typeof timestamp !== 'number' || Date.now() - timestamp > TOKEN_MAX_AGE_MS) {
        return false;
      }
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(this.env.ORACLE_PRIVATE_KEY),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const data = new TextEncoder().encode(`craps:${nonce}:${String(player).toLowerCase()}:${timestamp}`);
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
      const payout = bets.field;
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
