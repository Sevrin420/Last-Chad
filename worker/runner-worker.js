/**
 * Members Only — Worker
 * Cloudflare Worker + KV
 *
 * Handles:
 *  1. Poker session management (deal, draw, cashout)
 *  2. Craps session management (start, WebSocket relay, cashout)
 *  3. HashCash craps tables
 *  4. Freeplay & PieFace minigame leaderboards
 *  5. Oracle-signed settlements (chips payout)
 *
 * Cloudflare secrets (set via `wrangler secret put`):
 *   ORACLE_PRIVATE_KEY  — hex private key, no 0x prefix
 *
 * wrangler.toml vars:
 *   CONTRACT_ADDRESS    — MembersOnly.sol contract address
 *   GAMBLE_ADDRESS      — Gamble.sol contract address
 *   READ_RPC            — Avalanche read RPC URL
 */

import { ethers } from 'ethers';
export { CrapsTable } from './craps-table.js';
export { HashCashTable } from './hashcash-table.js';
export { ClubNileRoom } from './clubnile-room.js';

const ALLOWED_ORIGINS = ['https://membersonly.cc', 'https://www.membersonly.cc', 'https://lastchad.xyz', 'https://enterthegrotto.xyz', 'https://api.enterthegrotto.xyz'];
function getCors(request) {
  const origin = request?.headers?.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const POKER_SESSION_TTL = 900;    // 15 minutes per session (reset on every interaction)
const CRAPS_SESSION_TTL = 1200;   // 20 minutes per craps session (longer game)
const TABLE_PRESENCE_TTL = 120;   // 2 minutes — heartbeat refreshes this
const TABLE_STALE_MS = 90_000;    // 90s — entries older than this are filtered out
const MAX_PUBLIC_TABLES  = 6;
const MAX_PRIVATE_TABLES = 10;
const MAX_PLAYERS_PER_TABLE = 4;
const PUBLIC_TABLES = Array.from({ length: MAX_PUBLIC_TABLES }, (_, i) => ({
  name: `public-${i + 1}`,
  label: `PUBLIC TABLE ${i + 1}`,
}));
function isValidTable(tableCode) {
  return PUBLIC_TABLES.some(t => t.name === tableCode) || tableCode.startsWith('priv-');
}
const POKER_PAYOUTS = {
  'ROYAL FLUSH':      250,
  'STRAIGHT FLUSH':    50,
  'FOUR OF A KIND':    25,
  'FULL HOUSE':         9,
  'FLUSH':              6,
  'STRAIGHT':           4,
  'THREE OF A KIND':    3,
  'TWO PAIR':           2,
  'JACKS OR BETTER':    1,
};

const BLACKJACK_SESSION_TTL = 900; // 15 minutes per session

// ── HashCash Craps config ──
const HASHCASH_PUBLIC_TABLES = [
  { name: 'hashcash-1', label: 'HASHCASH TABLE 1' },
  { name: 'hashcash-2', label: 'HASHCASH TABLE 2' },
  { name: 'hashcash-3', label: 'HASHCASH TABLE 3' },
  { name: 'hashcash-4', label: 'HASHCASH TABLE 4' },
];
const HASHCASH_PRIVATE_TABLES = 5;
const HASHCASH_COOLDOWN_TTL = 86_400; // 24 hours
const HASHCASH_LB_KEY = 'hashcash:leaderboard';
const HASHCASH_LB_MAX = 20;
function isValidHashCashTable(tableCode) {
  return HASHCASH_PUBLIC_TABLES.some(t => t.name === tableCode) || tableCode.startsWith('hcpriv-');
}

const GAMBLE_ABI = [
  'function wagerAmounts(uint256 nonce) view returns (uint256)',
  'function wagerPlayers(uint256 nonce) view returns (address)',
  'function usedNonces(uint256 nonce) view returns (bool)',
  'event CageBuyIn(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce)',
];


export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCors(request) });
    }

    _currentCors = getCors(request);
    const url = new URL(request.url);

    try {
      // Poker endpoints
      if (request.method === 'POST' && url.pathname === '/poker/start') {
        return await handlePokerStart(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/poker/deal') {
        return await handlePokerDeal(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/poker/draw') {
        return await handlePokerDraw(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/poker/cashout') {
        return await handlePokerCashout(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/poker/admin/reset-session') {
        return await handlePokerAdminReset(request, env);
      }

      // Blackjack endpoints
      if (request.method === 'POST' && url.pathname === '/blackjack/start') {
        return await handleBlackjackStart(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/blackjack/deal') {
        return await handleBlackjackDeal(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/blackjack/hit') {
        return await handleBlackjackHit(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/blackjack/stand') {
        return await handleBlackjackStand(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/blackjack/double') {
        return await handleBlackjackDouble(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/blackjack/cashout') {
        return await handleBlackjackCashout(request, env);
      }

      // Craps endpoints (game logic lives in CrapsTable DO;
      // Worker handles on-chain verification + cashout signing only)
      if (request.method === 'POST' && url.pathname === '/craps/start') {
        return await handleCrapsStart(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/craps/cashout') {
        return await handleCrapsCashout(request, env);
      }

      // ── The Cage: buy-in registration + cash-out signing ──
      if (request.method === 'POST' && url.pathname === '/cage/buyin') {
        return await handleCageBuyin(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/cage/balance') {
        return await handleCageBalance(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/cage/cashout') {
        return await handleCageCashout(request, env);
      }

      // ── WebSocket upgrade → Durable Object ──
      if (url.pathname === '/craps/ws') {
        return await handleCrapsWebSocket(request, url, env);
      }

      // Club Nile social rooms (lobby chat + table presence/emoji/tips)
      if (url.pathname === '/clubnile/ws') {
        const room = (url.searchParams.get('room') || 'lobby').slice(0, 24);
        const id = env.CLUBNILE_ROOM.idFromName(room);
        return await env.CLUBNILE_ROOM.get(id).fetch(request);
      }

      // Table list (queries Durable Objects for player counts)
      if (request.method === 'GET' && url.pathname === '/tables/list') {
        return await handleTableList(env);
      }

      // ── HashCash Craps ──
      if (request.method === 'POST' && url.pathname === '/hashcash/join') {
        return await handleHashCashJoin(request, env);
      }
      if (url.pathname === '/hashcash/ws') {
        return await handleHashCashWebSocket(request, url, env);
      }
      if (request.method === 'POST' && url.pathname === '/hashcash/lockin') {
        return await handleHashCashLockin(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/hashcash/tables') {
        return await handleHashCashTableList(env);
      }
      if (request.method === 'GET' && url.pathname === '/hashcash/leaderboard') {
        return await handleHashCashLeaderboard(env);
      }
      if (request.method === 'POST' && url.pathname === '/hashcash/save-chips') {
        return await handleHashCashSaveChips(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/hashcash/admin/reset-leaderboard') {
        return await handleHashCashResetLeaderboard(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/hashcash/admin/delete-entry') {
        return await handleHashCashDeleteEntry(request, env);
      }

      // Freeplay leaderboard
      if (request.method === 'GET' && url.pathname === '/freeplay/leaderboard') {
        return await handleFreeplayLeaderboard(env);
      }
      if (request.method === 'POST' && url.pathname === '/freeplay/score') {
        return await handleFreeplayScore(request, env);
      }

      // ── Avax Pie Face ──
      if (request.method === 'POST' && url.pathname === '/pieface/play') {
        return await handlePieFacePlay(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/pieface/leaderboard') {
        return await handlePieFaceLeaderboard(env);
      }
      if (request.method === 'POST' && url.pathname === '/pieface/score') {
        return await handlePieFaceScore(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/pieface/use-attempt') {
        return await handlePieFaceUseAttempt(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/pieface/reset-leaderboard') {
        return await handlePieFaceResetLeaderboard(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/pieface/delete-entry') {
        return await handlePieFaceDeleteEntry(request, env);
      }

      // Admin: view kick log (owner-only, requires ORACLE_PRIVATE_KEY as bearer)
      if (request.method === 'GET' && url.pathname === '/craps/kick-log') {
        const auth = request.headers.get('Authorization') || '';
        const token = auth.replace('Bearer ', '');
        if (!token || token !== env.ORACLE_PRIVATE_KEY) {
          return json({ error: 'Unauthorized' }, 403);
        }
        const list = await env.RUNNER_KV.list({ prefix: 'kick:' });
        const entries = [];
        for (const key of list.keys) {
          const val = await env.RUNNER_KV.get(key.name, { type: 'json' });
          if (val) entries.push(val);
        }
        entries.sort((a, b) => new Date(b.kickedAt) - new Date(a.kickedAt));
        return json({ kicks: entries });
      }

      // Admin: reset all public tables (owner-only, requires ORACLE_PRIVATE_KEY as bearer)
      if (request.method === 'POST' && url.pathname === '/tables/reset-all') {
        const auth = request.headers.get('Authorization') || '';
        const token = auth.replace('Bearer ', '');
        if (!token || token !== env.ORACLE_PRIVATE_KEY) {
          return json({ error: 'Unauthorized' }, 403);
        }
        const results = [];
        for (const t of PUBLIC_TABLES) {
          try {
            const id = env.CRAPS_TABLE.idFromName(t.name);
            const stub = env.CRAPS_TABLE.get(id);
            const res = await stub.fetch(new Request('https://do/reset', { method: 'POST' }));
            const body = await res.json();
            results.push({ table: t.name, ...body });
          } catch (err) {
            results.push({ table: t.name, error: err.message });
          }
        }
        return json({ ok: true, results });
      }

      // Agora RTC token
      if (request.method === 'POST' && url.pathname === '/agora/token') {
        return await handleAgoraToken(request, env);
      }
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: 'Internal error', reason: err.message || 'server_error' }, 500);
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ---------------------------------------------------------------------------
// ===========================================================================
// POKER ENDPOINTS
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /poker/start  { tokenId, nonce, player }
// Verify wager on-chain, create session with stack = wager amount.
// ---------------------------------------------------------------------------
async function handlePokerStart(request, env) {
  const { tokenId, nonce, player } = await parseBody(request);
  if (tokenId == null || nonce == null || !player) {
    return json({ error: 'Missing tokenId, nonce, or player' }, 400);
  }
  if (!ethers.isAddress(player)) {
    return json({ error: 'Invalid player address' }, 400);
  }

  // Verify wager exists on-chain
  const provider = new ethers.JsonRpcProvider(env.READ_RPC);
  const gamble   = new ethers.Contract(env.GAMBLE_ADDRESS, GAMBLE_ABI, provider);
  const wager    = Number(await gamble.wagerAmounts(BigInt(nonce)));
  if (wager === 0) {
    return json({ error: 'No active wager for this nonce' }, 403);
  }
  const onChainPlayer = (await gamble.wagerPlayers(BigInt(nonce))).toLowerCase();
  if (onChainPlayer !== player.toLowerCase()) {
    return json({ error: 'Player mismatch' }, 403);
  }

  const sessionToken = await generateSessionToken(nonce, player.toLowerCase(), env);

  // Check if session already exists — return it with refreshed TTL
  const key = `poker:${nonce}`;
  const existing = await env.RUNNER_KV.get(key, { type: 'json' });
  if (existing) {
    // If session is stuck mid-hand (player abandoned during dealt phase), forfeit the hand
    // bet and reset to ready — stack already had handWager deducted when the hand was dealt.
    if (existing.phase === 'dealt') {
      existing.phase         = 'ready';
      existing.deck          = null;
      existing.hand          = null;
      existing.handWager     = 0;
      existing.lastDrawResult = null;
    }
    await env.RUNNER_KV.put(key, JSON.stringify(existing), { expirationTtl: POKER_SESSION_TTL });
    return json({ ok: true, stack: existing.stack, sessionToken });
  }

  await env.RUNNER_KV.put(key, JSON.stringify({
    tokenId: String(tokenId),
    player:  player.toLowerCase(),
    stack:   wager,
    phase:   'ready',
    deck:    null,
    hand:    null,
    handWager: 0,
    lastDrawResult: null, // cached draw result for retry
    _expectedToken: sessionToken,
  }), { expirationTtl: POKER_SESSION_TTL });

  return json({ ok: true, stack: wager, sessionToken });
}

// ---------------------------------------------------------------------------
// POST /poker/deal  { nonce, handWager }
// Deal 5 cards from a fresh shuffled deck. handWager is deducted from stack.
// ---------------------------------------------------------------------------
async function handlePokerDeal(request, env) {
  const { nonce, handWager, sessionToken } = await parseBody(request);
  if (nonce == null || handWager == null) {
    return json({ error: 'Missing nonce or handWager' }, 400);
  }

  const key     = `poker:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No poker session' }, 403);
  if (!verifySessionToken(session, sessionToken)) {
    return json({ error: 'Invalid session token' }, 403);
  }
  if (session.phase !== 'ready') {
    return json({ error: 'Must complete current hand first' }, 400);
  }

  const bet = Math.max(1, Math.min(Number(handWager), session.stack));

  // Shuffle a fresh 52-card deck using crypto-safe RNG
  const deck = shuffleDeckCrypto();
  const hand = deck.splice(0, 5);

  session.deck      = deck;
  session.hand      = hand;
  session.handWager = bet;
  session.stack    -= bet;
  session.phase     = 'dealt';
  session.lastDrawResult = null; // clear previous draw cache

  // TTL resets on every interaction
  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: POKER_SESSION_TTL });

  return json({
    ok: true,
    cards: hand.map(cardFromIndex),
    stack: session.stack,
    handWager: bet,
  });
}

// ---------------------------------------------------------------------------
// POST /poker/draw  { nonce, held: [bool,bool,bool,bool,bool] }
// Replace unheld cards, evaluate hand, adjust stack.
// ---------------------------------------------------------------------------
async function handlePokerDraw(request, env) {
  const { nonce, held, sessionToken } = await parseBody(request);
  if (nonce == null || !Array.isArray(held) || held.length !== 5) {
    return json({ error: 'Missing nonce or invalid held array' }, 400);
  }

  const key     = `poker:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No poker session' }, 403);
  if (!verifySessionToken(session, sessionToken)) {
    return json({ error: 'Invalid session token' }, 403);
  }

  // If already drawn, return cached result (handles network retry gracefully)
  if (session.phase === 'ready' && session.lastDrawResult) {
    return json(session.lastDrawResult);
  }

  if (session.phase !== 'dealt') {
    return json({ error: 'No hand dealt or already drawn' }, 400);
  }

  // Replace unheld cards
  let drawIdx = 0;
  for (let i = 0; i < 5; i++) {
    if (!held[i]) {
      session.hand[i] = session.deck[drawIdx++];
    }
  }

  const cards  = session.hand.map(cardFromIndex);
  const result = evaluatePokerHand(cards);
  const mult   = result ? POKER_PAYOUTS[result] : 0;
  const winnings = session.handWager * mult;

  session.stack += winnings;
  session.phase  = 'ready';
  session.deck   = null;
  session.hand   = null;

  // Cache draw result so retries return the same outcome
  const drawResponse = {
    ok: true,
    cards,
    hand: result,
    multiplier: mult,
    winnings,
    stack: session.stack,
  };
  session.lastDrawResult = drawResponse;

  // TTL resets on every interaction
  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: POKER_SESSION_TTL });

  return json(drawResponse);
}

// ---------------------------------------------------------------------------
// POST /poker/cashout  { tokenId, nonce }
// Sign final payout so player can claim on-chain.
// ---------------------------------------------------------------------------
async function handlePokerCashout(request, env) {
  const { tokenId, nonce, sessionToken } = await parseBody(request);
  if (tokenId == null || nonce == null) {
    return json({ error: 'Missing tokenId or nonce' }, 400);
  }

  const key     = `poker:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No poker session' }, 403);
  if (!verifySessionToken(session, sessionToken)) {
    return json({ error: 'Invalid session token' }, 403);
  }
  if (session.phase === 'dealt') {
    return json({ error: 'Finish current hand before cashing out' }, 400);
  }
  if (String(tokenId) !== session.tokenId) {
    return json({ error: 'Token mismatch' }, 403);
  }

  const payout = session.stack;

  // Skip signing if payout is 0 — no on-chain tx needed for losses
  if (payout === 0) {
    await env.RUNNER_KV.delete(key);
    return json({ ok: true, payout: 0, nonce: Number(nonce), signature: '0x' });
  }

  // Sign keccak256(tokenId, payout, nonce, player)
  const oracleWallet = new ethers.Wallet('0x' + env.ORACLE_PRIVATE_KEY);
  const messageHash  = ethers.solidityPackedKeccak256(
    ['uint256', 'uint256', 'uint256', 'address'],
    [BigInt(tokenId), BigInt(payout), BigInt(nonce), session.player]
  );
  const signature = await oracleWallet.signMessage(ethers.getBytes(messageHash));

  // Delete session — can't cash out twice
  await env.RUNNER_KV.delete(key);

  return json({ ok: true, payout, nonce: Number(nonce), signature });
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE CAGE — buy chips in to play, cash your stack back to your wallet.
//  The server tracks the authoritative play stack per token so a client can
//  never cash out more than it actually holds. Buy-in is verified on-chain via
//  the CageBuyIn event (proof the chips were burned).
//  NOTE: table wins/losses should adjust cage:{tokenId}.stack so that lost chips
//  stay burnt — wire the craps/blackjack settlement into this stack next.
// ═══════════════════════════════════════════════════════════════════════════
const CAGE_SESSION_TTL = 60 * 60 * 24 * 30;  // 30 days

// POST /cage/buyin  { tokenId, player, txHash }
async function handleCageBuyin(request, env) {
  const { tokenId, player, txHash } = await parseBody(request);
  if (tokenId == null || !player || !txHash) {
    return json({ error: 'Missing tokenId, player, or txHash' }, 400);
  }
  if (!ethers.isAddress(player)) return json({ error: 'Invalid player address' }, 400);

  const seenKey = `cage_tx:${String(txHash).toLowerCase()}`;
  if (await env.RUNNER_KV.get(seenKey)) return json({ error: 'Buy-in already registered' }, 409);

  const provider = new ethers.JsonRpcProvider(env.READ_RPC);
  const receipt  = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return json({ error: 'Transaction not found or failed' }, 400);

  // Find the CageBuyIn event from the Gamble contract in this tx (proves the burn)
  const iface = new ethers.Interface(GAMBLE_ABI);
  let amount = 0;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== env.GAMBLE_ADDRESS.toLowerCase()) continue;
    let parsed;
    try { parsed = iface.parseLog(log); } catch { continue; }
    if (parsed && parsed.name === 'CageBuyIn'
        && String(parsed.args.tokenId) === String(tokenId)
        && parsed.args.player.toLowerCase() === player.toLowerCase()) {
      amount = Number(parsed.args.amount);
      break;
    }
  }
  if (amount <= 0) return json({ error: 'No matching CageBuyIn in this transaction' }, 400);

  const key = `cage:${tokenId}`;
  const cur = (await env.RUNNER_KV.get(key, { type: 'json' })) || { player: player.toLowerCase(), stack: 0 };
  cur.player = player.toLowerCase();
  cur.stack  = (cur.stack || 0) + amount;
  delete cur.pendingCashout;   // fresh play
  await env.RUNNER_KV.put(key, JSON.stringify(cur), { expirationTtl: CAGE_SESSION_TTL });
  await env.RUNNER_KV.put(seenKey, '1', { expirationTtl: CAGE_SESSION_TTL });

  return json({ ok: true, credited: amount, stack: cur.stack });
}

// POST /cage/balance  { tokenId }  → the authoritative play stack
async function handleCageBalance(request, env) {
  const { tokenId } = await parseBody(request);
  if (tokenId == null) return json({ error: 'Missing tokenId' }, 400);
  const cur = (await env.RUNNER_KV.get(`cage:${tokenId}`, { type: 'json' })) || { stack: 0 };
  return json({ ok: true, stack: cur.stack || 0 });
}

// POST /cage/cashout  { tokenId, player }
// Signs the CURRENT server-tracked stack for on-chain cageCashOut. Idempotent:
// a retry returns the same signature (the on-chain usedNonces prevents double-mint).
async function handleCageCashout(request, env) {
  const { tokenId, player } = await parseBody(request);
  if (tokenId == null || !player) return json({ error: 'Missing tokenId or player' }, 400);
  if (!ethers.isAddress(player)) return json({ error: 'Invalid player address' }, 400);

  const key = `cage:${tokenId}`;
  const cur = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!cur) return json({ error: 'Nothing to cash out' }, 400);
  if (cur.player && cur.player.toLowerCase() !== player.toLowerCase()) {
    return json({ error: 'Player mismatch' }, 403);
  }
  if (cur.pendingCashout) return json({ ok: true, ...cur.pendingCashout });   // idempotent retry
  if ((cur.stack || 0) <= 0) return json({ error: 'Nothing to cash out' }, 400);

  const amount = cur.stack;
  // Fresh unused nonce, far above the sequential commitWager/cageBuyIn nonces
  const nonce = (BigInt(1) << BigInt(200)) + BigInt(Date.now()) * BigInt(1000) + BigInt(Math.floor(Math.random() * 1000));

  const oracleWallet = new ethers.Wallet('0x' + env.ORACLE_PRIVATE_KEY);
  const messageHash  = ethers.solidityPackedKeccak256(
    ['uint256', 'uint256', 'uint256', 'address'],
    [BigInt(tokenId), BigInt(amount), nonce, player]
  );
  const signature = await oracleWallet.signMessage(ethers.getBytes(messageHash));

  cur.pendingCashout = { amount, nonce: nonce.toString(), signature };
  cur.stack = 0;
  await env.RUNNER_KV.put(key, JSON.stringify(cur), { expirationTtl: CAGE_SESSION_TTL });

  return json({ ok: true, amount, nonce: nonce.toString(), signature });
}

// ---------------------------------------------------------------------------
// POST /poker/admin/reset-session  { key, nonce }
// Delete a stuck poker session from KV. Requires admin secret (first 16 chars of ORACLE_PRIVATE_KEY).
// ---------------------------------------------------------------------------
async function handlePokerAdminReset(request, env) {
  const body = await parseBody(request);
  const adminSecret = (env.ORACLE_PRIVATE_KEY || 'dev-key').slice(0, 16);
  if (!body.key || body.key !== adminSecret) return json({ error: 'Unauthorized' }, 403);
  if (body.nonce == null) return json({ error: 'Missing nonce' }, 400);

  const kvKey = `poker:${body.nonce}`;
  const session = await env.RUNNER_KV.get(kvKey, { type: 'json' });
  if (!session) return json({ error: 'No session found for that nonce' }, 404);

  await env.RUNNER_KV.delete(kvKey);
  return json({ ok: true, message: `Poker session for nonce ${body.nonce} deleted`, player: session.player, stack: session.stack });
}

// ═══════════════════════════════════════════════════════════════════════════
//  BLACKJACK ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// POST /blackjack/start  { tokenId, nonce, player }
async function handleBlackjackStart(request, env) {
  const { tokenId, nonce, player } = await parseBody(request);
  if (tokenId == null || nonce == null || !player) return json({ error: 'Missing fields' }, 400);
  if (!ethers.isAddress(player)) return json({ error: 'Invalid address' }, 400);

  const provider = new ethers.JsonRpcProvider(env.READ_RPC);
  const gamble   = new ethers.Contract(env.GAMBLE_ADDRESS, GAMBLE_ABI, provider);
  const wager    = Number(await gamble.wagerAmounts(BigInt(nonce)));
  if (wager === 0) return json({ error: 'No active wager' }, 403);
  const onChain = (await gamble.wagerPlayers(BigInt(nonce))).toLowerCase();
  if (onChain !== player.toLowerCase()) return json({ error: 'Player mismatch' }, 403);

  const sessionToken = await generateBlackjackToken(nonce, player.toLowerCase(), env);

  const key = `bj:${nonce}`;
  const existing = await env.RUNNER_KV.get(key, { type: 'json' });
  if (existing) {
    await env.RUNNER_KV.put(key, JSON.stringify(existing), { expirationTtl: BLACKJACK_SESSION_TTL });
    return json({ ok: true, stack: existing.stack, sessionToken });
  }

  await env.RUNNER_KV.put(key, JSON.stringify({
    tokenId: String(tokenId),
    player: player.toLowerCase(),
    stack: wager,
    phase: 'ready',  // ready | playing | resolved
    deck: null,
    playerHand: null,
    dealerHand: null,
    handWager: 0,
    lastResult: null,
    _expectedToken: sessionToken,
  }), { expirationTtl: BLACKJACK_SESSION_TTL });

  return json({ ok: true, stack: wager, sessionToken });
}

// POST /blackjack/deal  { nonce, handWager, sessionToken }
async function handleBlackjackDeal(request, env) {
  const { nonce, handWager, sessionToken } = await parseBody(request);
  if (nonce == null || handWager == null) return json({ error: 'Missing fields' }, 400);

  const key = `bj:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No session' }, 403);
  if (session._expectedToken !== sessionToken) return json({ error: 'Invalid token' }, 403);
  if (session.phase !== 'ready') return json({ error: 'Hand in progress' }, 400);

  const bet = Math.max(1, Math.min(Number(handWager), session.stack));
  const deck = shuffleDeckCrypto();

  const playerHand = [deck.pop(), deck.pop()];
  const dealerHand = [deck.pop(), deck.pop()];

  session.deck = deck;
  session.playerHand = playerHand;
  session.dealerHand = dealerHand;
  session.handWager = bet;
  session.stack -= bet;
  session.phase = 'playing';
  session.lastResult = null;

  // Check for natural blackjack
  const pVal = bjHandValue(playerHand);
  const dVal = bjHandValue(dealerHand);

  if (pVal === 21 && playerHand.length === 2) {
    // Player blackjack
    if (dVal === 21 && dealerHand.length === 2) {
      // Push — return bet
      session.stack += bet;
      session.phase = 'ready';
      session.lastResult = { result: 'push', payout: bet };
    } else {
      // Blackjack pays 3:2
      const payout = Math.floor(bet * 2.5);
      session.stack += payout;
      session.phase = 'ready';
      session.lastResult = { result: 'blackjack', payout };
    }
    await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: BLACKJACK_SESSION_TTL });
    return json({
      ok: true,
      playerCards: playerHand.map(cardFromIndex),
      dealerCards: dealerHand.map(cardFromIndex),  // reveal both on natural
      playerValue: pVal,
      dealerValue: dVal,
      result: session.lastResult.result,
      payout: session.lastResult.payout,
      stack: session.stack,
    });
  }

  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: BLACKJACK_SESSION_TTL });

  return json({
    ok: true,
    playerCards: playerHand.map(cardFromIndex),
    dealerCards: [cardFromIndex(dealerHand[0]), null],  // hide hole card
    playerValue: pVal,
    result: null,
    stack: session.stack,
  });
}

// POST /blackjack/hit  { nonce, sessionToken }
async function handleBlackjackHit(request, env) {
  const { nonce, sessionToken } = await parseBody(request);
  const key = `bj:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No session' }, 403);
  if (session._expectedToken !== sessionToken) return json({ error: 'Invalid token' }, 403);
  if (session.phase !== 'playing') return json({ error: 'No active hand' }, 400);

  session.playerHand.push(session.deck.pop());
  const pVal = bjHandValue(session.playerHand);

  if (pVal > 21) {
    // Bust
    session.phase = 'ready';
    session.lastResult = { result: 'bust', payout: 0 };
    await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: BLACKJACK_SESSION_TTL });
    return json({
      ok: true,
      playerCards: session.playerHand.map(cardFromIndex),
      dealerCards: session.dealerHand.map(cardFromIndex),
      playerValue: pVal,
      dealerValue: bjHandValue(session.dealerHand),
      result: 'bust',
      payout: 0,
      stack: session.stack,
    });
  }

  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: BLACKJACK_SESSION_TTL });
  return json({
    ok: true,
    playerCards: session.playerHand.map(cardFromIndex),
    dealerCards: [cardFromIndex(session.dealerHand[0]), null],
    playerValue: pVal,
    result: null,
    stack: session.stack,
  });
}

// POST /blackjack/stand  { nonce, sessionToken }
async function handleBlackjackStand(request, env) {
  const { nonce, sessionToken } = await parseBody(request);
  const key = `bj:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No session' }, 403);
  if (session._expectedToken !== sessionToken) return json({ error: 'Invalid token' }, 403);
  if (session.phase !== 'playing') return json({ error: 'No active hand' }, 400);

  return resolveBlackjackHand(session, key, env);
}

// POST /blackjack/double  { nonce, sessionToken }
async function handleBlackjackDouble(request, env) {
  const { nonce, sessionToken } = await parseBody(request);
  const key = `bj:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No session' }, 403);
  if (session._expectedToken !== sessionToken) return json({ error: 'Invalid token' }, 403);
  if (session.phase !== 'playing') return json({ error: 'No active hand' }, 400);
  if (session.playerHand.length !== 2) return json({ error: 'Can only double on first two cards' }, 400);

  const extraBet = Math.min(session.handWager, session.stack);
  session.stack -= extraBet;
  session.handWager += extraBet;

  // Take exactly one card
  session.playerHand.push(session.deck.pop());
  const pVal = bjHandValue(session.playerHand);

  if (pVal > 21) {
    session.phase = 'ready';
    session.lastResult = { result: 'bust', payout: 0 };
    await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: BLACKJACK_SESSION_TTL });
    return json({
      ok: true,
      playerCards: session.playerHand.map(cardFromIndex),
      dealerCards: session.dealerHand.map(cardFromIndex),
      playerValue: pVal,
      dealerValue: bjHandValue(session.dealerHand),
      result: 'bust',
      payout: 0,
      stack: session.stack,
    });
  }

  return resolveBlackjackHand(session, key, env);
}

// POST /blackjack/cashout  { tokenId, nonce, sessionToken }
async function handleBlackjackCashout(request, env) {
  const { tokenId, nonce, sessionToken } = await parseBody(request);
  if (tokenId == null || nonce == null) return json({ error: 'Missing fields' }, 400);

  const key = `bj:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No session' }, 403);
  if (session._expectedToken !== sessionToken) return json({ error: 'Invalid token' }, 403);
  if (session.phase === 'playing') return json({ error: 'Finish hand first' }, 400);
  if (String(tokenId) !== session.tokenId) return json({ error: 'Token mismatch' }, 403);

  const payout = session.stack;
  if (payout === 0) {
    await env.RUNNER_KV.delete(key);
    return json({ ok: true, payout: 0, nonce: Number(nonce), signature: '0x' });
  }

  const oracleWallet = new ethers.Wallet('0x' + env.ORACLE_PRIVATE_KEY);
  const messageHash  = ethers.solidityPackedKeccak256(
    ['uint256', 'uint256', 'uint256', 'address'],
    [BigInt(tokenId), BigInt(payout), BigInt(nonce), session.player]
  );
  const signature = await oracleWallet.signMessage(ethers.getBytes(messageHash));
  await env.RUNNER_KV.delete(key);

  return json({ ok: true, payout, nonce: Number(nonce), signature });
}

// ── Blackjack helpers ──

/** Dealer plays: hit on soft 17 and below, stand on hard 17+ */
async function resolveBlackjackHand(session, key, env) {
  // Dealer draws
  while (bjHandValue(session.dealerHand) < 17) {
    session.dealerHand.push(session.deck.pop());
  }

  const pVal = bjHandValue(session.playerHand);
  const dVal = bjHandValue(session.dealerHand);
  let result, payout;

  if (dVal > 21) {
    result = 'dealer_bust'; payout = session.handWager * 2;
  } else if (pVal > dVal) {
    result = 'win'; payout = session.handWager * 2;
  } else if (pVal === dVal) {
    result = 'push'; payout = session.handWager;
  } else {
    result = 'lose'; payout = 0;
  }

  session.stack += payout;
  session.phase = 'ready';
  session.lastResult = { result, payout };

  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: BLACKJACK_SESSION_TTL });

  return json({
    ok: true,
    playerCards: session.playerHand.map(cardFromIndex),
    dealerCards: session.dealerHand.map(cardFromIndex),
    playerValue: pVal,
    dealerValue: dVal,
    result,
    payout,
    stack: session.stack,
  });
}

/** Calculate best hand value (aces count as 11 or 1) */
function bjHandValue(hand) {
  let total = 0, aces = 0;
  for (const idx of hand) {
    const rank = idx % 13; // 0=2, 1=3, ..., 8=10, 9=J, 10=Q, 11=K, 12=A
    if (rank === 12) { aces++; total += 11; }
    else if (rank >= 8) { total += 10; } // 10, J, Q, K
    else { total += rank + 2; }
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

async function generateBlackjackToken(nonce, player, env) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.ORACLE_PRIVATE_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const data = new TextEncoder().encode(`blackjack:${nonce}:${player}`);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Poker helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Anti-cheat: HMAC session token — ties session to nonce+player, no extra txs
// ---------------------------------------------------------------------------
async function generateSessionToken(nonce, player, env) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.ORACLE_PRIVATE_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = new TextEncoder().encode(`poker:${nonce}:${player}`);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function verifySessionToken(session, sessionToken) {
  if (!session._expectedToken || !sessionToken) return false; // fail closed
  return session._expectedToken === sessionToken;
}

/** Fisher-Yates shuffle using crypto.getRandomValues for manipulation resistance */
function shuffleDeckCrypto() {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  const rng  = new Uint32Array(52);
  crypto.getRandomValues(rng);
  for (let i = 51; i > 0; i--) {
    const j = rng[i] % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CRAPS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// POST /craps/start  { tokenId, nonce, player, tableCode }
// Verifies on-chain wager, generates session token, registers player in the
// CrapsTable Durable Object. Game state lives entirely in the DO — no KV.
async function handleCrapsStart(request, env) {
  const { tokenId, nonce, player, tableCode } = await parseBody(request);
  if (tokenId == null || nonce == null || !player) {
    return json({ error: 'Missing tokenId, nonce, or player' }, 400);
  }
  if (!ethers.isAddress(player)) {
    return json({ error: 'Invalid player address' }, 400);
  }

  // Check if nonce was already cashed out (KV marker persists after DO cleanup)
  const cashoutKey = `craps_done:${nonce}`;
  const alreadyCashedOut = await env.RUNNER_KV.get(cashoutKey);
  if (alreadyCashedOut) {
    return json({ error: 'Nonce already used' }, 403);
  }

  // Verify wager on-chain
  const provider = new ethers.JsonRpcProvider(env.READ_RPC);
  const gamble   = new ethers.Contract(env.GAMBLE_ADDRESS, GAMBLE_ABI, provider);

  const used = await gamble.usedNonces(BigInt(nonce));
  if (used) {
    return json({ error: 'Nonce already claimed on-chain' }, 403);
  }

  const wager = Number(await gamble.wagerAmounts(BigInt(nonce)));
  if (wager === 0) {
    return json({ error: 'No active wager for this nonce' }, 403);
  }
  const onChainPlayer = (await gamble.wagerPlayers(BigInt(nonce))).toLowerCase();
  if (onChainPlayer !== player.toLowerCase()) {
    return json({ error: 'Player mismatch' }, 403);
  }

  const { token: sessionToken, timestamp: sessionTokenTs } = await generateCrapsSessionToken(nonce, player.toLowerCase(), env);

  // Register player in the CrapsTable Durable Object (if tableCode provided).
  // If no tableCode yet (player picks table on craps.html), the DO registration
  // happens when the client sends the 'auth' WS message — the DO verifies the HMAC token.
  // We still pre-register if we have the table so the player data is ready.
  if (tableCode) {
    if (isValidTable(tableCode)) {
      try {
        const doId = env.CRAPS_TABLE.idFromName(tableCode);
        const stub = env.CRAPS_TABLE.get(doId);
        await stub.fetch(new Request('https://do/register', {
          method: 'POST',
          body: JSON.stringify({
            nonce:        String(nonce),
            tokenId:      String(tokenId),
            player:       player.toLowerCase(),
            stack:        wager,
            sessionToken,
            sessionTokenTs,
            buyIn:        wager,
          }),
        }));
      } catch (_) { /* best-effort; auth WS message will retry */ }
    }
  }

  return json({ ok: true, stack: wager, sessionToken, sessionTokenTs });
}

// POST /craps/cashout  { tokenId, nonce, sessionToken, sessionTokenTs, tableCode }
// Fetches player state from the CrapsTable DO, signs the payout, cleans up.
async function handleCrapsCashout(request, env) {
  const { tokenId, nonce, sessionToken, sessionTokenTs, tableCode } = await parseBody(request);
  if (tokenId == null || nonce == null || !sessionToken) {
    return json({ error: 'Missing tokenId, nonce, or sessionToken' }, 400);
  }

  // Quick-reject if KV already marked (avoids unnecessary DO call).
  // The DO itself is the true serialization point — it caches the cashout
  // result so duplicate requests return the same response idempotently.
  const cashoutKey = `craps_done:${nonce}`;
  const alreadyCashedOut = await env.RUNNER_KV.get(cashoutKey);
  if (alreadyCashedOut) {
    return json({ error: 'Already cashed out' }, 403);
  }

  // Fetch player state from DO and remove them from the table
  if (!tableCode) return json({ error: 'Missing tableCode' }, 400);
  if (!isValidTable(tableCode)) return json({ error: 'Invalid table' }, 400);

  const doId  = env.CRAPS_TABLE.idFromName(tableCode);
  const stub  = env.CRAPS_TABLE.get(doId);
  const doRes = await stub.fetch(new Request('https://do/cashout', {
    method: 'POST',
    body: JSON.stringify({ nonce: String(nonce), sessionToken, sessionTokenTs }),
  }));
  const cashoutData = await doRes.json();

  if (!cashoutData.ok) {
    return json({ error: cashoutData.error || 'Cashout failed' }, doRes.status);
  }

  const payout = cashoutData.payout;
  const playerAddr = cashoutData.player;

  if (String(tokenId) !== cashoutData.tokenId) {
    return json({ error: 'Token mismatch' }, 403);
  }

  // Mark nonce in KV as a fast-path reject for future requests.
  // The DO's idempotency cache is the true guard against double-cashout.
  await env.RUNNER_KV.put(cashoutKey, '1', { expirationTtl: 86_400 });

  if (payout === 0) {
    return json({ ok: true, payout: 0, nonce: Number(nonce), signature: '0x' });
  }

  const oracleWallet = new ethers.Wallet('0x' + env.ORACLE_PRIVATE_KEY);
  const messageHash  = ethers.solidityPackedKeccak256(
    ['uint256', 'uint256', 'uint256', 'address'],
    [BigInt(tokenId), BigInt(payout), BigInt(nonce), playerAddr]
  );
  const signature = await oracleWallet.signMessage(ethers.getBytes(messageHash));

  return json({ ok: true, payout, nonce: Number(nonce), signature });
}

// ── Removed: crapsResolveBets, crapsCalcOdds, verifyCrapsSessionToken ──
// All game logic now lives in the CrapsTable Durable Object (craps-table.js).


async function generateCrapsSessionToken(nonce, player, env) {
  const timestamp = Date.now();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.ORACLE_PRIVATE_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = new TextEncoder().encode(`craps:${nonce}:${player}:${timestamp}`);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const token = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { token, timestamp };
}


/** Convert card index (0-51) to { rank: 0-12, suit: 0-3 } */
function cardFromIndex(idx) {
  return { rank: idx % 13, suit: Math.floor(idx / 13) };
}

/** Evaluate a 5-card poker hand (Jacks or Better). Returns hand name or null. */
function evaluatePokerHand(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => a - b);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  let isStraight = false;
  if (new Set(ranks).size === 5) {
    if (ranks[4] - ranks[0] === 4) isStraight = true;
    // Ace-low straight: A-2-3-4-5  (ranks 0,1,2,3,12)
    if (ranks[0] === 0 && ranks[1] === 1 && ranks[2] === 2 && ranks[3] === 3 && ranks[4] === 12) isStraight = true;
  }

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const freq = Object.values(counts).sort((a, b) => b - a);

  if (isFlush && isStraight && ranks[0] === 8 && ranks[4] === 12) return 'ROYAL FLUSH';
  if (isFlush && isStraight) return 'STRAIGHT FLUSH';
  if (freq[0] === 4) return 'FOUR OF A KIND';
  if (freq[0] === 3 && freq[1] === 2) return 'FULL HOUSE';
  if (isFlush) return 'FLUSH';
  if (isStraight) return 'STRAIGHT';
  if (freq[0] === 3) return 'THREE OF A KIND';
  if (freq[0] === 2 && freq[1] === 2) return 'TWO PAIR';
  if (freq[0] === 2) {
    const pairRank = parseInt(Object.entries(counts).find(([, c]) => c === 2)[0]);
    if (pairRank >= 9) return 'JACKS OR BETTER'; // J=9, Q=10, K=11, A=12
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function parseBody(request) {
  try { return await request.json(); } catch { return {}; }
}

let _currentCors = {};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ..._currentCors },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  CRAPS TABLE — WebSocket routing via Durable Objects
// ═══════════════════════════════════════════════════════════════════════════

// GET /craps/ws?table=X&playerId=Y&name=Z&chadId=N  (WebSocket upgrade)
// Routes the connection to the CrapsTable Durable Object for that table.
async function handleCrapsWebSocket(request, url, env) {
  const table = url.searchParams.get('table');
  if (!table) {
    return new Response(JSON.stringify({ error: 'Missing table' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ..._currentCors },
    });
  }

  // Validate table name
  if (!isValidTable(table)) {
    return new Response(JSON.stringify({ error: 'Invalid table name' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ..._currentCors },
    });
  }

  // Route to the Durable Object (one DO per table)
  const id = env.CRAPS_TABLE.idFromName(table);
  const stub = env.CRAPS_TABLE.get(id);

  // If table has 0 players (including no grace-period reconnects), hard-reset all DO state.
  // This nukes stale game state left by zombie Hibernation sockets.
  // We use allCount (not count) so a briefly-disconnected player reconnecting doesn't
  // accidentally wipe their own session data.
  try {
    const infoRes = await stub.fetch(new Request('https://do/info'));
    const info = await infoRes.json();
    if ((info.count || 0) === 0 && (info.allCount || 0) === 0) {
      await stub.fetch(new Request('https://do/reset', { method: 'POST' }));
    }
  } catch (_) { /* best-effort; proceed with WS upgrade either way */ }

  // Forward the entire request (including Upgrade headers + query params)
  return stub.fetch(request);
}

// GET /tables/list — returns player counts by querying each public table's DO
async function handleTableList(env) {
  const tables = [];

  // Query all public table DOs in parallel
  const queries = PUBLIC_TABLES.map(async (t) => {
    try {
      const id = env.CRAPS_TABLE.idFromName(t.name);
      const stub = env.CRAPS_TABLE.get(id);
      const res = await stub.fetch(new Request('https://do/info'));
      const data = await res.json();
      return {
        name: t.name,
        label: t.label,
        players: data.count || 0,
        maxPlayers: MAX_PLAYERS_PER_TABLE,
      };
    } catch (_) {
      return {
        name: t.name,
        label: t.label,
        players: 0,
        maxPlayers: MAX_PLAYERS_PER_TABLE,
      };
    }
  });

  const results = await Promise.all(queries);
  return json({
    tables: results,
    limits: { maxPublic: MAX_PUBLIC_TABLES, maxPrivate: MAX_PRIVATE_TABLES, maxPerTable: MAX_PLAYERS_PER_TABLE },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  AGORA RTC TOKEN GENERATION (AccessToken v006)
// ═══════════════════════════════════════════════════════════════════════════

// POST /agora/token  { channelName, uid }
async function handleAgoraToken(request, env) {
  const { channelName, uid } = await parseBody(request);
  if (!channelName) return json({ error: 'Missing channelName' }, 400);

  const appId = (env.AGORA_APP_ID || '').trim();
  const appCert = (env.AGORA_APP_CERT || '').trim();
  if (!appId || !appCert) return json({ error: 'Agora not configured' }, 500);

  const uidStr = String(uid || 0);
  const expireTs = Math.floor(Date.now() / 1000) + 21600; // 6 hours (covers 5h max session)

  // Privileges: joinChannel(1), publishAudio(2), publishVideo(3), publishData(4)
  const privileges = { 1: expireTs, 2: expireTs, 3: expireTs, 4: expireTs };

  const token = await buildAgoraToken006(appId, appCert, channelName, uidStr, privileges);
  return json({ token });
}

// --- Agora AccessToken v006 implementation ---

async function hmacSha256(keyBytes, dataBytes) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
  return new Uint8Array(sig);
}

function putUint16LE(arr, val) {
  arr.push(val & 0xff, (val >> 8) & 0xff);
}

function putUint32LE(arr, val) {
  arr.push(val & 0xff, (val >> 8) & 0xff, (val >> 16) & 0xff, (val >> 24) & 0xff);
}

function putString(arr, str) {
  const bytes = new TextEncoder().encode(str);
  putUint16LE(arr, bytes.length);
  for (const b of bytes) arr.push(b);
}

function putBytes(arr, bytes) {
  putUint16LE(arr, bytes.length);
  for (const b of bytes) arr.push(b);
}

function putTreeMapUInt32(arr, map) {
  const entries = Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0]));
  putUint16LE(arr, entries.length);
  for (const [k, v] of entries) {
    putUint16LE(arr, Number(k));
    putUint32LE(arr, v);
  }
}

function uint32LEBytes(val) {
  return new Uint8Array([val & 0xff, (val >> 8) & 0xff, (val >> 16) & 0xff, (val >> 24) & 0xff]);
}

// CRC32 (ISO 3309)
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    table[i] = crc;
  }
  return table;
})();

function crc32(str) {
  const bytes = new TextEncoder().encode(str);
  let crc = 0xFFFFFFFF;
  for (const b of bytes) crc = CRC32_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function buildAgoraToken006(appId, appCert, channelName, uidStr, privileges) {
  // Random salt and expiry timestamp
  const saltArr = new Uint32Array(1);
  crypto.getRandomValues(saltArr);
  const salt = saltArr[0];
  const ts = Math.floor(Date.now() / 1000) + 86400; // token struct expires in 24h

  // Build signing key: HMAC chain
  const appIdBytes = new TextEncoder().encode(appId);
  const appCertBytes = new TextEncoder().encode(appCert);
  let signing = await hmacSha256(appCertBytes, appIdBytes);
  signing = await hmacSha256(signing, uint32LEBytes(salt));
  signing = await hmacSha256(signing, uint32LEBytes(ts));

  // Build message content: salt + ts + services
  // AccessToken2 (006) requires privileges wrapped in a service map
  const content = [];
  putUint32LE(content, salt);
  putUint32LE(content, ts);
  // Services map: count=1, then service type 1 (kRtc) with its privileges
  putUint16LE(content, 1);       // 1 service
  putUint16LE(content, 1);       // service type = kRtc
  putTreeMapUInt32(content, privileges);
  const contentBytes = new Uint8Array(content);

  // Sign content
  const signature = await hmacSha256(signing, contentBytes);

  // CRC32 of channel name and uid
  const crcChannel = crc32(channelName);
  const crcUid = crc32(uidStr);

  // Pack: string(signature) + uint32(crcChannel) + uint32(crcUid) + string(content)
  const buf = [];
  putBytes(buf, signature);
  putUint32LE(buf, crcChannel);
  putUint32LE(buf, crcUid);
  putBytes(buf, contentBytes);

  // Base64 encode
  const packed = new Uint8Array(buf);
  const b64 = btoa(String.fromCharCode(...packed));

  return '006' + appId + b64;
}


// ── Freeplay Leaderboard ──
const FREEPLAY_LB_KEY = 'freeplay:leaderboard';
const FREEPLAY_LB_MAX = 50;

async function handleFreeplayLeaderboard(env) {
  const lb = await env.RUNNER_KV.get(FREEPLAY_LB_KEY, { type: 'json' }) || [];
  return json({ ok: true, leaderboard: lb.slice(0, 20) });
}

async function handleFreeplayScore(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  const { name, chips } = body;
  if (!name || typeof name !== 'string' || name.length > 32) return json({ error: 'invalid name' }, 400);
  if (!chips || typeof chips !== 'number' || chips <= 100) return json({ error: 'score must beat 100' }, 400);

  const lb = await env.RUNNER_KV.get(FREEPLAY_LB_KEY, { type: 'json' }) || [];
  lb.push({ name: name.trim(), chips, date: new Date().toISOString().slice(0, 10) });
  lb.sort((a, b) => b.chips - a.chips);
  await env.RUNNER_KV.put(FREEPLAY_LB_KEY, JSON.stringify(lb.slice(0, FREEPLAY_LB_MAX)));
  return json({ ok: true, rank: lb.findIndex(e => e.name === name.trim() && e.chips === chips) + 1 });
}

// ══════════════════════════════════════════════════════════════════════════
//  HASHCASH CRAPS — No crypto, multiplayer, 24h cooldown
// ══════════════════════════════════════════════════════════════════════════

// POST /hashcash/join  { username }
// Checks username ownership, 24h cooldown, generates session token.
async function handleHashCashJoin(request, env) {
  const body = await parseBody(request);
  let username = (body.username || '').trim();
  if (!username || username.length > 32) return json({ error: 'Invalid username' }, 400);

  // Sanitize: alphanumeric + spaces only, strip unicode tricks
  username = username.replace(/[^a-zA-Z0-9 _-]/g, '');
  if (!username) return json({ error: 'Invalid username — letters and numbers only' }, 400);

  const password = (body.password || '').toString();
  if (!password || password.length < 4) return json({ error: 'Password must be at least 4 characters' }, 400);

  // Hash password with HMAC so we never store plaintext
  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  const enc = new TextEncoder();
  const pwKey = await crypto.subtle.importKey('raw', enc.encode(oracleKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const pwSig = await crypto.subtle.sign('HMAC', pwKey, enc.encode(`pw:${username.toLowerCase()}:${password}`));
  const passHash = btoa(String.fromCharCode(...new Uint8Array(pwSig)));

  const userKey = `hashcash:user:${username.toLowerCase()}`;
  const existingUser = await env.RUNNER_KV.get(userKey);

  if (existingUser) {
    // Username already registered — verify password
    let userData;
    try { userData = JSON.parse(existingUser); } catch (_) { userData = {}; }
    if (userData.passHash) {
      // Has password — verify it
      if (passHash !== userData.passHash) {
        return json({ error: 'Wrong password', wrongPass: true }, 403);
      }
    } else {
      // Legacy or corrupted entry — upgrade to password auth
      await env.RUNNER_KV.put(userKey, JSON.stringify({ username, passHash, registeredAt: userData.registeredAt || Date.now() }));
    }
  } else {
    // New registration — store username + hashed password permanently
    await env.RUNNER_KV.put(userKey, JSON.stringify({ username, passHash, registeredAt: Date.now() }));
  }

  // Generate HMAC session token (deterministic per username+key so DO can verify)
  const tokenData = `hashcash:${username.toLowerCase()}`;
  const stKey = await crypto.subtle.importKey('raw', enc.encode(oracleKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const stSig = await crypto.subtle.sign('HMAC', stKey, enc.encode(tokenData));
  const sessionToken = btoa(String.fromCharCode(...new Uint8Array(stSig))).slice(0, 32);

  // Load saved chips (permanent)
  const chipsKey = `hashcash:chips:${username.toLowerCase()}`;
  const savedRaw = await env.RUNNER_KV.get(chipsKey);
  let chipData = null;
  try { chipData = savedRaw ? JSON.parse(savedRaw) : null; } catch (_) {}

  let stack = 0;
  let dailyBonus = false;
  const BONUS_INTERVAL = HASHCASH_COOLDOWN_TTL * 1000; // 24h in ms

  if (chipData) {
    // Returning player — restore saved chips
    stack = chipData.stack || 0;
    const lastBonus = chipData.lastBonusAt || 0;
    // Check if 24h+ since last bonus
    if (Date.now() - lastBonus >= BONUS_INTERVAL) {
      stack += 100;
      dailyBonus = true;
    }
  } else {
    // Brand new player — first 100 chips
    stack = 100;
    dailyBonus = true;
  }

  // Save updated chips with bonus timestamp
  await env.RUNNER_KV.put(chipsKey, JSON.stringify({
    stack,
    lastBonusAt: dailyBonus ? Date.now() : (chipData?.lastBonusAt || Date.now()),
    savedAt: Date.now(),
  }));

  return json({ ok: true, username, sessionToken, stack, dailyBonus });
}

// GET /hashcash/ws?table=X&username=Y&sessionToken=Z  (WebSocket upgrade)
async function handleHashCashWebSocket(request, url, env) {
  const table = url.searchParams.get('table');
  if (!table) return json({ error: 'Missing table' }, 400);
  if (!isValidHashCashTable(table)) return json({ error: 'Invalid table' }, 400);

  const id = env.HASHCASH_TABLE.idFromName(table);
  const stub = env.HASHCASH_TABLE.get(id);

  // Reset empty tables to clear zombie state
  try {
    const infoRes = await stub.fetch(new Request('https://do/info'));
    const info = await infoRes.json();
    if ((info.count || 0) === 0) {
      await stub.fetch(new Request('https://do/reset', { method: 'POST' }));
    }
  } catch (_) {}

  return stub.fetch(request);
}

// POST /hashcash/lockin  { username, sessionToken, table }
async function handleHashCashLockin(request, env) {
  const body = await parseBody(request);
  const { username, sessionToken, table } = body;
  if (!username || typeof username !== 'string') return json({ error: 'Invalid username' }, 400);
  if (!table || !isValidHashCashTable(table)) return json({ error: 'Invalid table' }, 400);

  // Verify sessionToken matches — regenerate HMAC and compare
  if (!sessionToken) return json({ error: 'Missing sessionToken' }, 403);
  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  const tokenData = `hashcash:${username.toLowerCase()}`;
  const encoder = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey('raw', encoder.encode(oracleKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(tokenData));
  const expectedToken = btoa(String.fromCharCode(...new Uint8Array(sig))).slice(0, 32);
  if (sessionToken !== expectedToken) return json({ error: 'Unauthorized' }, 403);

  // Forward to DO — it calculates score from stack+bets and removes the player
  const id = env.HASHCASH_TABLE.idFromName(table);
  const stub = env.HASHCASH_TABLE.get(id);
  const doRes = await stub.fetch(new Request('https://do/lockin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  }));
  const doData = await doRes.json();
  if (!doData.ok) return json(doData, doRes.status);

  const score = doData.score;
  let rank = null;
  let onLeaderboard = false;

  // Save to leaderboard if score > 0
  if (score > 0) {
    const lb = await env.RUNNER_KV.get(HASHCASH_LB_KEY, { type: 'json' }) || [];
    // Check if score qualifies for top 10
    const qualifies = lb.length < HASHCASH_LB_MAX || score > (lb[lb.length - 1]?.chips || 0);
    if (qualifies) {
      lb.push({ name: username.trim(), chips: score, date: new Date().toISOString().slice(0, 10) });
      lb.sort((a, b) => b.chips - a.chips);
      const trimmed = lb.slice(0, HASHCASH_LB_MAX);
      await env.RUNNER_KV.put(HASHCASH_LB_KEY, JSON.stringify(trimmed));
      rank = trimmed.findIndex(e => e.name === username.trim() && e.chips === score) + 1;
      onLeaderboard = true;
    }
  }

  // Reset saved chips to 0 but keep lastBonusAt for daily bonus tracking
  const chipsKeyLock = `hashcash:chips:${username.toLowerCase()}`;
  const existingChipsRaw = await env.RUNNER_KV.get(chipsKeyLock);
  let lockLastBonus = Date.now();
  try {
    const ec = existingChipsRaw ? JSON.parse(existingChipsRaw) : null;
    if (ec?.lastBonusAt) lockLastBonus = ec.lastBonusAt;
  } catch (_) {}
  await env.RUNNER_KV.put(chipsKeyLock, JSON.stringify({ stack: 0, lastBonusAt: lockLastBonus, savedAt: Date.now() }));

  return json({ ok: true, score, rank, onLeaderboard });
}

// GET /hashcash/tables — public table player counts
async function handleHashCashTableList(env) {
  const queries = HASHCASH_PUBLIC_TABLES.map(async (t) => {
    try {
      const id = env.HASHCASH_TABLE.idFromName(t.name);
      const stub = env.HASHCASH_TABLE.get(id);
      const res = await stub.fetch(new Request('https://do/info'));
      const data = await res.json();
      return { name: t.name, label: t.label, players: data.count || 0, maxPlayers: MAX_PLAYERS_PER_TABLE };
    } catch (_) {
      return { name: t.name, label: t.label, players: 0, maxPlayers: MAX_PLAYERS_PER_TABLE };
    }
  });
  const tables = await Promise.all(queries);
  return json({ tables });
}

// GET /hashcash/leaderboard
async function handleHashCashLeaderboard(env) {
  const lb = await env.RUNNER_KV.get(HASHCASH_LB_KEY, { type: 'json' }) || [];
  return json({ ok: true, leaderboard: lb.slice(0, HASHCASH_LB_MAX) });
}

// POST /hashcash/save-chips  { username, sessionToken, stack }
// Called when player leaves the table without locking in
async function handleHashCashSaveChips(request, env) {
  const body = await parseBody(request);
  const { username, sessionToken, stack } = body;
  if (!username || typeof username !== 'string') return json({ error: 'Invalid username' }, 400);
  if (typeof stack !== 'number' || stack < 0) return json({ error: 'Invalid stack' }, 400);

  // Verify sessionToken
  if (!sessionToken) return json({ error: 'Missing sessionToken' }, 403);
  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  const enc = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey('raw', enc.encode(oracleKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(`hashcash:${username.toLowerCase()}`));
  const expectedToken = btoa(String.fromCharCode(...new Uint8Array(sig))).slice(0, 32);
  if (sessionToken !== expectedToken) return json({ error: 'Unauthorized' }, 403);

  // Save chips permanently — preserve lastBonusAt from existing data
  const chipsKey = `hashcash:chips:${username.toLowerCase()}`;
  const existingRaw = await env.RUNNER_KV.get(chipsKey);
  let lastBonusAt = Date.now();
  try {
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    if (existing?.lastBonusAt) lastBonusAt = existing.lastBonusAt;
  } catch (_) {}

  await env.RUNNER_KV.put(chipsKey, JSON.stringify({
    stack: Math.floor(stack),
    lastBonusAt,
    savedAt: Date.now(),
  }));

  return json({ ok: true, saved: Math.floor(stack) });
}

// POST /hashcash/admin/reset-leaderboard  { key }
async function handleHashCashResetLeaderboard(request, env) {
  const body = await parseBody(request);
  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  const adminSecret = oracleKey.slice(0, 16);
  if (!body.key || body.key !== adminSecret) return json({ error: 'Unauthorized' }, 403);
  await env.RUNNER_KV.delete(HASHCASH_LB_KEY);
  return json({ ok: true, message: 'Leaderboard reset' });
}

// POST /hashcash/admin/delete-entry  { key, name, index? }
// Deletes a specific player's entry (or all entries by that name)
async function handleHashCashDeleteEntry(request, env) {
  const body = await parseBody(request);
  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  const adminSecret = oracleKey.slice(0, 16);
  if (!body.key || body.key !== adminSecret) return json({ error: 'Unauthorized' }, 403);
  if (!body.name) return json({ error: 'Missing name' }, 400);

  const lb = await env.RUNNER_KV.get(HASHCASH_LB_KEY, { type: 'json' }) || [];
  const before = lb.length;
  const filtered = typeof body.index === 'number'
    ? lb.filter((_, i) => i !== body.index)
    : lb.filter(e => e.name.toLowerCase() !== body.name.toLowerCase());
  await env.RUNNER_KV.put(HASHCASH_LB_KEY, JSON.stringify(filtered));
  return json({ ok: true, removed: before - filtered.length, remaining: filtered.length });
}

// ══════════════════════════════════════════════════════════════════════════
//  AVAX PIE FACE — Shared leaderboard + accounts
// ══════════════════════════════════════════════════════════════════════════

const PIEFACE_LB_KEY    = 'pieface:leaderboard';
const PIEFACE_LB_MAX    = 5;
const PIEFACE_MAX_SCORE = 2000; // max possible: 6 slots × ceil(60000/1850ms) × 10pts ≈ 1980
const PIEFACE_INITIAL_ATTEMPTS = 2;   // given on account creation
const PIEFACE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24-hour cooldown then 1 attempt

async function pfSessionToken(username, oracleKey) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(oracleKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`pieface:session:${username.toLowerCase()}`));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).slice(0, 32);
}

// POST /pieface/play  { username }
// Creates account if new, returns existing if known. No password.
async function handlePieFacePlay(request, env) {
  const body = await parseBody(request);
  let username = (body.username || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '');
  if (!username || username.length < 2 || username.length > 24)
    return json({ error: 'Name must be 2–24 characters' }, 400);

  const userKey = `pieface:user:${username.toLowerCase()}`;
  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  const sessionToken = await pfSessionToken(username, oracleKey);

  let userData = await env.RUNNER_KV.get(userKey, { type: 'json' });
  if (!userData) {
    // New player — create account
    userData = { attempts: PIEFACE_INITIAL_ATTEMPTS, lastAttemptUsed: 0, highScore: 0 };
    await env.RUNNER_KV.put(userKey, JSON.stringify(userData));
  }

  const availableAttempts = pfGetAvailableAttempts(userData);
  const secondsLeft = pfSecondsLeft(userData);

  return json({ ok: true, sessionToken, username, attempts: availableAttempts, secondsLeft, highScore: userData.highScore || 0 });
}

// GET /pieface/leaderboard
async function handlePieFaceLeaderboard(env) {
  const lb = await env.RUNNER_KV.get(PIEFACE_LB_KEY, { type: 'json' }) || [];
  return json({ ok: true, leaderboard: lb });
}

// Returns how many attempts the user currently has (banked + possible cooldown refresh)
function pfGetAvailableAttempts(userData) {
  if ((userData.attempts || 0) > 0) return userData.attempts;
  // No banked attempts — check if 24h cooldown has elapsed
  const elapsed = Date.now() - (userData.lastAttemptUsed || 0);
  return elapsed >= PIEFACE_COOLDOWN_MS ? 1 : 0;
}

// Returns seconds until next attempt (0 if attempts available)
function pfSecondsLeft(userData) {
  if (pfGetAvailableAttempts(userData) > 0) return 0;
  const elapsed = Date.now() - (userData.lastAttemptUsed || 0);
  return Math.max(0, Math.ceil((PIEFACE_COOLDOWN_MS - elapsed) / 1000));
}

function pfFormatCooldown(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// POST /pieface/use-attempt  { username, sessionToken }
async function handlePieFaceUseAttempt(request, env) {
  const body = await parseBody(request);
  const { username, sessionToken } = body;
  if (!username || !sessionToken) return json({ error: 'Missing auth' }, 403);

  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  const expected = await pfSessionToken(username, oracleKey);
  if (sessionToken !== expected) return json({ error: 'Unauthorized' }, 403);

  const userKey = `pieface:user:${username.toLowerCase()}`;
  const userData = await env.RUNNER_KV.get(userKey, { type: 'json' });
  if (!userData) return json({ error: 'User not found' }, 404);

  const available = pfGetAvailableAttempts(userData);
  if (available <= 0) {
    const sLeft = pfSecondsLeft(userData);
    return json({ error: `No attempts remaining. Next attempt in ${pfFormatCooldown(sLeft)}.`, attempts: 0, secondsLeft: sLeft }, 400);
  }

  // If the available attempt came from cooldown (not banked), don't decrement — it's 0 already
  if ((userData.attempts || 0) > 0) {
    userData.attempts -= 1;
  }
  userData.lastAttemptUsed = Date.now();
  await env.RUNNER_KV.put(userKey, JSON.stringify(userData));
  // secondsLeft after using last attempt = full cooldown duration
  const remainingAttempts = Math.max(0, userData.attempts || 0);
  const secondsLeft = remainingAttempts > 0 ? 0 : PIEFACE_COOLDOWN_MS / 1000;
  return json({ ok: true, attempts: remainingAttempts, secondsLeft });
}

// GET /pieface/reset-leaderboard?secret=<ORACLE_PRIVATE_KEY>
async function handlePieFaceResetLeaderboard(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');
  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  if (!secret || secret !== oracleKey) return json({ error: 'Unauthorized' }, 403);
  await env.RUNNER_KV.put(PIEFACE_LB_KEY, JSON.stringify([]));
  return json({ ok: true, message: 'Leaderboard cleared' });
}

// GET /pieface/delete-entry?secret=<key>&username=<username>
async function handlePieFaceDeleteEntry(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');
  const target = (url.searchParams.get('username') || '').toLowerCase().trim();
  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  if (!secret || secret !== oracleKey) return json({ error: 'Unauthorized' }, 403);
  if (!target) return json({ error: 'username param required' }, 400);

  const lb = await env.RUNNER_KV.get(PIEFACE_LB_KEY, { type: 'json' }) || [];
  const before = lb.length;
  const updated = lb.filter(e => e.username.toLowerCase() !== target);
  await env.RUNNER_KV.put(PIEFACE_LB_KEY, JSON.stringify(updated));
  return json({ ok: true, removed: before - updated.length, leaderboard: updated });
}

// POST /pieface/score  { username, sessionToken, score, clickCount }
async function handlePieFaceScore(request, env) {
  const body = await parseBody(request);
  const { username, sessionToken, score, clickCount } = body;
  if (!username || !sessionToken) return json({ error: 'Missing auth' }, 403);
  if (typeof score !== 'number' || score < 0) return json({ error: 'Invalid score' }, 400);

  const oracleKey = env.ORACLE_PRIVATE_KEY || 'dev-key';
  const expected = await pfSessionToken(username, oracleKey);
  if (sessionToken !== expected) return json({ error: 'Unauthorized' }, 403);

  // Anti-cheat: score must equal clickCount × 10
  if (typeof clickCount === 'number' && score !== clickCount * 10)
    return json({ error: 'Score validation failed' }, 400);

  const cappedScore = Math.min(score, PIEFACE_MAX_SCORE);

  // Update user high score
  const userKey = `pieface:user:${username.toLowerCase()}`;
  const userData = await env.RUNNER_KV.get(userKey, { type: 'json' });
  if (!userData) return json({ error: 'User not found' }, 404);

  const prevHigh = userData.highScore || 0;
  if (cappedScore > prevHigh) {
    userData.highScore = cappedScore;
    await env.RUNNER_KV.put(userKey, JSON.stringify(userData));
  }

  // Only update leaderboard if this is a new personal best
  let onLeaderboard = false;
  let rank = -1;

  if (cappedScore > prevHigh || cappedScore === prevHigh) {
    const lb = await env.RUNNER_KV.get(PIEFACE_LB_KEY, { type: 'json' }) || [];
    const existingIdx = lb.findIndex(e => e.username.toLowerCase() === username.toLowerCase());

    if (existingIdx >= 0) {
      if (cappedScore > lb[existingIdx].score) {
        lb[existingIdx].score = cappedScore;
        lb[existingIdx].date = new Date().toISOString().slice(0, 10);
      }
    } else {
      lb.push({ username: username.trim(), score: cappedScore, date: new Date().toISOString().slice(0, 10) });
    }

    lb.sort((a, b) => b.score - a.score);
    const trimmed = lb.slice(0, PIEFACE_LB_MAX);
    await env.RUNNER_KV.put(PIEFACE_LB_KEY, JSON.stringify(trimmed));

    rank = trimmed.findIndex(e => e.username.toLowerCase() === username.toLowerCase()) + 1;
    onLeaderboard = rank > 0;
  }

  return json({ ok: true, score: cappedScore, onLeaderboard, rank });
}
