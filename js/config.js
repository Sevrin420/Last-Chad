// Contract addresses and RPC config for Last Chad
// Update these when deploying to mainnet

export const CONTRACT_ADDRESS         = '0xE6A490A8D7fd9AAa70d095CC3e28a4974f9AfcE2';
export const ITEMS_CONTRACT_ADDRESS   = '0xf84b280b2f501b9433319f1c8eee5595c5c60b34';
export const QUEST_REWARDS_ADDRESS    = '0x66f98e6f6fa6c0f0315de904b0aae30337787d00';
export const MARKET_ADDRESS           = '0x2648fce03fe383c4a1d1a4c21fa59a0b9f35243d';
export const READ_RPC                 = 'https://api.avax-test.network/ext/bc/C/rpc';

export const LASTCHAD_ABI = [
  'function approve(address to, uint256 tokenId)',
  'function getStats(uint256 tokenId) view returns (uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma, bool assigned)',
  'function getLevel(uint256 tokenId) view returns (uint256)',
  'function getExperience(uint256 tokenId) view returns (uint256)',
  'function getCells(uint256 tokenId) view returns (uint256)',
];

export const QUEST_REWARDS_ABI = [
  'function startQuest(uint256 tokenId, uint8 questId)',
  'function completeQuest(uint256 tokenId, uint8 questId, uint256 xpAmount)',
  'function getSession(uint256 tokenId) view returns (bytes32 seed, uint8 questId, uint256 startTime, uint256 expiresAt, bool active)',
  'function isSessionExpired(uint256 tokenId) view returns (bool)',
  'function lockedBy(uint256 tokenId) view returns (address)',
  'function burnLocked(uint256 tokenId)',
  'function releaseLocked(uint256 tokenId)',
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
