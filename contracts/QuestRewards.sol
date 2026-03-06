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
        bytes32 seed;      // keccak256(tokenId, questId, prevrandao, timestamp, sender) — set immediately
        uint8   questId;
        uint40  startTime;
        bool    active;
    }

    // Per-quest choice XP rewards, set by game owner
    struct QuestConfig {
        uint8 choice1A;  // XP bonus when choice1 = 0
        uint8 choice1B;  // XP bonus when choice1 = 1
        uint8 choice2A;  // XP bonus when choice2 = 0
        uint8 choice2B;  // XP bonus when choice2 = 1
    }

    mapping(uint256 => QuestSession) public pendingSessions;
    mapping(uint256 => mapping(uint8 => bool)) public questStarted;
    mapping(uint256 => mapping(uint8 => bool)) public questCompleted;

    // tokenId => original owner (set while NFT is in escrow)
    mapping(uint256 => address) public lockedBy;

    // itemId => cell cost for the in-quest shop (0 = not for sale)
    mapping(uint256 => uint256) public itemPrices;

    // questId => choice XP config
    mapping(uint8 => QuestConfig) internal _questConfig;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    event QuestStarted(uint256 indexed tokenId, uint8 questId, bytes32 seed, uint256 expiresAt);
    event QuestCompleted(uint256 indexed tokenId, uint8 questId, uint256 xpAwarded);
    event QuestFailed(uint256 indexed tokenId, uint8 questId);
    event NFTBurned(uint256 indexed tokenId, address indexed originalOwner);
    event NFTReleased(uint256 indexed tokenId, address indexed returnedTo);

    // Mid/end-quest awards (called by game owner)
    event CellsAwarded(uint256 indexed tokenId, address indexed player, uint256 amount);
    event ItemAwarded(uint256 indexed tokenId, address indexed player, uint256 itemId);

    // Player-initiated shop purchase
    event ItemPurchased(uint256 indexed tokenId, uint256 indexed itemId, address indexed buyer, uint256 cellCost);

    event ItemPriceSet(uint256 indexed itemId, uint256 cellCost);
    event QuestConfigSet(uint8 indexed questId, uint8 c1a, uint8 c1b, uint8 c2a, uint8 c2b);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(address lastChadAddress) {
        lastChad  = ILastChad(lastChadAddress);
        gameOwner = msg.sender;
    }

    // -------------------------------------------------------------------------
    // setLastChadItems — owner sets the items contract (optional, for item awards)
    // -------------------------------------------------------------------------
    function setLastChadItems(address itemsAddress) external {
        require(msg.sender == gameOwner, "Not game owner");
        lastChadItems = ILastChadItems(itemsAddress);
    }

    // -------------------------------------------------------------------------
    // setQuestConfig — owner sets choice XP bonuses for a quest
    // -------------------------------------------------------------------------
    function setQuestConfig(uint8 questId, uint8 c1a, uint8 c1b, uint8 c2a, uint8 c2b) external {
        require(msg.sender == gameOwner, "Not game owner");
        _questConfig[questId] = QuestConfig(c1a, c1b, c2a, c2b);
        emit QuestConfigSet(questId, c1a, c1b, c2a, c2b);
    }

    // -------------------------------------------------------------------------
    // startQuest — player locks NFT into escrow; seed is generated immediately
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

        pendingSessions[tokenId] = QuestSession({
            seed:      seed,
            questId:   questId,
            startTime: uint40(block.timestamp),
            active:    true
        });

        emit QuestStarted(tokenId, questId, seed, block.timestamp + SESSION_DURATION);
    }

    // -------------------------------------------------------------------------
    // completeQuest — player submits choices + kept-dice bitmasks; XP is
    //                 computed on-chain from the seed (no trusted server needed)
    //
    // choice1, choice2: narrative choices (0 or 1), mapped to XP via QuestConfig
    // kept1: 5-bit bitmask — which dice the player kept after roll 1
    // kept2: 5-bit bitmask — which dice the player kept after roll 2
    //        (must be a superset of kept1)
    //
    // XP = choiceBonus1 + cargoScore + choiceBonus2 + dexBonus
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

        // Validate inputs
        require(choice1 <= 1, "Invalid choice1");
        require(choice2 <= 1, "Invalid choice2");
        require(kept1 < 32, "Invalid kept1");
        require(kept2 < 32, "Invalid kept2");
        require((kept1 & kept2) == kept1, "kept2 must include all of kept1");

        // Compute cargo score on-chain from seed + kept bitmasks
        uint8 cargo = _calculateCargo(session.seed, kept1, kept2);

        // Look up choice XP bonuses
        QuestConfig memory qc = _questConfig[questId];
        uint256 c1Bonus = choice1 == 0 ? uint256(qc.choice1A) : uint256(qc.choice1B);
        uint256 c2Bonus = choice2 == 0 ? uint256(qc.choice2A) : uint256(qc.choice2B);

        // DEX bonus: dex >= 2 gives (dex - 1) bonus XP
        (, , uint32 dex, , ) = lastChad.getStats(tokenId);
        uint256 dexBonus = dex >= 2 ? uint256(dex) - 1 : 0;

        uint256 xpAmount = c1Bonus + uint256(cargo) + c2Bonus + dexBonus;

        questCompleted[tokenId][questId] = true;
        delete pendingSessions[tokenId];
        delete lockedBy[tokenId];

        lastChad.transferFrom(address(this), player, tokenId);
        lastChad.awardExperience(tokenId, xpAmount);
        emit QuestCompleted(tokenId, questId, xpAmount);
    }

    // -------------------------------------------------------------------------
    // On-chain dice derivation — mirrors _deriveDieJS in quest frontend
    // keccak256(seed, roll, dieIndex) % 6 + 1
    // -------------------------------------------------------------------------
    function _deriveDie(bytes32 seed, uint8 roll, uint8 dieIndex) internal pure returns (uint8) {
        return uint8(uint256(keccak256(abi.encodePacked(seed, roll, dieIndex))) % 6) + 1;
    }

    // -------------------------------------------------------------------------
    // Ship Captain Crew scoring — finds 6+5+4, returns sum of remaining 2 dice
    // Returns 0 if the full set (6, 5, 4) is not present
    // -------------------------------------------------------------------------
    function _calculateCargo(bytes32 seed, uint8 kept1, uint8 kept2) internal pure returns (uint8) {
        // Determine final die values based on which roll they were kept on
        uint8[5] memory values;
        for (uint8 i = 0; i < 5; i++) {
            if ((kept1 & (1 << i)) != 0) {
                values[i] = _deriveDie(seed, 1, i);   // kept after roll 1
            } else if ((kept2 & (1 << i)) != 0) {
                values[i] = _deriveDie(seed, 2, i);   // kept after roll 2
            } else {
                values[i] = _deriveDie(seed, 3, i);   // settled on roll 3
            }
        }

        // Find ship (6), captain (5), mate (4) — one of each
        bool[5] memory used;
        bool has6;
        bool has5;
        bool has4;

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

        // Cargo = sum of remaining 2 dice
        uint8 cargo = 0;
        for (uint8 i = 0; i < 5; i++) {
            if (!used[i]) cargo += values[i];
        }
        return cargo;
    }

    // -------------------------------------------------------------------------
    // awardCells — game owner grants cells mid-quest or at end
    // Can be called multiple times (e.g. after each minigame section)
    // -------------------------------------------------------------------------
    function awardCells(uint256 tokenId, uint256 amount) external {
        require(msg.sender == gameOwner, "Not game owner");
        address player = lockedBy[tokenId];
        require(player != address(0), "Token not locked");

        lastChad.awardCells(tokenId, amount);
        emit CellsAwarded(tokenId, player, amount);
    }

    // -------------------------------------------------------------------------
    // awardItem — game owner mints an item to the original owner
    // Use for: good dice rolls, minigame scores, XP thresholds, quest rewards
    // Call before completeQuest so lockedBy is still set
    // -------------------------------------------------------------------------
    function awardItem(uint256 tokenId, uint256 itemId) external {
        require(msg.sender == gameOwner, "Not game owner");
        require(address(lastChadItems) != address(0), "Items contract not set");
        address player = lockedBy[tokenId];
        require(player != address(0), "Token not locked");

        lastChadItems.mintTo(player, itemId, 1);
        emit ItemAwarded(tokenId, player, itemId);
    }

    // -------------------------------------------------------------------------
    // purchaseItem — player spends cells to buy an item mid-quest
    // Requires an active session (no shopping after the quest ends)
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
    // setItemPrice — owner sets cell cost for a shop item (0 = remove)
    // -------------------------------------------------------------------------
    function setItemPrice(uint256 itemId, uint256 cellCost) external {
        require(msg.sender == gameOwner, "Not game owner");
        itemPrices[itemId] = cellCost;
        emit ItemPriceSet(itemId, cellCost);
    }

    // -------------------------------------------------------------------------
    // burnLocked — owner only; burn a failed/forfeited NFT
    // -------------------------------------------------------------------------
    function burnLocked(uint256 tokenId) external {
        require(msg.sender == gameOwner, "Not game owner");
        address original = lockedBy[tokenId];
        require(original != address(0), "Token not locked");

        delete lockedBy[tokenId];
        lastChad.transferFrom(address(this), BURN_ADDRESS, tokenId);
        emit NFTBurned(tokenId, original);
    }

    // -------------------------------------------------------------------------
    // releaseLocked — owner only; mercy release / error recovery
    // -------------------------------------------------------------------------
    function releaseLocked(uint256 tokenId) external {
        require(msg.sender == gameOwner, "Not game owner");
        address original = lockedBy[tokenId];
        require(original != address(0), "Token not locked");

        delete lockedBy[tokenId];
        delete pendingSessions[tokenId];
        lastChad.transferFrom(address(this), original, tokenId);
        emit NFTReleased(tokenId, original);
    }

    // Required to receive ERC-721 tokens
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
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
}
