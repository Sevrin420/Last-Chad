// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function eliminated(uint256 tokenId) external view returns (bool);
    function awardCells(uint256 tokenId, uint256 amount) external;
    function spendCells(uint256 tokenId, uint256 amount) external;
    function getOpenCells(uint256 tokenId) external view returns (uint256);
    function getClosedCells(uint256 tokenId) external view returns (uint256);
}

contract Tournament is Ownable {
    ILastChad public immutable lastChad;
    address public immutable gameOwner;
    uint256 public currentMonth;
    uint256 public constant LOCK_AMOUNT = 1111;

    // ── Endgame Snapshot ──
    mapping(uint256 => uint256) public endgameSnapshot;      // tokenId → closed cells at endgame

    // ── Cell Tiers ──
    mapping(uint256 => uint256) public cellTiers;            // closedCellThreshold → claimAmount
    uint256[] public tierThresholds;                         // sorted thresholds for lookup

    // ── Monthly State ──
    mapping(uint256 => mapping(uint256 => bool)) public cellsClaimed;    // tokenId → month → claimed
    mapping(uint256 => mapping(uint256 => bool)) public lockedForMonth;  // tokenId → month → locked
    mapping(uint256 => uint256) public lockCount;                        // month → number locked
    mapping(uint256 => uint256[]) public lockedChads;                    // month → tokenId array

    // ── Events ──
    event CellsClaimed(uint256 indexed tokenId, uint256 month, uint256 amount);
    event LockedForTournament(uint256 indexed tokenId, uint256 month);
    event PrizeDistributed(uint256 month, uint256 winnerCount, uint256 perWinner);
    event MonthAdvanced(uint256 newMonth);
    event EndgameSnapshotSet(uint256 count);
    event CellTierSet(uint256 threshold, uint256 amount);

    constructor(address _lastChad) Ownable(msg.sender) {
        lastChad = ILastChad(_lastChad);
        gameOwner = msg.sender;
    }

    // ─────────────────────────────────────────────────────────
    // Setup Functions (owner only)
    // ─────────────────────────────────────────────────────────

    /// @notice Freeze each chad's closed cell count for tier lookup (can be batched)
    function snapshotEndgame(uint256[] calldata tokenIds, uint256[] calldata closedCells) external onlyOwner {
        require(tokenIds.length == closedCells.length, "Array length mismatch");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            endgameSnapshot[tokenIds[i]] = closedCells[i];
        }
        emit EndgameSnapshotSet(tokenIds.length);
    }

    /// @notice Set a single cell tier (threshold → claim amount)
    function setCellTier(uint256 closedCellThreshold, uint256 claimAmount) external onlyOwner {
        _setCellTier(closedCellThreshold, claimAmount);
    }

    /// @notice Set multiple cell tiers in one call
    function batchSetCellTiers(uint256[] calldata thresholds, uint256[] calldata amounts) external onlyOwner {
        require(thresholds.length == amounts.length, "Array length mismatch");
        for (uint256 i = 0; i < thresholds.length; i++) {
            _setCellTier(thresholds[i], amounts[i]);
        }
    }

    function _setCellTier(uint256 threshold, uint256 amount) internal {
        // Add to thresholds array if new
        if (cellTiers[threshold] == 0 && amount > 0) {
            tierThresholds.push(threshold);
            _sortThresholds();
        }
        cellTiers[threshold] = amount;
        emit CellTierSet(threshold, amount);
    }

    function _sortThresholds() internal {
        uint256 len = tierThresholds.length;
        for (uint256 i = 1; i < len; i++) {
            uint256 key = tierThresholds[i];
            uint256 j = i;
            while (j > 0 && tierThresholds[j - 1] > key) {
                tierThresholds[j] = tierThresholds[j - 1];
                j--;
            }
            tierThresholds[j] = key;
        }
    }

    // ─────────────────────────────────────────────────────────
    // Player Functions
    // ─────────────────────────────────────────────────────────

    /// @notice Claim free cells based on endgame snapshot tier (once per month)
    function claimCells(uint256 tokenId) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!lastChad.eliminated(tokenId), "Chad eliminated");
        require(!cellsClaimed[tokenId][currentMonth], "Already claimed this month");

        uint256 amount = getClaimAmount(tokenId);
        require(amount > 0, "No cells to claim");

        cellsClaimed[tokenId][currentMonth] = true;
        lastChad.awardCells(tokenId, amount);

        emit CellsClaimed(tokenId, currentMonth, amount);
    }

    /// @notice Lock 1111 cells to enter this month's tournament
    function lockForTournament(uint256 tokenId) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!lastChad.eliminated(tokenId), "Chad eliminated");
        require(!lockedForMonth[tokenId][currentMonth], "Already locked this month");

        lastChad.spendCells(tokenId, LOCK_AMOUNT);

        lockedForMonth[tokenId][currentMonth] = true;
        lockCount[currentMonth]++;
        lockedChads[currentMonth].push(tokenId);

        emit LockedForTournament(tokenId, currentMonth);
    }

    // ─────────────────────────────────────────────────────────
    // Owner Functions — Distribution
    // ─────────────────────────────────────────────────────────

    /// @notice Distribute AVAX to winners and advance to next month
    function distributeAndReset() external onlyOwner {
        uint256 pool = address(this).balance;
        uint256 winners = lockCount[currentMonth];

        if (winners > 0 && pool > 0) {
            uint256 perWinner = pool / winners;
            uint256[] storage chads = lockedChads[currentMonth];

            for (uint256 i = 0; i < chads.length; i++) {
                address winner = lastChad.ownerOf(chads[i]);
                (bool sent, ) = payable(winner).call{value: perWinner}("");
                require(sent, "Transfer failed");
            }

            emit PrizeDistributed(currentMonth, winners, perWinner);
        }

        currentMonth++;
        emit MonthAdvanced(currentMonth);
    }

    /// @notice Accept AVAX deposits for the prize pool
    receive() external payable {}

    // ─────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────

    function getLockedChads(uint256 month) external view returns (uint256[] memory) {
        return lockedChads[month];
    }

    function getLockCount(uint256 month) external view returns (uint256) {
        return lockCount[month];
    }

    function hasClaimed(uint256 tokenId, uint256 month) external view returns (bool) {
        return cellsClaimed[tokenId][month];
    }

    function hasLocked(uint256 tokenId, uint256 month) external view returns (bool) {
        return lockedForMonth[tokenId][month];
    }

    function getClaimAmount(uint256 tokenId) public view returns (uint256) {
        uint256 snapshot = endgameSnapshot[tokenId];
        if (snapshot == 0) return 0;

        uint256 best = 0;
        for (uint256 i = 0; i < tierThresholds.length; i++) {
            if (snapshot >= tierThresholds[i]) {
                best = cellTiers[tierThresholds[i]];
            } else {
                break; // thresholds are sorted ascending
            }
        }
        return best;
    }

    function getCurrentMonth() external view returns (uint256) {
        return currentMonth;
    }

    function getTierCount() external view returns (uint256) {
        return tierThresholds.length;
    }

    function getTierThreshold(uint256 index) external view returns (uint256 threshold, uint256 amount) {
        require(index < tierThresholds.length, "Index out of bounds");
        threshold = tierThresholds[index];
        amount = cellTiers[threshold];
    }
}
