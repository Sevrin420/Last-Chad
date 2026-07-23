# Aeterna — Game Design Document v4.1
**Slogan:** Vita Aeterna  
**Season Structure:** 56 Days Active / 14 Days Break  
**Last Updated:** July 23, 2026

---

## 1. Vision & Core Fantasy

Aeterna is an invitation-only, multi-generational NFT cult RPG set in a living digital abbey.

Players join a sacred community, perform daily duties, recruit others, build bloodlines, and ultimately decide whether to perform the Final Communion. The game explores faith, devotion, groupthink, and the cost of belief — powered by real DeFi yield.

**Core Goals**
- Fun daily + social play
- Grow a real Treasury that generates sustainable yield
- Heavily reward long-term and early believers through Devotion and bloodlines
- Allow short-term players meaningful returns through pure devotion
- Create a living economy around Souls

---

## 2. Season Structure

- 56 days active gameplay
- 14 days break
- Follows lunar 28-day rhythm
- Final Communion only on **Day 56**

---

## 3. Mint & Treasury

**Mint Prices**
- Season 1: 0.02 ETH
- Seasons 2–4: 0.015 ETH
- Supply: 2,220 Cultists per season

**Funds**
- All mint funds stay in ETH and earn DeFi yield
- ~25% targeted for player payouts at Final Communion
- Remaining stays in Treasury
- Yield distribution is fully admin-controlled and based on Devotion

---

## 4. The Cultist NFT

ERC-6551 Tokenbound Account.

**Holds**
- Gold (revealed only at Final Communion)
- Soul NFTs (carry Devotion)
- Cosmetics / relics

**Naming & Ranks**
- Brother / Sister [Name] (default)
- Deacon [Name] (manual)
- Bishop [Name] (manual / decided at Final Communion)
- Cardinal [Name] (manual)
- Children: Brother Scott II, Sister Mary III, etc.

**X Handle** — optional metadata at mint.

Starts at Level 1 with 0 Devotion.

---

## 5. Daily Duties & Devotion

**Required (every day for streak)**
1. Daily Devotional Prayer
2. Tending the Garden
3. Light the Sacred Candles

**Gift System (Physical)**
- Gifts spawn in the world
- Player picks up gift → holds it in front of character → walks → offers to another player
- On accept: gift disappears, Devotion awarded

| Recipient       | Giver | Receiver | Limits                          |
|-----------------|-------|----------|---------------------------------|
| Another Cultist | +10   | +5       | Giver 1/day, Receiver max 10/day |
| Guru            | +50   | —        | Giver 1/day                     |

**Streak Multipliers**
- 7d → 1.5×
- 14d → 2.0×
- 21d → 2.5×
- 28d → 3.0× (max)
- Level 10 still grants the maximum multiplier
- Levels above 10 are for ranking/flex only

**Confession (Streak Recovery)**
- Must be performed the next day after breaking streak
- Cost escalates per character per season:
  - 1st: 0.005 ETH
  - 2nd: 0.006 ETH
  - 3rd: 0.007 ETH
  - +0.001 ETH each additional time
- Cost resets each new season

---

## 6. Levels & Progression

- Level has **no cap**
- Level 10 = maximum multiplier
- All actions earn **Devotion only** (Legacy system removed)
- Level Up is an on-chain transaction that updates Level + Devotion and acts as a permanent checkpoint
- No gold is paid or shown at Level Up

---

## 7. Final Communion (Day 56)

Gold is calculated and revealed only at this moment.

**Choices**
1. **Leave the Cult** — receive gold, NFT burned, Devotion lost
2. **Tithe Everything** — Devotion is **doubled**
   - Has Child → full Devotion transfers to Child
   - No Child → 50% to a Free Soul

Ranks (Deacon / Bishop / Cardinal) are decided by the project at Final Communion.

---

## 8. Bloodline & Children

- Opposite sex, both must agree and sign
- Each parent pays 80% of mint price in gold
- 10-day gestation
- Each parent receives 1 Child NFT
- Max 1 child per parent
- Child passively receives a portion of parent’s new Devotion while parent is alive

---

## 9. Soul System

| Season | Max Souls a Cultist can hold |
|--------|------------------------------|
| 1      | 0                            |
| 2      | 1                            |
| 3      | 2                            |
| 4      | 3                            |

- 1 Soul may be added per season (Bloodline or Lost/Free Soul)
- Souls hold **Devotion**
- A new player in Season 4 can bind up to 3 Lost Souls

---

## 10. Gaming

- 2-player games (e.g. Mancala)
- Players wager ETH against each other
- 5% house rake
- Can contribute to Devotion (flexible)

---

## 11. Social & Admin

- Invitation-only recruitment
- Cathedral Rooms (ownable)
- X handle + social engagement can be rewarded manually
- Guru = special NFT controlled by project creator (not a normal Cultist)
- Admin can manually award Devotion at any time by X handle or character name
- Full admin control over yield unlock, formulas, and special distributions

---

## 12. Design Goals Check

| Goal                              | Status    |
|-----------------------------------|-----------|
| Fun daily + social play           | Strong    |
| Players see each other + physical gifts | Achieved |
| Simple elegant backend            | Achieved  |
| Sustainable Treasury + yield      | Strong    |
| Clean Devotion-only progression   | Achieved  |
| Uncapped Level + max mult at 10   | Achieved  |
| Full admin flexibility            | Achieved  |
| Runs on 2GB VPS                   | Achievable|
