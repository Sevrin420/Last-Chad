// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IERC721Minimal {
    function balanceOf(address owner) external view returns (uint256);
}

interface IMembersOnlyItems {
    function mintChips(address to, uint256 amount) external;
    function burnItem(address from, uint256 itemId, uint256 amount) external;
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

contract MembersOnly is ERC721Enumerable, Ownable {
    uint256 public constant MAX_SUPPLY = 222;
    uint256 public constant MINT_PRICE = 0.01 ether;              // 0.01 AVAX
    uint256 public constant MAX_MINT_PER_WALLET = 5;
    uint256 public constant BASE_CHIPS = 50;
    uint256 public constant PARTNER_BONUS_CHIPS = 100;

    // ── Partner System ──
    struct Partner {
        string name;
        address nftContract;
        bool active;
    }

    uint256 public nextPartnerId = 1;
    mapping(uint256 => Partner) public partners;

    // ── Whitelist (Merkle) ──
    bytes32 public merkleRoot;

    // ── Tier System (owner-set per token, matches metadata trait) ──
    mapping(uint256 => uint8) public tokenTier;           // tokenId => tier (1, 2, or 3)
    mapping(uint8 => uint256) public tierChipReward;      // tier => weekly chip amount

    // ── Level Bonus (mint-order based) ──
    mapping(uint8 => uint256) public levelBonusChips;     // level (1-4) => bonus weekly chips

    // ── Weekly Chip Claiming ──
    uint256 public currentWeek;
    mapping(uint256 => mapping(uint256 => bool)) public weekClaimed; // tokenId => week => claimed

    // ── Core State ──
    IMembersOnlyItems public items;
    uint256 public invitationItemId;
    uint256 public totalMinted;
    string private _baseTokenURI;
    mapping(uint256 => string) private _tokenURIs;
    mapping(uint256 => string) public tokenName;
    mapping(bytes32 => bool) private _usedNames;
    mapping(address => bool) public authorizedGame;
    mapping(address => uint256) public mintedPerWallet;
    mapping(uint256 => bool) public isActive;
    mapping(uint256 => bool) private _nameSet;

    // ── Events ──
    event NameSet(uint256 indexed tokenId, string name);
    event GameContractSet(address indexed game, bool enabled);
    event PartnerRegistered(uint256 indexed partnerId, string name, address nftContract);
    event PartnerUpdated(uint256 indexed partnerId, bool active);
    event TierSet(uint256 indexed tokenId, uint8 tier);
    event TierRewardSet(uint8 tier, uint256 amount);
    event LevelBonusSet(uint8 level, uint256 amount);
    event WeeklyChipsClaimed(uint256 indexed tokenId, uint256 week, uint256 amount);
    event WeekAdvanced(uint256 newWeek);
    event MerkleRootSet(bytes32 merkleRoot);

    modifier onlyGameOrOwner() {
        require(authorizedGame[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    constructor(string memory baseURI) ERC721("Members Only", "MEMBER") Ownable(msg.sender) {
        _baseTokenURI = baseURI;
    }

    // ─────────────────────────────────────────────────────────
    // Transfer lock — block transfers while isActive
    // ─────────────────────────────────────────────────────────
    function _update(address to, uint256 tokenId, address auth) internal override(ERC721Enumerable) returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            require(!isActive[tokenId], "Token is active");
        }
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value) internal override(ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function setActive(uint256 tokenId, bool active) external onlyGameOrOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        isActive[tokenId] = active;
    }

    // ─────────────────────────────────────────────────────────
    // Partner Management (owner only)
    // ─────────────────────────────────────────────────────────
    function registerPartner(string calldata name, address nftContract) external onlyOwner returns (uint256) {
        require(bytes(name).length > 0, "Name cannot be empty");
        require(nftContract != address(0), "Invalid NFT contract");
        uint256 partnerId = nextPartnerId++;
        partners[partnerId] = Partner(name, nftContract, true);
        emit PartnerRegistered(partnerId, name, nftContract);
        return partnerId;
    }

    function setPartnerActive(uint256 partnerId, bool active) external onlyOwner {
        require(bytes(partners[partnerId].name).length > 0, "Partner does not exist");
        partners[partnerId].active = active;
        emit PartnerUpdated(partnerId, active);
    }

    function getPartner(uint256 partnerId) external view returns (string memory name, address nftContract, bool active) {
        Partner memory p = partners[partnerId];
        return (p.name, p.nftContract, p.active);
    }

    function getPartnerCount() external view returns (uint256) {
        return nextPartnerId - 1;
    }

    function hasPartnerNFT(address wallet) public view returns (bool) {
        for (uint256 i = 1; i < nextPartnerId; i++) {
            if (partners[i].active && IERC721Minimal(partners[i].nftContract).balanceOf(wallet) > 0) {
                return true;
            }
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────
    // Whitelist Management (Merkle proof)
    // ─────────────────────────────────────────────────────────
    function setMerkleRoot(bytes32 _merkleRoot) external onlyOwner {
        merkleRoot = _merkleRoot;
        emit MerkleRootSet(_merkleRoot);
    }

    // ─────────────────────────────────────────────────────────
    // Minting
    // ─────────────────────────────────────────────────────────
    function mint(uint256 quantity) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        _mintInternal(quantity);
    }

    function mintWithInvitation(uint256 quantity) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        require(invitationItemId > 0, "Invitation not set");
        require(items.balanceOf(msg.sender, invitationItemId) >= 1, "No invitation");
        _mintInternal(quantity);
    }

    function mintWhitelist(uint256 quantity, bytes32[] calldata proof) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        require(merkleRoot != bytes32(0), "Whitelist not set");
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "Invalid whitelist proof");
        _mintInternal(quantity);
    }

