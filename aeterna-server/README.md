# Aeterna Server Starter

Minimal Node.js + Fastify + SQLite + Socket.io backend for Season 1.

## Quick Start

```bash
cp .env.example .env
# edit .env with your values

npm install
npm start
# or
pm2 start src/index.js --name aeterna
```

## What is included
- Player state (`/me`)
- Manual save (`/save`) — ready for Cloudflare Worker signature
- Escalating Confession cost
- Basic duty stubs
- Admin Devotion award
- Full WebSocket presence, movement, emojis, chat, and physical gift flow

## What you still need to add
- Wallet signature authentication (SIWE)
- Real Cloudflare Worker call inside `/save`
- On-chain payment verification for Confession
- Full duty → Devotion → streak logic
- Gift spawning system
- Zone-based movement broadcasting (for performance)

See the Architecture folder for full design.
