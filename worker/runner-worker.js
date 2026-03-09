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
