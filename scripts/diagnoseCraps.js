/**
 * diagnoseCraps.js — Diagnose why craps commitWager fails
 *
 * Read-only checks (no private key needed):
 *   1. Contract code exists at all addresses
 *   2. Wallet owns NFT
 *   3. Wallet has chips (ERC-1155 token 0)
 *   4. Gamble is authorized in MembersOnly
 *   5. Gamble is authorized in MembersOnlyItems
 *   6. Gamble.items() and Gamble.membersOnly() point to correct contracts
 *   7. Simulate commitWager via eth_call (dry run)
 *   8. Worker /tables/list is reachable
 *
 * Usage:
 *   WALLET=0x... npx hardhat run scripts/diagnoseCraps.js --network fuji
 */

const hre = require("hardhat");
const { MEMBERS_ONLY, ITEMS, GAMBLE, TOURNAMENT, READ_RPC } = require('./addresses');

const WALLET = process.env.WALLET || process.env.AIRDROP_TO || '';
const WORKER_URL = 'https://last-chad-runner.severin20.workers.dev';

const MEMBERS_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function authorizedGame(address) view returns (bool)',
  'function isActive(uint256) view returns (bool)',
  'function items() view returns (address)',
];

const ITEMS_ABI = [
  'function balanceOf(address, uint256) view returns (uint256)',
  'function authorizedGame(address) view returns (bool)',
  'function CHIPS_ID() view returns (uint256)',
];

const GAMBLE_ABI = [
  'function membersOnly() view returns (address)',
  'function items() view returns (address)',
  'function oracle() view returns (address)',
  'function minWager() view returns (uint256)',
  'function maxWager() view returns (uint256)',
  'function nextNonce() view returns (uint256)',
  'function commitWager(uint256 tokenId, uint256 wager) returns (uint256)',
];

