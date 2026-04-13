const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Treasury", function () {
  let membersOnly, treasury;
  let owner, player1, player2;
  const MINT_PRICE = ethers.parseEther("0.01");
  const CHIPS_PER_SHARE = 10_000n;

  beforeEach(async function () {
    [owner, player1, player2] = await ethers.getSigners();

    const MembersOnly = await ethers.getContractFactory("MembersOnly");
    membersOnly = await MembersOnly.deploy("https://membersonly.xyz/metadata/");

    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(await membersOnly.getAddress());

    // Authorize Treasury as a game contract (so it can call spendChips)
    await membersOnly.setGameContract(await treasury.getAddress(), true);

    // Mint NFTs for players
    await membersOnly.connect(player1).mint(1, { value: MINT_PRICE });
    await membersOnly.connect(player2).mint(1, { value: MINT_PRICE });

    // Give players enough chips to buy shares
    await membersOnly.awardChips(1, 50_000n);
    await membersOnly.awardChips(2, 50_000n);
  });

  // ─── Deployment ───
  describe("Deployment", function () {
    it("should set correct membersOnly address", async function () {
      expect(await treasury.membersOnly()).to.equal(await membersOnly.getAddress());
    });

    it("should start at month 0 with 0 total shares", async function () {
      expect(await treasury.currentMonth()).to.equal(0);
      expect(await treasury.totalShares()).to.equal(0);
    });

    it("should have CHIPS_PER_SHARE = 10000", async function () {
      expect(await treasury.CHIPS_PER_SHARE()).to.equal(CHIPS_PER_SHARE);
    });
  });

  // ─── Burn for Shares ───
  describe("burnForShares", function () {
    it("should burn chips and grant shares", async function () {
      await treasury.connect(player1).burnForShares(1, 2);
      expect(await treasury.shares(1)).to.equal(2);
      expect(await treasury.totalShares()).to.equal(2);
      // 50 base + 50000 awarded - 20000 burned = 30050
      expect(await membersOnly.getChips(1)).to.equal(30_050n);
    });

    it("should emit SharesBurned event", async function () {
      await expect(treasury.connect(player1).burnForShares(1, 1))
        .to.emit(treasury, "SharesBurned")
        .withArgs(1, 1, CHIPS_PER_SHARE);
    });

    it("should revert if not token owner", async function () {
      await expect(treasury.connect(player2).burnForShares(1, 1))
        .to.be.revertedWith("Not token owner");
    });

    it("should revert if zero shares", async function () {
      await expect(treasury.connect(player1).burnForShares(1, 0))
        .to.be.revertedWith("Zero shares");
    });

    it("should revert if insufficient chips", async function () {
      // player1 has 50050 chips, try to buy 6 shares (60000 chips)
      await expect(treasury.connect(player1).burnForShares(1, 6))
        .to.be.revertedWith("Insufficient chips");
    });

    it("should allow multiple burns on same token", async function () {
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.connect(player1).burnForShares(1, 2);
      expect(await treasury.shares(1)).to.equal(3);
      expect(await treasury.totalShares()).to.equal(3);
    });
  });

  // ─── Deposit Yield ───
  describe("depositYield", function () {
    beforeEach(async function () {
      await treasury.connect(player1).burnForShares(1, 2);
    });

    it("should accept AVAX deposit and advance month", async function () {
      const deposit = ethers.parseEther("1.0");
      await treasury.depositYield({ value: deposit });

      expect(await treasury.currentMonth()).to.equal(1);
      expect(await treasury.monthlyDeposit(0)).to.equal(deposit);
      expect(await treasury.monthlyTotalShares(0)).to.equal(2);
    });

    it("should emit YieldDeposited event", async function () {
      const deposit = ethers.parseEther("1.0");
      await expect(treasury.depositYield({ value: deposit }))
        .to.emit(treasury, "YieldDeposited")
        .withArgs(0, deposit, 2);
    });

    it("should revert if not owner", async function () {
      await expect(treasury.connect(player1).depositYield({ value: ethers.parseEther("1.0") }))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });

    it("should revert if no AVAX sent", async function () {
      await expect(treasury.depositYield({ value: 0 }))
        .to.be.revertedWith("No AVAX sent");
    });

    it("should revert if no shareholders", async function () {
      // Deploy fresh treasury with no shares
      const Treasury = await ethers.getContractFactory("Treasury");
      const fresh = await Treasury.deploy(await membersOnly.getAddress());
      await expect(fresh.depositYield({ value: ethers.parseEther("1.0") }))
        .to.be.revertedWith("No shareholders");
    });
  });

  // ─── Claim Yield ───
  describe("claimYield", function () {
    const deposit = ethers.parseEther("1.0");

    beforeEach(async function () {
      // Player1: 2 shares, Player2: 1 share → total 3
      await treasury.connect(player1).burnForShares(1, 2);
      await treasury.connect(player2).burnForShares(2, 1);
      await treasury.depositYield({ value: deposit });
    });

    it("should pay proportional yield", async function () {
      const before = await ethers.provider.getBalance(player1.address);
      const tx = await treasury.connect(player1).claimYield(1, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(player1.address);

      // player1 has 2/3 of 1 AVAX
      const expected = (deposit * 2n) / 3n;
      expect(after - before + gasUsed).to.equal(expected);
    });

    it("should emit YieldClaimed event", async function () {
      const expected = (deposit * 2n) / 3n;
      await expect(treasury.connect(player1).claimYield(1, 0))
        .to.emit(treasury, "YieldClaimed")
        .withArgs(1, 0, expected);
    });

    it("should mark as claimed", async function () {
      await treasury.connect(player1).claimYield(1, 0);
      expect(await treasury.claimed(1, 0)).to.be.true;
    });

    it("should revert on double claim", async function () {
      await treasury.connect(player1).claimYield(1, 0);
      await expect(treasury.connect(player1).claimYield(1, 0))
        .to.be.revertedWith("Already claimed");
    });

    it("should revert if month not finalized", async function () {
      await expect(treasury.connect(player1).claimYield(1, 1))
        .to.be.revertedWith("Month not finalized");
    });

    it("should revert if not token owner", async function () {
      await expect(treasury.connect(player2).claimYield(1, 0))
        .to.be.revertedWith("Not token owner");
    });

    it("should revert if no shares that month", async function () {
      // Mint a third NFT with no shares
      await membersOnly.connect(owner).mint(1, { value: MINT_PRICE });
      await expect(treasury.connect(owner).claimYield(3, 0))
        .to.be.revertedWith("No shares that month");
    });
  });

  // ─── Batch Claim ───
  describe("batchClaimYield", function () {
    const deposit = ethers.parseEther("1.0");

    beforeEach(async function () {
      await treasury.connect(player1).burnForShares(1, 2);
      // Deposit 3 months
      await treasury.depositYield({ value: deposit });
      await treasury.depositYield({ value: deposit });
      await treasury.depositYield({ value: deposit });
    });

    it("should claim multiple months at once", async function () {
      const before = await ethers.provider.getBalance(player1.address);
      const tx = await treasury.connect(player1).batchClaimYield(1, [0, 1, 2]);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(player1.address);

      // 3 months × 1 AVAX each, player1 has all shares
      expect(after - before + gasUsed).to.equal(deposit * 3n);
    });

    it("should skip already-claimed months", async function () {
      await treasury.connect(player1).claimYield(1, 0);
      // Batch claim all 3 — month 0 skipped
      const before = await ethers.provider.getBalance(player1.address);
      const tx = await treasury.connect(player1).batchClaimYield(1, [0, 1, 2]);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(player1.address);

      expect(after - before + gasUsed).to.equal(deposit * 2n);
    });

    it("should revert if nothing to claim", async function () {
      // Mint a third NFT with no shares
      await membersOnly.connect(owner).mint(1, { value: MINT_PRICE });
      await expect(treasury.connect(owner).batchClaimYield(3, [0, 1, 2]))
        .to.be.revertedWith("Nothing to claim");
    });
  });

  // ─── Checkpoint correctness ───
  describe("Checkpoint accuracy", function () {
    const deposit = ethers.parseEther("1.0");

    it("shares acquired after deposit should NOT claim that month", async function () {
      // Month 0: only player1 has shares
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.depositYield({ value: deposit }); // month 0 finalized

      // Player2 buys shares in month 1
      await treasury.connect(player2).burnForShares(2, 1);

      // Player2 should NOT be able to claim month 0
      await expect(treasury.connect(player2).claimYield(2, 0))
        .to.be.revertedWith("No shares that month");

      // Player1 claims full amount for month 0
      const before = await ethers.provider.getBalance(player1.address);
      const tx = await treasury.connect(player1).claimYield(1, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(player1.address);

      expect(after - before + gasUsed).to.equal(deposit);
    });

    it("adding more shares should not affect past months", async function () {
      // Month 0: player1 has 1 share
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.depositYield({ value: deposit }); // month 0: 1 share total

      // Month 1: player1 adds 2 more shares (now 3 total)
      await treasury.connect(player1).burnForShares(1, 2);
      await treasury.depositYield({ value: deposit }); // month 1: 3 shares total

      // Month 0 claim should use 1 share (not 3)
      const claimable0 = await treasury.getClaimable(1, 0);
      expect(claimable0).to.equal(deposit); // 1/1 of deposit

      // Month 1 claim should use 3 shares (3/3 = all)
      const claimable1 = await treasury.getClaimable(1, 1);
      expect(claimable1).to.equal(deposit); // 3/3 of deposit
    });

    it("getSharesAt returns correct historical values", async function () {
      await treasury.connect(player1).burnForShares(1, 1);
      // Still month 0
      expect(await treasury.getSharesAt(1, 0)).to.equal(1);

      await treasury.depositYield({ value: deposit }); // advance to month 1

      await treasury.connect(player1).burnForShares(1, 2);
      // Now month 1, total shares = 3
      expect(await treasury.getSharesAt(1, 0)).to.equal(1); // historical
      expect(await treasury.getSharesAt(1, 1)).to.equal(3); // current
    });
  });

  // ─── View: getClaimable ───
  describe("getClaimable", function () {
    it("should return 0 for unfinalized month", async function () {
      await treasury.connect(player1).burnForShares(1, 1);
      expect(await treasury.getClaimable(1, 0)).to.equal(0);
    });

    it("should return 0 after claiming", async function () {
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.depositYield({ value: ethers.parseEther("1.0") });
      await treasury.connect(player1).claimYield(1, 0);
      expect(await treasury.getClaimable(1, 0)).to.equal(0);
    });

    it("should return correct proportional amount", async function () {
      const deposit = ethers.parseEther("3.0");
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.connect(player2).burnForShares(2, 2);
      await treasury.depositYield({ value: deposit });

      // player1: 1/3, player2: 2/3
      expect(await treasury.getClaimable(1, 0)).to.equal(ethers.parseEther("1.0"));
      expect(await treasury.getClaimable(2, 0)).to.equal(ethers.parseEther("2.0"));
    });
  });
});
