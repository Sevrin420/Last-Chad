// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IItemsPayout {
    function payFromChips(address from, uint256 amount, address recipient) external;
    function CHIP_PRICE() external view returns (uint256);
}

/**
 * @title Tips
 * @dev Routes Club Nile CHIP tips and gallery purchases to their payees, paid
 *      in the AVAX that backs the chips. On each call the payer's regular chips
 *      (MembersOnlyItems id 0) are burned and the equal AVAX is released to the
 *      payee via MembersOnlyItems.payFromChips — so the chip solvency invariant
 *      is preserved and the payee is cashed out in real AVAX.
 *
 *      Payees:
 *        • TEAM     — one owner-set wallet (dealer/house tips). Set once, rarely
 *                     changed.
 *        • CREATORS — an owner-updatable registry keyed by a short id (bytes32),
 *                     covering band songwriters and gallery artists. Wallets can
 *                     be re-pointed at any time as the line-up changes, without
 *                     redeploying — non-team payees are expected to change on an
 *                     ongoing basis.
 *
 *      Tournament TOKENS have no cash value and are never handled here; those
 *      tips stay off-chain / prize-only.
 *
 *      Wiring: deploy with the MembersOnlyItems address + team wallet, then call
 *      MembersOnlyItems.setGameContract(thisTips, true) so this contract may
 *      call payFromChips. Register creator wallets with setCreator / setCreators.
 */
contract Tips is Ownable, ReentrancyGuard {
    IItemsPayout public items;             // MembersOnlyItems (must authorize this contract)
    address public teamWallet;             // dealer / house tips

    /// @notice creatorId => payout wallet. id is a short label, e.g.
    ///         keccak256("band:THE BALLADEER") or keccak256("art:SLOT ONE").
    mapping(bytes32 => address) public creatorWallet;

    event ItemsSet(address indexed items);
    event TeamWalletSet(address indexed wallet);
    event CreatorSet(bytes32 indexed creatorId, address indexed wallet);
    event TeamTip(address indexed from, uint256 chips, uint256 avax, string context);
    event CreatorTip(
        address indexed from, bytes32 indexed creatorId, address indexed wallet,
        uint256 chips, uint256 avax, string category, string item
    );
    event Purchase(
        address indexed from, bytes32 indexed creatorId, address indexed wallet,
        uint256 chips, uint256 avax, string item
    );

    constructor(address _items, address _teamWallet) Ownable(msg.sender) {
        require(_items != address(0), "items zero");
        require(_teamWallet != address(0), "team zero");
        items = IItemsPayout(_items);
        teamWallet = _teamWallet;
    }

    // ─────────────────────────────────────────────
    //  Owner config
    // ─────────────────────────────────────────────

    function setItems(address _items) external onlyOwner {
        require(_items != address(0), "zero");
        items = IItemsPayout(_items);
        emit ItemsSet(_items);
    }

    function setTeamWallet(address wallet) external onlyOwner {
        require(wallet != address(0), "zero");
        teamWallet = wallet;
        emit TeamWalletSet(wallet);
    }

    /// @notice Point (or re-point) a creator id at a payout wallet. Use the zero
    ///         address to retire a creator.
    function setCreator(bytes32 creatorId, address wallet) external onlyOwner {
        creatorWallet[creatorId] = wallet;
        emit CreatorSet(creatorId, wallet);
    }

    /// @notice Batch update the creator registry in one tx.
    function setCreators(bytes32[] calldata ids, address[] calldata wallets) external onlyOwner {
        require(ids.length == wallets.length, "length mismatch");
        for (uint256 i = 0; i < ids.length; i++) {
            creatorWallet[ids[i]] = wallets[i];
            emit CreatorSet(ids[i], wallets[i]);
        }
    }

    // ─────────────────────────────────────────────
    //  Tips & buys — paid in chips, released as AVAX to the payee
    // ─────────────────────────────────────────────

    /// @notice Tip the house/team. `context` is free text for the leaderboard
    ///         (e.g. "dealer:blackjack").
    function tipTeam(uint256 chips, string calldata context) external nonReentrant {
        require(chips > 0, "zero chips");
        uint256 avax = chips * items.CHIP_PRICE();
        items.payFromChips(msg.sender, chips, teamWallet);
        emit TeamTip(msg.sender, chips, avax, context);
    }

    /// @notice Tip a registered creator (band songwriter or gallery artist).
    ///         `category` = "band" | "gallery"; `item` = song/artwork title.
    function tipCreator(bytes32 creatorId, uint256 chips, string calldata category, string calldata item)
        external nonReentrant
    {
        address wallet = creatorWallet[creatorId];
        require(wallet != address(0), "creator unset");
        require(chips > 0, "zero chips");
        uint256 avax = chips * items.CHIP_PRICE();
        items.payFromChips(msg.sender, chips, wallet);
        emit CreatorTip(msg.sender, creatorId, wallet, chips, avax, category, item);
    }

    /// @notice Buy a gallery piece from a registered creator at a chip price the
    ///         caller pays in full to that creator. The piece's delivery (an NFT
    ///         transfer/mint) is handled off this contract for now; this records
    ///         the sale and pays the artist.
    function buyFromCreator(bytes32 creatorId, uint256 chips, string calldata item)
        external nonReentrant
    {
        address wallet = creatorWallet[creatorId];
        require(wallet != address(0), "creator unset");
        require(chips > 0, "zero chips");
        uint256 avax = chips * items.CHIP_PRICE();
        items.payFromChips(msg.sender, chips, wallet);
        emit Purchase(msg.sender, creatorId, wallet, chips, avax, item);
    }
}
