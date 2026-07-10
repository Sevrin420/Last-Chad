// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IMembersOnly {
    function ownerOf(uint256 tokenId) external view returns (address);
    function isActive(uint256 tokenId) external view returns (bool);
}

interface IMembersOnlyItems {
    function burnChips(address from, uint256 amount) external;
    function mintChips(address to, uint256 amount) external;
}

/// @title Gamble — chip-wagering games for Members Only
///
/// Three settlement paths:
///   1. flip()        — fully on-chain coin flip (40% win, 2x payout).
///   2. resolveGame() — oracle-signed settlement for any off-chain game
///                      (blackjack, poker, etc.). The Cloudflare Worker
///                      runs game logic and signs (tokenId, wager, payout,
///                      gameId, nonce, player). The contract verifies and
///                      settles chips atomically.
///   3. commitWager() / claimWinnings() — two-tx settlement for craps, poker.
///
/// Must be authorized in MembersOnlyItems: items.setGameContract(gambleAddress, true)
contract Gamble {
    IMembersOnly      public immutable membersOnly;
    IMembersOnlyItems public immutable items;
    address           public immutable gameOwner;
    address           public oracle;

    uint256 public minWager = 1;
    uint256 public maxWager = 500;
    uint256 public maxPayoutMultiplier = 20; // payout cap: wager * multiplier

    // Prevent oracle signature replay
    mapping(uint256 => bool) public usedNonces;

    // Two-tx settlement (poker, craps, etc.)
    mapping(uint256 => uint256) public wagerAmounts;  // nonce => wager
    mapping(uint256 => address) public wagerPlayers;   // nonce => player
    uint256 public nextNonce;

    // ── Events ──────────────────────────────────────────────────────────────
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
    constructor(address membersOnlyAddress, address itemsAddress, address _oracle) {
        require(_oracle != address(0), "Oracle required");
        membersOnly = IMembersOnly(membersOnlyAddress);
        items       = IMembersOnlyItems(itemsAddress);
        gameOwner   = msg.sender;
        oracle      = _oracle;
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

    // ── Path 1: oracle-signed game resolution ────────────────────────────────
    /// @notice Settle any off-chain game (blackjack, poker, etc.).
    ///         The Worker signs keccak256(tokenId, wager, payout, gameId, nonce, player).
    ///         Spends `wager` chips; if payout > 0 awards that many chips back.
    function resolveGame(
        uint256 tokenId,
        uint256 wager,
        uint256 payout,
        uint8   gameId,
        uint256 nonce,
        bytes calldata oracleSig
    ) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!membersOnly.isActive(tokenId), "Token is active");
        require(wager > 0, "Invalid wager");
        require(!usedNonces[nonce], "Nonce already used");

        bytes32 message = keccak256(abi.encodePacked(
            tokenId, wager, payout, gameId, nonce, msg.sender
        ));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(message);
        address signer  = ECDSA.recover(ethHash, oracleSig);
        require(signer == oracle, "Invalid oracle signature");

        usedNonces[nonce] = true;
        items.burnChips(msg.sender, wager);
        if (payout > 0) {
            items.mintChips(msg.sender, payout);
        }

        emit GameResolved(tokenId, msg.sender, gameId, wager, payout);
    }

    // ── Path 2: two-tx settlement (poker, craps) ───────────────────────────
    /// @notice TX 1 — Player commits chips before the game starts.
    ///         Chips are spent immediately. Returns a nonce for the session.
    function commitWager(uint256 tokenId, uint256 wager) external returns (uint256) {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!membersOnly.isActive(tokenId), "Token is active");
        require(wager >= minWager && wager <= maxWager, "Wager out of range");

        uint256 nonce = nextNonce++;
        wagerAmounts[nonce] = wager;
        wagerPlayers[nonce] = msg.sender;
        items.burnChips(msg.sender, wager);

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
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
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
            items.mintChips(msg.sender, payout);
        }

        emit WinningsClaimed(tokenId, msg.sender, payout, nonce);
    }

    // ── The Cage: buy-in / cash-out ──────────────────────────────────────────
    // Withdraw chips from your wallet into a play session (chips are BURNED now);
    // gamble with that stack; return the remainder at the cage. Anything you don't
    // cash out stays burned — i.e. all lost chips are burnt.
    uint256 public cageLimit = 1_000_000;   // max chips per buy-in (owner-tunable)

    event CageBuyIn(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce);
    event CageCashOut(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce);

    function setCageLimit(uint256 limit) external onlyGameOwner {
        require(limit > 0, "Limit must be > 0");
        cageLimit = limit;
    }

    /// @notice Buy in at the cage: burns `amount` chips and opens a play session.
    ///         The Worker credits your off-chain stack against the returned nonce.
    function cageBuyIn(uint256 tokenId, uint256 amount) external returns (uint256) {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!membersOnly.isActive(tokenId), "Token is active");
        require(amount > 0 && amount <= cageLimit, "Amount out of range");

        uint256 nonce = nextNonce++;
        items.burnChips(msg.sender, amount);

        emit CageBuyIn(tokenId, msg.sender, amount, nonce);
        return nonce;
    }

    /// @notice Cash out at the cage: mints your remaining stack back to your wallet.
    ///         The Worker signs keccak256(tokenId, amount, nonce, player) for the
    ///         balance you're leaving with; losses are never re-minted.
    function cageCashOut(
        uint256 tokenId,
        uint256 amount,
        uint256 nonce,
        bytes calldata oracleSig
    ) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!usedNonces[nonce], "Nonce already used");

        bytes32 message = keccak256(abi.encodePacked(tokenId, amount, nonce, msg.sender));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(message);
        require(ECDSA.recover(ethHash, oracleSig) == oracle, "Invalid oracle signature");

        usedNonces[nonce] = true;
        if (amount > 0) {
            items.mintChips(msg.sender, amount);
        }

        emit CageCashOut(tokenId, msg.sender, amount, nonce);
    }
}
