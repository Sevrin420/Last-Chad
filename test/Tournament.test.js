const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRICE = ethers.parseEther("2");
const BASE_URI = "https://lastchad.xyz/metadata/";

describe("Tournament", function () {
  let lastChad, tournament, owner, addr1, addr2, addr3;

  beforeEach(async function () {
    [owner, addr1, addr2, addr3] = await ethers.getSigners();

    // Deploy LastChad
    const LC = await ethers.getContractFactory("LastChad");
    lastChad = await LC.deploy(BASE_URI);

    // Deploy Tournament
    const T = await ethers.getContractFactory("Tournament");
    tournament = await T.deploy(await lastChad.getAddress());

    // Authorize Tournament as a game contract on LastChad
    await lastChad.setGameContract(await tournament.getAddress(), true);

    // Mint a chad for addr1 and addr2
    await lastChad.connect(addr1).mint(1, { value: PRICE });
    await lastChad.connect(addr2).mint(1, { value: PRICE });

    // Award extra cells so they have enough to lock (1111 needed)
    await lastChad.awardCells(1, 2000);
    await lastChad.awardCells(2, 2000);
  });

  // ──────────────────────────────────────────────────────────
  // Deployment
  // ──────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets lastChad address correctly", async function () {
      expect(await tournament.lastChad()).to.equal(await lastChad.getAddress());
    });

    it("sets gameOwner correctly", async function () {
      expect(await tournament.gameOwner()).to.equal(owner.address);
    });

    it("starts at month 0", async function () {
      expect(await tournament.currentMonth()).to.equal(0);
    });

    it("LOCK_AMOUNT is 1111", async function () {
      expect(await tournament.LOCK_AMOUNT()).to.equal(1111);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Endgame Snapshot
  // ──────────────────────────────────────────────────────────
  describe("Endgame Snapshot", function () {
    it("owner can set snapshots", async function () {
      await tournament.snapshotEndgame([1, 2], [500, 1000]);
      expect(await tournament.endgameSnapshot(1)).to.equal(500);
      expect(await tournament.endgameSnapshot(2)).to.equal(1000);
    });

    it("reverts for non-owner", async function () {
      await expect(
        tournament.connect(addr1).snapshotEndgame([1], [500])
      ).to.be.revertedWithCustomError(tournament, "OwnableUnauthorizedAccount");
    });

    it("reverts on array length mismatch", async function () {
      await expect(
        tournament.snapshotEndgame([1, 2], [500])
      ).to.be.revertedWith("Array length mismatch");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Cell Tiers
  // ──────────────────────────────────────────────────────────
  describe("Cell Tiers", function () {
    it("owner can set a single tier", async function () {
      await tournament.setCellTier(500, 30);
      expect(await tournament.getTierCount()).to.equal(1);
      const [threshold, amount] = await tournament.getTierThreshold(0);
      expect(threshold).to.equal(500);
      expect(amount).to.equal(30);
    });

    it("owner can batch set tiers", async function () {
      await tournament.batchSetCellTiers([200, 500, 1000], [20, 30, 50]);
      expect(await tournament.getTierCount()).to.equal(3);
    });

    it("tiers are sorted ascending", async function () {
      await tournament.batchSetCellTiers([1000, 200, 500], [50, 20, 30]);
      const [t0] = await tournament.getTierThreshold(0);
      const [t1] = await tournament.getTierThreshold(1);
      const [t2] = await tournament.getTierThreshold(2);
      expect(t0).to.equal(200);
      expect(t1).to.equal(500);
      expect(t2).to.equal(1000);
    });

    it("reverts for non-owner", async function () {
      await expect(
        tournament.connect(addr1).setCellTier(500, 30)
      ).to.be.revertedWithCustomError(tournament, "OwnableUnauthorizedAccount");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Claim Cells
  // ──────────────────────────────────────────────────────────
  describe("Claim Cells", function () {
    beforeEach(async function () {
      // Set up snapshot and tiers
      await tournament.snapshotEndgame([1, 2], [500, 1000]);
      await tournament.batchSetCellTiers([200, 500, 1000], [20, 30, 50]);
    });

    it("player can claim cells based on tier", async function () {
      const cellsBefore = await lastChad.getOpenCells(1);
      await tournament.connect(addr1).claimCells(1);
      const cellsAfter = await lastChad.getOpenCells(1);
      expect(cellsAfter - cellsBefore).to.equal(30); // 500 closed → tier 500 → 30 cells
    });

    it("higher snapshot gets higher tier", async function () {
      const cellsBefore = await lastChad.getOpenCells(2);
      await tournament.connect(addr2).claimCells(2);
      const cellsAfter = await lastChad.getOpenCells(2);
      expect(cellsAfter - cellsBefore).to.equal(50); // 1000 closed → tier 1000 → 50 cells
    });

    it("emits CellsClaimed event", async function () {
      await expect(tournament.connect(addr1).claimCells(1))
        .to.emit(tournament, "CellsClaimed")
        .withArgs(1, 0, 30);
    });

    it("cannot claim twice in same month", async function () {
      await tournament.connect(addr1).claimCells(1);
      await expect(
        tournament.connect(addr1).claimCells(1)
      ).to.be.revertedWith("Already claimed this month");
    });

    it("cannot claim for someone else's chad", async function () {
      await expect(
        tournament.connect(addr2).claimCells(1)
      ).to.be.revertedWith("Not token owner");
    });

    it("cannot claim with no snapshot", async function () {
      // Mint a new chad with no snapshot
      await lastChad.connect(addr3).mint(1, { value: PRICE });
      await expect(
        tournament.connect(addr3).claimCells(3)
      ).to.be.revertedWith("No cells to claim");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Lock for Tournament
  // ──────────────────────────────────────────────────────────
  describe("Lock for Tournament", function () {
    it("player can lock 1111 cells", async function () {
      const cellsBefore = await lastChad.getOpenCells(1);
      await tournament.connect(addr1).lockForTournament(1);
      const cellsAfter = await lastChad.getOpenCells(1);
      expect(cellsBefore - cellsAfter).to.equal(1111);
    });

    it("increments lock count", async function () {
      await tournament.connect(addr1).lockForTournament(1);
      expect(await tournament.getLockCount(0)).to.equal(1);
    });

    it("adds to lockedChads array", async function () {
      await tournament.connect(addr1).lockForTournament(1);
      const locked = await tournament.getLockedChads(0);
      expect(locked.length).to.equal(1);
      expect(locked[0]).to.equal(1);
    });

    it("emits LockedForTournament event", async function () {
      await expect(tournament.connect(addr1).lockForTournament(1))
        .to.emit(tournament, "LockedForTournament")
        .withArgs(1, 0);
    });

    it("cannot lock twice in same month", async function () {
      await tournament.connect(addr1).lockForTournament(1);
      await expect(
        tournament.connect(addr1).lockForTournament(1)
      ).to.be.revertedWith("Already locked this month");
    });

    it("cannot lock someone else's chad", async function () {
      await expect(
        tournament.connect(addr2).lockForTournament(1)
      ).to.be.revertedWith("Not token owner");
    });

    it("reverts if insufficient cells", async function () {
      // Spend most cells first
      await lastChad.spendCells(1, 1500);
      await expect(
        tournament.connect(addr1).lockForTournament(1)
      ).to.be.revertedWith("Insufficient cells");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Distribute and Reset
  // ──────────────────────────────────────────────────────────
  describe("Distribute and Reset", function () {
    it("distributes AVAX equally to winners", async function () {
      await tournament.connect(addr1).lockForTournament(1);
      await tournament.connect(addr2).lockForTournament(2);

      // Send 10 AVAX to tournament as prize pool
      const prize = ethers.parseEther("10");
      await owner.sendTransaction({
        to: await tournament.getAddress(),
        value: prize
      });

      const balBefore1 = await ethers.provider.getBalance(addr1.address);
      const balBefore2 = await ethers.provider.getBalance(addr2.address);

      await tournament.distributeAndReset();

      const balAfter1 = await ethers.provider.getBalance(addr1.address);
      const balAfter2 = await ethers.provider.getBalance(addr2.address);

      expect(balAfter1 - balBefore1).to.equal(ethers.parseEther("5"));
      expect(balAfter2 - balBefore2).to.equal(ethers.parseEther("5"));
    });

    it("advances month after distribution", async function () {
      await tournament.distributeAndReset();
      expect(await tournament.currentMonth()).to.equal(1);
    });

    it("emits MonthAdvanced event", async function () {
      await expect(tournament.distributeAndReset())
        .to.emit(tournament, "MonthAdvanced")
        .withArgs(1);
    });

    it("players can lock again in new month", async function () {
      await tournament.connect(addr1).lockForTournament(1);
      await tournament.distributeAndReset();
      // Refill cells for next month
      await lastChad.awardCells(1, 2000);
      await tournament.connect(addr1).lockForTournament(1);
      expect(await tournament.getLockCount(1)).to.equal(1);
    });

    it("reverts for non-owner", async function () {
      await expect(
        tournament.connect(addr1).distributeAndReset()
      ).to.be.revertedWithCustomError(tournament, "OwnableUnauthorizedAccount");
    });
  });

  // ──────────────────────────────────────────────────────────
  // View Functions
  // ──────────────────────────────────────────────────────────
  describe("View Functions", function () {
    it("hasClaimed returns correct value", async function () {
      await tournament.snapshotEndgame([1], [500]);
      await tournament.setCellTier(500, 30);
      expect(await tournament.hasClaimed(1, 0)).to.equal(false);
      await tournament.connect(addr1).claimCells(1);
      expect(await tournament.hasClaimed(1, 0)).to.equal(true);
    });

    it("hasLocked returns correct value", async function () {
      expect(await tournament.hasLocked(1, 0)).to.equal(false);
      await tournament.connect(addr1).lockForTournament(1);
      expect(await tournament.hasLocked(1, 0)).to.equal(true);
    });

    it("getClaimAmount returns correct tier amount", async function () {
      await tournament.snapshotEndgame([1], [750]);
      await tournament.batchSetCellTiers([200, 500, 1000], [20, 30, 50]);
      // 750 >= 500 but < 1000, so tier 500 → 30
      expect(await tournament.getClaimAmount(1)).to.equal(30);
    });

    it("getClaimAmount returns 0 for no snapshot", async function () {
      expect(await tournament.getClaimAmount(1)).to.equal(0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Eliminated Chads
  // ──────────────────────────────────────────────────────────
  describe("Eliminated Chads", function () {
    it("eliminated chad cannot claim cells", async function () {
      await tournament.snapshotEndgame([1], [500]);
      await tournament.setCellTier(500, 30);
      await lastChad.eliminate(1);
      await expect(
        tournament.connect(addr1).claimCells(1)
      ).to.be.revertedWith("Chad eliminated");
    });

    it("eliminated chad cannot lock for tournament", async function () {
      await lastChad.eliminate(1);
      await expect(
        tournament.connect(addr1).lockForTournament(1)
      ).to.be.revertedWith("Chad eliminated");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Receive AVAX
  // ──────────────────────────────────────────────────────────
  describe("Receive AVAX", function () {
    it("accepts direct AVAX transfers", async function () {
      await owner.sendTransaction({
        to: await tournament.getAddress(),
        value: ethers.parseEther("5")
      });
      expect(await ethers.provider.getBalance(await tournament.getAddress()))
        .to.equal(ethers.parseEther("5"));
    });
  });
});
