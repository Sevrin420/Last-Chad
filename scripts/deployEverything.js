/**
 * deployEverything.js
 *
 * One-click full deploy of ALL Members Only contracts:
 *   1. MembersOnly      (ERC-721 — membership NFTs)
 *   2. MembersOnlyItems (ERC-1155 — items + chips + treasury)
 *   3. Market           (NFT marketplace)
 *   4. Gamble           (chip wagering — oracle required)
 *   5. Tournament       (tournament system)
 *   6. Tips             (CHIP tips & gallery buys → team/creator wallets)
 *   7. TournamentLeaderboard (burn tournament tokens → monthly pro-rata yield)
 *
 * After deploy:
 *   - Wires all cross-contract references (incl. authorizing Tips for payFromChips)
 *   - Sets weekly tier rewards to spec (Common 20 / Rare 40 / Legendary 100)
 *   - Optionally seeds the house bankroll (HOUSE_DEPOSIT_AVAX)
 *   - Patches js/config.js and worker/wrangler.toml with new addresses
 *
 * Usage:
 *   npx hardhat run scripts/deployEverything.js --network fuji
 *   npx hardhat run scripts/deployEverything.js --network avalanche
 *
 * Env vars:
 *   PRIVATE_KEY        — deployer wallet
 *   ORACLE_ADDRESS     — Cloudflare Worker public key (REQUIRED for Gamble)
 *   TEAM_WALLET        — team/house tip payout wallet (optional; defaults to
 *                        the deployer, re-pointable later via Tips.setTeamWallet)
 *   HOUSE_DEPOSIT_AVAX — optional initial house bankroll to fund via
 *                        Items.depositHouse() (e.g. "1.0"); skipped if unset/0
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const SET_GAME_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

const SET_ITEMS_ABI = [
  'function setItems(address _items) external',
  'function setTierReward(uint8 tier, uint256 amount) external',
];

const DEPOSIT_HOUSE_ABI = [
  'function depositHouse() external payable',
];

const MARKET_WIRE_ABI = [
  'function setApprovedContract(address nftContract, bool approved) external',
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;
  const isMainnet  = network === 'avalanche' || network === 'mainnet';

  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress || !hre.ethers.isAddress(oracleAddress)) {
    throw new Error("ORACLE_ADDRESS env var is required (non-zero address).");
  }

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║         Members Only — Full Protocol Deploy               ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network:   ${network}`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Oracle:    ${oracleAddress}\n`);

  // ── 1. MembersOnly ──────────────────────────────────────────────────────
  const baseURI = "https://membersonly.cc/members-metadata/";
  console.log("1/5  Deploying MembersOnly (ERC-721)...");
  const MembersOnly = await hre.ethers.getContractFactory("MembersOnly");
  const membersOnly = await MembersOnly.deploy(baseURI);
  await membersOnly.waitForDeployment();
  const membersOnlyAddress = await membersOnly.getAddress();
  console.log("     ✓ MembersOnly:", membersOnlyAddress);

  // ── 2. MembersOnlyItems ─────────────────────────────────────────────────
  const itemsBaseURI = "https://membersonly.cc/items/";
  console.log("\n2/5  Deploying MembersOnlyItems (ERC-1155)...");
  const MembersOnlyItems = await hre.ethers.getContractFactory("MembersOnlyItems");
  const membersOnlyItems = await MembersOnlyItems.deploy(itemsBaseURI, membersOnlyAddress);
  await membersOnlyItems.waitForDeployment();
  const itemsAddress = await membersOnlyItems.getAddress();
  console.log("     ✓ MembersOnlyItems:", itemsAddress);

  // ── 3. Market ────────────────────────────────────────────────────────────
  console.log("\n3/5  Deploying Market...");
  const Market = await hre.ethers.getContractFactory("Market");
  const market = await Market.deploy(deployer.address);
  await market.waitForDeployment();
  const marketAddress = await market.getAddress();
  console.log("     ✓ Market:", marketAddress);

  // ── 4. Gamble ───────────────────────────────────────────────────────────
  console.log("\n4/5  Deploying Gamble...");
  const Gamble = await hre.ethers.getContractFactory("Gamble");
  const gamble = await Gamble.deploy(membersOnlyAddress, itemsAddress, oracleAddress);
  await gamble.waitForDeployment();
  const gambleAddress = await gamble.getAddress();
  console.log("     ✓ Gamble:", gambleAddress);

  // ── 5. Tournament ─────────────────────────────────────────────────────────
  console.log("\n5/6  Deploying Tournament...");
  const Tournament = await hre.ethers.getContractFactory("Tournament");
  const tournament = await Tournament.deploy(membersOnlyAddress, itemsAddress);
  await tournament.waitForDeployment();
  const tournamentAddress = await tournament.getAddress();
  console.log("     ✓ Tournament:", tournamentAddress);

  // ── 6. Tips ───────────────────────────────────────────────────────────────
  // Team wallet defaults to the deployer if TEAM_WALLET is unset; it can be
  // re-pointed any time via Tips.setTeamWallet(...). Creator wallets (band /
  // gallery) are registered post-deploy via Tips.setCreator / setCreators.
  const teamWallet = (process.env.TEAM_WALLET && hre.ethers.isAddress(process.env.TEAM_WALLET))
    ? process.env.TEAM_WALLET
    : deployer.address;
  console.log("\n6/7  Deploying Tips...");
  console.log("     Team wallet:", teamWallet,
    teamWallet === deployer.address ? "(deployer — set TEAM_WALLET to override)" : "");
  const Tips = await hre.ethers.getContractFactory("Tips");
  const tips = await Tips.deploy(itemsAddress, teamWallet);
  await tips.waitForDeployment();
  const tipsAddress = await tips.getAddress();
  console.log("     ✓ Tips:", tipsAddress);

  // ── 7. TournamentLeaderboard ──────────────────────────────────────────────
  console.log("\n7/7  Deploying TournamentLeaderboard...");
  const Leaderboard = await hre.ethers.getContractFactory("TournamentLeaderboard");
  const leaderboard = await Leaderboard.deploy(itemsAddress, membersOnlyAddress);
  await leaderboard.waitForDeployment();
  const leaderboardAddress = await leaderboard.getAddress();
  console.log("     ✓ TournamentLeaderboard:", leaderboardAddress);

  // ════════════════════════════════════════════════════════════════════════
  // WIRING
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── Wiring contracts ──────────────────────────────────────");
  let tx;

  // MembersOnly.setItems(itemsAddress) — so it can mint chips on mint/weekly
  const moSetItems = new hre.ethers.Contract(membersOnlyAddress, SET_ITEMS_ABI, deployer);
  tx = await moSetItems.setItems(itemsAddress);
  await tx.wait();
  console.log("  MembersOnly.setItems(Items)                ✓");

  // Items authorizes MembersOnly (for chip minting on mint/weekly)
  const itemsAuth = new hre.ethers.Contract(itemsAddress, SET_GAME_ABI, deployer);
  tx = await itemsAuth.setGameContract(membersOnlyAddress, true);
  await tx.wait();
  console.log("  Items.setGameContract(MembersOnly)         ✓");

  // Items authorizes Gamble (for chip burn/mint on wager/win)
  tx = await itemsAuth.setGameContract(gambleAddress, true);
  await tx.wait();
  console.log("  Items.setGameContract(Gamble)              ✓");

  // Items authorizes Tournament (for chip burn on entry)
  tx = await itemsAuth.setGameContract(tournamentAddress, true);
  await tx.wait();
  console.log("  Items.setGameContract(Tournament)          ✓");

  // Items authorizes Tips (for payFromChips — tip/buy chip→AVAX payouts)
  tx = await itemsAuth.setGameContract(tipsAddress, true);
  await tx.wait();
  console.log("  Items.setGameContract(Tips)                ✓");

  // Items authorizes TournamentLeaderboard (to burn tournament tokens on entry)
  tx = await itemsAuth.setGameContract(leaderboardAddress, true);
  await tx.wait();
  console.log("  Items.setGameContract(Leaderboard)         ✓");

  // Market approves MembersOnly + Items for trading
  const marketContract = new hre.ethers.Contract(marketAddress, MARKET_WIRE_ABI, deployer);
  tx = await marketContract.setApprovedContract(membersOnlyAddress, true);
  await tx.wait();
  console.log("  Market.setApprovedContract(MembersOnly)    ✓");

  tx = await marketContract.setApprovedContract(itemsAddress, true);
  await tx.wait();
  console.log("  Market.setApprovedContract(Items)          ✓");

  // Set weekly tournament-token drop per rarity to spec:
  //   Common=20, Rare=40, Legendary=100 tournament tokens/week.
  console.log("\n── Setting tier rewards ──────────────────────────────────");
  const tierRewards = { 1: 20, 2: 40, 3: 100 }; // 1=Common, 2=Rare, 3=Legendary
  const tierNames = { 1: 'Common', 2: 'Rare', 3: 'Legendary' };
  for (const [tier, reward] of Object.entries(tierRewards)) {
    tx = await moSetItems.setTierReward(tier, reward);
    await tx.wait();
    console.log(`  ${tierNames[tier]} (tier ${tier}): +${reward} tokens/week       ✓`);
  }

  // ── Optional: seed the house bankroll ─────────────────────────────────────
  // Free chip mints (game winnings) require the house to be funded or they
  // revert "House underfunded". Fund it now if HOUSE_DEPOSIT_AVAX is set.
  const houseDeposit = process.env.HOUSE_DEPOSIT_AVAX;
  if (houseDeposit && parseFloat(houseDeposit) > 0) {
    console.log("\n── Funding house bankroll ────────────────────────────────");
    const itemsHouse = new hre.ethers.Contract(itemsAddress, DEPOSIT_HOUSE_ABI, deployer);
    tx = await itemsHouse.depositHouse({ value: hre.ethers.parseEther(houseDeposit) });
    await tx.wait();
    console.log(`  Items.depositHouse(${houseDeposit} AVAX)                ✓`);
  } else {
    console.log("\n── House bankroll ────────────────────────────────────────");
    console.log("  ⓘ HOUSE_DEPOSIT_AVAX unset — skipping. Fund later via");
    console.log("    Items.depositHouse() before paying out any free chips.");
  }

  // ════════════════════════════════════════════════════════════════════════
  // PATCH CONFIG FILES
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── Patching config files ─────────────────────────────────");
  console.log(`  Target network: ${isMainnet ? 'Avalanche MAINNET (0xa86a)' : 'Fuji testnet (0xa869)'}`);

  // Flip every Fuji-specific value in `s` to mainnet. Idempotent + safe on an
  // already-mainnet string (the Fuji tokens simply won't be present).
  // 0xa869 and 43113 are anchored (quoted / word-boundary) so they can only
  // match chain-id tokens, never a substring of a freshly deployed address.
  const toMainnet = (s) => s
    .replace(/api\.avax-test\.network/g, 'api.avax.network')
    .replace(/rpc\.ankr\.com\/avalanche_fuji/g, 'rpc.ankr.com/avalanche')
    .replace(/testnet\.snowtrace\.io/g, 'snowtrace.io')
    .replace(/Avalanche Fuji Testnet/g, 'Avalanche C-Chain')
    .replace(/\b43113\b/g, '43114')
    .replace(/'0xa869'/g, "'0xa86a'");

  // ── js/config.js ── addresses + (on mainnet) RPC / chain flip
  const configPath = path.join(__dirname, '..', 'js', 'config.js');
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');

    const replacements = {
      CONTRACT_ADDRESS:       membersOnlyAddress,
      ITEMS_CONTRACT_ADDRESS: itemsAddress,
      MARKET_ADDRESS:         marketAddress,
      GAMBLE_ADDRESS:         gambleAddress,
      TOURNAMENT_ADDRESS:     tournamentAddress,
      TIPS_ADDRESS:           tipsAddress,
      LEADERBOARD_ADDRESS:    leaderboardAddress,
    };

    for (const [key, addr] of Object.entries(replacements)) {
      const re = new RegExp(`export const ${key}\\s*=\\s*'[^']*'`);
      const pad = key.length < 24 ? ' '.repeat(24 - key.length) : ' ';
      config = config.replace(re, `export const ${key}${pad}= '${addr}'`);
    }

    if (isMainnet) config = toMainnet(config);

    fs.writeFileSync(configPath, config, 'utf8');
    console.log(`  js/config.js                             ✓  (7 addresses${isMainnet ? ' + mainnet' : ''})`);
  } else {
    console.warn("  ⚠ js/config.js not found");
  }

  // ── worker/wrangler.toml ── addresses + (on mainnet) RPC flip
  const wranglerPath = path.join(__dirname, '..', 'worker', 'wrangler.toml');
  if (fs.existsSync(wranglerPath)) {
    let wrangler = fs.readFileSync(wranglerPath, 'utf8');
    wrangler = wrangler.replace(
      /CONTRACT_ADDRESS\s*=\s*"[^"]*"/,
      `CONTRACT_ADDRESS      = "${membersOnlyAddress}"`
    );
    wrangler = wrangler.replace(
      /GAMBLE_ADDRESS\s*=\s*"[^"]*"/,
      `GAMBLE_ADDRESS        = "${gambleAddress}"`
    );
    if (isMainnet) wrangler = toMainnet(wrangler);
    fs.writeFileSync(wranglerPath, wrangler, 'utf8');
    console.log(`  worker/wrangler.toml                     ✓  (2 addresses${isMainnet ? ' + mainnet RPC' : ''})`);
  } else {
    console.warn("  ⚠ worker/wrangler.toml not found");
  }

  // ── games/clubnile.html ── MINT_CFG / CAGE_CFG addresses + (mainnet) chainId
  // The game page carries its own hardcoded addresses and chain-switch calls
  // (independent of js/config.js), so patch them here too.
  const gamePath = path.join(__dirname, '..', 'games', 'clubnile.html');
  if (fs.existsSync(gamePath)) {
    let game = fs.readFileSync(gamePath, 'utf8');
    // MINT_CFG.address = MembersOnly
    game = game.replace(
      /(const MINT_CFG = \{ address: )'0x[0-9a-fA-F]{40}'/,
      `$1'${membersOnlyAddress}'`
    );
    // CAGE_CFG.items = MembersOnlyItems (anchored on its comment)
    game = game.replace(
      /(items:\s*)'0x[0-9a-fA-F]{40}'(\s*,\s*\/\/ MembersOnlyItems)/,
      `$1'${itemsAddress}'$2`
    );
    // CAGE_CFG.gamble = Gamble (anchored on its comment)
    game = game.replace(
      /(gamble:\s*)'0x[0-9a-fA-F]{40}'(\s*,\s*\/\/ Gamble)/,
      `$1'${gambleAddress}'$2`
    );
    if (isMainnet) game = toMainnet(game);  // MINT_CFG.chainId + switch calls 0xa869→0xa86a
    fs.writeFileSync(gamePath, game, 'utf8');
    console.log(`  games/clubnile.html                      ✓  (3 addresses${isMainnet ? ' + mainnet chainId' : ''})`);
  } else {
    console.warn("  ⚠ games/clubnile.html not found");
  }

  // ════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║              Deployment Complete!                         ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network:          ${network} (${isMainnet ? 'mainnet 0xa86a' : 'Fuji 0xa869'})`);
  console.log(`  MembersOnly:      ${membersOnlyAddress}`);
  console.log(`  MembersOnlyItems: ${itemsAddress}`);
  console.log(`  Market:           ${marketAddress}`);
  console.log(`  Gamble:           ${gambleAddress}`);
  console.log(`  Tournament:       ${tournamentAddress}`);
  console.log(`  Tips:             ${tipsAddress}`);
  console.log(`  Leaderboard:      ${leaderboardAddress}`);
  console.log(`  Team wallet:      ${teamWallet}`);
  console.log(`  Oracle:           ${oracleAddress}`);
  console.log("");
  console.log("  Wiring:");
  console.log("    MembersOnly.setItems(Items)             ✓");
  console.log("    Items ← authorized → MembersOnly       ✓");
  console.log("    Items ← authorized → Gamble            ✓");
  console.log("    Items ← authorized → Tournament        ✓");
  console.log("    Items ← authorized → Tips              ✓");
  console.log("    Items ← authorized → Leaderboard       ✓");
  console.log("    Market ← approved  → MembersOnly       ✓");
  console.log("    Market ← approved  → Items             ✓");
  console.log("");
  console.log("  Patched: js/config.js, worker/wrangler.toml, games/clubnile.html");
  console.log(isMainnet
    ? "  ⚠ These files now point at MAINNET — commit & push them, then\n" +
      "    redeploy the worker so the new addresses/RPC go live."
    : "  ⓘ Files point at Fuji staging — commit & push, redeploy worker.");
  console.log("════════════════════════════════════════════════════════════\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
