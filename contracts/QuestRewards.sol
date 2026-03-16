// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function awardCells(uint256 tokenId, uint256 amount) external;
    function spendCells(uint256 tokenId, uint256 amount) external;
    function eliminated(uint256 tokenId) external view returns (bool);
    function isActive(uint256 tokenId) external view returns (bool);
    function setActive(uint256 tokenId, bool active) external;
    function eliminate(uint256 tokenId) external;
}

interface ILastChadItems {
    function mintTo(address to, uint256 itemId, uint256 quantity) external;
}

contract QuestRewards {
    ILastChad      public immutable lastChad;
    ILastChadItems public lastChadItems;
    address        public immutable gameOwner;
    address        public oracle; // Cloudflare Worker signing key

    uint256 public constant SESSION_DURATION = 1 hours;
    uint256 public questCooldown = 30 days; // configurable cooldown between same quest attempts

    // ── Quest Session ──
    struct QuestSession {
        bytes32 seed;
        uint8   questId;
        uint40  startTime;
        bool    active;
        address player;  // original quest starter
    }

    // Per-quest config — cells and item minted automatically on completion
    struct QuestConfig {
        uint16 cellReward; // bonus cells awarded on completion (0 = none)
        uint16 itemReward; // item ID minted on completion (0 = none)
    }

    // ── Arcade Session ──
    struct ArcadeSession {
        bytes32 seed;       // server-generated seed for obstacle patterns
        uint8   gameType;   // 0=runner, 1=topshooter, 2=area51
        uint40  startTime;
        bool    active;
        address player;
    }

    // ── Death Rate Limiter ──
    uint256 public deathCount;
    uint256 public deathWindowStart;
    uint256 public constant MAX_DEATHS_PER_WINDOW = 10;
    uint256 public constant DEATH_WINDOW = 60; // seconds
    bool    public deathsPaused;

    // ── State ──
    mapping(uint256 => QuestSession)                      public pendingSessions;
    mapping(uint256 => mapping(uint8 => uint256))         public lastQuestTime; // cooldown-based (replaces one-attempt-ever)
    mapping(uint256 => mapping(uint8 => bool))            public questCompleted; // tracks if ever completed (for rewards)
    mapping(uint256 => uint256)                           public itemPrices;     // in-quest shop
    mapping(uint8   => QuestConfig)                       internal _questConfig;
    mapping(uint256 => ArcadeSession)                     public arcadeSessions;

    // ── Events ──
    event QuestStarted(uint256 indexed tokenId, uint8 questId, bytes32 seed, uint256 expiresAt);
    event QuestCompleted(uint256 indexed tokenId, uint8 questId, uint256 cellsAwarded, uint256 itemAwarded);
    event QuestFailed(uint256 indexed tokenId, uint8 questId);
    event CellsAwarded(uint256 indexed tokenId, address indexed player, uint256 amount);
    event ItemAwarded(uint256 indexed tokenId, address indexed player, uint256 itemId);
    event ItemPurchased(uint256 indexed tokenId, uint256 indexed itemId, address indexed buyer, uint256 cellCost);
    event ItemPriceSet(uint256 indexed itemId, uint256 cellCost);
    event QuestConfigSet(uint8 indexed questId, uint16 cellReward, uint16 itemReward);
    event ArcadeStarted(uint256 indexed tokenId, uint8 gameType, bytes32 seed);
    event ArcadeSurvived(uint256 indexed tokenId, uint8 gameType);
    event ArcadeDeath(uint256 indexed tokenId, uint8 gameType);

    // ── Constructor ──
    constructor(address lastChadAddress) {
        lastChad  = ILastChad(lastChadAddress);
        gameOwner = msg.sender;
    }

    modifier onlyGameOwner() {
        require(msg.sender == gameOwner, "Not game owner");
        _;
    }

    // ── Admin setters ──
    function setLastChadItems(address itemsAddress) external onlyGameOwner {
        lastChadItems = ILastChadItems(itemsAddress);
    }

    function setOracle(address _oracle) external onlyGameOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
    }

    function setQuestCooldown(uint256 cooldown) external onlyGameOwner {
        questCooldown = cooldown;
    }

    function setQuestConfig(
        uint8  questId,
        uint16 cellReward,
        uint16 itemReward
    ) external onlyGameOwner {
        _questConfig[questId] = QuestConfig(cellReward, itemReward);
        emit QuestConfigSet(questId, cellReward, itemReward);
    }

    // ─────────────────────────────────────────────────────────
    // startQuest — sets isActive flag, no NFT transfer
    // ─────────────────────────────────────────────────────────
    function startQuest(uint256 tokenId, uint8 questId) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!lastChad.eliminated(tokenId), "Chad eliminated");
        require(!lastChad.isActive(tokenId), "Token already active");

        // Cooldown check (replaces one-attempt-ever)
        require(
            block.timestamp >= lastQuestTime[tokenId][questId] + questCooldown,
            "Quest on cooldown"
        );

        bytes32 seed = keccak256(abi.encodePacked(
            tokenId, questId, block.prevrandao, block.timestamp, msg.sender
        ));

        lastQuestTime[tokenId][questId] = block.timestamp;
        lastChad.setActive(tokenId, true);

        pendingSessions[tokenId] = QuestSession({
            seed:      seed,
            questId:   questId,
            startTime: uint40(block.timestamp),
            active:    true,
            player:    msg.sender
        });

        emit QuestStarted(tokenId, questId, seed, block.timestamp + SESSION_DURATION);
    }

    // ─────────────────────────────────────────────────────────
    // completeQuest — oracle-signed cell reward, clears isActive
    // ─────────────────────────────────────────────────────────
    function completeQuest(
        uint256 tokenId,
        uint8   questId,
        uint256 cellReward,
        bytes calldata oracleSig
    ) external {
        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(session.questId == questId, "Wrong quest");
        require(msg.sender == session.player, "Not quest participant");
        require(block.timestamp <= uint256(session.startTime) + SESSION_DURATION, "Session expired");

        // Oracle signature verification
        if (oracle != address(0)) {
            bytes32 message = keccak256(abi.encodePacked(tokenId, questId, session.player, cellReward));
            bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(message);
            address signer  = ECDSA.recover(ethHash, oracleSig);
            require(signer == oracle, "Invalid oracle signature");
        }

        // Settle state
        questCompleted[tokenId][questId] = true;
        delete pendingSessions[tokenId];
        lastChad.setActive(tokenId, false);

        // Award cells from oracle-signed amount
        uint256 totalCellsAwarded = cellReward;
        if (cellReward > 0) {
            lastChad.awardCells(tokenId, cellReward);
        }

        // Award bonus cells from quest config
        QuestConfig memory qc = _questConfig[questId];
        if (qc.cellReward > 0) {
            totalCellsAwarded += uint256(qc.cellReward);
            lastChad.awardCells(tokenId, uint256(qc.cellReward));
        }

        // Award item from quest config
        uint256 itemAwarded = 0;
        if (qc.itemReward > 0 && address(lastChadItems) != address(0)) {
            itemAwarded = uint256(qc.itemReward);
            lastChadItems.mintTo(session.player, itemAwarded, 1);
        }

        emit QuestCompleted(tokenId, questId, totalCellsAwarded, itemAwarded);
    }

    // ─────────────────────────────────────────────────────────
    // failQuest — clears isActive, no death, no rewards
    // ─────────────────────────────────────────────────────────
    function failQuest(uint256 tokenId, uint8 questId) external onlyGameOwner {
        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(session.questId == questId, "Wrong quest");

        delete pendingSessions[tokenId];
        lastChad.setActive(tokenId, false);

        emit QuestFailed(tokenId, questId);
    }

    // ─────────────────────────────────────────────────────────
    // Mid-quest awards — game owner only
    // ─────────────────────────────────────────────────────────
    function awardCells(uint256 tokenId, uint256 amount) external onlyGameOwner {
        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        lastChad.awardCells(tokenId, amount);
        emit CellsAwarded(tokenId, session.player, amount);
    }

    function awardItem(uint256 tokenId, uint256 itemId) external onlyGameOwner {
        require(address(lastChadItems) != address(0), "Items contract not set");
        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        lastChadItems.mintTo(session.player, itemId, 1);
        emit ItemAwarded(tokenId, session.player, itemId);
    }

    // ─────────────────────────────────────────────────────────
    // purchaseItem — player spends cells in-quest shop
    // ─────────────────────────────────────────────────────────
    function purchaseItem(uint256 tokenId, uint256 itemId) external {
        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(session.player == msg.sender, "Not quest participant");
        require(block.timestamp <= uint256(session.startTime) + SESSION_DURATION, "Session expired");
        require(address(lastChadItems) != address(0), "Items contract not set");
        uint256 cost = itemPrices[itemId];
        require(cost > 0, "Item not in shop");

        lastChad.spendCells(tokenId, cost);
        lastChadItems.mintTo(msg.sender, itemId, 1);
        emit ItemPurchased(tokenId, itemId, msg.sender, cost);
    }

    function setItemPrice(uint256 itemId, uint256 cellCost) external onlyGameOwner {
        itemPrices[itemId] = cellCost;
        emit ItemPriceSet(itemId, cellCost);
    }

    // ─────────────────────────────────────────────────────────
    // Arcade Sessions — server-managed minigames
    // ─────────────────────────────────────────────────────────
    function startArcade(uint256 tokenId, uint8 gameType, bytes32 seed) external onlyGameOwner {
        require(lastChad.ownerOf(tokenId) != address(0), "Token does not exist");
        require(!lastChad.eliminated(tokenId), "Chad eliminated");
        require(!lastChad.isActive(tokenId), "Token already active");

        lastChad.setActive(tokenId, true);

        arcadeSessions[tokenId] = ArcadeSession({
            seed:      seed,
            gameType:  gameType,
            startTime: uint40(block.timestamp),
            active:    true,
            player:    lastChad.ownerOf(tokenId)
        });

        emit ArcadeStarted(tokenId, gameType, seed);
    }

    function confirmSurvival(uint256 tokenId) external onlyGameOwner {
        ArcadeSession memory session = arcadeSessions[tokenId];
        require(session.active, "No active arcade session");

        delete arcadeSessions[tokenId];
        lastChad.setActive(tokenId, false);

        emit ArcadeSurvived(tokenId, session.gameType);
    }

    function confirmDeath(uint256 tokenId) external onlyGameOwner {
        ArcadeSession memory session = arcadeSessions[tokenId];
        require(session.active, "No active arcade session");
        require(!deathsPaused, "Deaths paused");

        // Death rate limiter
        if (block.timestamp > deathWindowStart + DEATH_WINDOW) {
            deathCount = 0;
            deathWindowStart = block.timestamp;
        }
        deathCount++;
        require(deathCount <= MAX_DEATHS_PER_WINDOW, "Too many deaths - auto-paused");

        delete arcadeSessions[tokenId];
        lastChad.setActive(tokenId, false);
        lastChad.eliminate(tokenId);

        emit ArcadeDeath(tokenId, session.gameType);
    }

    function unpauseDeaths() external onlyGameOwner {
        deathsPaused = false;
    }

    function pauseDeaths() external onlyGameOwner {
        deathsPaused = true;
    }

    // ─────────────────────────────────────────────────────────
    // Emergency release — clears isActive if session is stuck
    // ─────────────────────────────────────────────────────────
    function releaseQuest(uint256 tokenId) external onlyGameOwner {
        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        delete pendingSessions[tokenId];
        lastChad.setActive(tokenId, false);
    }

    function releaseArcade(uint256 tokenId) external onlyGameOwner {
        ArcadeSession memory session = arcadeSessions[tokenId];
        require(session.active, "No active arcade session");
        delete arcadeSessions[tokenId];
        lastChad.setActive(tokenId, false);
    }

    // ─────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────
    function getSession(uint256 tokenId) external view returns (
        bytes32 seed, uint8 questId, uint256 startTime, uint256 expiresAt, bool active
    ) {
        QuestSession memory s = pendingSessions[tokenId];
        return (s.seed, s.questId, s.startTime, uint256(s.startTime) + SESSION_DURATION, s.active);
    }

    function getArcadeSession(uint256 tokenId) external view returns (
        bytes32 seed, uint8 gameType, uint256 startTime, bool active
    ) {
        ArcadeSession memory s = arcadeSessions[tokenId];
        return (s.seed, s.gameType, s.startTime, s.active);
    }

    function isSessionExpired(uint256 tokenId) external view returns (bool) {
        QuestSession memory s = pendingSessions[tokenId];
        if (!s.active) return false;
        return block.timestamp > uint256(s.startTime) + SESSION_DURATION;
    }

    function getQuestConfig(uint8 questId) external view returns (uint16 cellReward, uint16 itemReward) {
        QuestConfig memory qc = _questConfig[questId];
        return (qc.cellReward, qc.itemReward);
    }
}
