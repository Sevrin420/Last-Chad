// ══════════════════════════════════════════════════════════════════════
// quest-globals.js — Global vars for non-module quest pages
// ══════════════════════════════════════════════════════════════════════
// Quest pages load this via <script src="../../js/quest-globals.js">
// (non-module), so ES imports are not available.  All values here
// MUST match js/config.js, which is the single source of truth.
//
// Deploy scripts patch both files automatically.
// If you edit an address or RPC here, update config.js too (or vice-versa).
// ══════════════════════════════════════════════════════════════════════

// ── Contract addresses (mirror config.js) ────────────────────────────
var CONTRACT_ADDRESS       = '0x04DFED6F15866125b1f6d140bcb1AB90F7614252';
var ITEMS_CONTRACT_ADDRESS = '0x239066699C706152f6E2Fa5a82a05fC13C9677cD';
var QUEST_REWARDS_ADDRESS  = '0x1f3A741A5169B002C8F7563C7cD11a3081cD1E4B';

// ── RPC endpoints (mirror config.js) ─────────────────────────────────
var READ_RPC          = 'https://api.avax-test.network/ext/bc/C/rpc';
var READ_RPC_FALLBACK = 'https://rpc.ankr.com/avalanche_fuji';

// ── Chain config (mirror config.js) ──────────────────────────────────
var AVAX_CHAIN_ID = '0xa869';
var AVAX_CHAIN = {
  chainId: AVAX_CHAIN_ID,
  chainName: 'Avalanche Fuji Testnet',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: ['https://rpc.ankr.com/avalanche_fuji', 'https://api.avax-test.network/ext/bc/C/rpc'],
  blockExplorerUrls: ['https://testnet.snowtrace.io/']
};

// ── WalletConnect (mirror config.js) ─────────────────────────────────
var WALLETCONNECT_PROJECT_ID = '3aa99496af6ef381ca5d78f464777c45';

// ── ABIs (subsets of config.js — only the functions quest pages need) ─
var LASTCHAD_ABI = [
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
  'function getPendingStatPoints(uint256 tokenId) external view returns (uint256)',
  'function spendStatPoint(uint256 tokenId, uint8 statIndex) external',
  'function totalSupply() external view returns (uint256)',
  'function getStats(uint256 tokenId) external view returns (uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma, bool assigned)',
  'function getOpenCells(uint256 tokenId) external view returns (uint256)',
  'function getClosedCells(uint256 tokenId) external view returns (uint256)',
  'function getCells(uint256 tokenId) external view returns (uint256)',
  'function getTotalCells(uint256 tokenId) external view returns (uint256)',
  'function lockCells(uint256 tokenId, uint256 amount)',
  'function getLevel(uint256 tokenId) external view returns (uint256)',
  'function isActive(uint256 tokenId) external view returns (bool)',
  'function eliminated(uint256 tokenId) external view returns (bool)',
  'function tokenName(uint256 tokenId) external view returns (string)'
];

var LASTCHAD_ITEMS_ABI = [
  'function mint(uint256 itemId, uint256 quantity) external payable',
  'function getItem(uint256 itemId) external view returns (string memory name, uint256 maxSupply, uint256 minted, uint256 price, bool stackable, bool active)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)'
];

var QUEST_REWARDS_ABI = [
  'function startQuest(uint256 tokenId, uint8 questId) external',
  'function completeQuest(uint256 tokenId, uint8 questId, uint256 cellReward, bytes oracleSig) external',
  'function purchaseItem(uint256 tokenId, uint256 itemId) external',
  'function getSession(uint256 tokenId) external view returns (bytes32 seed, uint8 questId, uint256 startTime, uint256 expiresAt, bool active)',
  'function isSessionExpired(uint256 tokenId) external view returns (bool)',
  'function questCompleted(uint256 tokenId, uint8 questId) external view returns (bool)',
  'function lastQuestTime(uint256 tokenId, uint8 questId) external view returns (uint256)',
  'function questCooldown() external view returns (uint256)',
  'function getQuestConfig(uint8 questId) external view returns (uint16 cellReward, uint16 itemReward)',
  'function getArcadeSession(uint256 tokenId) external view returns (bytes32 seed, uint8 gameType, uint256 startTime, bool active)',
  'function deathsPaused() external view returns (bool)',
  'function startArcade(uint256 tokenId, uint8 gameType, bytes32 seed) external',
  'function confirmSurvival(uint256 tokenId) external',
  'function confirmDeath(uint256 tokenId) external',
  'event QuestStarted(uint256 indexed tokenId, uint8 questId, bytes32 seed, uint256 expiresAt)',
  'event QuestCompleted(uint256 indexed tokenId, uint8 questId, uint256 cellsAwarded, uint256 itemAwarded)',
  'event QuestFailed(uint256 indexed tokenId, uint8 questId)',
  'event ArcadeStarted(uint256 indexed tokenId, uint8 gameType, bytes32 seed)',
  'event ArcadeSurvived(uint256 indexed tokenId, uint8 gameType)',
  'event ArcadeDeath(uint256 indexed tokenId, uint8 gameType)'
];
