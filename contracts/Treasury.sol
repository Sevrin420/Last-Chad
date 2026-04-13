// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IMembersOnly {
    function ownerOf(uint256 tokenId) external view returns (address);
    function spendChips(uint256 tokenId, uint256 amount) external;
}

/**
 * @title Treasury
 * @notice Yield-sharing vault for Members Only NFT holders.
 *
 *  Players burn 10,000 chips per share (permanent).
 *  Owner deposits AVAX monthly — shareholders claim proportional yield.
 *  Uses per-token checkpoints so share changes don't affect past months.
 */
contract Treasury is Ownable {

    IMembersOnly public immutable membersOnly;

    uint256 public constant CHIPS_PER_SHARE = 10_000;

    // ── Share state ─────────────────────────────────────────────
    mapping(uint256 => uint256) public shares;      // tokenId => current shares
    uint256 public totalShares;

    // Checkpoint: records share balance at a given month
    struct Checkpoint {
        uint256 month;
        uint256 value;
    }
    mapping(uint256 => Checkpoint[]) private _tokenCkpts; // tokenId => history
    Checkpoint[] private _totalCkpts;                      // global history

    // ── Monthly yield ───────────────────────────────────────────
    uint256 public currentMonth;
    mapping(uint256 => uint256) public monthlyDeposit;       // month => AVAX
    mapping(uint256 => uint256) public monthlyTotalShares;   // month => snapshot

    // ── Claims ──────────────────────────────────────────────────
    mapping(uint256 => mapping(uint256 => bool)) public claimed; // tokenId => month => claimed

    // ── Events ──────────────────────────────────────────────────
    event SharesBurned(uint256 indexed tokenId, uint256 numShares, uint256 chipsBurned);
    event YieldDeposited(uint256 indexed month, uint256 amount, uint256 snapshotShares);
    event YieldClaimed(uint256 indexed tokenId, uint256 indexed month, uint256 amount);

    constructor(address _membersOnly) Ownable(msg.sender) {
        membersOnly = IMembersOnly(_membersOnly);
    }

    // ─────────────────────────────────────────────────────────────
    //  Burn chips → permanent shares
    // ─────────────────────────────────────────────────────────────

    function burnForShares(uint256 tokenId, uint256 numShares) external {
        require(msg.sender == membersOnly.ownerOf(tokenId), "Not token owner");
        require(numShares > 0, "Zero shares");

        uint256 cost = numShares * CHIPS_PER_SHARE;
        membersOnly.spendChips(tokenId, cost);

        shares[tokenId] += numShares;
        totalShares += numShares;

        _writeCheckpoint(_tokenCkpts[tokenId], shares[tokenId]);
        _writeCheckpoint(_totalCkpts, totalShares);

        emit SharesBurned(tokenId, numShares, cost);
    }

    // ─────────────────────────────────────────────────────────────
    //  Owner deposits AVAX yield for current month
    // ─────────────────────────────────────────────────────────────

    function depositYield() external payable onlyOwner {
        require(msg.value > 0, "No AVAX sent");
        require(totalShares > 0, "No shareholders");

        monthlyDeposit[currentMonth] = msg.value;
        monthlyTotalShares[currentMonth] = totalShares;

        emit YieldDeposited(currentMonth, msg.value, totalShares);
        currentMonth++;
    }

    // ─────────────────────────────────────────────────────────────
    //  Claim yield
    // ─────────────────────────────────────────────────────────────

    function claimYield(uint256 tokenId, uint256 month) external {
        require(msg.sender == membersOnly.ownerOf(tokenId), "Not token owner");
        require(month < currentMonth, "Month not finalized");
        require(!claimed[tokenId][month], "Already claimed");
        require(monthlyDeposit[month] > 0, "No deposit");

        uint256 playerShares = _sharesAt(_tokenCkpts[tokenId], month);
        require(playerShares > 0, "No shares that month");

        claimed[tokenId][month] = true;

        uint256 payout = (monthlyDeposit[month] * playerShares) / monthlyTotalShares[month];
        require(payout > 0, "Nothing to claim");

        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "Transfer failed");

        emit YieldClaimed(tokenId, month, payout);
    }

    function batchClaimYield(uint256 tokenId, uint256[] calldata months) external {
        require(msg.sender == membersOnly.ownerOf(tokenId), "Not token owner");

        uint256 total;
        for (uint256 i = 0; i < months.length; i++) {
            uint256 m = months[i];
            require(m < currentMonth, "Month not finalized");
            if (claimed[tokenId][m]) continue;
            if (monthlyDeposit[m] == 0) continue;

            uint256 playerShares = _sharesAt(_tokenCkpts[tokenId], m);
            if (playerShares == 0) continue;

            claimed[tokenId][m] = true;
            uint256 payout = (monthlyDeposit[m] * playerShares) / monthlyTotalShares[m];
            total += payout;

            emit YieldClaimed(tokenId, m, payout);
        }

        require(total > 0, "Nothing to claim");
        (bool ok, ) = msg.sender.call{value: total}("");
        require(ok, "Transfer failed");
    }

    // ─────────────────────────────────────────────────────────────
    //  View helpers
    // ─────────────────────────────────────────────────────────────

    function getClaimable(uint256 tokenId, uint256 month) external view returns (uint256) {
        if (month >= currentMonth) return 0;
        if (claimed[tokenId][month]) return 0;
        if (monthlyDeposit[month] == 0) return 0;

        uint256 playerShares = _sharesAt(_tokenCkpts[tokenId], month);
        if (playerShares == 0) return 0;

        return (monthlyDeposit[month] * playerShares) / monthlyTotalShares[month];
    }

    function getSharesAt(uint256 tokenId, uint256 month) external view returns (uint256) {
        return _sharesAt(_tokenCkpts[tokenId], month);
    }

    // ─────────────────────────────────────────────────────────────
    //  Internal: checkpoint read / write
    // ─────────────────────────────────────────────────────────────

    function _writeCheckpoint(Checkpoint[] storage ckpts, uint256 value) private {
        uint256 len = ckpts.length;
        if (len > 0 && ckpts[len - 1].month == currentMonth) {
            ckpts[len - 1].value = value;
        } else {
            ckpts.push(Checkpoint(currentMonth, value));
        }
    }

    function _sharesAt(Checkpoint[] storage ckpts, uint256 month) private view returns (uint256) {
        uint256 len = ckpts.length;
        if (len == 0) return 0;
        if (ckpts[len - 1].month <= month) return ckpts[len - 1].value;
        if (ckpts[0].month > month) return 0;

        // Binary search for latest checkpoint at or before `month`
        uint256 lo = 0;
        uint256 hi = len - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (ckpts[mid].month <= month) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return ckpts[lo].value;
    }
}
