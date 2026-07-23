# Aeterna — Complete Handoff Package
**Version:** 4.1  
**Date:** July 23, 2026  
**Slogan:** Vita Aeterna

---

## What This Package Contains

| Folder | Contents |
|--------|----------|
| `01_GDD` | Full Game Design Document (v4.1) |
| `02_Architecture` | Backend architecture, API, WebSockets, data models, SQLite schema |
| `03_Server_Starter` | Ready-to-run Node.js + Fastify + Socket.io starter code |
| `04_Smart_Contracts` | Contract rename map, required changes, and design notes |
| `05_Overview` | This handoff file |

---

## Project Summary

**Aeterna** is an invitation-only, multi-generational NFT cult RPG.

Players mint Cultist NFTs, perform daily duties in a shared top-down pixel abbey, give physical gifts, build streaks, level up (uncapped), and at the end of each 56-day season perform Final Communion. All value accrual is expressed through **Devotion**. Souls carry Devotion across generations. Yield is distributed based on Devotion and is fully admin-controlled.

### Core Loop
1. Mint Cultist (0.02 ETH Season 1, 0.015 ETH later seasons)
2. Perform 3 required daily duties + optional gift giving
3. Build streak → higher Devotion multipliers (caps at Level 10)
4. Manually save progress (Cloudflare Worker signs)
5. Level Up on-chain (permanent checkpoint)
6. Day 56 → Final Communion (gold revealed, Devotion doubled, transfer to Child or Free Soul)
7. Continue bloodline or start fresh next season

### Key Design Decisions (Final)
- **No Legacy system** — everything is Devotion
- Level has **no cap**; Level 10 still gives max multiplier
- Gold is **hidden** until Final Communion
- Confession cost escalates (+0.001 ETH each use per season)
- Players must **manually save** when leaving the game
- Physical gift carrying (pick up → walk → offer → accept)
- Realtime presence, emojis, and optional chat
- Yield fully admin-controlled and based on Devotion
- Progressive Soul cap (0 → 1 → 2 → 3 across seasons)
- Ranks (Deacon / Bishop / Cardinal) decided by admin at Final Communion

---

## Technical Architecture (Minimal)

| Component | Role |
|-----------|------|
| 2GB VPS | Full game server + SQLite + WebSockets |
| Cloudflare Worker | Only signs Devotion on manual save |
| Smart Contracts | Mint, Level Up, Final Communion, Souls, ETH wagers |
| Static Frontend | Game client |

**Assumption:** ≤ 25% concurrent players (~550 max). Architecture is intentionally lightweight so it runs smoothly on 2GB RAM.

---

## Current Economic Model (4 Seasons)

- Season 1: 2,220 × 0.02 ETH = 44.4 ETH  
- Seasons 2–4: 2,220 × 0.015 ETH = 33.3 ETH each  
- **Total raised:** ~144.3 ETH  
- Target player payout: ~25%  
- Remaining Treasury after 4 seasons: ~108 ETH + optional Confession/wager revenue  

---

## Next Steps (Recommended Order)

1. Review and lock GDD v4.1  
2. Deploy starter server on your existing VPS  
3. Implement Cloudflare Worker signing  
4. Update / rewrite smart contracts (see `04_Smart_Contracts`)  
5. Build minimal frontend that talks to the VPS + contracts  
6. Private test with small group  
7. Public Season 1

---

## Contact / Ownership

Project owned and operated by the creator (Guru character in-game).  
All admin functions (manual Devotion awards, ranks, yield unlock, etc.) are controlled by the project wallet.
