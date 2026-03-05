// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function awardExperience(uint256 tokenId, uint256 amount) external;
    function awardCells(uint256 tokenId, uint256 amount) external;
    function spendCells(uint256 tokenId, uint256 amount) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface ILastChadItems {
    function mintTo(address to, uint256 itemId, uint256 quantity) external;
}

contract QuestRewards {
    ILastChad      public immutable lastChad;
    ILastChadItems public immutable lastChadItems;
    address        public immutable gameOwner;

    uint256 public constant SESSION_DURATION   = 1 hours;
    uint256 public constant SEED_REVEAL_TIMEOUT = 5 minutes;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    struct QuestSession {
        bytes32 partialSeed;  // keccak256(tokenId, questId, prevrandao, timestamp, sender)
        bytes32 seed;         // final seed = keccak256(partialSeed, serverNonce); zero until revealSeed()
        uint8   questId;
        uint40  startTime;
        bool    active;
        bool    seedRevealed;
    }

    mapping(uint256 => QuestSession) public pendingSessions;
    mapping(uint256 => mapping(uint8 => bool)) public questStarted;
    mapping(uint256 => mapping(uint8 => bool)) public questCompleted;

    // tokenId => original owner (set while NFT is in escrow)
    mapping(uint256 => address) public lockedBy;

    // itemId => cell cost for the in-quest shop (0 = not for sale)
    mapping(uint256 => uint256) public itemPrices;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    event QuestStarted(uint256 indexed tokenId, uint8 questId, uint256 expiresAt, uint256 revealDeadline);
    event SeedRevealed(uint256 indexed tokenId, uint8 questId, bytes32 seed);
    event QuestCancelled(uint256 indexed tokenId, uint8 questId, address indexed player);
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

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(address lastChadAddress, address lastChadItemsAddress) {
        lastChad      = ILastChad(lastChadAddress);
        lastChadItems = ILastChadItems(lastChadItemsAddress);
        gameOwner     = msg.sender;
    }

    // -------------------------------------------------------------------------
    // startQuest — player locks NFT into escrow
    // -------------------------------------------------------------------------
    function startQuest(uint256 tokenId, uint8 questId) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!questStarted[tokenId][questId], "Quest already attempted");

        bytes32 partialSeed = keccak256(abi.encodePacked(
            tokenId, questId, block.prevrandao, block.timestamp, msg.sender
        ));

        questStarted[tokenId][questId] = true;
        lockedBy[tokenId] = msg.sender;
        lastChad.transferFrom(msg.sender, address(this), tokenId);

        pendingSessions[tokenId] = QuestSession({
            partialSeed:  partialSeed,
            seed:         bytes32(0),
            questId:      questId,
            startTime:    uint40(block.timestamp),
            active:       true,
            seedRevealed: false
        });

        emit QuestStarted(
            tokenId,
            questId,
            block.timestamp + SESSION_DURATION,
            block.timestamp + SEED_REVEAL_TIMEOUT
        );
    }

    // -------------------------------------------------------------------------
    // revealSeed — game owner contributes server nonce to finalise the seed
    // Called by server immediately after startQuest confirms on-chain.
    // finalSeed = keccak256(partialSeed, serverNonce)
    // The serverNonce is logged off-chain for public verifiability.
    // -------------------------------------------------------------------------
    function revealSeed(uint256 tokenId, bytes32 serverNonce) external {
        require(msg.sender == gameOwner, "Not game owner");
        require(lockedBy[tokenId] != address(0), "Token not locked");

        QuestSession storage session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(!session.seedRevealed, "Seed already revealed");

        bytes32 finalSeed = keccak256(abi.encodePacked(session.partialSeed, serverNonce));
        session.seed = finalSeed;
        session.seedRevealed = true;

        emit SeedRevealed(tokenId, session.questId, finalSeed);
    }

    // -------------------------------------------------------------------------
    // cancelQuest — player reclaims NFT if server fails to reveal seed in time
    // Only callable after SEED_REVEAL_TIMEOUT expires without a revealSeed call.
    // Clears questStarted so the player can retry the quest.
    // -------------------------------------------------------------------------
    function cancelQuest(uint256 tokenId) external {
        require(lockedBy[tokenId] == msg.sender, "Not quest participant");

        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(!session.seedRevealed, "Quest already seeded");
        require(
            block.timestamp > uint256(session.startTime) + SEED_REVEAL_TIMEOUT,
            "Reveal window still open"
        );

        uint8 qId = session.questId;
        delete pendingSessions[tokenId];
        delete lockedBy[tokenId];
        questStarted[tokenId][qId] = false;

        lastChad.transferFrom(address(this), msg.sender, tokenId);
        emit QuestCancelled(tokenId, qId, msg.sender);
    }

    // -------------------------------------------------------------------------
    // completeQuest — game owner resolves the quest; XP only
    //
    // Call awardCells / awardItem before this if awarding those.
    // xpAmount > 0 → success: NFT returned, XP awarded
    // xpAmount == 0 → fail:   NFT stays locked; call burnLocked to finalise
    // -------------------------------------------------------------------------
    function completeQuest(uint256 tokenId, uint8 questId, uint256 xpAmount) external {
        require(msg.sender == gameOwner, "Not game owner");
        require(lockedBy[tokenId] != address(0), "Token not locked");

        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(session.seedRevealed, "Seed not revealed");
        require(session.questId == questId, "Wrong quest");
        require(
            block.timestamp <= uint256(session.startTime) + SESSION_DURATION,
            "Session expired"
        );
        require(!questCompleted[tokenId][questId], "Already completed");

        address player = lockedBy[tokenId];
        delete pendingSessions[tokenId];

        if (xpAmount > 0) {
            questCompleted[tokenId][questId] = true;
            delete lockedBy[tokenId];

            lastChad.transferFrom(address(this), player, tokenId);
            lastChad.awardExperience(tokenId, xpAmount);
            emit QuestCompleted(tokenId, questId, xpAmount);
        } else {
            emit QuestFailed(tokenId, questId);
        }
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
        bytes32 seed, uint8 questId, uint256 startTime, uint256 expiresAt, bool active, bool seedRevealed
    ) {
        QuestSession memory s = pendingSessions[tokenId];
        return (s.seed, s.questId, s.startTime, uint256(s.startTime) + SESSION_DURATION, s.active, s.seedRevealed);
    }

    function isSessionExpired(uint256 tokenId) external view returns (bool) {
        QuestSession memory s = pendingSessions[tokenId];
        if (!s.active) return false;
        return block.timestamp > uint256(s.startTime) + SESSION_DURATION;
    }
}
