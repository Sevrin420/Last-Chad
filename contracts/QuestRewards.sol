// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function awardExperience(uint256 tokenId, uint256 amount) external;
    function awardCells(uint256 tokenId, uint256 amount) external;
    function spendCells(uint256 tokenId, uint256 amount) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function getStats(uint256 tokenId) external view returns (
        uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma, bool assigned
    );
}

interface ILastChadItems {
    function mintTo(address to, uint256 itemId, uint256 quantity) external;
}

contract QuestRewards {
    ILastChad      public immutable lastChad;
    ILastChadItems public lastChadItems;
    address        public immutable gameOwner;

    uint256 public constant SESSION_DURATION = 1 hours;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    struct QuestSession {
        bytes32 seed;      // keccak256(tokenId, questId, prevrandao, timestamp, sender)
        uint8   questId;
        uint40  startTime;
        bool    active;
    }

    // Per-quest reward config — set once by game owner, applied automatically on completeQuest
    struct QuestConfig {
        uint8  choice1A;    // XP bonus when choice1 = 0
        uint8  choice1B;    // XP bonus when choice1 = 1
        uint8  choice2A;    // XP bonus when choice2 = 0
        uint8  choice2B;    // XP bonus when choice2 = 1
        uint16 cellReward;  // cells awarded on completion (0 = none)
        uint16 itemReward;  // item ID minted on completion (0 = none)
    }

    mapping(uint256 => QuestSession) public pendingSessions;
    mapping(uint256 => mapping(uint8 => bool)) public questStarted;
    mapping(uint256 => mapping(uint8 => bool)) public questCompleted;

    // tokenId => original owner (set while NFT is in escrow)
    mapping(uint256 => address) public lockedBy;

    // itemId => cell cost for the in-quest shop (0 = not for sale)
    mapping(uint256 => uint256) public itemPrices;

    // questId => reward config
    mapping(uint8 => QuestConfig) internal _questConfig;

    // Locked token enumeration — required for burnAllLocked()
    uint256[] private _lockedTokenIds;
    mapping(uint256 => uint256) private _lockedIndex; // tokenId => 1-based position in array

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    event QuestStarted(uint256 indexed tokenId, uint8 questId, bytes32 seed, uint256 expiresAt);
    event QuestCompleted(uint256 indexed tokenId, uint8 questId, uint256 xpAwarded, uint256 cellsAwarded, uint256 itemAwarded);
    event NFTBurned(uint256 indexed tokenId, address indexed originalOwner);
    event NFTReleased(uint256 indexed tokenId, address indexed returnedTo);

    // Mid-quest awards (called by game owner for dynamic events)
    event CellsAwarded(uint256 indexed tokenId, address indexed player, uint256 amount);
    event ItemAwarded(uint256 indexed tokenId, address indexed player, uint256 itemId);

    // Player-initiated shop purchase
    event ItemPurchased(uint256 indexed tokenId, uint256 indexed itemId, address indexed buyer, uint256 cellCost);

    event ItemPriceSet(uint256 indexed itemId, uint256 cellCost);
    event QuestConfigSet(uint8 indexed questId, uint8 c1a, uint8 c1b, uint8 c2a, uint8 c2b, uint16 cellReward, uint16 itemReward);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(address lastChadAddress) {
        lastChad  = ILastChad(lastChadAddress);
        gameOwner = msg.sender;
    }

    modifier onlyGameOwner() {
        require(msg.sender == gameOwner, "Not game owner");
        _;
    }

    // -------------------------------------------------------------------------
    // setLastChadItems
    // -------------------------------------------------------------------------
    function setLastChadItems(address itemsAddress) external onlyGameOwner {
        lastChadItems = ILastChadItems(itemsAddress);
    }

    // -------------------------------------------------------------------------
    // setQuestConfig — defines XP choice bonuses + automatic end-of-quest rewards
    // cellReward: cells minted to player on completion (0 = none)
    // itemReward: item ID minted to player on completion (0 = none)
    // -------------------------------------------------------------------------
    function setQuestConfig(
        uint8  questId,
        uint8  c1a, uint8 c1b,
        uint8  c2a, uint8 c2b,
        uint16 cellReward,
        uint16 itemReward
    ) external onlyGameOwner {
        _questConfig[questId] = QuestConfig(c1a, c1b, c2a, c2b, cellReward, itemReward);
        emit QuestConfigSet(questId, c1a, c1b, c2a, c2b, cellReward, itemReward);
    }

    // -------------------------------------------------------------------------
    // startQuest — player locks NFT into escrow; seed generated immediately
    // -------------------------------------------------------------------------
    function startQuest(uint256 tokenId, uint8 questId) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!questStarted[tokenId][questId], "Quest already attempted");

        bytes32 seed = keccak256(abi.encodePacked(
            tokenId, questId, block.prevrandao, block.timestamp, msg.sender
        ));

        questStarted[tokenId][questId] = true;
        lockedBy[tokenId] = msg.sender;
        lastChad.transferFrom(msg.sender, address(this), tokenId);
        _addLocked(tokenId);

        pendingSessions[tokenId] = QuestSession({
            seed:      seed,
            questId:   questId,
            startTime: uint40(block.timestamp),
            active:    true
        });

        emit QuestStarted(tokenId, questId, seed, block.timestamp + SESSION_DURATION);
    }

    // -------------------------------------------------------------------------
    // completeQuest — player submits choices + kept-dice bitmasks.
    //                 XP, cells, and item rewards are all computed/awarded
    //                 automatically from on-chain config. No server required.
    //
    // choice1, choice2 : narrative choices (0 or 1), mapped to XP via QuestConfig
    // kept1            : 5-bit bitmask of dice kept after roll 1
    // kept2            : 5-bit bitmask of dice kept after roll 2 (superset of kept1)
    // -------------------------------------------------------------------------
    function completeQuest(
        uint256 tokenId,
        uint8   questId,
        uint8   choice1,
        uint8   choice2,
        uint8   kept1,
        uint8   kept2
    ) external {
        address player = lockedBy[tokenId];
        require(player != address(0), "Token not locked");
        require(msg.sender == player, "Not token owner");

        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(session.questId == questId, "Wrong quest");
        require(
            block.timestamp <= uint256(session.startTime) + SESSION_DURATION,
            "Session expired"
        );
        require(!questCompleted[tokenId][questId], "Already completed");

        require(choice1 <= 1, "Invalid choice1");
        require(choice2 <= 1, "Invalid choice2");
        require(kept1 < 32,   "Invalid kept1");
        require(kept2 < 32,   "Invalid kept2");
        require((kept1 & kept2) == kept1, "kept2 must include all of kept1");

        // On-chain dice scoring
        uint8 cargo = _calculateCargo(session.seed, kept1, kept2);

        // XP from choices + dice + dex
        QuestConfig memory qc = _questConfig[questId];
        uint256 c1Bonus  = choice1 == 0 ? uint256(qc.choice1A) : uint256(qc.choice1B);
        uint256 c2Bonus  = choice2 == 0 ? uint256(qc.choice2A) : uint256(qc.choice2B);
        (, , uint32 dex, , ) = lastChad.getStats(tokenId);
        uint256 dexBonus = dex >= 2 ? uint256(dex) - 1 : 0;
        uint256 xpAmount = c1Bonus + uint256(cargo) + c2Bonus + dexBonus;

        // Settle state before external calls
        questCompleted[tokenId][questId] = true;
        delete pendingSessions[tokenId];
        delete lockedBy[tokenId];
        _removeLocked(tokenId);

        // Return NFT
        lastChad.transferFrom(address(this), player, tokenId);

        // Award XP (guard against zero — awardExperience requires > 0)
        if (xpAmount > 0) {
            lastChad.awardExperience(tokenId, xpAmount);
        }

        // Award cells from quest config
        uint256 cellsAwarded = 0;
        if (qc.cellReward > 0) {
            cellsAwarded = uint256(qc.cellReward);
            lastChad.awardCells(tokenId, cellsAwarded);
        }

        // Award item from quest config
        uint256 itemAwarded = 0;
        if (qc.itemReward > 0 && address(lastChadItems) != address(0)) {
            itemAwarded = uint256(qc.itemReward);
            lastChadItems.mintTo(player, itemAwarded, 1);
        }

        emit QuestCompleted(tokenId, questId, xpAmount, cellsAwarded, itemAwarded);
    }

    // -------------------------------------------------------------------------
    // On-chain dice derivation
    // keccak256(seed, roll, dieIndex) % 6 + 1
    // -------------------------------------------------------------------------
    function _deriveDie(bytes32 seed, uint8 roll, uint8 dieIndex) internal pure returns (uint8) {
        return uint8(uint256(keccak256(abi.encodePacked(seed, roll, dieIndex))) % 6) + 1;
    }

    // Ship Captain Crew: needs 6 + 5 + 4; cargo = sum of remaining 2 dice
    function _calculateCargo(bytes32 seed, uint8 kept1, uint8 kept2) internal pure returns (uint8) {
        uint8[5] memory values;
        for (uint8 i = 0; i < 5; i++) {
            if      ((kept1 & (1 << i)) != 0) values[i] = _deriveDie(seed, 1, i);
            else if ((kept2 & (1 << i)) != 0) values[i] = _deriveDie(seed, 2, i);
            else                               values[i] = _deriveDie(seed, 3, i);
        }

        bool[5] memory used;
        bool has6; bool has5; bool has4;

        for (uint8 i = 0; i < 5; i++) {
            if (!has6 && values[i] == 6) { used[i] = true; has6 = true; break; }
        }
        for (uint8 i = 0; i < 5; i++) {
            if (!has5 && !used[i] && values[i] == 5) { used[i] = true; has5 = true; break; }
        }
        for (uint8 i = 0; i < 5; i++) {
            if (!has4 && !used[i] && values[i] == 4) { used[i] = true; has4 = true; break; }
        }

        if (!has6 || !has5 || !has4) return 0;

        uint8 cargo = 0;
        for (uint8 i = 0; i < 5; i++) {
            if (!used[i]) cargo += values[i];
        }
        return cargo;
    }

    // -------------------------------------------------------------------------
    // Mid-quest awards — game owner only, for dynamic in-quest events
    // These are optional; standard rewards come from QuestConfig automatically
    // -------------------------------------------------------------------------
    function awardCells(uint256 tokenId, uint256 amount) external onlyGameOwner {
        address player = lockedBy[tokenId];
        require(player != address(0), "Token not locked");
        lastChad.awardCells(tokenId, amount);
        emit CellsAwarded(tokenId, player, amount);
    }

    function awardItem(uint256 tokenId, uint256 itemId) external onlyGameOwner {
        require(address(lastChadItems) != address(0), "Items contract not set");
        address player = lockedBy[tokenId];
        require(player != address(0), "Token not locked");
        lastChadItems.mintTo(player, itemId, 1);
        emit ItemAwarded(tokenId, player, itemId);
    }

    // -------------------------------------------------------------------------
    // purchaseItem — player spends cells to buy from in-quest shop
    // -------------------------------------------------------------------------
    function purchaseItem(uint256 tokenId, uint256 itemId) external {
        require(lockedBy[tokenId] == msg.sender, "Not quest participant");
        require(address(lastChadItems) != address(0), "Items contract not set");
        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(
            block.timestamp <= uint256(session.startTime) + SESSION_DURATION,
            "Session expired"
        );
        uint256 cost = itemPrices[itemId];
        require(cost > 0, "Item not in shop");

        lastChad.spendCells(tokenId, cost);
        lastChadItems.mintTo(msg.sender, itemId, 1);
        emit ItemPurchased(tokenId, itemId, msg.sender, cost);
    }

    // -------------------------------------------------------------------------
    // setItemPrice
    // -------------------------------------------------------------------------
    function setItemPrice(uint256 itemId, uint256 cellCost) external onlyGameOwner {
        itemPrices[itemId] = cellCost;
        emit ItemPriceSet(itemId, cellCost);
    }

    // -------------------------------------------------------------------------
    // Release — return NFTs to their original owners
    // -------------------------------------------------------------------------
    function releaseLocked(uint256 tokenId) external onlyGameOwner {
        address original = lockedBy[tokenId];
        require(original != address(0), "Token not locked");
        _doRelease(tokenId, original);
        emit NFTReleased(tokenId, original);
    }

    function batchReleaseLocked(uint256[] calldata tokenIds) external onlyGameOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            address original = lockedBy[tokenId];
            if (original == address(0)) continue; // skip unlocked
            _doRelease(tokenId, original);
            emit NFTReleased(tokenId, original);
        }
    }

    // -------------------------------------------------------------------------
    // Burn — send NFTs to the dead address
    // -------------------------------------------------------------------------
    function burnLocked(uint256 tokenId) external onlyGameOwner {
        address original = lockedBy[tokenId];
        require(original != address(0), "Token not locked");
        _doBurn(tokenId, original);
        emit NFTBurned(tokenId, original);
    }

    function batchBurnLocked(uint256[] calldata tokenIds) external onlyGameOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            address original = lockedBy[tokenId];
            if (original == address(0)) continue; // skip unlocked
            _doBurn(tokenId, original);
            emit NFTBurned(tokenId, original);
        }
    }

    // Burn every NFT currently held in escrow
    function burnAllLocked() external onlyGameOwner {
        // Iterate in reverse so swap-and-pop removals don't skip tokens
        for (uint256 i = _lockedTokenIds.length; i > 0; i--) {
            uint256 tokenId = _lockedTokenIds[i - 1];
            address original = lockedBy[tokenId];
            _doBurn(tokenId, original);
            emit NFTBurned(tokenId, original);
        }
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    function _doRelease(uint256 tokenId, address original) internal {
        delete lockedBy[tokenId];
        delete pendingSessions[tokenId];
        _removeLocked(tokenId);
        lastChad.transferFrom(address(this), original, tokenId);
    }

    function _doBurn(uint256 tokenId, address original) internal {
        delete lockedBy[tokenId];
        delete pendingSessions[tokenId];
        _removeLocked(tokenId);
        lastChad.transferFrom(address(this), BURN_ADDRESS, tokenId);
    }

    // O(1) add to locked set
    function _addLocked(uint256 tokenId) internal {
        _lockedIndex[tokenId] = _lockedTokenIds.length + 1; // 1-based
        _lockedTokenIds.push(tokenId);
    }

    // O(1) remove from locked set via swap-and-pop
    function _removeLocked(uint256 tokenId) internal {
        uint256 idx = _lockedIndex[tokenId];
        if (idx == 0) return; // not tracked

        uint256 arrayIdx = idx - 1;
        uint256 last = _lockedTokenIds[_lockedTokenIds.length - 1];
        _lockedTokenIds[arrayIdx] = last;
        _lockedIndex[last] = idx;
        _lockedTokenIds.pop();
        delete _lockedIndex[tokenId];
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------
    function getSession(uint256 tokenId) external view returns (
        bytes32 seed, uint8 questId, uint256 startTime, uint256 expiresAt, bool active
    ) {
        QuestSession memory s = pendingSessions[tokenId];
        return (s.seed, s.questId, s.startTime, uint256(s.startTime) + SESSION_DURATION, s.active);
    }

    function isSessionExpired(uint256 tokenId) external view returns (bool) {
        QuestSession memory s = pendingSessions[tokenId];
        if (!s.active) return false;
        return block.timestamp > uint256(s.startTime) + SESSION_DURATION;
    }

    // Returns all token IDs currently locked in escrow
    function getLockedTokenIds() external view returns (uint256[] memory) {
        return _lockedTokenIds;
    }

    function getLockedCount() external view returns (uint256) {
        return _lockedTokenIds.length;
    }

    function getQuestConfig(uint8 questId) external view returns (
        uint8 c1a, uint8 c1b, uint8 c2a, uint8 c2b, uint16 cellReward, uint16 itemReward
    ) {
        QuestConfig memory qc = _questConfig[questId];
        return (qc.choice1A, qc.choice1B, qc.choice2A, qc.choice2B, qc.cellReward, qc.itemReward);
    }

    // Required to receive ERC-721 tokens
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
