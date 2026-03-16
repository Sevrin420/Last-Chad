const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE = ethers.parseEther("2");
const BASE_URI = "https://lastchad.xyz/metadata/";
const QUEST_ID = 0;

describe("QuestRewards", function () {
  let lastChad, questRewards, owner, player, other;

  beforeEach(async function () {
    [owner, player, other] = await ethers.getSigners();

    const LastChad = await ethers.getContractFactory("LastChad");
    lastChad = await LastChad.deploy(BASE_URI);

    const QuestRewards = await ethers.getContractFactory("QuestRewards");
    questRewards = await QuestRewards.deploy(await lastChad.getAddress());

    // Authorize QuestRewards
    await lastChad.setGameContract(await questRewards.getAddress(), true);

    // Configure quest 0: 5 bonus cells, no item
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

    it("has default quest cooldown of 30 days", async function () {
      expect(await questRewards.questCooldown()).to.equal(30 * 24 * 3600);
    });
  });

  // ──────────────────────────────────────────────────────────
  // startQuest (no escrow — uses isActive flag)
  // ──────────────────────────────────────────────────────────
  describe("startQuest", function () {
    it("emits QuestStarted with correct args", async function () {
      const tx = await questRewards.connect(player).startQuest(1, QUEST_ID);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment?.name === "QuestStarted");
      expect(event).to.not.be.undefined;
      expect(event.args.tokenId).to.equal(1);
      expect(event.args.questId).to.equal(QUEST_ID);
      expect(event.args.seed).to.not.equal(ethers.ZeroHash);
    });

    it("sets isActive on the token (no NFT transfer)", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      expect(await lastChad.isActive(1)).to.be.true;
      // NFT stays with player
      expect(await lastChad.ownerOf(1)).to.equal(player.address);
    });

    it("stores an active session", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      const session = await questRewards.getSession(1);
      expect(session.active).to.be.true;
      expect(session.questId).to.equal(QUEST_ID);
    });

    it("blocks transfer while quest is active", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await expect(
        lastChad.connect(player).transferFrom(player.address, other.address, 1)
      ).to.be.revertedWith("Token is active in quest/arcade");
    });

    it("reverts when caller does not own the token", async function () {
      await expect(
        questRewards.connect(other).startQuest(1, QUEST_ID)
      ).to.be.revertedWith("Not token owner");
    });

    it("reverts when token is already active", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await expect(
        questRewards.connect(player).startQuest(1, 1) // different quest
      ).to.be.revertedWith("Token already active");
    });

    it("reverts when eliminated", async function () {
      await lastChad.eliminate(1);
      await expect(
        questRewards.connect(player).startQuest(1, QUEST_ID)
      ).to.be.revertedWith("Chad eliminated");
    });

    it("enforces cooldown between same quest attempts", async function () {
      // Complete quest first
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      // Try again immediately — should fail
      await expect(
        questRewards.connect(player).startQuest(1, QUEST_ID)
      ).to.be.revertedWith("Quest on cooldown");
    });

    it("allows quest after cooldown expires", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      // Advance past cooldown
      await time.increase(30 * 24 * 3600 + 1);
      await expect(
        questRewards.connect(player).startQuest(1, QUEST_ID)
      ).to.not.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────
  // completeQuest
  // ──────────────────────────────────────────────────────────
  describe("completeQuest", function () {
    beforeEach(async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
    });

    it("awards cells and clears isActive", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      // 10 oracle + 5 config = 15 cells awarded
      expect(await lastChad.getOpenCells(1)).to.equal(20); // 5 starter + 15
      expect(await lastChad.isActive(1)).to.be.false;
    });

    it("emits QuestCompleted", async function () {
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x")
      ).to.emit(questRewards, "QuestCompleted").withArgs(1, QUEST_ID, 15, 0);
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

    it("reverts when not quest participant", async function () {
      await expect(
        questRewards.connect(other).completeQuest(1, QUEST_ID, 10, "0x")
      ).to.be.revertedWith("Not quest participant");
    });

    it("reverts when session expired", async function () {
      await time.increase(3601);
      await expect(
        questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x")
      ).to.be.revertedWith("Session expired");
    });

    it("reverts with wrong questId", async function () {
      await expect(
        questRewards.connect(player).completeQuest(1, 99, 10, "0x")
      ).to.be.revertedWith("Wrong quest");
    });

    it("allows transfer after completion", async function () {
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      await expect(
        lastChad.connect(player).transferFrom(player.address, other.address, 1)
      ).to.not.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────
  // failQuest
  // ──────────────────────────────────────────────────────────
  describe("failQuest", function () {
    beforeEach(async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
    });

    it("clears isActive and session without awarding cells", async function () {
      const cellsBefore = await lastChad.getOpenCells(1);
      await questRewards.failQuest(1, QUEST_ID);
      expect(await lastChad.isActive(1)).to.be.false;
      expect(await lastChad.getOpenCells(1)).to.equal(cellsBefore);
      const session = await questRewards.getSession(1);
      expect(session.active).to.be.false;
    });

    it("emits QuestFailed", async function () {
      await expect(questRewards.failQuest(1, QUEST_ID))
        .to.emit(questRewards, "QuestFailed").withArgs(1, QUEST_ID);
    });

    it("only game owner can call failQuest", async function () {
      await expect(
        questRewards.connect(player).failQuest(1, QUEST_ID)
      ).to.be.revertedWith("Not game owner");
    });

    it("reverts with wrong questId", async function () {
      await expect(questRewards.failQuest(1, 99))
        .to.be.revertedWith("Wrong quest");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Arcade Sessions
  // ──────────────────────────────────────────────────────────
  describe("Arcade Sessions", function () {
    const seed = ethers.keccak256(ethers.toUtf8Bytes("test-seed"));

    it("game owner can start arcade session", async function () {
      await expect(questRewards.startArcade(1, 0, seed))
        .to.emit(questRewards, "ArcadeStarted").withArgs(1, 0, seed);
      expect(await lastChad.isActive(1)).to.be.true;
    });

    it("reverts if token already active", async function () {
      await questRewards.startArcade(1, 0, seed);
      await expect(
        questRewards.startArcade(1, 1, seed)
      ).to.be.revertedWith("Token already active");
    });

    it("reverts if eliminated", async function () {
      await lastChad.eliminate(1);
      await expect(
        questRewards.startArcade(1, 0, seed)
      ).to.be.revertedWith("Chad eliminated");
    });

    it("confirmSurvival clears session and isActive", async function () {
      await questRewards.startArcade(1, 0, seed);
      await expect(questRewards.confirmSurvival(1))
        .to.emit(questRewards, "ArcadeSurvived").withArgs(1, 0);
      expect(await lastChad.isActive(1)).to.be.false;
    });

    it("confirmDeath eliminates the chad", async function () {
      await questRewards.startArcade(1, 0, seed);
      await expect(questRewards.confirmDeath(1))
        .to.emit(questRewards, "ArcadeDeath").withArgs(1, 0);
      expect(await lastChad.isActive(1)).to.be.false;
      expect(await lastChad.eliminated(1)).to.be.true;
    });

    it("non-game-owner cannot start arcade", async function () {
      await expect(
        questRewards.connect(player).startArcade(1, 0, seed)
      ).to.be.revertedWith("Not game owner");
    });

    it("confirmSurvival reverts with no active session", async function () {
      await expect(questRewards.confirmSurvival(1))
        .to.be.revertedWith("No active arcade session");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Death Rate Limiter
  // ──────────────────────────────────────────────────────────
  describe("Death Rate Limiter", function () {
    const seed = ethers.keccak256(ethers.toUtf8Bytes("seed"));

    it("allows deaths up to MAX_DEATHS_PER_WINDOW", async function () {
      // Mint 10 tokens
      await lastChad.connect(player).mint(10, { value: PRICE * 10n });
      for (let i = 2; i <= 11; i++) {
        await questRewards.startArcade(i, 0, seed);
        await questRewards.confirmDeath(i);
      }
      // All 10 should be eliminated
      for (let i = 2; i <= 11; i++) {
        expect(await lastChad.eliminated(i)).to.be.true;
      }
    });

    it("blocks deaths exceeding window limit", async function () {
      await lastChad.connect(player).mint(12, { value: PRICE * 12n });
      // Kill 10
      for (let i = 2; i <= 11; i++) {
        await questRewards.startArcade(i, 0, seed);
        await questRewards.confirmDeath(i);
      }
      // 11th death should fail
      await questRewards.startArcade(12, 0, seed);
      await expect(questRewards.confirmDeath(12))
        .to.be.revertedWith("Too many deaths - auto-paused");
    });

    it("death window resets after DEATH_WINDOW seconds", async function () {
      await lastChad.connect(player).mint(12, { value: PRICE * 12n });
      // Kill 10
      for (let i = 2; i <= 11; i++) {
        await questRewards.startArcade(i, 0, seed);
        await questRewards.confirmDeath(i);
      }
      // Wait past death window
      await time.increase(61);
      // Should allow again
      await questRewards.startArcade(12, 0, seed);
      await expect(questRewards.confirmDeath(12)).to.not.be.reverted;
    });

    it("pauseDeaths blocks all deaths", async function () {
      await questRewards.pauseDeaths();
      await questRewards.startArcade(1, 0, seed);
      await expect(questRewards.confirmDeath(1))
        .to.be.revertedWith("Deaths paused");
    });

    it("unpauseDeaths allows deaths again", async function () {
      await questRewards.pauseDeaths();
      await questRewards.unpauseDeaths();
      await questRewards.startArcade(1, 0, seed);
      await expect(questRewards.confirmDeath(1)).to.not.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────
  // Emergency Release
  // ──────────────────────────────────────────────────────────
  describe("Emergency Release", function () {
    it("releaseQuest clears session and isActive", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await questRewards.releaseQuest(1);
      expect(await lastChad.isActive(1)).to.be.false;
      const session = await questRewards.getSession(1);
      expect(session.active).to.be.false;
    });

    it("releaseArcade clears session and isActive", async function () {
      const seed = ethers.keccak256(ethers.toUtf8Bytes("seed"));
      await questRewards.startArcade(1, 0, seed);
      await questRewards.releaseArcade(1);
      expect(await lastChad.isActive(1)).to.be.false;
    });

    it("only game owner can release", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await expect(
        questRewards.connect(player).releaseQuest(1)
      ).to.be.revertedWith("Not game owner");
    });
  });

  // ──────────────────────────────────────────────────────────
  // View helpers
  // ──────────────────────────────────────────────────────────
  describe("View helpers", function () {
    it("getSession returns active=false when no session", async function () {
      const session = await questRewards.getSession(1);
      expect(session.active).to.be.false;
    });

    it("isSessionExpired returns true after 1 hour", async function () {
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await time.increase(3601);
      expect(await questRewards.isSessionExpired(1)).to.be.true;
    });

    it("getArcadeSession returns data", async function () {
      const seed = ethers.keccak256(ethers.toUtf8Bytes("seed"));
      await questRewards.startArcade(1, 2, seed);
      const session = await questRewards.getArcadeSession(1);
      expect(session.seed).to.equal(seed);
      expect(session.gameType).to.equal(2);
      expect(session.active).to.be.true;
    });
  });

  // ──────────────────────────────────────────────────────────
  // Quest Cooldown Configuration
  // ──────────────────────────────────────────────────────────
  describe("Quest Cooldown", function () {
    it("game owner can change cooldown", async function () {
      await questRewards.setQuestCooldown(7 * 24 * 3600); // 1 week
      expect(await questRewards.questCooldown()).to.equal(7 * 24 * 3600);
    });

    it("shorter cooldown allows faster replay", async function () {
      await questRewards.setQuestCooldown(60); // 1 minute
      await questRewards.connect(player).startQuest(1, QUEST_ID);
      await questRewards.connect(player).completeQuest(1, QUEST_ID, 10, "0x");
      // Wait 61 seconds
      await time.increase(61);
      await expect(
        questRewards.connect(player).startQuest(1, QUEST_ID)
      ).to.not.be.reverted;
    });
  });
});
