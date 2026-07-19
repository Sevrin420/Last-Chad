// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IERC721Minimal {
    function balanceOf(address owner) external view returns (uint256);
}

interface IMembersOnlyItems {
    function mintChips(address to, uint256 amount) external;
    function mintTournamentChips(address to, uint256 amount) external;
    function burnItem(address from, uint256 itemId, uint256 amount) external;
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

contract MembersOnly is ERC721Enumerable, Ownable {
    uint256 public constant MAX_SUPPLY = 888;
    uint256 public constant MINT_PRICE = 0.02 ether;              // 0.02 AVAX
    uint256 public constant MAX_MINT_PER_WALLET = 5;
    // Welcome bonus = the token's rarity weekly amount (20/40/100), paid once at
    // mint in TOURNAMENT tokens (free, prize-only currency). See effectiveTier().

    // ── Partner System ──
    struct Partner {
        string name;
        address nftContract;
        bool active;
    }

    uint256 public nextPartnerId = 1;
    mapping(uint256 => Partner) public partners;

    // ── Whitelist (Merkle) ──
    bytes32 public merkleRoot;

    // ── Tier / Rarity System (owner-set per token, matches metadata trait) ──
    //
    // Three rarities, assigned to match each token's immutable metadata trait.
    // Intended distribution across the collection:
    //   COMMON    (tier 1) — 90%  —  20 chips / week
    //   RARE      (tier 2) —  9%  —  40 chips / week
    //   LEGENDARY (tier 3) —  1%  — 100 chips / week
    //
    // The weekly drop is paid in TOURNAMENT tokens (MembersOnlyItems token 1) —
    // free, no cash value, used only to enter tournaments / redeem for prizes.
    // (Regular chips, token 0, are the real-money table currency worth 0.01 AVAX.)
    uint8 public constant TIER_COMMON    = 1;
    uint8 public constant TIER_RARE      = 2;
    uint8 public constant TIER_LEGENDARY = 3;

    mapping(uint256 => uint8) public tokenTier;           // tokenId => tier (1=common, 2=rare, 3=legendary)
    mapping(uint8 => uint256) public tierChipReward;      // tier => weekly chip amount

    // ── Level Bonus (mint-order based) ──
    mapping(uint8 => uint256) public levelBonusChips;     // level (1-4) => bonus weekly chips

    // ── Weekly Chip Claiming (time-based: a new week rolls automatically every 7 days) ──
    // weekAnchor is the moment "week 0" begins; the owner can set it to a specific
    // day/time (e.g. Monday 00:00 UTC) so every weekly drop lands on that schedule.
    uint256 public weekLength = 7 days;
    uint256 public weekAnchor;
    // unclaimed weeks STACK: track the last week folded into a claim; a claim mints
    // reward * (currentWeek - lastClaimWeek). Set at mint so it can't backfill pre-mint weeks.
    mapping(uint256 => uint256) public lastClaimWeek; // tokenId => last week counted

    function currentWeek() public view returns (uint256) {
        return (block.timestamp - weekAnchor) / weekLength;
    }

    // timestamp at which the next weekly drop unlocks — handy for the UI countdown
    function nextDropAt() external view returns (uint256) {
        return weekAnchor + (currentWeek() + 1) * weekLength;
    }

    function setWeekSchedule(uint256 anchor, uint256 length) external onlyOwner {
        require(anchor <= block.timestamp, "Anchor must be past/now");
        require(length >= 1 hours && length <= 30 days, "Length out of range");
        weekAnchor = anchor;
        weekLength = length;
        emit WeekScheduleSet(anchor, length);
    }

    // ── Core State ──
    IMembersOnlyItems public items;
    uint256 public invitationItemId;
    uint256 public totalMinted;
    string private _baseTokenURI;
    mapping(uint256 => string) private _tokenURIs;
    mapping(uint256 => string) public tokenName;
    mapping(bytes32 => bool) private _usedNames;
    mapping(address => bool) public authorizedGame;
    mapping(address => uint256) public mintedPerWallet;
    mapping(uint256 => bool) public isActive;
    mapping(uint256 => bool) private _nameSet;

    // ── Events ──
    event NameSet(uint256 indexed tokenId, string name);
    event GameContractSet(address indexed game, bool enabled);
    event PartnerRegistered(uint256 indexed partnerId, string name, address nftContract);
    event PartnerUpdated(uint256 indexed partnerId, bool active);
    event TierSet(uint256 indexed tokenId, uint8 tier);
    event TierRewardSet(uint8 tier, uint256 amount);
    event LevelBonusSet(uint8 level, uint256 amount);
    event WeeklyChipsClaimed(uint256 indexed tokenId, uint256 week, uint256 amount);
    event WeekScheduleSet(uint256 anchor, uint256 length);
    event MerkleRootSet(bytes32 merkleRoot);

    modifier onlyGameOrOwner() {
        require(authorizedGame[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    constructor(string memory baseURI) ERC721("Members Only", "MEMBER") Ownable(msg.sender) {
        _baseTokenURI = baseURI;
        weekAnchor = block.timestamp;

        // Default weekly chip drop per rarity (owner-tunable via setTierReward).
        tierChipReward[TIER_COMMON]    = 20;
        tierChipReward[TIER_RARE]      = 40;
        tierChipReward[TIER_LEGENDARY] = 100;
    }

    // ─────────────────────────────────────────────────────────
    // Transfer lock — block transfers while isActive
    // ─────────────────────────────────────────────────────────
    function _update(address to, uint256 tokenId, address auth) internal override(ERC721Enumerable) returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            require(!isActive[tokenId], "Token is active");
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
    // Partner Management (owner only)
    // ─────────────────────────────────────────────────────────
    function registerPartner(string calldata name, address nftContract) external onlyOwner returns (uint256) {
        require(bytes(name).length > 0, "Name cannot be empty");
        require(nftContract != address(0), "Invalid NFT contract");
        uint256 partnerId = nextPartnerId++;
        partners[partnerId] = Partner(name, nftContract, true);
        emit PartnerRegistered(partnerId, name, nftContract);
        return partnerId;
    }

    function setPartnerActive(uint256 partnerId, bool active) external onlyOwner {
        require(bytes(partners[partnerId].name).length > 0, "Partner does not exist");
        partners[partnerId].active = active;
        emit PartnerUpdated(partnerId, active);
    }

    function getPartner(uint256 partnerId) external view returns (string memory name, address nftContract, bool active) {
        Partner memory p = partners[partnerId];
        return (p.name, p.nftContract, p.active);
    }

    function getPartnerCount() external view returns (uint256) {
        return nextPartnerId - 1;
    }

    function hasPartnerNFT(address wallet) public view returns (bool) {
        for (uint256 i = 1; i < nextPartnerId; i++) {
            if (partners[i].active && IERC721Minimal(partners[i].nftContract).balanceOf(wallet) > 0) {
                return true;
            }
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────
    // Whitelist Management (Merkle proof)
    // ─────────────────────────────────────────────────────────
    function setMerkleRoot(bytes32 _merkleRoot) external onlyOwner {
        merkleRoot = _merkleRoot;
        emit MerkleRootSet(_merkleRoot);
    }

    // ─────────────────────────────────────────────────────────
    // Minting
    // ─────────────────────────────────────────────────────────
    function mint(uint256 quantity) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        _mintInternal(quantity);
    }

    function mintWithInvitation(uint256 quantity) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        require(invitationItemId > 0, "Invitation not set");
        require(items.balanceOf(msg.sender, invitationItemId) >= 1, "No invitation");
        items.burnItem(msg.sender, invitationItemId, 1);
        _mintInternal(quantity);
    }

    function mintWhitelist(uint256 quantity, bytes32[] calldata proof) external payable {
        require(msg.value >= MINT_PRICE * quantity, "Insufficient payment");
        require(merkleRoot != bytes32(0), "Whitelist not set");
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "Invalid whitelist proof");
        _mintInternal(quantity);
    }

    function _mintInternal(uint256 quantity) internal {
        require(quantity > 0, "Quantity must be > 0");
        require(totalMinted + quantity <= MAX_SUPPLY, "Exceeds max supply");
        require(mintedPerWallet[msg.sender] + quantity <= MAX_MINT_PER_WALLET, "Exceeds max per wallet");

        mintedPerWallet[msg.sender] += quantity;
        uint256 welcomeChips;
        for (uint256 i = 0; i < quantity; i++) {
            totalMinted++;
            _safeMint(msg.sender, totalMinted);
            lastClaimWeek[totalMinted] = currentWeek();   // weekly drop starts accruing from next week
            welcomeChips += tierChipReward[effectiveTier(totalMinted)]; // rarity welcome (20/40/100)
        }
        items.mintTournamentChips(msg.sender, welcomeChips);  // free welcome tournament tokens
    }

    // ─────────────────────────────────────────────────────────
    // Naming (unique names enforced)
    // ─────────────────────────────────────────────────────────
    function setName(uint256 tokenId, string calldata name) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!_nameSet[tokenId], "Name already set");
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(name).length <= 12, "Name too long");

        bytes32 nameHash = keccak256(abi.encodePacked(_toLower(name)));
        require(!_usedNames[nameHash], "Name already taken");
        _usedNames[nameHash] = true;

        _nameSet[tokenId] = true;
        tokenName[tokenId] = name;
        emit NameSet(tokenId, name);
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

    function isNameAssigned(uint256 tokenId) external view returns (bool) {
        return _nameSet[tokenId];
    }

    // ─────────────────────────────────────────────────────────
    // Tier System (owner-set, matches metadata trait)
    // ─────────────────────────────────────────────────────────
    function setTier(uint256 tokenId, uint8 tier) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        require(tier >= TIER_COMMON && tier <= TIER_LEGENDARY, "Tier must be 1, 2, or 3");
        tokenTier[tokenId] = tier;
        emit TierSet(tokenId, tier);
    }

