// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IMembersOnly {
    function ownerOf(uint256 tokenId) external view returns (address);
    function isActive(uint256 tokenId) external view returns (bool);
    function tokenName(uint256 tokenId) external view returns (string memory);
}

interface IMembersOnlyItems {
    function burnChips(address from, uint256 amount) external;
    function mintChips(address to, uint256 amount) external;
    function burnTournamentChips(address from, uint256 amount) external;
    function mintTournamentChips(address to, uint256 amount) external;
    function payFromChips(address from, uint256 amount, address recipient) external;
    function CHIP_PRICE() external view returns (uint256);
}

/**
 * @title Casino — Club Nile's single operator contract
 * @dev One oracle-authorized operator that owns ALL casino operations, so the
 *      protocol is three contracts: the ERC-721 (MembersOnly), the ERC-1155
 *      vault (MembersOnlyItems), and this. It merges what used to be three
 *      separate operators:
 *
 *        • GAMBLE   — chip wagering (resolveGame / commitWager+claimWinnings)
 *                     and the two cages: the chip cage (cageBuyIn/cageCashOut,
 *                     AVAX-backed chips id 0) and the tournament-token cage
 *                     (tourneyWithdraw/tourneyDeposit, free tokens id 1).
 *        • LEADERBOARD — burn tournament tokens (min 2000) to hold a spot on
 *                     the month's board; owner funds a monthly AVAX pool; each
 *                     entrant pull-claims a pro-rata share (burned/total).
 *        • TIPS     — route CHIP tips & gallery buys to team/creator wallets
 *                     via Items.payFromChips.
 *
 *      All three were "authorized-to-mint/burn + oracle-signed + AVAX-holding"
 *      operators, and all are swappable by re-authorization on Items — so
 *      merging them costs nothing in safety while keeping the vault (Items)
 *      strictly separate. A single nonce space + usedNonces covers every
 *      signed path; tourney-deposit signatures are domain-tagged "TOURNEY" so
 *      they can never be replayed against the AVAX-backed chip cage.
 *
 *      Authorize once: items.setGameContract(thisCasino, true).
 */
