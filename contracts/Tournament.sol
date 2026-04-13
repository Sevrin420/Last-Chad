// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMembersOnlyForTournament {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IMembersOnlyItemsForTournament {
    function burnChips(address from, uint256 amount) external;
}

/// @title Tournament — configurable tournaments for Members Only casino
///
/// Tournament flow:
///   1. Owner creates tournament with params (cost, duration, rebuy, etc.)
///   2. Players enter (chip cost deducted, tournament chips awarded)
///   3. Players play games and accumulate/lose tournament chips
///   4. Players lock their tournament chip balance as their score
///   5. Tournament ends — leaderboard is final
///
/// Entry is once per NFT unless rebuy is allowed.
/// Rebuy: re-enter, new score only replaces old if higher.
contract Tournament is Ownable, ReentrancyGuard {
    IMembersOnlyForTournament public immutable membersOnly;
    IMembersOnlyItemsForTournament public immutable items;

    struct TournamentConfig {
        string  name;
        uint256 startTime;
        uint256 endTime;
        uint256 chipCost;          // 0 = free entry
        bool    tokenGated;        // requires Members Only NFT (always true for now)
        uint256 tournamentChips;   // chips received on entry
        bool    rebuyAllowed;
        bool    active;
        uint256 entryCount;        // total entries
    }

    struct TournamentEntry {
        uint256 tournamentChips;   // current tournament chip balance
        uint256 score;             // locked score (0 = not yet locked)
        bool    entered;
        uint256 entryCount;        // times entered (for rebuy tracking)
        bool    busted;            // went to 0
    }

    uint256 public nextTournamentId = 1;
    mapping(uint256 => TournamentConfig) public tournaments;
    mapping(uint256 => mapping(uint256 => TournamentEntry)) public entries; // tournamentId => tokenId => entry
    mapping(uint256 => uint256[]) private _leaderboardTokens;              // tournamentId => tokenId array (scored)
    mapping(uint256 => mapping(uint256 => bool)) private _onLeaderboard;   // tournamentId => tokenId => on board

    // ── Events ──
    event TournamentCreated(uint256 indexed tournamentId, string name, uint256 startTime, uint256 endTime, uint256 chipCost, uint256 tournamentChips, bool rebuyAllowed);
    event TournamentCancelled(uint256 indexed tournamentId);
    event TournamentEntered(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 tournamentChips);
    event ScoreLocked(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 score);
    event ScoreUpdated(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 oldScore, uint256 newScore);
    event PlayerBusted(uint256 indexed tournamentId, uint256 indexed tokenId);
    event TournamentChipsAwarded(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 amount);
    event TournamentChipsSpent(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 amount);

    constructor(address _membersOnly, address _items) Ownable(msg.sender) {
        membersOnly = IMembersOnlyForTournament(_membersOnly);
        items = IMembersOnlyItemsForTournament(_items);
    }

    // ─────────────────────────────────────────────────────────
    // Owner Functions
    // ─────────────────────────────────────────────────────────

    function createTournament(
        string calldata name,
        uint256 startTime,
        uint256 endTime,
        uint256 chipCost,
        uint256 tournamentChips,
        bool    rebuyAllowed
    ) external onlyOwner returns (uint256 tournamentId) {
        require(bytes(name).length > 0, "Name required");
        require(endTime > startTime, "End must be after start");
        require(tournamentChips > 0, "Must award tournament chips");

        tournamentId = nextTournamentId++;
        tournaments[tournamentId] = TournamentConfig({
            name:            name,
            startTime:       startTime,
            endTime:         endTime,
            chipCost:        chipCost,
            tokenGated:      true,
            tournamentChips: tournamentChips,
            rebuyAllowed:    rebuyAllowed,
            active:          true,
            entryCount:      0
        });

        emit TournamentCreated(tournamentId, name, startTime, endTime, chipCost, tournamentChips, rebuyAllowed);
    }

    function cancelTournament(uint256 tournamentId) external onlyOwner {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        tournaments[tournamentId].active = false;
        emit TournamentCancelled(tournamentId);
    }

    /// @notice Award tournament chips to a player (for game results)
    function awardTournamentChips(uint256 tournamentId, uint256 tokenId, uint256 amount) external onlyOwner {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        TournamentEntry storage entry = entries[tournamentId][tokenId];
        require(entry.entered, "Not entered");
        require(!entry.busted, "Player busted");

        entry.tournamentChips += amount;
        emit TournamentChipsAwarded(tournamentId, tokenId, amount);
    }

    /// @notice Spend tournament chips from a player (for game results)
    function spendTournamentChips(uint256 tournamentId, uint256 tokenId, uint256 amount) external onlyOwner {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        TournamentEntry storage entry = entries[tournamentId][tokenId];
        require(entry.entered, "Not entered");
        require(entry.tournamentChips >= amount, "Insufficient tournament chips");

        entry.tournamentChips -= amount;

        if (entry.tournamentChips == 0) {
            entry.busted = true;
            emit PlayerBusted(tournamentId, tokenId);
        }

        emit TournamentChipsSpent(tournamentId, tokenId, amount);
    }

    // ─────────────────────────────────────────────────────────
    // Player Functions
    // ─────────────────────────────────────────────────────────

    function enterTournament(uint256 tournamentId, uint256 tokenId) external {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        TournamentConfig storage config = tournaments[tournamentId];
        require(config.active, "Tournament not active");
        require(block.timestamp >= config.startTime, "Tournament not started");
        require(block.timestamp < config.endTime, "Tournament ended");
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");

        TournamentEntry storage entry = entries[tournamentId][tokenId];

        if (entry.entered) {
            // Rebuy logic
            require(config.rebuyAllowed, "Rebuy not allowed");
            require(entry.busted, "Must be busted to rebuy");

            entry.busted = false;
            entry.tournamentChips = config.tournamentChips;
            entry.entryCount++;
        } else {
            // First entry
            entry.entered = true;
            entry.tournamentChips = config.tournamentChips;
            entry.entryCount = 1;
            config.entryCount++;
        }

        // Deduct chip cost if any (burns ERC-1155 chip tokens)
        if (config.chipCost > 0) {
            items.burnChips(msg.sender, config.chipCost);
        }

        emit TournamentEntered(tournamentId, tokenId, config.tournamentChips);
    }

    function lockScore(uint256 tournamentId, uint256 tokenId) external {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        TournamentConfig storage config = tournaments[tournamentId];
        require(config.active, "Tournament not active");
        require(block.timestamp < config.endTime, "Tournament ended");
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");

        TournamentEntry storage entry = entries[tournamentId][tokenId];
        require(entry.entered, "Not entered");
        require(!entry.busted, "Player busted");
        require(entry.tournamentChips > 0, "No chips to lock");

        uint256 newScore = entry.tournamentChips;
        uint256 oldScore = entry.score;

        // If rebuy: new score only replaces old if higher
        if (oldScore > 0) {
            require(newScore > oldScore, "New score must be higher than previous");
            entry.score = newScore;
            emit ScoreUpdated(tournamentId, tokenId, oldScore, newScore);
        } else {
            entry.score = newScore;
            // Add to leaderboard tracking
            if (!_onLeaderboard[tournamentId][tokenId]) {
                _leaderboardTokens[tournamentId].push(tokenId);
                _onLeaderboard[tournamentId][tokenId] = true;
            }
            emit ScoreLocked(tournamentId, tokenId, newScore);
        }

        // Lock means chips are committed — set to 0
        entry.tournamentChips = 0;
        entry.busted = true; // Can rebuy if allowed
    }

    // ─────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────

    function getTournament(uint256 tournamentId) external view returns (
        string memory name,
        uint256 startTime,
        uint256 endTime,
        uint256 chipCost,
        uint256 tournamentChips,
        bool    rebuyAllowed,
        bool    active,
        uint256 entryCount
    ) {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        TournamentConfig storage c = tournaments[tournamentId];
        return (c.name, c.startTime, c.endTime, c.chipCost, c.tournamentChips, c.rebuyAllowed, c.active, c.entryCount);
    }

    function getEntry(uint256 tournamentId, uint256 tokenId) external view returns (
        uint256 tournamentChips,
        uint256 score,
        bool    entered,
        uint256 entryCount,
        bool    busted
    ) {
        TournamentEntry storage e = entries[tournamentId][tokenId];
        return (e.tournamentChips, e.score, e.entered, e.entryCount, e.busted);
    }

    function getLeaderboardCount(uint256 tournamentId) external view returns (uint256) {
        return _leaderboardTokens[tournamentId].length;
    }

    function getLeaderboard(uint256 tournamentId, uint256 offset, uint256 limit) external view returns (
        uint256[] memory tokenIds,
        uint256[] memory scores
    ) {
        uint256[] storage tokens = _leaderboardTokens[tournamentId];
        uint256 total = tokens.length;

        if (offset >= total) {
            return (new uint256[](0), new uint256[](0));
        }

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;

        tokenIds = new uint256[](count);
        scores = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            uint256 tid = tokens[offset + i];
            tokenIds[i] = tid;
            scores[i] = entries[tournamentId][tid].score;
        }
    }

    function isTournamentActive(uint256 tournamentId) external view returns (bool) {
        if (!_tournamentExists(tournamentId)) return false;
        TournamentConfig storage c = tournaments[tournamentId];
        return c.active && block.timestamp >= c.startTime && block.timestamp < c.endTime;
    }

    function _tournamentExists(uint256 tournamentId) internal view returns (bool) {
        return tournamentId > 0 && tournamentId < nextTournamentId;
    }

    /// @notice Accept AVAX deposits for prize pools
    receive() external payable {}

    /// @notice Distribute AVAX prize to specific winners (owner decides)
    function distributePrize(address[] calldata winners, uint256[] calldata amounts) external onlyOwner nonReentrant {
        require(winners.length == amounts.length, "Array length mismatch");
        for (uint256 i = 0; i < winners.length; i++) {
            (bool sent, ) = payable(winners[i]).call{value: amounts[i]}("");
            require(sent, "Transfer failed");
        }
    }

    function withdraw() external onlyOwner {
        (bool success, ) = payable(owner()).call{value: address(this).balance}("");
        require(success, "Withdrawal failed");
    }
}
