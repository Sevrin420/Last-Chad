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

---

## !!!!! NEVER DEPLOY CONTRACTS WITHOUT ASKING !!!!!
