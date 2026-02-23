// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
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

    // ========== STATE ==========

    /// @notice Fee in basis points charged on each sale (default 2.5%)
    uint256 public feeBps = 250;

    /// @notice Total fees collected, withdrawable by owner
    uint256 public accumulatedFees;

    /// @notice NFT contracts allowed to be listed on this market
    mapping(address => bool) public approvedContracts;

    /// @notice All active and past listings: nftContract => tokenId => Listing
    mapping(address => mapping(uint256 => Listing)) public listings;

    // ========== EVENTS ==========

    event ContractApproved(address indexed nftContract, bool approved);
    event FeeUpdated(uint256 newFeeBps);
    event FeesWithdrawn(uint256 amount);
    event Listed(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 price);
    event Delisted(address indexed nftContract, uint256 indexed tokenId, address seller);
    event Sold(address indexed nftContract, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price);

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
     * @notice Owner can delist any listing (e.g. if NFT was stolen or contract revoked).
     */
    function adminDelist(address nftContract, uint256 tokenId) external onlyOwner {
        Listing storage l = listings[nftContract][tokenId];
        require(l.active, "Market: not listed");
        l.active = false;
        emit Delisted(nftContract, tokenId, l.seller);
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

    // ========== VIEW ==========

    function getListing(address nftContract, uint256 tokenId)
        external view returns (Listing memory)
    {
        return listings[nftContract][tokenId];
    }

    function isApprovedContract(address nftContract) external view returns (bool) {
        return approvedContracts[nftContract];
    }
}