    function batchSetTier(uint256[] calldata tokenIds, uint8[] calldata tiers) external onlyOwner {
        require(tokenIds.length == tiers.length, "Array length mismatch");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            require(_ownerOf(tokenIds[i]) != address(0), "Token does not exist");
            require(tiers[i] >= TIER_COMMON && tiers[i] <= TIER_LEGENDARY, "Tier must be 1, 2, or 3");
            tokenTier[tokenIds[i]] = tiers[i];
            emit TierSet(tokenIds[i], tiers[i]);
        }
    }

    function setTierReward(uint8 tier, uint256 amount) external onlyOwner {
        require(tier >= TIER_COMMON && tier <= TIER_LEGENDARY, "Tier must be 1, 2, or 3");
        tierChipReward[tier] = amount;
        emit TierRewardSet(tier, amount);
    }

    /// @notice Human-readable rarity label for a token's tier ("" if unset).
    function tierName(uint256 tokenId) external view returns (string memory) {
        uint8 tier = tokenTier[tokenId];
        if (tier == TIER_COMMON)    return "Common";
        if (tier == TIER_RARE)      return "Rare";
        if (tier == TIER_LEGENDARY) return "Legendary";
        return "";
    }

    /// @notice Tier used for chip math. Rarity is assigned post-mint to match
    ///         metadata, so an unset tier (0) defaults to Common — a freshly
    ///         minted token earns/receives the Common amount until the owner
    ///         upgrades it to Rare/Legendary.
    function effectiveTier(uint256 tokenId) public view returns (uint8) {
        uint8 tier = tokenTier[tokenId];
        return tier == 0 ? TIER_COMMON : tier;
    }

    // ─────────────────────────────────────────────────────────
    // Level System (mint-order based, pure function)
    // ─────────────────────────────────────────────────────────
    function getLevel(uint256 tokenId) public pure returns (uint8) {
        require(tokenId >= 1 && tokenId <= MAX_SUPPLY, "Invalid token ID");
        if (tokenId <= 222) return 1;
        if (tokenId <= 444) return 2;
        if (tokenId <= 666) return 3;
        return 4; // 667-888
    }

    function setLevelBonus(uint8 level, uint256 amount) external onlyOwner {
        require(level >= 1 && level <= 4, "Level must be 1-4");
        levelBonusChips[level] = amount;
        emit LevelBonusSet(level, amount);
    }

    // ─────────────────────────────────────────────────────────
    // Weekly Chip Claiming
    // ─────────────────────────────────────────────────────────
    function claimWeeklyChips(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        uint256 weeksOwed = claimableWeeks(tokenId);
        require(weeksOwed > 0, "Nothing to claim yet");

        uint256 reward = tierChipReward[effectiveTier(tokenId)] + levelBonusChips[getLevel(tokenId)];
        require(reward > 0, "No reward set");

        lastClaimWeek[tokenId] = currentWeek();          // resync (also safe if schedule moved)
        uint256 total = reward * weeksOwed;
        items.mintTournamentChips(msg.sender, total);    // weekly drop is TOURNAMENT tokens (prize-only)

        emit WeeklyChipsClaimed(tokenId, currentWeek(), total);
    }

    /// @notice Claim the weekly tournament-chip drop for many tokens at once —
    ///         one signature mints the summed total across every listed token
    ///         the caller owns. Tokens with nothing owed are skipped.
    function claimWeeklyChipsBatch(uint256[] calldata tokenIds) external {
        uint256 cw = currentWeek();
        uint256 total;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            require(ownerOf(tokenId) == msg.sender, "Not token owner");
            uint256 last = lastClaimWeek[tokenId];
            if (cw <= last) continue;                        // nothing owed for this one
            uint256 reward = tierChipReward[effectiveTier(tokenId)] + levelBonusChips[getLevel(tokenId)];
            if (reward == 0) continue;
            uint256 amount = reward * (cw - last);
            lastClaimWeek[tokenId] = cw;
            total += amount;
            emit WeeklyChipsClaimed(tokenId, cw, amount);
        }
        require(total > 0, "Nothing to claim");
        items.mintTournamentChips(msg.sender, total);
    }

    // whole unclaimed weeks waiting for this token (safe against a moved schedule)
    function claimableWeeks(uint256 tokenId) public view returns (uint256) {
        uint256 cw = currentWeek();
        uint256 last = lastClaimWeek[tokenId];
        return cw > last ? cw - last : 0;
    }

    // total chips this token can claim right now (all stacked weeks)
    function claimableChips(uint256 tokenId) external view returns (uint256) {
        uint256 reward = tierChipReward[effectiveTier(tokenId)] + levelBonusChips[getLevel(tokenId)];
        return reward * claimableWeeks(tokenId);
    }

    // ─────────────────────────────────────────────────────────
    // Game Authorization
    // ─────────────────────────────────────────────────────────
    function setGameContract(address game, bool enabled) external onlyOwner {
        require(game != address(0), "Invalid address");
        authorizedGame[game] = enabled;
        emit GameContractSet(game, enabled);
    }

    // ─────────────────────────────────────────────────────────
    // Items Contract (chips live in MembersOnlyItems as ERC-1155)
    // ─────────────────────────────────────────────────────────
    function setItems(address _items) external onlyOwner {
        require(_items != address(0), "Invalid address");
        items = IMembersOnlyItems(_items);
    }

    function setInvitationItemId(uint256 itemId) external onlyOwner {
        invitationItemId = itemId;
    }

    // ─────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────
    function getWeeklyReward(uint256 tokenId) external view returns (uint256) {
        uint256 reward = tierChipReward[effectiveTier(tokenId)];
        if (tokenId >= 1 && tokenId <= MAX_SUPPLY) {
            reward += levelBonusChips[getLevel(tokenId)];
        }
        return reward;
    }

    // kept for the UI: a token has "claimed" a given week if it's already folded in
    function hasClaimed(uint256 tokenId, uint256 week) external view returns (bool) {
        return week < lastClaimWeek[tokenId];
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
