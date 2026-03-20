// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function eliminated(uint256 tokenId) external view returns (bool);
    function isActive(uint256 tokenId) external view returns (bool);
    function spendCells(uint256 tokenId, uint256 amount) external;
    function awardCells(uint256 tokenId, uint256 amount) external;
}

/// @title CrapsGame — fully on-chain craps with deterministic dice
///
/// All dice rolls derive from a keccak256 seed generated at session start.
/// Bet placement, resolution, and payout happen entirely on-chain.
/// A Cloudflare Worker records events for multiplayer display and anti-cheat audit.
///
/// Must be authorized: lastChad.setGameContract(crapsGameAddress, true)
contract CrapsGame {
    ILastChad public immutable lastChad;
    address   public immutable gameOwner;

    // ── Bet type indices ───────────────────────────────────────────────────
    uint8 constant PASS       = 0;
    uint8 constant PASS_ODDS  = 1;
    uint8 constant FIELD      = 2;
    uint8 constant COME       = 3;
    uint8 constant HARD4      = 4;
    uint8 constant HARD6      = 5;
    uint8 constant HARD8      = 6;
    uint8 constant HARD10     = 7;
    uint8 constant PLACE4     = 8;
    uint8 constant PLACE5     = 9;
    uint8 constant PLACE6     = 10;
    uint8 constant PLACE8     = 11;
    uint8 constant PLACE9     = 12;
    uint8 constant PLACE10    = 13;
    // 14-19: come bets on 4,5,6,8,9,10
    // 20-25: come odds on 4,5,6,8,9,10
    uint8 constant BET_COUNT  = 26;

    struct Session {
        address player;
        uint256 stack;
        uint8   phase;       // 0 = comeout, 1 = point
        uint8   point;       // the point number (4-10), 0 if comeout
        uint256 rollCount;   // incremented each roll, used for dice derivation
        bytes32 baseSeed;    // generated at startSession
        bool    active;
    }

    mapping(uint256 => Session) public sessions;
    mapping(uint256 => mapping(uint8 => uint256)) public bets;

    uint256 public minWager = 1;
    uint256 public maxWager = 50;

    // ── Events (Worker indexes these for audit + multiplayer) ──────────────
    event SessionStarted(
        uint256 indexed tokenId,
        address indexed player,
        uint256 wager,
        bytes32 seed
    );
    event BetsPlaced(
        uint256 indexed tokenId,
        uint8[] zones,
        uint256[] amounts
    );
    event DiceRolled(
        uint256 indexed tokenId,
        uint8 d1,
        uint8 d2,
        int256  netWin,
        uint256 newStack,
        uint8   newPhase,
        uint8   newPoint
    );
    event CashedOut(
        uint256 indexed tokenId,
        uint256 payout
    );
    event SessionForceEnded(
        uint256 indexed tokenId,
        uint256 payout
    );

    // ── Constructor ────────────────────────────────────────────────────────
    constructor(address _lastChad) {
        lastChad  = ILastChad(_lastChad);
        gameOwner = msg.sender;
    }

    modifier onlyGameOwner() {
        require(msg.sender == gameOwner, "Not game owner");
        _;
    }

    // ── Admin ──────────────────────────────────────────────────────────────
    function setWagerLimits(uint256 _min, uint256 _max) external onlyGameOwner {
        require(_min > 0 && _max >= _min, "Invalid limits");
        minWager = _min;
        maxWager = _max;
    }

    // ── Start a craps session ──────────────────────────────────────────────
    /// @notice Spend cells as buy-in, generate deterministic seed, open session.
    function startSession(uint256 tokenId, uint256 wager) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!lastChad.eliminated(tokenId), "Eliminated");
        require(!lastChad.isActive(tokenId),   "Active elsewhere");
        require(!sessions[tokenId].active,     "Session already active");
        require(wager >= minWager && wager <= maxWager, "Wager out of range");

        lastChad.spendCells(tokenId, wager);

        bytes32 seed = keccak256(abi.encodePacked(
            tokenId, wager, block.prevrandao, block.timestamp, msg.sender
        ));

        sessions[tokenId] = Session({
            player:    msg.sender,
            stack:     wager,
            phase:     0,
            point:     0,
            rollCount: 0,
            baseSeed:  seed,
            active:    true
        });

        emit SessionStarted(tokenId, msg.sender, wager, seed);
    }

    // ── Place bets ─────────────────────────────────────────────────────────
    /// @notice Move chips from stack to bet zones. All validation on-chain.
    function placeBets(
        uint256 tokenId,
        uint8[] calldata zones,
        uint256[] calldata amounts
    ) external {
        Session storage s = sessions[tokenId];
        require(s.active,                "No active session");
        require(s.player == msg.sender,  "Not session player");
        require(zones.length == amounts.length && zones.length > 0, "Bad arrays");

        for (uint256 i = 0; i < zones.length; i++) {
            uint8   zone = zones[i];
            uint256 amt  = amounts[i];
            require(zone < BET_COUNT, "Invalid zone");
            require(amt > 0 && amt <= s.stack, "Bad amount");

            // Timing rules
            if (zone >= PLACE4 && zone <= PLACE10) {
                require(s.phase == 1, "Place bets after point");
            }
            if (zone == PASS_ODDS) {
                require(s.phase == 1 && bets[tokenId][PASS] > 0,
                    "Need pass bet and point");
            }
            if (zone == COME) {
                require(s.phase == 1, "Come bets after point");
            }
            // Come odds require existing come bet on that number
            if (zone >= 20 && zone <= 25) {
                require(bets[tokenId][zone - 6] > 0, "No come bet on number");
            }

            s.stack -= amt;
            bets[tokenId][zone] += amt;
        }

        emit BetsPlaced(tokenId, zones, amounts);
    }

    // ── Place bets + roll in one tx (better UX) ──────────────────────────
    /// @notice Place bets and roll dice atomically. Saves a transaction.
    function placeBetsAndRoll(
        uint256 tokenId,
        uint8[] calldata zones,
        uint256[] calldata amounts
    ) external {
        Session storage s = sessions[tokenId];
        require(s.active,                "No active session");
        require(s.player == msg.sender,  "Not session player");

        // Place bets (same logic as placeBets)
        if (zones.length > 0) {
            require(zones.length == amounts.length, "Bad arrays");
            for (uint256 i = 0; i < zones.length; i++) {
                uint8   zone = zones[i];
                uint256 amt  = amounts[i];
                require(zone < BET_COUNT, "Invalid zone");
                require(amt > 0 && amt <= s.stack, "Bad amount");
                if (zone >= PLACE4 && zone <= PLACE10) {
                    require(s.phase == 1, "Place bets after point");
                }
                if (zone == PASS_ODDS) {
                    require(s.phase == 1 && bets[tokenId][PASS] > 0,
                        "Need pass bet and point");
                }
                if (zone == COME) {
                    require(s.phase == 1, "Come bets after point");
                }
                if (zone >= 20 && zone <= 25) {
                    require(bets[tokenId][zone - 6] > 0, "No come bet on number");
                }
                s.stack -= amt;
                bets[tokenId][zone] += amt;
            }
            emit BetsPlaced(tokenId, zones, amounts);
        }

        // Roll (same logic as roll)
        bool hasBets;
        for (uint8 i = 0; i < BET_COUNT; i++) {
            if (bets[tokenId][i] > 0) { hasBets = true; break; }
        }
        require(hasBets, "No bets on table");

        bytes32 rollSeed = keccak256(abi.encodePacked(s.baseSeed, s.rollCount));
        s.rollCount++;
        uint8 d1 = uint8(uint256(keccak256(abi.encodePacked(rollSeed, uint8(0)))) % 6) + 1;
        uint8 d2 = uint8(uint256(keccak256(abi.encodePacked(rollSeed, uint8(1)))) % 6) + 1;
        uint8 total = d1 + d2;
        bool  isHard = (d1 == d2);

        int256 netWin = _resolveBets(tokenId, s, total, isHard);
        emit DiceRolled(tokenId, d1, d2, netWin, s.stack, s.phase, s.point);
    }

    // ── Roll dice ──────────────────────────────────────────────────────────
    /// @notice Generate deterministic dice from on-chain seed, resolve all bets.
    function roll(uint256 tokenId) external {
        Session storage s = sessions[tokenId];
        require(s.active,               "No active session");
        require(s.player == msg.sender, "Not session player");

        // Must have at least one bet on the table
        bool hasBets;
        for (uint8 i = 0; i < BET_COUNT; i++) {
            if (bets[tokenId][i] > 0) { hasBets = true; break; }
        }
        require(hasBets, "No bets on table");

        // Deterministic dice from seed
        bytes32 rollSeed = keccak256(abi.encodePacked(s.baseSeed, s.rollCount));
        s.rollCount++;

        uint8 d1 = uint8(uint256(keccak256(abi.encodePacked(rollSeed, uint8(0)))) % 6) + 1;
        uint8 d2 = uint8(uint256(keccak256(abi.encodePacked(rollSeed, uint8(1)))) % 6) + 1;
        uint8 total = d1 + d2;
        bool  isHard = (d1 == d2);

        int256 netWin = _resolveBets(tokenId, s, total, isHard);

        emit DiceRolled(tokenId, d1, d2, netWin, s.stack, s.phase, s.point);
    }

    // ── Cash out ───────────────────────────────────────────────────────────
    /// @notice Return all bets to stack, close session, award cells.
    function cashout(uint256 tokenId) external {
        Session storage s = sessions[tokenId];
        require(s.active,               "No active session");
        require(s.player == msg.sender, "Not session player");

        uint256 payout = _closeSession(tokenId, s);

        if (payout > 0) {
            lastChad.awardCells(tokenId, payout);
        }

        emit CashedOut(tokenId, payout);
    }

    // ── Force-end (game owner recovery) ────────────────────────────────────
    /// @notice Game owner can close a stuck session, returning cells to player.
    function forceEnd(uint256 tokenId) external onlyGameOwner {
        Session storage s = sessions[tokenId];
        require(s.active, "No active session");

        uint256 payout = _closeSession(tokenId, s);

        if (payout > 0) {
            lastChad.awardCells(tokenId, payout);
        }

        emit SessionForceEnded(tokenId, payout);
    }

    // ── View helpers ───────────────────────────────────────────────────────

    function getSession(uint256 tokenId) external view returns (
        address player,
        uint256 stack,
        uint8   phase,
        uint8   point,
        uint256 rollCount,
        bytes32 baseSeed,
        bool    active
    ) {
        Session storage s = sessions[tokenId];
        return (s.player, s.stack, s.phase, s.point, s.rollCount, s.baseSeed, s.active);
    }

    function getAllBets(uint256 tokenId) external view returns (uint256[26] memory result) {
        for (uint8 i = 0; i < BET_COUNT; i++) {
            result[i] = bets[tokenId][i];
        }
    }

    /// @notice Preview what dice a given rollCount would produce (for frontend verification).
    function previewDice(uint256 tokenId) external view returns (uint8 d1, uint8 d2) {
        Session storage s = sessions[tokenId];
        require(s.active, "No active session");
        bytes32 rollSeed = keccak256(abi.encodePacked(s.baseSeed, s.rollCount));
        d1 = uint8(uint256(keccak256(abi.encodePacked(rollSeed, uint8(0)))) % 6) + 1;
        d2 = uint8(uint256(keccak256(abi.encodePacked(rollSeed, uint8(1)))) % 6) + 1;
    }

    // ── Internal: close session ────────────────────────────────────────────

    function _closeSession(uint256 tokenId, Session storage s) internal returns (uint256 payout) {
        // Return all bets to stack
        for (uint8 i = 0; i < BET_COUNT; i++) {
            uint256 b = bets[tokenId][i];
            if (b > 0) {
                s.stack += b;
                bets[tokenId][i] = 0;
            }
        }
        payout = s.stack;
        s.active = false;
        s.stack = 0;
    }

    // ── Internal: resolve all bets for a roll ──────────────────────────────

    function _resolveBets(
        uint256 tokenId,
        Session storage s,
        uint8 total,
        bool isHard
    ) internal returns (int256 netWin) {

        // ── 1. FIELD (one-roll) ────────────────────────────────────────────
        uint256 fieldBet = bets[tokenId][FIELD];
        if (fieldBet > 0) {
            if (_isFieldWin(total)) {
                uint256 payout;
                if (total == 2)       payout = fieldBet * 2; // 2:1
                else if (total == 12) payout = fieldBet * 3; // 3:1
                else                  payout = fieldBet;     // 1:1
                netWin += int256(payout);
                s.stack += fieldBet + payout;
            }
            bets[tokenId][FIELD] = 0;
        }

        // ── 2. HARDWAYS ────────────────────────────────────────────────────
        netWin += _resolveHardways(tokenId, s, total, isHard);

        // ── 3. COME BETS on numbers (resolve before new come) ──────────────
        netWin += _resolveComeBets(tokenId, s, total);

        // ── 4. NEW COME BET ────────────────────────────────────────────────
        uint256 comeBet = bets[tokenId][COME];
        if (comeBet > 0) {
            if (total == 7 || total == 11) {
                netWin += int256(comeBet);
                s.stack += comeBet + comeBet; // 1:1
            } else if (total == 2 || total == 3 || total == 12) {
                // lose — bet gone
            } else {
                // Move to number
                uint8 cbIdx = _comeBetIndex(total);
                bets[tokenId][cbIdx] += comeBet;
            }
            bets[tokenId][COME] = 0;
        }

        // ── 5. PLACE BETS ──────────────────────────────────────────────────
        netWin += _resolvePlaceBets(tokenId, s, total);

        // ── 6. PASS LINE + ODDS ────────────────────────────────────────────
        netWin += _resolvePassLine(tokenId, s, total);
    }

    function _isFieldWin(uint8 total) internal pure returns (bool) {
        return total == 2 || total == 3 || total == 4 || total == 9 ||
               total == 10 || total == 11 || total == 12;
    }

    function _resolveHardways(
        uint256 tokenId, Session storage s, uint8 total, bool isHard
    ) internal returns (int256 netWin) {
        // hard4=7:1, hard6=9:1, hard8=9:1, hard10=7:1
        uint8[4] memory hIdx  = [HARD4, HARD6, HARD8, HARD10];
        uint8[4] memory hNum  = [uint8(4), 6, 8, 10];
        uint256[4] memory hMul = [uint256(7), 9, 9, 7];

        for (uint256 i = 0; i < 4; i++) {
            uint256 hBet = bets[tokenId][hIdx[i]];
            if (hBet == 0) continue;
            if (total == hNum[i] && isHard) {
                uint256 payout = hBet * hMul[i];
                netWin += int256(payout);
                s.stack += hBet + payout;
                bets[tokenId][hIdx[i]] = 0;
            } else if (total == 7 || (total == hNum[i] && !isHard)) {
                bets[tokenId][hIdx[i]] = 0;
            }
        }
    }

    function _resolveComeBets(
        uint256 tokenId, Session storage s, uint8 total
    ) internal returns (int256 netWin) {
        uint8[6] memory nums = [uint8(4), 5, 6, 8, 9, 10];

        for (uint256 i = 0; i < 6; i++) {
            uint8 cbIdx = uint8(14 + i);
            uint8 coIdx = uint8(20 + i);
            uint256 cb = bets[tokenId][cbIdx];
            if (cb == 0) continue;

            if (total == nums[i]) {
                // Win — 1:1
                netWin += int256(cb);
                s.stack += cb + cb;
                bets[tokenId][cbIdx] = 0;
                // Come odds
                uint256 co = bets[tokenId][coIdx];
                if (co > 0) {
                    uint256 oddsPay = _calcOdds(nums[i], co);
                    netWin += int256(oddsPay);
                    s.stack += co + oddsPay;
                    bets[tokenId][coIdx] = 0;
                }
            } else if (total == 7) {
                bets[tokenId][cbIdx] = 0;
                bets[tokenId][coIdx] = 0;
            }
        }
    }

    function _resolvePlaceBets(
        uint256 tokenId, Session storage s, uint8 total
    ) internal returns (int256 netWin) {
        // Place 4/10: 9:5, Place 5/9: 7:5, Place 6/8: 7:6
        uint8[6] memory nums   = [uint8(4), 5, 6, 8, 9, 10];
        uint8[6] memory pIdx   = [PLACE4, PLACE5, PLACE6, PLACE8, PLACE9, PLACE10];
        uint256[6] memory payN = [uint256(9), 7, 7, 7, 7, 9];
        uint256[6] memory payD = [uint256(5), 5, 6, 6, 5, 5];

        for (uint256 i = 0; i < 6; i++) {
            uint256 pb = bets[tokenId][pIdx[i]];
            if (pb == 0) continue;
            if (total == nums[i]) {
                uint256 payout = (pb * payN[i]) / payD[i];
                netWin += int256(payout);
                s.stack += pb + payout;
                bets[tokenId][pIdx[i]] = 0;
            } else if (total == 7) {
                bets[tokenId][pIdx[i]] = 0;
            }
        }
    }

    function _resolvePassLine(
        uint256 tokenId, Session storage s, uint8 total
    ) internal returns (int256 netWin) {
        uint256 passBet = bets[tokenId][PASS];

        if (s.phase == 0) {
            // ── Comeout ──
            if (passBet > 0) {
                if (total == 7 || total == 11) {
                    netWin += int256(passBet);
                    s.stack += passBet + passBet; // 1:1
                    bets[tokenId][PASS] = 0;
                } else if (total == 2 || total == 3 || total == 12) {
                    bets[tokenId][PASS] = 0; // craps — lose
                } else {
                    s.point = total;
                    s.phase = 1; // point established
                }
            }
        } else {
            // ── Point phase ──
            if (total == s.point) {
                // Winner
                if (passBet > 0) {
                    netWin += int256(passBet);
                    s.stack += passBet + passBet;
                    bets[tokenId][PASS] = 0;
                    // Pass odds
                    uint256 po = bets[tokenId][PASS_ODDS];
                    if (po > 0) {
                        uint256 oddsPay = _calcOdds(s.point, po);
                        netWin += int256(oddsPay);
                        s.stack += po + oddsPay;
                        bets[tokenId][PASS_ODDS] = 0;
                    }
                }
                s.phase = 0;
                s.point = 0;
            } else if (total == 7) {
                // Seven out
                if (passBet > 0) bets[tokenId][PASS] = 0;
                uint256 po = bets[tokenId][PASS_ODDS];
                if (po > 0) bets[tokenId][PASS_ODDS] = 0;
                s.phase = 0;
                s.point = 0;
            }
        }
    }

    function _calcOdds(uint8 pointNum, uint256 bet) internal pure returns (uint256) {
        if (pointNum == 4 || pointNum == 10) return bet * 2;         // 2:1
        if (pointNum == 5 || pointNum == 9)  return (bet * 3) / 2;   // 3:2
        if (pointNum == 6 || pointNum == 8)  return (bet * 6) / 5;   // 6:5
        return 0;
    }

    function _comeBetIndex(uint8 num) internal pure returns (uint8) {
        if (num == 4)  return 14;
        if (num == 5)  return 15;
        if (num == 6)  return 16;
        if (num == 8)  return 17;
        if (num == 9)  return 18;
        if (num == 10) return 19;
        revert("Invalid come number");
    }
}
