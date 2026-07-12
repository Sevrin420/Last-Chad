// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title TraditionalGambling — real-money casino chips for Rob's Hideout
///
/// A self-contained, ETH-backed chip house for the "traditional" (non-NFT)
/// tables. There is no token gate and no free weekly chips: players buy chips
/// with ETH at a fixed rate, gamble them, and cash out at the same rate.
///
///   1 CHIP = 0.005 ETH   (buy price == cash-out price)
///
/// Chips live in a simple internal ledger (not an ERC-1155). Every chip in
/// circulation is fully backed by ETH held in this contract — the solvency
/// invariant `address(this).balance >= totalChips * CHIP_PRICE` holds after
/// every state change, so a player can always redeem their chips for ETH.
///
/// Settlement mirrors Gamble.sol so the same Cloudflare Worker oracle can run
/// the games (craps, blackjack, roulette) off-chain and sign results:
///   • resolveGame()            — single-tx settle (burn wager, mint payout).
///   • commitWager()/claim()    — two-tx settle for live tables.
///   • cageBuyIn()/cageCashOut() — withdraw a stack into a play session and
///                                 return the remainder at the cage.
///
/// The house bankroll (owner-deposited ETH above the player reserve) covers
/// net payouts; the owner may only withdraw the surplus, never the ETH that
/// backs outstanding player chips.
contract TraditionalGambling is Ownable, ReentrancyGuard, Pausable {
    using MessageHashUtils for bytes32;

    /// @dev Fixed price: 1 chip == 0.005 ETH, both directions.
    uint256 public constant CHIP_PRICE = 0.005 ether;

    address public oracle;

    // Internal chip ledger
    mapping(address => uint256) public chipBalance;
    uint256 public totalChips;                 // sum of all chipBalance — the backed supply

    // Wager guardrails (in chips)
    uint256 public minWager = 1;
    uint256 public maxWager = 2000;
    uint256 public maxPayoutMultiplier = 40;   // payout cap: wager * multiplier

    // Oracle signature replay protection
    mapping(uint256 => bool) public usedNonces;

    // Two-tx settlement sessions (live tables)
    mapping(uint256 => uint256) public wagerAmounts;   // nonce => wager
    mapping(uint256 => address) public wagerPlayers;    // nonce => player
    uint256 public nextNonce = 1;

    // ── Events ───────────────────────────────────────────────────────────────
    event ChipsBought(address indexed player, uint256 chips, uint256 ethPaid);
    event ChipsCashedOut(address indexed player, uint256 chips, uint256 ethPaid);
    event GameResolved(address indexed player, uint8 indexed gameId, uint256 wager, uint256 payout, uint256 nonce);
    event WagerCommitted(address indexed player, uint256 wager, uint256 nonce);
    event WinningsClaimed(address indexed player, uint256 payout, uint256 nonce);
    event CageBuyIn(address indexed player, uint256 amount, uint256 nonce);
    event CageCashOut(address indexed player, uint256 amount, uint256 nonce);
    event HouseDeposited(uint256 amount);
    event HouseWithdrawn(uint256 amount);

    constructor(address _oracle) Ownable(msg.sender) {
        require(_oracle != address(0), "Oracle required");
        oracle = _oracle;
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
    }

    function setWagerLimits(uint256 min, uint256 max) external onlyOwner {
        require(min > 0 && max >= min, "Invalid limits");
        minWager = min;
        maxWager = max;
    }

    function setMaxPayoutMultiplier(uint256 mult) external onlyOwner {
        require(mult > 0, "Multiplier must be > 0");
        maxPayoutMultiplier = mult;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ── Solvency accounting ────────────────────────────────────────────────────
    /// @notice ETH that must stay locked to back every outstanding chip.
    function reserveRequired() public view returns (uint256) {
        return totalChips * CHIP_PRICE;
    }

    /// @notice House bankroll: ETH above the player reserve, free for the owner.
    function houseSurplus() public view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 reserve = reserveRequired();
        return bal > reserve ? bal - reserve : 0;
    }

    /// @dev Mint chips to a player, asserting the new supply stays fully backed.
    function _mintChips(address to, uint256 amount) internal {
        chipBalance[to] += amount;
        totalChips += amount;
        // No ETH moved on a mint — the surplus bankroll must already cover it.
        require(address(this).balance >= totalChips * CHIP_PRICE, "House underfunded");
    }

    /// @dev Burn chips from a player.
    function _burnChips(address from, uint256 amount) internal {
        require(chipBalance[from] >= amount, "Insufficient chips");
        chipBalance[from] -= amount;
        totalChips -= amount;
    }

    function _verifyOracle(bytes32 message, bytes calldata sig) internal view {
        require(ECDSA.recover(message.toEthSignedMessageHash(), sig) == oracle, "Invalid oracle signature");
    }

    // ── ETH on-ramp / off-ramp ─────────────────────────────────────────────────
    /// @notice Buy chips at 0.005 ETH each. Any ETH beyond a whole number of
    ///         chips is refunded, so the reserve always matches chips exactly.
    function buyChips() external payable whenNotPaused nonReentrant {
        uint256 chips = msg.value / CHIP_PRICE;
        require(chips > 0, "Send at least 0.005 ETH");
        uint256 cost = chips * CHIP_PRICE;

        chipBalance[msg.sender] += chips;
        totalChips += chips;
        emit ChipsBought(msg.sender, chips, cost);

        uint256 refund = msg.value - cost;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "Refund failed");
        }
    }

    /// @notice Cash out chips for ETH at 0.005 each. Always available (never
    ///         paused) so players can exit at will.
    function cashOut(uint256 chips) external nonReentrant {
        require(chips > 0, "Nothing to cash out");
        _burnChips(msg.sender, chips);
        uint256 eth = chips * CHIP_PRICE;
        emit ChipsCashedOut(msg.sender, chips, eth);
        (bool ok, ) = payable(msg.sender).call{value: eth}("");
        require(ok, "Payout failed");
    }

    // ── Path 1: single-tx oracle settlement ─────────────────────────────────────
    /// @notice Settle an off-chain game. The Worker signs
    ///         keccak256(player, wager, payout, gameId, nonce, address(this)).
    ///         Burns `wager` chips, mints `payout` chips (0 = a loss).
    function resolveGame(
        uint256 wager,
        uint256 payout,
        uint8   gameId,
        uint256 nonce,
        bytes calldata oracleSig
    ) external whenNotPaused nonReentrant {
        require(wager >= minWager && wager <= maxWager, "Wager out of range");
        require(payout <= wager * maxPayoutMultiplier, "Payout exceeds cap");
        require(!usedNonces[nonce], "Nonce already used");

        bytes32 message = keccak256(abi.encodePacked(msg.sender, wager, payout, gameId, nonce, address(this)));
        _verifyOracle(message, oracleSig);

        usedNonces[nonce] = true;
        _burnChips(msg.sender, wager);
        if (payout > 0) _mintChips(msg.sender, payout);

        emit GameResolved(msg.sender, gameId, wager, payout, nonce);
    }

    // ── Path 2: two-tx settlement (live craps / poker) ──────────────────────────
    /// @notice TX 1 — commit chips before the hand. Chips are burned now; the
    ///         returned nonce keys the session.
    function commitWager(uint256 wager) external whenNotPaused nonReentrant returns (uint256) {
        require(wager >= minWager && wager <= maxWager, "Wager out of range");
        uint256 nonce = nextNonce++;
        wagerAmounts[nonce] = wager;
        wagerPlayers[nonce] = msg.sender;
        _burnChips(msg.sender, wager);
        emit WagerCommitted(msg.sender, wager, nonce);
        return nonce;
    }

    /// @notice TX 2 — claim winnings once the Worker signs
    ///         keccak256(player, payout, nonce, address(this)). Losses need no TX 2.
    function claimWinnings(uint256 payout, uint256 nonce, bytes calldata oracleSig) external nonReentrant {
        require(wagerAmounts[nonce] > 0, "No active wager");
        require(wagerPlayers[nonce] == msg.sender, "Not wager owner");
        require(!usedNonces[nonce], "Already claimed");
        require(payout <= wagerAmounts[nonce] * maxPayoutMultiplier, "Payout exceeds cap");

        bytes32 message = keccak256(abi.encodePacked(msg.sender, payout, nonce, address(this)));
        _verifyOracle(message, oracleSig);

        usedNonces[nonce] = true;
        delete wagerAmounts[nonce];
        delete wagerPlayers[nonce];
        if (payout > 0) _mintChips(msg.sender, payout);

        emit WinningsClaimed(msg.sender, payout, nonce);
    }

    // ── The Cage: buy a stack into a session, return the remainder ─────────────
    /// @notice Withdraw `amount` chips into an off-chain play session (burned now).
    function cageBuyIn(uint256 amount) external whenNotPaused nonReentrant returns (uint256) {
        require(amount > 0, "Amount required");
        uint256 nonce = nextNonce++;
        _burnChips(msg.sender, amount);
        emit CageBuyIn(msg.sender, amount, nonce);
        return nonce;
    }

    /// @notice Return the remaining stack at the cage. The Worker signs
    ///         keccak256(player, amount, nonce, address(this)); lost chips are
    ///         never re-minted.
    function cageCashOut(uint256 amount, uint256 nonce, bytes calldata oracleSig) external nonReentrant {
        require(!usedNonces[nonce], "Nonce already used");
        bytes32 message = keccak256(abi.encodePacked(msg.sender, amount, nonce, address(this)));
        _verifyOracle(message, oracleSig);

        usedNonces[nonce] = true;
        if (amount > 0) _mintChips(msg.sender, amount);
        emit CageCashOut(msg.sender, amount, nonce);
    }

    // ── House bankroll ──────────────────────────────────────────────────────────
    /// @notice Fund the house so it can cover net payouts. Mints no chips.
    function depositHouse() external payable onlyOwner {
        require(msg.value > 0, "Nothing sent");
        emit HouseDeposited(msg.value);
    }

    /// @notice Withdraw house profit. Cannot touch the ETH backing player chips.
    function withdrawHouse(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Nothing to withdraw");
        require(address(this).balance - amount >= reserveRequired(), "Would break chip backing");
        emit HouseWithdrawn(amount);
        (bool ok, ) = payable(owner()).call{value: amount}("");
        require(ok, "Withdraw failed");
    }
}
