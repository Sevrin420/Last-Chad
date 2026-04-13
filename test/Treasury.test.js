const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Treasury", function () {
  let membersOnly, items, treasury;
  let owner, player1, player2;
  const MINT_PRICE = ethers.parseEther("0.01");
  const CHIPS_PER_SHARE = 10_000n;
  const CHIPS_ID = 0n;

  beforeEach(async function () {
    [owner, player1, player2] = await ethers.getSigners();

    const MembersOnly = await ethers.getContractFactory("MembersOnly");
    membersOnly = await MembersOnly.deploy("https://membersonly.xyz/metadata/");

    const Items = await ethers.getContractFactory("MembersOnlyItems");
    items = await Items.deploy("https://membersonly.xyz/items/", await membersOnly.getAddress());

    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(await membersOnly.getAddress(), await items.getAddress());

    // Wire everything
    await membersOnly.setItems(await items.getAddress());
    await items.setGameContract(await membersOnly.getAddress(), true);
    await items.setGameContract(await treasury.getAddress(), true);

    // Mint NFTs
    await membersOnly.connect(player1).mint(1, { value: MINT_PRICE });
    await membersOnly.connect(player2).mint(1, { value: MINT_PRICE });

    // Give players enough chips
    await items.mintChips(player1.address, 50_000n);
    await items.mintChips(player2.address, 50_000n);
  });

  // ─── Deployment ───
  describe("Deployment", function () {
    it("should start at month 0", async function () {
      expect(await treasury.currentMonth()).to.equal(0);
    });

    it("should have CHIPS_PER_SHARE = 10000", async function () {
      expect(await treasury.CHIPS_PER_SHARE()).to.equal(CHIPS_PER_SHARE);
    });
  });

  // ─── Burn for Shares ───
  describe("burnForShares", function () {
    it("should burn ERC-1155 chips and grant shares for current month", async function () {
      const before = await items.balanceOf(player1.address, CHIPS_ID);
      await treasury.connect(player1).burnForShares(1, 2);
      const after = await items.balanceOf(player1.address, CHIPS_ID);

      expect(before - after).to.equal(20_000n);
      expect(await treasury.getShares(1)).to.equal(2);
      expect(await treasury.getTotalShares()).to.equal(2);
    });

    it("should emit SharesBurned event", async function () {
      await expect(treasury.connect(player1).burnForShares(1, 1))
        .to.emit(treasury, "SharesBurned")
        .withArgs(1, 0, 1, CHIPS_PER_SHARE);
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
      await expect(treasury.connect(player1).burnForShares(1, 6))
        .to.be.revertedWith("Insufficient chips");
    });

    it("should revert after month is finalized", async function () {
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.depositYield({ value: ethers.parseEther("1.0") });
      // Now month 0 is finalized, currentMonth = 1
      // Buying shares for month 1 should work
      await treasury.connect(player1).burnForShares(1, 1);
    });
  });

  // ─── Deposit Yield ───
  describe("depositYield", function () {
    it("should accept deposit and advance month", async function () {
      await treasury.connect(player1).burnForShares(1, 2);
      const deposit = ethers.parseEther("1.0");
      await treasury.depositYield({ value: deposit });

      expect(await treasury.currentMonth()).to.equal(1);
      expect(await treasury.monthlyDeposit(0)).to.equal(deposit);
      expect(await treasury.monthlyTotalShares(0)).to.equal(2);
    });

    it("should revert with no shareholders", async function () {
      await expect(treasury.depositYield({ value: ethers.parseEther("1.0") }))
        .to.be.revertedWith("No shareholders");
    });
  });

  // ─── Claim Yield ───
  describe("claimYield", function () {
    const deposit = ethers.parseEther("3.0");

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

      // player1 has 2/3 of 3 AVAX = 2 AVAX
      expect(after - before + gasUsed).to.equal(ethers.parseEther("2.0"));
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
  });

  // ─── Shares Reset Each Month ───
  describe("Monthly share reset", function () {
    it("shares from month 0 do not carry to month 1", async function () {
      // Month 0: player1 buys 2 shares
      await treasury.connect(player1).burnForShares(1, 2);
      await treasury.depositYield({ value: ethers.parseEther("1.0") });

      // Month 1: player1 has 0 shares (reset)
      expect(await treasury.getShares(1)).to.equal(0);
      expect(await treasury.getTotalShares()).to.equal(0);
    });

    it("players must rebuy shares each month", async function () {
      // Month 0
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.depositYield({ value: ethers.parseEther("1.0") });

      // Month 1: no shares → cannot deposit
      await expect(treasury.depositYield({ value: ethers.parseEther("1.0") }))
        .to.be.revertedWith("No shareholders");

      // Player buys again for month 1
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.depositYield({ value: ethers.parseEther("1.0") });

      // Can claim both months
      const tx = await treasury.connect(player1).batchClaimYield(1, [0, 1]);
      await expect(tx).to.emit(treasury, "YieldClaimed");
    });
  });

  // ─── Batch Claim ───
  describe("batchClaimYield", function () {
    it("should claim multiple months at once", async function () {
      // 3 months of deposits
      for (let i = 0; i < 3; i++) {
        await treasury.connect(player1).burnForShares(1, 1);
        await treasury.depositYield({ value: ethers.parseEther("1.0") });
      }

      const before = await ethers.provider.getBalance(player1.address);
      const tx = await treasury.connect(player1).batchClaimYield(1, [0, 1, 2]);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(player1.address);

      expect(after - before + gasUsed).to.equal(ethers.parseEther("3.0"));
    });
  });

  // ─── View: getClaimable ───
  describe("getClaimable", function () {
    it("should return correct proportional amount", async function () {
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.connect(player2).burnForShares(2, 2);
      await treasury.depositYield({ value: ethers.parseEther("3.0") });

      expect(await treasury.getClaimable(1, 0)).to.equal(ethers.parseEther("1.0"));
      expect(await treasury.getClaimable(2, 0)).to.equal(ethers.parseEther("2.0"));
    });

    it("should return 0 after claiming", async function () {
      await treasury.connect(player1).burnForShares(1, 1);
      await treasury.depositYield({ value: ethers.parseEther("1.0") });
      await treasury.connect(player1).claimYield(1, 0);
      expect(await treasury.getClaimable(1, 0)).to.equal(0);
    });
  });
});
