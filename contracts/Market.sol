// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface ILastChadElimination {
    function eliminated(uint256 tokenId) external view returns (bool);
}

/**
 * @title Market
 * @notice NFT marketplace for Last Chad. Supports any approved ERC-721 and ERC-1155 contract.
 *
 * Enumeration strategy
 * --------------------
 * Active listings are tracked in per-contract dynamic arrays with a parallel
 * index mapping so that insertion and removal are both O(1) (swap-and-pop).
 * The view getters `getActiveListings` / `getActiveListings1155` let the
 * frontend page through all active listings with a single RPC call per page —
 * no event-log scanning, no block-range limits.
 *
 * Events are still emitted so an off-chain indexer (e.g. The Graph) can be
 * added later for richer queries without any contract changes.
 */
contract Market is Ownable, ReentrancyGuard {

    // ========== STRUCTS ==========

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;  // wei (AVAX)
        bool    active;
    }

    struct Listing1155 {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 amount; // always 1 for non-stackable items
        uint256 price;  // wei (AVAX)
        bool    active;
    }

    /// @dev Key used to look up an ERC-1155 listing in the enumeration array.
    struct Key1155 {
        uint256 tokenId;
        address seller;
    }

    // ========== STATE ==========

    /// @notice Fee in basis points charged on each sale (default 5 %)
    uint256 public feeBps = 500;

    /// @notice Total fees collected, withdrawable by owner
    uint256 public accumulatedFees;

    /// @notice LastChad contract address for elimination checks (address(0) = disabled)
    address public lastChadContract;

    /// @notice NFT contracts allowed to be listed on this market
    mapping(address => bool) public approvedContracts;

    // ----- ERC-721 listings -----

    /// @notice Direct lookup: nftContract => tokenId => Listing
    mapping(address => mapping(uint256 => Listing)) public listings;

    /// @dev Enumeration: nftContract => array of active tokenIds
    mapping(address => uint256[]) private _active721Ids;

    /// @dev Index into _active721Ids (1-based; 0 means "not in array")
    mapping(address => mapping(uint256 => uint256)) private _active721Idx;

    // ----- ERC-1155 listings -----

    /// @notice Direct lookup: nftContract => tokenId => seller => Listing1155
    mapping(address => mapping(uint256 => mapping(address => Listing1155))) public listings1155;

    /// @dev Enumeration: nftContract => array of active (tokenId, seller) pairs
    mapping(address => Key1155[]) private _active1155Keys;

    /// @dev Index into _active1155Keys (1-based; 0 means "not in array")
    mapping(address => mapping(uint256 => mapping(address => uint256))) private _active1155Idx;

    // ========== EVENTS ==========

    event ContractApproved(address indexed nftContract, bool approved);
    event FeeUpdated(uint256 newFeeBps);
    event FeesWithdrawn(uint256 amount);

    event Listed(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 price);
    event Delisted(address indexed nftContract, uint256 indexed tokenId, address seller);
    event Sold(address indexed nftContract, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price);

    event Listed1155(address indexed nftContract, uint256 indexed tokenId, address indexed seller, uint256 amount, uint256 price);
    event Delisted1155(address indexed nftContract, uint256 indexed tokenId, address seller);
    event Sold1155(address indexed nftContract, uint256 indexed tokenId, address indexed buyer, address seller, uint256 amount, uint256 totalPrice);

    // ========== CONSTRUCTOR ==========

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ========== INTERNAL: ENUMERATION HELPERS ==========

    function _addListing721(address nftContract, uint256 tokenId) internal {
        _active721Idx[nftContract][tokenId] = _active721Ids[nftContract].length + 1;
        _active721Ids[nftContract].push(tokenId);
    }

    function _removeListing721(address nftContract, uint256 tokenId) internal {
        uint256 idx  = _active721Idx[nftContract][tokenId] - 1; // convert to 0-based
        uint256[] storage ids = _active721Ids[nftContract];
        uint256 lastId = ids[ids.length - 1];
        ids[idx] = lastId;
        _active721Idx[nftContract][lastId] = idx + 1;
        ids.pop();
        delete _active721Idx[nftContract][tokenId];
    }

    function _addListing1155(address nftContract, uint256 tokenId, address seller) internal {
        _active1155Idx[nftContract][tokenId][seller] = _active1155Keys[nftContract].length + 1;
        _active1155Keys[nftContract].push(Key1155(tokenId, seller));
    }

    function _removeListing1155(address nftContract, uint256 tokenId, address seller) internal {
        uint256 idx = _active1155Idx[nftContract][tokenId][seller] - 1; // 0-based
        Key1155[] storage keys = _active1155Keys[nftContract];
        Key1155 memory lastKey = keys[keys.length - 1];
        keys[idx] = lastKey;
        _active1155Idx[nftContract][lastKey.tokenId][lastKey.seller] = idx + 1;
        keys.pop();
        delete _active1155Idx[nftContract][tokenId][seller];
    }

    // ========== ADMIN ==========

    function setLastChadContract(address _lastChad) external onlyOwner {
        lastChadContract = _lastChad;
    }

    function setApprovedContract(address nftContract, bool approved) external onlyOwner {
        approvedContracts[nftContract] = approved;
        emit ContractApproved(nftContract, approved);
    }

    function setApprovedContracts(address[] calldata nftContracts, bool approved) external onlyOwner {
        for (uint256 i = 0; i < nftContracts.length; i++) {
            approvedContracts[nftContracts[i]] = approved;
            emit ContractApproved(nftContracts[i], approved);
        }
    }

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 1000, "Market: fee too high");
        feeBps = newFeeBps;
        emit FeeUpdated(newFeeBps);
    }

    function withdrawFees() external onlyOwner {
        uint256 amount = accumulatedFees;
        require(amount > 0, "Market: nothing to withdraw");
        accumulatedFees = 0;
        (bool ok,) = payable(owner()).call{value: amount}("");
        require(ok, "Market: transfer failed");
        emit FeesWithdrawn(amount);
    }

    function adminDelist(address nftContract, uint256 tokenId) external onlyOwner {
        Listing storage l = listings[nftContract][tokenId];
        require(l.active, "Market: not listed");
        address seller = l.seller;
        l.active = false;
        _removeListing721(nftContract, tokenId);
        emit Delisted(nftContract, tokenId, seller);
    }

    function adminDelist1155(address nftContract, uint256 tokenId, address seller) external onlyOwner {
        Listing1155 storage l = listings1155[nftContract][tokenId][seller];
        require(l.active, "Market: not listed");
        l.active = false;
        _removeListing1155(nftContract, tokenId, seller);
        emit Delisted1155(nftContract, tokenId, seller);
    }

    // ========== SELLER: ERC-721 ==========

    /**
     * @notice List an ERC-721 NFT for sale.
     *         Caller must approve this contract first (setApprovalForAll or approve).
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

        bool wasListed = listings[nftContract][tokenId].active;

        listings[nftContract][tokenId] = Listing({
            seller:      msg.sender,
            nftContract: nftContract,
            tokenId:     tokenId,
            price:       price,
            active:      true
        });

        // Only add to enumeration array if not already present.
        // Re-listing an already-listed token (price update) reuses the existing slot.
        if (!wasListed) {
            _addListing721(nftContract, tokenId);
        }

        emit Listed(nftContract, tokenId, msg.sender, price);
    }

    function delist(address nftContract, uint256 tokenId) external {
        Listing storage l = listings[nftContract][tokenId];
        require(l.active, "Market: not listed");
        require(l.seller == msg.sender, "Market: not your listing");
        l.active = false;
        _removeListing721(nftContract, tokenId);
        emit Delisted(nftContract, tokenId, msg.sender);
    }

    // ========== BUYER: ERC-721 ==========

    function buy(address nftContract, uint256 tokenId) external payable nonReentrant {
        Listing storage l = listings[nftContract][tokenId];
        require(l.active, "Market: not listed");
        require(msg.value >= l.price, "Market: insufficient payment");

        // Block purchase of eliminated Chads
        if (lastChadContract != address(0) && nftContract == lastChadContract) {
            require(!ILastChadElimination(lastChadContract).eliminated(tokenId), "Market: Chad is eliminated");
        }

        address seller = l.seller;
        uint256 price  = l.price;
        l.active = false;
        _removeListing721(nftContract, tokenId);

        uint256 fee          = (price * feeBps) / 10000;
        uint256 sellerAmount = price - fee;
        accumulatedFees     += fee;

        IERC721(nftContract).safeTransferFrom(seller, msg.sender, tokenId);

        (bool ok1,) = payable(seller).call{value: sellerAmount}("");
        require(ok1, "Market: seller payment failed");

        if (msg.value > price) {
            (bool ok2,) = payable(msg.sender).call{value: msg.value - price}("");
            require(ok2, "Market: refund failed");
        }

        emit Sold(nftContract, tokenId, msg.sender, seller, price);
    }

    // ========== SELLER: ERC-1155 ==========

    /**
     * @notice List one ERC-1155 token for sale.
     *         Caller must approve this contract first (setApprovalForAll).
     */
    function list1155(address nftContract, uint256 tokenId, uint256 price) external {
        require(approvedContracts[nftContract], "Market: contract not approved");
        require(price > 0, "Market: price must be > 0");

        IERC1155 nft = IERC1155(nftContract);
        require(nft.balanceOf(msg.sender, tokenId) >= 1, "Market: insufficient balance");
        require(nft.isApprovedForAll(msg.sender, address(this)), "Market: market not approved");

        bool wasListed = listings1155[nftContract][tokenId][msg.sender].active;

        listings1155[nftContract][tokenId][msg.sender] = Listing1155({
            seller:      msg.sender,
            nftContract: nftContract,
            tokenId:     tokenId,
            amount:      1,
            price:       price,
            active:      true
        });

        if (!wasListed) {
            _addListing1155(nftContract, tokenId, msg.sender);
        }

        emit Listed1155(nftContract, tokenId, msg.sender, 1, price);
    }

    function delist1155(address nftContract, uint256 tokenId) external {
        Listing1155 storage l = listings1155[nftContract][tokenId][msg.sender];
        require(l.active, "Market: not listed");
        l.active = false;
        _removeListing1155(nftContract, tokenId, msg.sender);
        emit Delisted1155(nftContract, tokenId, msg.sender);
    }

    // ========== BUYER: ERC-1155 ==========

    function buy1155(address nftContract, uint256 tokenId, address seller) external payable nonReentrant {
        Listing1155 storage l = listings1155[nftContract][tokenId][seller];
        require(l.active, "Market: not listed");
        require(msg.value >= l.price, "Market: insufficient payment");

        address _seller = l.seller;
        uint256 _price  = l.price;
        l.active = false;
        _removeListing1155(nftContract, tokenId, seller);

        uint256 fee          = (_price * feeBps) / 10000;
        uint256 sellerAmount = _price - fee;
        accumulatedFees     += fee;

        IERC1155(nftContract).safeTransferFrom(_seller, msg.sender, tokenId, 1, "");

        (bool ok1,) = payable(_seller).call{value: sellerAmount}("");
        require(ok1, "Market: seller payment failed");

        if (msg.value > _price) {
            (bool ok2,) = payable(msg.sender).call{value: msg.value - _price}("");
            require(ok2, "Market: refund failed");
        }

        emit Sold1155(nftContract, tokenId, msg.sender, _seller, 1, _price);
    }

    // ========== VIEW: DIRECT LOOKUP ==========

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

    // ========== VIEW: PAGINATED ENUMERATION ==========

    /**
     * @notice Return a page of active ERC-721 listings for a given NFT contract.
     * @param nftContract The NFT contract to query.
     * @param offset      First listing to return (0-based).
     * @param limit       Maximum number of listings to return.
     * @return results    Array of Listing structs.
     * @return total      Total number of active listings (for pagination).
     */
    function getActiveListings(
        address nftContract,
        uint256 offset,
        uint256 limit
    ) external view returns (Listing[] memory results, uint256 total) {
        uint256[] storage ids = _active721Ids[nftContract];
        total = ids.length;
        if (offset >= total || limit == 0) return (new Listing[](0), total);
        uint256 end = offset + limit > total ? total : offset + limit;
        results = new Listing[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            results[i - offset] = listings[nftContract][ids[i]];
        }
    }

    /**
     * @notice Return a page of active ERC-1155 listings for a given NFT contract.
     * @param nftContract The NFT contract to query.
     * @param offset      First listing to return (0-based).
     * @param limit       Maximum number of listings to return.
     * @return results    Array of Listing1155 structs.
     * @return total      Total number of active listings (for pagination).
     */
    function getActiveListings1155(
        address nftContract,
        uint256 offset,
        uint256 limit
    ) external view returns (Listing1155[] memory results, uint256 total) {
        Key1155[] storage keys = _active1155Keys[nftContract];
        total = keys.length;
        if (offset >= total || limit == 0) return (new Listing1155[](0), total);
        uint256 end = offset + limit > total ? total : offset + limit;
        results = new Listing1155[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            results[i - offset] = listings1155[nftContract][keys[i].tokenId][keys[i].seller];
        }
    }
}
