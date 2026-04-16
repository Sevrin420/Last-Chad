# plan.md — Members Only Casino

---

## MAINNET CHECKLIST

Before deploying to mainnet, do these:

- [ ] **Flip `PARTNER_CHECKS_ENABLED` to `true`** in `mint.html` (line ~1005) — re-enables partner NFT validation
- [ ] **Switch `js/config.js` back to mainnet** — RPC, chain ID, explorer URLs
- [ ] **Deploy contracts to mainnet** via `deploy.yml` → target: `everything`, network: `avalanche`
- [ ] **Create Invitation item** — call `items.createItem("Invitation", 0, 0, true, 0, 0)` then `membersOnly.setInvitationItemId(itemId)`
- [ ] **Airdrop invitations** — call `items.batchAirdrop(wallets, invitationItemId, quantities)`
- [ ] **Verify contracts on Snowtrace** — deploy.yml → target: `verify`
- [ ] **Fix mint.html network enforcement** — mint page doesn't call `ensureSigner()`, so wallet can stay on mainnet
- [ ] **Restore knocker circle size** — currently 9% (shrunk for testing), change back to 13% in `index.html`
- [ ] **wallet.js network auto-switch** — currently auto-selects Fuji based on config.js AVAX_CHAIN_ID. When switching to mainnet, just change config.js chain ID to `0xa86a` and it will auto-use mainnet (no wallet.js changes needed)

---

## TESTNET → MAINNET SWITCH (config changes needed)

### js/config.js — change these values:

```js
// Contract addresses → will be auto-updated by deploy workflow
// RPC endpoints
export const READ_RPC           = 'https://rpc.ankr.com/avalanche';           // currently: avalanche_fuji
export const READ_RPC_FALLBACK  = 'https://api.avax.network/ext/bc/C/rpc';    // currently: api.avax-test.network

// Chain config
export const AVAX_CHAIN_ID = '0xa86a'; // 43114 mainnet — currently: 0xa869 (43113 Fuji)
export const AVAX_CHAIN = {
  chainId: AVAX_CHAIN_ID,
  chainName: 'Avalanche C-Chain',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: ['https://api.avax.network/ext/bc/C/rpc', 'https://rpc.ankr.com/avalanche'],
  blockExplorerUrls: ['https://snowtrace.io/']
};
```

### worker/wrangler.toml — change READ_RPC:

```toml
READ_RPC = "https://api.avax.network/ext/bc/C/rpc"   # currently: api.avax-test.network
```

Then redeploy worker: deploy.yml → target: `fix-worker`

### index.html CSP — add mainnet RPC to connect-src (already present):

`https://api.avax.network` is already in the CSP alongside `https://api.avax-test.network`. No change needed.

---

## CHANGES MADE FOR TESTNET PREP (April 2026)

### Code improvements (keep for mainnet):

1. **index.html — connectWallet call signature fixed**
   - Was: `connectWallet(onConnected)` (wrong — passed callback as walletName)
   - Now: `connectWallet(null, { onConnected })` (matches wallet.js API)

2. **index.html — dynamic invitationItemId**
   - Was: hardcoded `INVITATION_ITEM_ID = 1`
   - Now: reads `contract.invitationItemId()` from MembersOnly, falls back to item 1

3. **index.html — RPC fallback + error logging**
   - Was: silent `try {} catch {}` on balanceOf calls
   - Now: tries primary RPC, falls back to READ_RPC_FALLBACK, logs errors to console

4. **craps.html, poker.html, blackjack.html — RPC fallback**
   - Same pattern: import READ_RPC_FALLBACK, retry membership check on failure
   - No more silent "Membership not found" on RPC hiccups

5. **index.html — NFT card styling**
   - `object-fit: contain` (was `cover` — cropped card art)
   - Border transparent by default, gold on hover/selected/glow
   - Invitation card shows alongside member NFTs

6. **js/config.js — invitation ABI entries added**
   - `invitationItemId()`, `mintWithInvitation()`, `setInvitationItemId()`

### Network-specific changes (revert for mainnet):

1. **js/config.js** — RPC endpoints, chain ID, chain config (see switch section above)
2. **worker/wrangler.toml** — READ_RPC (see switch section above)

---

## !!!!! NEVER DEPLOY CONTRACTS WITHOUT ASKING !!!!!
