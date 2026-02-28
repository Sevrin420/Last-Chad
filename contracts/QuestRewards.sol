// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function awardExperience(uint256 tokenId, uint256 amount) external;
}

contract QuestRewards {
    ILastChad public immutable lastChad;

    uint256 public constant SESSION_DURATION = 1 hours;

    struct QuestSession {
        bytes32 seed;
        uint8 questId;
        uint40 startTime;
        bool active;
    }

    // tokenId => active session (overwritten on each new quest start)
    mapping(uint256 => QuestSession) public pendingSessions;

    // tokenId => questId => started (set once on startQuest, never cleared)
    mapping(uint256 => mapping(uint8 => bool)) public questStarted;

    // tokenId => questId => completed (set on successful completeQuest)
    mapping(uint256 => mapping(uint8 => bool)) public questCompleted;

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

    constructor(address lastChadAddress) {
        lastChad = ILastChad(lastChadAddress);
    }

    // -------------------------------------------------------------------------
    // startQuest
    //
    // - Caller must own the token
    // - Quest must not have been started before by this token (one attempt ever)
    // - Generates a deterministic seed from on-chain entropy
    // - Marks questStarted permanently; stores active session
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
    // Parameters:
    //   xpAmount — total XP computed by the frontend from all dice sections.
    //              Each dice section score = sum of all 5 dice + the section's
    //              assigned stat bonus. Scores accumulate across all dice
    //              sections in the quest.
    //
    // Session guards prevent double-claiming and expired sessions.
    // -------------------------------------------------------------------------
    function completeQuest(
        uint256 tokenId,
        uint8 questId,
        uint256 xpAmount
    ) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");

        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(session.questId == questId, "Wrong quest");
        require(
            block.timestamp <= uint256(session.startTime) + SESSION_DURATION,
            "Session expired"
        );
        require(!questCompleted[tokenId][questId], "Already completed");

        // Mark complete and clear session before external call
        questCompleted[tokenId][questId] = true;
        delete pendingSessions[tokenId];

        // Award XP — LastChad handles level-up logic internally
        if (xpAmount > 0) {
            lastChad.awardExperience(tokenId, xpAmount);
        }

        emit QuestCompleted(tokenId, questId, xpAmount);
    }

    // -------------------------------------------------------------------------
    // View helpers (used by the frontend to determine page state on load)
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
