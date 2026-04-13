# Members Only

> An NFT-gated casino on Avalanche. 222 Chads. Multiplayer craps, tournaments, and a player-to-player market.

Mint a Chad. Earn chips weekly. Hit the tables. Top the leaderboard.

---

## Play

**[lastchad.xyz](https://lastchad.xyz)**

---

## The Casino

Members Only is a fully on-chain casino where your membership is an ERC-721 NFT. Chips, tiers, and items are all stored on-chain.

### Membership
- 222 total supply, 0.01 AVAX to mint
- Max 5 per wallet
- Name your Chad (12 char max, unique)

### Chips
- In-game currency tied to your NFT (not your wallet)
- Earned weekly based on Tier + Level
- Spent at the tables (craps, gamble) and in tournaments

### Tiers & Levels
- **Tier** (1-3): set by owner to match metadata trait
- **Level** (1-4): determined by mint order (#1-50 = L1, #51-100 = L2, #101-150 = L3, #151-222 = L4)
- Both contribute to weekly chip rewards

### Items
- ERC-1155 tokens with chip bonuses
- Utilize (lock) items to your NFT for weekly bonus chips
- Trade on the market when not utilized

---

## Contracts

| Contract | Purpose |
|----------|---------|
| MembersOnly | ERC-721 NFT (222 max, chips, tiers, levels, weekly claims) |
| MembersOnlyItems | ERC-1155 items (stackable/non-stackable, utilize/lock) |
| Gamble | Chip wagering (craps buy-in, oracle settlements) |
| Tournament | Tournament entry, score locking, leaderboard |
| Market | Player-to-player NFT trading |

---

## Tech

- Solidity 0.8.26 + OpenZeppelin 5.0.0
- Hardhat 2.28.5
- ethers.js v5 + AppKit/Reown
- Cloudflare Workers + Durable Objects (craps tables)
- GitHub Pages

---

## Development

```bash
npm install
npm test
npx hardhat compile
```

Deployment and contract management is handled through the GitHub Actions **Deploy** workflow.

---

## License

MIT
