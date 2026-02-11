// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract LastChad is ERC721, Ownable {
    uint256 public constant MAX_SUPPLY = 6;
    uint256 public constant MINT_PRICE = 0.02 ether; // 0.02 AVAX
    uint256 public constant TOTAL_STAT_POINTS = 10;

    struct Stats {
        uint8 strength;
        uint8 intelligence;
        uint8 dexterity;
        uint8 charisma;
        bool assigned;
    }

    uint256 public totalSupply;
    string private _baseTokenURI;
    mapping(uint256 => Stats) private _tokenStats;
    mapping(uint256 => string) public tokenName;

    event StatsAssigned(uint256 indexed tokenId, uint8 strength, uint8 intelligence, uint8 dexterity, uint8 charisma);
    event StatsUpdated(uint256 indexed tokenId, uint8 strength, uint8 intelligence, uint8 dexterity, uint8 charisma);
    event StatIncremented(uint256 indexed tokenId, uint8 statIndex, uint8 amount, uint8 newValue);
    event NameSet(uint256 indexed tokenId, string name);

    constructor(string memory baseURI) ERC721("Last Chad", "CHAD") Ownable(msg.sender) {
        _baseTokenURI = baseURI;
    }

    function mint(uint256 quantity) external payable {
        require(quantity > 0, "Quantity must be > 0");
        require(totalSupply + quantity <= MAX_SUPPLY, "Exceeds max supply");
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");

        for (uint256 i = 0; i < quantity; i++) {
            totalSupply++;
            _safeMint(msg.sender, totalSupply);
        }
    }

    function setStats(uint256 tokenId, string calldata name, uint8 strength, uint8 intelligence, uint8 dexterity, uint8 charisma) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!_tokenStats[tokenId].assigned, "Stats already assigned");
        require(
            uint256(strength) + uint256(intelligence) + uint256(dexterity) + uint256(charisma) == TOTAL_STAT_POINTS,
            "Must use exactly 10 points"
        );
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(name).length <= 12, "Name too long");

        tokenName[tokenId] = name;
        _tokenStats[tokenId] = Stats(strength, intelligence, dexterity, charisma, true);
        emit NameSet(tokenId, name);
        emit StatsAssigned(tokenId, strength, intelligence, dexterity, charisma);
    }

    function updateStats(uint256 tokenId, uint8 strength, uint8 intelligence, uint8 dexterity, uint8 charisma) external onlyOwner {
        require(ownerOf(tokenId) != address(0), "Token does not exist");
        _tokenStats[tokenId] = Stats(strength, intelligence, dexterity, charisma, true);
        emit StatsUpdated(tokenId, strength, intelligence, dexterity, charisma);
    }

    // statIndex: 0=strength, 1=intelligence, 2=dexterity, 3=charisma
    function addStat(uint256 tokenId, uint8 statIndex, uint8 amount) external onlyOwner {
        require(ownerOf(tokenId) != address(0), "Token does not exist");
        require(statIndex <= 3, "Invalid stat index");
        require(amount > 0, "Amount must be > 0");

        Stats storage s = _tokenStats[tokenId];
        uint8 newValue;
        if (statIndex == 0) { newValue = s.strength + amount; s.strength = newValue; }
        else if (statIndex == 1) { newValue = s.intelligence + amount; s.intelligence = newValue; }
        else if (statIndex == 2) { newValue = s.dexterity + amount; s.dexterity = newValue; }
        else { newValue = s.charisma + amount; s.charisma = newValue; }

        emit StatIncremented(tokenId, statIndex, amount, newValue);
    }

    function getStats(uint256 tokenId) external view returns (uint8 strength, uint8 intelligence, uint8 dexterity, uint8 charisma, bool assigned) {
        Stats memory s = _tokenStats[tokenId];
        return (s.strength, s.intelligence, s.dexterity, s.charisma, s.assigned);
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