    function _mintInternal(uint256 quantity) internal {
        require(quantity > 0, "Quantity must be > 0");
        require(totalMinted + quantity <= MAX_SUPPLY, "Exceeds max supply");
        require(mintedPerWallet[msg.sender] + quantity <= MAX_MINT_PER_WALLET, "Exceeds max per wallet");

        uint256 chipsPerMint = BASE_CHIPS;

        bool partnerBonus = hasPartnerNFT(msg.sender);
        if (partnerBonus) {
            chipsPerMint += PARTNER_BONUS_CHIPS;
        }

        mintedPerWallet[msg.sender] += quantity;
        for (uint256 i = 0; i < quantity; i++) {
            totalMinted++;
            _safeMint(msg.sender, totalMinted);
        }
        items.mintChips(msg.sender, chipsPerMint * quantity);
    }

    // ─────────────────────────────────────────────────────────
    // Naming (unique names enforced)
    // ─────────────────────────────────────────────────────────
    function setName(uint256 tokenId, string calldata name) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!_nameSet[tokenId], "Name already set");
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(name).length <= 12, "Name too long");

        bytes32 nameHash = keccak256(abi.encodePacked(_toLower(name)));
        require(!_usedNames[nameHash], "Name already taken");
        _usedNames[nameHash] = true;

        _nameSet[tokenId] = true;
        tokenName[tokenId] = name;
        emit NameSet(tokenId, name);
    }

    function _toLower(string calldata str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        bytes memory lower = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x41 && b[i] <= 0x5A) {
                lower[i] = bytes1(uint8(b[i]) + 32);
            } else {
                lower[i] = b[i];
            }
        }
        return string(lower);
    }

    function isNameTaken(string calldata name) external view returns (bool) {
        return _usedNames[keccak256(abi.encodePacked(_toLower(name)))];
    }

    function isNameAssigned(uint256 tokenId) external view returns (bool) {
        return _nameSet[tokenId];
    }

    // ─────────────────────────────────────────────────────────
    // Tier System (owner-set, matches metadata trait)
    // ─────────────────────────────────────────────────────────
    function setTier(uint256 tokenId, uint8 tier) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        require(tier >= 1 && tier <= 4, "Tier must be 1-4");
        tokenTier[tokenId] = tier;
        emit TierSet(tokenId, tier);
    }

    function batchSetTier(uint256[] calldata tokenIds, uint8[] calldata tiers) external onlyOwner {
        require(tokenIds.length == tiers.length, "Array length mismatch");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            require(_ownerOf(tokenIds[i]) != address(0), "Token does not exist");
            require(tiers[i] >= 1 && tiers[i] <= 3, "Tier must be 1-4");
            tokenTier[tokenIds[i]] = tiers[i];
            emit TierSet(tokenIds[i], tiers[i]);
        }
    }

    function setTierReward(uint8 tier, uint256 amount) external onlyOwner {
        require(tier >= 1 && tier <= 4, "Tier must be 1-4");
        tierChipReward[tier] = amount;
        emit TierRewardSet(tier, amount);
    }

    // ─────────────────────────────────────────────────────────
    // Level System (mint-order based, pure function)
    // ─────────────────────────────────────────────────────────
    function getLevel(uint256 tokenId) public pure returns (uint8) {
        require(tokenId >= 1 && tokenId <= 222, "Invalid token ID");
        if (tokenId <= 50) return 1;
        if (tokenId <= 100) return 2;
        if (tokenId <= 150) return 3;
        return 4; // 151-222
    }

    function setLevelBonus(uint8 level, uint256 amount) external onlyOwner {
        require(level >= 1 && level <= 4, "Level must be 1-4");
        levelBonusChips[level] = amount;
        emit LevelBonusSet(level, amount);
    }

    // ─────────────────────────────────────────────────────────
    // Weekly Chip Claiming
    // ─────────────────────────────────────────────────────────
    function claimWeeklyChips(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!weekClaimed[tokenId][currentWeek], "Already claimed this week");

        uint8 tier = tokenTier[tokenId];
        uint256 reward = tierChipReward[tier];
        uint8 level = getLevel(tokenId);
        reward += levelBonusChips[level];

        require(reward > 0, "No chips to claim");

        weekClaimed[tokenId][currentWeek] = true;
        items.mintChips(msg.sender, reward);

        emit WeeklyChipsClaimed(tokenId, currentWeek, reward);
    }

    function advanceWeek() external onlyOwner {
        currentWeek++;
        emit WeekAdvanced(currentWeek);
    }

    // ─────────────────────────────────────────────────────────
    // Game Authorization
    // ─────────────────────────────────────────────────────────
    function setGameContract(address game, bool enabled) external onlyOwner {
        require(game != address(0), "Invalid address");
        authorizedGame[game] = enabled;
        emit GameContractSet(game, enabled);
    }

    // ─────────────────────────────────────────────────────────
    // Items Contract (chips live in MembersOnlyItems as ERC-1155)
    // ─────────────────────────────────────────────────────────
    function setItems(address _items) external onlyOwner {
        require(_items != address(0), "Invalid address");
        items = IMembersOnlyItems(_items);
    }

    function setInvitationItemId(uint256 itemId) external onlyOwner {
        invitationItemId = itemId;
    }

    // ─────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────
    function getWeeklyReward(uint256 tokenId) external view returns (uint256) {
        uint8 tier = tokenTier[tokenId];
        uint256 reward = tierChipReward[tier];
        if (tokenId >= 1 && tokenId <= MAX_SUPPLY) {
            reward += levelBonusChips[getLevel(tokenId)];
        }
        return reward;
    }

    function hasClaimed(uint256 tokenId, uint256 week) external view returns (bool) {
        return weekClaimed[tokenId][week];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory _tokenURI = _tokenURIs[tokenId];
        if (bytes(_tokenURI).length > 0) return _tokenURI;
        return super.tokenURI(tokenId);
    }

    function setTokenURI(uint256 tokenId, string calldata uri) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        _tokenURIs[tokenId] = uri;
    }

    function batchSetTokenURI(uint256[] calldata tokenIds, string[] calldata uris) external onlyOwner {
        require(tokenIds.length == uris.length, "Array length mismatch");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            require(_ownerOf(tokenIds[i]) != address(0), "Token does not exist");
            _tokenURIs[tokenIds[i]] = uris[i];
        }
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function setBaseURI(string memory baseURI) external onlyOwner {
        _baseTokenURI = baseURI;
    }

    function withdraw() external onlyOwner {
        (bool success, ) = payable(owner()).call{value: address(this).balance}("");
        require(success, "Withdrawal failed");
    }
}
