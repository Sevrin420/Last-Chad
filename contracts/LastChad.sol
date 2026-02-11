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

    event StatsAssigned(uint256 indexed tokenId, uint8 strength, uint8 intelligence, uint8 dexterity, uint8 charisma);

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

    function setStats(uint256 tokenId, uint8 strength, uint8 intelligence, uint8 dexterity, uint8 charisma) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!_tokenStats[tokenId].assigned, "Stats already assigned");
        require(
            uint256(strength) + uint256(intelligence) + uint256(dexterity) + uint256(charisma) == TOTAL_STAT_POINTS,
            "Must use exactly 10 points"
        );

        _tokenStats[tokenId] = Stats(strength, intelligence, dexterity, charisma, true);
        emit StatsAssigned(tokenId, strength, intelligence, dexterity, charisma);
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
