// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function eliminated(uint256 tokenId) external view returns (bool);
    function isActive(uint256 tokenId) external view returns (bool);
    function spendCells(uint256 tokenId, uint256 amount) external;
    function awardCells(uint256 tokenId, uint256 amount) external;
}

/// @title Gamble — cell-wagering games for Last Chad
///
/// Two settlement paths:
///   1. flip()        — fully on-chain coin flip (40% win, 2x payout).
///   2. resolveGame() — oracle-signed settlement for any off-chain game
///                      (blackjack, poker, etc.). The Cloudflare Worker
///                      runs game logic and signs (tokenId, wager, payout,
///                      gameId, nonce, player). The contract verifies and
///                      settles cells atomically.
///
/// Must be authorized: lastChad.setGameContract(gambleAddress, true)
contract Gamble {
    ILastChad public immutable lastChad;
    address   public immutable gameOwner;
    address   public oracle;

    uint256 public minWager = 1;
    uint256 public maxWager = 500;
    uint256 public maxPayoutMultiplier = 20; // payout cap: wager * multiplier

    // Prevent oracle signature replay
    mapping(uint256 => bool) public usedNonces;

    // Two-tx settlement (poker, craps, etc.)
    mapping(uint256 => uint256) public wagerAmounts;  // nonce → wager
    mapping(uint256 => address) public wagerPlayers;   // nonce → player
    uint256 public nextNonce;

    // ── Events ──────────────────────────────────────────────────────────────
    event CoinFlip(
        uint256 indexed tokenId,
        address indexed player,
        uint256 wager,
        bool    won,
        bytes32 seed
    );

    event GameResolved(
        uint256 indexed tokenId,
        address indexed player,
        uint8   indexed gameId,
        uint256 wager,
        uint256 payout  // 0 = player lost
    );

    event WagerCommitted(
        uint256 indexed tokenId,
        address indexed player,
        uint256 wager,
        uint256 nonce
    );

    event WinningsClaimed(
        uint256 indexed tokenId,
        address indexed player,
        uint256 payout,
        uint256 nonce
    );

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address lastChadAddress, address _oracle) {
        require(_oracle != address(0), "Oracle required");
        lastChad  = ILastChad(lastChadAddress);
        gameOwner = msg.sender;
        oracle    = _oracle;
    }

    modifier onlyGameOwner() {
        require(msg.sender == gameOwner, "Not game owner");
        _;
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    function setOracle(address _oracle) external onlyGameOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
    }

    function setWagerLimits(uint256 min, uint256 max) external onlyGameOwner {
        require(min > 0 && max >= min, "Invalid limits");
        minWager = min;
        maxWager = max;
    }

    function setMaxPayoutMultiplier(uint256 mult) external onlyGameOwner {
        require(mult > 0, "Multiplier must be > 0");
        maxPayoutMultiplier = mult;
    }

    // ── Path 1: on-chain coin flip ───────────────────────────────────────────
    /// @notice 40% chance to win 2x the wager. Outcome derived from block entropy.
    function flip(uint256 tokenId, uint256 wager) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!lastChad.eliminated(tokenId), "Chad eliminated");
        require(!lastChad.isActive(tokenId), "Token active in quest/arcade");
        require(wager >= minWager && wager <= maxWager, "Wager out of range");

        lastChad.spendCells(tokenId, wager);

        bytes32 seed = keccak256(abi.encodePacked(
            tokenId, wager, block.prevrandao, block.timestamp, msg.sender
        ));
        // 40 out of 100 = 40% win chance
        bool won = uint256(seed) % 100 < 40;

        if (won) {
            lastChad.awardCells(tokenId, wager * 2);
        }

        emit CoinFlip(tokenId, msg.sender, wager, won, seed);
    }

    // ── Path 2: oracle-signed game resolution ────────────────────────────────
    /// @notice Settle any off-chain game (blackjack, poker, etc.).
    ///         The Worker signs keccak256(tokenId, wager, payout, gameId, nonce, player).
    ///         Spends `wager` cells; if payout > 0 awards that many cells back.
    /// @param gameId  Identifier for the game type (e.g. 1=blackjack, 2=poker).
    /// @param nonce   Unique value per game session — prevents signature replay.
    /// @param payout  Cells to award on win (0 = player lost, wager*2 = double-or-nothing).
    function resolveGame(
        uint256 tokenId,
        uint256 wager,
        uint256 payout,
        uint8   gameId,
        uint256 nonce,
        bytes calldata oracleSig
    ) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!lastChad.eliminated(tokenId), "Chad eliminated");
        require(!lastChad.isActive(tokenId), "Token active in quest/arcade");
        require(wager > 0, "Invalid wager");
        require(!usedNonces[nonce], "Nonce already used");

        bytes32 message = keccak256(abi.encodePacked(
            tokenId, wager, payout, gameId, nonce, msg.sender
        ));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(message);
        address signer  = ECDSA.recover(ethHash, oracleSig);
        require(signer == oracle, "Invalid oracle signature");

        usedNonces[nonce] = true;
        lastChad.spendCells(tokenId, wager);
        if (payout > 0) {
            lastChad.awardCells(tokenId, payout);
        }

        emit GameResolved(tokenId, msg.sender, gameId, wager, payout);
    }

    // ── Path 3: two-tx settlement (poker, craps) ───────────────────────────
    /// @notice TX 1 — Player commits cells before the game starts.
    ///         Cells are spent immediately. Returns a nonce for the session.
    function commitWager(uint256 tokenId, uint256 wager) external returns (uint256) {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!lastChad.eliminated(tokenId), "Chad eliminated");
        require(!lastChad.isActive(tokenId), "Token active in quest/arcade");
        require(wager >= minWager && wager <= maxWager, "Wager out of range");

        uint256 nonce = nextNonce++;
        wagerAmounts[nonce] = wager;
        wagerPlayers[nonce] = msg.sender;
        lastChad.spendCells(tokenId, wager);

        emit WagerCommitted(tokenId, msg.sender, wager, nonce);
        return nonce;
    }

    /// @notice TX 2 — Player claims winnings after the Worker signs the result.
    ///         Only called on a win (payout > 0). Losses need no TX 2.
    function claimWinnings(
        uint256 tokenId,
        uint256 payout,
        uint256 nonce,
        bytes calldata oracleSig
    ) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!lastChad.eliminated(tokenId), "Chad eliminated");
        require(wagerAmounts[nonce] > 0, "No active wager");
        require(wagerPlayers[nonce] == msg.sender, "Not wager owner");
        require(!usedNonces[nonce], "Already claimed");
        require(payout <= wagerAmounts[nonce] * maxPayoutMultiplier, "Payout exceeds cap");

        bytes32 message = keccak256(abi.encodePacked(
            tokenId, payout, nonce, msg.sender
        ));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(message);
        address signer  = ECDSA.recover(ethHash, oracleSig);
        require(signer == oracle, "Invalid oracle signature");

        usedNonces[nonce] = true;
        delete wagerAmounts[nonce];
        delete wagerPlayers[nonce];

        if (payout > 0) {
            lastChad.awardCells(tokenId, payout);
        }

        emit WinningsClaimed(tokenId, msg.sender, payout, nonce);
    }
}
