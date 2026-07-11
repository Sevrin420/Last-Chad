// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

// Minimal ERC-721 used ONLY in tests to exercise MembersOnly's partner-bonus
// path (hasPartnerNFT). Never deployed to production.
contract MockPartnerNFT is ERC721 {
    uint256 private _next = 1;
    constructor() ERC721("MockPartner", "MOCK") {}
    function mint(uint256 quantity) external {
        for (uint256 i = 0; i < quantity; i++) {
            _mint(msg.sender, _next++);
        }
    }
}
