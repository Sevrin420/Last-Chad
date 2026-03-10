# Last Chad

> A Mobile text-based adventure RPG with upgradable NFT characters on Avalanche.

Mint a Chad. Send them on quests. Roll dice. Play Mini-Games. Earn XP. Level up. Equip items. Don't die.

---

## Play

**[lastchad.xyz](https://lastchad.xyz)**

---

## The Game

Last Chad is a mobile fully on-chain RPG where your character is an ERC-721 NFT that permanently changes based on your choices. XP, levels, stats, and items are all stored on-chain. There is no reset.

### Characters
- 10,000 total supply, 2 AVAX to mint
- 4 stats: Strength, Intelligence, Dexterity, Charisma
- Distribute 2 points at setup, earn 1 more per level-up
- Level = total XP / 100

### Quests
- Your Chad is locked in escrow for the duration
- Dice rolls are deterministic — derived from an on-chain keccak256 seed
- One attempt per quest per Chad. Forever.
- Fail and your Chad might not come back

### Items
- ERC-1155 tokens earned through quests or direct claim
- Some items apply stat bonuses during gameplay
- Non-stackable items: one per wallet

### Cells
- In-game currency tied to your NFT (not your wallet)
- Earned mid-quest, spent in the quest shop

---

## Contracts — Fuji Testnet

| Contract | Address |
|----------|---------|
| LastChad (ERC-721) | `0xcE6D7bC4cAdfafc4cAe6BB86fD70ea206bDe884f` |
| LastChadItems (ERC-1155) | `0x00906C5b4a5943E212FD59d227e995F3390cf86d` |
| QuestRewards | `0x0CcA830784D13F4E9B606F914eB0c1deecA925eB` |
| Market | `0x2648fce03fe383c4a1d1a4c21fa59a0b9f35243d` |
| Gamble | `0x12527ec23064D11Fa128d6B36Db69252b86Ec0AC` |

---

## Tech

- Solidity 0.8.26 + OpenZeppelin 5.0.0
- Hardhat 2.28.5
- Web3.js + WalletConnect
- Cloudflare Worker (quest oracle)
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
