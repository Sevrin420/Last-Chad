/**
 * Last Chad — Quest Oracle Worker
 * Cloudflare Worker + KV
 *
 * Handles two jobs:
 *  1. Session tracking — prevents reload-to-retry on skill-based minigames
 *  2. XP signing — computes final XP (baseXP + stat bonus) and signs it
 *     so completeQuest() can verify the amount on-chain
 *
 * Stat bonus resolution (for dice quests):
 *  - Fetches lastchad.xyz/quests/index.json to map questId → slug
 *  - Fetches lastchad.xyz/quests/{slug}/data.json to find ALL dice sections' statBonus fields
 *  - Fetches lastChad.getStats(tokenId) via read RPC to get the actual stat values
 *  - Each dice section's stat bonus is applied independently — two STR-based dice
 *    sections both add the character's STR value to the final XP total
 *  - Both data.json and chain stats are read by the Worker — the client never
 *    controls which stat applies or what its value is
 *
 * KV key:  runner:{tokenId}:{questId}
 * KV value: { runStartedAt, died, player }
 *
 * KV cache key:  questdata_v2:{questId}
 * KV cache value: { statBonuses: string[] }   TTL: 24h
 *
 * Endpoints:
 *   POST /session/start  { tokenId, questId, player }  → record run start
 *   POST /session/die    { tokenId, questId }           → record death
 *   POST /session/win    { tokenId, questId, baseXP }   → verify + sign finalXP
 *   GET  /session/status?tokenId=&questId=              → current state
 *
 * Cloudflare secrets (set via `wrangler secret put`):
 *   ORACLE_PRIVATE_KEY  — hex private key, no 0x prefix
 *
 * wrangler.toml vars:
 *   LASTCHAD_ADDRESS    — LastChad.sol contract address
 *   READ_RPC            — Avalanche read RPC URL
 *   GAME_BASE_URL       — e.g. https://lastchad.xyz
 */

import { ethers } from 'ethers';

