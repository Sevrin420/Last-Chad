/**
 * deployEverything.js
 *
 * Full deploy of the Members Only / Club Nile protocol — just THREE contracts:
 *   1. MembersOnly      (ERC-721 — membership NFTs)
 *   2. MembersOnlyItems (ERC-1155 — chips id 0 + tournament tokens id 1 + items,
 *                        the AVAX-backed vault)
 *   3. Casino           (the single oracle-authorized operator: chip wagering,
 *                        the chip cage + tournament-token cage, the burn-for-yield
 *                        leaderboard, and CHIP tip/gallery-buy routing)
 *
 * MembersOnly + Items are separate because one is ERC-721 and one is ERC-1155,
 * and Items is the vault (holds the bankroll + is the mint/burn authority).
 * Everything else that used to be its own operator contract (Gamble, Tournament,
 * TournamentLeaderboard, Tips) is now one Casino, swappable via Items
 * authorization without touching the vault.
 *
 * After deploy:
 *   - Wires MembersOnly ⇄ Items and authorizes Casino on Items
 *   - Sets weekly tier rewards to spec (Common 20 / Rare 40 / Legendary 100)
 *   - Optionally seeds the house bankroll (HOUSE_DEPOSIT_AVAX)
 *   - Patches js/config.js, worker/wrangler.toml, and games/clubnile.html;
 *     with --network avalanche it also flips every Fuji value to mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/deployEverything.js --network fuji
 *   npx hardhat run scripts/deployEverything.js --network avalanche
 *
 * Env vars:
 *   PRIVATE_KEY        — deployer wallet
 *   ORACLE_ADDRESS     — Cloudflare Worker public key (REQUIRED)
 *   TEAM_WALLET        — team/house tip payout wallet (optional; defaults to
 *                        the deployer, re-pointable later via Casino.setTeamWallet)
 *   HOUSE_DEPOSIT_AVAX — optional initial house bankroll to fund via
 *                        Items.depositHouse() (e.g. "1.0"); skipped if unset/0
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const SET_GAME_ABI    = ['function setGameContract(address gameContract, bool approved) external'];
const SET_ITEMS_ABI   = [
  'function setItems(address _items) external',
  'function setTierReward(uint8 tier, uint256 amount) external',
];
const DEPOSIT_HOUSE_ABI = ['function depositHouse() external payable'];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;
  const isMainnet  = network === 'avalanche' || network === 'mainnet';

  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress || !hre.ethers.isAddress(oracleAddress)) {
    throw new Error("ORACLE_ADDRESS env var is required (non-zero address).");
  }
  const teamWallet = (process.env.TEAM_WALLET && hre.ethers.isAddress(process.env.TEAM_WALLET))
    ? process.env.TEAM_WALLET
    : deployer.address;

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║         Club Nile — 3-Contract Protocol Deploy            ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network:   ${network} (${isMainnet ? 'mainnet 0xa86a' : 'Fuji 0xa869'})`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Oracle:    ${oracleAddress}`);
  console.log(`  Team:      ${teamWallet}${teamWallet === deployer.address ? ' (deployer — set TEAM_WALLET to override)' : ''}\n`);

  // ── 1. MembersOnly ──────────────────────────────────────────────────────
  console.log("1/3  Deploying MembersOnly (ERC-721)...");
  const MembersOnly = await hre.ethers.getContractFactory("MembersOnly");
  const membersOnly = await MembersOnly.deploy("https://membersonly.cc/members-metadata/");
  await membersOnly.waitForDeployment();
  const membersOnlyAddress = await membersOnly.getAddress();
  console.log("     ✓ MembersOnly:", membersOnlyAddress);

  // ── 2. MembersOnlyItems ─────────────────────────────────────────────────
  console.log("\n2/3  Deploying MembersOnlyItems (ERC-1155 vault)...");
  const MembersOnlyItems = await hre.ethers.getContractFactory("MembersOnlyItems");
  const membersOnlyItems = await MembersOnlyItems.deploy("https://membersonly.cc/items/", membersOnlyAddress);
  await membersOnlyItems.waitForDeployment();
  const itemsAddress = await membersOnlyItems.getAddress();
  console.log("     ✓ MembersOnlyItems:", itemsAddress);

  // ── 3. Casino ─────────────────────────────────────────────────────────────
  console.log("\n3/3  Deploying Casino (operator)...");
  const Casino = await hre.ethers.getContractFactory("Casino");
  const casino = await Casino.deploy(membersOnlyAddress, itemsAddress, oracleAddress, teamWallet);
  await casino.waitForDeployment();
  const casinoAddress = await casino.getAddress();
  console.log("     ✓ Casino:", casinoAddress);

  // ════════════════════════════════════════════════════════════════════════
  // WIRING
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── Wiring contracts ──────────────────────────────────────");
  let tx;

  const moSetItems = new hre.ethers.Contract(membersOnlyAddress, SET_ITEMS_ABI, deployer);
  tx = await moSetItems.setItems(itemsAddress); await tx.wait();
  console.log("  MembersOnly.setItems(Items)                ✓");

  const itemsAuth = new hre.ethers.Contract(itemsAddress, SET_GAME_ABI, deployer);
  tx = await itemsAuth.setGameContract(membersOnlyAddress, true); await tx.wait();
  console.log("  Items.setGameContract(MembersOnly)         ✓");
  tx = await itemsAuth.setGameContract(casinoAddress, true); await tx.wait();
  console.log("  Items.setGameContract(Casino)              ✓");

  // Weekly tournament-token drop per rarity (spec): Common 20 / Rare 40 / Legendary 100
  console.log("\n── Setting tier rewards ──────────────────────────────────");
  const tierRewards = { 1: 20, 2: 40, 3: 100 };
  const tierNames   = { 1: 'Common', 2: 'Rare', 3: 'Legendary' };
  for (const [tier, reward] of Object.entries(tierRewards)) {
    tx = await moSetItems.setTierReward(tier, reward); await tx.wait();
    console.log(`  ${tierNames[tier]} (tier ${tier}): +${reward} tokens/week       ✓`);
  }

  // Optional: seed the house bankroll so free-chip winnings don't revert.
  const houseDeposit = process.env.HOUSE_DEPOSIT_AVAX;
  if (houseDeposit && parseFloat(houseDeposit) > 0) {
    console.log("\n── Funding house bankroll ────────────────────────────────");
    const itemsHouse = new hre.ethers.Contract(itemsAddress, DEPOSIT_HOUSE_ABI, deployer);
    tx = await itemsHouse.depositHouse({ value: hre.ethers.parseEther(houseDeposit) }); await tx.wait();
    console.log(`  Items.depositHouse(${houseDeposit} AVAX)                ✓`);
  } else {
    console.log("\n── House bankroll ────────────────────────────────────────");
    console.log("  ⓘ HOUSE_DEPOSIT_AVAX unset — fund Items.depositHouse() before");
    console.log("    paying out any free chips.");
  }

  // ════════════════════════════════════════════════════════════════════════
  // PATCH CONFIG FILES  (+ Fuji→mainnet flip on --network avalanche)
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── Patching config files ─────────────────────────────────");
  console.log(`  Target network: ${isMainnet ? 'Avalanche MAINNET (0xa86a)' : 'Fuji testnet (0xa869)'}`);

  // 0xa869 and 43113 are anchored (quoted / word-boundary) so they can only
  // match chain-id tokens, never a substring of a freshly deployed address.
  const toMainnet = (s) => s
    .replace(/api\.avax-test\.network/g, 'api.avax.network')
    .replace(/rpc\.ankr\.com\/avalanche_fuji/g, 'rpc.ankr.com/avalanche')
    .replace(/testnet\.snowtrace\.io/g, 'snowtrace.io')
    .replace(/Avalanche Fuji Testnet/g, 'Avalanche C-Chain')
    .replace(/\b43113\b/g, '43114')
    .replace(/'0xa869'/g, "'0xa86a'");

  // js/config.js — addresses + (mainnet) RPC / chain flip
  const configPath = path.join(__dirname, '..', 'js', 'config.js');
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');
    const replacements = {
      CONTRACT_ADDRESS:       membersOnlyAddress,
      ITEMS_CONTRACT_ADDRESS: itemsAddress,
      CASINO_ADDRESS:         casinoAddress,
    };
    for (const [key, addr] of Object.entries(replacements)) {
      const re = new RegExp(`export const ${key}\\s*=\\s*'[^']*'`);
      const pad = key.length < 24 ? ' '.repeat(24 - key.length) : ' ';
      config = config.replace(re, `export const ${key}${pad}= '${addr}'`);
    }
    if (isMainnet) config = toMainnet(config);
    fs.writeFileSync(configPath, config, 'utf8');
    console.log(`  js/config.js                             ✓  (3 addresses${isMainnet ? ' + mainnet' : ''})`);
  } else console.warn("  ⚠ js/config.js not found");

  // worker/wrangler.toml — addresses + (mainnet) RPC flip
  const wranglerPath = path.join(__dirname, '..', 'worker', 'wrangler.toml');
  if (fs.existsSync(wranglerPath)) {
    let wrangler = fs.readFileSync(wranglerPath, 'utf8');
    wrangler = wrangler.replace(/CONTRACT_ADDRESS\s*=\s*"[^"]*"/, `CONTRACT_ADDRESS      = "${membersOnlyAddress}"`);
    wrangler = wrangler.replace(/CASINO_ADDRESS\s*=\s*"[^"]*"/,   `CASINO_ADDRESS        = "${casinoAddress}"`);
    if (isMainnet) wrangler = toMainnet(wrangler);
    fs.writeFileSync(wranglerPath, wrangler, 'utf8');
    console.log(`  worker/wrangler.toml                     ✓  (2 addresses${isMainnet ? ' + mainnet RPC' : ''})`);
  } else console.warn("  ⚠ worker/wrangler.toml not found");

  // games/clubnile.html — its own hardcoded addresses + chain-switch calls
  const gamePath = path.join(__dirname, '..', 'games', 'clubnile.html');
  if (fs.existsSync(gamePath)) {
    let game = fs.readFileSync(gamePath, 'utf8');
    game = game.replace(/(const MINT_CFG = \{ address: )'0x[0-9a-fA-F]{40}'/, `$1'${membersOnlyAddress}'`);
    game = game.replace(/(items:\s*)'0x[0-9a-fA-F]{40}'(\s*,\s*\/\/ MembersOnlyItems)/, `$1'${itemsAddress}'$2`);
    game = game.replace(/(casino:\s*)'0x[0-9a-fA-F]{40}'(\s*,\s*\/\/ Casino)/, `$1'${casinoAddress}'$2`);
    if (isMainnet) game = toMainnet(game);
    fs.writeFileSync(gamePath, game, 'utf8');
    console.log(`  games/clubnile.html                      ✓  (3 addresses${isMainnet ? ' + mainnet chainId' : ''})`);
  } else console.warn("  ⚠ games/clubnile.html not found");

  // ════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║              Deployment Complete!                         ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network:          ${network} (${isMainnet ? 'mainnet 0xa86a' : 'Fuji 0xa869'})`);
  console.log(`  MembersOnly:      ${membersOnlyAddress}`);
  console.log(`  MembersOnlyItems: ${itemsAddress}`);
  console.log(`  Casino:           ${casinoAddress}`);
  console.log(`  Oracle:           ${oracleAddress}`);
  console.log(`  Team wallet:      ${teamWallet}`);
  console.log("");
  console.log("  Wiring:  MembersOnly ⇄ Items,  Items → Casino (authorized)");
  console.log("");
  console.log("  Patched: js/config.js, worker/wrangler.toml, games/clubnile.html");
  console.log(isMainnet
    ? "  ⚠ These now point at MAINNET — commit & push, then redeploy the worker."
    : "  ⓘ These point at Fuji staging — commit & push, redeploy the worker.");
  console.log("════════════════════════════════════════════════════════════\n");
}

main().catch(err => { console.error(err); process.exit(1); });
