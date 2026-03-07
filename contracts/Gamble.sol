// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function eliminated(uint256 tokenId) external view returns (bool);
    function spendCells(uint256 tokenId, uint256 amount) external;
    function awardCells(uint256 tokenId, uint256 amount) external;
}

/// @title Gamble — coin-flip mini-game for Last Chad
/// @notice Players wager cells on a 50/50 coin flip. Win = 2x wager returned.
///         Must be authorized via lastChad.setGameContract(gambleAddress, true).
contract Gamble {
    ILastChad public immutable lastChad;
    address   public immutable gameOwner;

    uint256 public minWager = 1;
    uint256 public maxWager = 50;

    event CoinFlip(
        uint256 indexed tokenId,
        address indexed player,
        uint256 wager,
        bool    won,
        bytes32 seed
    );

    constructor(address lastChadAddress) {
        lastChad  = ILastChad(lastChadAddress);
        gameOwner = msg.sender;
    }

    modifier onlyGameOwner() {
        require(msg.sender == gameOwner, "Not game owner");
        _;
    }

    function setWagerLimits(uint256 min, uint256 max) external onlyGameOwner {
        require(min > 0 && max >= min, "Invalid limits");
        minWager = min;
        maxWager = max;
    }

    /// @notice Flip the coin. Spends `wager` cells; awards 2x back on win.
    /// @param tokenId  The chad NFT to wager cells from.
    /// @param wager    Number of cells to bet (must be within minWager–maxWager).
    function flip(uint256 tokenId, uint256 wager) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!lastChad.eliminated(tokenId), "Chad eliminated");
        require(wager >= minWager && wager <= maxWager, "Wager out of range");

        // Deduct wager first — reverts if insufficient cells
        lastChad.spendCells(tokenId, wager);

        // 50/50 outcome from block entropy (good enough for a cell-based mini-game)
        bytes32 seed = keccak256(abi.encodePacked(
            tokenId, wager, block.prevrandao, block.timestamp, msg.sender
        ));
        bool won = uint256(seed) % 2 == 0;

        if (won) {
            lastChad.awardCells(tokenId, wager * 2);
        }

        emit CoinFlip(tokenId, msg.sender, wager, won, seed);
    }
}
