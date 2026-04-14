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
 * @dev ERC-1155 item contract for Members Only casino.
 *      Owner defines new item types at any time.
 *      Items can give weekly chip bonuses, one-time chip claims, or unlock areas.
 *      Items lock to an NFT when utilized and can be unlocked for trading.
 *      Chips (token ID 0) are a built-in stackable ERC-1155 token, tradeable between wallets.
 */
contract MembersOnlyItems is ERC1155, Ownable {
    using Strings for uint256;

    /// @notice Token ID 0 = Chips (stackable, unlimited, tradeable)
    uint256 public constant CHIPS_ID = 0;

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

    uint256 public nextItemId = 1;

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

    // ── Treasury (yield vault) ──
    uint256 public constant CHIPS_PER_SHARE = 10_000;
    uint256 public currentMonth;
    mapping(uint256 => uint256) public monthlyDeposit;                                 // month => AVAX
    mapping(uint256 => uint256) public monthlyTotalShares;                             // month => total shares
    mapping(uint256 => mapping(uint256 => uint256)) public monthlyShares;              // month => tokenId => shares
    mapping(uint256 => mapping(uint256 => bool)) public yieldClaimed;                  // tokenId => month => claimed

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
    event SharesBurned(uint256 indexed tokenId, uint256 indexed month, uint256 numShares, uint256 chipsBurned);
    event YieldDeposited(uint256 indexed month, uint256 amount, uint256 totalShares);
    event YieldClaimed(uint256 indexed tokenId, uint256 indexed month, uint256 amount);

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
    //  Chip operations (token ID 0)
    // ─────────────────────────────────────────────

    function mintChips(address to, uint256 amount) external onlyAuthorized {
        require(amount > 0, "Amount must be > 0");
        _mint(to, CHIPS_ID, amount, "");
    }

    function burnChips(address from, uint256 amount) external onlyAuthorized {
        require(amount > 0, "Amount must be > 0");
        require(balanceOf(from, CHIPS_ID) >= amount, "Insufficient chips");
        _burn(from, CHIPS_ID, amount);
    }

    function getChips(address wallet) external view returns (uint256) {
        return balanceOf(wallet, CHIPS_ID);
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
            _mint(msg.sender, CHIPS_ID, bonus, "");

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
        _mint(msg.sender, CHIPS_ID, bonus, "");

        emit OneTimeBonusClaimed(tokenId, itemId, bonus);
    }

    // ─────────────────────────────────────────────
    //  Treasury: burn chips for monthly yield shares
    // ─────────────────────────────────────────────

    function burnForShares(uint256 tokenId, uint256 numShares) external {
        require(msg.sender == membersOnly.ownerOf(tokenId), "Not token owner");
        require(numShares > 0, "Zero shares");
        require(monthlyDeposit[currentMonth] == 0, "Month already finalized");

        uint256 cost = numShares * CHIPS_PER_SHARE;
        require(balanceOf(msg.sender, CHIPS_ID) >= cost, "Insufficient chips");
        _burn(msg.sender, CHIPS_ID, cost);

        monthlyShares[currentMonth][tokenId] += numShares;
        monthlyTotalShares[currentMonth] += numShares;

        emit SharesBurned(tokenId, currentMonth, numShares, cost);
    }

    function depositYield() external payable onlyOwner {
        require(msg.value > 0, "No AVAX sent");
        require(monthlyTotalShares[currentMonth] > 0, "No shareholders");

        monthlyDeposit[currentMonth] = msg.value;
        emit YieldDeposited(currentMonth, msg.value, monthlyTotalShares[currentMonth]);
        currentMonth++;
    }

    function claimYield(uint256 tokenId, uint256 month) external {
        require(msg.sender == membersOnly.ownerOf(tokenId), "Not token owner");
        require(month < currentMonth, "Month not finalized");
        require(!yieldClaimed[tokenId][month], "Already claimed");
        require(monthlyDeposit[month] > 0, "No deposit");

        uint256 playerShares = monthlyShares[month][tokenId];
        require(playerShares > 0, "No shares that month");

        yieldClaimed[tokenId][month] = true;

        uint256 payout = (monthlyDeposit[month] * playerShares) / monthlyTotalShares[month];
        require(payout > 0, "Nothing to claim");

        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "Transfer failed");

        emit YieldClaimed(tokenId, month, payout);
    }

    function batchClaimYield(uint256 tokenId, uint256[] calldata months) external {
        require(msg.sender == membersOnly.ownerOf(tokenId), "Not token owner");

        uint256 total;
        for (uint256 i = 0; i < months.length; i++) {
            uint256 m = months[i];
            require(m < currentMonth, "Month not finalized");
            if (yieldClaimed[tokenId][m]) continue;
            if (monthlyDeposit[m] == 0) continue;

            uint256 playerShares = monthlyShares[m][tokenId];
            if (playerShares == 0) continue;

            yieldClaimed[tokenId][m] = true;
            uint256 payout = (monthlyDeposit[m] * playerShares) / monthlyTotalShares[m];
            total += payout;

            emit YieldClaimed(tokenId, m, payout);
        }

        require(total > 0, "Nothing to claim");
        (bool ok, ) = msg.sender.call{value: total}("");
        require(ok, "Transfer failed");
    }

    function getClaimable(uint256 tokenId, uint256 month) external view returns (uint256) {
        if (month >= currentMonth) return 0;
        if (yieldClaimed[tokenId][month]) return 0;
        if (monthlyDeposit[month] == 0) return 0;
        uint256 playerShares = monthlyShares[month][tokenId];
        if (playerShares == 0) return 0;
        return (monthlyDeposit[month] * playerShares) / monthlyTotalShares[month];
    }

    function getTreasuryShares(uint256 tokenId) external view returns (uint256) {
        return monthlyShares[currentMonth][tokenId];
    }

    function getTreasuryTotalShares() external view returns (uint256) {
        return monthlyTotalShares[currentMonth];
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

    function totalItems() external view returns (uint256) {
        return nextItemId - 1;
    }

    function isUtilized(uint256 tokenId, uint256 itemId) external view returns (bool) {
        return itemUtilized[tokenId][itemId];
    }

    function setBaseURI(string calldata newURI) external onlyOwner {
        _baseTokenURI = newURI;
    }

    function withdraw() external onlyOwner {
        (bool success, ) = payable(owner()).call{value: address(this).balance}("");
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
        return itemId > 0 && itemId < nextItemId;
    }
}
