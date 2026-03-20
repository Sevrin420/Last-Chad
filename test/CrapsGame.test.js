const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRICE = ethers.parseEther("0.02");
const BASE_URI = "https://lastchad.xyz/metadata/";

// Bet type indices (must match CrapsGame.sol)
const PASS       = 0;
const PASS_ODDS  = 1;
const FIELD      = 2;
const COME       = 3;
const HARD4      = 4;
const HARD6      = 5;
const HARD8      = 6;
const HARD10     = 7;
const PLACE4     = 8;
const PLACE5     = 9;
const PLACE6     = 10;
const PLACE8     = 11;
const PLACE9     = 12;
const PLACE10    = 13;
// 14-19: come bets on 4,5,6,8,9,10
// 20-25: come odds on 4,5,6,8,9,10

describe("CrapsGame", function () {
  let lastChad, craps, owner, player, other;

  beforeEach(async function () {
    [owner, player, other] = await ethers.getSigners();

    const ChadFactory = await ethers.getContractFactory("LastChad");
    lastChad = await ChadFactory.deploy(BASE_URI);

    const CrapsFactory = await ethers.getContractFactory("CrapsGame");
    craps = await CrapsFactory.deploy(await lastChad.getAddress());

    // Authorize craps contract
    await lastChad.setGameContract(await craps.getAddress(), true);

    // Mint a token and give it cells
    await lastChad.connect(player).mint(1, { value: PRICE });
    await lastChad.connect(player).setStats(1, "CrapChad", 1, 0, 1, 0);
    await lastChad.awardCells(1, 200);
  });

  /** Helper: get dice values from a DiceRolled event */
  function parseDiceRolled(receipt) {
    const iface = craps.interface;
    const log = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(e => e && e.name === "DiceRolled");
    if (!log) return null;
    return {
      tokenId:  Number(log.args.tokenId),
      d1:       Number(log.args.d1),
      d2:       Number(log.args.d2),
      netWin:   log.args.netWin,
      newStack: Number(log.args.newStack),
      newPhase: Number(log.args.newPhase),
      newPoint: Number(log.args.newPoint),
    };
  }

  function parseSessionStarted(receipt) {
    const iface = craps.interface;
    const log = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(e => e && e.name === "SessionStarted");
    return log ? log.args : null;
  }

  // ──────────────────────────────────────────────────────────
  // Constructor
  // ──────────────────────────────────────────────────────────
  describe("constructor", function () {
    it("sets lastChad and gameOwner", async function () {
      expect(await craps.lastChad()).to.equal(await lastChad.getAddress());
      expect(await craps.gameOwner()).to.equal(owner.address);
    });
  });

  // ──────────────────────────────────────────────────────────
  // startSession
  // ──────────────────────────────────────────────────────────
  describe("startSession", function () {
    it("opens a session and spends cells", async function () {
      const cellsBefore = await lastChad.getCells(1);
      const tx = await craps.connect(player).startSession(1, 20);
      const receipt = await tx.wait();
      const cellsAfter = await lastChad.getCells(1);

      expect(cellsBefore - cellsAfter).to.equal(20n);

      const args = parseSessionStarted(receipt);
      expect(args).to.not.be.null;
      expect(args.wager).to.equal(20);
      expect(args.seed).to.not.equal(ethers.ZeroHash);

      const [, stack, phase, , , , active] = await craps.getSession(1);
      expect(stack).to.equal(20);
      expect(phase).to.equal(0); // comeout
      expect(active).to.be.true;
    });

    it("reverts if not token owner", async function () {
      await expect(
        craps.connect(other).startSession(1, 10)
      ).to.be.revertedWith("Not token owner");
    });

    it("reverts if session already active", async function () {
      await craps.connect(player).startSession(1, 10);
      await expect(
        craps.connect(player).startSession(1, 10)
      ).to.be.revertedWith("Session already active");
    });

    it("reverts if wager out of range", async function () {
      await expect(
        craps.connect(player).startSession(1, 0)
      ).to.be.revertedWith("Wager out of range");
      await expect(
        craps.connect(player).startSession(1, 51)
      ).to.be.revertedWith("Wager out of range");
    });
  });

  // ──────────────────────────────────────────────────────────
  // placeBets
  // ──────────────────────────────────────────────────────────
  describe("placeBets", function () {
    beforeEach(async function () {
      await craps.connect(player).startSession(1, 50);
    });

    it("places a pass bet", async function () {
      await craps.connect(player).placeBets(1, [PASS], [5]);
      const [, stack] = await craps.getSession(1);
      expect(stack).to.equal(45);
      const allBets = await craps.getAllBets(1);
      expect(allBets[PASS]).to.equal(5);
    });

    it("places multiple bets at once", async function () {
      await craps.connect(player).placeBets(1, [PASS, FIELD], [5, 3]);
      const [, stack] = await craps.getSession(1);
      expect(stack).to.equal(42);
      const allBets = await craps.getAllBets(1);
      expect(allBets[PASS]).to.equal(5);
      expect(allBets[FIELD]).to.equal(3);
    });

    it("reverts if not session player", async function () {
      await expect(
        craps.connect(other).placeBets(1, [PASS], [5])
      ).to.be.revertedWith("Not session player");
    });

    it("reverts if amount exceeds stack", async function () {
      await expect(
        craps.connect(player).placeBets(1, [PASS], [51])
      ).to.be.revertedWith("Bad amount");
    });

    it("reverts place bets during comeout", async function () {
      await expect(
        craps.connect(player).placeBets(1, [PLACE6], [5])
      ).to.be.revertedWith("Place bets after point");
    });

    it("reverts pass odds without pass bet and point", async function () {
      await expect(
        craps.connect(player).placeBets(1, [PASS_ODDS], [5])
      ).to.be.revertedWith("Need pass bet and point");
    });

    it("reverts come bets during comeout", async function () {
      await expect(
        craps.connect(player).placeBets(1, [COME], [5])
      ).to.be.revertedWith("Come bets after point");
    });
  });

  // ──────────────────────────────────────────────────────────
  // roll — basic
  // ──────────────────────────────────────────────────────────
  describe("roll", function () {
    beforeEach(async function () {
      await craps.connect(player).startSession(1, 50);
    });

    it("reverts with no bets on table", async function () {
      await expect(
        craps.connect(player).roll(1)
      ).to.be.revertedWith("No bets on table");
    });

    it("emits DiceRolled with valid dice values", async function () {
      await craps.connect(player).placeBets(1, [PASS], [5]);
      const tx = await craps.connect(player).roll(1);
      const receipt = await tx.wait();
      const result = parseDiceRolled(receipt);

      expect(result).to.not.be.null;
      expect(result.d1).to.be.gte(1).and.lte(6);
      expect(result.d2).to.be.gte(1).and.lte(6);
    });

    it("produces deterministic dice (same seed → same result)", async function () {
      // Preview dice before rolling
      const [d1Preview, d2Preview] = await craps.previewDice(1);
      await craps.connect(player).placeBets(1, [FIELD], [1]);
      const tx = await craps.connect(player).roll(1);
      const receipt = await tx.wait();
      const result = parseDiceRolled(receipt);

      expect(result.d1).to.equal(Number(d1Preview));
      expect(result.d2).to.equal(Number(d2Preview));
    });

    it("increments rollCount after each roll", async function () {
      await craps.connect(player).placeBets(1, [FIELD], [1]);
      await craps.connect(player).roll(1);
      const [, , , , rollCount] = await craps.getSession(1);
      expect(rollCount).to.equal(1);
    });
  });

  // ──────────────────────────────────────────────────────────
  // roll — pass line resolution
  // ──────────────────────────────────────────────────────────
  describe("pass line resolution", function () {
    beforeEach(async function () {
      await craps.connect(player).startSession(1, 50);
    });

    it("resolves pass line over multiple rolls until outcome", async function () {
      // Place pass bet and roll repeatedly — eventually we hit a comeout win/loss or a point
      await craps.connect(player).placeBets(1, [PASS], [5]);

      let rolls = 0;
      let resolved = false;
      let stackAfter;

      // Roll until the pass line bet resolves (max 50 rolls to prevent infinite loop)
      while (rolls < 50 && !resolved) {
        // Re-place field bet if needed to keep a bet on the table
        const allBets = await craps.getAllBets(1);
        const hasBets = allBets.some(b => b > 0n);
        if (!hasBets) {
          const [, stack] = await craps.getSession(1);
          if (stack >= 1n) {
            await craps.connect(player).placeBets(1, [FIELD], [1]);
          } else {
            break;
          }
        }

        const tx = await craps.connect(player).roll(1);
        const receipt = await tx.wait();
        const result = parseDiceRolled(receipt);
        rolls++;
        stackAfter = result.newStack;

        // Check if pass bet is still on the table
        const betsAfter = await craps.getAllBets(1);
        if (betsAfter[PASS] === 0n) resolved = true;
      }

      // Just verify we completed successfully without reverting
      expect(rolls).to.be.gte(1);
    });
  });

  // ──────────────────────────────────────────────────────────
  // roll — field bet resolution
  // ──────────────────────────────────────────────────────────
  describe("field bet resolution", function () {
    beforeEach(async function () {
      await craps.connect(player).startSession(1, 50);
    });

    it("field bet clears after every roll (one-roll bet)", async function () {
      await craps.connect(player).placeBets(1, [FIELD], [5]);
      await craps.connect(player).roll(1);
      const allBets = await craps.getAllBets(1);
      expect(allBets[FIELD]).to.equal(0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // cashout
  // ──────────────────────────────────────────────────────────
  describe("cashout", function () {
    beforeEach(async function () {
      await craps.connect(player).startSession(1, 50);
    });

    it("returns stack as cells", async function () {
      const cellsBefore = await lastChad.getCells(1);
      await craps.connect(player).cashout(1);
      const cellsAfter = await lastChad.getCells(1);

      // Player started with 200, spent 50 on session, gets 50 back
      expect(cellsAfter - cellsBefore).to.equal(50n);

      const [, , , , , , active] = await craps.getSession(1);
      expect(active).to.be.false;
    });

    it("returns bets on table + stack", async function () {
      await craps.connect(player).placeBets(1, [PASS, FIELD], [10, 5]);
      // Stack is now 35, 15 on table
      const cellsBefore = await lastChad.getCells(1);
      await craps.connect(player).cashout(1);
      const cellsAfter = await lastChad.getCells(1);

      // Should get 35 + 15 = 50 back
      expect(cellsAfter - cellsBefore).to.equal(50n);
    });

    it("reverts if not session player", async function () {
      await expect(
        craps.connect(other).cashout(1)
      ).to.be.revertedWith("Not session player");
    });

    it("allows new session after cashout", async function () {
      await craps.connect(player).cashout(1);
      // Should be able to start a new session
      await craps.connect(player).startSession(1, 20);
      const [, , , , , , active] = await craps.getSession(1);
      expect(active).to.be.true;
    });

    it("handles zero payout (lost everything)", async function () {
      // Place all chips as field bets and roll until broke
      let stack = 50n;
      while (stack > 0n) {
        const betAmt = stack > 10n ? 10n : stack;
        await craps.connect(player).placeBets(1, [FIELD], [betAmt]);
        await craps.connect(player).roll(1);
        const [, s] = await craps.getSession(1);
        stack = s;
        const allBets = await craps.getAllBets(1);
        // Field clears every roll, so if stack is 0 and no bets, we're broke
        if (stack === 0n && allBets.every(b => b === 0n)) break;
      }

      const cellsBefore = await lastChad.getCells(1);
      await craps.connect(player).cashout(1);
      const cellsAfter = await lastChad.getCells(1);
      // Might be 0 or some small amount from wins
      expect(cellsAfter).to.be.gte(cellsBefore);
    });
  });

  // ──────────────────────────────────────────────────────────
  // forceEnd
  // ──────────────────────────────────────────────────────────
  describe("forceEnd", function () {
    beforeEach(async function () {
      await craps.connect(player).startSession(1, 30);
    });

    it("game owner can force-end a session", async function () {
      const cellsBefore = await lastChad.getCells(1);
      await craps.connect(owner).forceEnd(1);
      const cellsAfter = await lastChad.getCells(1);
      expect(cellsAfter - cellsBefore).to.equal(30n);

      const [, , , , , , active] = await craps.getSession(1);
      expect(active).to.be.false;
    });

    it("reverts if not game owner", async function () {
      await expect(
        craps.connect(player).forceEnd(1)
      ).to.be.revertedWith("Not game owner");
    });
  });

  // ──────────────────────────────────────────────────────────
  // setWagerLimits
  // ──────────────────────────────────────────────────────────
  describe("setWagerLimits", function () {
    it("updates wager limits", async function () {
      await craps.connect(owner).setWagerLimits(5, 100);
      expect(await craps.minWager()).to.equal(5);
      expect(await craps.maxWager()).to.equal(100);
    });

    it("reverts if not game owner", async function () {
      await expect(
        craps.connect(player).setWagerLimits(5, 100)
      ).to.be.revertedWith("Not game owner");
    });

    it("reverts if min > max", async function () {
      await expect(
        craps.connect(owner).setWagerLimits(10, 5)
      ).to.be.revertedWith("Invalid limits");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Integration: multi-roll session
  // ──────────────────────────────────────────────────────────
  describe("integration: multi-roll session", function () {
    it("plays a full session with multiple rolls and cashes out", async function () {
      await craps.connect(player).startSession(1, 50);

      // Play 10 rounds of field betting
      for (let i = 0; i < 10; i++) {
        const [, stack] = await craps.getSession(1);
        if (stack === 0n) break;
        const betAmt = stack > 5n ? 5n : stack;
        await craps.connect(player).placeBets(1, [FIELD], [betAmt]);
        await craps.connect(player).roll(1);
      }

      // Cash out whatever remains
      const cellsBefore = await lastChad.getCells(1);
      await craps.connect(player).cashout(1);
      const cellsAfter = await lastChad.getCells(1);

      // Verify session is closed
      const [, , , , , , active] = await craps.getSession(1);
      expect(active).to.be.false;

      // Cells increased by payout amount
      expect(cellsAfter).to.be.gte(cellsBefore);
    });

    it("plays pass line with point and place bets", async function () {
      await craps.connect(player).startSession(1, 50);

      // Place pass bet
      await craps.connect(player).placeBets(1, [PASS], [5]);

      // Roll until point is set or pass resolves
      let pointSet = false;
      for (let i = 0; i < 20; i++) {
        // Add a field bet to ensure there's always a bet on table
        const [, stack] = await craps.getSession(1);
        if (stack === 0n) break;

        const allBets = await craps.getAllBets(1);
        const hasBets = allBets.some(b => b > 0n);
        if (!hasBets) {
          await craps.connect(player).placeBets(1, [FIELD], [1]);
        }

        const tx = await craps.connect(player).roll(1);
        const receipt = await tx.wait();
        const result = parseDiceRolled(receipt);

        if (result.newPhase === 1 && result.newPoint > 0) {
          pointSet = true;
          // Now we can place place bets
          const [, stackNow] = await craps.getSession(1);
          if (stackNow >= 5n) {
            await craps.connect(player).placeBets(1, [PLACE6], [5]);
          }
          break;
        }
      }

      // Cash out
      await craps.connect(player).cashout(1);
      const [, , , , , , active] = await craps.getSession(1);
      expect(active).to.be.false;
    });
  });

  // ──────────────────────────────────────────────────────────
  // View helpers
  // ──────────────────────────────────────────────────────────
  describe("view helpers", function () {
    it("getAllBets returns 26-element array", async function () {
      await craps.connect(player).startSession(1, 50);
      const allBets = await craps.getAllBets(1);
      expect(allBets.length).to.equal(26);
    });

    it("previewDice returns valid values", async function () {
      await craps.connect(player).startSession(1, 50);
      const [d1, d2] = await craps.previewDice(1);
      expect(d1).to.be.gte(1).and.lte(6);
      expect(d2).to.be.gte(1).and.lte(6);
    });

    it("previewDice reverts without active session", async function () {
      await expect(craps.previewDice(1)).to.be.revertedWith("No active session");
    });
  });
});