const CORS = {
  'Access-Control-Allow-Origin': 'https://lastchad.xyz',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const WIN_THRESHOLD_MS  = 110_000; // runner: 2 min map, 10s buffer
const MAX_XP_PER_QUEST  = 50;      // hard cap — Worker will never sign more
const QUEST_CACHE_TTL   = 86_400;  // 24h — quest configs change rarely
const VALID_STATS       = new Set(['strength', 'intelligence', 'dexterity', 'charisma']);

const POKER_SESSION_TTL = 600;    // 10 minutes per session (reset on every interaction)
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

const GAMBLE_ABI = [
  'function wagerAmounts(uint256 nonce) view returns (uint256)',
  'function wagerPlayers(uint256 nonce) view returns (address)',
  'function usedNonces(uint256 nonce) view returns (bool)',
];

const GETSTATS_ABI = [
  'function getStats(uint256 tokenId) view returns (uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma, bool assigned)',
];
const QUESTREWARDS_ABI = [
  'function questStarted(uint256 tokenId, uint8 questId) view returns (bool)',
];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/session/start') {
        return await handleStart(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/session/die') {
        return await handleDie(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/session/visit-section') {
        return await handleVisitSection(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/session/win') {
        return await handleWin(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/session/status') {
        return await handleStatus(url, env);
      }

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

      // Craps endpoints
      if (request.method === 'POST' && url.pathname === '/craps/start') {
        return await handleCrapsStart(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/craps/bet') {
        return await handleCrapsBet(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/craps/roll') {
        return await handleCrapsRoll(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/craps/cashout') {
        return await handleCrapsCashout(request, env);
      }

      // Table presence endpoints
      if (request.method === 'POST' && url.pathname === '/tables/join') {
        return await handleTableJoin(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/tables/leave') {
        return await handleTableLeave(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/tables/list') {
        return await handleTableList(env);
      }
      if (request.method === 'POST' && url.pathname === '/tables/state') {
        return await handleTableStatePost(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/tables/state') {
        return await handleTableStateGet(url, env);
      }
      if (request.method === 'POST' && url.pathname === '/tables/shooter') {
        return await handleShooterAdvance(request, env);
      }

      // Agora RTC token
      if (request.method === 'POST' && url.pathname === '/agora/token') {
        return await handleAgoraToken(request, env);
      }
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ---------------------------------------------------------------------------
// POST /session/start  { tokenId, questId, player }
// ---------------------------------------------------------------------------
async function handleStart(request, env) {
  const { tokenId, questId, player } = await parseBody(request);
  if (!tokenId || questId == null || !player) {
    return json({ error: 'Missing tokenId, questId, or player' }, 400);
  }
  if (!ethers.isAddress(player)) {
    return json({ error: 'Invalid player address' }, 400);
  }

  // On-chain check: each Chad can only start each quest once.
  // QuestRewards.questStarted is set permanently the moment startQuest() runs.
  if (env.QUEST_REWARDS_ADDRESS) {
    try {
      const provider = new ethers.JsonRpcProvider(env.READ_RPC);
      const qr = new ethers.Contract(env.QUEST_REWARDS_ADDRESS, QUESTREWARDS_ABI, provider);
      const alreadyStarted = await qr.questStarted(BigInt(tokenId), Number(questId));
      if (alreadyStarted) {
        // Allow the session to be re-registered if the chain shows it started
        // (this covers the normal flow: adventure.html starts → quest page registers).
        // But if a KV session already exists AND is completed, block.
        const existing = await getSession(env, kvKey(tokenId, questId));
        if (existing?.completed) {
          return json({ ok: false, reason: 'quest_already_completed' }, 403);
        }
        if (existing?.died) {
          return json({ ok: false, reason: 'already_died' }, 403);
        }
      }
    } catch (_) { /* RPC error — let the session proceed */ }
  }

  const key      = kvKey(tokenId, questId);
  const existing = await getSession(env, key);

  if (existing?.died)      return json({ ok: false, reason: 'already_died' }, 403);
  if (existing?.completed) return json({ ok: false, reason: 'quest_already_completed' }, 403);

  await env.RUNNER_KV.put(key, JSON.stringify({
    runStartedAt:    Date.now(),
    died:            false,
    completed:       false,
    player:          player.toLowerCase(),
    visitedSections: existing?.visitedSections ?? {},
    diceScore:       existing?.diceScore ?? null,
  }), { expirationTtl: 3600 });

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /session/die  { tokenId, questId }
// ---------------------------------------------------------------------------
async function handleDie(request, env) {
  const { tokenId, questId } = await parseBody(request);
  if (!tokenId || questId == null) return json({ error: 'Missing tokenId or questId' }, 400);

  const key      = kvKey(tokenId, questId);
  const existing = await getSession(env, key);

  await env.RUNNER_KV.put(key, JSON.stringify({
    runStartedAt:    existing?.runStartedAt ?? Date.now(),
    died:            true,
    completed:       false,
    player:          existing?.player ?? null,
    visitedSections: existing?.visitedSections ?? {},
    diceScore:       existing?.diceScore ?? null,
  }), { expirationTtl: 3600 });

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /session/visit-section  { tokenId, questId, sectionId, sectionXp }
//
// Records that the player entered a section and how much XP it awards.
// Only the first visit per sectionId is recorded (no double-counting).
// ---------------------------------------------------------------------------
async function handleVisitSection(request, env) {
  const { tokenId, questId, sectionId, sectionXp } = await parseBody(request);
  if (!tokenId || questId == null || sectionId == null) {
    return json({ error: 'Missing tokenId, questId, or sectionId' }, 400);
  }

  const key     = kvKey(tokenId, questId);
  const session = await getSession(env, key);

  if (!session)         return json({ ok: false, reason: 'no_session' }, 403);
  if (session.died)     return json({ ok: false, reason: 'already_died' }, 403);
  if (session.completed) return json({ ok: false, reason: 'quest_already_completed' }, 403);

  const xp = Math.max(0, Math.min(Number(sectionXp) || 0, MAX_XP_PER_QUEST));
  const sid = String(sectionId);

  // Only record first visit — prevents XP inflation from section revisits
  if (session.visitedSections[sid] !== undefined) {
    return json({ ok: true, alreadyVisited: true });
  }

  session.visitedSections[sid] = xp;
  const ttl = Math.max(60, Math.ceil((session.runStartedAt + 3_600_000 - Date.now()) / 1000));
  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: ttl });

  return json({ ok: true, sectionXp: xp });
}

// ---------------------------------------------------------------------------
// POST /session/win  { tokenId, questId, diceXP }
//
// diceXP — raw score computed by the game UI (cargo score / lives remaining).
//          The Worker adds the stat bonus on top from authoritative sources.
//          The client cannot influence which stat is used or its value.
//
// Returns { ok, signature, xpAmount } on success.
// ---------------------------------------------------------------------------
async function handleWin(request, env) {
  const { tokenId, questId, diceXP } = await parseBody(request);
  if (!tokenId || questId == null || diceXP == null) {
    return json({ error: 'Missing tokenId, questId, or diceXP' }, 400);
  }

  const key     = kvKey(tokenId, questId);
  const session = await getSession(env, key);

  if (!session)          return json({ ok: false, reason: 'no_session' }, 403);
  if (session.died)      return json({ ok: false, reason: 'already_died' }, 403);
  if (session.completed) return json({ ok: false, reason: 'quest_already_completed' }, 403);

  const elapsed = Date.now() - session.runStartedAt;
  if (elapsed < WIN_THRESHOLD_MS) {
    return json({ ok: false, reason: 'too_fast', elapsed, required: WIN_THRESHOLD_MS }, 403);
  }

  const dice = Math.max(0, Math.min(Number(diceXP) || 0, 12)); // dice cargo score 0–12

  // 1. Sum XP from every quest section the player actually visited (tracked server-side).
  const sectionXpTotal = Object.values(session.visitedSections ?? {})
    .reduce((sum, xp) => sum + Number(xp), 0);

  // 2. Look up which stat each dice section uses (from data.json via GitHub Pages).
  //    Returns an array — one entry per dice section that has a statBonus configured.
  //    Each dice section's stat is applied independently, so two STR-based dice
  //    sections both add the character's STR value.
  const statBonuses = await getQuestStatBonuses(Number(questId), env);

  // 3. Sum the stat value for every dice section that has one — fetched from chain.
  let statValue = 0;
  if (statBonuses.length > 0) {
    const stats = await getCharStats(BigInt(tokenId), env);
    for (const statName of statBonuses) {
      statValue += stats[statName] ?? 0;
    }
  }

  // finalXP = section XP (server-tracked) + dice cargo score (client-reported) + per-section stat bonuses (chain)
  const finalXP = Math.min(sectionXpTotal + dice + statValue, MAX_XP_PER_QUEST);

  // 4. Sign keccak256(tokenId, questId, player, finalXP)
  //    Must match what QuestRewards.sol verifies on-chain.
  const oracleWallet = new ethers.Wallet('0x' + env.ORACLE_PRIVATE_KEY);
  const messageHash  = ethers.solidityPackedKeccak256(
    ['uint256', 'uint8', 'address', 'uint256'],
    [BigInt(tokenId), Number(questId), session.player, BigInt(finalXP)]
  );
  const signature = await oracleWallet.signMessage(ethers.getBytes(messageHash));

  // 5. Mark session completed — prevents re-claiming
  await env.RUNNER_KV.put(key, JSON.stringify({
    ...session,
    completed: true,
    diceScore: dice,
  }), { expirationTtl: 86_400 }); // keep 24h so status endpoint can confirm

  return json({ ok: true, signature, xpAmount: finalXP, sectionXpTotal, dice, statBonuses, statValue, elapsed });
}

// ---------------------------------------------------------------------------
// GET /session/status?tokenId=&questId=
// ---------------------------------------------------------------------------
async function handleStatus(url, env) {
  const tokenId = url.searchParams.get('tokenId');
  const questId = url.searchParams.get('questId');
  if (!tokenId || questId == null) return json({ error: 'Missing tokenId or questId' }, 400);

  const session = await getSession(env, kvKey(tokenId, questId));
  if (!session) return json({ exists: false, died: false });

  const elapsed = Date.now() - session.runStartedAt;
  return json({
    exists:          true,
    died:            session.died,
    completed:       session.completed ?? false,
    elapsed,
    canClaim:        !session.died && !session.completed && elapsed >= WIN_THRESHOLD_MS,
    visitedSections: session.visitedSections ?? {},
  });
}

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
    // Refresh TTL on reconnect
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
  if (bet > session.stack || bet < 1) {
    return json({ error: 'Invalid hand wager' }, 400);
  }

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

// POST /craps/start  { tokenId, nonce, player }
async function handleCrapsStart(request, env) {
  const { tokenId, nonce, player } = await parseBody(request);
  if (tokenId == null || nonce == null || !player) {
    return json({ error: 'Missing tokenId, nonce, or player' }, 400);
  }
  if (!ethers.isAddress(player)) {
    return json({ error: 'Invalid player address' }, 400);
  }

  // Check if nonce was already cashed out (KV marker persists after session deletion)
  const cashoutKey = `craps_done:${nonce}`;
  const alreadyCashedOut = await env.RUNNER_KV.get(cashoutKey);
  if (alreadyCashedOut) {
    return json({ error: 'Nonce already used' }, 403);
  }

  // Verify wager on-chain
  const provider = new ethers.JsonRpcProvider(env.READ_RPC);
  const gamble   = new ethers.Contract(env.GAMBLE_ADDRESS, GAMBLE_ABI, provider);

  // Check if nonce was already claimed on-chain
  const used = await gamble.usedNonces(BigInt(nonce));
  if (used) {
    return json({ error: 'Nonce already claimed on-chain' }, 403);
  }

  const wager    = Number(await gamble.wagerAmounts(BigInt(nonce)));
  if (wager === 0) {
    return json({ error: 'No active wager for this nonce' }, 403);
  }
  const onChainPlayer = (await gamble.wagerPlayers(BigInt(nonce))).toLowerCase();
  if (onChainPlayer !== player.toLowerCase()) {
    return json({ error: 'Player mismatch' }, 403);
  }

  const sessionToken = await generateCrapsSessionToken(nonce, player.toLowerCase(), env);

  const key = `craps:${nonce}`;
  const existing = await env.RUNNER_KV.get(key, { type: 'json' });
  if (existing) {
    await env.RUNNER_KV.put(key, JSON.stringify(existing), { expirationTtl: CRAPS_SESSION_TTL });
    return json({ ok: true, stack: existing.stack, sessionToken });
  }

  await env.RUNNER_KV.put(key, JSON.stringify({
    tokenId: String(tokenId),
    player:  player.toLowerCase(),
    stack:   wager,
    phase:   'comeout',
    point:   0,
    bets:    {},
    comeBets: {},
    comeOdds: {},
    _expectedToken: sessionToken,
  }), { expirationTtl: CRAPS_SESSION_TTL });

  return json({ ok: true, stack: wager, sessionToken });
}

// POST /craps/bet  { nonce, zone, amount }
// Place a single bet server-side. Stack is deducted on the Worker.
async function handleCrapsBet(request, env) {
  const { nonce, zone, amount, sessionToken } = await parseBody(request);
  if (nonce == null || !zone) return json({ error: 'Missing nonce or zone' }, 400);

  const key     = `craps:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No craps session' }, 403);
  if (!verifyCrapsSessionToken(session, sessionToken)) {
    return json({ error: 'Invalid session token' }, 403);
  }

  const validBetZones = new Set([
    'pass','field','come','passOdds',
    'place4','place5','place6','place8','place9','place10',
    'hard4','hard6','hard8','hard10',
    'comeOdds4','comeOdds5','comeOdds6','comeOdds8','comeOdds9','comeOdds10',
  ]);
  if (!validBetZones.has(zone)) return json({ error: 'Invalid bet zone' }, 400);
  if (zone.startsWith('place') && session.phase === 'comeout') {
    return json({ error: 'Place bets open after point' }, 400);
  }
  if (zone === 'pass' && session.phase === 'point') {
    return json({ error: 'Pass line only on come-out roll' }, 400);
  }
  if (zone === 'passOdds' && session.phase === 'comeout') {
    return json({ error: 'Pass odds only after point is set' }, 400);
  }
  if (zone === 'come' && session.phase === 'comeout') {
    return json({ error: 'Come bets only after point is set' }, 400);
  }
  // Come odds require an existing come bet on that number
  if (zone.startsWith('comeOdds')) {
    const num = zone.replace('comeOdds', '');
    if (!session.comeBets || !session.comeBets[num]) {
      return json({ error: 'No come bet on ' + num + ' to back with odds' }, 400);
    }
  }

  const amt = Math.max(0, Math.min(Math.floor(Number(amount) || 0), session.stack));
  if (amt <= 0) return json({ error: 'Invalid amount or insufficient stack' }, 400);

  // Come odds go into the comeOdds object, not bets
  if (zone.startsWith('comeOdds')) {
    const num = zone.replace('comeOdds', '');
    session.stack -= amt;
    if (!session.comeOdds) session.comeOdds = {};
    session.comeOdds[num] = (session.comeOdds[num] || 0) + amt;
  } else {
    session.stack -= amt;
    session.bets[zone] = (session.bets[zone] || 0) + amt;
  }

  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: CRAPS_SESSION_TTL });
  return json({ ok: true, stack: session.stack, bets: session.bets, comeOdds: session.comeOdds || {} });
}

// POST /craps/roll  { nonce, newBets: { zone: amount } }
// Client sends NEW bets to place; worker validates each against stack, then rolls.
// Bets are tracked server-side — client cannot inflate existing bets.
async function handleCrapsRoll(request, env) {
  const { nonce, newBets, sessionToken } = await parseBody(request);
  if (nonce == null) return json({ error: 'Missing nonce' }, 400);

  const key     = `craps:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No craps session' }, 403);
  if (!verifyCrapsSessionToken(session, sessionToken)) {
    return json({ error: 'Invalid session token' }, 403);
  }

  // Guard against concurrent roll requests for the same session.
  // Two simultaneous rolls could both read the same KV state and double bets.
  if (session.rolling) {
    return json({ error: 'Roll already in progress' }, 409);
  }
  session.rolling = true;
  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: CRAPS_SESSION_TTL });

  // ── Server-side bet placement: validate each new bet against stack ──
  const validBetZones = new Set([
    'pass','field','come','passOdds',
    'place4','place5','place6','place8','place9','place10',
    'hard4','hard6','hard8','hard10',
    'comeOdds4','comeOdds5','comeOdds6','comeOdds8','comeOdds9','comeOdds10',
  ]);
  if (newBets && typeof newBets === 'object') {
    for (const [zone, amount] of Object.entries(newBets)) {
      if (!validBetZones.has(zone)) continue;
      const amt = Math.max(0, Math.min(Math.floor(Number(amount) || 0), session.stack));
      if (amt <= 0) continue;
      // Phase rules — same as handleCrapsBet
      if (zone.startsWith('place') && session.phase === 'comeout') continue;
      if (zone === 'pass' && session.phase === 'point') continue;
      if (zone === 'passOdds' && session.phase === 'comeout') continue;
      if (zone === 'come' && session.phase === 'comeout') continue;
      // Come odds require an existing come bet on that number
      if (zone.startsWith('comeOdds')) {
        const num = zone.replace('comeOdds', '');
        if (!session.comeBets || !session.comeBets[num]) continue;
        session.stack -= amt;
        if (!session.comeOdds) session.comeOdds = {};
        session.comeOdds[num] = (session.comeOdds[num] || 0) + amt;
      } else {
        session.stack -= amt;
        session.bets[zone] = (session.bets[zone] || 0) + amt;
      }
    }
  }

  // Must have at least one bet on the table
  const totalBets = Object.values(session.bets).reduce((s, v) => s + v, 0)
    + Object.values(session.comeBets || {}).reduce((s, v) => s + v, 0);
  if (totalBets === 0) {
    session.rolling = false;
    await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: CRAPS_SESSION_TTL });
    return json({ error: 'No bets on table' }, 400);
  }

  // Generate dice server-side — crypto.getRandomValues, not Math.random
  let d1, d2, total, isHard, resolution;
  try {
    const arr = new Uint32Array(2);
    crypto.getRandomValues(arr);
    d1 = (arr[0] % 6) + 1;
    d2 = (arr[1] % 6) + 1;
    total = d1 + d2;
    isHard = (d1 === d2);

    // Resolve all bets (server-side authoritative)
    resolution = crapsResolveBets(session, d1, d2, total, isHard);
  } catch (err) {
    session.rolling = false;
    await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: CRAPS_SESSION_TTL });
    return json({ error: 'Roll resolution failed' }, 500);
  }

  session.rolling = false;
  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: CRAPS_SESSION_TTL });

  return json({
    ok: true,
    dice: [d1, d2],
    total,
    isHard,
    resolution,
    stack: session.stack,
    phase: session.phase,
    point: session.point,
    bets: session.bets,
    comeBets: session.comeBets || {},
  });
}

// POST /craps/cashout  { tokenId, nonce }
async function handleCrapsCashout(request, env) {
  const { tokenId, nonce, sessionToken } = await parseBody(request);
  if (tokenId == null || nonce == null) {
    return json({ error: 'Missing tokenId or nonce' }, 400);
  }

  const key     = `craps:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No craps session' }, 403);
  if (!verifyCrapsSessionToken(session, sessionToken)) {
    return json({ error: 'Invalid session token' }, 403);
  }
  if (String(tokenId) !== session.tokenId) {
    return json({ error: 'Token mismatch' }, 403);
  }

  // Return all bets to stack
  let betsOnTable = 0;
  for (const val of Object.values(session.bets || {})) betsOnTable += val;
  for (const val of Object.values(session.comeBets || {})) betsOnTable += val;
  for (const val of Object.values(session.comeOdds || {})) betsOnTable += val;
  const payout = session.stack + betsOnTable;

  // Mark nonce as done and delete session BEFORE signing to prevent double-cashout races.
  // Even if two concurrent requests both pass the initial craps_done check, only one will
  // reach claimWinnings on-chain (usedNonces prevents replay). But we minimise the window
  // by committing the done marker and removing the session first.
  const cashoutKey = `craps_done:${nonce}`;
  await env.RUNNER_KV.put(cashoutKey, '1', { expirationTtl: 86_400 });
  await env.RUNNER_KV.delete(key);

  if (payout === 0) {
    return json({ ok: true, payout: 0, nonce: Number(nonce), signature: '0x' });
  }

  const oracleWallet = new ethers.Wallet('0x' + env.ORACLE_PRIVATE_KEY);
  const messageHash  = ethers.solidityPackedKeccak256(
    ['uint256', 'uint256', 'uint256', 'address'],
    [BigInt(tokenId), BigInt(payout), BigInt(nonce), session.player]
  );
  const signature = await oracleWallet.signMessage(ethers.getBytes(messageHash));

  return json({ ok: true, payout, nonce: Number(nonce), signature });
}

// Craps bet resolution — mutates session in place, returns resolution info
function crapsResolveBets(session, d1, d2, total, isHard) {
  const bets = session.bets || {};
  const comeBets = session.comeBets || {};
  const comeOdds = session.comeOdds || {};
  let netWin = 0;
  const wins = [];
  const losses = [];
  let message = '';

  // FIELD (one-roll)
  if (bets.field) {
    const fieldNums = [2,3,4,9,10,11,12];
    if (fieldNums.includes(total)) {
      let payout = bets.field;
      if (total === 2) payout = bets.field * 2;
      else if (total === 12) payout = bets.field * 3;
      netWin += payout;
      session.stack += bets.field + payout;
      wins.push('field');
      message = 'FIELD ' + total + '! +' + payout;
    } else { losses.push('field'); }
    bets.field = 0;
  }

  // HARDWAYS
  const hardMap = { hard4: 4, hard6: 6, hard8: 8, hard10: 10 };
  const hardPay = { hard4: 7, hard6: 9, hard8: 9, hard10: 7 };
  for (const [key, num] of Object.entries(hardMap)) {
    if (!bets[key]) continue;
    if (total === num && isHard) {
      const payout = bets[key] * hardPay[key];
      netWin += payout;
      session.stack += bets[key] + payout;
      wins.push(key);
      message = 'HARD ' + num + '! +' + payout;
      bets[key] = 0;
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
      session.stack += amt + amt;
      message = 'COME ' + num + ' wins! +' + amt;
      if (comeOdds[numStr]) {
        const oddsPay = crapsCalcOdds(num, comeOdds[numStr]);
        netWin += oddsPay;
        session.stack += comeOdds[numStr] + oddsPay;
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
      session.stack += bets.come + bets.come;
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

  // PLACE BETS — standing bets: on hit, pay profit but bet stays active
  const placePay = { 4: [9,5], 5: [7,5], 6: [7,6], 8: [7,6], 9: [7,5], 10: [9,5] };
  for (const num of [4,5,6,8,9,10]) {
    const key = 'place' + num;
    if (!bets[key]) continue;
    if (total === num) {
      const [payNum, payDen] = placePay[num];
      const payout = Math.floor(bets[key] * payNum / payDen);
      netWin += payout;
      session.stack += payout; // profit only — bet stays on the table
      wins.push(key);
      message = 'PLACE ' + num + ' hits! +' + payout;
      // bets[key] stays — place bets are standing bets in standard craps
    } else if (total === 7) {
      losses.push(key);
      bets[key] = 0;
    }
  }

  // PASS LINE + ODDS
  if (session.phase === 'comeout') {
    if (bets.pass) {
      if (total === 7 || total === 11) {
        netWin += bets.pass;
        session.stack += bets.pass + bets.pass;
        wins.push('pass');
        message = total === 7 ? 'SEVEN! Winner!' : 'YO ELEVEN! Winner!';
        bets.pass = 0;
      } else if (total === 2 || total === 3 || total === 12) {
        losses.push('pass');
        message = total === 12 ? 'TWELVE! Craps!' : total === 2 ? 'SNAKE EYES! Craps!' : 'THREE CRAPS!';
        bets.pass = 0;
      } else {
        session.point = total;
        session.phase = 'point';
        message = 'Point is ' + total + '!';
      }
    }
  } else {
    if (total === session.point) {
      if (bets.pass) {
        netWin += bets.pass;
        session.stack += bets.pass + bets.pass;
        wins.push('pass');
        message = 'WINNER! Point ' + session.point + '!';
        if (bets.passOdds) {
          const oddsPay = crapsCalcOdds(session.point, bets.passOdds);
          netWin += oddsPay;
          session.stack += bets.passOdds + oddsPay;
          bets.passOdds = 0;
        }
        bets.pass = 0;
      }
      session.phase = 'comeout';
      session.point = 0;
    } else if (total === 7) {
      if (bets.pass) { losses.push('pass'); bets.pass = 0; }
      if (bets.passOdds) { bets.passOdds = 0; }
      message = 'SEVEN OUT!';
      session.phase = 'comeout';
      session.point = 0;
    }
  }

  session.bets = bets;
  session.comeBets = comeBets;
  session.comeOdds = comeOdds;

  return { netWin, wins, losses, message };
}

function crapsCalcOdds(pointNum, bet) {
  switch (pointNum) {
    case 4: case 10: return bet * 2;
    case 5: case 9:  return Math.floor(bet * 3 / 2);
    case 6: case 8:  return Math.floor(bet * 6 / 5);
    default: return 0;
  }
}

async function generateCrapsSessionToken(nonce, player, env) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.ORACLE_PRIVATE_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = new TextEncoder().encode(`craps:${nonce}:${player}`);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function verifyCrapsSessionToken(session, sessionToken) {
  if (!session._expectedToken || !sessionToken) return false; // fail closed
  return session._expectedToken === sessionToken;
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
// getQuestStatBonuses — fetch questId → slug → data.json → all dice section statBonuses
//
// Cached in KV under questdata_v2:{questId} for 24h so GitHub Pages is only
// hit once per quest per day across all workers.
// Returns an array of stat name strings (one entry per dice section that has a
// statBonus configured). Empty array means no stat bonuses apply.
// ---------------------------------------------------------------------------
async function getQuestStatBonuses(questId, env) {
  const cacheKey = `questdata_v2:${questId}`;
  const cached   = await env.RUNNER_KV.get(cacheKey, { type: 'json' });
  if (cached !== null) return cached.statBonuses ?? [];

  const baseUrl = env.GAME_BASE_URL ?? 'https://lastchad.xyz';

  // Fetch quest index to find the slug for this questId
  const indexRes = await fetch(`${baseUrl}/quests/index.json`);
  if (!indexRes.ok) throw new Error('Failed to fetch quest index');
  const index = await indexRes.json();

  const entry = index.find(q => q.questId === questId);
  if (!entry) {
    // questId not in index — runner quest or no data.json
    await env.RUNNER_KV.put(cacheKey, JSON.stringify({ statBonuses: [] }), { expirationTtl: QUEST_CACHE_TTL });
    return [];
  }

  // Fetch quest data.json to find every dice section's statBonus
  const dataRes = await fetch(`${baseUrl}/quests/${entry.slug}/data.json`);
  if (!dataRes.ok) {
    await env.RUNNER_KV.put(cacheKey, JSON.stringify({ statBonuses: [] }), { expirationTtl: QUEST_CACHE_TTL });
    return [];
  }
  const data = await dataRes.json();

  // Collect one entry per dice section that has a valid statBonus configured
  const statBonuses = (data.sections ?? [])
    .filter(s => s.selectedChoice === 'dice' && s.statBonus && VALID_STATS.has(s.statBonus))
    .map(s => s.statBonus);

  await env.RUNNER_KV.put(cacheKey, JSON.stringify({ statBonuses }), { expirationTtl: QUEST_CACHE_TTL });
  return statBonuses;
}

// ---------------------------------------------------------------------------
// getCharStats — read LastChad.getStats(tokenId) via read RPC (free, no gas)
// Returns { strength, intelligence, dexterity, charisma } as plain numbers.
// ---------------------------------------------------------------------------
async function getCharStats(tokenId, env) {
  const provider = new ethers.JsonRpcProvider(env.READ_RPC);
  const contract = new ethers.Contract(env.LASTCHAD_ADDRESS, GETSTATS_ABI, provider);
  const [strength, intelligence, dexterity, charisma] = await contract.getStats(tokenId);
  return {
    strength:     Number(strength),
    intelligence: Number(intelligence),
    dexterity:    Number(dexterity),
    charisma:     Number(charisma),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function kvKey(tokenId, questId) {
  return `runner:${tokenId}:${questId}`;
}

async function getSession(env, key) {
  const raw = await env.RUNNER_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function parseBody(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  TABLE PRESENCE (lobby player counts)
// ═══════════════════════════════════════════════════════════════════════════

// POST /tables/join  { table, playerId }
async function handleTableJoin(request, env) {
  const { table, playerId } = await parseBody(request);
  if (!table || !playerId) return json({ error: 'Missing table or playerId' }, 400);

  const isPublic  = PUBLIC_TABLES.some(t => t.name === table);
  const isPrivate = table.startsWith('priv-');
  if (!isPublic && !isPrivate) return json({ error: 'Invalid table name' }, 400);

  // Enforce private table cap
  if (isPrivate) {
    const privCount = await countPrivateTables(env);
    // Allow if player is already in this table, otherwise check cap
    const existingCheck = await env.RUNNER_KV.get(`table_players:${table}`, { type: 'json' }) || {};
    if (!existingCheck[playerId] && privCount >= MAX_PRIVATE_TABLES) {
      return json({ error: 'Private table limit reached', max: MAX_PRIVATE_TABLES }, 429);
    }
  }

  const key = `table_players:${table}`;
  const existing = await env.RUNNER_KV.get(key, { type: 'json' }) || {};

  // Enforce per-table player cap (allow rejoin if already seated)
  const now = Date.now();
  const activePlayers = Object.entries(existing).filter(([, ts]) => now - ts < TABLE_STALE_MS);
  if (!existing[playerId] && activePlayers.length >= MAX_PLAYERS_PER_TABLE) {
    return json({ error: 'Table is full', max: MAX_PLAYERS_PER_TABLE }, 429);
  }

  existing[playerId] = Date.now();
  await env.RUNNER_KV.put(key, JSON.stringify(existing), { expirationTtl: TABLE_PRESENCE_TTL });

  const count = Object.values(existing).filter(ts => now - ts < TABLE_STALE_MS).length;
  // Ensure a shooter is assigned (first player becomes shooter)
  const shooter = await ensureShooter(table, env);
  return json({ ok: true, count, shooter });
}

async function countPrivateTables(env) {
  // List all private table KV keys with active players
  const list = await env.RUNNER_KV.list({ prefix: 'table_players:priv-' });
  let count = 0;
  const now = Date.now();
  for (const key of list.keys) {
    const players = await env.RUNNER_KV.get(key.name, { type: 'json' }) || {};
    const active = Object.values(players).filter(ts => now - ts < TABLE_STALE_MS);
    if (active.length > 0) count++;
  }
  return count;
}

// POST /tables/leave  { table, playerId }
async function handleTableLeave(request, env) {
  const { table, playerId } = await parseBody(request);
  if (!table || !playerId) return json({ error: 'Missing table or playerId' }, 400);

  const key = `table_players:${table}`;
  const existing = await env.RUNNER_KV.get(key, { type: 'json' }) || {};
  delete existing[playerId];

  if (Object.keys(existing).length === 0) {
    await env.RUNNER_KV.delete(key);
    await env.RUNNER_KV.delete(`table_shooter:${table}`);
  } else {
    await env.RUNNER_KV.put(key, JSON.stringify(existing), { expirationTtl: TABLE_PRESENCE_TTL });
    await ensureShooter(table, env);
  }
  return json({ ok: true });
}

// GET /tables/list
async function handleTableList(env) {
  const now = Date.now();
  const tables = [];

  for (const t of PUBLIC_TABLES) {
    const players = await env.RUNNER_KV.get(`table_players:${t.name}`, { type: 'json' }) || {};
    const active = Object.values(players).filter(ts => now - ts < TABLE_STALE_MS);
    tables.push({
      name: t.name,
      label: t.label,
      players: active.length,
      maxPlayers: MAX_PLAYERS_PER_TABLE,
    });
  }

  return json({
    tables,
    limits: { maxPublic: MAX_PUBLIC_TABLES, maxPrivate: MAX_PRIVATE_TABLES, maxPerTable: MAX_PLAYERS_PER_TABLE },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  TABLE STATE SYNC (multiplayer bet/dice visibility)
// ═══════════════════════════════════════════════════════════════════════════

const TABLE_STATE_TTL = 120; // 2 min KV expiry — stale players auto-expire

// POST /tables/state  { table, playerId, state }
// Player pushes their current visible game state after each bet/roll/cashout.
async function handleTableStatePost(request, env) {
  const { table, playerId, state } = await parseBody(request);
  if (!table || !playerId || !state) return json({ error: 'Missing fields' }, 400);

  // Sanitize: only store the fields other players need to see
  const sanitized = {
    name:     String(state.name || '').slice(0, 20),
    chadId:   Number(state.chadId) || 0,
    stack:    Number(state.stack) || 0,
    bets:     {},
    comeBets: {},
    phase:    state.phase === 'point' ? 'point' : 'comeout',
    point:    Number(state.point) || 0,
    lastDice: Array.isArray(state.lastDice) ? state.lastDice.slice(0, 2).map(Number) : null,
    lastMsg:  String(state.lastMsg || '').slice(0, 80),
    ts:       Date.now(),
  };
  // Whitelist bet zones
  const allowedBets = new Set([
    'pass','field','come','passOdds',
    'place4','place5','place6','place8','place9','place10',
    'hard4','hard6','hard8','hard10',
  ]);
  if (state.bets && typeof state.bets === 'object') {
    for (const [k, v] of Object.entries(state.bets)) {
      if (allowedBets.has(k) && Number(v) > 0) sanitized.bets[k] = Number(v);
    }
  }
  if (state.comeBets && typeof state.comeBets === 'object') {
    for (const [k, v] of Object.entries(state.comeBets)) {
      if (Number(v) > 0) sanitized.comeBets[k] = Number(v);
    }
  }

  const key = `table_state:${table}:${playerId}`;
  await env.RUNNER_KV.put(key, JSON.stringify(sanitized), { expirationTtl: TABLE_STATE_TTL });
  return json({ ok: true });
}

// GET /tables/state?table=X&playerId=Y
// Returns all other players' states at the table (excludes the requester).
async function handleTableStateGet(url, env) {
  const table    = url.searchParams.get('table');
  const myId     = url.searchParams.get('playerId');
  if (!table) return json({ error: 'Missing table' }, 400);

  // Get player list for this table to know who to look up
  const playersKey = `table_players:${table}`;
  const players = await env.RUNNER_KV.get(playersKey, { type: 'json' }) || {};
  const now = Date.now();

  const others = [];
  for (const [pid, ts] of Object.entries(players)) {
    if (pid === String(myId)) continue; // skip self
    if (now - ts > TABLE_STALE_MS) continue; // skip stale
    const stateKey = `table_state:${table}:${pid}`;
    const st = await env.RUNNER_KV.get(stateKey, { type: 'json' });
    if (st) {
      st.playerId = pid;
      others.push(st);
    }
  }
  // Include shooter info
  const shooterKey = `table_shooter:${table}`;
  const shooter = await env.RUNNER_KV.get(shooterKey, { type: 'json' });
  return json({ ok: true, players: others, shooter: shooter ? shooter.playerId : null });
}

// ── Shooter rotation ──

async function getActivePlayers(table, env) {
  const playersKey = `table_players:${table}`;
  const players = await env.RUNNER_KV.get(playersKey, { type: 'json' }) || {};
  const now = Date.now();
  // Return active playerIds sorted by join time (oldest first = stable order)
  return Object.entries(players)
    .filter(([, ts]) => now - ts < TABLE_STALE_MS)
    .sort((a, b) => a[1] - b[1])
    .map(([pid]) => pid);
}

async function ensureShooter(table, env) {
  const shooterKey = `table_shooter:${table}`;
  const existing = await env.RUNNER_KV.get(shooterKey, { type: 'json' });
  const active = await getActivePlayers(table, env);
  if (active.length === 0) {
    await env.RUNNER_KV.delete(shooterKey);
    return null;
  }
  // If current shooter is still active, keep them
  if (existing && active.includes(existing.playerId)) return existing.playerId;
  // Otherwise assign first active player
  const newShooter = { playerId: active[0] };
  await env.RUNNER_KV.put(shooterKey, JSON.stringify(newShooter), { expirationTtl: TABLE_PRESENCE_TTL });
  return active[0];
}

// POST /tables/shooter  { table, playerId }
// Called by the current shooter's client after a 7-out to pass the dice.
async function handleShooterAdvance(request, env) {
  const { table, playerId } = await parseBody(request);
  if (!table || !playerId) return json({ error: 'Missing fields' }, 400);

  const shooterKey = `table_shooter:${table}`;
  const current = await env.RUNNER_KV.get(shooterKey, { type: 'json' });

  // Only the current shooter can advance
  if (!current || current.playerId !== playerId) {
    return json({ error: 'Not the shooter' }, 403);
  }

  const active = await getActivePlayers(table, env);
  if (active.length === 0) return json({ ok: true, shooter: null });

  const idx = active.indexOf(playerId);
  const nextIdx = (idx + 1) % active.length;
  const nextShooter = { playerId: active[nextIdx] };
  await env.RUNNER_KV.put(shooterKey, JSON.stringify(nextShooter), { expirationTtl: TABLE_PRESENCE_TTL });
  return json({ ok: true, shooter: active[nextIdx] });
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
