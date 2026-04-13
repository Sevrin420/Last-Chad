// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title FakeLil
 * @notice Free-to-mint ERC-721 collection. 20 max supply.
 *         Completely standalone — no dependency on Members Only contracts.
 */
contract FakeLil is ERC721Enumerable, Ownable {

    uint256 public constant MAX_SUPPLY = 20;
    uint256 public constant MAX_PER_WALLET = 3;

    string private _baseTokenURI;
    uint256 private _nextTokenId = 1;

    error SoldOut();
    error WalletLimitReached();
    error BaseURINotSet();

    constructor(address initialOwner)
        ERC721("Fake Lil", "FAKELIL")
        Ownable(initialOwner)
    {}

    // ── Mint ──────────────────────────────────────────────────────────────────

    function mint(uint256 quantity) external {
        if (_nextTokenId + quantity - 1 > MAX_SUPPLY) revert SoldOut();
        if (balanceOf(msg.sender) + quantity > MAX_PER_WALLET) revert WalletLimitReached();

        for (uint256 i = 0; i < quantity; i++) {
            _safeMint(msg.sender, _nextTokenId++);
        }
    }

    // ── Metadata ──────────────────────────────────────────────────────────────

    function setBaseURI(string calldata uri) external onlyOwner {
        _baseTokenURI = uri;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // ── Owner airdrop ─────────────────────────────────────────────────────────

    /**
     * @notice Airdrop tokens to specific addresses (owner only).
     *         Useful for gifting or reserving tokens before public mint.
     */
    function airdrop(address[] calldata recipients) external onlyOwner {
        if (_nextTokenId + recipients.length - 1 > MAX_SUPPLY) revert SoldOut();
        for (uint256 i = 0; i < recipients.length; i++) {
            _safeMint(recipients[i], _nextTokenId++);
        }
    }
}
