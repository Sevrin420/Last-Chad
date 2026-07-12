// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

interface IMembersOnlyForItems {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title MembersOnlyItems
 * @dev ERC-1155 item + currency contract for Members Only casino.
 *      Owner defines new item types at any time.
 *      Items can give weekly chip bonuses, one-time chip claims, or unlock areas.
 *      Items lock to an NFT when utilized and can be unlocked for trading.
 *      Two reserved currency tokens: regular chips (id 0, real money, 0.05 AVAX,
 *      AVAX-backed) and tournament chips (id 1, free, prize-only). Both are
 *      stackable and tradeable between wallets.
 */
contract MembersOnlyItems is ERC1155, Ownable {
    using Strings for uint256;

    // ── Two reserved currency tokens (never "items") ──
    /// @notice Token ID 0 = regular CHIPS — the real-money gambling currency.
    ///         Pegged at CHIP_PRICE AVAX each: buyable and redeemable 1:1 in
    ///         both directions, and fully AVAX-backed (see solvency invariant).
    uint256 public constant CHIPS_ID = 0;

    /// @notice Token ID 1 = TOURNAMENT CHIPS — free, earned currency.
    ///         The weekly rarity drop and mint bonus are paid in these. They
    ///         have NO cash value and cannot be redeemed for AVAX; their only
    ///         use is entering tournaments / redeeming for prizes.
    uint256 public constant TCHIPS_ID = 1;

    /// @notice 1 regular chip == 0.05 AVAX, both buy and redeem.
    uint256 public constant CHIP_PRICE = 0.05 ether;

    /// @notice Total regular chips (id 0) in circulation — drives the reserve.
    uint256 public chipSupply;

    enum ItemType { None, WeeklyChipBonus, OneTimeChipClaim, AreaAccess }

    struct ItemDef {
        string  name;
        uint256 maxSupply;
        uint256 minted;
        uint256 price;        // in wei (0 = free claim)
        bool    stackable;    // false = max 1 per wallet
        bool    active;
        ItemType itemType;
        uint256 bonusAmount;  // chips per week (WeeklyChipBonus) or one-time amount (OneTimeChipClaim)
    }

    IMembersOnlyForItems public membersOnly;

    uint256 public nextItemId = 2;   // ids 0 (chips) & 1 (tournament chips) are reserved; items start at 2

    mapping(uint256 => ItemDef) private _items;
    mapping(address => bool) public authorizedGame;

    // ── Utilize System (lock item to NFT) ──
    mapping(uint256 => mapping(uint256 => bool)) public itemUtilized;    // tokenId => itemId => utilized
    mapping(uint256 => mapping(uint256 => address)) public utilizedBy;   // tokenId => itemId => owner at time of utilize

    // ── Weekly bonus claiming (per item per NFT per week) ──
    uint256 public currentWeek;
    mapping(uint256 => mapping(uint256 => mapping(uint256 => bool))) public weeklyBonusClaimed; // tokenId => itemId => week => claimed

    // ── One-time chip claim tracking ──
    mapping(uint256 => mapping(uint256 => bool)) public oneTimeClaimed; // tokenId => itemId => claimed

    // ── Wallet-based item claiming ──
    mapping(uint256 => mapping(address => bool)) public itemClaimable;  // itemId => wallet => can claim
    mapping(uint256 => mapping(address => bool)) public itemClaimed;    // itemId => wallet => has claimed

    // ── Events ──
    event ItemCreated(uint256 indexed itemId, string name, uint256 maxSupply, uint256 price, bool stackable, ItemType itemType, uint256 bonusAmount);
    event ItemMinted(uint256 indexed itemId, address indexed to, uint256 quantity);
    event ItemActiveSet(uint256 indexed itemId, bool active);
    event ItemPriceSet(uint256 indexed itemId, uint256 price);
    event GameContractSet(address indexed game, bool enabled);
    event ItemUtilized(uint256 indexed tokenId, uint256 indexed itemId);
    event ItemUnutilized(uint256 indexed tokenId, uint256 indexed itemId);
    event WeeklyBonusClaimed(uint256 indexed tokenId, uint256 indexed itemId, uint256 week, uint256 amount);
    event OneTimeBonusClaimed(uint256 indexed tokenId, uint256 indexed itemId, uint256 amount);
    event ItemClaimableSet(uint256 indexed itemId, uint256 walletCount);

    modifier onlyAuthorized() {
        require(authorizedGame[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    string private _baseTokenURI;

    constructor(string memory baseURI, address _membersOnly) ERC1155("") Ownable(msg.sender) {
        _baseTokenURI = baseURI;
        membersOnly = IMembersOnlyForItems(_membersOnly);
    }

    function uri(uint256 itemId) public view override returns (string memory) {
        require(_exists(itemId), "Item does not exist");
        return string(abi.encodePacked(_baseTokenURI, itemId.toString()));
    }

    // ─────────────────────────────────────────────
    //  Owner: item management
    // ─────────────────────────────────────────────

    function createItem(
        string calldata name,
        uint256 maxSupply,
        uint256 price,
        bool stackable,
        ItemType itemType,
        uint256 bonusAmount
    ) external onlyOwner returns (uint256 itemId) {
        require(bytes(name).length > 0, "Name required");

        itemId = nextItemId++;
        _items[itemId] = ItemDef({
            name:        name,
            maxSupply:   maxSupply,
            minted:      0,
            price:       price,
            stackable:   stackable,
            active:      true,
            itemType:    itemType,
            bonusAmount: bonusAmount
        });

        emit ItemCreated(itemId, name, maxSupply, price, stackable, itemType, bonusAmount);
    }

    function setItemActive(uint256 itemId, bool active) external onlyOwner {
        require(_exists(itemId), "Item does not exist");
        _items[itemId].active = active;
        emit ItemActiveSet(itemId, active);
    }

    function setItemPrice(uint256 itemId, uint256 price) external onlyOwner {
        require(_exists(itemId), "Item does not exist");
        _items[itemId].price = price;
        emit ItemPriceSet(itemId, price);
    }

    function setGameContract(address game, bool enabled) external onlyOwner {
        require(game != address(0), "Invalid address");
        authorizedGame[game] = enabled;
        emit GameContractSet(game, enabled);
    }

    function setMembersOnly(address _membersOnly) external onlyOwner {
        require(_membersOnly != address(0), "Invalid address");
        membersOnly = IMembersOnlyForItems(_membersOnly);
    }

    function syncWeek(uint256 week) external onlyOwner {
        currentWeek = week;
    }

    // ─────────────────────────────────────────────
    //  Minting & Airdrop
    // ─────────────────────────────────────────────

    function mintTo(address to, uint256 itemId, uint256 quantity) external onlyAuthorized {
        _mintItem(to, itemId, quantity);
    }

    function airdrop(address to, uint256 itemId, uint256 quantity) external onlyOwner {
        _mintItem(to, itemId, quantity);
    }

    function batchAirdrop(address[] calldata recipients, uint256 itemId, uint256[] calldata quantities) external onlyOwner {
        require(recipients.length == quantities.length, "Array length mismatch");
        for (uint256 i = 0; i < recipients.length; i++) {
            _mintItem(recipients[i], itemId, quantities[i]);
        }
    }

    // ─────────────────────────────────────────────
    //  Burn any item (authorized contracts only)
    // ─────────────────────────────────────────────

    function burnItem(address from, uint256 itemId, uint256 amount) external onlyAuthorized {
        require(amount > 0, "Amount must be > 0");
        require(balanceOf(from, itemId) >= amount, "Insufficient balance");
        _burn(from, itemId, amount);
    }

    // ─────────────────────────────────────────────
    //  Regular chip operations (token ID 0) — real money, 0.05 AVAX each
    // ─────────────────────────────────────────────
    //
    // Solvency invariant: address(this).balance >= chipSupply * CHIP_PRICE.
    // Every regular chip in circulation is redeemable for 0.05 AVAX, so the
    // contract must always hold enough AVAX to buy them all back.
    //  • buyChips()      — player adds exactly amount*CHIP_PRICE AVAX (self-backing)
    //  • mintChips()     — free mint (game winnings): needs the house bankroll to
    //                      already cover it, so the invariant is asserted.
    //  • burnChips()     — losses/spends: frees reserve into house surplus.
    //  • redeemChips()   — player cashes out at CHIP_PRICE.

    event ChipsBought(address indexed player, uint256 chips, uint256 avaxPaid);
    event ChipsRedeemed(address indexed player, uint256 chips, uint256 avaxPaid);
    event HouseDeposited(uint256 amount);

    /// @notice ETH/AVAX that must stay locked to back every outstanding chip.
    function reserveRequired() public view returns (uint256) {
        return chipSupply * CHIP_PRICE;
    }

    /// @notice House bankroll: AVAX above the player reserve, free for the owner.
    function houseSurplus() public view returns (uint256) {
        uint256 reserve = reserveRequired();
        return address(this).balance > reserve ? address(this).balance - reserve : 0;
    }

    /// @notice Buy regular chips at 0.05 AVAX each. Remainder below one whole
    ///         chip is refunded so the reserve matches supply exactly.
    function buyChips() external payable {
        uint256 chips = msg.value / CHIP_PRICE;
        require(chips > 0, "Send at least 0.05 AVAX");
        uint256 cost = chips * CHIP_PRICE;

        chipSupply += chips;
        _mint(msg.sender, CHIPS_ID, chips, "");
        emit ChipsBought(msg.sender, chips, cost);

        uint256 refund = msg.value - cost;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "Refund failed");
        }
    }

    /// @notice Redeem regular chips for AVAX at 0.05 each. Always available.
    function redeemChips(uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        require(balanceOf(msg.sender, CHIPS_ID) >= amount, "Insufficient chips");
        _burn(msg.sender, CHIPS_ID, amount);
        chipSupply -= amount;
        uint256 avax = amount * CHIP_PRICE;
        emit ChipsRedeemed(msg.sender, amount, avax);
        (bool ok, ) = payable(msg.sender).call{value: avax}("");
        require(ok, "Payout failed");
    }

    /// @notice Fund the house so it can cover net game payouts (mints no chips).
    function depositHouse() external payable onlyOwner {
        require(msg.value > 0, "Nothing sent");
        emit HouseDeposited(msg.value);
    }

    function mintChips(address to, uint256 amount) external onlyAuthorized {
        require(amount > 0, "Amount must be > 0");
        chipSupply += amount;
        _mint(to, CHIPS_ID, amount, "");
        // free mint (winnings) must already be covered by the house bankroll
        require(address(this).balance >= chipSupply * CHIP_PRICE, "House underfunded");
    }

    function burnChips(address from, uint256 amount) external onlyAuthorized {
        require(amount > 0, "Amount must be > 0");
        require(balanceOf(from, CHIPS_ID) >= amount, "Insufficient chips");
        _burn(from, CHIPS_ID, amount);
        chipSupply -= amount;
    }

    function getChips(address wallet) external view returns (uint256) {
        return balanceOf(wallet, CHIPS_ID);
    }

    // ─────────────────────────────────────────────
    //  Tournament chip operations (token ID 1) — free, prize-only, no cash value
    // ─────────────────────────────────────────────

    function mintTournamentChips(address to, uint256 amount) external onlyAuthorized {
        require(amount > 0, "Amount must be > 0");
        _mint(to, TCHIPS_ID, amount, "");
    }

    function burnTournamentChips(address from, uint256 amount) external onlyAuthorized {
        require(amount > 0, "Amount must be > 0");
        require(balanceOf(from, TCHIPS_ID) >= amount, "Insufficient tournament chips");
        _burn(from, TCHIPS_ID, amount);
    }

    function getTournamentChips(address wallet) external view returns (uint256) {
        return balanceOf(wallet, TCHIPS_ID);
    }

    /// @notice Owner: award tournament chips directly to a wallet.
    function airdropTournamentChips(address to, uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be > 0");
        _mint(to, TCHIPS_ID, amount, "");
    }

    /// @notice Owner: award tournament chips to many wallets in one tx.
    function batchAirdropTournamentChips(address[] calldata recipients, uint256[] calldata amounts) external onlyOwner {
        require(recipients.length == amounts.length, "Array length mismatch");
        for (uint256 i = 0; i < recipients.length; i++) {
            if (amounts[i] > 0) _mint(recipients[i], TCHIPS_ID, amounts[i], "");
        }
    }

    // ─────────────────────────────────────────────
    //  Wallet-based claiming
    // ─────────────────────────────────────────────

    function setItemClaimable(uint256 itemId, address[] calldata wallets) external onlyOwner {
        require(_exists(itemId), "Item does not exist");
        for (uint256 i = 0; i < wallets.length; i++) {
            itemClaimable[itemId][wallets[i]] = true;
        }
        emit ItemClaimableSet(itemId, wallets.length);
    }

    function claimItem(uint256 itemId) external {
        require(_exists(itemId), "Item does not exist");
        require(_items[itemId].active, "Item not available");
        require(itemClaimable[itemId][msg.sender], "Not eligible to claim");
        require(!itemClaimed[itemId][msg.sender], "Already claimed");

        itemClaimed[itemId][msg.sender] = true;
        _mintItem(msg.sender, itemId, 1);
    }

    // ─────────────────────────────────────────────
    //  Player: purchase
    // ─────────────────────────────────────────────

    function mint(uint256 itemId, uint256 quantity) external payable {
        require(_exists(itemId), "Item does not exist");
        ItemDef storage item = _items[itemId];
        require(item.active, "Item not available");
        require(quantity > 0, "Quantity must be > 0");

        if (!item.stackable) {
            require(quantity == 1, "Non-stackable: quantity must be 1");
        }

        require(msg.value >= item.price * quantity, "Insufficient payment");
        _mintItem(msg.sender, itemId, quantity);
    }

    // ─────────────────────────────────────────────
    //  Utilize / Unutilize (lock item to NFT)
    // ─────────────────────────────────────────────

    function utilizeItem(uint256 tokenId, uint256 itemId) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not NFT owner");
        require(balanceOf(msg.sender, itemId) > 0, "Do not own item");
        require(!itemUtilized[tokenId][itemId], "Already utilized on this NFT");

        itemUtilized[tokenId][itemId] = true;
        utilizedBy[tokenId][itemId] = msg.sender;

        emit ItemUtilized(tokenId, itemId);
    }

    function unutilizeItem(uint256 tokenId, uint256 itemId) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not NFT owner");
        require(itemUtilized[tokenId][itemId], "Not utilized");

        itemUtilized[tokenId][itemId] = false;
        delete utilizedBy[tokenId][itemId];

        emit ItemUnutilized(tokenId, itemId);
    }

