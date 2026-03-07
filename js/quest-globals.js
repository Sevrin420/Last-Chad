// Shared contract configuration for all quest pages.
// Update this file when contracts are redeployed — all quest pages
// load it at runtime via <script src="../../js/quest-globals.js">,
// so a single edit here fixes every quest simultaneously.

var CONTRACT_ADDRESS = '0xcE6D7bC4cAdfafc4cAe6BB86fD70ea206bDe884f';
var ITEMS_CONTRACT_ADDRESS = '0x00906C5b4a5943E212FD59d227e995F3390cf86d';
var QUEST_REWARDS_ADDRESS = '0x0CcA830784D13F4E9B606F914eB0c1deecA925eB';

var READ_RPC = 'https://api.avax-test.network/ext/bc/C/rpc';
var READ_RPC_FALLBACK = 'https://rpc.ankr.com/avalanche_fuji';
var AVAX_CHAIN_ID = '0xa869';
var AVAX_CHAIN = {
  chainId: AVAX_CHAIN_ID,
  chainName: 'Avalanche Fuji Testnet',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: ['https://rpc.ankr.com/avalanche_fuji', 'https://api.avax-test.network/ext/bc/C/rpc'],
  blockExplorerUrls: ['https://testnet.snowtrace.io/']
};
var WALLETCONNECT_PROJECT_ID = '3aa99496af6ef381ca5d78f464777c45';

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
  'function getLevel(uint256 tokenId) external view returns (uint256)'
];

var LASTCHAD_ITEMS_ABI = [
  'function mint(uint256 itemId, uint256 quantity) external payable',
  'function getItem(uint256 itemId) external view returns (string memory name, uint256 maxSupply, uint256 minted, uint256 price, bool stackable, bool active)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)'
];

var QUEST_REWARDS_ABI = [
  'function startQuest(uint256 tokenId, uint8 questId) external',
  'function completeQuest(uint256 tokenId, uint8 questId, uint256 cellReward, bytes oracleSig) external',
  'function getSession(uint256 tokenId) external view returns (bytes32 seed, uint8 questId, uint256 startTime, uint256 expiresAt, bool active)',
  'function questCompleted(uint256 tokenId, uint8 questId) external view returns (bool)',
  'function lockedBy(uint256 tokenId) external view returns (address)'
];
