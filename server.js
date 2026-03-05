require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { ethers } = require('ethers');
const questRoutes = require('./routes/quests');

const app = express();
const PORT = process.env.PORT || 5000;

// -------------------------------------------------------------------------
// Seed Watcher — listens for QuestStarted events and calls revealSeed()
// Requires GAME_OWNER_PRIVATE_KEY and QUEST_REWARDS_ADDRESS in .env
// -------------------------------------------------------------------------
const QUEST_REWARDS_WATCHER_ABI = [
  'event QuestStarted(uint256 indexed tokenId, uint8 questId, uint256 expiresAt, uint256 revealDeadline)',
  'function revealSeed(uint256 tokenId, bytes32 serverNonce) external'
];

function startSeedWatcher() {
  const rpcUrl = process.env.AVAX_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc';
  const contractAddress = process.env.QUEST_REWARDS_ADDRESS;
  const privateKey = process.env.GAME_OWNER_PRIVATE_KEY;

  if (!contractAddress || !privateKey) {
    console.warn('⚠️  Seed watcher disabled: set QUEST_REWARDS_ADDRESS and GAME_OWNER_PRIVATE_KEY in .env');
    return;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, QUEST_REWARDS_WATCHER_ABI, signer);

  console.log('👁️  Seed watcher active — listening for QuestStarted events');

  contract.on('QuestStarted', async (tokenId, questId, expiresAt, revealDeadline) => {
    const tokenIdNum = Number(tokenId);
    console.log(`🎲 QuestStarted: tokenId=${tokenIdNum} questId=${questId} — generating server nonce`);

    try {
      // Cryptographically random 32-byte nonce generated after block confirmation
      const serverNonce = ethers.randomBytes(32);
      const serverNonceHex = ethers.hexlify(serverNonce);

      // Log publicly for verifiability — anyone can confirm the final seed
      console.log(`🔐 revealSeed: tokenId=${tokenIdNum} nonce=${serverNonceHex}`);

      const tx = await contract.revealSeed(tokenIdNum, serverNonceHex);
      await tx.wait();

      console.log(`✅ Seed revealed: tokenId=${tokenIdNum} tx=${tx.hash}`);
    } catch (err) {
      console.error(`❌ revealSeed failed for tokenId=${tokenIdNum}:`, err.message);
    }
  });
}

startSeedWatcher();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname)));

// Routes
app.use('/api', questRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server running' });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: err.message || 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

app.listen(PORT, () => {
  console.log(`🎮 Last Chad Quest Server running on http://localhost:${PORT}`);
});
