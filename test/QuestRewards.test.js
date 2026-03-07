const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE = ethers.parseEther("0.02");
const BASE_URI = "https://lastchad.xyz/metadata/";
const QUEST_ID = 0;

// Extracts the seed from a QuestStarted event receipt
function seedFromReceipt(receipt) {
  const event = receipt.logs.find(l => l.fragment?.name === "QuestStarted");
  return event.args.seed;
}

describe("QuestRewards", function () {
  let lastChad, questRewards, owner, player, other;

  beforeEach(async function () {
    [owner, player, other] = await ethers.getSigners();

    const LastChad = await ethers.getContractFactory("LastChad");
    lastChad = await LastChad.deploy(BASE_URI);

    const QuestRewards = await ethers.getContractFactory("QuestRewards");
    questRewards = await QuestRewards.deploy(await lastChad.getAddress());

    // Authorize QuestRewards to call awardCells on LastChad
    await lastChad.setGameContract(await questRewards.getAddress(), true);

    // Configure quest 0: 5 bonus cells on completion, no item
    await questRewards.setQuestConfig(QUEST_ID, 5, 0);

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
    let seed;

    beforeEach(async function () {
      const tx = await questRewards.connect(player).startQuest(1, QUEST_ID);
      seed = seedFromReceipt(await tx.wait());
    });

    it("reverts when caller does not own the token", async function () {
      await expect(
        questRewards.connect(other).completeQuest(1, QUEST_ID, 10, "0x")
      ).to.be.revertedWith("Not token owner");
    });

    it("reverts when there is no active session", async function () {
      await lastChad.connect(player).mint(1, { value: PRICE });
      await expect(
        questRewards.connect(player).completeQuest(2, QUEST_ID, 10, "0x")
      ).to.be.revertedWith("No active session");
    });

    it("reverts when questId does not match the active session", async function () {
      await expect(
        questRewards.connect(player).completeQuest(1, 99, 10, "0x")
      ).to.be.revertedWith("Wrong quest");
    });

    it("reverts when the session has expired", async function () {
      await time.increase(3601);
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x")
      ).to.be.revertedWith("Session expired");
    });

    // — Cell awards —

    it("awards cells from oracle amount + quest config bonus", async function () {
      const cellReward = 10;
      // No oracle set, so signature not verified
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, cellReward, "0x")
      ).to.emit(questRewards, "QuestCompleted").withArgs(1, QUEST_ID, 15, 0);
      // 10 from oracle + 5 from quest config = 15 total
      // Player started with 5 open cells, now has 5 + 15 = 20
      expect(await lastChad.getOpenCells(1)).to.equal(20);
    });

    it("awards zero cells when oracle amount is 0", async function () {
      // Still gets quest config bonus of 5
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 0, "0x");
      expect(await lastChad.getOpenCells(1)).to.equal(10); // 5 starter + 5 config bonus
    });

    // — Post-completion state —

    it("open cells are recorded on the LastChad contract", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      expect(await lastChad.getOpenCells(1)).to.equal(20); // 5 + 10 + 5
    });

    it("marks questCompleted as true", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      expect(await questRewards.questCompleted(1, QUEST_ID)).to.be.true;
    });

    it("clears the active session", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      const session = await questRewards.getSession(1);
      expect(session.active).to.be.false;
    });

    it("cannot be completed a second time", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x")
      ).to.be.revertedWith("No active session");
    });

    it("returns NFT to player after completion", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      expect(await lastChad.ownerOf(1)).to.equal(player.address);
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
