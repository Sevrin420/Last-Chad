const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Tournament", function () {
  let membersOnly, items, tournament;
  let owner, user1, user2;
  const MINT_PRICE = ethers.parseEther("0.02");
  const CHIPS_ID = 0n;   // regular chips (real money)
  const TCHIPS_ID = 1n;  // tournament chips — the entry currency (minted 50 at mint)

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    const MembersOnly = await ethers.getContractFactory("MembersOnly");
    membersOnly = await MembersOnly.deploy("https://membersonly.xyz/metadata/");

    const Items = await ethers.getContractFactory("MembersOnlyItems");
    items = await Items.deploy("https://membersonly.xyz/items/", await membersOnly.getAddress());

    const Tournament = await ethers.getContractFactory("Tournament");
    tournament = await Tournament.deploy(await membersOnly.getAddress(), await items.getAddress());

    // Wire
    await membersOnly.setItems(await items.getAddress());
    await items.setGameContract(await membersOnly.getAddress(), true);
    await items.setGameContract(await tournament.getAddress(), true);

    // Mint NFTs
    await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
    await membersOnly.connect(user2).mint(1, { value: MINT_PRICE });
  });

  // ─── Tournament Creation ───
  describe("Creation", function () {
    it("should create a tournament", async function () {
      const now = await time.latest();
      await expect(tournament.createTournament("Weekly Craps", now + 60, now + 3660, 10, 1000, false))
        .to.emit(tournament, "TournamentCreated");

      const t = await tournament.getTournament(1);
      expect(t.name).to.equal("Weekly Craps");
      expect(t.chipCost).to.equal(10);
      expect(t.tournamentChips).to.equal(1000);
    });

    it("should cancel a tournament", async function () {
      const now = await time.latest();
      await tournament.createTournament("Test", now + 60, now + 3660, 0, 100, false);
      await tournament.cancelTournament(1);
      const t = await tournament.getTournament(1);
      expect(t.active).to.be.false;
    });
  });

  // ─── Entry ───
  describe("Entry", function () {
    beforeEach(async function () {
      const now = await time.latest();
      await tournament.createTournament("Test", now + 1, now + 7200, 10, 500, false);
      await time.increase(2);
    });

    it("should burn tournament chips (token 1) on entry", async function () {
      const before = await items.balanceOf(user1.address, TCHIPS_ID); // 50 from welcome bonus
      await tournament.connect(user1).enterTournament(1, 1);
      const after = await items.balanceOf(user1.address, TCHIPS_ID);
      expect(before - after).to.equal(10n);
    });

    it("should enter and receive tournament chips (internal)", async function () {
      await tournament.connect(user1).enterTournament(1, 1);
      const entry = await tournament.getEntry(1, 1);
      expect(entry.entered).to.be.true;
      expect(entry.tournamentChips).to.equal(500);
    });

    it("should enter a free tournament without burning chips", async function () {
      const now = await time.latest();
      await tournament.createTournament("Free", now + 1, now + 7200, 0, 100, false);
      await time.increase(2);

      const before = await items.balanceOf(user1.address, TCHIPS_ID);
      await tournament.connect(user1).enterTournament(2, 1);
      const after = await items.balanceOf(user1.address, TCHIPS_ID);
      expect(after).to.equal(before); // no tournament chips burned on free entry
    });

    it("should reject double entry without rebuy", async function () {
      await tournament.connect(user1).enterTournament(1, 1);
      await expect(
        tournament.connect(user1).enterTournament(1, 1)
      ).to.be.revertedWith("Rebuy not allowed");
    });
  });

  // ─── Score Locking ───
  describe("Score Locking", function () {
    beforeEach(async function () {
      const now = await time.latest();
      await tournament.createTournament("Test", now + 1, now + 7200, 0, 500, false);
      await time.increase(2);
      await tournament.connect(user1).enterTournament(1, 1);
    });

    it("should lock score", async function () {
      await tournament.connect(user1).lockScore(1, 1);
      const entry = await tournament.getEntry(1, 1);
      expect(entry.score).to.equal(500);
      expect(entry.tournamentChips).to.equal(0);
    });

    it("should add to leaderboard", async function () {
      await tournament.connect(user1).lockScore(1, 1);
      expect(await tournament.getLeaderboardCount(1)).to.equal(1);
    });
  });

  // ─── Rebuy ───
  describe("Rebuy", function () {
    beforeEach(async function () {
      const now = await time.latest();
      await tournament.createTournament("Rebuy", now + 1, now + 7200, 0, 500, true);
      await time.increase(2);
      await tournament.connect(user1).enterTournament(1, 1);
    });

    it("should allow rebuy after bust", async function () {
      await tournament.spendTournamentChips(1, 1, 500);
      await tournament.connect(user1).enterTournament(1, 1);
      const entry = await tournament.getEntry(1, 1);
      expect(entry.tournamentChips).to.equal(500);
      expect(entry.entryCount).to.equal(2);
    });

    it("should allow higher score to replace old", async function () {
      await tournament.connect(user1).lockScore(1, 1);
      await tournament.connect(user1).enterTournament(1, 1);
      await tournament.awardTournamentChips(1, 1, 100);
      await tournament.connect(user1).lockScore(1, 1);
      const entry = await tournament.getEntry(1, 1);
      expect(entry.score).to.equal(600);
    });
  });

  // ─── Tournament Chips are internal (not ERC-1155) ───
  describe("Tournament chips are calculations only", function () {
    it("tournament chips do not affect ERC-1155 chip balance", async function () {
      const now = await time.latest();
      await tournament.createTournament("Test", now + 1, now + 7200, 0, 500, false);
      await time.increase(2);

      const before = await items.balanceOf(user1.address, CHIPS_ID);
      await tournament.connect(user1).enterTournament(1, 1);
      const after = await items.balanceOf(user1.address, CHIPS_ID);

      // Free entry = no chip change; tournament chips are internal
      expect(after).to.equal(before);

      // But the player has 500 tournament chips internally
      const entry = await tournament.getEntry(1, 1);
      expect(entry.tournamentChips).to.equal(500);
    });
  });

  // ─── Prize Distribution (manual) ───
  describe("Prize Distribution", function () {
    it("should distribute AVAX prize to winners", async function () {
      const prize = ethers.parseEther("1");
      await owner.sendTransaction({ to: await tournament.getAddress(), value: prize });

      const balBefore = await ethers.provider.getBalance(user1.address);
      await tournament.distributePrize([user1.address], [prize]);
      const balAfter = await ethers.provider.getBalance(user1.address);
      expect(balAfter - balBefore).to.equal(prize);
    });
  });

  // ─── Rank-based yield/prize settlement ───
  describe("Rank-based prize settlement", function () {
    beforeEach(async function () {
      const now = await time.latest();
      await tournament.createTournament("Yield", now + 1, now + 7200, 0, 500, false);
      await time.increase(2);
      await tournament.connect(user1).enterTournament(1, 1);
      await tournament.connect(user2).enterTournament(1, 2);
      await tournament.awardTournamentChips(1, 1, 300); // user1 → 800 internal
      await tournament.connect(user1).lockScore(1, 1); // score 800
      await tournament.connect(user2).lockScore(1, 2); // score 500
    });

    it("pays the pool to top locked scores by weight", async function () {
      await tournament.fundPrizePool(1, { value: ethers.parseEther("10") });
      await tournament.setPrizeWeights(1, [7000, 3000]); // 70 / 30
      const b1 = await ethers.provider.getBalance(user1.address);
      const b2 = await ethers.provider.getBalance(user2.address);
      await tournament.settleTournament(1, [1, 2]); // highest score first
      expect((await ethers.provider.getBalance(user1.address)) - b1).to.equal(ethers.parseEther("7"));
      expect((await ethers.provider.getBalance(user2.address)) - b2).to.equal(ethers.parseEther("3"));
    });

    it("winner-take-all sends the whole pool to the top lock", async function () {
      await tournament.fundPrizePool(1, { value: ethers.parseEther("5") });
      await tournament.setPrizeWeights(1, [10000]);
      const b1 = await ethers.provider.getBalance(user1.address);
      await tournament.settleTournament(1, [1, 2]);
      expect((await ethers.provider.getBalance(user1.address)) - b1).to.equal(ethers.parseEther("5"));
    });

    it("skips ranks below minLockToQualify", async function () {
      await tournament.fundPrizePool(1, { value: ethers.parseEther("10") });
      await tournament.setPrizeWeights(1, [7000, 3000]);
      await tournament.setMinLockToQualify(1, 600); // user2 (500) does not qualify
      const b2 = await ethers.provider.getBalance(user2.address);
      await tournament.settleTournament(1, [1, 2]);
      expect((await ethers.provider.getBalance(user2.address)) - b2).to.equal(0n);
    });

    it("rejects a non-descending ranking", async function () {
      await tournament.fundPrizePool(1, { value: ethers.parseEther("10") });
      await tournament.setPrizeWeights(1, [7000, 3000]);
      await expect(tournament.settleTournament(1, [2, 1])) // 500 then 800 = ascending
        .to.be.revertedWith("Ranking not descending");
    });

    it("cannot settle twice", async function () {
      await tournament.fundPrizePool(1, { value: ethers.parseEther("5") });
      await tournament.setPrizeWeights(1, [10000]);
      await tournament.settleTournament(1, [1, 2]);
      await expect(tournament.settleTournament(1, [1, 2])).to.be.revertedWith("Already settled");
    });

    it("shields funded pools from withdraw", async function () {
      await tournament.fundPrizePool(1, { value: ethers.parseEther("4") });
      await expect(tournament.withdraw()).to.be.revertedWith("Nothing to withdraw");
    });

    it("rejects prize weights over 100%", async function () {
      await expect(tournament.setPrizeWeights(1, [7000, 4000])).to.be.revertedWith("Weights exceed 100%");
    });
  });
});
