/**
 * Last Chad — Runner Quest Worker
 * Cloudflare Worker + KV
 *
 * Tracks per-run state so players can't reload after dying to get a new attempt.
 * The frontend checks this Worker before showing the "Claim Rewards" button.
 *
 * KV key:  runner:{tokenId}:{questId}
 * KV value: { runStartedAt: <unix ms>, died: <bool> }
 *
 * Endpoints:
 *   POST /session/start  { tokenId, questId }          → records run attempt start
 *   POST /session/die    { tokenId, questId }          → records death, locks out further runs
 *   POST /session/win    { tokenId, questId }          → verifies win (not died + 110s elapsed)
 *   GET  /session/status?tokenId=&questId=             → returns current state
 *
 * Limitation: enforces UI only. A player who calls completeQuest() directly
 * via their wallet bypasses this Worker entirely. Sufficient for casual anti-cheat.
 */

const CORS = {
  'Access-Control-Allow-Origin': 'https://lastchad.xyz',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const WIN_THRESHOLD_MS = 110_000; // 110 seconds — runner is 2 minutes, allow 10s buffer

export default {
  async fetch(request, env) {
    // CORS preflight
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
      return json({ error: 'Internal error' }, 500);
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ---------------------------------------------------------------------------
// POST /session/start
// Called when the runner game loads and begins.
// If the player already died on this tokenId+questId, rejects immediately.
// Otherwise records runStartedAt = now (resets on each fresh load).
// ---------------------------------------------------------------------------
async function handleStart(request, env) {
  const { tokenId, questId } = await parseBody(request);
  if (!tokenId || questId == null) return json({ error: 'Missing tokenId or questId' }, 400);

  const key = kvKey(tokenId, questId);
  const existing = await getSession(env, key);

  if (existing?.died) {
    return json({ ok: false, reason: 'already_died' }, 403);
  }

  const session = {
    runStartedAt: Date.now(),
    died: false,
  };
  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: 3600 }); // 1hr TTL

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /session/die
// Called the moment the player hits an obstacle and dies.
// Sets died = true permanently for this tokenId+questId.
// ---------------------------------------------------------------------------
async function handleDie(request, env) {
  const { tokenId, questId } = await parseBody(request);
  if (!tokenId || questId == null) return json({ error: 'Missing tokenId or questId' }, 400);

  const key = kvKey(tokenId, questId);
  const existing = await getSession(env, key);

  const session = {
    runStartedAt: existing?.runStartedAt ?? Date.now(),
    died: true,
  };
  await env.RUNNER_KV.put(key, JSON.stringify(session), { expirationTtl: 3600 });

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /session/win
// Called when the player reaches the end of the map.
// Returns { ok: true } only if:
//   1. died is false (no death recorded for this run)
//   2. at least WIN_THRESHOLD_MS has elapsed since runStartedAt
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

  return json({ ok: true, elapsed });
}

// ---------------------------------------------------------------------------
// GET /session/status?tokenId=1&questId=2
// Returns current session state for the frontend to check on load.
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