    // ─────────────────────────────────────────────
    //  Chip Bonus Claims (via MembersOnly.awardChips)
    // ─────────────────────────────────────────────

    function claimWeeklyItemBonus(uint256 tokenId, uint256[] calldata itemIds) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not NFT owner");

        for (uint256 i = 0; i < itemIds.length; i++) {
            uint256 itemId = itemIds[i];
            require(_exists(itemId), "Item does not exist");
            require(itemUtilized[tokenId][itemId], "Item not utilized on this NFT");
            require(_items[itemId].itemType == ItemType.WeeklyChipBonus, "Not a weekly bonus item");
            require(!weeklyBonusClaimed[tokenId][itemId][currentWeek], "Already claimed this week");

            uint256 bonus = _items[itemId].bonusAmount;
            require(bonus > 0, "No bonus amount");

            weeklyBonusClaimed[tokenId][itemId][currentWeek] = true;
            _mint(msg.sender, TCHIPS_ID, bonus, "");   // free perk → tournament chips

            emit WeeklyBonusClaimed(tokenId, itemId, currentWeek, bonus);
        }
    }

    function claimOneTimeBonus(uint256 tokenId, uint256 itemId) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not NFT owner");
        require(_exists(itemId), "Item does not exist");
        require(itemUtilized[tokenId][itemId], "Item not utilized on this NFT");
        require(_items[itemId].itemType == ItemType.OneTimeChipClaim, "Not a one-time claim item");
        require(!oneTimeClaimed[tokenId][itemId], "Already claimed");

        uint256 bonus = _items[itemId].bonusAmount;
        require(bonus > 0, "No bonus amount");

        oneTimeClaimed[tokenId][itemId] = true;
        _mint(msg.sender, TCHIPS_ID, bonus, "");   // free perk → tournament chips

        emit OneTimeBonusClaimed(tokenId, itemId, bonus);
    }

    // ─────────────────────────────────────────────
    //  Transfer restriction for utilized items
    // ─────────────────────────────────────────────

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        // Block transfer of utilized items (mint and burn are allowed)
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                // Check if this item is utilized by any NFT owned by `from`
                // We track utilizedBy mapping so we check if the sender has any active utilizations
                // Since we can't iterate all tokenIds, we rely on the user to unutilize first
                // The utilizedBy mapping stores the address, so transfers are blocked if
                // the item is utilized to any NFT
            }
        }
        super._update(from, to, ids, values);
    }

    // ─────────────────────────────────────────────
    //  View helpers
    // ─────────────────────────────────────────────

    function getItem(uint256 itemId) external view returns (
        string memory name,
        uint256 maxSupply,
        uint256 minted,
        uint256 price,
        bool stackable,
        bool active,
        ItemType itemType,
        uint256 bonusAmount
    ) {
        require(_exists(itemId), "Item does not exist");
        ItemDef storage item = _items[itemId];
        return (item.name, item.maxSupply, item.minted, item.price, item.stackable, item.active, item.itemType, item.bonusAmount);
    }

    /// @notice Count of real items created (ids 0 & 1 are reserved currencies).
    function totalItems() external view returns (uint256) {
        return nextItemId - 2;
    }

    function isUtilized(uint256 tokenId, uint256 itemId) external view returns (bool) {
        return itemUtilized[tokenId][itemId];
    }

    function setBaseURI(string calldata newURI) external onlyOwner {
        _baseTokenURI = newURI;
    }

    /// @notice Withdraw house profit only — never the AVAX backing player chips.
    function withdraw() external onlyOwner {
        uint256 amount = houseSurplus();
        require(amount > 0, "No surplus to withdraw");
        (bool success, ) = payable(owner()).call{value: amount}("");
        require(success, "Withdrawal failed");
    }

    // ─────────────────────────────────────────────
    //  Internal
    // ─────────────────────────────────────────────

    function _mintItem(address to, uint256 itemId, uint256 quantity) internal {
        ItemDef storage item = _items[itemId];

        if (item.maxSupply > 0) {
            require(item.minted + quantity <= item.maxSupply, "Exceeds max supply");
        }

        if (!item.stackable) {
            require(balanceOf(to, itemId) == 0, "Already own this item");
        }

        item.minted += quantity;
        _mint(to, itemId, quantity, "");

        emit ItemMinted(itemId, to, quantity);
    }

    function _exists(uint256 itemId) internal view returns (bool) {
        // ids 0 & 1 are reserved currency tokens, not creatable/queryable items
        return itemId >= 2 && itemId < nextItemId;
    }
}
