// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IItemsBurn {
    function burnTournamentChips(address from, uint256 amount) external;
}

interface IMembersView {
    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenName(uint256 tokenId) external view returns (string memory);
}

/**
 * @title TournamentLeaderboard
 * @dev The Club Nile tournament leaderboard + monthly yield distribution.
 *
 *      Players BURN tournament tokens (MembersOnlyItems id 1, free/no cash
 *      value) to take and hold a spot on the current month's leaderboard. Each
 *      burn is permanent; the board records the NFT's name and its cumulative
 *      burned amount for the epoch. A minimum of {MIN_BURN} tokens is required
 *      to first appear; players may burn again any time to increase their
 *      standing.
 *
 *      Monthly cycle (owner-driven epochs):
 *        • Burns during epoch E accumulate in burnedOf[E][tokenId].
 *        • The owner tops up epoch E's AVAX pool with the month's yield via
 *          fundYield().
 *        • closeEpoch() freezes epoch E for claims and opens epoch E+1 fresh
 *          (the board resets — a new month, new burns).
 *        • Each entrant then pulls their PRO-RATA share of the pool:
 *              share = pool[E] * burnedOf[E][tokenId] / totalBurned[E]
 *          paid to the token's CURRENT owner. Burn twice as much → earn twice
 *          the slice. No ranking is submitted on-chain; "position" is purely
 *          the visual ordering of burned amounts.
 *
 *      Pull-based claims keep settlement gas-safe and trustless regardless of
 *      how many players enter. Funded pools are shielded from owner withdrawal.
 *
 *      Wiring: deploy with (items, members); authorize this contract to burn
 *      tokens via MembersOnlyItems.setGameContract(thisLeaderboard, true).
 */
