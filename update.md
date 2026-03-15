# update.md — Last Chad v2: Battle Royale Architecture

## Core Concept

Last Chad becomes a **battle royale NFT game**. 10,000 players mint, play monthly quests with embedded arcade minigames, and get eliminated over ~6 months until ~1,000 survivors remain. Survivors receive their official Chad NFT airdrop.

---

## Key Changes from v1

| Area | v1 (Current) | v2 (Update) |
|------|-------------|-------------|
| Supply | 70 NFTs, 0.02 AVAX | 10,000 NFTs, 2 AVAX |
| Escrow | NFT transferred to contract during quest | No escrow — boolean `isActive` flag |
| Death | NFT burned on quest fail (optional) | Death from arcade minigames + monthly culling |
| Cells | In-quest currency, spent on items | Core survival metric — locked cells determine culling |
| Endgame | None | Survivors airdropped official NFT; mint art changed to "thanks for playing" |

---

## Game Loop

```
1. MINT         → Player pays 2 AVAX, receives Chad NFT
2. QUEST        → Monthly quest with narrative + arcade minigame (mandatory)
3. EARN CELLS   → Quests award cells; casino games (blackjack, craps) let players gamble cells
4. LOCK CELLS   → Players lock cells on-chain to protect against monthly culling
5. SURVIVE      → Bottom Chads by locked cells eliminated monthly
6. REPEAT       → Until ~1,000 remain
7. AIRDROP      → Survivors get official Chad NFT; original mint art changed
```

---

## Elimination Mechanics

### Monthly Culling
- Based on `lockedCells[tokenId]` on-chain
- Bottom N Chads by locked cell count are eliminated each month
- Threshold tuned so game converges to ~1,000 players over ~6 months
- Consider triggering endgame by player count, not calendar (flexible timeline)

### Arcade Minigame Death
- Quests contain embedded arcade minigames (endless runner, topshooter, area51)
- All minigames are **survival-based** — survive for 2 minutes
- Death in minigame = Chad eliminated from game
- Players MUST do quests to earn cells — skipping quests = no cells = culled
- Death is always from skill-based gameplay, never from dice RNG

---

## Cell Economy

### Earning Cells
- Quests award cells on completion
- Casino games (blackjack, craps) allow cell gambling — win or lose, no death risk

### Cell Locking (On-Chain)
```solidity
mapping(uint256 => uint256) public lockedCells;

function lockCells(uint256 tokenId, uint256 amount) external onlyGameOrOwner {
    require(_tokenCells[tokenId] >= amount);
    _tokenCells[tokenId] -= amount;
    lockedCells[tokenId] += amount;
}
```
- `_tokenCells` = spendable balance (gambling, shop)
- `lockedCells` = staked balance (determines survival ranking)
- One-way lock — strategic choice of how many to lock vs keep liquid

### Gambling Flow (Pre-Authorize Pattern)
1. Player signs tx: `lockGamblingStake(tokenId, amount)` — cells moved to escrow
2. Worker confirms lock → player gambles freely (all bets handled off-chain in Worker + D1)
3. Session ends → player signs tx: `settleGambling(tokenId, netResult)` — escrow resolved
4. **House has unlimited cell supply** — no bankroll constraint

**If player closes tab:** cells stay locked in escrow. Next session, Worker checks D1 for open session and forces settlement before allowing new activity.

---

## NFT Image Mutability

- Chad NFT images can be changed in the contract (mutable `tokenURI`)
- **During game:** dynamic metadata served from server
- **Endgame airdrop:** survivor NFTs get permanent art (IPFS or on-chain SVG)
- **Post-game:** all original mint tokens have art changed to "Thank You for Playing Last Chad"

---

## Backend Architecture

### Stack: Cloudflare Workers + D1/KV

No traditional server needed. The workload is small:
- 10,000 players × 1 quest/month × 15 min = ~3.5 avg concurrent players
- Peak (50% play in first 3 days): ~210 concurrent players
- Peak requests: ~4,000-5,000/minute — well within Cloudflare limits

| Component | Purpose |
|-----------|---------|
| Cloudflare Workers | Quest validation, arcade anti-cheat, gambling logic |
| Cloudflare D1 | Session state, gambling history, arcade game logs |
| Cloudflare KV | Fast lookups (is Chad alive, cell balance cache) |
| On-chain | Final state: cell balances, cell locking, death, quest completion |

### Cost Estimate
- Free tier: 100,000 requests/day (likely sufficient)
- Paid tier: ~$5/month if exceeded
- Paid RPC (if needed): ~$50-100/month

---

## Anti-Cheat (Arcade Minigames)

Since arcade minigames can kill Chads, anti-cheat is critical.

### Three Endpoints

1. **Start endpoint** — generates session ID, stores `startTime` + game seed in D1. Returns seed to client.
2. **Heartbeat endpoint** — receives session ID + timestamp + game state every 10-15 seconds. Stored in D1.
3. **Result endpoint** — receives session ID + outcome (survived/died). Validates:
   - Did 2+ minutes pass since `startTime`?
   - Did heartbeats arrive at roughly even intervals?
   - Were there at least X heartbeats?
   - Does game state in heartbeats match expected obstacle patterns from seed?
   - **If any check fails → Chad lives (fail safe)**

### Key Principles
- **Server-side timer** — client can't fake duration
- **Server-generated seed** — determines obstacle/enemy patterns, prevents idle-waiting
- **Heartbeats with game state** — proves active play, references seed-generated patterns
- **Death never instant** — server validates before finalizing
- **Fail safe** — any error = Chad survives

### Server Stability Priority
- Death requires server-side confirmation — if server is down, nothing happens, Chad lives
- Rate-limit death events — 10+ deaths in 60 seconds triggers auto-pause and alert
- Log every arcade session, every state change, every death event for disputes
- Connection drops freeze game state, don't default to death

---

## On-Chain Transaction Budget

### Per Player Per Month
| Action | Transactions |
|--------|-------------|
| `startQuest()` | 1 |
| `completeQuest()` (awards cells + items) | 1 |
| `lockCells()` | 1-3 |
| `lockGamblingStake()` | 1 per gambling session |
| `settleGambling()` | 1 per gambling session |
| **Total** | ~5-8 txs/month |

### Gambling is Hybrid
- Individual bets: off-chain (Worker + D1)
- Net session result: one settlement tx on-chain
- This avoids hundreds of on-chain txs per player

### RPC Capacity
- Avalanche public RPC: ~10 req/sec sustained
- At 5-8 txs/player/month: ~50,000-80,000 txs/month total
- Well within public RPC limits
- Paid RPC ($50-100/mo) available if needed

---

## Endgame (< 1,000 Players Remain)

1. Game announced as entering final phase
2. Remaining players airdropped official Chad NFT with permanent art
3. All 10,000 original mint NFTs have art changed to "Thank You for Playing Last Chad"
4. Official NFTs use IPFS or on-chain SVG for immutable storage
5. Consider triggering endgame by player count threshold, not fixed date

---

## Open Design Questions

- **Culling threshold:** Bottom 10%? Fixed number? Percentage-based converges naturally.
- **Arcade difficulty curve:** Early quests forgiving, later quests harder? Tuning controls elimination pace.
- **What reward justifies arcade risk?** Big cell payouts? Exclusive items? Needs to be significant enough that players don't avoid quests entirely.
- **Multiple Chads per wallet:** Not a problem — each Chad requires active play to survive. Whales minting 50 Chads spend 100 AVAX and fund the prize pool.
