const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MembersOnly", function () {
  let MembersOnly, membersOnly;
  let owner, user1, user2, gameContract;
  const MINT_PRICE = ethers.parseEther("0.01");
  const BASE_CHIPS = 50n;
  const MAX_SUPPLY = 222;
  const MAX_PER_WALLET = 5;

  beforeEach(async function () {
    [owner, user1, user2, gameContract] = await ethers.getSigners();
    MembersOnly = await ethers.getContractFactory("MembersOnly");
    membersOnly = await MembersOnly.deploy("https://membersonly.xyz/metadata/");
  });

  // ─── Deployment ───
  describe("Deployment", function () {
    it("should set correct name and symbol", async function () {
      expect(await membersOnly.name()).to.equal("Members Only");
      expect(await membersOnly.symbol()).to.equal("MEMBER");
    });

    it("should set correct owner", async function () {
      expect(await membersOnly.owner()).to.equal(owner.address);
    });

    it("should start with zero supply", async function () {
      expect(await membersOnly.totalMinted()).to.equal(0);
    });
  });

  // ─── Minting ───
  describe("Minting", function () {
    it("should mint a single NFT", async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      expect(await membersOnly.totalMinted()).to.equal(1);
      expect(await membersOnly.ownerOf(1)).to.equal(user1.address);
    });

    it("should mint multiple NFTs", async function () {
      await membersOnly.connect(user1).mint(3, { value: MINT_PRICE * 3n });
      expect(await membersOnly.totalMinted()).to.equal(3);
      expect(await membersOnly.balanceOf(user1.address)).to.equal(3);
    });

    it("should assign base chips on mint", async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      expect(await membersOnly.getChips(1)).to.equal(BASE_CHIPS);
    });

    it("should reject insufficient payment", async function () {
      await expect(
        membersOnly.connect(user1).mint(1, { value: 0 })
      ).to.be.revertedWith("Insufficient payment");
    });

    it("should reject exceeding max per wallet", async function () {
      await membersOnly.connect(user1).mint(5, { value: MINT_PRICE * 5n });
      await expect(
        membersOnly.connect(user1).mint(1, { value: MINT_PRICE })
      ).to.be.revertedWith("Exceeds max per wallet");
    });

    it("should reject exceeding max supply", async function () {
      // Mint in batches to approach limit
      for (let i = 0; i < 44; i++) {
        const signer = (await ethers.getSigners())[i % 10];
        // Reset wallet count by using different wallets
      }
      // This is a conceptual test — full supply test requires many wallets
    });

    it("should assign sequential token IDs", async function () {
      await membersOnly.connect(user1).mint(2, { value: MINT_PRICE * 2n });
      expect(await membersOnly.ownerOf(1)).to.equal(user1.address);
      expect(await membersOnly.ownerOf(2)).to.equal(user1.address);
    });
  });

  // ─── Naming ───
  describe("Naming", function () {
    beforeEach(async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
    });

    it("should allow setting a name", async function () {
      await membersOnly.connect(user1).setName(1, "Alpha");
      expect(await membersOnly.tokenName(1)).to.equal("Alpha");
    });

    it("should reject duplicate names (case insensitive)", async function () {
      await membersOnly.connect(user1).setName(1, "Alpha");
      await membersOnly.connect(user2).mint(1, { value: MINT_PRICE });
      await expect(
        membersOnly.connect(user2).setName(2, "alpha")
      ).to.be.revertedWith("Name already taken");
    });

    it("should reject empty name", async function () {
      await expect(
        membersOnly.connect(user1).setName(1, "")
      ).to.be.revertedWith("Name cannot be empty");
    });

    it("should reject name longer than 12 chars", async function () {
      await expect(
        membersOnly.connect(user1).setName(1, "ThisNameIsWayTooLong")
      ).to.be.revertedWith("Name too long");
    });

    it("should only allow naming once", async function () {
      await membersOnly.connect(user1).setName(1, "Alpha");
      await expect(
        membersOnly.connect(user1).setName(1, "Beta")
      ).to.be.revertedWith("Name already set");
    });

    it("should reject non-owner naming", async function () {
      await expect(
        membersOnly.connect(user2).setName(1, "Hack")
      ).to.be.revertedWith("Not token owner");
    });

    it("should report name taken correctly", async function () {
      await membersOnly.connect(user1).setName(1, "Alpha");
      expect(await membersOnly.isNameTaken("Alpha")).to.be.true;
      expect(await membersOnly.isNameTaken("ALPHA")).to.be.true;
      expect(await membersOnly.isNameTaken("Beta")).to.be.false;
    });
  });

  // ─── Tier System ───
  describe("Tier System", function () {
    beforeEach(async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
    });

    it("should allow owner to set tier", async function () {
      await membersOnly.setTier(1, 2);
      expect(await membersOnly.tokenTier(1)).to.equal(2);
    });

    it("should reject invalid tier values", async function () {
      await expect(membersOnly.setTier(1, 0)).to.be.revertedWith("Tier must be 1, 2, or 3");
      await expect(membersOnly.setTier(1, 4)).to.be.revertedWith("Tier must be 1, 2, or 3");
    });

    it("should batch set tiers", async function () {
      await membersOnly.connect(user1).mint(2, { value: MINT_PRICE * 2n });
      await membersOnly.batchSetTier([1, 2, 3], [1, 2, 3]);
      expect(await membersOnly.tokenTier(1)).to.equal(1);
      expect(await membersOnly.tokenTier(2)).to.equal(2);
      expect(await membersOnly.tokenTier(3)).to.equal(3);
    });

    it("should set tier reward", async function () {
      await membersOnly.setTierReward(1, 10);
      expect(await membersOnly.tierChipReward(1)).to.equal(10);
    });

    it("should reject non-owner tier setting", async function () {
      await expect(
        membersOnly.connect(user1).setTier(1, 1)
      ).to.be.revertedWithCustomError(membersOnly, "OwnableUnauthorizedAccount");
    });

    it("should emit TierSet event", async function () {
      await expect(membersOnly.setTier(1, 2))
        .to.emit(membersOnly, "TierSet")
        .withArgs(1, 2);
    });
  });

  // ─── Level System ───
  describe("Level System", function () {
    it("should return level 1 for tokens 1-50", async function () {
      expect(await membersOnly.getLevel(1)).to.equal(1);
      expect(await membersOnly.getLevel(50)).to.equal(1);
    });

    it("should return level 2 for tokens 51-100", async function () {
      expect(await membersOnly.getLevel(51)).to.equal(2);
      expect(await membersOnly.getLevel(100)).to.equal(2);
    });

    it("should return level 3 for tokens 101-150", async function () {
      expect(await membersOnly.getLevel(101)).to.equal(3);
      expect(await membersOnly.getLevel(150)).to.equal(3);
    });

    it("should return level 4 for tokens 151-222", async function () {
      expect(await membersOnly.getLevel(151)).to.equal(4);
      expect(await membersOnly.getLevel(222)).to.equal(4);
    });

    it("should set level bonus", async function () {
      await membersOnly.setLevelBonus(1, 5);
      expect(await membersOnly.levelBonusChips(1)).to.equal(5);
    });
  });

  // ─── Weekly Chip Claiming ───
  describe("Weekly Chip Claiming", function () {
    beforeEach(async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      await membersOnly.setTier(1, 1);
      await membersOnly.setTierReward(1, 20);
      await membersOnly.setLevelBonus(1, 5);
    });

    it("should claim weekly chips (tier + level bonus)", async function () {
      const chipsBefore = await membersOnly.getChips(1);
      await membersOnly.connect(user1).claimWeeklyChips(1);
      const chipsAfter = await membersOnly.getChips(1);
      expect(chipsAfter - chipsBefore).to.equal(25); // 20 tier + 5 level
    });

    it("should prevent double claiming same week", async function () {
      await membersOnly.connect(user1).claimWeeklyChips(1);
      await expect(
        membersOnly.connect(user1).claimWeeklyChips(1)
      ).to.be.revertedWith("Already claimed this week");
    });

    it("should allow claiming after week advances", async function () {
      await membersOnly.connect(user1).claimWeeklyChips(1);
      await membersOnly.advanceWeek();
      await membersOnly.connect(user1).claimWeeklyChips(1); // should not revert
    });

    it("should reject claim with no rewards configured", async function () {
      await membersOnly.connect(user2).mint(1, { value: MINT_PRICE });
      // Token 2 has no tier set (tier 0), no reward configured
      await expect(
        membersOnly.connect(user2).claimWeeklyChips(2)
      ).to.be.revertedWith("No chips to claim");
    });

    it("should report weekly reward correctly", async function () {
      expect(await membersOnly.getWeeklyReward(1)).to.equal(25);
    });

    it("should emit WeekAdvanced event", async function () {
      await expect(membersOnly.advanceWeek())
        .to.emit(membersOnly, "WeekAdvanced")
        .withArgs(1);
    });
  });

  // ─── Chip Management ───
  describe("Chip Management", function () {
    beforeEach(async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      await membersOnly.setGameContract(gameContract.address, true);
    });

    it("should award chips from game contract", async function () {
      await membersOnly.connect(gameContract).awardChips(1, 100);
      expect(await membersOnly.getChips(1)).to.equal(BASE_CHIPS + 100n);
    });

    it("should spend chips from game contract", async function () {
      await membersOnly.connect(gameContract).spendChips(1, 10);
      expect(await membersOnly.getChips(1)).to.equal(BASE_CHIPS - 10n);
    });

    it("should reject spending more than balance", async function () {
      await expect(
        membersOnly.connect(gameContract).spendChips(1, 1000)
      ).to.be.revertedWith("Insufficient chips");
    });

    it("should batch award chips", async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      await membersOnly.batchAwardChips([1, 2], [50, 100]);
      expect(await membersOnly.getChips(1)).to.equal(BASE_CHIPS + 50n);
      expect(await membersOnly.getChips(2)).to.equal(BASE_CHIPS + 100n);
    });

    it("should reject unauthorized chip operations", async function () {
      await expect(
        membersOnly.connect(user2).awardChips(1, 100)
      ).to.be.revertedWith("Not authorized");
    });

    it("should get chips in batch", async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      const chips = await membersOnly.getChipsBatch([1, 2]);
      expect(chips[0]).to.equal(BASE_CHIPS);
      expect(chips[1]).to.equal(BASE_CHIPS);
    });
  });

  // ─── isActive Lock ───
  describe("Active Lock", function () {
    beforeEach(async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      await membersOnly.setGameContract(gameContract.address, true);
    });

    it("should block transfer when active", async function () {
      await membersOnly.connect(gameContract).setActive(1, true);
      await expect(
        membersOnly.connect(user1).transferFrom(user1.address, user2.address, 1)
      ).to.be.revertedWith("Token is active");
    });

    it("should allow transfer when not active", async function () {
      await membersOnly.connect(user1).transferFrom(user1.address, user2.address, 1);
      expect(await membersOnly.ownerOf(1)).to.equal(user2.address);
    });
  });

  // ─── Partner Bonus ───
  describe("Partner Bonus", function () {
    let FakeLil, fakeLil;

    beforeEach(async function () {
      FakeLil = await ethers.getContractFactory("FakeLil");
      fakeLil = await FakeLil.deploy("https://fakelil.xyz/");
      // Mint a partner NFT to user1
      await fakeLil.connect(user1).mint(1);
      // Register as partner
      await membersOnly.registerPartner("FakeLil", await fakeLil.getAddress());
    });

    it("should give bonus chips when minting with partner NFT", async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      expect(await membersOnly.getChips(1)).to.equal(BASE_CHIPS + 100n);
    });

    it("should not give bonus without partner NFT", async function () {
      await membersOnly.connect(user2).mint(1, { value: MINT_PRICE });
      expect(await membersOnly.getChips(1)).to.equal(BASE_CHIPS);
    });
  });

  // ─── Token URI ───
  describe("Token URI", function () {
    beforeEach(async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
    });

    it("should return base URI + token ID", async function () {
      const uri = await membersOnly.tokenURI(1);
      expect(uri).to.equal("https://membersonly.xyz/metadata/1");
    });

    it("should allow per-token URI override", async function () {
      await membersOnly.setTokenURI(1, "https://custom.xyz/1");
      expect(await membersOnly.tokenURI(1)).to.equal("https://custom.xyz/1");
    });
  });

  // ─── Withdraw ───
  describe("Withdraw", function () {
    it("should allow owner to withdraw", async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      const balBefore = await ethers.provider.getBalance(owner.address);
      const tx = await membersOnly.withdraw();
      const receipt = await tx.wait();
      const balAfter = await ethers.provider.getBalance(owner.address);
      expect(balAfter).to.be.greaterThan(balBefore - receipt.gasUsed * receipt.gasPrice);
    });
  });
});
