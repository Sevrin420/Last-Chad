# Runner Quest — Anti-Cheat Worker

## What This Is

A Cloudflare Worker that tracks runner game session state to prevent players
from reloading the page after dying to get another attempt at the quest.

**Files:**
- `worker/runner-worker.js` — the Worker code
- `worker/wrangler.toml` — deployment config

---

## The Problem It Solves

The runner is a 2-minute skill-based obstacle course tied to a quest. When a
player starts a quest, their NFT is locked in the `QuestRewards` contract. On
a win, the player calls `completeQuest()` and gets their NFT + XP + cells +
item back. On a lose, nothing happens on-chain — the NFT stays locked.

Without this Worker, a player could:
1. Start the quest, load the runner
2. Die
3. Reload the page and try again indefinitely

The Worker records each run attempt and death server-side in Cloudflare KV.
On page load, the game checks the Worker. If `died: true`, the runner is
replaced with a death screen and the claim button is never shown.

---

## How It Works

### KV Storage

Key: `runner:{tokenId}:{questId}`
Value: `{ runStartedAt: <unix ms>, died: <bool> }`
TTL: 1 hour (matches the on-chain session window)

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/session/start` | Called when runner loads. Rejects if `died: true`. Records `runStartedAt = now`. |
| `POST` | `/session/die` | Called on death. Sets `died: true` permanently for this `tokenId+questId`. |
| `POST` | `/session/win` | Verifies win: checks `died == false` AND `elapsed >= 110s`. |
| `GET` | `/session/status` | Returns `{ died, elapsed, canClaim }` — checked on every page load. |

### Win Verification

`/session/win` returns `{ ok: true }` only if:
1. No death is recorded in KV for this `tokenId+questId`
2. At least 110 seconds have elapsed since `runStartedAt` (the runner is 2
   minutes; 10s buffer allows for network lag at the finish line)

If the player dies and blocks the death POST, they still can't fake a win
claim early — the time check catches it. They'd need to play a full fresh
2-minute run anyway.

### Frontend Integration

```js
const WORKER_URL = 'https://last-chad-runner.<your-subdomain>.workers.dev';

// On runner page load
async function initRunner(tokenId, questId) {
  const res = await fetch(`${WORKER_URL}/session/status?tokenId=${tokenId}&questId=${questId}`);
  const { died, canClaim } = await res.json();

  if (died) {
    showDeathScreen(); // no runner, no claim button
    return;
  }

  // Start a new run attempt
  await fetch(`${WORKER_URL}/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, questId }),
  });

  startRunner();
}

// On obstacle collision (death)
async function onPlayerDeath(tokenId, questId) {
  await fetch(`${WORKER_URL}/session/die`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, questId }),
  });
  showDeathScreen();
}

// On reaching the end of the map (win)
async function onPlayerWin(tokenId, questId) {
  const res = await fetch(`${WORKER_URL}/session/win`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, questId }),
  });
  const { ok, reason } = await res.json();

  if (ok) {
    showClaimButton(); // player calls completeQuest() from here
  } else {
    console.warn('Win rejected:', reason);
  }
}
```

---

## What Happens on Lose

Nothing on-chain. The NFT stays locked in the `QuestRewards` contract. The
Worker records `died: true` so the frontend permanently shows the death
screen for this `tokenId+questId`.

The game owner can later call `burnLocked(tokenId)` or `releaseLocked(tokenId)`
from `admin.html` if needed (mercy release or cleanup).

---

## Honest Limitation

This is **UI enforcement only**. A player who knows the contract ABI can call
`completeQuest()` directly from their wallet (e.g. via Snowtrace or a custom
script), bypassing the Worker entirely.

For a 70-NFT game with a small community, this is an acceptable trade-off.
A cryptographic solution would require a contract change: the Worker would
sign a "win ticket" and `completeQuest()` would verify the signature on-chain.
That has not been implemented.

---

## Deployment

### 1. Install Wrangler
```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespace
```bash
cd worker
npx wrangler kv:namespace create RUNNER_KV
npx wrangler kv:namespace create RUNNER_KV --preview
```

Paste the returned `id` and `preview_id` into `wrangler.toml`.

### 3. Deploy
```bash
npx wrangler deploy
```

### 4. Update CORS origin
In `runner-worker.js`, the `CORS` origin is set to `https://lastchad.xyz`.
For local development, temporarily add `http://localhost:*` or set it to `*`.

### 5. Update frontend config
Set `WORKER_URL` in your runner page to the deployed Worker URL shown after
`wrangler deploy`.

---

## Cost

- Cloudflare Workers free tier: 100,000 requests/day
- Cloudflare KV free tier: 100,000 reads/day, 1,000 writes/day
- At 10,000 players × ~10 KV ops per session: ~100,000 writes/day

If you exceed the free tier, the Workers Paid plan is $5/month for 10M
requests and 1M KV writes/day.
