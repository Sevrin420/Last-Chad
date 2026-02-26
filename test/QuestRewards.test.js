const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE = ethers.parseEther("0.02");
const BASE_URI = "https://lastchad.xyz/metadata/";
const QUEST_ID = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Off-chain helpers — mirror the contract's internal scoring logic exactly
// ─────────────────────────────────────────────────────────────────────────────

// Matches: keccak256(abi.encodePacked(seed, roll, dieIndex)) % 6 + 1
function computeDie(seed, roll, dieIndex) {
  const packed = ethers.solidityPacked(
    ["bytes32", "uint8", "uint8"],
    [seed, roll, dieIndex]
  );
  return Number(BigInt(ethers.keccak256(packed)) % 6n) + 1;
}

// Applies kept1 / kept2 bitmasks to select which roll each die comes from
function computeFinalDice(seed, kept1, kept2) {
  return Array.from({ length: 5 }, (_, i) => {
    if ((kept1 >> i) & 1) return computeDie(seed, 1, i);
    if ((kept2 >> i) & 1) return computeDie(seed, 2, i);
    return computeDie(seed, 3, i);
  });
}

// Finds 6+5+4, returns sum of remaining 2 dice (or 0 if set not present)
function computeDiceScore(dice) {
  const used = new Array(5).fill(false);
  let has6 = false, has5 = false, has4 = false;
  for (let i = 0; i < 5 && !has6; i++) {
    if (dice[i] === 6) { has6 = true; used[i] = true; }
  }
  for (let i = 0; i < 5 && !has5; i++) {
    if (!used[i] && dice[i] === 5) { has5 = true; used[i] = true; }
  }
  for (let i = 0; i < 5 && !has4; i++) {
    if (!used[i] && dice[i] === 4) { has4 = true; used[i] = true; }
  }
  if (!has6 || !has5 || !has4) return 0;
  return dice.reduce((sum, v, i) => sum + (used[i] ? 0 : v), 0);
}

