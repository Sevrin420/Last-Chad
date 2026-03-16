// Contract addresses and RPC config for Last Chad
// Update these when deploying to mainnet

export const CONTRACT_ADDRESS         = '0x04DFED6F15866125b1f6d140bcb1AB90F7614252';
export const ITEMS_CONTRACT_ADDRESS   = '0x239066699C706152f6E2Fa5a82a05fC13C9677cD';
export const QUEST_REWARDS_ADDRESS    = '0x1f3A741A5169B002C8F7563C7cD11a3081cD1E4B';
export const MARKET_ADDRESS           = '0x204203b3495C940293b87cF1ff4ce7EEf81F1A1A';
export const GAMBLE_ADDRESS           = '0x42Ae979c86cF4868F8648A1eec16567CbBF19698';
export const READ_RPC                 = 'https://api.avax-test.network/ext/bc/C/rpc';

export const LASTCHAD_ABI = [
  // ERC-721 standard
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function approve(address to, uint256 tokenId)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  // ERC-721 Enumerable
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  // LastChad-specific
  'function MAX_SUPPLY() view returns (uint256)',
  'function MINT_PRICE() view returns (uint256)',
  'function TEAM_MINT_PRICE() view returns (uint256)',
  'function MAX_MINT_PER_WALLET() view returns (uint256)',
  'function totalMinted() view returns (uint256)',
  'function getStats(uint256 tokenId) view returns (uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma, bool assigned)',
  'function getLevel(uint256 tokenId) view returns (uint256)',
  'function getOpenCells(uint256 tokenId) view returns (uint256)',
  'function getClosedCells(uint256 tokenId) view returns (uint256)',
  'function getCells(uint256 tokenId) view returns (uint256)',
  'function lockCells(uint256 tokenId, uint256 amount)',
  'function awardCells(uint256 tokenId, uint256 amount)',
  'function spendCells(uint256 tokenId, uint256 amount)',
  'function getPendingStatPoints(uint256 tokenId) view returns (uint256)',
  'function spendStatPoint(uint256 tokenId, uint8 statIndex)',
  'function tokenName(uint256 tokenId) view returns (string)',
  'function authorizedGame(address game) view returns (bool)',
  'function setGameContract(address game, bool enabled)',
  'function mint(uint256 quantity) payable',
  'function mintWithTeam(uint256 quantity, uint256 teamId) payable',
  'function setStats(uint256 tokenId, string name, uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma)',
  // Elimination & active status
  'function eliminated(uint256 tokenId) view returns (bool)',
  'function eliminatedCount() view returns (uint256)',
  'function isActive(uint256 tokenId) view returns (bool)',
  'function setActive(uint256 tokenId, bool active)',
  'function eliminate(uint256 tokenId)',
  'function batchEliminate(uint256[] tokenIds)',
  'function reinstate(uint256 tokenId)',
  'function batchReinstate(uint256[] tokenIds)',
  // Batch helpers
  'function batchAwardCells(uint256[] tokenIds, uint256[] amounts)',
  'function getClosedCellsBatch(uint256[] tokenIds) view returns (uint256[])',
  'function getTotalCells(uint256 tokenId) view returns (uint256)',
  // Cull system
  'function cullMode() view returns (uint8)',
  'function cullValue() view returns (uint256)',
  'function getCullCount() view returns (uint256)',
  'function setCullMode(uint8 mode, uint256 value)',
  'function announceCull(uint256 executeAfterTimestamp)',
  'function cullAnnouncedAt() view returns (uint256)',
  'function cullExecuteAfter() view returns (uint256)',
  // Team system
  'function createTeam(string name, address nftContract) returns (uint256)',
  'function setTeamActive(uint256 teamId, bool active)',
  'function getTeam(uint256 teamId) view returns (string name, address nftContract, bool active, uint256 memberCount)',
  'function getTeamCount() view returns (uint256)',
  'function tokenTeam(uint256 tokenId) view returns (uint256)',
  'function teamMemberCount(uint256 teamId) view returns (uint256)',
  // Unique names
  'function isNameTaken(string name) view returns (bool)',
  // Per-token mutable URI
  'function setTokenURI(uint256 tokenId, string uri)',
  'function batchSetTokenURI(uint256[] tokenIds, string[] uris)',
  // Owner
  'function setBaseURI(string baseURI)',
  'function withdraw()',
  'function updateStats(uint256 tokenId, uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma)',
  'function addStat(uint256 tokenId, uint8 statIndex, uint32 amount)',
  'function mintedPerWallet(address wallet) view returns (uint256)',
  // Events
  'event Eliminated(uint256 indexed tokenId, uint256 closedCells)',
  'event Reinstated(uint256 indexed tokenId)',
  'event TeamCreated(uint256 indexed teamId, string name, address nftContract)',
  'event CullAnnounced(uint256 cullAt, uint8 mode, uint256 value, uint256 estimatedCount)',
  'event CellsLocked(uint256 indexed tokenId, uint256 amount, uint256 totalClosed, uint256 newLevel)',
  'event LevelUp(uint256 indexed tokenId, uint256 newLevel, uint256 statPointsAwarded)',
  'event CellsAwarded(uint256 indexed tokenId, uint256 amount, uint256 totalOpenCells)',
  'event StatsAssigned(uint256 indexed tokenId, uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma)',
  'event NameSet(uint256 indexed tokenId, string name)',
];

