// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract LastChad is ERC721, Ownable {
    uint256 public constant MAX_SUPPLY = 70;
    uint256 public constant MINT_PRICE = 0.02 ether; // 0.02 AVAX
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

    uint256 public totalSupply;
    string private _baseTokenURI;
    mapping(uint256 => Stats) private _tokenStats;
    mapping(uint256 => string) public tokenName;
    mapping(uint256 => uint256) private _openCells;    // spendable cells
    mapping(uint256 => uint256) private _closedCells;  // locked permanently into the NFT
    mapping(uint256 => uint256) private _pendingStatPoints;
    mapping(address => bool) public authorizedGame;
    mapping(address => uint256) public mintedPerWallet;
    mapping(uint256 => bool) public eliminated;
    uint256 public eliminationPercent = 20;

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
    event EliminationPercentSet(uint256 newPercent);

    modifier onlyGameOrOwner() {
        require(authorizedGame[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    constructor(string memory baseURI) ERC721("Last Chad", "CHAD") Ownable(msg.sender) {
        _baseTokenURI = baseURI;
    }

    function mint(uint256 quantity) external payable {
        require(quantity > 0, "Quantity must be > 0");
        require(totalSupply + quantity <= MAX_SUPPLY, "Exceeds max supply");
        require(mintedPerWallet[msg.sender] + quantity <= MAX_MINT_PER_WALLET, "Exceeds max per wallet");
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");

        mintedPerWallet[msg.sender] += quantity;
        for (uint256 i = 0; i < quantity; i++) {
            totalSupply++;
            _safeMint(msg.sender, totalSupply);
            _openCells[totalSupply] = 5;
        }
    }

    function setStats(uint256 tokenId, string calldata name, uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!_tokenStats[tokenId].assigned, "Stats already assigned");
        require(
            uint256(strength) + uint256(intelligence) + uint256(dexterity) + uint256(charisma) == TOTAL_STAT_POINTS,
            "Must use exactly 2 points"
        );
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(name).length <= 12, "Name too long");

        tokenName[tokenId] = name;
        _tokenStats[tokenId] = Stats(strength, intelligence, dexterity, charisma, true);
        emit NameSet(tokenId, name);
        emit StatsAssigned(tokenId, strength, intelligence, dexterity, charisma);
    }

    function updateStats(uint256 tokenId, uint32 strength, uint32 intelligence, uint32 dexterity, uint32 charisma) external onlyOwner {
        require(ownerOf(tokenId) != address(0), "Token does not exist");
        _tokenStats[tokenId] = Stats(strength, intelligence, dexterity, charisma, true);
        emit StatsUpdated(tokenId, strength, intelligence, dexterity, charisma);
    }

    // statIndex: 0=strength, 1=intelligence, 2=dexterity, 3=charisma
    function addStat(uint256 tokenId, uint8 statIndex, uint32 amount) external onlyOwner {
        require(ownerOf(tokenId) != address(0), "Token does not exist");
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

    // -------------------------------------------------------------------------
    // Elimination — owner flags the bottom eliminationPercent% each month
    // -------------------------------------------------------------------------
    function setEliminationPercent(uint256 percent) external onlyOwner {
        require(percent > 0 && percent <= 100, "Invalid percent");
        eliminationPercent = percent;
        emit EliminationPercentSet(percent);
    }

    function eliminate(uint256 tokenId) external onlyOwner {
        require(ownerOf(tokenId) != address(0), "Token does not exist");
        require(!eliminated[tokenId], "Already eliminated");
        eliminated[tokenId] = true;
        emit Eliminated(tokenId, _closedCells[tokenId]);
    }

    // Call in chunks of ~500 for large supplies to stay under block gas limit
    function batchEliminate(uint256[] calldata tokenIds) external onlyOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tid = tokenIds[i];
            if (eliminated[tid]) continue;
            if (ownerOf(tid) == address(0)) continue;
            eliminated[tid] = true;
            emit Eliminated(tid, _closedCells[tid]);
        }
    }

    function reinstate(uint256 tokenId) external onlyOwner {
        require(eliminated[tokenId], "Not eliminated");
        eliminated[tokenId] = false;
        emit Reinstated(tokenId);
    }

    // Lock open cells into closed cells. Leveling: 100 closed = level 2, 200 = level 3, etc.
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

    // statIndex: 0=strength, 1=intelligence, 2=dexterity, 3=charisma
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

    // Award open cells to a token (quest rewards, etc.)
    function awardCells(uint256 tokenId, uint256 amount) external onlyGameOrOwner {
        require(ownerOf(tokenId) != address(0), "Token does not exist");
        require(amount > 0, "Amount must be > 0");
        _openCells[tokenId] += amount;
        emit CellsAwarded(tokenId, amount, _openCells[tokenId]);
    }

    // Spend open cells from a token (shop purchases, gambling, etc.)
    function spendCells(uint256 tokenId, uint256 amount) external onlyGameOrOwner {
        require(amount > 0, "Amount must be > 0");
        require(_openCells[tokenId] >= amount, "Insufficient cells");
        _openCells[tokenId] -= amount;
        emit CellsSpent(tokenId, amount, _openCells[tokenId]);
    }

    // Backward-compatible alias — returns open cells
    function getCells(uint256 tokenId) external view returns (uint256) {
        return _openCells[tokenId];
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
