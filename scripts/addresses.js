/**
 * addresses.js — Single source of truth for deployed contract addresses.
 *
 * Reads js/config.js (ES module) and re-exports addresses as CommonJS
 * so every Hardhat script can just:
 *
 *   const { LAST_CHAD, ITEMS, QUEST_REWARDS, MARKET, GAMBLE } = require('./addresses');
 */

const fs   = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'js', 'config.js');
const src = fs.readFileSync(configPath, 'utf8');

function extract(name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*'([^']+)'`);
  const m = src.match(re);
  if (!m) throw new Error(`addresses.js: ${name} not found in js/config.js`);
  return m[1];
}

function extractOptional(name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*'([^']+)'`);
  const m = src.match(re);
  return m ? m[1] : '';
}

module.exports = {
  LAST_CHAD:     extract('CONTRACT_ADDRESS'),
  ITEMS:         extract('ITEMS_CONTRACT_ADDRESS'),
  QUEST_REWARDS: extract('QUEST_REWARDS_ADDRESS'),
  MARKET:        extract('MARKET_ADDRESS'),
  GAMBLE:        extract('GAMBLE_ADDRESS'),
  TOURNAMENT:    extractOptional('TOURNAMENT_ADDRESS'),
  READ_RPC:      extract('READ_RPC'),
};
