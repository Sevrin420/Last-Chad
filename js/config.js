// Contract addresses and RPC config for Last Chad
// Update these when deploying to mainnet

export const CONTRACT_ADDRESS         = '0x27732900f9a87ced6a2ec5ce890d7ff58f882f76';
export const ITEMS_CONTRACT_ADDRESS   = '0x0ef84248f58be2ac72b8d2e4229fc4e8575d5947';
export const QUEST_REWARDS_ADDRESS    = '0x1e395c017BbdAEe37CD641DB112076144439c382';
export const MARKET_ADDRESS           = '0x2648fce03fe383c4a1d1a4c21fa59a0b9f35243d';
export const READ_RPC                 = 'https://api.avax-test.network/ext/bc/C/rpc';

export const LASTCHAD_ABI = [
  'function approve(address to, uint256 tokenId)',
  'function getStats(uint256 tokenId) view returns (uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma, bool assigned)',
  'function getLevel(uint256 tokenId) view returns (uint256)',
  'function getExperience(uint256 tokenId) view returns (uint256)',
  'function getCells(uint256 tokenId) view returns (uint256)',
  'function awardCells(uint256 tokenId, uint256 amount)',
  'function spendCells(uint256 tokenId, uint256 amount)',
];

export const QUEST_REWARDS_ABI = [
  // Player
  'function startQuest(uint256 tokenId, uint8 questId)',
  'function completeQuest(uint256 tokenId, uint8 questId, uint256 xpAmount, bytes oracleSig)',
  'function purchaseItem(uint256 tokenId, uint256 itemId)',
  // Game owner — config
  'function setOracle(address oracle)',
  'function setQuestConfig(uint8 questId, uint16 cellReward, uint16 itemReward)',
  'function setLastChadItems(address itemsAddress)',
  // Game owner — awards
  'function awardCells(uint256 tokenId, uint256 amount)',
  'function awardItem(uint256 tokenId, uint256 itemId)',
  'function setItemPrice(uint256 itemId, uint256 cellCost)',
  // Game owner — release
  'function releaseLocked(uint256 tokenId)',
  'function batchReleaseLocked(uint256[] tokenIds)',
  // Game owner — burn
  'function burnLocked(uint256 tokenId)',
  'function batchBurnLocked(uint256[] tokenIds)',
  'function burnAllLocked()',
  // View
  'function itemPrices(uint256 itemId) view returns (uint256)',
  'function lockedBy(uint256 tokenId) view returns (address)',
  'function getSession(uint256 tokenId) view returns (bytes32 seed, uint8 questId, uint256 startTime, uint256 expiresAt, bool active)',
  'function isSessionExpired(uint256 tokenId) view returns (bool)',
  'function getLockedTokenIds() view returns (uint256[])',
  'function getLockedCount() view returns (uint256)',
  'function getQuestConfig(uint8 questId) view returns (uint16 cellReward, uint16 itemReward)',
  // Events
  'event QuestStarted(uint256 indexed tokenId, uint8 questId, bytes32 seed, uint256 expiresAt)',
  'event QuestCompleted(uint256 indexed tokenId, uint8 questId, uint256 xpAwarded, uint256 cellsAwarded, uint256 itemAwarded)',
  'event NFTBurned(uint256 indexed tokenId, address indexed originalOwner)',
  'event NFTReleased(uint256 indexed tokenId, address indexed returnedTo)',
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
];
