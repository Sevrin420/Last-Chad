// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface ILastChad {
    function ownerOf(uint256 tokenId) external view returns (address);
    function awardCells(uint256 tokenId, uint256 amount) external;
    function spendCells(uint256 tokenId, uint256 amount) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface ILastChadItems {
    function mintTo(address to, uint256 itemId, uint256 quantity) external;
}

contract QuestRewards {
    ILastChad      public immutable lastChad;
    ILastChadItems public lastChadItems;
    address        public immutable gameOwner;
    address        public oracle; // Cloudflare Worker signing key

    uint256 public constant SESSION_DURATION = 1 hours;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    struct QuestSession {
        bytes32 seed;      // retained for Worker reference via getSession()
        uint8   questId;
        uint40  startTime;
        bool    active;
    }

    // Per-quest config — cells and item minted automatically on completion.
    // Cell reward amount is computed by the Worker and committed in the oracle signature.
    struct QuestConfig {
        uint16 cellReward; // bonus cells awarded on completion (0 = none)
        uint16 itemReward; // item ID minted on completion (0 = none)
    }

    mapping(uint256 => QuestSession)            public pendingSessions;
    mapping(uint256 => mapping(uint8 => bool))  public questStarted;
    mapping(uint256 => mapping(uint8 => bool))  public questCompleted;
    mapping(uint256 => address)                 public lockedBy;
    mapping(uint256 => uint256)                 public itemPrices;
    mapping(uint8   => QuestConfig)             internal _questConfig;

    uint256[] private _lockedTokenIds;
    mapping(uint256 => uint256) private _lockedIndex;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    event QuestStarted(uint256 indexed tokenId, uint8 questId, bytes32 seed, uint256 expiresAt);
    event QuestCompleted(uint256 indexed tokenId, uint8 questId, uint256 cellsAwarded, uint256 itemAwarded);
    event NFTBurned(uint256 indexed tokenId, address indexed originalOwner);
    event NFTReleased(uint256 indexed tokenId, address indexed returnedTo);
    event CellsAwarded(uint256 indexed tokenId, address indexed player, uint256 amount);
    event ItemAwarded(uint256 indexed tokenId, address indexed player, uint256 itemId);
    event ItemPurchased(uint256 indexed tokenId, uint256 indexed itemId, address indexed buyer, uint256 cellCost);
    event ItemPriceSet(uint256 indexed itemId, uint256 cellCost);
    event QuestConfigSet(uint8 indexed questId, uint16 cellReward, uint16 itemReward);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(address lastChadAddress) {
        lastChad  = ILastChad(lastChadAddress);
        gameOwner = msg.sender;
    }

    modifier onlyGameOwner() {
        require(msg.sender == gameOwner, "Not game owner");
        _;
    }

    // -------------------------------------------------------------------------
    // Admin setters
    // -------------------------------------------------------------------------
    function setLastChadItems(address itemsAddress) external onlyGameOwner {
        lastChadItems = ILastChadItems(itemsAddress);
    }

    function setOracle(address _oracle) external onlyGameOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
    }

    // cellReward: cells minted to player on completion (0 = none)
    // itemReward: item ID minted to player on completion (0 = none)
    function setQuestConfig(
        uint8  questId,
        uint16 cellReward,
        uint16 itemReward
    ) external onlyGameOwner {
        _questConfig[questId] = QuestConfig(cellReward, itemReward);
        emit QuestConfigSet(questId, cellReward, itemReward);
    }

    // -------------------------------------------------------------------------
    // startQuest — player locks NFT into escrow; seed generated for Worker use
    // -------------------------------------------------------------------------
    function startQuest(uint256 tokenId, uint8 questId) external {
        require(lastChad.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!questStarted[tokenId][questId], "Quest already attempted");

        bytes32 seed = keccak256(abi.encodePacked(
            tokenId, questId, block.prevrandao, block.timestamp, msg.sender
        ));

        questStarted[tokenId][questId] = true;
        lockedBy[tokenId] = msg.sender;
        lastChad.transferFrom(msg.sender, address(this), tokenId);
        _addLocked(tokenId);

        pendingSessions[tokenId] = QuestSession({
            seed:      seed,
            questId:   questId,
            startTime: uint40(block.timestamp),
            active:    true
        });

        emit QuestStarted(tokenId, questId, seed, block.timestamp + SESSION_DURATION);
    }

    // -------------------------------------------------------------------------
    // completeQuest — player submits oracle-signed cell reward amount.
    //
    // The Worker (Cloudflare) runs all game logic: dice rolls, choice bonuses,
    // dex scaling, minigame outcomes. It signs keccak256(tokenId, questId, player,
    // cellReward) with the oracle private key. The contract verifies the signature
    // and awards exactly the cells the Worker certified.
    //
    // Additional cells and item rewards come from QuestConfig (on-chain).
    // -------------------------------------------------------------------------
    function completeQuest(
        uint256 tokenId,
        uint8   questId,
        uint256 cellReward,
        bytes calldata oracleSig
    ) external {
        address player = lockedBy[tokenId];
        require(player != address(0), "Token not locked");
        require(msg.sender == player, "Not token owner");

        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(session.questId == questId, "Wrong quest");
        require(block.timestamp <= uint256(session.startTime) + SESSION_DURATION, "Session expired");
        require(!questCompleted[tokenId][questId], "Already completed");

        // Oracle signature commits to the exact cell reward the Worker certified.
        if (oracle != address(0)) {
            bytes32 message = keccak256(abi.encodePacked(tokenId, questId, player, cellReward));
            bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(message);
            address signer  = ECDSA.recover(ethHash, oracleSig);
            require(signer == oracle, "Invalid oracle signature");
        }

        // Settle state before external calls
        questCompleted[tokenId][questId] = true;
        delete pendingSessions[tokenId];
        delete lockedBy[tokenId];
        _removeLocked(tokenId);

        // Return NFT
        lastChad.transferFrom(address(this), player, tokenId);

        // Award cells from oracle-signed amount
        uint256 totalCellsAwarded = cellReward;
        if (cellReward > 0) {
            lastChad.awardCells(tokenId, cellReward);
        }

        // Award bonus cells from quest config
        QuestConfig memory qc = _questConfig[questId];
        if (qc.cellReward > 0) {
            totalCellsAwarded += uint256(qc.cellReward);
            lastChad.awardCells(tokenId, uint256(qc.cellReward));
        }

        // Award item from quest config
        uint256 itemAwarded = 0;
        if (qc.itemReward > 0 && address(lastChadItems) != address(0)) {
            itemAwarded = uint256(qc.itemReward);
            lastChadItems.mintTo(player, itemAwarded, 1);
        }

        emit QuestCompleted(tokenId, questId, totalCellsAwarded, itemAwarded);
    }

    // -------------------------------------------------------------------------
    // Mid-quest awards — game owner only
    // -------------------------------------------------------------------------
    function awardCells(uint256 tokenId, uint256 amount) external onlyGameOwner {
        address player = lockedBy[tokenId];
        require(player != address(0), "Token not locked");
        lastChad.awardCells(tokenId, amount);
        emit CellsAwarded(tokenId, player, amount);
    }

    function awardItem(uint256 tokenId, uint256 itemId) external onlyGameOwner {
        require(address(lastChadItems) != address(0), "Items contract not set");
        address player = lockedBy[tokenId];
        require(player != address(0), "Token not locked");
        lastChadItems.mintTo(player, itemId, 1);
        emit ItemAwarded(tokenId, player, itemId);
    }

    // -------------------------------------------------------------------------
    // purchaseItem — player spends cells to buy from in-quest shop
    // -------------------------------------------------------------------------
    function purchaseItem(uint256 tokenId, uint256 itemId) external {
        require(lockedBy[tokenId] == msg.sender, "Not quest participant");
        require(address(lastChadItems) != address(0), "Items contract not set");
        QuestSession memory session = pendingSessions[tokenId];
        require(session.active, "No active session");
        require(block.timestamp <= uint256(session.startTime) + SESSION_DURATION, "Session expired");
        uint256 cost = itemPrices[itemId];
        require(cost > 0, "Item not in shop");

        lastChad.spendCells(tokenId, cost);
        lastChadItems.mintTo(msg.sender, itemId, 1);
        emit ItemPurchased(tokenId, itemId, msg.sender, cost);
    }

    // -------------------------------------------------------------------------
    // setItemPrice
    // -------------------------------------------------------------------------
    function setItemPrice(uint256 itemId, uint256 cellCost) external onlyGameOwner {
        itemPrices[itemId] = cellCost;
        emit ItemPriceSet(itemId, cellCost);
    }

    // -------------------------------------------------------------------------
    // Release
    // -------------------------------------------------------------------------
    function releaseLocked(uint256 tokenId) external onlyGameOwner {
        address original = lockedBy[tokenId];
        require(original != address(0), "Token not locked");
        _doRelease(tokenId, original);
        emit NFTReleased(tokenId, original);
    }

    function batchReleaseLocked(uint256[] calldata tokenIds) external onlyGameOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            address original = lockedBy[tokenId];
            if (original == address(0)) continue;
            _doRelease(tokenId, original);
            emit NFTReleased(tokenId, original);
        }
    }

    // -------------------------------------------------------------------------
    // Burn
    // -------------------------------------------------------------------------
    function burnLocked(uint256 tokenId) external onlyGameOwner {
        address original = lockedBy[tokenId];
        require(original != address(0), "Token not locked");
        _doBurn(tokenId, original);
        emit NFTBurned(tokenId, original);
    }

    function batchBurnLocked(uint256[] calldata tokenIds) external onlyGameOwner {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            address original = lockedBy[tokenId];
            if (original == address(0)) continue;
            _doBurn(tokenId, original);
            emit NFTBurned(tokenId, original);
        }
    }

    function burnAllLocked() external onlyGameOwner {
        for (uint256 i = _lockedTokenIds.length; i > 0; i--) {
            uint256 tokenId = _lockedTokenIds[i - 1];
            address original = lockedBy[tokenId];
            _doBurn(tokenId, original);
            emit NFTBurned(tokenId, original);
        }
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    function _doRelease(uint256 tokenId, address original) internal {
        delete lockedBy[tokenId];
        delete pendingSessions[tokenId];
        _removeLocked(tokenId);
        lastChad.transferFrom(address(this), original, tokenId);
    }

    function _doBurn(uint256 tokenId, address original) internal {
        delete lockedBy[tokenId];
        delete pendingSessions[tokenId];
        _removeLocked(tokenId);
        lastChad.transferFrom(address(this), BURN_ADDRESS, tokenId);
    }

    function _addLocked(uint256 tokenId) internal {
        _lockedIndex[tokenId] = _lockedTokenIds.length + 1;
        _lockedTokenIds.push(tokenId);
    }

    function _removeLocked(uint256 tokenId) internal {
        uint256 idx = _lockedIndex[tokenId];
        if (idx == 0) return;
        uint256 arrayIdx = idx - 1;
        uint256 last = _lockedTokenIds[_lockedTokenIds.length - 1];
        _lockedTokenIds[arrayIdx] = last;
        _lockedIndex[last] = idx;
        _lockedTokenIds.pop();
        delete _lockedIndex[tokenId];
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------
    function getSession(uint256 tokenId) external view returns (
        bytes32 seed, uint8 questId, uint256 startTime, uint256 expiresAt, bool active
    ) {
        QuestSession memory s = pendingSessions[tokenId];
        return (s.seed, s.questId, s.startTime, uint256(s.startTime) + SESSION_DURATION, s.active);
    }

    function isSessionExpired(uint256 tokenId) external view returns (bool) {
        QuestSession memory s = pendingSessions[tokenId];
        if (!s.active) return false;
        return block.timestamp > uint256(s.startTime) + SESSION_DURATION;
    }

    function getLockedTokenIds() external view returns (uint256[] memory) {
        return _lockedTokenIds;
    }

    function getLockedCount() external view returns (uint256) {
        return _lockedTokenIds.length;
    }

    function getQuestConfig(uint8 questId) external view returns (uint16 cellReward, uint16 itemReward) {
        QuestConfig memory qc = _questConfig[questId];
        return (qc.cellReward, qc.itemReward);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
