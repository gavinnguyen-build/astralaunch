// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {AstralaunchConstants as C} from "./AstralaunchConstants.sol";
import {IFeeAdapter} from "./interfaces/IFeeAdapter.sol";
import {IBuybackVault, SOURCE_FORFEIT} from "./interfaces/IBuybackVault.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

/// @title  FeeEscrow
/// @notice Singleton that holds the 20% escrowed creator fee share for every Astralaunch asset.
///         Trading fees (from Doppler) accumulate here when `collect` is called.
///         Service revenue (from distribute) unlocks escrowed funds at 0.2 : 1 ratio.
///
///         v2: supports dual numeraire (USDC or WMON). For WMON-paired tokens,
///         the numeraire side of trading fees is WMON. WMON escrow stays in WMON;
///         claimable amount is valued via Chainlink MON/USD oracle at claim time.
///         No keeper swap (O4) required.
///
///         SPEC §4.3 / §6.3.
contract FeeEscrow is ReentrancyGuard {
    using SafeTransferLib for address;

    // ── Storage per asset ─────────────────────────────────────────────────────
    struct TokenData {
        address creator;
        uint48  launchTime;
        bool    forfeited;
        uint128 usdcAccrued;         // USDC collected (for USDC pairs)
        uint128 usdcClaimed;         // USDC already paid to creator
        uint128 tokenPending;        // asset-denominated fees
        uint128 recordedRevenue;     // cumulative USDC recorded by router.distribute()
        bytes32 poolId;              // Uniswap v4 pool id for collectFees
        address numeraire;           // USDC or WMON
    }

    /// @notice WMON-specific escrow data, stored separately to avoid stack-too-deep.
    struct WmonData {
        uint128 wmonAccrued;         // total WMON collected
        uint128 wmonClaimed;         // WMON already paid to creator
        uint128 wmonClaimedUsd;      // cumulative USD value of WMON claims (8 decimals)
    }

    mapping(address asset => TokenData) private _data;
    mapping(address asset => WmonData)  private _wmon;

    // ── Singletons ────────────────────────────────────────────────────────────
    address         public immutable registry;
    address         public immutable buybackVault;
    IAggregatorV3   public immutable oracle;
    uint256         public immutable maxStaleness;
    address         constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address         constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    /// @notice Fee adapter used for collectFees calls. Set at construction.
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
    error CollectFeesFailed();
    error OracleZeroPrice();
    error OracleStale();

    // ── Events ────────────────────────────────────────────────────────────────
    event AssetRegistered(address indexed asset, address indexed creator, uint48 launchTime, address numeraire);
    event FeeCollected(address indexed asset, uint256 usdcDelta, uint256 tokenDelta, uint256 wmonDelta);
    event RevenueRecorded(address indexed asset, uint256 amt, uint256 newTotal);
    event Claimed(address indexed asset, address indexed creator, uint256 amt);
    event ClaimedWmon(address indexed asset, address indexed creator, uint256 wmonAmt, uint256 usdValue);
    event Forfeited(address indexed asset, uint256 usdcMoved, uint256 tokenMoved, uint256 wmonMoved);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _registry, address _buybackVault, address _oracle, uint256 _maxStaleness) {
        registry      = _registry;
        buybackVault  = _buybackVault;
        oracle        = IAggregatorV3(_oracle);
        maxStaleness  = _maxStaleness;
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
    function collect(address asset) external nonReentrant {
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();

        address num = d.numeraire;
        uint256 numeraireBefore = num.balanceOf(address(this));
        uint256 tokenBefore     = asset.balanceOf(address(this));

        (address target, bytes memory cdata) = _adapters[asset].collectFeesCall(d.poolId);
        (bool ok,) = target.call(cdata);
        if (!ok) revert CollectFeesFailed();

        uint256 numeraireDelta = num.balanceOf(address(this)) - numeraireBefore;
        uint256 tokenDelta     = asset.balanceOf(address(this)) - tokenBefore;

        uint256 usdcDelta;
        uint256 wmonDelta;

        if (d.forfeited) {
            if (num == USDC && numeraireDelta > 0) {
                USDC.safeTransfer(buybackVault, numeraireDelta);
                IBuybackVault(buybackVault).creditUSDC(asset, numeraireDelta, SOURCE_FORFEIT);
            }
            if (num == WMON && numeraireDelta > 0) {
                WMON.safeTransfer(buybackVault, numeraireDelta);
            }
        } else {
            if (num == USDC) {
                usdcDelta = numeraireDelta;
                if (usdcDelta > 0) d.usdcAccrued += uint128(usdcDelta);
            } else {
                wmonDelta = numeraireDelta;
                if (wmonDelta > 0) _wmon[asset].wmonAccrued += uint128(wmonDelta);
            }
            if (tokenDelta > 0) d.tokenPending += uint128(tokenDelta);
        }

        emit FeeCollected(asset, usdcDelta, tokenDelta, wmonDelta);
    }

    // ── Revenue recording ─────────────────────────────────────────────────────
    function recordRevenue(address asset, uint256 amt) external {
        if (!authorizedRouters[msg.sender]) revert NotRouter();
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();
        d.recordedRevenue += uint128(amt);
        emit RevenueRecorded(asset, amt, d.recordedRevenue);
    }

    // ── Claim ─────────────────────────────────────────────────────────────────
    function claimable(address asset) external view returns (uint256) {
        return _claimable(_data[asset]);
    }

    function claimableWmon(address asset) external view returns (uint256) {
        (uint256 wmonAmt,) = _computeClaimableWmon(asset);
        return wmonAmt;
    }

    function claim(address asset) external nonReentrant {
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();
        if (msg.sender != d.creator) revert NotCreator();

        if (d.numeraire == USDC) {
            uint256 amt = _claimable(d);
            if (amt == 0) revert NothingToClaim();
            d.usdcClaimed += uint128(amt);
            USDC.safeTransfer(d.creator, amt);
            emit Claimed(asset, d.creator, amt);
        } else {
            (uint256 wmonAmt, uint256 usdValue) = _computeClaimableWmon(asset);
            if (wmonAmt == 0) revert NothingToClaim();
            WmonData storage w = _wmon[asset];
            w.wmonClaimed    += uint128(wmonAmt);
            w.wmonClaimedUsd += uint128(usdValue);
            WMON.safeTransfer(d.creator, wmonAmt);
            emit ClaimedWmon(asset, d.creator, wmonAmt, usdValue);
        }
    }

    // ── Forfeit ───────────────────────────────────────────────────────────────
    function forfeit(address asset) external nonReentrant {
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();
        if (d.forfeited) revert AlreadyForfeited();
        if (block.timestamp < uint256(d.launchTime) + C.FORFEIT_DELAY) revert ForfeitTooEarly();

        d.forfeited = true;

        uint256 usdcRemaining  = uint256(d.usdcAccrued) - uint256(d.usdcClaimed);
        uint256 tokenRemaining = uint256(d.tokenPending);

        WmonData storage w = _wmon[asset];
        uint256 wmonRemaining = uint256(w.wmonAccrued) - uint256(w.wmonClaimed);

        if (usdcRemaining > 0) {
            d.usdcAccrued = d.usdcClaimed;
            USDC.safeTransfer(buybackVault, usdcRemaining);
            IBuybackVault(buybackVault).creditUSDC(asset, usdcRemaining, SOURCE_FORFEIT);
        }
        if (tokenRemaining > 0) {
            d.tokenPending = 0;
            asset.safeTransfer(buybackVault, tokenRemaining);
        }
        if (wmonRemaining > 0) {
            w.wmonAccrued = w.wmonClaimed;
            WMON.safeTransfer(buybackVault, wmonRemaining);
        }

        emit Forfeited(asset, usdcRemaining, tokenRemaining, wmonRemaining);
    }

    // ── View ──────────────────────────────────────────────────────────────────
    function tokenData(address asset) external view returns (TokenData memory) {
        return _data[asset];
    }

    function wmonData(address asset) external view returns (WmonData memory) {
        return _wmon[asset];
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

    function _computeClaimableWmon(address asset) internal view returns (uint256 wmonAmt, uint256 usdValue) {
        TokenData storage d = _data[asset];
        WmonData storage w  = _wmon[asset];

        if (d.forfeited || d.launchTime == 0 || d.numeraire != WMON) return (0, 0);

        uint256 allowanceUsd8 = (uint256(d.recordedRevenue) * C.ESCROW_UNLOCK_BPS * 100) / 10_000;

        uint256 remainingUsd8 = allowanceUsd8 > uint256(w.wmonClaimedUsd)
            ? allowanceUsd8 - uint256(w.wmonClaimedUsd)
            : 0;
        if (remainingUsd8 == 0) return (0, 0);

        (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        if (answer <= 0) revert OracleZeroPrice();
        if (block.timestamp - updatedAt > maxStaleness) revert OracleStale();
        uint256 monPriceUsd8 = uint256(answer);

        uint256 maxWmon = (remainingUsd8 * 1e18) / monPriceUsd8;
        uint256 availableWmon = uint256(w.wmonAccrued) - uint256(w.wmonClaimed);
        wmonAmt = maxWmon < availableWmon ? maxWmon : availableWmon;
        usdValue = (wmonAmt * monPriceUsd8) / 1e18;
    }
}