contract TournamentLeaderboard is Ownable, ReentrancyGuard {
    IItemsBurn   public items;    // MembersOnlyItems (must authorize this contract)
    IMembersView public members;  // MembersOnly (ownerOf + tokenName)

    /// @notice Minimum tournament tokens to first appear on the board.
    uint256 public constant MIN_BURN = 2000;

    /// @notice Current open epoch (the month accepting burns). Starts at 0.
    uint256 public epoch;

    // epoch => tokenId => cumulative tokens burned this epoch
    mapping(uint256 => mapping(uint256 => uint256)) public burnedOf;
    // epoch => sum of all tokens burned this epoch
    mapping(uint256 => uint256) public totalBurned;
    // epoch => tokenIds that have appeared on the board (for enumeration)
    mapping(uint256 => uint256[]) private _participants;
    // epoch => tokenId => already listed in _participants
    mapping(uint256 => mapping(uint256 => bool)) public onBoard;

    // epoch => AVAX yield pool
    mapping(uint256 => uint256) public pool;
    // epoch => frozen for claims (set by closeEpoch)
    mapping(uint256 => bool) public closed;
    // epoch => tokenId => claimed its share
    mapping(uint256 => mapping(uint256 => bool)) public claimed;

    /// @notice AVAX reserved for pools (funded, not yet claimed). Shielded from withdraw.
    uint256 public totalPooled;

    event Burned(uint256 indexed epoch, uint256 indexed tokenId, string name, uint256 amount, uint256 cumulative);
    event YieldFunded(uint256 indexed epoch, uint256 amount, uint256 pool);
    event EpochClosed(uint256 indexed epoch, uint256 pool, uint256 totalBurned, uint256 nextEpoch);
    event Claimed(uint256 indexed epoch, uint256 indexed tokenId, address indexed to, uint256 amount);
    event ItemsSet(address indexed items);
    event MembersSet(address indexed members);

    constructor(address _items, address _members) Ownable(msg.sender) {
        require(_items != address(0) && _members != address(0), "zero addr");
        items   = IItemsBurn(_items);
        members = IMembersView(_members);
    }

    // ─────────────────────────────────────────────
    //  Owner config
    // ─────────────────────────────────────────────

    function setItems(address _items) external onlyOwner {
        require(_items != address(0), "zero");
        items = IItemsBurn(_items);
        emit ItemsSet(_items);
    }

    function setMembers(address _members) external onlyOwner {
        require(_members != address(0), "zero");
        members = IMembersView(_members);
        emit MembersSet(_members);
    }

    // ─────────────────────────────────────────────
    //  Burn to take / hold a leaderboard spot
    // ─────────────────────────────────────────────

    /// @notice Burn `amount` tournament tokens to enter or climb this month's
    ///         board. First entry must be >= MIN_BURN; top-ups can be any
    ///         positive amount. Reverts if the caller lacks the tokens.
    function burnForLeaderboard(uint256 tokenId, uint256 amount) external nonReentrant {
        require(members.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(amount > 0, "amount zero");

        uint256 e = epoch;
        uint256 prior = burnedOf[e][tokenId];
        if (prior == 0) {
            require(amount >= MIN_BURN, "min 2000 to enter");
        }

        items.burnTournamentChips(msg.sender, amount); // reverts if balance too low

        uint256 cumulative = prior + amount;
        burnedOf[e][tokenId] = cumulative;
        totalBurned[e] += amount;
        if (!onBoard[e][tokenId]) {
            onBoard[e][tokenId] = true;
            _participants[e].push(tokenId);
        }
        emit Burned(e, tokenId, members.tokenName(tokenId), amount, cumulative);
    }

    // ─────────────────────────────────────────────
    //  Monthly yield: fund → close → claim
    // ─────────────────────────────────────────────

    /// @notice Top up the CURRENT (open) epoch's AVAX yield pool.
    function fundYield() external payable {
        require(msg.value > 0, "no value");
        pool[epoch] += msg.value;
        totalPooled += msg.value;
        emit YieldFunded(epoch, msg.value, pool[epoch]);
    }

    /// @notice Freeze the current epoch for claims and open the next one fresh.
    ///         The board resets automatically (new epoch key → zero burns).
    function closeEpoch() external onlyOwner {
        uint256 e = epoch;
        closed[e] = true;
        epoch = e + 1;
        emit EpochClosed(e, pool[e], totalBurned[e], epoch);
    }

    /// @notice Claim a token's pro-rata share of a closed epoch's pool. Pays the
    ///         token's current owner. Anyone may trigger it; funds go to the owner.
    function claim(uint256 e, uint256 tokenId) public nonReentrant returns (uint256 share) {
        require(closed[e], "epoch not closed");
        require(!claimed[e][tokenId], "already claimed");
        uint256 burned = burnedOf[e][tokenId];
        require(burned > 0, "nothing burned");

        uint256 total = totalBurned[e];
        share = (pool[e] * burned) / total;
        claimed[e][tokenId] = true;

        if (share > 0) {
            totalPooled -= share;
            address to = members.ownerOf(tokenId);
            (bool ok, ) = payable(to).call{value: share}("");
            require(ok, "transfer failed");
            emit Claimed(e, tokenId, to, share);
        } else {
            emit Claimed(e, tokenId, members.ownerOf(tokenId), 0);
        }
    }

    /// @notice Claim several tokens' shares from one closed epoch in a single tx.
    function claimMany(uint256 e, uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            claim(e, tokenIds[i]);
        }
    }

    // ─────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────

    function participantCount(uint256 e) external view returns (uint256) {
        return _participants[e].length;
    }

    /// @notice Paginated board for an epoch. Amounts are cumulative burns; the
    ///         client sorts by amount to display "position".
    function leaderboard(uint256 e, uint256 offset, uint256 limit)
        external view
        returns (uint256[] memory ids, string[] memory names, uint256[] memory amounts)
    {
        uint256 n = _participants[e].length;
        if (offset >= n) return (new uint256[](0), new string[](0), new uint256[](0));
        uint256 end = offset + limit;
        if (end > n) end = n;
        uint256 len = end - offset;
        ids = new uint256[](len);
        names = new string[](len);
        amounts = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            uint256 id = _participants[e][offset + i];
            ids[i] = id;
            names[i] = members.tokenName(id);
            amounts[i] = burnedOf[e][id];
        }
    }

    /// @notice What a token could claim from a closed epoch right now (0 if open,
    ///         already claimed, or nothing burned).
    function pendingShare(uint256 e, uint256 tokenId) external view returns (uint256) {
        if (!closed[e] || claimed[e][tokenId]) return 0;
        uint256 total = totalBurned[e];
        if (total == 0) return 0;
        return (pool[e] * burnedOf[e][tokenId]) / total;
    }

    // ─────────────────────────────────────────────
    //  Surplus withdrawal (never touches funded pools)
    // ─────────────────────────────────────────────

    /// @notice Withdraw only AVAX above the reserved pools (e.g. stray sends or
    ///         rounding dust from prior settlements).
    function withdrawSurplus(address to) external onlyOwner nonReentrant {
        require(to != address(0), "zero");
        uint256 surplus = address(this).balance - totalPooled;
        require(surplus > 0, "no surplus");
        (bool ok, ) = payable(to).call{value: surplus}("");
        require(ok, "transfer failed");
    }

    /// @dev Reject raw sends so pool accounting can't be bypassed; use fundYield.
    receive() external payable {
        revert("use fundYield");
    }
}
