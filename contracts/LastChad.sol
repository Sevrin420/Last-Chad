// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract LastChad is ERC721, Ownable {
    uint256 public constant MAX_SUPPLY = 6;
    uint256 public constant MINT_PRICE = 3 ether; // 3 AVAX

    uint256 public totalSupply;
    string private _baseTokenURI;

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
