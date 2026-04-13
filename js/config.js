// ══════════════════════════════════════════════════════════════════════
// config.js — SINGLE SOURCE OF TRUTH for Members Only configuration
// ══════════════════════════════════════════════════════════════════════
// All contract addresses, ABIs, RPC endpoints, chain config, and
// service URLs live here.
//
// When deploying contracts, update THIS file first. Deploy scripts
// patch automatically.
// ══════════════════════════════════════════════════════════════════════

// ── Contract addresses (update after deployment) ─────────────────────
export const CONTRACT_ADDRESS         = '0x0000000000000000000000000000000000000000'; // MembersOnly
export const ITEMS_CONTRACT_ADDRESS   = '0x0000000000000000000000000000000000000000'; // MembersOnlyItems
export const MARKET_ADDRESS           = '0x0000000000000000000000000000000000000000'; // Market
export const GAMBLE_ADDRESS           = '0x0000000000000000000000000000000000000000'; // Gamble
export const TOURNAMENT_ADDRESS       = '0x0000000000000000000000000000000000000000'; // Tournament

// ── RPC endpoints ────────────────────────────────────────────────────
export const READ_RPC                 = 'https://api.avax.network/ext/bc/C/rpc';
export const READ_RPC_FALLBACK        = 'https://rpc.ankr.com/avalanche';

// ── Chain config ─────────────────────────────────────────────────────
export const AVAX_CHAIN_ID = '0xa86a'; // 43114 Avalanche C-Chain
export const AVAX_CHAIN = {
  chainId: AVAX_CHAIN_ID,
  chainName: 'Avalanche C-Chain',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: ['https://rpc.ankr.com/avalanche', 'https://api.avax.network/ext/bc/C/rpc'],
  blockExplorerUrls: ['https://snowtrace.io/']
};

// ── WalletConnect ────────────────────────────────────────────────────
export const WALLETCONNECT_PROJECT_ID = '3aa99496af6ef381ca5d78f464777c45';

// ── NFT image URL ────────────────────────────────────────────────────
// Single source of truth — asset folders are untouchable.
export function getChadImageUrl(tokenId) {
  return 'assets/Chads%20333/framed/chad_' + tokenId + '.png';
}

// ── Cloudflare Worker ────────────────────────────────────────────────
export const WORKER_URL = 'https://last-chad-runner.severin20.workers.dev';

// ══════════════════════════════════════════════════════════════════════
// ABIs — Members Only contracts
// ══════════════════════════════════════════════════════════════════════

export const MEMBERS_ONLY_ABI = [
  // ERC-721 standard
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function approve(address to, uint256 tokenId)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  // ERC-721 Enumerable
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  // MembersOnly-specific
  'function MAX_SUPPLY() view returns (uint256)',
  'function MINT_PRICE() view returns (uint256)',
  'function BASE_CHIPS() view returns (uint256)',
  'function PARTNER_BONUS_CHIPS() view returns (uint256)',
  'function MAX_MINT_PER_WALLET() view returns (uint256)',
  'function totalMinted() view returns (uint256)',
  'function mint(uint256 quantity) payable',
  'function mintWhitelist(uint256 quantity, bytes32[] proof) payable',
  // Naming
  'function setName(uint256 tokenId, string name)',
  'function tokenName(uint256 tokenId) view returns (string)',
  'function isNameTaken(string name) view returns (bool)',
  'function isNameAssigned(uint256 tokenId) view returns (bool)',
  // Chips
  'function getChips(uint256 tokenId) view returns (uint256)',
  'function getChipsBatch(uint256[] tokenIds) view returns (uint256[])',
  'function awardChips(uint256 tokenId, uint256 amount)',
  'function batchAwardChips(uint256[] tokenIds, uint256[] amounts)',
  'function spendChips(uint256 tokenId, uint256 amount)',
  // Tier system
  'function tokenTier(uint256 tokenId) view returns (uint8)',
  'function tierChipReward(uint8 tier) view returns (uint256)',
  'function setTier(uint256 tokenId, uint8 tier)',
  'function batchSetTier(uint256[] tokenIds, uint8[] tiers)',
  'function setTierReward(uint8 tier, uint256 amount)',
  // Level system
  'function getLevel(uint256 tokenId) view returns (uint8)',
  'function levelBonusChips(uint8 level) view returns (uint256)',
  'function setLevelBonus(uint8 level, uint256 amount)',
  // Weekly claiming
  'function currentWeek() view returns (uint256)',
  'function claimWeeklyChips(uint256 tokenId)',
  'function advanceWeek()',
  'function getWeeklyReward(uint256 tokenId) view returns (uint256)',
  'function hasClaimed(uint256 tokenId, uint256 week) view returns (bool)',
  // Active lock
  'function isActive(uint256 tokenId) view returns (bool)',
  'function setActive(uint256 tokenId, bool active)',
  // Game auth
  'function authorizedGame(address game) view returns (bool)',
  'function setGameContract(address game, bool enabled)',
  // Partner system
  'function registerPartner(string name, address nftContract) returns (uint256)',
  'function setPartnerActive(uint256 partnerId, bool active)',
  'function getPartner(uint256 partnerId) view returns (string name, address nftContract, bool active)',
  'function getPartnerCount() view returns (uint256)',
  'function hasPartnerNFT(address wallet) view returns (bool)',
  // Whitelist
  'function merkleRoot() view returns (bytes32)',
  'function setMerkleRoot(bytes32 root)',
  // URI
  'function setTokenURI(uint256 tokenId, string uri)',
  'function batchSetTokenURI(uint256[] tokenIds, string[] uris)',
  'function setBaseURI(string baseURI)',
  // Owner
  'function withdraw()',
  'function mintedPerWallet(address wallet) view returns (uint256)',
  // Events
  'event NameSet(uint256 indexed tokenId, string name)',
  'event ChipsAwarded(uint256 indexed tokenId, uint256 amount, uint256 totalChips)',
  'event ChipsSpent(uint256 indexed tokenId, uint256 amount, uint256 remainingChips)',
  'event TierSet(uint256 indexed tokenId, uint8 tier)',
  'event WeeklyChipsClaimed(uint256 indexed tokenId, uint256 week, uint256 amount)',
  'event WeekAdvanced(uint256 newWeek)',
];