contract Casino is Ownable, ReentrancyGuard {
    IMembersOnly      public immutable membersOnly;
    IMembersOnlyItems public items;
    address           public oracle;

    // ── wagering config ──
    uint256 public minWager = 1;
    uint256 public maxWager = 500;
    uint256 public maxPayoutMultiplier = 20;      // payout cap: wager * multiplier
    uint256 public cageLimit = 1_000_000;         // max chips per chip-cage buy-in
    uint256 public tourneyCageLimit = 10_000_000; // max tokens per tourney withdraw

    // ── shared nonce space + replay guard (all signed paths) ──
    mapping(uint256 => bool)    public usedNonces;
    mapping(uint256 => uint256) public wagerAmounts;  // nonce => wager
    mapping(uint256 => address) public wagerPlayers;  // nonce => player
    uint256 public nextNonce;

    // ── tips: team wallet + creator registry ──
    address public teamWallet;
    mapping(bytes32 => address) public creatorWallet;

    // ── leaderboard: monthly burn-for-yield ──
    uint256 public constant MIN_BURN = 2000;
    uint256 public epoch;                                               // current open epoch
    mapping(uint256 => mapping(uint256 => uint256)) public burnedOf;    // epoch => tokenId => cumulative burned
    mapping(uint256 => uint256) public totalBurned;                     // epoch => sum burned
    mapping(uint256 => uint256[]) private _participants;               // epoch => tokenIds
    mapping(uint256 => mapping(uint256 => bool)) public onBoard;        // epoch => tokenId => listed
    mapping(uint256 => uint256) public pool;                            // epoch => AVAX pool
    mapping(uint256 => bool)    public closed;                          // epoch => frozen for claims
    mapping(uint256 => mapping(uint256 => bool)) public claimed;        // epoch => tokenId => claimed
    uint256 public totalPooled;                                        // AVAX reserved for pools

    // ── Events ──
    event GameResolved(uint256 indexed tokenId, address indexed player, uint8 indexed gameId, uint256 wager, uint256 payout);
    event WagerCommitted(uint256 indexed tokenId, address indexed player, uint256 wager, uint256 nonce);
    event WinningsClaimed(uint256 indexed tokenId, address indexed player, uint256 payout, uint256 nonce);
    event CageBuyIn(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce);
    event CageCashOut(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce);
    event TourneyWithdraw(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce);
    event TourneyDeposit(uint256 indexed tokenId, address indexed player, uint256 amount, uint256 nonce);
    event TeamWalletSet(address indexed wallet);
    event CreatorSet(bytes32 indexed creatorId, address indexed wallet);
    event TeamTip(address indexed from, uint256 chips, uint256 avax, string context);
    event CreatorTip(address indexed from, bytes32 indexed creatorId, address indexed wallet, uint256 chips, uint256 avax, string category, string item);
    event Purchase(address indexed from, bytes32 indexed creatorId, address indexed wallet, uint256 chips, uint256 avax, string item);
    event Burned(uint256 indexed epoch, uint256 indexed tokenId, string name, uint256 amount, uint256 cumulative);
    event YieldFunded(uint256 indexed epoch, uint256 amount, uint256 pool);
    event EpochClosed(uint256 indexed epoch, uint256 pool, uint256 totalBurned, uint256 nextEpoch);
    event Claimed(uint256 indexed epoch, uint256 indexed tokenId, address indexed to, uint256 amount);

    constructor(address membersOnlyAddress, address itemsAddress, address _oracle, address _teamWallet)
        Ownable(msg.sender)
    {
        require(_oracle != address(0), "Oracle required");
        require(itemsAddress != address(0) && membersOnlyAddress != address(0), "zero addr");
        require(_teamWallet != address(0), "team zero");
        membersOnly = IMembersOnly(membersOnlyAddress);
        items       = IMembersOnlyItems(itemsAddress);
        oracle      = _oracle;
        teamWallet  = _teamWallet;
    }

    // ─────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────
    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
    }
    function setItems(address _items) external onlyOwner {
        require(_items != address(0), "zero");
        items = IMembersOnlyItems(_items);
    }
    function setWagerLimits(uint256 min, uint256 max) external onlyOwner {
        require(min > 0 && max >= min, "Invalid limits");
        minWager = min; maxWager = max;
    }
    function setMaxPayoutMultiplier(uint256 mult) external onlyOwner {
        require(mult > 0, "Multiplier must be > 0");
        maxPayoutMultiplier = mult;
    }
    function setCageLimit(uint256 limit) external onlyOwner {
        require(limit > 0, "Limit must be > 0");
        cageLimit = limit;
    }
    function setTourneyCageLimit(uint256 limit) external onlyOwner {
        require(limit > 0, "Limit must be > 0");
        tourneyCageLimit = limit;
    }
    function setTeamWallet(address wallet) external onlyOwner {
        require(wallet != address(0), "zero");
        teamWallet = wallet;
        emit TeamWalletSet(wallet);
    }
    function setCreator(bytes32 creatorId, address wallet) external onlyOwner {
        creatorWallet[creatorId] = wallet;
        emit CreatorSet(creatorId, wallet);
    }
    function setCreators(bytes32[] calldata ids, address[] calldata wallets) external onlyOwner {
        require(ids.length == wallets.length, "length mismatch");
        for (uint256 i = 0; i < ids.length; i++) {
            creatorWallet[ids[i]] = wallets[i];
            emit CreatorSet(ids[i], wallets[i]);
        }
    }

    // ─────────────────────────────────────────────
    //  Wagering — oracle-signed + two-tx settlement
    // ─────────────────────────────────────────────
    function resolveGame(uint256 tokenId, uint256 wager, uint256 payout, uint8 gameId, uint256 nonce, bytes calldata oracleSig) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!membersOnly.isActive(tokenId), "Token is active");
        require(wager > 0, "Invalid wager");
        require(!usedNonces[nonce], "Nonce already used");

        bytes32 message = keccak256(abi.encodePacked(tokenId, wager, payout, gameId, nonce, msg.sender));
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(message), oracleSig) == oracle, "Invalid oracle signature");

        usedNonces[nonce] = true;
        items.burnChips(msg.sender, wager);
        if (payout > 0) items.mintChips(msg.sender, payout);
        emit GameResolved(tokenId, msg.sender, gameId, wager, payout);
    }

    function commitWager(uint256 tokenId, uint256 wager) external returns (uint256) {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!membersOnly.isActive(tokenId), "Token is active");
        require(wager >= minWager && wager <= maxWager, "Wager out of range");

        uint256 nonce = nextNonce++;
        wagerAmounts[nonce] = wager;
        wagerPlayers[nonce] = msg.sender;
        items.burnChips(msg.sender, wager);
        emit WagerCommitted(tokenId, msg.sender, wager, nonce);
        return nonce;
    }

    function claimWinnings(uint256 tokenId, uint256 payout, uint256 nonce, bytes calldata oracleSig) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(wagerAmounts[nonce] > 0, "No active wager");
        require(wagerPlayers[nonce] == msg.sender, "Not wager owner");
        require(!usedNonces[nonce], "Already claimed");
        require(payout <= wagerAmounts[nonce] * maxPayoutMultiplier, "Payout exceeds cap");

        bytes32 message = keccak256(abi.encodePacked(tokenId, payout, nonce, msg.sender));
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(message), oracleSig) == oracle, "Invalid oracle signature");

        usedNonces[nonce] = true;
        delete wagerAmounts[nonce];
        delete wagerPlayers[nonce];
        if (payout > 0) items.mintChips(msg.sender, payout);
        emit WinningsClaimed(tokenId, msg.sender, payout, nonce);
    }

    // ─────────────────────────────────────────────
    //  The chip cage (AVAX-backed chips id 0)
    // ─────────────────────────────────────────────
    function cageBuyIn(uint256 tokenId, uint256 amount) external returns (uint256) {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!membersOnly.isActive(tokenId), "Token is active");
        require(amount > 0 && amount <= cageLimit, "Amount out of range");

        uint256 nonce = nextNonce++;
        items.burnChips(msg.sender, amount);
        emit CageBuyIn(tokenId, msg.sender, amount, nonce);
        return nonce;
    }

    function cageCashOut(uint256 tokenId, uint256 amount, uint256 nonce, bytes calldata oracleSig) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!usedNonces[nonce], "Nonce already used");

        bytes32 message = keccak256(abi.encodePacked(tokenId, amount, nonce, msg.sender));
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(message), oracleSig) == oracle, "Invalid oracle signature");

        usedNonces[nonce] = true;
        if (amount > 0) items.mintChips(msg.sender, amount);
        emit CageCashOut(tokenId, msg.sender, amount, nonce);
    }

    // ─────────────────────────────────────────────
    //  The tournament-token cage (free tokens id 1)
    // ─────────────────────────────────────────────
    function tourneyWithdraw(uint256 tokenId, uint256 amount) external returns (uint256) {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(amount > 0 && amount <= tourneyCageLimit, "Amount out of range");

        uint256 nonce = nextNonce++;
        items.burnTournamentChips(msg.sender, amount);
        emit TourneyWithdraw(tokenId, msg.sender, amount, nonce);
        return nonce;
    }

    function tourneyDeposit(uint256 tokenId, uint256 amount, uint256 nonce, bytes calldata oracleSig) external {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(!usedNonces[nonce], "Nonce already used");

        bytes32 message = keccak256(abi.encodePacked("TOURNEY", tokenId, amount, nonce, msg.sender));
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(message), oracleSig) == oracle, "Invalid oracle signature");

        usedNonces[nonce] = true;
        if (amount > 0) items.mintTournamentChips(msg.sender, amount);
        emit TourneyDeposit(tokenId, msg.sender, amount, nonce);
    }

    // ─────────────────────────────────────────────
    //  Tips & buys — paid in chips, released as AVAX to the payee
    // ─────────────────────────────────────────────
    function tipTeam(uint256 chips, string calldata context) external nonReentrant {
        require(chips > 0, "zero chips");
        uint256 avax = chips * items.CHIP_PRICE();
        items.payFromChips(msg.sender, chips, teamWallet);
        emit TeamTip(msg.sender, chips, avax, context);
    }

    function tipCreator(bytes32 creatorId, uint256 chips, string calldata category, string calldata item)
        external nonReentrant
    {
        address wallet = creatorWallet[creatorId];
        require(wallet != address(0), "creator unset");
        require(chips > 0, "zero chips");
        uint256 avax = chips * items.CHIP_PRICE();
        items.payFromChips(msg.sender, chips, wallet);
        emit CreatorTip(msg.sender, creatorId, wallet, chips, avax, category, item);
    }

    function buyFromCreator(bytes32 creatorId, uint256 chips, string calldata item)
        external nonReentrant
    {
        address wallet = creatorWallet[creatorId];
        require(wallet != address(0), "creator unset");
        require(chips > 0, "zero chips");
        uint256 avax = chips * items.CHIP_PRICE();
        items.payFromChips(msg.sender, chips, wallet);
        emit Purchase(msg.sender, creatorId, wallet, chips, avax, item);
    }

    // ─────────────────────────────────────────────
    //  Burn-for-yield leaderboard (monthly, pro-rata)
    // ─────────────────────────────────────────────
    function burnForLeaderboard(uint256 tokenId, uint256 amount) external nonReentrant {
        require(membersOnly.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(amount > 0, "amount zero");

        uint256 e = epoch;
        uint256 prior = burnedOf[e][tokenId];
        if (prior == 0) require(amount >= MIN_BURN, "min 2000 to enter");

        items.burnTournamentChips(msg.sender, amount);

        uint256 cumulative = prior + amount;
        burnedOf[e][tokenId] = cumulative;
        totalBurned[e] += amount;
        if (!onBoard[e][tokenId]) { onBoard[e][tokenId] = true; _participants[e].push(tokenId); }
        emit Burned(e, tokenId, membersOnly.tokenName(tokenId), amount, cumulative);
    }

    function fundYield() external payable {
        require(msg.value > 0, "no value");
        pool[epoch] += msg.value;
        totalPooled += msg.value;
        emit YieldFunded(epoch, msg.value, pool[epoch]);
    }

    function closeEpoch() external onlyOwner {
        uint256 e = epoch;
        closed[e] = true;
        epoch = e + 1;
        emit EpochClosed(e, pool[e], totalBurned[e], epoch);
    }

    function claim(uint256 e, uint256 tokenId) public nonReentrant returns (uint256 share) {
        require(closed[e], "epoch not closed");
        require(!claimed[e][tokenId], "already claimed");
        uint256 burned = burnedOf[e][tokenId];
        require(burned > 0, "nothing burned");

        uint256 total = totalBurned[e];
        share = (pool[e] * burned) / total;
        claimed[e][tokenId] = true;

        address to = membersOnly.ownerOf(tokenId);
        if (share > 0) {
            totalPooled -= share;
            (bool ok, ) = payable(to).call{value: share}("");
            require(ok, "transfer failed");
        }
        emit Claimed(e, tokenId, to, share);
    }

    function claimMany(uint256 e, uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) claim(e, tokenIds[i]);
    }

    // ── leaderboard views ──
    function participantCount(uint256 e) external view returns (uint256) {
        return _participants[e].length;
    }
    function leaderboard(uint256 e, uint256 offset, uint256 limit)
        external view returns (uint256[] memory ids, string[] memory names, uint256[] memory amounts)
    {
        uint256 n = _participants[e].length;
        if (offset >= n) return (new uint256[](0), new string[](0), new uint256[](0));
        uint256 end = offset + limit; if (end > n) end = n;
        uint256 len = end - offset;
        ids = new uint256[](len); names = new string[](len); amounts = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            uint256 id = _participants[e][offset + i];
            ids[i] = id; names[i] = membersOnly.tokenName(id); amounts[i] = burnedOf[e][id];
        }
    }
    function pendingShare(uint256 e, uint256 tokenId) external view returns (uint256) {
        if (!closed[e] || claimed[e][tokenId]) return 0;
        uint256 total = totalBurned[e];
        if (total == 0) return 0;
        return (pool[e] * burnedOf[e][tokenId]) / total;
    }

    // ── surplus (never touches funded pools) ──
    function withdrawSurplus(address to) external onlyOwner nonReentrant {
        require(to != address(0), "zero");
        uint256 surplus = address(this).balance - totalPooled;
        require(surplus > 0, "no surplus");
        (bool ok, ) = payable(to).call{value: surplus}("");
        require(ok, "transfer failed");
    }

    receive() external payable { revert("use fundYield"); }
}
