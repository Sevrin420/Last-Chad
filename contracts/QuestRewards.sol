// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getStats(uint256 tokenId) external view returns (
        uint32 strength,
        uint32 intelligence,
        uint32 dexterity,
        uint32 charisma,
        bool assigned
    );
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
    //   choice1  — 0 = lower tunnels (+1 XP), 1 = upper tunnels (+3 XP)
    //   choice2  — 0 = force alone (+2 XP),   1 = signal backup (+3 XP)
    //   kept1    — 5-bit bitmask: which dice were locked after roll 1
    //   kept2    — 5-bit bitmask: which dice were locked after roll 2
    //              kept2 must be a superset of kept1
    //
    // The contract re-derives all dice outcomes from the session seed and the
    // keep decisions, then computes the exact XP. The frontend cannot inflate
    // the score — the contract independently verifies everything.
    // -------------------------------------------------------------------------
    function completeQuest(
        uint256 tokenId,
        uint8 questId,
        uint8 choice1,
        uint8 choice2,
        uint8 kept1,
        uint8 kept2
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

        require(choice1 <= 1, "Invalid choice1");
        require(choice2 <= 1, "Invalid choice2");
        require(kept1 < 32, "Invalid kept1");
        require(kept2 < 32, "Invalid kept2");
        require((kept2 & kept1) == kept1, "kept2 must include all of kept1");

        // Re-derive all dice outcomes from the session seed
        uint8[5] memory finalDice = _deriveFinalDice(session.seed, kept1, kept2);

        // Score the dice
        uint256 diceScore = _calculateDiceScore(finalDice);

        // Read dex for bonus (dex 1 = no bonus, dex 2 = +1, dex 3 = +2, etc.)
        (, , uint32 dex, , ) = lastChad.getStats(tokenId);
        uint256 dexBonus = dex > 1 ? uint256(dex) - 1 : 0;

        // Total XP
        uint256 xp = (choice1 == 1 ? 3 : 1)
                   + diceScore
                   + (choice2 == 1 ? 3 : 2)
                   + dexBonus;

        // Mark complete and clear session before external call
        questCompleted[tokenId][questId] = true;
        delete pendingSessions[tokenId];

        // Award XP — LastChad handles level-up logic internally
        lastChad.awardExperience(tokenId, xp);

        emit QuestCompleted(tokenId, questId, xp);
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

    // -------------------------------------------------------------------------
    // Internal: deterministic dice derivation
    //
    // Each die value is keccak256(seed, rollNumber, dieIndex) % 6 + 1.
    // The frontend uses the identical formula so dice are consistent.
    //
    // kept1 / kept2 are 5-bit bitmasks (bit i = die i):
    //   - If bit i set in kept1 → die i uses roll 1 value
    //   - Else if bit i set in kept2 → die i uses roll 2 value
    //   - Else → die i uses roll 3 value
    //
    // A player who "stops early" sets all remaining bits in kept1 or kept2,
    // which naturally prevents those dice from changing on later rolls.
    // -------------------------------------------------------------------------
    function _deriveDie(bytes32 seed, uint8 roll, uint8 dieIndex)
        internal
        pure
        returns (uint8)
    {
        return uint8(uint256(keccak256(abi.encodePacked(seed, roll, dieIndex))) % 6) + 1;
    }

    function _deriveFinalDice(bytes32 seed, uint8 kept1, uint8 kept2)
        internal
        pure
        returns (uint8[5] memory finalDice)
    {
        for (uint8 i = 0; i < 5; i++) {
            bool lockedAfterR1 = (kept1 >> i) & 1 == 1;
            bool lockedAfterR2 = (kept2 >> i) & 1 == 1;

            if (lockedAfterR1) {
                finalDice[i] = _deriveDie(seed, 1, i);
            } else if (lockedAfterR2) {
                finalDice[i] = _deriveDie(seed, 2, i);
            } else {
                finalDice[i] = _deriveDie(seed, 3, i);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Internal: dice scoring
    //
    // Objective: find one 6 (SHIP), one 5 (CAPTAIN), one 4 (MATE).
    // If all three are present, the score is the sum of the remaining 2 dice.
    // If any of the three is missing, the dice score is 0.
    // -------------------------------------------------------------------------
    function _calculateDiceScore(uint8[5] memory dice)
        internal
        pure
        returns (uint256)
    {
        bool[5] memory used;
        bool has6;
        bool has5;
        bool has4;

        for (uint8 i = 0; i < 5 && !has6; i++) {
            if (dice[i] == 6) { has6 = true; used[i] = true; }
        }
        for (uint8 i = 0; i < 5 && !has5; i++) {
            if (!used[i] && dice[i] == 5) { has5 = true; used[i] = true; }
        }
        for (uint8 i = 0; i < 5 && !has4; i++) {
            if (!used[i] && dice[i] == 4) { has4 = true; used[i] = true; }
        }

        if (!has6 || !has5 || !has4) return 0;

        uint256 crewScore;
        for (uint8 i = 0; i < 5; i++) {
            if (!used[i]) crewScore += dice[i];
        }
        return crewScore;
    }
}
