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
export const CONTRACT_ADDRESS        = '0x1517f9a3D3005c01019B780dE7153a0A3292E2DE'; // MembersOnly (ERC-721)
export const ITEMS_CONTRACT_ADDRESS  = '0x66A3828a06b3C1Bf6D6DE39E229468e365e22EA5'; // MembersOnlyItems (ERC-1155 vault)
export const CASINO_ADDRESS          = '0x0000000000000000000000000000000000000000'; // Casino operator (set on deploy)

// ── RPC endpoints ────────────────────────────────────────────────────
export const READ_RPC                 = 'https://api.avax.network/ext/bc/C/rpc';
export const READ_RPC_FALLBACK        = 'https://rpc.ankr.com/avalanche';

// ── Chain config ─────────────────────────────────────────────────────
export const AVAX_CHAIN_ID = '0xa86a'; // 43114 Avalanche C-Chain
export const AVAX_CHAIN = {
  chainId: AVAX_CHAIN_ID,
  chainName: 'Avalanche C-Chain',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'],
  blockExplorerUrls: ['https://snowtrace.io/']
};

// ── WalletConnect ────────────────────────────────────────────────────
export const WALLETCONNECT_PROJECT_ID = '3aa99496af6ef381ca5d78f464777c45';

// ── NFT image URL ────────────────────────────────────────────────────
// NFT image URL — uses members folder with zero-padded filenames
export function getChadImageUrl(tokenId) {
  const num = String(tokenId).padStart(3, '0');
  return 'assets/members/member' + num + '.png';
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
  // Chips are an on-chain ERC-1155 token (id 0) held per-wallet in MembersOnlyItems.
  // Read a wallet's balance with ITEMS_ABI: balanceOf(wallet, 0). MembersOnly only
  // *grants* chips (mint bonus + weekly claim) via items.mintChips.
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
  'function nextDropAt() view returns (uint256)',
  'function weekAnchor() view returns (uint256)',
  'function weekLength() view returns (uint256)',
  'function setWeekSchedule(uint256 anchor, uint256 length)',
  'function claimWeeklyChips(uint256 tokenId)',
  'function getWeeklyReward(uint256 tokenId) view returns (uint256)',
  'function claimableWeeks(uint256 tokenId) view returns (uint256)',
  'function claimableChips(uint256 tokenId) view returns (uint256)',
  'function lastClaimWeek(uint256 tokenId) view returns (uint256)',
  'function hasClaimed(uint256 tokenId, uint256 week) view returns (bool)',
  // Active lock
  'function isActive(uint256 tokenId) view returns (bool)',
  'function setActive(uint256 tokenId, bool active)',
  // Invitation
  'function invitationItemId() view returns (uint256)',
  'function mintWithInvitation(uint256 quantity) payable',
  'function setInvitationItemId(uint256 itemId)',
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
  'event TierSet(uint256 indexed tokenId, uint8 tier)',
  'event WeeklyChipsClaimed(uint256 indexed tokenId, uint256 week, uint256 amount)',
  'event WeekScheduleSet(uint256 anchor, uint256 length)',
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

// ── Casino: the single operator (wagering + both cages + leaderboard + tips) ──
export const CASINO_ABI = [
  // Wagering — oracle-signed + two-tx settlement
  'function resolveGame(uint256 tokenId, uint256 wager, uint256 payout, uint8 gameId, uint256 nonce, bytes oracleSig) external',
  'function commitWager(uint256 tokenId, uint256 wager) external returns (uint256)',
  'function claimWinnings(uint256 tokenId, uint256 payout, uint256 nonce, bytes oracleSig) external',
  // Chip cage (AVAX-backed chips id 0)
  'function cageBuyIn(uint256 tokenId, uint256 amount) external returns (uint256)',
  'function cageCashOut(uint256 tokenId, uint256 amount, uint256 nonce, bytes oracleSig) external',
  'function cageLimit() view returns (uint256)',
  // Tournament-token cage (free tokens id 1)
  'function tourneyWithdraw(uint256 tokenId, uint256 amount) external returns (uint256)',
  'function tourneyDeposit(uint256 tokenId, uint256 amount, uint256 nonce, bytes oracleSig) external',
  'function tourneyCageLimit() view returns (uint256)',
  // Tips & gallery buys — paid in CHIPs, released as AVAX
  'function tipTeam(uint256 chips, string context)',
  'function tipCreator(bytes32 creatorId, uint256 chips, string category, string item)',
  'function buyFromCreator(bytes32 creatorId, uint256 chips, string item)',
  'function teamWallet() view returns (address)',
  'function creatorWallet(bytes32 creatorId) view returns (address)',
  // Burn-for-yield leaderboard (min 2000 to enter; monthly pro-rata)
  'function burnForLeaderboard(uint256 tokenId, uint256 amount)',
  'function MIN_BURN() view returns (uint256)',
  'function epoch() view returns (uint256)',
  'function burnedOf(uint256 epoch, uint256 tokenId) view returns (uint256)',
  'function totalBurned(uint256 epoch) view returns (uint256)',
  'function pool(uint256 epoch) view returns (uint256)',
  'function closed(uint256 epoch) view returns (bool)',
  'function claimed(uint256 epoch, uint256 tokenId) view returns (bool)',
  'function participantCount(uint256 epoch) view returns (uint256)',
  'function leaderboard(uint256 epoch, uint256 offset, uint256 limit) view returns (uint256[] ids, string[] names, uint256[] amounts)',
  'function pendingShare(uint256 epoch, uint256 tokenId) view returns (uint256)',
  'function fundYield() payable',
  'function closeEpoch()',
  'function claim(uint256 epoch, uint256 tokenId) returns (uint256)',
  'function claimMany(uint256 epoch, uint256[] tokenIds)',
  // Owner
  'function setOracle(address oracle) external',
  'function setWagerLimits(uint256 min, uint256 max) external',
  'function setTeamWallet(address wallet)',
  'function setCreator(bytes32 creatorId, address wallet)',
  'function setCreators(bytes32[] ids, address[] wallets)',
  'function withdrawSurplus(address to)',
  // View
  'function usedNonces(uint256 nonce) view returns (bool)',
  'function nextNonce() view returns (uint256)',
  // Events
  'event GameResolved(uint256 indexed tokenId, address indexed player, uint8 indexed gameId, uint256 wager, uint256 payout)',
  'event WagerCommitted(uint256 indexed tokenId, address indexed player, uint256 wager, uint256 nonce)',
  'event WinningsClaimed(uint256 indexed tokenId, address indexed player, uint256 payout, uint256 nonce)',
  'event CageBuyIn(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce)',
  'event CageCashOut(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce)',
  'event TourneyWithdraw(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce)',
  'event TourneyDeposit(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce)',
  'event TeamTip(address indexed from, uint256 chips, uint256 avax, string context)',
  'event CreatorTip(address indexed from, bytes32 indexed creatorId, address indexed wallet, uint256 chips, uint256 avax, string category, string item)',
  'event Purchase(address indexed from, bytes32 indexed creatorId, address indexed wallet, uint256 chips, uint256 avax, string item)',
  'event Burned(uint256 indexed epoch, uint256 indexed tokenId, string name, uint256 amount, uint256 cumulative)',
  'event YieldFunded(uint256 indexed epoch, uint256 amount, uint256 pool)',
  'event EpochClosed(uint256 indexed epoch, uint256 pool, uint256 totalBurned, uint256 nextEpoch)',
  'event Claimed(uint256 indexed epoch, uint256 indexed tokenId, address indexed to, uint256 amount)',
];