// Extracts the seed from a QuestStarted event receipt
function seedFromReceipt(receipt) {
  const event = receipt.logs.find(l => l.fragment?.name === "QuestStarted");
  return event.args.seed;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("QuestRewards", function () {
  let lastChad, questRewards, owner, player, other;

  beforeEach(async function () {
    [owner, player, other] = await ethers.getSigners();

    const LastChad = await ethers.getContractFactory("LastChad");
    lastChad = await LastChad.deploy(BASE_URI);

    const QuestRewards = await ethers.getContractFactory("QuestRewards");
    questRewards = await QuestRewards.deploy(await lastChad.getAddress());

    // Authorize QuestRewards to call awardExperience on LastChad
    await lastChad.setGameContract(await questRewards.getAddress(), true);

    // Mint token 1 to player
    await lastChad.connect(player).mint(1, { value: PRICE });
  });

  // ──────────────────────────────────────────────────────────
  // Deployment
  // ──────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("stores the LastChad contract address", async function () {
      expect(await questRewards.lastChad()).to.equal(await lastChad.getAddress());
    });

    it("has SESSION_DURATION = 3600 seconds", async function () {
      expect(await questRewards.SESSION_DURATION()).to.equal(3600);
    });
  });

  // ──────────────────────────────────────────────────────────
  // startQuest
  // ──────────────────────────────────────────────────────────
  describe("startQuest", function () {
    it("emits QuestStarted with tokenId, questId, and a non-zero seed", async function () {
      const tx = await questRewards.connect(player).startQuest(1, QUEST_ID);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment?.name === "QuestStarted");
      expect(event).to.not.be.undefined;
      expect(event.args.tokenId).to.equal(1);
      expect(event.args.questId).to.equal(QUEST_ID);
      expect(event.args.seed).to.not.equal(ethers.ZeroHash);
    });

    it("sets expiresAt to block.timestamp + 1 hour", async function () {
      const tx = await questRewards.connect(player).startQuest(1, QUEST_ID);
      const block = await ethers.provider.getBlock(tx.blockNumber);
      const session = await questRewards.getSession(1);
      expect(session.expiresAt).to.equal(BigInt(block.timestamp) + 3600n);
    });

    it("marks questStarted permanently", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      expect(await questRewards.questStarted(1, QUEST_ID)).to.be.true;
    });

    it("stores an active session with the correct questId", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      const session = await questRewards.getSession(1);
      expect(session.active).to.be.true;
      expect(session.questId).to.equal(QUEST_ID);
      expect(session.seed).to.not.equal(ethers.ZeroHash);
    });

    it("reverts when caller does not own the token", async function () {
      await expect(
        questRewards.connect(other).startQuest(1, QUEST_ID)
      ).to.be.revertedWith("Not token owner");
    });

    it("reverts on a second call for the same token and quest", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await expect(
        questRewards.connect(player).startQuest(1, QUEST_ID)
      ).to.be.revertedWith("Quest already attempted");
    });

    it("questStarted stays true and blocks retry even after session expires", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await time.increase(3601);
      expect(await questRewards.questStarted(1, QUEST_ID)).to.be.true;
      await expect(
        questRewards.connect(player).startQuest(1, QUEST_ID)
      ).to.be.revertedWith("Quest already attempted");
    });
  });

  // ──────────────────────────────────────────────────────────
  // completeQuest
  // ──────────────────────────────────────────────────────────
  describe("completeQuest", function () {
    // kept1 = kept2 = 0b11111 — all dice locked after roll 1.
    // Final dice are 100% predictable from the seed alone.
    const ALL_KEPT = 31;

    let seed;

    beforeEach(async function () {
      const tx = await questRewards.connect(player).startQuest(1, QUEST_ID);
      seed = seedFromReceipt(await tx.wait());
    });

    // — Input validation —

    it("reverts when caller does not own the token", async function () {
      await expect(
        questRewards.connect(other).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT)
      ).to.be.revertedWith("Not token owner");
    });

    it("reverts when there is no active session", async function () {
      // Token 2 has never had startQuest called
      await lastChad.connect(player).mint(1, { value: PRICE });
      await expect(
        questRewards.connect(player).completeQuest(2, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT)
      ).to.be.revertedWith("No active session");
    });

    it("reverts when questId does not match the active session", async function () {
      // Session has questId=0; passing 99 triggers "Wrong quest"
      await expect(
        questRewards.connect(player).completeQuest(1, 99, 1, 1, ALL_KEPT, ALL_KEPT)
      ).to.be.revertedWith("Wrong quest");
    });

    it("reverts when the session has expired", async function () {
      await time.increase(3601);
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT)
      ).to.be.revertedWith("Session expired");
    });

    it("reverts for choice1 > 1", async function () {
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 2, 1, ALL_KEPT, ALL_KEPT)
      ).to.be.revertedWith("Invalid choice1");
    });

    it("reverts for choice2 > 1", async function () {
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 2, ALL_KEPT, ALL_KEPT)
      ).to.be.revertedWith("Invalid choice2");
    });

    it("reverts for kept1 >= 32", async function () {
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, 32, 32)
      ).to.be.revertedWith("Invalid kept1");
    });

    it("reverts for kept2 >= 32", async function () {
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, 32)
      ).to.be.revertedWith("Invalid kept2");
    });

    it("reverts when kept2 is not a superset of kept1", async function () {
      // kept1 locks dice 0,2,4 — kept2 locks dice 1,3 — missing dice 0,2,4
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, 0b10101, 0b01010)
      ).to.be.revertedWith("kept2 must include all of kept1");
    });

    // — XP calculation —

    it("awards correct XP: upper tunnels + backup signal (max choices)", async function () {
      const dice = computeFinalDice(seed, ALL_KEPT, ALL_KEPT);
      const expected = 3 + computeDiceScore(dice) + 3; // choice1=upper, choice2=backup, dex=0
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT)
      ).to.emit(questRewards, "QuestCompleted").withArgs(1, QUEST_ID, expected);
    });

    it("awards correct XP: lower tunnels + force alone (min choices)", async function () {
      const dice = computeFinalDice(seed, 0, 0);
      const expected = 1 + computeDiceScore(dice) + 2; // choice1=lower, choice2=force, dex=0
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 0, 0, 0, 0)
      ).to.emit(questRewards, "QuestCompleted").withArgs(1, QUEST_ID, expected);
    });

    it("applies DEX bonus: dex=3 gives +2 bonus", async function () {
      await lastChad.addStat(1, 2, 3); // statIndex 2 = dexterity, adds 3
      const dice = computeFinalDice(seed, ALL_KEPT, ALL_KEPT);
      const expected = 3 + computeDiceScore(dice) + 3 + 2;
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT)
      ).to.emit(questRewards, "QuestCompleted").withArgs(1, QUEST_ID, expected);
    });

    it("applies DEX bonus: dex=1 gives no bonus", async function () {
      await lastChad.addStat(1, 2, 1); // dex=1, bonus=0
      const dice = computeFinalDice(seed, ALL_KEPT, ALL_KEPT);
      const expected = 3 + computeDiceScore(dice) + 3 + 0;
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT)
      ).to.emit(questRewards, "QuestCompleted").withArgs(1, QUEST_ID, expected);
    });

    // — Dice roll selection via bitmasks —

    it("uses roll 2 values for dice locked in kept2 but not kept1", async function () {
      const kept1 = 0b00000; // nothing locked after roll 1
      const kept2 = 0b11111; // everything locked after roll 2
      const dice = computeFinalDice(seed, kept1, kept2);
      const expected = 1 + computeDiceScore(dice) + 2;
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 0, 0, kept1, kept2)
      ).to.emit(questRewards, "QuestCompleted").withArgs(1, QUEST_ID, expected);
    });

    it("mixes roll values correctly across different keep decisions", async function () {
      const kept1 = 0b00011; // dice 0,1 locked after roll 1
      const kept2 = 0b01111; // dice 0,1,2,3 locked after roll 2; die 4 uses roll 3
      const dice = computeFinalDice(seed, kept1, kept2);
      const expected = 1 + computeDiceScore(dice) + 2;
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 0, 0, kept1, kept2)
      ).to.emit(questRewards, "QuestCompleted").withArgs(1, QUEST_ID, expected);
    });

    // — Post-completion state —

    it("XP is recorded on the LastChad contract", async function () {
      const dice = computeFinalDice(seed, ALL_KEPT, ALL_KEPT);
      const expected = 3 + computeDiceScore(dice) + 3;
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT);
      expect(await lastChad.getExperience(1)).to.equal(expected);
    });

    it("marks questCompleted as true", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT);
      expect(await questRewards.questCompleted(1, QUEST_ID)).to.be.true;
    });

    it("clears the active session", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT);
      const session = await questRewards.getSession(1);
      expect(session.active).to.be.false;
    });

    it("cannot be completed a second time", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT);
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 1, 1, ALL_KEPT, ALL_KEPT)
      ).to.be.revertedWith("No active session");
    });
  });

  // ──────────────────────────────────────────────────────────
  // View helpers
  // ──────────────────────────────────────────────────────────
  describe("View helpers", function () {
    it("getSession returns active=false when no session exists", async function () {
      const session = await questRewards.getSession(1);
      expect(session.active).to.be.false;
    });

    it("isSessionExpired returns false for an active non-expired session", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      expect(await questRewards.isSessionExpired(1)).to.be.false;
    });

    it("isSessionExpired returns true after 1 hour has passed", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await time.increase(3601);
      expect(await questRewards.isSessionExpired(1)).to.be.true;
    });

    it("isSessionExpired returns false when no session is active", async function () {
      expect(await questRewards.isSessionExpired(1)).to.be.false;
    });
  });
});
