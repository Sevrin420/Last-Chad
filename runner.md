# Runner Quest — Oracle Anti-Cheat

## What This Is

A Cloudflare Worker that tracks runner game session state and issues cryptographic
win tickets. The contract verifies the Worker's signature in `completeQuest()`,
so a player cannot claim rewards without a genuine win signed by the oracle.

**Files:**
- `worker/runner-worker.js` — the Worker (KV state tracking + oracle signing)
- `worker/wrangler.toml`   — deployment config
- `worker/package.json`    — ethers dependency for bundling

---

## The Problem It Solves

The runner is a 2-minute skill-based obstacle course tied to a quest. When a
player starts a quest, their NFT is locked in the `QuestRewards` contract. On
a win, the player calls `completeQuest()` and gets their NFT + XP + cells +
item back. On a lose, nothing happens on-chain — the NFT stays locked.

Without this system, a player could:
1. Start the quest, load the runner
2. Die
3. Reload the page and try again indefinitely
4. Or call `completeQuest()` directly from their wallet at any time

This system closes both attack vectors.

---

## How It Works

### Oracle Signing (closes the contract bypass)

The Worker holds a private key (`ORACLE_PRIVATE_KEY` Cloudflare secret).
On a verified win, it signs:

```
keccak256(abi.encodePacked(tokenId, questId, playerAddress))
```

using `ethers.Wallet.signMessage()` (Ethereum personal sign / EIP-191).

The contract recovers the signer from this signature in `completeQuest()` and
requires it to equal the stored `oracle` address. No valid signature = tx reverts.
The oracle private key never leaves Cloudflare. The player passes the signature
as the `oracleSig` parameter but cannot forge it.

### KV State Tracking (closes the reload-to-retry exploit)

Key: `runner:{tokenId}:{questId}`
Value: `{ runStartedAt: <unix ms>, died: <bool>, player: <address> }`
TTL: 1 hour (matches the on-chain session window)

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/session/start` | Rejects if `died: true`. Records `runStartedAt = now` and `player`. |
| `POST` | `/session/die`   | Sets `died: true` permanently for this `tokenId+questId`. |
| `POST` | `/session/win`   | Verifies `died == false` AND `elapsed >= 110s` → returns oracle signature. |
| `GET`  | `/session/status`| Returns `{ died, elapsed, canClaim }` — checked on page load. |

### Win Flow (end to end)

```
1. Runner loads
   → GET  /session/status  — if died: show death screen, stop
   → POST /session/start   — records runStartedAt

2. Player hits obstacle
   → POST /session/die     — sets died: true, blocks all future runs

3. Player reaches the end (win)
   → POST /session/win     — Worker checks: not died + 110s elapsed
   → Worker signs keccak256(tokenId, questId, player) with oracle key
   → Returns { ok: true, signature }

4. Player calls completeQuest(tokenId, questId, choice1, choice2, kept1, kept2, signature)
   → Contract recovers signer from signature
   → Requires signer == oracle address
   → Awards XP, cells, item — returns NFT
```

### Lose Flow

Nothing on-chain. The NFT stays locked. The Worker records `died: true`.
On any future page load, `/session/status` returns `died: true` and the
runner is replaced with a death screen — no claim button shown.

The game owner can later call `burnLocked(tokenId)` or `releaseLocked(tokenId)`
from `admin.html`.

---

## Frontend Integration

```js
const WORKER_URL = 'https://last-chad-runner.<your-subdomain>.workers.dev';

async function initRunner(tokenId, questId, playerAddress) {
  // 1. Check for existing death
  const status = await fetch(
    `${WORKER_URL}/session/status?tokenId=${tokenId}&questId=${questId}`
  ).then(r => r.json());

  if (status.died) {
    showDeathScreen();
    return;
  }

  // 2. Record run start (player address needed for signing)
  const start = await fetch(`${WORKER_URL}/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, questId, player: playerAddress }),
  }).then(r => r.json());

  if (!start.ok) {
    showDeathScreen(); // already_died race condition
    return;
  }

  startRunner();
}

async function onPlayerDeath(tokenId, questId) {
  await fetch(`${WORKER_URL}/session/die`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, questId }),
  });
  showDeathScreen();
}

async function onPlayerWin(tokenId, questId, choice1, choice2, kept1, kept2) {
  const win = await fetch(`${WORKER_URL}/session/win`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, questId }),
  }).then(r => r.json());

  if (!win.ok) {
    showError(win.reason);
    return;
  }

  // Player calls the contract with the oracle signature
  await questRewardsContract.completeQuest(
    tokenId, questId, choice1, choice2, kept1, kept2, win.signature
  );
}
```

---

## Contract Changes (QuestRewards.sol)

Two additions:

**State variable:**
```solidity
address public oracle;
```

**Setter (onlyGameOwner):**
```solidity
function setOracle(address _oracle) external onlyGameOwner {
    require(_oracle != address(0), "Invalid oracle");
    oracle = _oracle;
}
```

**In completeQuest() — new parameter + check:**
```solidity
function completeQuest(
    uint256 tokenId, uint8 questId,
    uint8 choice1, uint8 choice2,
    uint8 kept1, uint8 kept2,
    bytes calldata oracleSig          // ← new
) external {
    // ... existing checks ...

    if (oracle != address(0)) {
        bytes32 message = keccak256(abi.encodePacked(tokenId, questId, player));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(message);
        address signer  = ECDSA.recover(ethHash, oracleSig);
        require(signer == oracle, "Invalid oracle signature");
    }

    // ... rest of function unchanged ...
}
```

The `if (oracle != address(0))` guard lets you deploy and test without the
Worker running — set the oracle address once the Worker is live.

---

## Deployment

### 1. Deploy the Worker

```bash
cd worker
npm install
npx wrangler kv:namespace create RUNNER_KV
npx wrangler kv:namespace create RUNNER_KV --preview
# Paste the returned IDs into wrangler.toml
npx wrangler deploy
```

### 2. Generate the oracle keypair

Use any Ethereum wallet generator or ethers:

```js
const { ethers } = require('ethers');
const wallet = ethers.Wallet.createRandom();
console.log('Private key:', wallet.privateKey);  // → store as secret
console.log('Oracle address:', wallet.address);  // → pass to setOracle()
```

### 3. Store the private key as a Cloudflare secret

```bash
npx wrangler secret put ORACLE_PRIVATE_KEY
# Paste the private key (without 0x prefix) when prompted
```

### 4. Register the oracle address on-chain

From `admin.html` or directly via the contract, call:
```
QuestRewards.setOracle(<oracle address from step 2>)
```

### 5. Update CORS in runner-worker.js

The `CORS` origin is set to `https://lastchad.xyz`. For local dev, temporarily
set it to `*`.

---

## Cost

- Cloudflare Workers free tier: 100,000 requests/day
- Cloudflare KV free tier: 100,000 reads/day, 1,000 writes/day
- At 10,000 players × ~10 KV ops per session: ~100,000 writes/day
- Workers Paid plan (if needed): $5/month for 10M requests + 1M KV writes/day
