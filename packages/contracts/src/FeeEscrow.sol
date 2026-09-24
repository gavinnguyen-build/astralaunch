// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {AstralaunchConstants as C} from "./AstralaunchConstants.sol";
import {IFeeAdapter} from "./interfaces/IFeeAdapter.sol";
import {IBuybackVault, SOURCE_FORFEIT} from "./interfaces/IBuybackVault.sol";

/// @title  FeeEscrow
/// @notice Singleton that holds the 20% escrowed creator fee share for every Astralaunch asset.
///         Trading fees (from Doppler) accumulate here when `collect` is called.
///         Service revenue (from distribute) unlocks escrowed USDC at 0.2 : 1 ratio.
///
///         v2: supports dual numeraire (USDC or WMON). For WMON-paired tokens,
///         the numeraire side of trading fees is WMON, which the keeper swaps to USDC
///         via O4. Escrow accounting is always in USDC terms.
///
///         SPEC §4.3 / §6.3.
contract FeeEscrow is ReentrancyGuard {
    using SafeTransferLib for address;

    // ── Storage per asset ─────────────────────────────────────────────────────
    struct TokenData {
        address creator;
        uint48  launchTime;
        bool    forfeited;
        uint128 usdcAccrued;         // USDC collected (directly for USDC pairs, or after O4 swap for WMON pairs)
        uint128 usdcClaimed;         // USDC already paid to creator
        uint128 tokenPending;        // asset-denominated fees not yet burned/swapped
        uint128 numerairePending;    // numeraire fees pending swap to USDC (nonzero only for WMON pairs)
        uint128 recordedRevenue;     // cumulative USDC recorded by router.distribute()
        bytes32 poolId;              // Uniswap v4 pool id for collectFees
        address numeraire;           // USDC or WMON — determines fee attribution in collect()
    }

    mapping(address asset => TokenData) private _data;

    // ── Singletons ────────────────────────────────────────────────────────────
    address         public immutable registry;
    address         public immutable buybackVault;
    address         constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address         constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    /// @notice Fee adapter used for collectFees calls. Set at construction.
    ///         In v2, the registry tells us which adapter to use per-token via the
    ///         initializer allowlist, but for fee collection the escrow needs a
    ///         reference. We store the adapter per-asset at registration.
    mapping(address asset => IFeeAdapter) private _adapters;

    // Addresses authorised to call recordRevenue (set of routers, maintained via registry)
    mapping(address router => bool) public authorizedRouters;

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotRegistry();
    error NotCreator();
    error NotRouter();
    error AssetNotRegistered();
    error AlreadyRegistered();
    error ForfeitTooEarly();
    error AlreadyForfeited();
    error NothingToClaim();

    // ── Events ────────────────────────────────────────────────────────────────
    event AssetRegistered(address indexed asset, address indexed creator, uint48 launchTime, address numeraire);
    event FeeCollected(address indexed asset, uint256 usdcDelta, uint256 tokenDelta, uint256 numeraireDelta);
    event RevenueRecorded(address indexed asset, uint256 amt, uint256 newTotal);
    event Claimed(address indexed asset, address indexed creator, uint256 amt);
    event Forfeited(address indexed asset, uint256 usdcMoved, uint256 tokenMoved, uint256 numeraireMoved);
    event NumeraireSwapped(address indexed asset, uint256 numeraireIn, uint256 usdcOut);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _registry, address _buybackVault) {
        registry     = _registry;
        buybackVault = _buybackVault;
    }

    // ── Registry callbacks ────────────────────────────────────────────────────
    /// @notice Register a new asset. Called once by AstralaunchRegistry after deploying the router.
    function registerAsset(
        address asset,
        address creator,
        uint48 launchTime,
        bytes32 poolId,
        address numeraire
    ) external {
        if (msg.sender != registry) revert NotRegistry();
        if (_data[asset].launchTime != 0) revert AlreadyRegistered();
        _data[asset] = TokenData({
            creator:          creator,
            launchTime:       launchTime,
            forfeited:        false,
            usdcAccrued:      0,
            usdcClaimed:      0,
            tokenPending:     0,
            numerairePending: 0,
            recordedRevenue:  0,
            poolId:           poolId,
            numeraire:        numeraire
        });
        emit AssetRegistered(asset, creator, launchTime, numeraire);
    }

    /// @notice Set the fee adapter for an asset. Called by AstralaunchRegistry at registration.
    function setAdapter(address asset, address adapter) external {
        if (msg.sender != registry) revert NotRegistry();
        _adapters[asset] = IFeeAdapter(adapter);
    }

    /// @notice Authorize a router to call recordRevenue. Called by AstralaunchRegistry.
    function authorizeRouter(address router) external {
        if (msg.sender != registry) revert NotRegistry();
        authorizedRouters[router] = true;
    }

    // ── Collect trading fees ──────────────────────────────────────────────────
    /// @notice Pull the escrow's share of Doppler trading fees for `asset`.
    ///         Anyone may trigger; the escrow calls collectFees as the beneficiary.
    ///         For USDC-paired tokens: receives USDC + asset tokens.
    ///         For WMON-paired tokens: receives WMON + asset tokens.
    function collect(address asset) external nonReentrant {
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();

        address num = d.numeraire;
        uint256 numeraireBefore = num.balanceOf(address(this));
        uint256 tokenBefore     = asset.balanceOf(address(this));

        _adapters[asset].collectFees(d.poolId);

        uint256 numeraireDelta = num.balanceOf(address(this)) - numeraireBefore;
        uint256 tokenDelta     = asset.balanceOf(address(this)) - tokenBefore;

        uint256 usdcDelta;

        if (d.forfeited) {
            // Post-forfeit: route any new accruals directly to BuybackVault
            if (num == USDC && numeraireDelta > 0) {
                USDC.safeTransfer(buybackVault, numeraireDelta);
                IBuybackVault(buybackVault).creditUSDC(asset, numeraireDelta, SOURCE_FORFEIT);
            }
            if (num == WMON && numeraireDelta > 0) {
                // WMON post-forfeit: send to buyback vault as pending
                WMON.safeTransfer(buybackVault, numeraireDelta);
            }
        } else {
            if (num == USDC) {
                // USDC pair: numeraire fees are USDC, credit directly
                usdcDelta = numeraireDelta;
                if (usdcDelta > 0) d.usdcAccrued += uint128(usdcDelta);
            } else {
                // WMON pair: numeraire fees are WMON, park as pending for keeper O4 swap
                if (numeraireDelta > 0) d.numerairePending += uint128(numeraireDelta);
            }
            if (tokenDelta > 0) d.tokenPending += uint128(tokenDelta);
        }

        emit FeeCollected(asset, usdcDelta, tokenDelta, num == WMON ? numeraireDelta : 0);
    }

    // ── O4: Credit USDC from keeper swap of WMON numeraire fees ──────────────
    /// @notice Called by the keeper after swapping WMON → USDC for a WMON-paired asset.
    ///         The keeper transfers USDC to this contract then calls this to credit escrow.
    /// @param asset     The asset whose WMON fees were swapped.
    /// @param usdcAmt   The USDC received from the swap.
    /// @param wmonUsed  The WMON consumed in the swap (deducted from numerairePending).
    function creditNumeraireSwap(address asset, uint128 usdcAmt, uint128 wmonUsed) external {
        if (!authorizedRouters[msg.sender] && msg.sender != registry) revert NotRouter();
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();
        require(d.numeraire == WMON, "not WMON pair");
        require(wmonUsed <= d.numerairePending, "exceeds pending");

        d.numerairePending -= wmonUsed;
        d.usdcAccrued      += usdcAmt;

        emit NumeraireSwapped(asset, wmonUsed, usdcAmt);
    }

    // ── Revenue recording ─────────────────────────────────────────────────────
    /// @notice Called by the asset's RevenueRouter after distribute().
    ///         Records full distribution amount so escrow unlock (0.2 × revenue) can be computed.
    function recordRevenue(address asset, uint256 amt) external {
        if (!authorizedRouters[msg.sender]) revert NotRouter();
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();
        d.recordedRevenue += uint128(amt);
        emit RevenueRecorded(asset, amt, d.recordedRevenue);
    }

    // ── Claim ─────────────────────────────────────────────────────────────────
    /// @notice Returns how many USDC the creator may claim right now.
    ///         = min(recordedRevenue × ESCROW_UNLOCK_BPS / 10000, usdcAccrued) − usdcClaimed
    function claimable(address asset) external view returns (uint256) {
        return _claimable(_data[asset]);
    }

    /// @notice Creator claims available escrowed USDC.
    function claim(address asset) external nonReentrant {
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();
        if (msg.sender != d.creator) revert NotCreator();

        uint256 amt = _claimable(d);
        if (amt == 0) revert NothingToClaim();

        d.usdcClaimed += uint128(amt);
        USDC.safeTransfer(d.creator, amt);

        emit Claimed(asset, d.creator, amt);
    }

    // ── Forfeit ───────────────────────────────────────────────────────────────
    /// @notice After launchTime + 365 days, anyone may move unclaimed escrow to BuybackVault.
    function forfeit(address asset) external nonReentrant {
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();
        if (d.forfeited) revert AlreadyForfeited();
        if (block.timestamp < uint256(d.launchTime) + C.FORFEIT_DELAY) revert ForfeitTooEarly();

        d.forfeited = true;

        uint256 usdcRemaining      = uint256(d.usdcAccrued) - uint256(d.usdcClaimed);
        uint256 tokenRemaining     = uint256(d.tokenPending);
        uint256 numeraireRemaining = uint256(d.numerairePending);

        if (usdcRemaining > 0) {
            d.usdcAccrued = d.usdcClaimed; // zero out available balance
            USDC.safeTransfer(buybackVault, usdcRemaining);
            IBuybackVault(buybackVault).creditUSDC(asset, usdcRemaining, SOURCE_FORFEIT);
        }
        if (tokenRemaining > 0) {
            d.tokenPending = 0;
            asset.safeTransfer(buybackVault, tokenRemaining);
        }
        if (numeraireRemaining > 0) {
            d.numerairePending = 0;
            // Send WMON to buyback vault
            WMON.safeTransfer(buybackVault, numeraireRemaining);
        }

        emit Forfeited(asset, usdcRemaining, tokenRemaining, numeraireRemaining);
    }

    // ── View ──────────────────────────────────────────────────────────────────
    function tokenData(address asset) external view returns (TokenData memory) {
        return _data[asset];
    }

    // ── Internal ──────────────────────────────────────────────────────────────
    function _claimable(TokenData storage d) internal view returns (uint256) {
        if (d.forfeited || d.launchTime == 0) return 0;
        uint256 allowance  = (uint256(d.recordedRevenue) * C.ESCROW_UNLOCK_BPS) / 10_000;
        uint256 maxPayable = allowance < uint256(d.usdcAccrued) ? allowance : uint256(d.usdcAccrued);
        uint256 already    = uint256(d.usdcClaimed);
        if (maxPayable <= already) return 0;
        return maxPayable - already;
    }
}