export const ITEMS_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function getItem(uint256 itemId) view returns (string memory name, uint256 maxSupply, uint256 minted, uint256 price, bool stackable, bool active)',
  'function mint(uint256 itemId, uint256 quantity) external payable',
  'function totalItems() view returns (uint256)',
  'function airdrop(address to, uint256 itemId, uint256 quantity)',
  'function batchAirdrop(address[] recipients, uint256 itemId, uint256[] quantities)',
  'function createItem(string name, uint256 maxSupply, uint256 price, bool stackable) returns (uint256)',
  'function setGameContract(address game, bool enabled)',
];

export const QUEST_REWARDS_ABI = [
  // Player
  'function startQuest(uint256 tokenId, uint8 questId)',
  'function completeQuest(uint256 tokenId, uint8 questId, uint256 cellReward, bytes oracleSig)',
  'function purchaseItem(uint256 tokenId, uint256 itemId)',
  // Game owner — config
  'function setOracle(address oracle)',
  'function setQuestConfig(uint8 questId, uint16 cellReward, uint16 itemReward)',
  'function setLastChadItems(address itemsAddress)',
  'function setQuestCooldown(uint256 cooldown)',
  // Game owner — awards
  'function awardCells(uint256 tokenId, uint256 amount)',
  'function awardItem(uint256 tokenId, uint256 itemId)',
  'function setItemPrice(uint256 itemId, uint256 cellCost)',
  // Game owner — quest/arcade management
  'function failQuest(uint256 tokenId, uint8 questId)',
  'function releaseQuest(uint256 tokenId)',
  'function releaseArcade(uint256 tokenId)',
  // Arcade sessions
  'function startArcade(uint256 tokenId, uint8 gameType, bytes32 seed)',
  'function confirmSurvival(uint256 tokenId)',
  'function confirmDeath(uint256 tokenId)',
  'function pauseDeaths()',
  'function unpauseDeaths()',
  // View
  'function itemPrices(uint256 itemId) view returns (uint256)',
  'function questCooldown() view returns (uint256)',
  'function deathsPaused() view returns (bool)',
  'function deathCount() view returns (uint256)',
  'function getSession(uint256 tokenId) view returns (bytes32 seed, uint8 questId, uint256 startTime, uint256 expiresAt, bool active)',
  'function getArcadeSession(uint256 tokenId) view returns (bytes32 seed, uint8 gameType, uint256 startTime, bool active)',
  'function isSessionExpired(uint256 tokenId) view returns (bool)',
  'function getQuestConfig(uint8 questId) view returns (uint16 cellReward, uint16 itemReward)',
  'function lastQuestTime(uint256 tokenId, uint8 questId) view returns (uint256)',
  'function questCompleted(uint256 tokenId, uint8 questId) view returns (bool)',
  // Events
  'event QuestStarted(uint256 indexed tokenId, uint8 questId, bytes32 seed, uint256 expiresAt)',
  'event QuestCompleted(uint256 indexed tokenId, uint8 questId, uint256 cellsAwarded, uint256 itemAwarded)',
  'event QuestFailed(uint256 indexed tokenId, uint8 questId)',
  'event ArcadeStarted(uint256 indexed tokenId, uint8 gameType, bytes32 seed)',
  'event ArcadeSurvived(uint256 indexed tokenId, uint8 gameType)',
  'event ArcadeDeath(uint256 indexed tokenId, uint8 gameType)',
];

