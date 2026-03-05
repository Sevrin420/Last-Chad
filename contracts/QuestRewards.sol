// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function awardExperience(uint256 tokenId, uint256 amount) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

contract QuestRewards {
    ILastChad public immutable lastChad;
    address public immutable gameOwner;

    uint256 public constant SESSION_DURATION = 1 hours;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    struct QuestSession {
        bytes32 seed;
        uint8 questId;
        uint40 startTime;
        bool active;
    }

    // tokenId => active session
    mapping(uint256 => QuestSession) public pendingSessions;

    // tokenId => questId => started (one attempt ever)
    mapping(uint256 => mapping(uint8 => bool)) public questStarted;

    // tokenId => questId => completed
    mapping(uint256 => mapping(uint8 => bool)) public questCompleted;

    // tokenId => original owner (set while NFT is held in escrow)
    mapping(uint256 => address) public lockedBy;

    event QuestStarted(
        uint256 indexed tokenId,
        uint8 questId,
        bytes32 seed,
        uint256 expiresAt
    );

    event QuestCompleted(
        uint256 indexed tokenId,
        uint8 questId,
        uint256 xpAwarded
    );

    event QuestFailed(
        uint256 indexed tokenId,
        uint8 questId
    );

    event NFTBurned(uint256 indexed tokenId, address indexed originalOwner);
    event NFTReleased(uint256 indexed tokenId, address indexed returnedTo);

    constructor(address lastChadAddress) {
        lastChad = ILastChad(lastChadAddress);
        gameOwner = msg.sender;
    }

    // -------------------------------------------------------------------------
    // startQuest
    //
    // - Caller must own the token
    // - Quest must not have been started before (one attempt ever)
    // - NFT is transferred into this contract (player must approve first)
    // - Generates a deterministic seed from on-chain entropy
    // -------------------------------------------------------------------------
    function startQuest(uint256 tokenId, uint8 questId) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!questStarted[tokenId][questId], "Quest already attempted");

        bytes32 seed = keccak256(abi.encodePacked(
            tokenId,
            questId,
            block.prevrandao,
            block.timestamp,
            msg.sender
        ));

        questStarted[tokenId][questId] = true;
        lockedBy[tokenId] = msg.sender;

        // Pull NFT into escrow — player must have approved this contract first
        lastChad.transferFrom(msg.sender, address(this), tokenId);

        pendingSessions[tokenId] = QuestSession({
            seed: seed,
            questId: questId,
            startTime: uint40(block.timestamp),
            active: true
        });

        emit QuestStarted(tokenId, questId, seed, block.timestamp + SESSION_DURATION);
    }

    // -------------------------------------------------------------------------
    // completeQuest
    //
    // xpAmount > 0 → success: NFT returned, XP awarded
    // xpAmount == 0 → fail: NFT stays locked until owner calls burnLocked
    // -------------------------------------------------------------------------
    function completeQuest(
        uint256 tokenId,
        uint8 questId,
        uint256 xpAmount
    ) external {
        require(lockedBy[tokenId] == msg.sender, "Not quest participant");

        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(session.questId == questId, "Wrong quest");
        require(
            block.timestamp <= uint256(session.startTime) + SESSION_DURATION,
            "Session expired"
        );
        require(!questCompleted[tokenId][questId], "Already completed");

        delete pendingSessions[tokenId];

        if (xpAmount > 0) {
            // Success — return NFT and award XP
            questCompleted[tokenId][questId] = true;
            delete lockedBy[tokenId];

            lastChad.transferFrom(address(this), msg.sender, tokenId);

            lastChad.awardExperience(tokenId, xpAmount);
            emit QuestCompleted(tokenId, questId, xpAmount);
        } else {
            // Fail — NFT stays locked, lockedBy preserved for burn reference
            emit QuestFailed(tokenId, questId);
        }
    }

    // -------------------------------------------------------------------------
    // burnLocked — owner only
    // Sends a failed/locked NFT to the burn address
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
    // releaseLocked — owner only
    // Returns a stuck NFT to its original owner (mercy / error recovery)
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
        bytes32 seed,
        uint8 questId,
        uint256 startTime,
        uint256 expiresAt,
        bool active
    ) {
        QuestSession memory s = pendingSessions[tokenId];
        return (
            s.seed,
            s.questId,
            s.startTime,
            uint256(s.startTime) + SESSION_DURATION,
            s.active
        );
    }

    function isSessionExpired(uint256 tokenId) external view returns (bool) {
        QuestSession memory s = pendingSessions[tokenId];
        if (!s.active) return false;
        return block.timestamp > uint256(s.startTime) + SESSION_DURATION;
    }
}
