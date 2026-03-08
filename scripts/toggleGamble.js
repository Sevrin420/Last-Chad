/**
 * toggleGamble.js
 *
 * Opens or closes the gambling den by authorizing / de-authorizing
 * the Gamble contract in LastChad.
 *
 * Usage:
 *   GAMBLE_OPEN=true  npx hardhat run scripts/toggleGamble.js --network fuji
 *   GAMBLE_OPEN=false npx hardhat run scripts/toggleGamble.js --network fuji
 *
 * Required env vars:
 *   PRIVATE_KEY  — owner wallet private key (hex, no 0x prefix)
 *   GAMBLE_OPEN  — "true" to open (authorize), "false" to close (de-authorize)
 */

const hre = require("hardhat");

const LAST_CHAD_ADDRESS = '0x27732900f9a87ced6a2ec5ce890d7ff58f882f76';
const GAMBLE_ADDRESS    = '0x9034A1B8F64d58E9e372C9aebBD64BFE6Bd294f1';

const SET_GAME_CONTRACT_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

async function main() {
  const open = process.env.GAMBLE_OPEN === 'true';
  const [owner] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\n${open ? 'Opening' : 'Closing'} gambling den on [${network}]`);
  console.log(`Owner:    ${owner.address}`);
  console.log(`LastChad: ${LAST_CHAD_ADDRESS}`);
  console.log(`Gamble:   ${GAMBLE_ADDRESS}\n`);

  const lastChad = new hre.ethers.Contract(
    LAST_CHAD_ADDRESS, SET_GAME_CONTRACT_ABI, owner
  );

  const tx = await lastChad.setGameContract(GAMBLE_ADDRESS, open);
  await tx.wait();
  console.log(`  lastChad.setGameContract(Gamble, ${open}) ✓`);
  console.log(`\nDone. Gambling den is now ${open ? 'OPEN' : 'CLOSED (maintenance)'}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
