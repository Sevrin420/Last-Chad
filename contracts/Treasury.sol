// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IMembersOnlyForTreasury {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IMembersOnlyItemsForTreasury {
    function burnChips(address from, uint256 amount) external;
}

/**
 * @title Treasury
 * @notice Yield vault for Members Only NFT holders.
 *
 *  Each month: players burn 10,000 chips per share, owner deposits AVAX,
 *  shareholders claim proportional yield. Shares reset every month.
 *
 *  Must be authorized in MembersOnlyItems: items.setGameContract(treasury, true)
 */
contract Treasury is Ownable {

    IMembersOnlyForTreasury public immutable membersOnly;
    IMembersOnlyItemsForTreasury public immutable items;

    uint256 public constant CHIPS_PER_SHARE = 10_000;

    // ── Monthly state ───────────────────────────────────────────
    uint256 public currentMonth;

    mapping(uint256 => uint256) public monthlyDeposit;      // month => AVAX deposited
    mapping(uint256 => uint256) public monthlyTotalShares;  // month => total shares

    // Per-token per-month shares
    mapping(uint256 => mapping(uint256 => uint256)) public monthlyShares; // month => tokenId => shares

    // ── Claims ──────────────────────────────────────────────────
    mapping(uint256 => mapping(uint256 => bool)) public claimed; // tokenId => month => claimed

    // ── Events ──────────────────────────────────────────────────
    event SharesBurned(uint256 indexed tokenId, uint256 indexed month, uint256 numShares, uint256 chipsBurned);
    event YieldDeposited(uint256 indexed month, uint256 amount, uint256 totalShares);
    event YieldClaimed(uint256 indexed tokenId, uint256 indexed month, uint256 amount);

    constructor(address _membersOnly, address _items) Ownable(msg.sender) {
        membersOnly = IMembersOnlyForTreasury(_membersOnly);
        items = IMembersOnlyItemsForTreasury(_items);
    }

    // ─────────────────────────────────────────────────────────────
    //  Burn chips → shares for the current month
    // ─────────────────────────────────────────────────────────────

    function burnForShares(uint256 tokenId, uint256 numShares) external {
        require(msg.sender == membersOnly.ownerOf(tokenId), "Not token owner");
        require(numShares > 0, "Zero shares");
        require(monthlyDeposit[currentMonth] == 0, "Month already finalized");

        uint256 cost = numShares * CHIPS_PER_SHARE;
        items.burnChips(msg.sender, cost);

        monthlyShares[currentMonth][tokenId] += numShares;
        monthlyTotalShares[currentMonth] += numShares;

        emit SharesBurned(tokenId, currentMonth, numShares, cost);
    }

    // ─────────────────────────────────────────────────────────────
    //  Owner deposits AVAX yield, finalizes the month
    // ─────────────────────────────────────────────────────────────

    function depositYield() external payable onlyOwner {
        require(msg.value > 0, "No AVAX sent");
        require(monthlyTotalShares[currentMonth] > 0, "No shareholders");

        monthlyDeposit[currentMonth] = msg.value;

        emit YieldDeposited(currentMonth, msg.value, monthlyTotalShares[currentMonth]);
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

        uint256 playerShares = monthlyShares[month][tokenId];
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

            uint256 playerShares = monthlyShares[m][tokenId];
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

        uint256 playerShares = monthlyShares[month][tokenId];
        if (playerShares == 0) return 0;

        return (monthlyDeposit[month] * playerShares) / monthlyTotalShares[month];
    }

    function getShares(uint256 tokenId) external view returns (uint256) {
        return monthlyShares[currentMonth][tokenId];
    }

    function getTotalShares() external view returns (uint256) {
        return monthlyTotalShares[currentMonth];
    }
}
