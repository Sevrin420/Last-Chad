// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Members Only Invitation
 * @notice Simple ERC-721 invite NFT. Owner airdrops to select wallets.
 *         Burned by MembersOnly contract when a player mints.
 */
contract Invitation is ERC721, Ownable {

    uint256 private _nextId = 1;
    string private _baseTokenURI;

    constructor(string memory baseURI) ERC721("Members Only Invitation", "INVITE") Ownable(msg.sender) {
        _baseTokenURI = baseURI;
    }

    /// @notice Airdrop one invitation to a wallet
    function airdrop(address to) external onlyOwner returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }

    /// @notice Airdrop invitations to multiple wallets
    function batchAirdrop(address[] calldata recipients) external onlyOwner {
        for (uint256 i = 0; i < recipients.length; i++) {
            _mint(recipients[i], _nextId++);
        }
    }

    /// @notice Burn an invitation (called by holder or approved contract)
    function burn(uint256 tokenId) external {
        require(_isAuthorized(ownerOf(tokenId), msg.sender, tokenId), "Not authorized to burn");
        _burn(tokenId);
    }

    function totalMinted() external view returns (uint256) {
        return _nextId - 1;
    }

    function setBaseURI(string calldata baseURI) external onlyOwner {
        _baseTokenURI = baseURI;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