// Backwards-compatible alias
export const LASTCHAD_ABI = MEMBERS_ONLY_ABI;

export const ITEMS_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function getItem(uint256 itemId) view returns (string name, uint256 maxSupply, uint256 minted, uint256 price, bool stackable, bool active, uint8 itemType, uint256 bonusAmount)',
  'function mint(uint256 itemId, uint256 quantity) payable',
  'function totalItems() view returns (uint256)',
  'function airdrop(address to, uint256 itemId, uint256 quantity)',
  'function batchAirdrop(address[] recipients, uint256 itemId, uint256[] quantities)',
  'function createItem(string name, uint256 maxSupply, uint256 price, bool stackable, uint8 itemType, uint256 bonusAmount) returns (uint256)',
  'function setGameContract(address game, bool enabled)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  // Utilize system
  'function utilizeItem(uint256 tokenId, uint256 itemId)',
  'function unutilizeItem(uint256 tokenId, uint256 itemId)',
  'function isUtilized(uint256 tokenId, uint256 itemId) view returns (bool)',
  // Chip bonuses
  'function claimWeeklyItemBonus(uint256 tokenId, uint256[] itemIds)',
  'function claimOneTimeBonus(uint256 tokenId, uint256 itemId)',
  // Wallet claiming
  'function claimItem(uint256 itemId)',
  'function setItemClaimable(uint256 itemId, address[] wallets)',
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
  'function setMembersOnlyContract(address _membersOnly)',
  'function membersOnlyContract() view returns (address)',
];

export const TOURNAMENT_ABI = [
  // Player
  'function enterTournament(uint256 tournamentId, uint256 tokenId)',
  'function lockScore(uint256 tournamentId, uint256 tokenId)',
  // View
  'function getTournament(uint256 tournamentId) view returns (string name, uint256 startTime, uint256 endTime, uint256 chipCost, uint256 tournamentChips, bool rebuyAllowed, bool active, uint256 entryCount)',
  'function getEntry(uint256 tournamentId, uint256 tokenId) view returns (uint256 tournamentChips, uint256 score, bool entered, uint256 entryCount, bool busted)',
  'function getLeaderboard(uint256 tournamentId, uint256 offset, uint256 limit) view returns (uint256[] tokenIds, uint256[] scores)',
  'function getLeaderboardCount(uint256 tournamentId) view returns (uint256)',
  'function isTournamentActive(uint256 tournamentId) view returns (bool)',
  'function nextTournamentId() view returns (uint256)',
  // Owner
  'function createTournament(string name, uint256 startTime, uint256 endTime, uint256 chipCost, uint256 tournamentChips, bool rebuyAllowed) returns (uint256)',
  'function cancelTournament(uint256 tournamentId)',
  'function awardTournamentChips(uint256 tournamentId, uint256 tokenId, uint256 amount)',
  'function spendTournamentChips(uint256 tournamentId, uint256 tokenId, uint256 amount)',
  'function distributePrize(address[] winners, uint256[] amounts)',
  'function withdraw()',
  // Events
  'event TournamentCreated(uint256 indexed tournamentId, string name, uint256 startTime, uint256 endTime, uint256 chipCost, uint256 tournamentChips, bool rebuyAllowed)',
  'event TournamentEntered(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 tournamentChips)',
  'event ScoreLocked(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 score)',
  'event ScoreUpdated(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 oldScore, uint256 newScore)',
];