export const GAMBLE_ABI = [
  // Coin flip (on-chain, 40% win)
  'function flip(uint256 tokenId, uint256 wager) external',
  // Generic oracle-signed settlement (blackjack, poker, etc.)
  'function resolveGame(uint256 tokenId, uint256 wager, uint256 payout, uint8 gameId, uint256 nonce, bytes oracleSig) external',
  // Admin
  'function setOracle(address oracle) external',
  'function setWagerLimits(uint256 min, uint256 max) external',
  // Two-tx settlement (poker, craps)
  'function commitWager(uint256 tokenId, uint256 wager) external returns (uint256)',
  'function claimWinnings(uint256 tokenId, uint256 payout, uint256 nonce, bytes oracleSig) external',
  // View
  'function minWager() view returns (uint256)',
  'function maxWager() view returns (uint256)',
  'function usedNonces(uint256 nonce) view returns (bool)',
  'function wagerAmounts(uint256 nonce) view returns (uint256)',
  'function nextNonce() view returns (uint256)',
  // Events
  'event CoinFlip(uint256 indexed tokenId, address indexed player, uint256 wager, bool won, bytes32 seed)',
  'event GameResolved(uint256 indexed tokenId, address indexed player, uint8 indexed gameId, uint256 wager, uint256 payout)',
  'event WagerCommitted(uint256 indexed tokenId, address indexed player, uint256 wager, uint256 nonce)',
  'event WinningsClaimed(uint256 indexed tokenId, address indexed player, uint256 payout, uint256 nonce)',
];

export const MARKET_ABI = [
  'function feeBps() view returns (uint256)',
  // ERC-721
  'function getListing(address nftContract, uint256 tokenId) view returns (tuple(address seller, address nftContract, uint256 tokenId, uint256 price, bool active))',
  'function getActiveListings(address nftContract, uint256 offset, uint256 limit) view returns (tuple(address seller, address nftContract, uint256 tokenId, uint256 price, bool active)[] results, uint256 total)',
  'function buy(address nftContract, uint256 tokenId) payable',
  'function list(address nftContract, uint256 tokenId, uint256 price)',
  'function delist(address nftContract, uint256 tokenId)',
  'event Sold(address indexed nftContract, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price)',
  // ERC-1155
  'function getListing1155(address nftContract, uint256 tokenId, address seller) view returns (tuple(address seller, address nftContract, uint256 tokenId, uint256 amount, uint256 price, bool active))',
  'function getActiveListings1155(address nftContract, uint256 offset, uint256 limit) view returns (tuple(address seller, address nftContract, uint256 tokenId, uint256 amount, uint256 price, bool active)[] results, uint256 total)',
  'function buy1155(address nftContract, uint256 tokenId, address seller) payable',
  'function list1155(address nftContract, uint256 tokenId, uint256 price)',
  'function delist1155(address nftContract, uint256 tokenId)',
  'event Sold1155(address indexed nftContract, uint256 indexed tokenId, address indexed buyer, address seller, uint256 amount, uint256 totalPrice)',
  'function setLastChadContract(address _lastChad)',
  'function lastChadContract() view returns (address)',
];
