const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRICE = ethers.parseEther("0.02");
const BASE_URI = "https://lastchad.xyz/metadata/";

describe("LastChad", function () {
  let contract, owner, addr1, addr2, addr3;

  beforeEach(async function () {
    [owner, addr1, addr2, addr3] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("LastChad");
    contract = await Factory.deploy(BASE_URI);
  });

  // ──────────────────────────────────────────────────────────
  // Deployment
  // ──────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets correct name and symbol", async function () {
      expect(await contract.name()).to.equal("Last Chad");
      expect(await contract.symbol()).to.equal("CHAD");
    });

    it("sets owner correctly", async function () {
      expect(await contract.owner()).to.equal(owner.address);
    });

    it("starts with zero supply", async function () {
      expect(await contract.totalSupply()).to.equal(0);
    });

    it("has correct constants", async function () {
      expect(await contract.MAX_SUPPLY()).to.equal(70);
      expect(await contract.MINT_PRICE()).to.equal(PRICE);
      expect(await contract.MAX_MINT_PER_WALLET()).to.equal(5);
      expect(await contract.TOTAL_STAT_POINTS()).to.equal(2);
      expect(await contract.CELLS_PER_LEVEL()).to.equal(100);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Minting
  // ──────────────────────────────────────────────────────────
  describe("Minting", function () {
    it("mints a single token", async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
      expect(await contract.totalSupply()).to.equal(1);
      expect(await contract.ownerOf(1)).to.equal(addr1.address);
      expect(await contract.balanceOf(addr1.address)).to.equal(1);
    });

    it("starts with 5 open cells", async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
      expect(await contract.getOpenCells(1)).to.equal(5);
      expect(await contract.getCells(1)).to.equal(5);
      expect(await contract.getClosedCells(1)).to.equal(0);
    });

    it("mints multiple tokens in one tx", async function () {
      await contract.connect(addr1).mint(3, { value: PRICE * 3n });
      expect(await contract.totalSupply()).to.equal(3);
      expect(await contract.balanceOf(addr1.address)).to.equal(3);
    });

    it("mints exactly MAX_MINT_PER_WALLET (5) tokens", async function () {
      await contract.connect(addr1).mint(5, { value: PRICE * 5n });
      expect(await contract.balanceOf(addr1.address)).to.equal(5);
      expect(await contract.mintedPerWallet(addr1.address)).to.equal(5);
    });

    it("tracks mintedPerWallet correctly across multiple txs", async function () {
      await contract.connect(addr1).mint(2, { value: PRICE * 2n });
      await contract.connect(addr1).mint(3, { value: PRICE * 3n });
      expect(await contract.mintedPerWallet(addr1.address)).to.equal(5);
    });

    it("accepts overpayment", async function () {
      await expect(
        contract.connect(addr1).mint(1, { value: PRICE * 2n })
      ).to.not.be.reverted;
    });

    it("assigns sequential token IDs starting at 1", async function () {
      await contract.connect(addr1).mint(3, { value: PRICE * 3n });
      expect(await contract.ownerOf(1)).to.equal(addr1.address);
      expect(await contract.ownerOf(2)).to.equal(addr1.address);
      expect(await contract.ownerOf(3)).to.equal(addr1.address);
    });

    it("reverts with quantity 0", async function () {
      await expect(
        contract.connect(addr1).mint(0, { value: 0 })
      ).to.be.revertedWith("Quantity must be > 0");
    });

    it("reverts when exceeding max per wallet", async function () {
      await expect(
        contract.connect(addr1).mint(6, { value: PRICE * 6n })
      ).to.be.revertedWith("Exceeds max per wallet");
    });

    it("reverts when second mint would push over wallet limit", async function () {
      await contract.connect(addr1).mint(4, { value: PRICE * 4n });
      await expect(
        contract.connect(addr1).mint(2, { value: PRICE * 2n })
      ).to.be.revertedWith("Exceeds max per wallet");
    });

    it("reverts with insufficient payment", async function () {
      await expect(
        contract.connect(addr1).mint(2, { value: PRICE })
      ).to.be.revertedWith("Insufficient payment");
    });

    it("reverts with zero payment", async function () {
      await expect(
        contract.connect(addr1).mint(1, { value: 0 })
      ).to.be.revertedWith("Insufficient payment");
    });

    it("different wallets can each mint up to 5", async function () {
      await contract.connect(addr1).mint(5, { value: PRICE * 5n });
      await contract.connect(addr2).mint(5, { value: PRICE * 5n });
      expect(await contract.totalSupply()).to.equal(10);
    });
  });

  // ──────────────────────────────────────────────────────────
  // tokenURI
  // ──────────────────────────────────────────────────────────
  describe("tokenURI", function () {
    beforeEach(async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
    });

    it("returns correct tokenURI", async function () {
      expect(await contract.tokenURI(1)).to.equal(BASE_URI + "1");
    });

    it("owner can update baseURI", async function () {
      await contract.setBaseURI("https://new.example.com/");
      expect(await contract.tokenURI(1)).to.equal("https://new.example.com/1");
    });

    it("non-owner cannot update baseURI", async function () {
      await expect(
        contract.connect(addr1).setBaseURI("https://evil.com/")
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────
  // Stats assignment
  // ──────────────────────────────────────────────────────────
  describe("setStats", function () {
    beforeEach(async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
    });

    it("assigns stats with 2 total points", async function () {
      await contract.connect(addr1).setStats(1, "Chad", 2, 0, 0, 0);
      const stats = await contract.getStats(1);
      expect(stats.strength).to.equal(2);
      expect(stats.intelligence).to.equal(0);
      expect(stats.assigned).to.be.true;
    });

    it("assigns stats split across multiple stats", async function () {
      await contract.connect(addr1).setStats(1, "Biggy", 1, 1, 0, 0);
      const stats = await contract.getStats(1);
      expect(stats.strength).to.equal(1);
      expect(stats.intelligence).to.equal(1);
    });

    it("sets the token name", async function () {
      await contract.connect(addr1).setStats(1, "Maximus", 0, 0, 1, 1);
      expect(await contract.tokenName(1)).to.equal("Maximus");
    });

    it("emits StatsAssigned and NameSet", async function () {
      await expect(contract.connect(addr1).setStats(1, "Chad", 2, 0, 0, 0))
        .to.emit(contract, "StatsAssigned").withArgs(1, 2, 0, 0, 0)
        .and.to.emit(contract, "NameSet").withArgs(1, "Chad");
    });

    it("reverts if not token owner", async function () {
      await expect(
        contract.connect(addr2).setStats(1, "Hack", 2, 0, 0, 0)
      ).to.be.revertedWith("Not token owner");
    });

    it("reverts if stats already assigned", async function () {
      await contract.connect(addr1).setStats(1, "Chad", 2, 0, 0, 0);
      await expect(
        contract.connect(addr1).setStats(1, "Chad2", 0, 0, 2, 0)
      ).to.be.revertedWith("Stats already assigned");
    });

    it("reverts if stat points != 2", async function () {
      await expect(
        contract.connect(addr1).setStats(1, "Chad", 1, 0, 0, 0)
      ).to.be.revertedWith("Must use exactly 2 points");
    });

    it("reverts if stat points > 2", async function () {
      await expect(
        contract.connect(addr1).setStats(1, "Chad", 3, 0, 0, 0)
      ).to.be.revertedWith("Must use exactly 2 points");
    });

    it("reverts with empty name", async function () {
      await expect(
        contract.connect(addr1).setStats(1, "", 2, 0, 0, 0)
      ).to.be.revertedWith("Name cannot be empty");
    });

    it("reverts with name longer than 12 chars", async function () {
      await expect(
        contract.connect(addr1).setStats(1, "TooLongNameXX", 2, 0, 0, 0)
      ).to.be.revertedWith("Name too long");
    });

    it("accepts name of exactly 12 chars", async function () {
      await expect(
        contract.connect(addr1).setStats(1, "Twelve_Chars", 2, 0, 0, 0)
      ).to.not.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────
  // Owner stat management
  // ──────────────────────────────────────────────────────────
  describe("updateStats (owner)", function () {
    beforeEach(async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
      await contract.connect(addr1).setStats(1, "Chad", 2, 0, 0, 0);
    });

    it("owner can overwrite stats", async function () {
      await contract.updateStats(1, 0, 0, 5, 5);
      const stats = await contract.getStats(1);
      expect(stats.dexterity).to.equal(5);
      expect(stats.charisma).to.equal(5);
    });

    it("non-owner cannot call updateStats", async function () {
      await expect(
        contract.connect(addr1).updateStats(1, 0, 0, 5, 5)
      ).to.be.reverted;
    });
  });

  describe("addStat (owner)", function () {
    beforeEach(async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
    });

    it("owner can increment a stat", async function () {
      await contract.addStat(1, 0, 3); // strength += 3
      const stats = await contract.getStats(1);
      expect(stats.strength).to.equal(3);
    });

    it("increments all stat indices", async function () {
      await contract.addStat(1, 0, 1);
      await contract.addStat(1, 1, 2);
      await contract.addStat(1, 2, 3);
      await contract.addStat(1, 3, 4);
      const stats = await contract.getStats(1);
      expect(stats.strength).to.equal(1);
      expect(stats.intelligence).to.equal(2);
      expect(stats.dexterity).to.equal(3);
      expect(stats.charisma).to.equal(4);
    });

    it("emits StatIncremented", async function () {
      await expect(contract.addStat(1, 0, 5))
        .to.emit(contract, "StatIncremented").withArgs(1, 0, 5, 5);
    });

    it("reverts for invalid stat index", async function () {
      await expect(contract.addStat(1, 4, 1)).to.be.revertedWith("Invalid stat index");
    });

    it("reverts for zero amount", async function () {
      await expect(contract.addStat(1, 0, 0)).to.be.revertedWith("Amount must be > 0");
    });

    it("non-owner cannot call addStat", async function () {
      await expect(
        contract.connect(addr1).addStat(1, 0, 1)
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────
  // Cells & Leveling (replaces Experience)
  // ──────────────────────────────────────────────────────────
  describe("Cells & Leveling", function () {
    beforeEach(async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
    });

    it("starts at level 1 with 5 open cells and 0 closed cells", async function () {
      expect(await contract.getLevel(1)).to.equal(1);
      expect(await contract.getOpenCells(1)).to.equal(5);
      expect(await contract.getClosedCells(1)).to.equal(0);
    });

    it("owner can award open cells", async function () {
      await contract.awardCells(1, 50);
      expect(await contract.getOpenCells(1)).to.equal(55);
    });

    it("token owner can lock cells to level up", async function () {
      // Give enough cells to level up
      await contract.awardCells(1, 95); // 5 + 95 = 100 open
      await expect(contract.connect(addr1).lockCells(1, 100))
        .to.emit(contract, "LevelUp").withArgs(1, 2, 1)
        .and.to.emit(contract, "CellsLocked").withArgs(1, 100, 100, 2);
      expect(await contract.getLevel(1)).to.equal(2);
      expect(await contract.getOpenCells(1)).to.equal(0);
      expect(await contract.getClosedCells(1)).to.equal(100);
    });

    it("awards pending stat points on level up", async function () {
      await contract.awardCells(1, 95);
      await contract.connect(addr1).lockCells(1, 100);
      expect(await contract.getPendingStatPoints(1)).to.equal(1);
    });

    it("awards multiple stat points on multi-level jump", async function () {
      await contract.awardCells(1, 295); // 5 + 295 = 300 open
      await contract.connect(addr1).lockCells(1, 300); // jumps to level 4
      expect(await contract.getPendingStatPoints(1)).to.equal(3);
      expect(await contract.getLevel(1)).to.equal(4);
    });

    it("partial lock does not level up if threshold not reached", async function () {
      await contract.awardCells(1, 45); // 50 open total
      await contract.connect(addr1).lockCells(1, 50);
      expect(await contract.getLevel(1)).to.equal(1);
      expect(await contract.getClosedCells(1)).to.equal(50);
    });

    it("incremental locks accumulate to level up", async function () {
      await contract.awardCells(1, 95);
      await contract.connect(addr1).lockCells(1, 50);
      expect(await contract.getLevel(1)).to.equal(1);
      await contract.connect(addr1).lockCells(1, 50);
      expect(await contract.getLevel(1)).to.equal(2);
    });

    it("reverts for zero lock amount", async function () {
      await expect(contract.connect(addr1).lockCells(1, 0)).to.be.revertedWith("Amount must be > 0");
    });

    it("reverts for insufficient open cells", async function () {
      await expect(contract.connect(addr1).lockCells(1, 100)).to.be.revertedWith("Insufficient open cells");
    });

    it("reverts if not token owner", async function () {
      await expect(contract.connect(addr2).lockCells(1, 5)).to.be.revertedWith("Not token owner");
    });

    it("non-owner/game cannot award cells", async function () {
      await expect(
        contract.connect(addr1).awardCells(1, 50)
      ).to.be.revertedWith("Not authorized");
    });
  });

  // ──────────────────────────────────────────────────────────
  // spendStatPoint
  // ──────────────────────────────────────────────────────────
  describe("spendStatPoint", function () {
    beforeEach(async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
      await contract.awardCells(1, 95); // 100 open total
      await contract.connect(addr1).lockCells(1, 100); // level 2, 1 stat point
    });

    it("token owner can spend a stat point", async function () {
      await contract.connect(addr1).spendStatPoint(1, 0); // strength
      const stats = await contract.getStats(1);
      expect(stats.strength).to.equal(1);
      expect(await contract.getPendingStatPoints(1)).to.equal(0);
    });

    it("emits StatPointSpent", async function () {
      await expect(contract.connect(addr1).spendStatPoint(1, 3))
        .to.emit(contract, "StatPointSpent").withArgs(1, 3, 1);
    });

    it("reverts when no stat points available", async function () {
      await contract.connect(addr1).spendStatPoint(1, 0);
      await expect(
        contract.connect(addr1).spendStatPoint(1, 0)
      ).to.be.revertedWith("No stat points available");
    });

    it("reverts for invalid stat index", async function () {
      await expect(
        contract.connect(addr1).spendStatPoint(1, 4)
      ).to.be.revertedWith("Invalid stat index");
    });

    it("reverts if not token owner", async function () {
      await expect(
        contract.connect(addr2).spendStatPoint(1, 0)
      ).to.be.revertedWith("Not token owner");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Game contract authorization
  // ──────────────────────────────────────────────────────────
  describe("Game contract authorization", function () {
    it("owner can authorize a game contract", async function () {
      await contract.setGameContract(addr2.address, true);
      expect(await contract.authorizedGame(addr2.address)).to.be.true;
    });

    it("authorized game can award cells", async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
      await contract.setGameContract(addr2.address, true);
      await expect(
        contract.connect(addr2).awardCells(1, 50)
      ).to.not.be.reverted;
    });

    it("owner can revoke game contract", async function () {
      await contract.setGameContract(addr2.address, true);
      await contract.setGameContract(addr2.address, false);
      expect(await contract.authorizedGame(addr2.address)).to.be.false;
    });

    it("emits GameContractSet", async function () {
      await expect(contract.setGameContract(addr2.address, true))
        .to.emit(contract, "GameContractSet").withArgs(addr2.address, true);
    });

    it("reverts when setting zero address", async function () {
      await expect(
        contract.setGameContract(ethers.ZeroAddress, true)
      ).to.be.revertedWith("Invalid address");
    });

    it("non-owner cannot set game contract", async function () {
      await expect(
        contract.connect(addr1).setGameContract(addr2.address, true)
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────
  // Withdraw
  // ──────────────────────────────────────────────────────────
  describe("Withdraw", function () {
    it("owner can withdraw contract balance", async function () {
      await contract.connect(addr1).mint(3, { value: PRICE * 3n });
      const before = await ethers.provider.getBalance(owner.address);
      const tx = await contract.withdraw();
      const receipt = await tx.wait();
      const gas = receipt.gasUsed * tx.gasPrice;
      const after = await ethers.provider.getBalance(owner.address);
      expect(after).to.be.greaterThan(before - gas);
    });

    it("non-owner cannot withdraw", async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
      await expect(contract.connect(addr1).withdraw()).to.be.reverted;
    });

    it("contract balance is correct after mints", async function () {
      await contract.connect(addr1).mint(2, { value: PRICE * 2n });
      await contract.connect(addr2).mint(1, { value: PRICE });
      const balance = await ethers.provider.getBalance(await contract.getAddress());
      expect(balance).to.equal(PRICE * 3n);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Unique Names
  // ──────────────────────────────────────────────────────────
  describe("Unique Names", function () {
    beforeEach(async function () {
      await contract.connect(addr1).mint(2, { value: PRICE * 2n });
    });

    it("prevents duplicate names (case-insensitive)", async function () {
      await contract.connect(addr1).setStats(1, "Chad", 2, 0, 0, 0);
      await expect(
        contract.connect(addr1).setStats(2, "chad", 0, 2, 0, 0)
      ).to.be.revertedWith("Name already taken");
    });

    it("prevents duplicate names (mixed case)", async function () {
      await contract.connect(addr1).setStats(1, "BIGBOY", 2, 0, 0, 0);
      await expect(
        contract.connect(addr1).setStats(2, "BigBoy", 0, 2, 0, 0)
      ).to.be.revertedWith("Name already taken");
    });

    it("allows different names", async function () {
      await contract.connect(addr1).setStats(1, "Alpha", 2, 0, 0, 0);
      await expect(
        contract.connect(addr1).setStats(2, "Beta", 0, 2, 0, 0)
      ).to.not.be.reverted;
    });

    it("isNameTaken returns correct values", async function () {
      expect(await contract.isNameTaken("Chad")).to.be.false;
      await contract.connect(addr1).setStats(1, "Chad", 2, 0, 0, 0);
      expect(await contract.isNameTaken("Chad")).to.be.true;
      expect(await contract.isNameTaken("chad")).to.be.true;
      expect(await contract.isNameTaken("CHAD")).to.be.true;
    });
  });

  // ──────────────────────────────────────────────────────────
  // Transfer Lock (isActive)
  // ──────────────────────────────────────────────────────────
  describe("Transfer Lock", function () {
    beforeEach(async function () {
      await contract.connect(addr1).mint(1, { value: PRICE });
      await contract.setGameContract(addr3.address, true);
    });

    it("game contract can set isActive", async function () {
      await contract.connect(addr3).setActive(1, true);
      expect(await contract.isActive(1)).to.be.true;
    });

    it("blocks transfer while isActive", async function () {
      await contract.connect(addr3).setActive(1, true);
      await expect(
        contract.connect(addr1).transferFrom(addr1.address, addr2.address, 1)
      ).to.be.revertedWith("Token is active in quest/arcade");
    });

    it("allows transfer after isActive cleared", async function () {
      await contract.connect(addr3).setActive(1, true);
      await contract.connect(addr3).setActive(1, false);
      await expect(
        contract.connect(addr1).transferFrom(addr1.address, addr2.address, 1)
      ).to.not.be.reverted;
    });

    it("non-game cannot set isActive", async function () {
      await expect(
        contract.connect(addr1).setActive(1, true)
      ).to.be.revertedWith("Not authorized");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Team System
  // ──────────────────────────────────────────────────────────
  describe("Team System", function () {
    let mockNft;

    beforeEach(async function () {
      // Deploy a second LastChad as a mock team NFT
      const Factory = await ethers.getContractFactory("LastChad");
      mockNft = await Factory.deploy(BASE_URI);
      // addr1 mints a team NFT
      await mockNft.connect(addr1).mint(1, { value: PRICE });
    });

    it("owner can create a team", async function () {
      const tx = await contract.createTeam("Apes", await mockNft.getAddress());
      await expect(tx).to.emit(contract, "TeamCreated").withArgs(1, "Apes", await mockNft.getAddress());
      expect(await contract.getTeamCount()).to.equal(1);
    });

    it("player with team NFT can mint with team", async function () {
      await contract.createTeam("Apes", await mockNft.getAddress());
      await contract.connect(addr1).mintWithTeam(1, 1, { value: PRICE });
      expect(await contract.tokenTeam(1)).to.equal(1);
      expect(await contract.teamMemberCount(1)).to.equal(1);
    });

    it("player without team NFT cannot mint with team", async function () {
      await contract.createTeam("Apes", await mockNft.getAddress());
      await expect(
        contract.connect(addr2).mintWithTeam(1, 1, { value: PRICE })
      ).to.be.revertedWith("Must hold team NFT");
    });

    it("player can mint without team (regular mint)", async function () {
      await contract.createTeam("Apes", await mockNft.getAddress());
      await contract.connect(addr2).mint(1, { value: PRICE });
      expect(await contract.tokenTeam(1)).to.equal(0);
    });

    it("reverts for inactive team", async function () {
      await contract.createTeam("Apes", await mockNft.getAddress());
      await contract.setTeamActive(1, false);
      await expect(
        contract.connect(addr1).mintWithTeam(1, 1, { value: PRICE })
      ).to.be.revertedWith("Team not active");
    });

    it("reverts for invalid team ID", async function () {
      await expect(
        contract.connect(addr1).mintWithTeam(1, 99, { value: PRICE })
      ).to.be.revertedWith("Invalid team");
    });

    it("getTeam returns correct data", async function () {
      await contract.createTeam("Apes", await mockNft.getAddress());
      await contract.connect(addr1).mintWithTeam(2, 1, { value: PRICE * 2n });
      const [name, nftAddr, active, count] = await contract.getTeam(1);
      expect(name).to.equal("Apes");
      expect(nftAddr).to.equal(await mockNft.getAddress());
      expect(active).to.be.true;
      expect(count).to.equal(2);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Cull System
  // ──────────────────────────────────────────────────────────
  describe("Cull System", function () {
    it("setCullMode sets percentage mode", async function () {
      await contract.setCullMode(1, 1000); // Percentage, 10%
      expect(await contract.cullMode()).to.equal(1);
      expect(await contract.cullValue()).to.equal(1000);
    });

    it("setCullMode sets fixed count mode", async function () {
      await contract.setCullMode(0, 50); // FixedCount, 50
      expect(await contract.cullMode()).to.equal(0);
      expect(await contract.cullValue()).to.equal(50);
    });

    it("getCullCount returns correct value for percentage mode", async function () {
      await contract.connect(addr1).mint(5, { value: PRICE * 5n });
      await contract.setCullMode(1, 2000); // 20%
      expect(await contract.getCullCount()).to.equal(1); // 20% of 5 = 1
    });

    it("getCullCount returns correct value for fixed count mode", async function () {
      await contract.setCullMode(0, 3);
      expect(await contract.getCullCount()).to.equal(3);
    });

    it("eliminatedCount tracks correctly", async function () {
      await contract.connect(addr1).mint(3, { value: PRICE * 3n });
      await contract.eliminate(1);
      expect(await contract.eliminatedCount()).to.equal(1);
      await contract.eliminate(2);
      expect(await contract.eliminatedCount()).to.equal(2);
      await contract.reinstate(1);
      expect(await contract.eliminatedCount()).to.equal(1);
    });

    it("announceCull emits event", async function () {
      await contract.connect(addr1).mint(5, { value: PRICE * 5n });
      const futureTime = Math.floor(Date.now() / 1000) + 86400;
      await expect(contract.announceCull(futureTime))
        .to.emit(contract, "CullAnnounced");
    });

    it("batchEliminate with eliminatedCount", async function () {
      await contract.connect(addr1).mint(5, { value: PRICE * 5n });
      await contract.batchEliminate([1, 2, 3]);
      expect(await contract.eliminatedCount()).to.equal(3);
    });

    it("batchReinstate works", async function () {
      await contract.connect(addr1).mint(3, { value: PRICE * 3n });
      await contract.batchEliminate([1, 2, 3]);
      await contract.batchReinstate([1, 3]);
      expect(await contract.eliminatedCount()).to.equal(1);
      expect(await contract.eliminated(2)).to.be.true;
    });
  });

  // ──────────────────────────────────────────────────────────
  // Batch Helpers
  // ──────────────────────────────────────────────────────────
  describe("Batch Helpers", function () {
    beforeEach(async function () {
      await contract.connect(addr1).mint(3, { value: PRICE * 3n });
    });

    it("batchAwardCells awards to multiple tokens", async function () {
      await contract.batchAwardCells([1, 2, 3], [10, 20, 30]);
      expect(await contract.getOpenCells(1)).to.equal(15); // 5 base + 10
      expect(await contract.getOpenCells(2)).to.equal(25);
      expect(await contract.getOpenCells(3)).to.equal(35);
    });

    it("batchAwardCells reverts on array mismatch", async function () {
      await expect(
        contract.batchAwardCells([1, 2], [10])
      ).to.be.revertedWith("Array length mismatch");
    });

    it("getClosedCellsBatch returns correct values", async function () {
      await contract.awardCells(1, 95);
      await contract.connect(addr1).lockCells(1, 50);
      await contract.awardCells(2, 195);
      await contract.connect(addr1).lockCells(2, 200);
      const result = await contract.getClosedCellsBatch([1, 2, 3]);
      expect(result[0]).to.equal(50);
      expect(result[1]).to.equal(200);
      expect(result[2]).to.equal(0);
    });

    it("getTotalCells returns open + closed", async function () {
      await contract.awardCells(1, 95); // 5 + 95 = 100
      await contract.connect(addr1).lockCells(1, 50); // 50 open, 50 closed
      expect(await contract.getTotalCells(1)).to.equal(100);
    });
  });
});