async function main() {
  const provider = new hre.ethers.JsonRpcProvider(READ_RPC);
  let pass = 0, fail = 0;

  function ok(msg) { console.log(`  ✓ ${msg}`); pass++; }
  function bad(msg) { console.log(`  ✗ ${msg}`); fail++; }
  function info(msg) { console.log(`  ℹ ${msg}`); }

  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  CRAPS DIAGNOSTIC — ${hre.network.name}`);
  console.log(`══════════════════════════════════════════════`);
  console.log(`  Wallet:       ${WALLET || '(not set)'}`);
  console.log(`  MembersOnly:  ${MEMBERS_ONLY}`);
  console.log(`  Items:        ${ITEMS}`);
  console.log(`  Gamble:       ${GAMBLE}`);
  console.log(`  RPC:          ${READ_RPC}`);
  console.log(`══════════════════════════════════════════════\n`);

  if (!WALLET || !hre.ethers.isAddress(WALLET)) {
    bad('WALLET env var not set or invalid');
    process.exit(1);
  }

  // 1. Contract code exists
  console.log('[1] Contract code check:');
  for (const [name, addr] of [['MembersOnly', MEMBERS_ONLY], ['Items', ITEMS], ['Gamble', GAMBLE]]) {
    const code = await provider.getCode(addr);
    if (code !== '0x' && code.length > 2) ok(`${name} has code (${code.length} bytes)`);
    else bad(`${name} has NO CODE at ${addr}`);
  }

  // 2. NFT ownership
  console.log('\n[2] NFT ownership:');
  const members = new hre.ethers.Contract(MEMBERS_ONLY, MEMBERS_ABI, provider);
  let nftBalance = 0, tokenId = null;
  try {
    nftBalance = Number(await members.balanceOf(WALLET));
    if (nftBalance > 0) {
      ok(`Wallet owns ${nftBalance} NFT(s)`);
      tokenId = Number(await members.tokenOfOwnerByIndex(WALLET, 0));
      info(`First token ID: ${tokenId}`);
    } else {
      bad('Wallet owns 0 NFTs');
    }
  } catch (e) {
    bad(`balanceOf failed: ${e.message}`);
  }

  // 3. Chips balance
  console.log('\n[3] Chips balance:');
  const items = new hre.ethers.Contract(ITEMS, ITEMS_ABI, provider);
  let chipBalance = 0;
  try {
    chipBalance = Number(await items.balanceOf(WALLET, 0));
    if (chipBalance > 0) ok(`Wallet has ${chipBalance} chips`);
    else bad('Wallet has 0 chips — commitWager will revert');
  } catch (e) {
    bad(`Chips balanceOf failed: ${e.message}`);
  }

  // 4. Token active status
  if (tokenId !== null) {
    console.log('\n[4] Token active status:');
    try {
      const active = await members.isActive(tokenId);
      if (!active) ok(`Token #${tokenId} is NOT active (good — commitWager requires inactive)`);
      else bad(`Token #${tokenId} IS active — commitWager will revert "Token is active"`);
    } catch (e) {
      bad(`isActive failed: ${e.message}`);
    }
  }

  // 5. Gamble authorization
  console.log('\n[5] Gamble authorization:');
  try {
    const authInMembers = await members.authorizedGame(GAMBLE);
    if (authInMembers) ok('Gamble authorized in MembersOnly');
    else bad('Gamble NOT authorized in MembersOnly');
  } catch (e) {
    bad(`authorizedGame on MembersOnly failed: ${e.message}`);
  }
  try {
    const authInItems = await items.authorizedGame(GAMBLE);
    if (authInItems) ok('Gamble authorized in MembersOnlyItems');
    else bad('Gamble NOT authorized in MembersOnlyItems — burnChips will revert');
  } catch (e) {
    bad(`authorizedGame on Items failed: ${e.message}`);
  }

  // 6. Gamble contract wiring
  console.log('\n[6] Gamble contract wiring:');
  const gamble = new hre.ethers.Contract(GAMBLE, GAMBLE_ABI, provider);
  try {
    const gambleMembers = await gamble.membersOnly();
    if (gambleMembers.toLowerCase() === MEMBERS_ONLY.toLowerCase()) ok('Gamble.membersOnly() matches');
    else bad(`Gamble.membersOnly() = ${gambleMembers} (expected ${MEMBERS_ONLY})`);
  } catch (e) {
    bad(`Gamble.membersOnly() failed: ${e.message}`);
  }
  try {
    const gambleItems = await gamble.items();
    if (gambleItems.toLowerCase() === ITEMS.toLowerCase()) ok('Gamble.items() matches');
    else bad(`Gamble.items() = ${gambleItems} (expected ${ITEMS})`);
  } catch (e) {
    bad(`Gamble.items() failed: ${e.message}`);
  }
  try {
    const oracle = await gamble.oracle();
    info(`Gamble.oracle() = ${oracle}`);
  } catch (e) {
    bad(`Gamble.oracle() failed: ${e.message}`);
  }
  try {
    const min = Number(await gamble.minWager());
    const max = Number(await gamble.maxWager());
    info(`Wager limits: min=${min}, max=${max}`);
  } catch (e) {
    info(`Wager limits not readable: ${e.message}`);
  }

  // 7. MembersOnly.items() wiring
  console.log('\n[7] MembersOnly.items() wiring:');
  try {
    const membersItems = await members.items();
    if (membersItems.toLowerCase() === ITEMS.toLowerCase()) ok('MembersOnly.items() matches');
    else bad(`MembersOnly.items() = ${membersItems} (expected ${ITEMS})`);
  } catch (e) {
    bad(`MembersOnly.items() failed: ${e.message}`);
  }

  // 8. Simulate commitWager (dry run via eth_call)
  if (tokenId !== null && chipBalance > 0) {
    console.log('\n[8] Simulate commitWager(tokenId, 1):');
    try {
      const calldata = gamble.interface.encodeFunctionData('commitWager', [tokenId, 1]);
      await provider.call({
        to: GAMBLE,
        data: calldata,
        from: WALLET,
      });
      ok('commitWager simulation succeeded (would not revert)');
    } catch (e) {
      const reason = e.reason || e.error?.message || e.message || '';
      bad(`commitWager simulation REVERTED: ${reason}`);
    }
  } else {
    console.log('\n[8] Skipping commitWager simulation (no token or no chips)');
  }

  // 9. Worker reachability
  console.log('\n[9] Worker reachability:');
  try {
    const resp = await fetch(WORKER_URL + '/tables/list');
    if (resp.ok) {
      const data = await resp.json();
      ok(`Worker /tables/list returned ${resp.status} (${JSON.stringify(data).slice(0, 100)}...)`);
    } else {
      bad(`Worker /tables/list returned ${resp.status}: ${await resp.text()}`);
    }
  } catch (e) {
    bad(`Worker unreachable: ${e.message}`);
  }

  // 10. Worker CORS preflight (OPTIONS /craps/start)
  console.log('\n[10] Worker CORS preflight:');
  try {
    const opts = await fetch(WORKER_URL + '/craps/start', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://membersonly.cc',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const acao = opts.headers.get('access-control-allow-origin') || '';
    const acam = opts.headers.get('access-control-allow-methods') || '';
    const acah = opts.headers.get('access-control-allow-headers') || '';
    info(`OPTIONS status: ${opts.status}`);
    info(`Access-Control-Allow-Origin: ${acao}`);
    info(`Access-Control-Allow-Methods: ${acam}`);
    info(`Access-Control-Allow-Headers: ${acah}`);
    if (opts.status === 204 && acao === 'https://membersonly.cc') {
      ok('CORS preflight passed for membersonly.cc');
    } else {
      bad(`CORS preflight issue: status=${opts.status}, origin=${acao}`);
    }
  } catch (e) {
    bad(`CORS preflight failed: ${e.message}`);
  }

  // 11. Worker POST /craps/start (with test data — expect 403 since no real wager)
  console.log('\n[11] Worker POST /craps/start (test):');
  try {
    const testResp = await fetch(WORKER_URL + '/craps/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://membersonly.cc',
      },
      body: JSON.stringify({ tokenId: tokenId || 1, nonce: 99999, player: WALLET, wager: 1 }),
    });
    const testBody = await testResp.text();
    const respAcao = testResp.headers.get('access-control-allow-origin') || '';
    info(`POST status: ${testResp.status}`);
    info(`Response ACAO: ${respAcao}`);
    info(`Body: ${testBody.slice(0, 200)}`);
    if (testResp.status === 403 && testBody.includes('No active wager')) {
      ok('Worker correctly rejects fake nonce with 403 + CORS headers');
    } else if (testResp.status === 403) {
      ok(`Worker returned 403: ${testBody.slice(0, 100)} (expected — no real wager)`);
    } else if (testResp.status === 500) {
      bad(`Worker 500 error: ${testBody.slice(0, 200)}`);
    } else {
      info(`Unexpected status ${testResp.status}: ${testBody.slice(0, 200)}`);
    }
    if (!respAcao) bad('Worker POST response missing Access-Control-Allow-Origin header!');
    else ok('Worker POST response has CORS headers');
  } catch (e) {
    bad(`Worker POST /craps/start failed: ${e.message}`);
  }

  // 12. Check for stuck nonces (recent wagers that weren't claimed)
  console.log('\n[12] Recent nonce status:');
  try {
    const nextNonce = Number(await gamble.nextNonce());
    info(`Gamble.nextNonce() = ${nextNonce}`);
    // Check last 5 nonces
    for (let n = Math.max(1, nextNonce - 5); n < nextNonce; n++) {
      const used = await gamble.usedNonces(BigInt(n));
      const wagerAmt = Number(await gamble.wagerAmounts(BigInt(n)));
      if (wagerAmt > 0 && !used) {
        info(`Nonce ${n}: wager=${wagerAmt}, used=${used} ← ACTIVE (unclaimed)`);
      } else if (used) {
        info(`Nonce ${n}: claimed`);
      } else {
        info(`Nonce ${n}: empty`);
      }
    }
  } catch (e) {
    bad(`Nonce check failed: ${e.message}`);
  }

  // Summary
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log(`══════════════════════════════════════════════\n`);

  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Diagnostic script crashed:', err);
  process.exit(1);
});
