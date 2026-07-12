// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMembersOnlyForTournament {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IMembersOnlyItemsForTournament {
    function burnTournamentChips(address from, uint256 amount) external;
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

    // ── Yield / prize distribution (owner-configurable) ──
    // Fund a per-tournament AVAX pool (e.g. with the week's yield). Configure
    // the minimum chips a player must lock to be eligible, and the payout split
    // by rank (1st / 2nd / 3rd …). Then settle: the top locked scores get paid.
    mapping(uint256 => uint256)   public prizePool;          // tournamentId => AVAX pool
    mapping(uint256 => uint256)   public minLockToQualify;   // tournamentId => min locked score to win
    mapping(uint256 => uint256[]) private _prizeWeightsBps;  // tournamentId => bps per rank [1st,2nd,…]
    mapping(uint256 => bool)      public settled;            // tournamentId => already paid out
    uint256 public totalPooled;                              // sum of all prizePool (shielded from withdraw)

    // ── Events ──
    event TournamentCreated(uint256 indexed tournamentId, string name, uint256 startTime, uint256 endTime, uint256 chipCost, uint256 tournamentChips, bool rebuyAllowed);
    event TournamentCancelled(uint256 indexed tournamentId);
    event TournamentEntered(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 tournamentChips);
    event ScoreLocked(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 score);
    event ScoreUpdated(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 oldScore, uint256 newScore);
    event PlayerBusted(uint256 indexed tournamentId, uint256 indexed tokenId);
    event TournamentChipsAwarded(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 amount);
    event TournamentChipsSpent(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 amount);
    event PrizePoolFunded(uint256 indexed tournamentId, uint256 amount, uint256 pool);
    event MinLockSet(uint256 indexed tournamentId, uint256 minLock);
    event PrizeWeightsSet(uint256 indexed tournamentId, uint256[] weightsBps);
    event PrizePaid(uint256 indexed tournamentId, uint256 indexed tokenId, uint256 rank, uint256 amount);
    event TournamentSettled(uint256 indexed tournamentId, uint256 pool, uint256 paid);

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

        // Deduct entry cost if any (burns TOURNAMENT chips — token ID 1)
        if (config.chipCost > 0) {
            items.burnTournamentChips(msg.sender, config.chipCost);
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

    // ─────────────────────────────────────────────────────────
    // Yield / Prize Distribution (rank-based, owner-configurable)
    // ─────────────────────────────────────────────────────────

    /// @notice Fund a tournament's AVAX prize pool (e.g. with the week's yield).
    ///         Anyone can top it up; the AVAX is shielded from `withdraw`.
    function fundPrizePool(uint256 tournamentId) external payable {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        require(msg.value > 0, "Nothing sent");
        prizePool[tournamentId] += msg.value;
        totalPooled += msg.value;
        emit PrizePoolFunded(tournamentId, msg.value, prizePool[tournamentId]);
    }

    /// @notice Minimum chips a player must LOCK to be eligible for a prize.
    function setMinLockToQualify(uint256 tournamentId, uint256 minLock) external onlyOwner {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        minLockToQualify[tournamentId] = minLock;
        emit MinLockSet(tournamentId, minLock);
    }

    /// @notice Payout split by finishing rank, in basis points of the pool:
    ///         weightsBps[0] = 1st place, [1] = 2nd, [2] = 3rd, … Sum ≤ 10000.
    ///         e.g. [10000] = winner-take-all; [6000,3000,1000] = 60/30/10.
    function setPrizeWeights(uint256 tournamentId, uint256[] calldata weightsBps) external onlyOwner {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        uint256 sum;
        for (uint256 i = 0; i < weightsBps.length; i++) sum += weightsBps[i];
        require(sum <= 10000, "Weights exceed 100%");
        _prizeWeightsBps[tournamentId] = weightsBps;
        emit PrizeWeightsSet(tournamentId, weightsBps);
    }

    function getPrizeWeights(uint256 tournamentId) external view returns (uint256[] memory) {
        return _prizeWeightsBps[tournamentId];
    }

    /// @notice Settle: pay the prize pool to the highest locked scores.
    ///         `rankedTokenIds` are the entrants ordered by locked score, highest
    ///         first (owner/oracle reads the leaderboard off-chain and passes the
    ///         order). The contract verifies the order is non-increasing and that
    ///         each paid rank meets `minLockToQualify`, then pays
    ///         `pool * weightsBps[rank] / 10000` to each token's current owner.
    ///         Winner-take-all ([10000]) makes "lock the most → gets the yield".
    function settleTournament(uint256 tournamentId, uint256[] calldata rankedTokenIds)
        external onlyOwner nonReentrant
    {
        require(_tournamentExists(tournamentId), "Tournament does not exist");
        require(!settled[tournamentId], "Already settled");
        uint256 pool = prizePool[tournamentId];
        require(pool > 0, "No prize pool");
        uint256[] storage weights = _prizeWeightsBps[tournamentId];
        require(weights.length > 0, "No prize weights set");

        settled[tournamentId] = true;
        prizePool[tournamentId] = 0;
        totalPooled -= pool;

        uint256 prevScore = type(uint256).max;
        uint256 paid;
        uint256 n = rankedTokenIds.length < weights.length ? rankedTokenIds.length : weights.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 tokenId = rankedTokenIds[i];
            uint256 score = entries[tournamentId][tokenId].score;
            require(score > 0, "Rank not locked");
            require(score <= prevScore, "Ranking not descending");
            prevScore = score;

            if (score < minLockToQualify[tournamentId]) continue; // below threshold → no prize
            uint256 amount = (pool * weights[i]) / 10000;
            if (amount == 0) continue;

            paid += amount;
            (bool ok, ) = payable(membersOnly.ownerOf(tokenId)).call{value: amount}("");
            require(ok, "Prize transfer failed");
            emit PrizePaid(tournamentId, tokenId, i, amount);
        }

        emit TournamentSettled(tournamentId, pool, paid);
    }

    /// @notice Accept plain AVAX (un-pooled surplus; use fundPrizePool to earmark)
    receive() external payable {}

    /// @notice Distribute AVAX prize to specific winners (owner decides, manual)
    function distributePrize(address[] calldata winners, uint256[] calldata amounts) external onlyOwner nonReentrant {
        require(winners.length == amounts.length, "Array length mismatch");
        for (uint256 i = 0; i < winners.length; i++) {
            (bool sent, ) = payable(winners[i]).call{value: amounts[i]}("");
            require(sent, "Transfer failed");
        }
    }

    /// @notice Withdraw surplus AVAX — never touches funded prize pools.
    function withdraw() external onlyOwner {
        uint256 amount = address(this).balance - totalPooled;
        require(amount > 0, "Nothing to withdraw");
        (bool success, ) = payable(owner()).call{value: amount}("");
        require(success, "Withdrawal failed");
    }
}
