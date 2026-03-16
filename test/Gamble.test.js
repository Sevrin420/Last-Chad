const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRICE = ethers.parseEther("0.02");
const BASE_URI = "https://lastchad.xyz/metadata/";

describe("Gamble", function () {
  let lastChad, gamble, owner, player, other, oracleWallet;

  beforeEach(async function () {
    [owner, player, other] = await ethers.getSigners();
    oracleWallet = ethers.Wallet.createRandom();

    const ChadFactory = await ethers.getContractFactory("LastChad");
    lastChad = await ChadFactory.deploy(BASE_URI);

    const GambleFactory = await ethers.getContractFactory("Gamble");
    gamble = await GambleFactory.deploy(
      await lastChad.getAddress(),
      oracleWallet.address
    );

    // Authorize gamble contract
    await lastChad.setGameContract(await gamble.getAddress(), true);

    // Mint a token and give it cells
    await lastChad.connect(player).mint(1, { value: PRICE });
    await lastChad.connect(player).setStats(1, "TestChad", 1, 0, 1, 0);
    await lastChad.awardCells(1, 100);
  });

  /** Helper: sign a claimWinnings message with the oracle wallet */
  async function signClaim(tokenId, payout, nonce, playerAddr) {
    const messageHash = ethers.solidityPackedKeccak256(
      ["uint256", "uint256", "uint256", "address"],
      [tokenId, payout, nonce, playerAddr]
    );
    return oracleWallet.signMessage(ethers.getBytes(messageHash));
  }

  // ──────────────────────────────────────────────────────────
  // Constructor
  // ──────────────────────────────────────────────────────────
  describe("constructor", function () {
    it("sets oracle at deploy", async function () {
      expect(await gamble.oracle()).to.equal(oracleWallet.address);
    });

    it("reverts if oracle is zero address", async function () {
      const GambleFactory = await ethers.getContractFactory("Gamble");
      await expect(
        GambleFactory.deploy(await lastChad.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("Oracle required");
    });
  });

  // ──────────────────────────────────────────────────────────
  // commitWager
  // ──────────────────────────────────────────────────────────
  describe("commitWager", function () {
    it("deducts cells and returns nonce", async function () {
      const cellsBefore = await lastChad.getCells(1);
      const tx = await gamble.connect(player).commitWager(1, 10);
      const receipt = await tx.wait();

      const cellsAfter = await lastChad.getCells(1);
      expect(cellsBefore - cellsAfter).to.equal(10);

      // Check nonce was emitted
      const iface = gamble.interface;
      const log = receipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "WagerCommitted");
      expect(log).to.not.be.null;
      expect(log.args.nonce).to.equal(0);
      expect(log.args.wager).to.equal(10);
    });

    it("increments nonce on each call", async function () {
      await gamble.connect(player).commitWager(1, 5);
      const tx = await gamble.connect(player).commitWager(1, 5);
      const receipt = await tx.wait();

      const log = receipt.logs
        .map(l => { try { return gamble.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "WagerCommitted");
      expect(log.args.nonce).to.equal(1);
    });

    it("stores wager amount and player", async function () {
      await gamble.connect(player).commitWager(1, 10);
      expect(await gamble.wagerAmounts(0)).to.equal(10);
      expect(await gamble.wagerPlayers(0)).to.equal(player.address);
    });

    it("reverts if not token owner", async function () {
      await expect(
        gamble.connect(other).commitWager(1, 10)
      ).to.be.revertedWith("Not token owner");
    });

    it("reverts if wager out of range", async function () {
      await expect(
        gamble.connect(player).commitWager(1, 0)
      ).to.be.revertedWith("Wager out of range");

      await expect(
        gamble.connect(player).commitWager(1, 51)
      ).to.be.revertedWith("Wager out of range");
    });
  });

  // ──────────────────────────────────────────────────────────
  // claimWinnings
  // ──────────────────────────────────────────────────────────
  describe("claimWinnings", function () {
    beforeEach(async function () {
      // Commit a wager (nonce=0)
      await gamble.connect(player).commitWager(1, 10);
    });

    it("awards cells on valid oracle-signed claim", async function () {
      const sig = await signClaim(1, 20, 0, player.address);
      const cellsBefore = await lastChad.getCells(1);
      await gamble.connect(player).claimWinnings(1, 20, 0, sig);
      const cellsAfter = await lastChad.getCells(1);
      expect(cellsAfter - cellsBefore).to.equal(20);
    });

    it("cleans up storage after claim", async function () {
      const sig = await signClaim(1, 20, 0, player.address);
      await gamble.connect(player).claimWinnings(1, 20, 0, sig);
      expect(await gamble.wagerAmounts(0)).to.equal(0);
      expect(await gamble.usedNonces(0)).to.be.true;
    });

    it("reverts on double claim", async function () {
      const sig = await signClaim(1, 20, 0, player.address);
      await gamble.connect(player).claimWinnings(1, 20, 0, sig);
      await expect(
        gamble.connect(player).claimWinnings(1, 20, 0, sig)
      ).to.be.revertedWith("Already claimed");
    });

    it("reverts if wrong player", async function () {
      const sig = await signClaim(1, 20, 0, player.address);
      await expect(
        gamble.connect(other).claimWinnings(1, 20, 0, sig)
      ).to.be.revertedWith("Not token owner");
    });

    it("reverts if no active wager", async function () {
      const sig = await signClaim(1, 20, 99, player.address);
      await expect(
        gamble.connect(player).claimWinnings(1, 20, 99, sig)
      ).to.be.revertedWith("No active wager");
    });

    it("reverts with invalid oracle signature", async function () {
      const fakeWallet = ethers.Wallet.createRandom();
      const messageHash = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "uint256", "address"],
        [1, 20, 0, player.address]
      );
      const badSig = await fakeWallet.signMessage(ethers.getBytes(messageHash));

      await expect(
        gamble.connect(player).claimWinnings(1, 20, 0, badSig)
      ).to.be.revertedWith("Invalid oracle signature");
    });

    it("reverts with empty signature (no bypass)", async function () {
      await expect(
        gamble.connect(player).claimWinnings(1, 20, 0, "0x")
      ).to.be.reverted;
    });

    it("allows zero payout claim (just marks nonce used)", async function () {
      const sig = await signClaim(1, 0, 0, player.address);
      const cellsBefore = await lastChad.getCells(1);
      await gamble.connect(player).claimWinnings(1, 0, 0, sig);
      const cellsAfter = await lastChad.getCells(1);
      expect(cellsAfter).to.equal(cellsBefore);
      expect(await gamble.usedNonces(0)).to.be.true;
    });
  });
});
