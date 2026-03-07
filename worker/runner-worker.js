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
 *  - Fetches lastchad.xyz/quests/{slug}/data.json to find the dice section's statBonus
 *  - Fetches lastChad.getStats(tokenId) via read RPC to get the actual stat value
 *  - Both data.json and chain stats are read by the Worker — the client never
 *    controls which stat applies or what its value is
 *
 * KV key:  runner:{tokenId}:{questId}
 * KV value: { runStartedAt, died, player }
 *
 * KV cache key:  questdata:{questId}
 * KV cache value: { statBonus }   TTL: 24h
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

const GETSTATS_ABI = [
  'function getStats(uint256 tokenId) view returns (uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma, bool assigned)',
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
      if (request.method === 'POST' && url.pathname === '/session/win') {
        return await handleWin(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/session/status') {
        return await handleStatus(url, env);
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

  const key      = kvKey(tokenId, questId);
  const existing = await getSession(env, key);

  if (existing?.died) {
    return json({ ok: false, reason: 'already_died' }, 403);
  }

  await env.RUNNER_KV.put(key, JSON.stringify({
    runStartedAt: Date.now(),
    died:         false,
    player:       player.toLowerCase(),
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
    runStartedAt: existing?.runStartedAt ?? Date.now(),
    died:         true,
    player:       existing?.player ?? null,
  }), { expirationTtl: 3600 });

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /session/win  { tokenId, questId, baseXP }
//
// baseXP — raw score computed by the game UI (cargo score + choice bonuses).
//          The Worker adds the stat bonus on top from authoritative sources.
//          The client cannot influence which stat is used or its value.
//
// Returns { ok, signature, xpAmount } on success.
// ---------------------------------------------------------------------------
async function handleWin(request, env) {
  const { tokenId, questId, baseXP } = await parseBody(request);
  if (!tokenId || questId == null || baseXP == null) {
    return json({ error: 'Missing tokenId, questId, or baseXP' }, 400);
  }

  const key     = kvKey(tokenId, questId);
  const session = await getSession(env, key);

  if (!session)       return json({ ok: false, reason: 'no_session' }, 403);
  if (session.died)   return json({ ok: false, reason: 'already_died' }, 403);

  const elapsed = Date.now() - session.runStartedAt;
  if (elapsed < WIN_THRESHOLD_MS) {
    return json({ ok: false, reason: 'too_fast', elapsed, required: WIN_THRESHOLD_MS }, 403);
  }

  const base = Number(baseXP);
  if (!Number.isInteger(base) || base < 0 || base > MAX_XP_PER_QUEST) {
    return json({ ok: false, reason: 'invalid_base_xp' }, 400);
  }

  // 1. Look up which stat this quest's dice section uses (from data.json via GitHub Pages).
  //    Returns null for quests with no dice section (runner games, etc.).
  const statBonus = await getQuestStatBonus(Number(questId), env);

  // 2. If a stat applies, read its value from the chain — never from the client.
  let statValue = 0;
  if (statBonus) {
    const stats = await getCharStats(BigInt(tokenId), env);
    statValue = stats[statBonus] ?? 0;
  }

  const finalXP = Math.min(base + statValue, MAX_XP_PER_QUEST);

  // 3. Sign keccak256(tokenId, questId, player, finalXP)
  //    Must match what QuestRewards.sol verifies on-chain.
  const oracleWallet = new ethers.Wallet('0x' + env.ORACLE_PRIVATE_KEY);
  const messageHash  = ethers.solidityPackedKeccak256(
    ['uint256', 'uint8', 'address', 'uint256'],
    [BigInt(tokenId), Number(questId), session.player, BigInt(finalXP)]
  );
  const signature = await oracleWallet.signMessage(ethers.getBytes(messageHash));

  return json({ ok: true, signature, xpAmount: finalXP, statBonus, statValue, elapsed });
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
    exists:   true,
    died:     session.died,
    elapsed,
    canClaim: !session.died && elapsed >= WIN_THRESHOLD_MS,
  });
}

// ---------------------------------------------------------------------------
// getQuestStatBonus — fetch questId → slug → data.json → dice section statBonus
//
// Cached in KV under questdata:{questId} for 24h so GitHub Pages is only
// hit once per quest per day across all workers.
// Returns a stat name string or null.
// ---------------------------------------------------------------------------
async function getQuestStatBonus(questId, env) {
  const cacheKey = `questdata:${questId}`;
  const cached   = await env.RUNNER_KV.get(cacheKey, { type: 'json' });
  if (cached !== null) return cached.statBonus;

  const baseUrl = env.GAME_BASE_URL ?? 'https://lastchad.xyz';

  // Fetch quest index to find the slug for this questId
  const indexRes = await fetch(`${baseUrl}/quests/index.json`);
  if (!indexRes.ok) throw new Error('Failed to fetch quest index');
  const index = await indexRes.json();

  const entry = index.find(q => q.questId === questId);
  if (!entry) {
    // questId not in index — could be a runner quest with no data.json
    await env.RUNNER_KV.put(cacheKey, JSON.stringify({ statBonus: null }), { expirationTtl: QUEST_CACHE_TTL });
    return null;
  }

  // Fetch quest data.json to find the dice section's statBonus
  const dataRes = await fetch(`${baseUrl}/quests/${entry.slug}/data.json`);
  if (!dataRes.ok) {
    await env.RUNNER_KV.put(cacheKey, JSON.stringify({ statBonus: null }), { expirationTtl: QUEST_CACHE_TTL });
    return null;
  }
  const data = await dataRes.json();

  const diceSection = (data.sections ?? []).find(s => s.selectedChoice === 'dice');
  const statBonus   = (diceSection?.statBonus && VALID_STATS.has(diceSection.statBonus))
    ? diceSection.statBonus
    : null;

  await env.RUNNER_KV.put(cacheKey, JSON.stringify({ statBonus }), { expirationTtl: QUEST_CACHE_TTL });
  return statBonus;
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
