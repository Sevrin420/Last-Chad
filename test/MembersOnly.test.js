const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MembersOnly", function () {
  let membersOnly, items;
  let owner, user1, user2, gameContract;
  const MINT_PRICE = ethers.parseEther("0.01");
  const BASE_CHIPS = 50n;
  const CHIPS_ID = 0n;

  beforeEach(async function () {
    [owner, user1, user2, gameContract] = await ethers.getSigners();

    const MembersOnly = await ethers.getContractFactory("MembersOnly");
    membersOnly = await MembersOnly.deploy("https://membersonly.xyz/metadata/");

    const Items = await ethers.getContractFactory("MembersOnlyItems");
    items = await Items.deploy("https://membersonly.xyz/items/", await membersOnly.getAddress());

    // Wire: MembersOnly needs Items reference, Items must authorize MembersOnly
    await membersOnly.setItems(await items.getAddress());
    await items.setGameContract(await membersOnly.getAddress(), true);
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

    it("should assign base chips as ERC-1155 tokens on mint", async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      expect(await items.balanceOf(user1.address, CHIPS_ID)).to.equal(BASE_CHIPS);
    });

    it("should assign chips for multiple mints in one call", async function () {
      await membersOnly.connect(user1).mint(3, { value: MINT_PRICE * 3n });
      expect(await items.balanceOf(user1.address, CHIPS_ID)).to.equal(BASE_CHIPS * 3n);
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
  });

  // ─── Level System ───
  describe("Level System", function () {
    it("should return correct levels by token ID range", async function () {
      expect(await membersOnly.getLevel(1)).to.equal(1);
      expect(await membersOnly.getLevel(83)).to.equal(1);
      expect(await membersOnly.getLevel(84)).to.equal(2);
      expect(await membersOnly.getLevel(166)).to.equal(2);
      expect(await membersOnly.getLevel(167)).to.equal(3);
      expect(await membersOnly.getLevel(249)).to.equal(3);
      expect(await membersOnly.getLevel(250)).to.equal(4);
      expect(await membersOnly.getLevel(333)).to.equal(4);
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

    const WEEK = 7 * 24 * 60 * 60;
    async function passWeeks(n) {
      await ethers.provider.send("evm_increaseTime", [WEEK * n]);
      await ethers.provider.send("evm_mine", []);
    }

    it("has nothing to claim in the mint week", async function () {
      expect(await membersOnly.claimableWeeks(1)).to.equal(0);
      await expect(
        membersOnly.connect(user1).claimWeeklyChips(1)
      ).to.be.revertedWith("Nothing to claim yet");
    });

    it("should claim one week of chips after a week passes", async function () {
      await passWeeks(1);
      const before = await items.balanceOf(user1.address, CHIPS_ID);
      await membersOnly.connect(user1).claimWeeklyChips(1);
      const after = await items.balanceOf(user1.address, CHIPS_ID);
      expect(after - before).to.equal(25n); // 20 tier + 5 level
    });

    it("stacks unclaimed weeks into a single claim", async function () {
      await passWeeks(3);
      expect(await membersOnly.claimableWeeks(1)).to.equal(3);
      expect(await membersOnly.claimableChips(1)).to.equal(75n); // 25 * 3
      const before = await items.balanceOf(user1.address, CHIPS_ID);
      await membersOnly.connect(user1).claimWeeklyChips(1);
      expect((await items.balanceOf(user1.address, CHIPS_ID)) - before).to.equal(75n);
    });

    it("cannot double-claim within the same week", async function () {
      await passWeeks(1);
      await membersOnly.connect(user1).claimWeeklyChips(1);
      await expect(
        membersOnly.connect(user1).claimWeeklyChips(1)
      ).to.be.revertedWith("Nothing to claim yet");
    });

    it("should report weekly reward correctly", async function () {
      expect(await membersOnly.getWeeklyReward(1)).to.equal(25);
    });
  });

  // ─── Chips are tradeable ERC-1155 ───
  describe("Chip Trading", function () {
    it("should allow transferring chips between wallets", async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      // user1 has BASE_CHIPS
      await items.connect(user1).safeTransferFrom(user1.address, user2.address, CHIPS_ID, 20n, "0x");
      expect(await items.balanceOf(user1.address, CHIPS_ID)).to.equal(BASE_CHIPS - 20n);
      expect(await items.balanceOf(user2.address, CHIPS_ID)).to.equal(20n);
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
    let fakeLil;

    beforeEach(async function () {
      const FakeLil = await ethers.getContractFactory("FakeLil");
      fakeLil = await FakeLil.deploy("https://fakelil.xyz/");
      await fakeLil.connect(user1).mint(1);
      await membersOnly.registerPartner("FakeLil", await fakeLil.getAddress());
    });

    it("should give bonus chips when minting with partner NFT", async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
      expect(await items.balanceOf(user1.address, CHIPS_ID)).to.equal(BASE_CHIPS + 100n);
    });

    it("should not give bonus without partner NFT", async function () {
      await membersOnly.connect(user2).mint(1, { value: MINT_PRICE });
      expect(await items.balanceOf(user2.address, CHIPS_ID)).to.equal(BASE_CHIPS);
    });
  });

  // ─── Token URI ───
  describe("Token URI", function () {
    beforeEach(async function () {
      await membersOnly.connect(user1).mint(1, { value: MINT_PRICE });
    });

    it("should return base URI + token ID", async function () {
      expect(await membersOnly.tokenURI(1)).to.equal("https://membersonly.xyz/metadata/1");
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
