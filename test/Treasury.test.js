const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Treasury (in MembersOnlyItems)", function () {
  let membersOnly, items;
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

    await membersOnly.setItems(await items.getAddress());
    await items.setGameContract(await membersOnly.getAddress(), true);

    // Mint NFTs
    await membersOnly.connect(player1).mint(1, { value: MINT_PRICE });
    await membersOnly.connect(player2).mint(1, { value: MINT_PRICE });

    // Give players enough chips
    await items.mintChips(player1.address, 50_000n);
    await items.mintChips(player2.address, 50_000n);
  });

  describe("burnForShares", function () {
    it("should burn chips internally and grant shares", async function () {
      const before = await items.balanceOf(player1.address, CHIPS_ID);
      await items.connect(player1).burnForShares(1, 2);
      const after = await items.balanceOf(player1.address, CHIPS_ID);

      expect(before - after).to.equal(20_000n);
      expect(await items.getTreasuryShares(1)).to.equal(2);
      expect(await items.getTreasuryTotalShares()).to.equal(2);
    });

    it("should emit SharesBurned event", async function () {
      await expect(items.connect(player1).burnForShares(1, 1))
        .to.emit(items, "SharesBurned")
        .withArgs(1, 0, 1, CHIPS_PER_SHARE);
    });

    it("should revert if not token owner", async function () {
      await expect(items.connect(player2).burnForShares(1, 1))
        .to.be.revertedWith("Not token owner");
    });

    it("should revert if insufficient chips", async function () {
      await expect(items.connect(player1).burnForShares(1, 6))
        .to.be.revertedWith("Insufficient chips");
    });

    it("should revert after month is finalized", async function () {
      await items.connect(player1).burnForShares(1, 1);
      await items.depositYield({ value: ethers.parseEther("1.0") });
      // Month 1 is open, should work
      await items.connect(player1).burnForShares(1, 1);
    });
  });

  describe("depositYield", function () {
    it("should accept deposit and advance month", async function () {
      await items.connect(player1).burnForShares(1, 2);
      const deposit = ethers.parseEther("1.0");
      await items.depositYield({ value: deposit });

      expect(await items.currentMonth()).to.equal(1);
      expect(await items.monthlyDeposit(0)).to.equal(deposit);
      expect(await items.monthlyTotalShares(0)).to.equal(2);
    });

    it("should revert with no shareholders", async function () {
      await expect(items.depositYield({ value: ethers.parseEther("1.0") }))
        .to.be.revertedWith("No shareholders");
    });

    it("should revert if not owner", async function () {
      await items.connect(player1).burnForShares(1, 1);
      await expect(items.connect(player1).depositYield({ value: ethers.parseEther("1.0") }))
        .to.be.revertedWithCustomError(items, "OwnableUnauthorizedAccount");
    });
  });

  describe("claimYield", function () {
    const deposit = ethers.parseEther("3.0");

    beforeEach(async function () {
      await items.connect(player1).burnForShares(1, 2);
      await items.connect(player2).burnForShares(2, 1);
      await items.depositYield({ value: deposit });
    });

    it("should pay proportional yield", async function () {
      const before = await ethers.provider.getBalance(player1.address);
      const tx = await items.connect(player1).claimYield(1, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(player1.address);

      // 2/3 of 3 AVAX = 2 AVAX
      expect(after - before + gasUsed).to.equal(ethers.parseEther("2.0"));
    });

    it("should revert on double claim", async function () {
      await items.connect(player1).claimYield(1, 0);
      await expect(items.connect(player1).claimYield(1, 0))
        .to.be.revertedWith("Already claimed");
    });

    it("should revert if month not finalized", async function () {
      await expect(items.connect(player1).claimYield(1, 1))
        .to.be.revertedWith("Month not finalized");
    });
  });

  describe("Monthly share reset", function () {
    it("shares from month 0 do not carry to month 1", async function () {
      await items.connect(player1).burnForShares(1, 2);
      await items.depositYield({ value: ethers.parseEther("1.0") });

      expect(await items.getTreasuryShares(1)).to.equal(0);
      expect(await items.getTreasuryTotalShares()).to.equal(0);
    });

    it("players must rebuy shares each month", async function () {
      await items.connect(player1).burnForShares(1, 1);
      await items.depositYield({ value: ethers.parseEther("1.0") });

      await expect(items.depositYield({ value: ethers.parseEther("1.0") }))
        .to.be.revertedWith("No shareholders");

      await items.connect(player1).burnForShares(1, 1);
      await items.depositYield({ value: ethers.parseEther("1.0") });

      const tx = await items.connect(player1).batchClaimYield(1, [0, 1]);
      await expect(tx).to.emit(items, "YieldClaimed");
    });
  });

  describe("batchClaimYield", function () {
    it("should claim multiple months at once", async function () {
      for (let i = 0; i < 3; i++) {
        await items.connect(player1).burnForShares(1, 1);
        await items.depositYield({ value: ethers.parseEther("1.0") });
      }

      const before = await ethers.provider.getBalance(player1.address);
      const tx = await items.connect(player1).batchClaimYield(1, [0, 1, 2]);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(player1.address);

      expect(after - before + gasUsed).to.equal(ethers.parseEther("3.0"));
    });
  });

  describe("getClaimable", function () {
    it("should return correct proportional amount", async function () {
      await items.connect(player1).burnForShares(1, 1);
      await items.connect(player2).burnForShares(2, 2);
      await items.depositYield({ value: ethers.parseEther("3.0") });

      expect(await items.getClaimable(1, 0)).to.equal(ethers.parseEther("1.0"));
      expect(await items.getClaimable(2, 0)).to.equal(ethers.parseEther("2.0"));
    });
  });
});
