// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title LastChadItems
 * @dev ERC-1155 item contract for Last Chad game.
 *      Owner defines new item types at any time — no redeployment needed.
 *      Stackable items allow multiple per wallet.
 *      Non-stackable items are capped at 1 per wallet.
 *      Item effects (stat modifiers etc.) are resolved client-side.
 */
contract LastChadItems is ERC1155, Ownable {
    using Strings for uint256;

    struct ItemDef {
        string  name;
        uint256 maxSupply;
        uint256 minted;
        uint256 price;      // in wei (0 = free claim)
        bool    stackable;  // false = max 1 per wallet
        bool    active;     // owner can pause individual items
    }

    // Item IDs start at 1
    uint256 public nextItemId = 1;

    mapping(uint256 => ItemDef) private _items;
    mapping(address => bool) public authorizedGame;

    event ItemCreated(uint256 indexed itemId, string name, uint256 maxSupply, uint256 price, bool stackable);
    event ItemMinted(uint256 indexed itemId, address indexed to, uint256 quantity);
    event ItemActiveSet(uint256 indexed itemId, bool active);
    event ItemPriceSet(uint256 indexed itemId, uint256 price);
    event GameContractSet(address indexed game, bool enabled);

    modifier onlyAuthorized() {
        require(authorizedGame[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    string private _baseTokenURI;

    constructor(string memory baseURI) ERC1155("") Ownable(msg.sender) {
        _baseTokenURI = baseURI;

        // Item #1 — Cindy's Code
        uint256 itemId = nextItemId++;
        _items[itemId] = ItemDef({
            name:      "Cindy's Code",
            maxSupply: 500,
            minted:    0,
            price:     0,
            stackable: false,
            active:    true
        });
        emit ItemCreated(itemId, "Cindy's Code", 500, 0, false);
    }

    /**
     * @notice Returns the metadata URI for a given item ID.
     *         Resolves to {baseURI}{itemId}
     */
    function uri(uint256 itemId) public view override returns (string memory) {
        require(_exists(itemId), "Item does not exist");
        return string(abi.encodePacked(_baseTokenURI, itemId.toString()));
    }

    // ─────────────────────────────────────────────
    //  Owner: item management
    // ─────────────────────────────────────────────

    /**
     * @notice Define a new item type. Owner only.
     * @param name      Display name of the item.
     * @param maxSupply Total number that can ever exist (0 = unlimited).
     * @param price     Cost in AVAX wei to mint (0 = free).
     * @param stackable Whether a single wallet can hold more than one.
     */
    function createItem(
        string calldata name,
        uint256 maxSupply,
        uint256 price,
        bool stackable
    ) external onlyOwner returns (uint256 itemId) {
        require(bytes(name).length > 0, "Name required");

        itemId = nextItemId++;
        _items[itemId] = ItemDef({
            name:      name,
            maxSupply: maxSupply,
            minted:    0,
            price:     price,
            stackable: stackable,
            active:    true
        });

        emit ItemCreated(itemId, name, maxSupply, price, stackable);
    }

    /**
     * @notice Pause or unpause minting of a specific item.
     */
    function setItemActive(uint256 itemId, bool active) external onlyOwner {
        require(_exists(itemId), "Item does not exist");
        _items[itemId].active = active;
        emit ItemActiveSet(itemId, active);
    }

    /**
     * @notice Update the mint price of an item.
     */
    function setItemPrice(uint256 itemId, uint256 price) external onlyOwner {
        require(_exists(itemId), "Item does not exist");
        _items[itemId].price = price;
        emit ItemPriceSet(itemId, price);
    }

    /**
     * @notice Airdrop items directly to a player. Owner only, ignores price.
     *         Still respects maxSupply and non-stackable rules.
     */
    function setGameContract(address game, bool enabled) external onlyOwner {
        require(game != address(0), "Invalid address");
        authorizedGame[game] = enabled;
        emit GameContractSet(game, enabled);
    }

    /**
     * @notice Mint an item directly to a player. Authorized game contracts only.
     *         Ignores AVAX price — cell-cost is enforced by the calling contract.
     *         Still respects maxSupply and non-stackable rules.
     */
    function mintTo(address to, uint256 itemId, uint256 quantity) external onlyAuthorized {
        _mintItem(to, itemId, quantity);
    }

    function airdrop(address to, uint256 itemId, uint256 quantity) external onlyOwner {
        _mintItem(to, itemId, quantity);
    }

    /**
     * @notice Update base metadata URI.
     */
    function setBaseURI(string calldata newURI) external onlyOwner {
        _baseTokenURI = newURI;
    }

    /**
     * @notice Withdraw all AVAX from item sales.
     */
    function withdraw() external onlyOwner {
        (bool success, ) = payable(owner()).call{value: address(this).balance}("");
        require(success, "Withdrawal failed");
    }

    // ─────────────────────────────────────────────
    //  Player: mint / claim
    // ─────────────────────────────────────────────

    /**
     * @notice Purchase or claim an item.
     * @param itemId   The item to mint.
     * @param quantity How many to mint (must be 1 for non-stackable items).
     */
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
    //  View helpers
    // ─────────────────────────────────────────────

    function getItem(uint256 itemId) external view returns (
        string memory name,
        uint256 maxSupply,
        uint256 minted,
        uint256 price,
        bool stackable,
        bool active
    ) {
        require(_exists(itemId), "Item does not exist");
        ItemDef storage item = _items[itemId];
        return (item.name, item.maxSupply, item.minted, item.price, item.stackable, item.active);
    }

    function totalItems() external view returns (uint256) {
        return nextItemId - 1;
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
