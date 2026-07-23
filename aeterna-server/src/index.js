import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import db from './db/database.js';

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });

// ========== HEALTH ==========
fastify.get('/health', async () => ({ status: 'ok', service: 'aeterna' }));

// ========== PLAYER ==========
fastify.get('/me', async (req, reply) => {
  const wallet = req.headers['x-wallet'];
  if (!wallet) return reply.code(401).send({ error: 'No wallet' });

  const player = db.prepare('SELECT * FROM players WHERE wallet = ?').get(wallet.toLowerCase());
  if (!player) return reply.code(404).send({ error: 'Player not found' });
  return player;
});

// Manual Save → later calls Cloudflare Worker for signature
fastify.post('/save', async (req, reply) => {
  const { wallet } = req.body || {};
  if (!wallet) return reply.code(400).send({ error: 'Missing wallet' });

  const player = db.prepare('SELECT * FROM players WHERE wallet = ?').get(wallet.toLowerCase());
  if (!player) return reply.code(404).send({ error: 'Player not found' });

  // TODO: Call Cloudflare Worker
  // const sigRes = await fetch(process.env.WORKER_URL, { method: 'POST', body: JSON.stringify({...}) })
  const signature = 'pending-worker-signature';

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO saves (player_id, devotion_at_save, streak_at_save, signature, signed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(player.id, player.devotion, player.streak, signature, now);

  db.prepare('UPDATE players SET last_save = ? WHERE id = ?').run(now, player.id);

  return {
    success: true,
    devotion: player.devotion,
    streak: player.streak,
    signature
  };
});

// ========== CONFESSION (escalating cost) ==========
fastify.post('/confession', async (req, reply) => {
  const { wallet, txHash } = req.body || {};
  if (!wallet) return reply.code(400).send({ error: 'Missing wallet' });

  const player = db.prepare('SELECT * FROM players WHERE wallet = ?').get(wallet.toLowerCase());
  if (!player) return reply.code(404).send({ error: 'Player not found' });

  const cost = 0.005 + (player.confession_count * 0.001);
  // TODO: Verify on-chain payment of `cost` ETH using txHash

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE players
    SET confession_count = confession_count + 1
    WHERE id = ?
  `).run(player.id);

  db.prepare(`
    INSERT INTO streak_logs (player_id, date, streak_before, broke, confessed, confessed_at, cost_eth, tx_hash)
    VALUES (?, ?, ?, 1, 1, ?, ?, ?)
  `).run(player.id, now.slice(0, 10), player.streak, now, cost, txHash || null);

  return {
    success: true,
    costPaid: cost,
    nextCost: cost + 0.001,
    confessionCount: player.confession_count + 1
  };
});

// ========== DUTIES (stubs) ==========
fastify.post('/duty/:type', async (req, reply) => {
  const { type } = req.params;
  const { wallet } = req.body || {};
  if (!['pray', 'garden', 'candles'].includes(type)) {
    return reply.code(400).send({ error: 'Invalid duty' });
  }
  if (!wallet) return reply.code(400).send({ error: 'Missing wallet' });

  const player = db.prepare('SELECT * FROM players WHERE wallet = ?').get(wallet.toLowerCase());
  if (!player) return reply.code(404).send({ error: 'Player not found' });

  const col = `${type}_today`;
  db.prepare(`UPDATE players SET ${col} = 1 WHERE id = ?`).run(player.id);

  // TODO: add Devotion, check streak completion, etc.
  return { success: true, duty: type };
});

// ========== ADMIN AWARD ==========
fastify.post('/admin/award', async (req, reply) => {
  const { wallet, amount, reason } = req.body || {};
  // TODO: protect with admin wallet check
  const player = db.prepare('SELECT * FROM players WHERE wallet = ?').get(wallet?.toLowerCase());
  if (!player) return reply.code(404).send({ error: 'Player not found' });

  db.prepare('UPDATE players SET devotion = devotion + ? WHERE id = ?').run(amount, player.id);
  db.prepare(`
    INSERT INTO admin_awards (player_id, amount, reason, awarded_at)
    VALUES (?, ?, ?, ?)
  `).run(player.id, amount, reason || null, new Date().toISOString());

  return { success: true, newDevotion: player.devotion + amount };
});

// ========== SOCKET.IO ==========
const io = new Server(fastify.server, {
  cors: { origin: '*' }
});

const online = new Map(); // socketId → player data

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    online.set(socket.id, { ...data, heldGiftId: null });
    socket.broadcast.emit('player_joined', data);
  });

  socket.on('move', (data) => {
    const p = online.get(socket.id);
    if (!p) return;
    p.x = data.x;
    p.y = data.y;
    p.dir = data.dir;
    socket.broadcast.emit('player_moved', {
      id: p.tokenId || socket.id,
      x: data.x,
      y: data.y,
      dir: data.dir
    });
  });

  socket.on('emoji', (data) => {
    const p = online.get(socket.id);
    if (!p) return;
    socket.broadcast.emit('emoji_show', {
      id: p.tokenId || socket.id,
      emoji: data.emoji
    });
  });

  socket.on('chat', (data) => {
    const p = online.get(socket.id);
    if (!p) return;
    // basic rate-limit could be added here
    socket.broadcast.emit('chat_msg', {
      id: p.tokenId || socket.id,
      name: p.name,
      text: String(data.text || '').slice(0, 120)
    });
  });

  socket.on('pickup_gift', (data) => {
    const p = online.get(socket.id);
    if (!p) return;
    p.heldGiftId = data.giftId;
    socket.broadcast.emit('gift_picked', {
      playerId: p.tokenId || socket.id,
      giftId: data.giftId
    });
  });

  socket.on('offer_gift', (data) => {
    const p = online.get(socket.id);
    if (!p || !p.heldGiftId) return;
    socket.broadcast.emit('gift_offered', {
      fromPlayerId: p.tokenId || socket.id,
      giftId: p.heldGiftId
    });
  });

  socket.on('accept_gift', (data) => {
    // In production: validate, award Devotion, clear heldGiftId, emit gift_transferred
    socket.broadcast.emit('gift_transferred', {
      fromId: data.fromPlayerId,
      toId: online.get(socket.id)?.tokenId || socket.id,
      giftId: data.giftId || null
    });
  });

  socket.on('drop_gift', () => {
    const p = online.get(socket.id);
    if (!p || !p.heldGiftId) return;
    const giftId = p.heldGiftId;
    p.heldGiftId = null;
    socket.broadcast.emit('gift_dropped', {
      playerId: p.tokenId || socket.id,
      giftId,
      x: p.x,
      y: p.y
    });
  });

  socket.on('disconnect', () => {
    const p = online.get(socket.id);
    if (p) {
      socket.broadcast.emit('player_left', { id: p.tokenId || socket.id });
      online.delete(socket.id);
    }
  });
});

// ========== START ==========
const port = Number(process.env.PORT) || 3000;
fastify.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`Aeterna server running on port ${port}`);
});
