// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IERC721Minimal {
    function balanceOf(address owner) external view returns (uint256);
}

contract LastChad is ERC721Enumerable, Ownable {
    uint256 public constant MAX_SUPPLY = 333;
    uint256 public constant MINT_PRICE = 2 ether;              // 2 AVAX
    uint256 public constant TOTAL_STAT_POINTS = 2;
    uint256 public constant MAX_MINT_PER_WALLET = 5;
    uint256 public constant CELLS_PER_LEVEL = 100;
    uint256 public constant BASE_CELLS = 50;
    uint256 public constant PARTNER_BONUS_CELLS = 100;
    uint256 public constant CODE_BONUS_CELLS = 100;

    struct Stats {
        uint32 strength;
        uint32 intelligence;
        uint32 dexterity;
        uint32 charisma;
        bool assigned;
    }

    // ── Partner System ──
    struct Partner {
        string name;
        address nftContract;  // must hold an NFT from this contract for bonus
        bool active;
    }

    uint256 public nextPartnerId = 1;
    mapping(uint256 => Partner) public partners;               // partnerId → Partner

    // ── Mint Code System (one-time use) ──
    mapping(bytes32 => bool) public mintCodeValid;             // hash → is a real code
    mapping(bytes32 => bool) public mintCodeUsed;              // hash → already redeemed

    // ── Level Freeze ──
    bool public levelsFrozen;

    // ── Cull System ──
    enum CullMode { FixedCount, Percentage }
    CullMode public cullMode = CullMode.Percentage;
    uint256 public cullValue = 2000;  // default 20% (basis points)
    uint256 public eliminatedCount;
    uint256 public cullAnnouncedAt;   // timestamp of last cull announcement (0 = none)
    uint256 public cullExecuteAfter;  // earliest timestamp the cull can execute

    // ── Core State ──
    uint256 public totalMinted;  // sequential counter for token IDs
    string private _baseTokenURI;
    mapping(uint256 => string) private _tokenURIs;  // per-token URI override
    mapping(uint256 => Stats) private _tokenStats;
    mapping(uint256 => string) public tokenName;
    mapping(bytes32 => bool) private _usedNames;             // keccak256(lowercase) → taken
    mapping(uint256 => uint256) private _openCells;
    mapping(uint256 => uint256) private _closedCells;
    mapping(uint256 => uint256) private _pendingStatPoints;
    mapping(address => bool) public authorizedGame;
    mapping(address => uint256) public mintedPerWallet;
    mapping(uint256 => bool) public eliminated;
    mapping(uint256 => bool) public isActive;                // locked during quest/arcade

    // ── Events ──
    event StatsAssigned(uint256 indexed tokenId, uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma);
    event StatsUpdated(uint256 indexed tokenId, uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma);
    event StatIncremented(uint256 indexed tokenId, uint8 statIndex, uint32 amount, uint32 newValue);
    event NameSet(uint256 indexed tokenId, string name);
    event CellsLocked(uint256 indexed tokenId, uint256 amount, uint256 totalClosed, uint256 newLevel);
    event LevelUp(uint256 indexed tokenId, uint256 newLevel, uint256 statPointsAwarded);
    event StatPointSpent(uint256 indexed tokenId, uint8 statIndex, uint32 newValue);
    event GameContractSet(address indexed game, bool enabled);
    event CellsAwarded(uint256 indexed tokenId, uint256 amount, uint256 totalOpenCells);
    event CellsSpent(uint256 indexed tokenId, uint256 amount, uint256 remainingOpenCells);
    event Eliminated(uint256 indexed tokenId, uint256 closedCells);
    event Reinstated(uint256 indexed tokenId);
    event PartnerRegistered(uint256 indexed partnerId, string name, address nftContract);
    event PartnerUpdated(uint256 indexed partnerId, bool active);
    event MintCodeUsed(bytes32 indexed codeHash, address indexed minter);
    event LevelsFrozen();
    event CullAnnounced(uint256 cullAt, CullMode mode, uint256 value, uint256 estimatedCount);
    event CullModeSet(CullMode mode, uint256 value);

    modifier onlyGameOrOwner() {
        require(authorizedGame[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    constructor(string memory baseURI) ERC721("Last Chad", "CHAD") Ownable(msg.sender) {
        _baseTokenURI = baseURI;
    }

    // ─────────────────────────────────────────────────────────
    // Transfer lock — block transfers while isActive
    // ─────────────────────────────────────────────────────────
    function _update(address to, uint256 tokenId, address auth) internal override(ERC721Enumerable) returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            require(!isActive[tokenId], "Token is active in quest/arcade");
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

    /// @notice Check if a wallet holds any registered partner NFT
    function hasPartnerNFT(address wallet) public view returns (bool) {
        for (uint256 i = 1; i < nextPartnerId; i++) {
            if (partners[i].active && IERC721Minimal(partners[i].nftContract).balanceOf(wallet) > 0) {
                return true;
            }
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────
    // Mint Code Management (owner only)
    // ─────────────────────────────────────────────────────────
    function addMintCodes(bytes32[] calldata codeHashes) external onlyOwner {
        for (uint256 i = 0; i < codeHashes.length; i++) {
            mintCodeValid[codeHashes[i]] = true;
        }
    }

    function removeMintCode(bytes32 codeHash) external onlyOwner {
        mintCodeValid[codeHash] = false;
    }

    // ─────────────────────────────────────────────────────────
    // Minting — 50 base + 100 partner bonus + 100 code bonus = 250 max
    // ─────────────────────────────────────────────────────────

    /// @notice Standard mint (no code)
    function mint(uint256 quantity) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        _mintInternal(quantity, "");
    }

    /// @notice Mint with a bonus code for +100 cells per NFT
    function mintWithCode(uint256 quantity, string calldata code) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        require(bytes(code).length > 0, "Empty code");
        _mintInternal(quantity, code);
    }

    function _mintInternal(uint256 quantity, string memory code) internal {
        require(quantity > 0, "Quantity must be > 0");
        require(totalMinted + quantity <= MAX_SUPPLY, "Exceeds max supply");
        require(mintedPerWallet[msg.sender] + quantity <= MAX_MINT_PER_WALLET, "Exceeds max per wallet");

        // Calculate cells per NFT
        uint256 cellsPerMint = BASE_CELLS;

        // Partner bonus: +100 if wallet holds any registered partner NFT
        bool partnerBonus = hasPartnerNFT(msg.sender);
        if (partnerBonus) {
            cellsPerMint += PARTNER_BONUS_CELLS;
        }

        // Code bonus: +100 if valid code (one-time use, burned here)
        if (bytes(code).length > 0) {
            bytes32 codeHash = keccak256(abi.encodePacked(code));
            require(mintCodeValid[codeHash], "Invalid code");
            require(!mintCodeUsed[codeHash], "Code already used");
            mintCodeUsed[codeHash] = true;
            cellsPerMint += CODE_BONUS_CELLS;
            emit MintCodeUsed(codeHash, msg.sender);
        }

        mintedPerWallet[msg.sender] += quantity;
        for (uint256 i = 0; i < quantity; i++) {
            totalMinted++;
            _safeMint(msg.sender, totalMinted);
            _openCells[totalMinted] = cellsPerMint;
        }
    }

    // ─────────────────────────────────────────────────────────
    // Stats & Naming (unique names enforced)
    // ─────────────────────────────────────────────────────────
    function setStats(uint256 tokenId, string calldata name, uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!_tokenStats[tokenId].assigned, "Stats already assigned");
        require(
            uint256(strength) + uint256(intelligence) + uint256(dexterity) + uint256(charisma) == TOTAL_STAT_POINTS,
            "Must use exactly 2 points"
        );
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(name).length <= 12, "Name too long");

        bytes32 nameHash = keccak256(abi.encodePacked(_toLower(name)));
        require(!_usedNames[nameHash], "Name already taken");
        _usedNames[nameHash] = true;

        tokenName[tokenId] = name;
        _tokenStats[tokenId] = Stats(strength, intelligence, dexterity, charisma, true);
        emit NameSet(tokenId, name);
        emit StatsAssigned(tokenId, strength, intelligence, dexterity, charisma);
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

    function updateStats(uint256 tokenId, uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        _tokenStats[tokenId] = Stats(strength, intelligence, dexterity, charisma, true);
        emit StatsUpdated(tokenId, strength, intelligence, dexterity, charisma);
    }

    function addStat(uint256 tokenId, uint8 statIndex, uint32 amount) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        require(statIndex <= 3, "Invalid stat index");
        require(amount > 0, "Amount must be > 0");

        Stats storage s = _tokenStats[tokenId];
        uint32 newValue;
        if (statIndex == 0) { s.strength += amount; newValue = s.strength; }
        else if (statIndex == 1) { s.intelligence += amount; newValue = s.intelligence; }
        else if (statIndex == 2) { s.dexterity += amount; newValue = s.dexterity; }
        else { s.charisma += amount; newValue = s.charisma; }

        emit StatIncremented(tokenId, statIndex, amount, newValue);
    }

    function setGameContract(address game, bool enabled) external onlyOwner {
        require(game != address(0), "Invalid address");
        authorizedGame[game] = enabled;
        emit GameContractSet(game, enabled);
    }

    // ─────────────────────────────────────────────────────────
    // Level Freeze (one-way, permanent)
    // ─────────────────────────────────────────────────────────
    function freezeLevels() external onlyOwner {
        levelsFrozen = true;
        emit LevelsFrozen();
    }

    // ─────────────────────────────────────────────────────────
    // Cull Configuration & Announcement
    // ─────────────────────────────────────────────────────────
    function setCullMode(CullMode mode, uint256 value) external onlyOwner {
        if (mode == CullMode.Percentage) require(value <= 10000, "Max 100%");
        cullMode = mode;
        cullValue = value;
        emit CullModeSet(mode, value);
    }

    function getCullCount() public view returns (uint256) {
        if (cullMode == CullMode.FixedCount) return cullValue;
        uint256 alive = totalMinted - eliminatedCount;
        return (alive * cullValue) / 10000;
    }

    function announceCull(uint256 executeAfterTimestamp) external onlyOwner {
        cullAnnouncedAt = block.timestamp;
        cullExecuteAfter = executeAfterTimestamp;
        emit CullAnnounced(executeAfterTimestamp, cullMode, cullValue, getCullCount());
    }

    // ─────────────────────────────────────────────────────────
    // Elimination (gas-optimized with pagination)
    // ─────────────────────────────────────────────────────────
    function eliminate(uint256 tokenId) external onlyGameOrOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        require(!eliminated[tokenId], "Already eliminated");
        eliminated[tokenId] = true;
        eliminatedCount++;
        emit Eliminated(tokenId, _closedCells[tokenId]);
    }

    function batchEliminate(uint256[] calldata tokenIds) external onlyGameOrOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tid = tokenIds[i];
            if (eliminated[tid]) continue;
            if (_ownerOf(tid) == address(0)) continue;
            eliminated[tid] = true;
            eliminatedCount++;
            emit Eliminated(tid, _closedCells[tid]);
        }
    }

    function reinstate(uint256 tokenId) external onlyOwner {
        require(eliminated[tokenId], "Not eliminated");
        eliminated[tokenId] = false;
        eliminatedCount--;
        emit Reinstated(tokenId);
    }

    function batchReinstate(uint256[] calldata tokenIds) external onlyOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tid = tokenIds[i];
            if (!eliminated[tid]) continue;
            eliminated[tid] = false;
            eliminatedCount--;
            emit Reinstated(tid);
        }
    }

    // ─────────────────────────────────────────────────────────
    // Cells & Leveling
    // ─────────────────────────────────────────────────────────
    function lockCells(uint256 tokenId, uint256 amount) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!eliminated[tokenId], "Chad eliminated");
        require(amount > 0, "Amount must be > 0");
        require(_openCells[tokenId] >= amount, "Insufficient open cells");

        uint256 oldLevel = (_closedCells[tokenId] / CELLS_PER_LEVEL) + 1;

        _openCells[tokenId] -= amount;
        _closedCells[tokenId] += amount;

        uint256 newLevel = (_closedCells[tokenId] / CELLS_PER_LEVEL) + 1;

        // Skip leveling when levels are frozen
        if (newLevel > oldLevel && !levelsFrozen) {
            uint256 levelsGained = newLevel - oldLevel;
            _pendingStatPoints[tokenId] += levelsGained;
            emit LevelUp(tokenId, newLevel, levelsGained);
        }

        emit CellsLocked(tokenId, amount, _closedCells[tokenId], newLevel);
    }

    function spendStatPoint(uint256 tokenId, uint8 statIndex) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!eliminated[tokenId], "Chad eliminated");
        require(!levelsFrozen, "Levels are frozen");
        require(_pendingStatPoints[tokenId] > 0, "No stat points available");
        require(statIndex <= 3, "Invalid stat index");

        _pendingStatPoints[tokenId]--;
        Stats storage s = _tokenStats[tokenId];
        uint32 newValue;
        if (statIndex == 0) { s.strength += 1; newValue = s.strength; }
        else if (statIndex == 1) { s.intelligence += 1; newValue = s.intelligence; }
        else if (statIndex == 2) { s.dexterity += 1; newValue = s.dexterity; }
        else { s.charisma += 1; newValue = s.charisma; }

        emit StatPointSpent(tokenId, statIndex, newValue);
    }

    // ─────────────────────────────────────────────────────────
    // Cell Management (game/owner)
    // ─────────────────────────────────────────────────────────
    function awardCells(uint256 tokenId, uint256 amount) external onlyGameOrOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        require(amount > 0, "Amount must be > 0");
        _openCells[tokenId] += amount;
        emit CellsAwarded(tokenId, amount, _openCells[tokenId]);
    }

    function batchAwardCells(uint256[] calldata tokenIds, uint256[] calldata amounts) external onlyGameOrOwner {
        require(tokenIds.length == amounts.length, "Array length mismatch");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            require(_ownerOf(tokenIds[i]) != address(0), "Token does not exist");
            require(amounts[i] > 0, "Amount must be > 0");
            _openCells[tokenIds[i]] += amounts[i];
            emit CellsAwarded(tokenIds[i], amounts[i], _openCells[tokenIds[i]]);
        }
    }

    function spendCells(uint256 tokenId, uint256 amount) external onlyGameOrOwner {
        require(amount > 0, "Amount must be > 0");
        require(_openCells[tokenId] >= amount, "Insufficient cells");
        _openCells[tokenId] -= amount;
        emit CellsSpent(tokenId, amount, _openCells[tokenId]);
    }

    // ─────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────
    function getPendingStatPoints(uint256 tokenId) external view returns (uint256) {
        return _pendingStatPoints[tokenId];
    }

    function getOpenCells(uint256 tokenId) external view returns (uint256) {
        return _openCells[tokenId];
    }

    function getClosedCells(uint256 tokenId) external view returns (uint256) {
        return _closedCells[tokenId];
    }

    function getLevel(uint256 tokenId) external view returns (uint256) {
        return (_closedCells[tokenId] / CELLS_PER_LEVEL) + 1;
    }

    function getStats(uint256 tokenId) external view returns (uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma, bool assigned) {
        Stats memory s = _tokenStats[tokenId];
        return (s.strength, s.intelligence, s.dexterity, s.charisma, s.assigned);
    }

    function getCells(uint256 tokenId) external view returns (uint256) {
        return _openCells[tokenId];
    }

    function getClosedCellsBatch(uint256[] calldata tokenIds) external view returns (uint256[] memory) {
        uint256[] memory result = new uint256[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            result[i] = _closedCells[tokenIds[i]];
        }
        return result;
    }

    function getTotalCells(uint256 tokenId) external view returns (uint256) {
        return _openCells[tokenId] + _closedCells[tokenId];
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
