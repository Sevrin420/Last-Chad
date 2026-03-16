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

const POKER_SESSION_TTL = 600;    // 10 minutes per session
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

  // Check if session already exists
  const key = `poker:${nonce}`;
  const existing = await env.RUNNER_KV.get(key, { type: 'json' });
  if (existing) {
    return json({ ok: true, stack: existing.stack });
  }

  await env.RUNNER_KV.put(key, JSON.stringify({
    tokenId: String(tokenId),
    player:  player.toLowerCase(),
    stack:   wager,
    phase:   'ready',
    deck:    null,
    hand:    null,
    handWager: 0,
  }), { expirationTtl: POKER_SESSION_TTL });

  return json({ ok: true, stack: wager });
}

// ---------------------------------------------------------------------------
// POST /poker/deal  { nonce, handWager }
// Deal 5 cards from a fresh shuffled deck. handWager is deducted from stack.
// ---------------------------------------------------------------------------
async function handlePokerDeal(request, env) {
  const { nonce, handWager } = await parseBody(request);
  if (nonce == null || handWager == null) {
    return json({ error: 'Missing nonce or handWager' }, 400);
  }

  const key     = `poker:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No poker session' }, 403);
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
  const { nonce, held } = await parseBody(request);
  if (nonce == null || !Array.isArray(held) || held.length !== 5) {
    return json({ error: 'Missing nonce or invalid held array' }, 400);
  }

  const key     = `poker:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No poker session' }, 403);
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

  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: POKER_SESSION_TTL });

  return json({
    ok: true,
    cards,
    hand: result,
    multiplier: mult,
    winnings,
    stack: session.stack,
  });
}

// ---------------------------------------------------------------------------
// POST /poker/cashout  { tokenId, nonce }
// Sign final payout so player can claim on-chain.
// ---------------------------------------------------------------------------
async function handlePokerCashout(request, env) {
  const { tokenId, nonce } = await parseBody(request);
  if (tokenId == null || nonce == null) {
    return json({ error: 'Missing tokenId or nonce' }, 400);
  }

  const key     = `poker:${nonce}`;
  const session = await env.RUNNER_KV.get(key, { type: 'json' });
  if (!session) return json({ error: 'No poker session' }, 403);
  if (session.phase === 'dealt') {
    return json({ error: 'Finish current hand before cashing out' }, 400);
  }
  if (String(tokenId) !== session.tokenId) {
    return json({ error: 'Token mismatch' }, 403);
  }

  const payout = session.stack;

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
