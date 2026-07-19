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
  console.log("\n6/6  Deploying Tips...");
  console.log("     Team wallet:", teamWallet,
    teamWallet === deployer.address ? "(deployer — set TEAM_WALLET to override)" : "");
  const Tips = await hre.ethers.getContractFactory("Tips");
  const tips = await Tips.deploy(itemsAddress, teamWallet);
  await tips.waitForDeployment();
  const tipsAddress = await tips.getAddress();
  console.log("     ✓ Tips:", tipsAddress);

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
    };

    for (const [key, addr] of Object.entries(replacements)) {
      const re = new RegExp(`export const ${key}\\s*=\\s*'[^']*'`);
      const pad = key.length < 24 ? ' '.repeat(24 - key.length) : ' ';
      config = config.replace(re, `export const ${key}${pad}= '${addr}'`);
    }

    fs.writeFileSync(configPath, config, 'utf8');
    console.log("  js/config.js                             ✓  (6 addresses)");
  } else {
    console.warn("  ⚠ js/config.js not found");
  }

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
    fs.writeFileSync(wranglerPath, wrangler, 'utf8');
    console.log("  worker/wrangler.toml                     ✓  (2 addresses)");
  } else {
    console.warn("  ⚠ worker/wrangler.toml not found");
  }

  // ════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║              Deployment Complete!                         ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network:          ${network}`);
  console.log(`  MembersOnly:      ${membersOnlyAddress}`);
  console.log(`  MembersOnlyItems: ${itemsAddress}`);
  console.log(`  Market:           ${marketAddress}`);
  console.log(`  Gamble:           ${gambleAddress}`);
  console.log(`  Tournament:       ${tournamentAddress}`);
  console.log(`  Tips:             ${tipsAddress}`);
  console.log(`  Team wallet:      ${teamWallet}`);
  console.log(`  Oracle:           ${oracleAddress}`);
  console.log("");
  console.log("  Wiring:");
  console.log("    MembersOnly.setItems(Items)             ✓");
  console.log("    Items ← authorized → MembersOnly       ✓");
  console.log("    Items ← authorized → Gamble            ✓");
  console.log("    Items ← authorized → Tournament        ✓");
  console.log("    Items ← authorized → Tips              ✓");
  console.log("    Market ← approved  → MembersOnly       ✓");
  console.log("    Market ← approved  → Items             ✓");
  console.log("════════════════════════════════════════════════════════════\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
