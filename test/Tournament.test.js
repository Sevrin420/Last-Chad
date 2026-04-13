const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Tournament", function () {
  let MembersOnly, membersOnly;
  let Tournament, tournament;
  let owner, user1, user2;
  const MINT_PRICE = ethers.parseEther("0.01");

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    MembersOnly = await ethers.getContractFactory("MembersOnly");
    membersOnly = await MembersOnly.deploy("https://membersonly.xyz/metadata/");

    Tournament = await ethers.getContractFactory("Tournament");
    tournament = await Tournament.deploy(await membersOnly.getAddress());

    // Authorize tournament to spend/award chips
    await membersOnly.setGameContract(await tournament.getAddress(), true);

    // Mint NFTs for users
    await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
    await membersOnly.connect(user2).mint(1, { value: MINT_PRICE });
  });

  // ─── Tournament Creation ───
  describe("Creation", function () {
    it("should create a tournament", async function () {
      const now = await time.latest();
      const start = now + 60;
      const end = start + 3600;

      await expect(tournament.createTournament("Weekly Craps", start, end, 10, 1000, false))
        .to.emit(tournament, "TournamentCreated");

      const t = await tournament.getTournament(1);
      expect(t.name).to.equal("Weekly Craps");
      expect(t.chipCost).to.equal(10);
      expect(t.tournamentChips).to.equal(1000);
      expect(t.rebuyAllowed).to.be.false;
      expect(t.active).to.be.true;
    });

    it("should reject end before start", async function () {
      const now = await time.latest();
      await expect(
        tournament.createTournament("Bad", now + 100, now + 50, 0, 100, false)
      ).to.be.revertedWith("End must be after start");
    });

    it("should reject zero tournament chips", async function () {
      const now = await time.latest();
      await expect(
        tournament.createTournament("Bad", now + 60, now + 3600, 0, 0, false)
      ).to.be.revertedWith("Must award tournament chips");
    });

    it("should cancel a tournament", async function () {
      const now = await time.latest();
      await tournament.createTournament("Test", now + 60, now + 3600, 0, 100, false);
      await tournament.cancelTournament(1);

      const t = await tournament.getTournament(1);
      expect(t.active).to.be.false;
    });
  });

  // ─── Entry ───
  describe("Entry", function () {
    let tournamentId;

    beforeEach(async function () {
      const now = await time.latest();
      await tournament.createTournament("Test", now + 1, now + 7200, 10, 500, false);
      tournamentId = 1;
      await time.increase(2);
    });

    it("should enter a free tournament", async function () {
      const now = await time.latest();
      await tournament.createTournament("Free", now + 1, now + 7200, 0, 100, false);
      await time.increase(2);

      await tournament.connect(user1).enterTournament(2, 1);
      const entry = await tournament.getEntry(2, 1);
      expect(entry.entered).to.be.true;
      expect(entry.tournamentChips).to.equal(100);
    });

    it("should deduct chip cost on entry", async function () {
      const chipsBefore = await membersOnly.getChips(1);
      await tournament.connect(user1).enterTournament(1, 1);
      const chipsAfter = await membersOnly.getChips(1);
      expect(chipsBefore - chipsAfter).to.equal(10);
    });

    it("should reject entry before tournament starts", async function () {
      const now = await time.latest();
      await tournament.createTournament("Future", now + 10000, now + 20000, 0, 100, false);
      await expect(
        tournament.connect(user1).enterTournament(2, 1)
      ).to.be.revertedWith("Tournament not started");
    });

    it("should reject double entry without rebuy", async function () {
      await tournament.connect(user1).enterTournament(1, 1);
      await expect(
        tournament.connect(user1).enterTournament(1, 1)
      ).to.be.revertedWith("Rebuy not allowed");
    });

    it("should reject non-owner entry", async function () {
      await expect(
        tournament.connect(user2).enterTournament(1, 1)
      ).to.be.revertedWith("Not token owner");
    });
  });

  // ─── Score Locking ───
  describe("Score Locking", function () {
    let tournamentId;

    beforeEach(async function () {
      const now = await time.latest();
      await tournament.createTournament("Test", now + 1, now + 7200, 0, 500, false);
      tournamentId = 1;
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

    it("should reject lock when busted", async function () {
      await tournament.spendTournamentChips(1, 1, 500);
      await expect(
        tournament.connect(user1).lockScore(1, 1)
      ).to.be.revertedWith("Player busted");
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
      await tournament.spendTournamentChips(1, 1, 500); // bust
      await tournament.connect(user1).enterTournament(1, 1); // rebuy
      const entry = await tournament.getEntry(1, 1);
      expect(entry.tournamentChips).to.equal(500);
      expect(entry.entryCount).to.equal(2);
    });

    it("should allow higher score to replace old", async function () {
      await tournament.connect(user1).lockScore(1, 1);
      const entry1 = await tournament.getEntry(1, 1);
      expect(entry1.score).to.equal(500);

      // Rebuy
      await tournament.connect(user1).enterTournament(1, 1);
      await tournament.awardTournamentChips(1, 1, 100);

      await tournament.connect(user1).lockScore(1, 1);
      const entry2 = await tournament.getEntry(1, 1);
      expect(entry2.score).to.equal(600);
    });

    it("should reject lower score replacement", async function () {
      await tournament.connect(user1).lockScore(1, 1); // score = 500

      await tournament.connect(user1).enterTournament(1, 1); // rebuy
      await tournament.spendTournamentChips(1, 1, 100);

      await expect(
        tournament.connect(user1).lockScore(1, 1)
      ).to.be.revertedWith("New score must be higher than previous");
    });
  });

  // ─── Leaderboard ───
  describe("Leaderboard", function () {
    it("should return paginated leaderboard", async function () {
      const now = await time.latest();
      await tournament.createTournament("Test", now + 1, now + 7200, 0, 500, false);
      await time.increase(2);

      await tournament.connect(user1).enterTournament(1, 1);
      await tournament.connect(user2).enterTournament(1, 2);

      await tournament.connect(user1).lockScore(1, 1);
      await tournament.connect(user2).lockScore(1, 2);

      const [tokenIds, scores] = await tournament.getLeaderboard(1, 0, 10);
      expect(tokenIds.length).to.equal(2);
      expect(scores[0]).to.equal(500);
      expect(scores[1]).to.equal(500);
    });
  });

  // ─── Tournament Chips (Owner) ───
  describe("Tournament Chip Management", function () {
    beforeEach(async function () {
      const now = await time.latest();
      await tournament.createTournament("Test", now + 1, now + 7200, 0, 500, false);
      await time.increase(2);
      await tournament.connect(user1).enterTournament(1, 1);
    });

    it("should award tournament chips", async function () {
      await tournament.awardTournamentChips(1, 1, 200);
      const entry = await tournament.getEntry(1, 1);
      expect(entry.tournamentChips).to.equal(700);
    });

    it("should spend tournament chips", async function () {
      await tournament.spendTournamentChips(1, 1, 100);
      const entry = await tournament.getEntry(1, 1);
      expect(entry.tournamentChips).to.equal(400);
    });

    it("should bust player when chips hit zero", async function () {
      await tournament.spendTournamentChips(1, 1, 500);
      const entry = await tournament.getEntry(1, 1);
      expect(entry.busted).to.be.true;
    });
  });

  // ─── Prize Distribution ───
  describe("Prize Distribution", function () {
    it("should distribute prize to winners", async function () {
      const prize = ethers.parseEther("1");
      await owner.sendTransaction({
        to: await tournament.getAddress(),
        value: prize
      });

      const balBefore = await ethers.provider.getBalance(user1.address);
      await tournament.distributePrize([user1.address], [prize]);
      const balAfter = await ethers.provider.getBalance(user1.address);
      expect(balAfter - balBefore).to.equal(prize);
    });

    it("should accept AVAX deposits", async function () {
      await owner.sendTransaction({
        to: await tournament.getAddress(),
        value: ethers.parseEther("5")
      });
      expect(await ethers.provider.getBalance(await tournament.getAddress()))
        .to.equal(ethers.parseEther("5"));
    });
  });
});
