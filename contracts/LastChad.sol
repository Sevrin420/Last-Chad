// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IERC721Minimal {
    function balanceOf(address owner) external view returns (uint256);
}

contract LastChad is ERC721Enumerable, Ownable {
    uint256 public constant MAX_SUPPLY = 333;
    uint256 public constant MINT_PRICE = 2 ether;          // 2 AVAX — standard mint
    uint256 public constant TEAM_MINT_PRICE = 1.5 ether;   // 1.5 AVAX — holds team NFT
    uint256 public constant TOTAL_STAT_POINTS = 2;
    uint256 public constant MAX_MINT_PER_WALLET = 5;
    uint256 public constant CELLS_PER_LEVEL = 100;

    struct Stats {
        uint32 strength;
        uint32 intelligence;
        uint32 dexterity;
        uint32 charisma;
        bool assigned;
    }

    // ── Team System ──
    struct Team {
        string name;
        address nftContract;  // must hold an NFT from this contract to join
        bool active;
    }

    uint256 public nextTeamId = 1;
    mapping(uint256 => Team) public teams;                   // teamId → Team
    mapping(uint256 => uint256) public tokenTeam;            // tokenId → teamId (0 = no team)
    mapping(uint256 => uint256) public teamMemberCount;      // teamId → count of minted members

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
    event TeamCreated(uint256 indexed teamId, string name, address nftContract);
    event TeamUpdated(uint256 indexed teamId, bool active);
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
        // Allow mints (from == address(0)) and burns, block transfers while active
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
    // Team Management (owner only)
    // ─────────────────────────────────────────────────────────
    function createTeam(string calldata name, address nftContract) external onlyOwner returns (uint256) {
        require(bytes(name).length > 0, "Name cannot be empty");
        require(nftContract != address(0), "Invalid NFT contract");
        uint256 teamId = nextTeamId++;
        teams[teamId] = Team(name, nftContract, true);
        emit TeamCreated(teamId, name, nftContract);
        return teamId;
    }

    function setTeamActive(uint256 teamId, bool active) external onlyOwner {
        require(bytes(teams[teamId].name).length > 0, "Team does not exist");
        teams[teamId].active = active;
        emit TeamUpdated(teamId, active);
    }

    function getTeam(uint256 teamId) external view returns (string memory name, address nftContract, bool active, uint256 memberCount) {
        Team memory t = teams[teamId];
        return (t.name, t.nftContract, t.active, teamMemberCount[teamId]);
    }

    function getTeamCount() external view returns (uint256) {
        return nextTeamId - 1;
    }

    // ─────────────────────────────────────────────────────────
    // Minting (with optional team selection + discount)
    // ─────────────────────────────────────────────────────────
    function mint(uint256 quantity) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        _mintInternal(quantity, 0);
    }

    /// @notice Mint with team selection. Must hold an NFT from the team's collection.
    ///         Discounted price: 0.015 AVAX per mint (vs 0.02 standard).
    function mintWithTeam(uint256 quantity, uint256 teamId) external payable {
        require(teamId > 0 && teamId < nextTeamId, "Invalid team");
        Team memory t = teams[teamId];
        require(t.active, "Team not active");
        require(IERC721Minimal(t.nftContract).balanceOf(msg.sender) > 0, "Must hold team NFT");
        require(msg.value >= TEAM_MINT_PRICE * quantity, "Insufficient payment");
        _mintInternal(quantity, teamId);
    }

    function _mintInternal(uint256 quantity, uint256 teamId) internal {
        require(quantity > 0, "Quantity must be > 0");
        require(totalMinted + quantity <= MAX_SUPPLY, "Exceeds max supply");
        require(mintedPerWallet[msg.sender] + quantity <= MAX_MINT_PER_WALLET, "Exceeds max per wallet");

        mintedPerWallet[msg.sender] += quantity;
        for (uint256 i = 0; i < quantity; i++) {
            totalMinted++;
            _safeMint(msg.sender, totalMinted);
            _openCells[totalMinted] = 5;
            if (teamId > 0) {
                tokenTeam[totalMinted] = teamId;
                teamMemberCount[teamId]++;
            }
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

    /// @notice Gas-optimized batch eliminate. Call in chunks of ~200-500 to stay under block gas limit.
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

        if (newLevel > oldLevel) {
            uint256 levelsGained = newLevel - oldLevel;
            _pendingStatPoints[tokenId] += levelsGained;
            emit LevelUp(tokenId, newLevel, levelsGained);
        }

        emit CellsLocked(tokenId, amount, _closedCells[tokenId], newLevel);
    }

    function spendStatPoint(uint256 tokenId, uint8 statIndex) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!eliminated[tokenId], "Chad eliminated");
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

    /// @notice Batch read closed cells for culling script efficiency
    function getClosedCellsBatch(uint256[] calldata tokenIds) external view returns (uint256[] memory) {
        uint256[] memory result = new uint256[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            result[i] = _closedCells[tokenIds[i]];
        }
        return result;
    }

    /// @notice Get total cells (open + closed) for a token
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
