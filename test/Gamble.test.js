const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRICE = ethers.parseEther("0.02");
const BASE_URI = "https://membersonly.xyz/metadata/";
const CHIPS_ID = 0n;

describe("Gamble", function () {
  let membersOnly, items, gamble, owner, player, other, oracleWallet;

  beforeEach(async function () {
    [owner, player, other] = await ethers.getSigners();
    oracleWallet = ethers.Wallet.createRandom();

    const MembersOnly = await ethers.getContractFactory("MembersOnly");
    membersOnly = await MembersOnly.deploy(BASE_URI);

    const Items = await ethers.getContractFactory("MembersOnlyItems");
    items = await Items.deploy("https://membersonly.xyz/items/", await membersOnly.getAddress());

    // Wire MembersOnly → Items
    await membersOnly.setItems(await items.getAddress());
    await items.setGameContract(await membersOnly.getAddress(), true);

    const GambleFactory = await ethers.getContractFactory("Gamble");
    gamble = await GambleFactory.deploy(
      await membersOnly.getAddress(),
      await items.getAddress(),
      oracleWallet.address
    );

    // Authorize Gamble in Items (for burnChips/mintChips)
    await items.setGameContract(await gamble.getAddress(), true);

    // Fund the house so free chip mints (test grant + winnings) stay backed.
    await items.depositHouse({ value: ethers.parseEther("100") });

    // Mint a token (welcome bonus is 50 TOURNAMENT chips, token 1)
    await membersOnly.connect(player).mint(1, { value: PRICE });
    // Grant regular (real-money) chips for wagering in tests
    await items.mintChips(player.address, 100);
  });

  async function signClaim(tokenId, payout, nonce, playerAddr) {
    const messageHash = ethers.solidityPackedKeccak256(
      ["uint256", "uint256", "uint256", "address"],
      [tokenId, payout, nonce, playerAddr]
    );
    return oracleWallet.signMessage(ethers.getBytes(messageHash));
  }

  // ─── Constructor ───
  describe("constructor", function () {
    it("sets oracle at deploy", async function () {
      expect(await gamble.oracle()).to.equal(oracleWallet.address);
    });

    it("reverts if oracle is zero address", async function () {
      const GambleFactory = await ethers.getContractFactory("Gamble");
      await expect(
        GambleFactory.deploy(await membersOnly.getAddress(), await items.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("Oracle required");
    });
  });

  // ─── commitWager ───
  describe("commitWager", function () {
    it("burns chips and returns nonce", async function () {
      const before = await items.balanceOf(player.address, CHIPS_ID);
      const tx = await gamble.connect(player).commitWager(1, 10);
      const receipt = await tx.wait();

      const after = await items.balanceOf(player.address, CHIPS_ID);
      expect(before - after).to.equal(10n);

      const log = receipt.logs
        .map(l => { try { return gamble.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "WagerCommitted");
      expect(log).to.not.be.null;
      expect(log.args.nonce).to.equal(0);
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
    });
  });

  // ─── claimWinnings ───
  describe("claimWinnings", function () {
    beforeEach(async function () {
      await gamble.connect(player).commitWager(1, 10);
    });

    it("mints chips on valid oracle-signed claim", async function () {
      const sig = await signClaim(1, 20, 0, player.address);
      const before = await items.balanceOf(player.address, CHIPS_ID);
      await gamble.connect(player).claimWinnings(1, 20, 0, sig);
      const after = await items.balanceOf(player.address, CHIPS_ID);
      expect(after - before).to.equal(20n);
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
  });
});
