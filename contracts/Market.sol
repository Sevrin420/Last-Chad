// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Market
 * @notice NFT marketplace for Last Chad. Supports any approved ERC-721 contract.
 *         Owner can add/remove NFT contracts and adjust the marketplace fee.
 */
contract Market is Ownable, ReentrancyGuard {

    // ========== STRUCTS ==========

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;   // wei (AVAX)
        bool    active;
    }

    struct Listing1155 {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 amount;  // tokens being sold (1 for non-stackable items)
        uint256 price;   // per-token price in wei
        bool    active;
    }

    // ========== STATE ==========

    /// @notice Fee in basis points charged on each sale (default 5%)
    uint256 public feeBps = 500;

    /// @notice Total fees collected, withdrawable by owner
    uint256 public accumulatedFees;

    /// @notice NFT contracts allowed to be listed on this market
    mapping(address => bool) public approvedContracts;

    /// @notice ERC-721 listings: nftContract => tokenId => Listing
    mapping(address => mapping(uint256 => Listing)) public listings;

    /// @notice ERC-1155 listings: nftContract => tokenId => seller => Listing1155
    mapping(address => mapping(uint256 => mapping(address => Listing1155))) public listings1155;

    // ========== EVENTS ==========

    event ContractApproved(address indexed nftContract, bool approved);
    event FeeUpdated(uint256 newFeeBps);
    event FeesWithdrawn(uint256 amount);
    event Listed(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 price);
    event Delisted(address indexed nftContract, uint256 indexed tokenId, address seller);
    event Sold(address indexed nftContract, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price);

    // ERC-1155 events
    event Listed1155(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 amount, uint256 price);
    event Delisted1155(address indexed nftContract, uint256 indexed tokenId, address seller);
    event Sold1155(address indexed nftContract, uint256 indexed tokenId, address indexed buyer, address seller, uint256 amount, uint256 totalPrice);

    // ========== CONSTRUCTOR ==========

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ========== ADMIN ==========

    /**
     * @notice Add or remove an NFT contract from the approved list.
     *         Call this to enable new NFT projects on the market without redeployment.
     */
    function setApprovedContract(address nftContract, bool approved) external onlyOwner {
        approvedContracts[nftContract] = approved;
        emit ContractApproved(nftContract, approved);
    }

    /**
     * @notice Batch-approve multiple NFT contracts at once.
     */
    function setApprovedContracts(address[] calldata nftContracts, bool approved) external onlyOwner {
        for (uint256 i = 0; i < nftContracts.length; i++) {
            approvedContracts[nftContracts[i]] = approved;
            emit ContractApproved(nftContracts[i], approved);
        }
    }

    /**
     * @notice Update the marketplace fee. Max 10% (1000 bps).
     */
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 1000, "Market: fee too high");
        feeBps = newFeeBps;
        emit FeeUpdated(newFeeBps);
    }

    /**
     * @notice Withdraw accumulated marketplace fees to owner wallet.
     */
    function withdrawFees() external onlyOwner {
        uint256 amount = accumulatedFees;
        require(amount > 0, "Market: nothing to withdraw");
        accumulatedFees = 0;
        payable(owner()).transfer(amount);
        emit FeesWithdrawn(amount);
    }

    /**
     * @notice Owner can delist any ERC-721 listing.
     */
    function adminDelist(address nftContract, uint256 tokenId) external onlyOwner {
        Listing storage l = listings[nftContract][tokenId];
        require(l.active, "Market: not listed");
        l.active = false;
        emit Delisted(nftContract, tokenId, l.seller);
    }

    /**
     * @notice Owner can delist any ERC-1155 listing.
     */
    function adminDelist1155(address nftContract, uint256 tokenId, address seller) external onlyOwner {
        Listing1155 storage l = listings1155[nftContract][tokenId][seller];
        require(l.active, "Market: not listed");
        l.active = false;
        emit Delisted1155(nftContract, tokenId, seller);
    }

    // ========== SELLER ==========

    /**
     * @notice List an NFT for sale.
     *         Caller must first approve this contract via setApprovalForAll or approve().
     * @param nftContract Address of the ERC-721 contract.
     * @param tokenId     Token to list.
     * @param price       Sale price in wei (AVAX).
     */
    function list(address nftContract, uint256 tokenId, uint256 price) external {
        require(approvedContracts[nftContract], "Market: contract not approved");
        require(price > 0, "Market: price must be > 0");

        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Market: not token owner");
        require(
            nft.isApprovedForAll(msg.sender, address(this)) ||
            nft.getApproved(tokenId) == address(this),
            "Market: market not approved to transfer NFT"
        );

        listings[nftContract][tokenId] = Listing({
            seller:      msg.sender,
            nftContract: nftContract,
            tokenId:     tokenId,
            price:       price,
            active:      true
        });

        emit Listed(nftContract, tokenId, msg.sender, price);
    }

    /**
     * @notice Remove your own listing.
     */
    function delist(address nftContract, uint256 tokenId) external {
        Listing storage l = listings[nftContract][tokenId];
        require(l.active, "Market: not listed");
        require(l.seller == msg.sender, "Market: not your listing");
        l.active = false;
        emit Delisted(nftContract, tokenId, msg.sender);
    }

    // ========== BUYER ==========

    /**
     * @notice Purchase a listed NFT. Send exact price or more (overpayment refunded).
     */
    function buy(address nftContract, uint256 tokenId) external payable nonReentrant {
        Listing storage l = listings[nftContract][tokenId];
        require(l.active, "Market: not listed");
        require(msg.value >= l.price, "Market: insufficient payment");

        address seller = l.seller;
        uint256 price  = l.price;
        l.active = false;

        uint256 fee          = (price * feeBps) / 10000;
        uint256 sellerAmount = price - fee;
        accumulatedFees     += fee;

        // Transfer NFT to buyer first (checks-effects-interactions pattern)
        IERC721(nftContract).safeTransferFrom(seller, msg.sender, tokenId);

        // Pay seller
        payable(seller).transfer(sellerAmount);

        // Refund overpayment
        if (msg.value > price) {
            payable(msg.sender).transfer(msg.value - price);
        }

        emit Sold(nftContract, tokenId, msg.sender, seller, price);
    }

    // ========== ERC-1155 SELLER ==========

    /**
     * @notice List ERC-1155 tokens for sale.
     *         Caller must first approve this contract via setApprovalForAll.
     * @param nftContract Address of the ERC-1155 contract.
     * @param tokenId     Item ID to list.
     * @param amount      Number of tokens to sell (1 for non-stackable items).
     * @param price       Price per token in wei.
     */
    function list1155(address nftContract, uint256 tokenId, uint256 amount, uint256 price) external {
        require(approvedContracts[nftContract], "Market: contract not approved");
        require(price > 0, "Market: price must be > 0");
        require(amount > 0, "Market: amount must be > 0");

        IERC1155 nft = IERC1155(nftContract);
        require(nft.balanceOf(msg.sender, tokenId) >= amount, "Market: insufficient balance");
        require(nft.isApprovedForAll(msg.sender, address(this)), "Market: market not approved");

        listings1155[nftContract][tokenId][msg.sender] = Listing1155({
            seller:      msg.sender,
            nftContract: nftContract,
            tokenId:     tokenId,
            amount:      amount,
            price:       price,
            active:      true
        });

        emit Listed1155(nftContract, tokenId, msg.sender, amount, price);
    }

    /**
     * @notice Remove your own ERC-1155 listing.
     */
    function delist1155(address nftContract, uint256 tokenId) external {
        Listing1155 storage l = listings1155[nftContract][tokenId][msg.sender];
        require(l.active, "Market: not listed");
        l.active = false;
        emit Delisted1155(nftContract, tokenId, msg.sender);
    }

    // ========== ERC-1155 BUYER ==========

    /**
     * @notice Purchase some or all of an ERC-1155 listing (partial buys supported).
     *         Send exact total (price × quantity) or more — overpayment is refunded.
     *         Listing persists with reduced amount until fully bought or delisted.
     * @param nftContract Address of the ERC-1155 contract.
     * @param tokenId     Item ID to buy.
     * @param seller      Address of the seller whose listing to purchase from.
     * @param quantity    How many tokens to buy (must be ≤ listing amount).
     */
    function buy1155(address nftContract, uint256 tokenId, address seller, uint256 quantity) external payable nonReentrant {
        Listing1155 storage l = listings1155[nftContract][tokenId][seller];
        require(l.active, "Market: not listed");
        require(quantity > 0 && quantity <= l.amount, "Market: invalid quantity");

        uint256 totalPrice = l.price * quantity;
        require(msg.value >= totalPrice, "Market: insufficient payment");

        address _seller = l.seller;
        uint256 _price  = l.price;

        l.amount -= quantity;
        if (l.amount == 0) l.active = false;

        uint256 fee          = (totalPrice * feeBps) / 10000;
        uint256 sellerAmount = totalPrice - fee;
        accumulatedFees     += fee;

        IERC1155(nftContract).safeTransferFrom(_seller, msg.sender, tokenId, quantity, "");
        payable(_seller).transfer(sellerAmount);

        if (msg.value > totalPrice) {
            payable(msg.sender).transfer(msg.value - totalPrice);
        }

        emit Sold1155(nftContract, tokenId, msg.sender, _seller, quantity, totalPrice);
    }

    // ========== VIEW ==========

    function getListing(address nftContract, uint256 tokenId)
        external view returns (Listing memory)
    {
        return listings[nftContract][tokenId];
    }

    function getListing1155(address nftContract, uint256 tokenId, address seller)
        external view returns (Listing1155 memory)
    {
        return listings1155[nftContract][tokenId][seller];
    }

    function isApprovedContract(address nftContract) external view returns (bool) {
        return approvedContracts[nftContract];
    }
}
