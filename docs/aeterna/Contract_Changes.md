# Aeterna Smart Contract Notes & Required Changes

## Rename Map (from original Familia* contracts)

| Old Name              | New Name             |
|-----------------------|----------------------|
| FamiliaCultist.sol    | AeternaCultist.sol   |
| FamiliaSoul.sol       | AeternaSoul.sol      |
| FamiliaGame.sol       | AeternaGame.sol      |
| FamiliaPayouts.sol    | AeternaPayouts.sol   |
| FamiliaCasino.sol     | **Removed** — folded into AeternaGame.sol |

## Major Design Changes Since Original Contracts

1. **Legacy system removed** — everything is Devotion
2. Level is **uncapped**; Level 10 still max multiplier
3. **No mid-season gold payouts** — gold calculated & revealed only at Final Communion
4. Gold is **hidden** from players until Day 56
5. Confession cost escalates (+0.001 ETH each use)
6. Gift system is physical (off-chain + Devotion awards)
7. 2-player ETH wagering lives inside Game contract (5% rake)
8. Season length: **56 active / 14 break**
9. Progressive Soul cap (0 → 1 → 2 → 3)
10. Souls hold **Devotion** (not Legacy)
11. Final Communion **doubles Devotion**
12. Yield is fully admin-controlled and based on Devotion
13. Manual admin awards of Devotion supported
14. X handle stored on Cultist NFT
15. Rank prefixes (Deacon / Bishop / Cardinal) — admin settable

## Required Contract Work

### AeternaCultist.sol
- Add optional `xHandle`
- Support rank/prefix updates (admin)
- Support Brother/Sister + Roman numerals for children
- Season-aware mint pricing if desired

### AeternaSoul.sol
- Progressive cap per season
- Store Devotion amount on the Soul
- Free Soul vs Bloodline Soul distinction
- Binding rules

### AeternaGame.sol (largest changes)
- Remove all mid-season gold logic
- Remove Legacy
- Implement escalating Confession
- Final Communion: double Devotion + transfer rules
- Level Up writes Level + Devotion only
- PvP ETH wager escrow + 5% rake
- Admin functions for manual Devotion awards and rank changes
- Admin yield controls

### AeternaPayouts.sol
- End-of-season gold payouts only
- Yield claim functions (admin-unlockable)
- Support stacked claims if desired

## Security Notes
- Daily Devotion is signed off-chain (Cloudflare Worker) and only finalized on Level Up
- High-value actions (mint, Level Up, Communion, wagers, Confession payment) are on-chain
- Rate-limit and nonce the Worker signatures to prevent replay
