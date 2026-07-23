# Aeterna — Technical Architecture

## Design Principles
- One small VPS does almost everything
- Cloudflare Worker only signs Devotion on manual save
- Blockchain holds all value and permanent state
- Keep realtime payloads tiny so 2GB RAM stays smooth

## Stack

| Layer              | Technology                          | Role                                      |
|--------------------|-------------------------------------|-------------------------------------------|
| Game Server        | Node.js + Fastify + better-sqlite3  | Logic, state, WebSockets                  |
| Realtime           | Socket.io                           | Presence, movement, gifts, emojis, chat   |
| Signing            | Cloudflare Worker                   | Devotion signature on manual save         |
| Database           | SQLite (WAL mode)                   | All off-chain state                       |
| Smart Contracts    | Solidity (ERC-721 + ERC-6551)       | Mint, Level Up, Communion, Souls, Wagers  |
| Frontend           | Static (Cloudflare Pages / Vercel)  | Game client                               |
| Process Manager    | PM2                                 | Keep server alive                         |

## Responsibility Split

**VPS**
- Daily duties & streaks
- Gift spawning, carrying, offering
- Confession (escalating cost)
- Live Devotion tracking
- Leaderboards
- Manual admin awards
- WebSocket presence + chat + emojis
- Manual save → requests signature from Worker

**Cloudflare Worker**
- Generate cryptographic signature for accumulated Devotion
- Called only on manual save / Level Up preparation

**On-chain**
- Mint
- Level Up (final state write)
- Final Communion + gold reveal
- Soul binding
- ETH wagers (escrow + 5% rake)
- Permanent Devotion storage after Level Up / Communion

## Performance Rules (Critical for 2GB)
- Broadcast movement only to nearby / same-zone players
- Send move updates only on meaningful position change
- Emojis are fire-and-forget (no DB)
- Chat rate-limited
- Keep all WebSocket payloads very small
- Assume max ~25% concurrent (≈550 players)

## Save Flow
1. Player plays → VPS records everything live
2. Player clicks “Save & Exit”
3. VPS asks Cloudflare Worker for signature
4. Signature stored; later used for on-chain Level Up
