/**
 * Last Chad — Runner Quest Worker
 * Cloudflare Worker + KV
 *
 * Tracks per-run state so players can't reload after dying to get a new attempt.
 * On a verified win, signs a win ticket with the oracle private key. The contract
 * verifies this signature in completeQuest() — no valid signature = tx reverts.
 *
 * KV key:  runner:{tokenId}:{questId}
 * KV value: { runStartedAt: <unix ms>, died: <bool>, player: <address> }
 *
 * Endpoints:
 *   POST /session/start  { tokenId, questId, player }  → records run attempt start
 *   POST /session/die    { tokenId, questId }           → records death, locks out further runs
 *   POST /session/win    { tokenId, questId }           → verifies win + returns oracle signature
 *   GET  /session/status?tokenId=&questId=              → returns current state
 *
 * Required Cloudflare secrets (set via `wrangler secret put`):
 *   ORACLE_PRIVATE_KEY  — hex private key for the oracle wallet (no 0x prefix)
 *                          Derive the oracle address from this key and call
 *                          QuestRewards.setOracle(oracleAddress) once after deploy.
 */

import { ethers } from 'ethers';

const CORS = {
  'Access-Control-Allow-Origin': 'https://lastchad.xyz',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const WIN_THRESHOLD_MS = 110_000; // 110s — runner is 2 minutes, allow 10s for network

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
// Called when the runner game loads and begins.
// Rejects if player already died on this tokenId+questId.
// Records runStartedAt = now and the player's address (needed for signing).
// ---------------------------------------------------------------------------
async function handleStart(request, env) {
  const { tokenId, questId, player } = await parseBody(request);
  if (!tokenId || questId == null || !player) {
    return json({ error: 'Missing tokenId, questId, or player' }, 400);
  }
  if (!ethers.isAddress(player)) {
    return json({ error: 'Invalid player address' }, 400);
  }

  const key = kvKey(tokenId, questId);
  const existing = await getSession(env, key);

  if (existing?.died) {
    return json({ ok: false, reason: 'already_died' }, 403);
  }

  const session = {
    runStartedAt: Date.now(),
    died: false,
    player: player.toLowerCase(),
  };
  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: 3600 });

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /session/die  { tokenId, questId }
// Called the moment the player hits an obstacle.
// Sets died = true permanently — no further runs allowed for this tokenId+questId.
// ---------------------------------------------------------------------------
async function handleDie(request, env) {
  const { tokenId, questId } = await parseBody(request);
  if (!tokenId || questId == null) return json({ error: 'Missing tokenId or questId' }, 400);

  const key = kvKey(tokenId, questId);
  const existing = await getSession(env, key);

  const session = {
    runStartedAt: existing?.runStartedAt ?? Date.now(),
    died: true,
    player: existing?.player ?? null,
  };
  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: 3600 });

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /session/win  { tokenId, questId }
// Called when the player reaches the end of the map.
// Checks:
//   1. No death recorded (died == false)
//   2. elapsed >= WIN_THRESHOLD_MS since runStartedAt
// On success, signs keccak256(tokenId, questId, player) with the oracle key
// and returns the signature. The player passes this to completeQuest().
// ---------------------------------------------------------------------------
async function handleWin(request, env) {
  const { tokenId, questId } = await parseBody(request);
  if (!tokenId || questId == null) return json({ error: 'Missing tokenId or questId' }, 400);

  const key = kvKey(tokenId, questId);
  const session = await getSession(env, key);

  if (!session) {
    return json({ ok: false, reason: 'no_session' }, 403);
  }
  if (session.died) {
    return json({ ok: false, reason: 'already_died' }, 403);
  }

  const elapsed = Date.now() - session.runStartedAt;
  if (elapsed < WIN_THRESHOLD_MS) {
    return json({ ok: false, reason: 'too_fast', elapsed, required: WIN_THRESHOLD_MS }, 403);
  }

  // Sign: keccak256(abi.encodePacked(tokenId, questId, player))
  // Must match what QuestRewards.sol verifies on-chain.
  const oracleWallet = new ethers.Wallet('0x' + env.ORACLE_PRIVATE_KEY);
  const messageHash = ethers.solidityPackedKeccak256(
    ['uint256', 'uint8', 'address'],
    [BigInt(tokenId), Number(questId), session.player]
  );
  const signature = await oracleWallet.signMessage(ethers.getBytes(messageHash));

  return json({ ok: true, signature, elapsed });
}

// ---------------------------------------------------------------------------
// GET /session/status?tokenId=1&questId=2
// Returns current session state. Checked on every page load.
// ---------------------------------------------------------------------------
async function handleStatus(url, env) {
  const tokenId = url.searchParams.get('tokenId');
  const questId = url.searchParams.get('questId');
  if (!tokenId || questId == null) return json({ error: 'Missing tokenId or questId' }, 400);

  const key = kvKey(tokenId, questId);
  const session = await getSession(env, key);

  if (!session) {
    return json({ exists: false, died: false });
  }

  const elapsed = Date.now() - session.runStartedAt;
  return json({
    exists: true,
    died: session.died,
    elapsed,
    canClaim: !session.died && elapsed >= WIN_THRESHOLD_MS,
  });
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
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
