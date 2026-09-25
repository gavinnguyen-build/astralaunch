// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {AstralaunchConstants as C} from "./AstralaunchConstants.sol";
import {IFeeAdapter} from "./interfaces/IFeeAdapter.sol";
import {IPoolManager, IUnlockCallback, SwapParams, BalanceDelta, BalanceDeltaLib} from "./interfaces/IPoolManager.sol";
import {PoolKey} from "./interfaces/IInitializer.sol";
import {IDopplerERC20V1} from "./interfaces/IDopplerERC20V1.sol";
import {SOURCE_TRADING} from "./interfaces/IBuybackVault.sol";

/// @title  BuybackVault
/// @notice Singleton that holds buyback funds per asset.
///         Collects its 10% trading-fee share from Doppler and receives 30% of service
///         revenue from RevenueRouter. Swaps USDC → asset via PoolManager.unlock and burns.
///
///         v2 changes:
///         - Dual numeraire support (USDC or WMON pairs).
///         - For WMON-paired tokens, buyback accumulates USDC but skips the swap
///           (no USDC/WMON v4 pool exists). TODO: add two-hop path when pool available.
///         - Removed CapWindowActive guard (Decision #6: balance-limit exclusions
///           ensure the vault is excluded, so it can hold tokens from minute 0).
///
///         Swap path (USDC pairs): PoolManager.unlock → unlockCallback → swap → settle USDC → take asset.
///         No Universal Router, no Permit2 (CLAUDE.md rule 13 / D14).
///
///         SPEC §6.4.
contract BuybackVault is ReentrancyGuard, IUnlockCallback {
    using SafeTransferLib for address;
    using BalanceDeltaLib for BalanceDelta;

    // ── Per-asset state ───────────────────────────────────────────────────────
    struct AssetData {
        PoolKey  poolKey;
        bytes32  poolId;
        bool     registered;
        address  numeraire;              // USDC or WMON
        uint128  balanceUSDC;            // USDC pending for buyback
        uint128  buybackFromRevenue;     // cumulative USDC swapped tagged SOURCE_REVENUE/FORFEIT
        uint128  buybackFromTrading;     // cumulative USDC swapped tagged SOURCE_TRADING
        uint128  tokenBalance;           // asset tokens accumulated (from collect); burned separately
        uint64   lastExecuteTime;
    }

    mapping(address asset => AssetData) private _assets;

    // ── Singletons ────────────────────────────────────────────────────────────
    address          public immutable registry;
    IPoolManager     public immutable poolManager;
    address          constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address          constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    /// @notice Fee adapters per-asset (set at registration).
    mapping(address asset => IFeeAdapter) private _adapters;

    // Authorised callers of creditUSDC
    mapping(address => bool) public authorizedCallers;

    // ── Transient swap context (set in execute, read in unlockCallback) ───────
    address  private _swapAsset;
    uint256  private _swapUsdcIn;
    uint256  private _swapMinOut;

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotRegistry();
    error NotAuthorized();
    error AssetNotRegistered();
    error AlreadyRegistered();
    error CooldownActive();
    error ExceedsMaxPerCall();
    error SlippageTooHigh();
    error SwapFailed();
    error InsufficientBalance();
    error BuybackNotAvailable(); // WMON-paired tokens cannot be bought back yet (no USDC/WMON pool)
    error CollectFeesFailed();

    // ── Events ────────────────────────────────────────────────────────────────
    event AssetRegistered(address indexed asset, bytes32 poolId, address numeraire);
    event CallerAuthorized(address indexed caller);
    event FeeCollected(address indexed asset, uint256 numeraireDelta, uint256 tokenDelta);
    event USDCCredited(address indexed asset, uint256 amt, uint8 sourceTag);
    event BuybackExecuted(address indexed asset, uint256 usdcIn, uint256 tokensBurned, uint8 sourceTag);
    event TokensBurned(address indexed asset, uint256 amt);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _registry, address _poolManager) {
        registry    = _registry;
        poolManager = IPoolManager(_poolManager);
    }

    // ── Registry callbacks ────────────────────────────────────────────────────
    function registerAsset(address asset, PoolKey calldata poolKey, bytes32 poolId, address numeraire)
        external
    {
        if (msg.sender != registry) revert NotRegistry();
        if (_assets[asset].registered) revert AlreadyRegistered();
        _assets[asset].poolKey    = poolKey;
        _assets[asset].poolId     = poolId;
        _assets[asset].registered = true;
        _assets[asset].numeraire  = numeraire;
        emit AssetRegistered(asset, poolId, numeraire);
    }

    /// @notice Set the fee adapter for an asset. Called by AstralaunchRegistry at registration.
    function setAdapter(address asset, address adapter) external {
        if (msg.sender != registry) revert NotRegistry();
        _adapters[asset] = IFeeAdapter(adapter);
    }

    function authorize(address caller) external {
        if (msg.sender != registry) revert NotRegistry();
        authorizedCallers[caller] = true;
        emit CallerAuthorized(caller);
    }

    // ── Collect trading fees ──────────────────────────────────────────────────
    /// @notice Pull the vault's 10% Doppler trading-fee share for `asset`.
    ///         For USDC pairs: receives USDC + asset tokens.
    ///         For WMON pairs: receives WMON + asset tokens.
    function collect(address asset) external nonReentrant {
        AssetData storage d = _assets[asset];
        if (!d.registered) revert AssetNotRegistered();

        address num = d.numeraire;
        uint256 numeraireBefore = num.balanceOf(address(this));
        uint256 tokenBefore     = asset.balanceOf(address(this));

        (address target, bytes memory cdata) = _adapters[asset].collectFeesCall(d.poolId);
        (bool ok,) = target.call(cdata);
        if (!ok) revert CollectFeesFailed();

        uint256 numeraireDelta = num.balanceOf(address(this)) - numeraireBefore;
        uint256 tokenDelta     = asset.balanceOf(address(this)) - tokenBefore;

        if (num == USDC) {
            // USDC pair: numeraire fees are USDC, credit directly for buyback
            if (numeraireDelta > 0) {
                d.balanceUSDC        += uint128(numeraireDelta);
                d.buybackFromTrading += uint128(numeraireDelta);
            }
        } else {
            // WMON pair: numeraire fees are WMON. For now, WMON just stays in the vault.
            // TODO: when USDC/WMON v4 pool exists, swap WMON → USDC → asset.
            // Trading fee WMON is tracked implicitly by WMON balance held.
        }
        if (tokenDelta > 0) d.tokenBalance += uint128(tokenDelta);

        emit FeeCollected(asset, numeraireDelta, tokenDelta);
    }

    // ── USDC accounting hook ──────────────────────────────────────────────────
    /// @notice Called by RevenueRouter/FeeEscrow after transferring USDC here.
    ///         Updates internal accounting without moving funds.
    function creditUSDC(address asset, uint256 amt, uint8 sourceTag) external {
        if (!authorizedCallers[msg.sender]) revert NotAuthorized();
        AssetData storage d = _assets[asset];
        if (!d.registered) revert AssetNotRegistered();
        d.balanceUSDC += uint128(amt);
        if (sourceTag == SOURCE_TRADING) {
            d.buybackFromTrading += uint128(amt);
        } else {
            d.buybackFromRevenue += uint128(amt);
        }
        emit USDCCredited(asset, amt, sourceTag);
    }

    // ── Execute buyback ───────────────────────────────────────────────────────
    /// @notice Swap up to `usdcIn` USDC for `asset` through the asset's own Uniswap v4 pool
    ///         and burn all received tokens. Permissionless.
    ///
    ///         Only available for USDC-paired tokens. For WMON-paired tokens, the USDC
    ///         accumulates but cannot be swapped (no USDC/WMON v4 pool). Reverts with
    ///         BuybackNotAvailable().
    ///
    ///         Constraints: usdcIn ≤ MAX_PER_CALL; at most once per MIN_INTERVAL per asset.
    function execute(address asset, uint256 usdcIn, uint256 minTokenOut)
        external
        nonReentrant
    {
        AssetData storage d = _assets[asset];
        if (!d.registered) revert AssetNotRegistered();

        // WMON-paired tokens cannot be bought back yet (Decision: accumulate USDC, skip swap)
        if (d.numeraire == WMON) revert BuybackNotAvailable();

        if (block.timestamp < uint256(d.lastExecuteTime) + C.BUYBACK_MIN_INTERVAL) revert CooldownActive();
        if (usdcIn > C.BUYBACK_MAX_PER_CALL) revert ExceedsMaxPerCall();
        if (usdcIn > uint256(d.balanceUSDC)) revert InsufficientBalance();

        // Determine source tag for emission (majority-source heuristic)
        uint8 tag = (d.buybackFromRevenue >= d.buybackFromTrading) ? uint8(1) : SOURCE_TRADING;

        // Debit balance before swap (checks-effects)
        d.balanceUSDC       -= uint128(usdcIn);
        d.lastExecuteTime    = uint64(block.timestamp);

        // Execute swap via PoolManager.unlock → unlockCallback
        _swapAsset   = asset;
        _swapUsdcIn  = usdcIn;
        _swapMinOut  = minTokenOut;

        bytes memory result = poolManager.unlock(abi.encode(asset, usdcIn, minTokenOut));
        uint256 tokensBurned = abi.decode(result, (uint256));

        if (tokensBurned < minTokenOut) revert SlippageTooHigh();

        emit BuybackExecuted(asset, usdcIn, tokensBurned, tag);
    }

    // ── IUnlockCallback ───────────────────────────────────────────────────────
    /// @notice Called by PoolManager inside the unlock. Executes the swap, settles USDC, takes asset.
    function unlockCallback(bytes calldata data)
        external
        override
        returns (bytes memory)
    {
        if (msg.sender != address(poolManager)) revert NotAuthorized();

        (address asset, uint256 usdcIn,) = abi.decode(data, (address, uint256, uint256));

        PoolKey memory key  = _assets[asset].poolKey;
        bool zeroForOne     = key.currency0 == USDC; // USDC is currency0 when USDC < asset

        // Exact-input swap: sell usdcIn USDC, get as many asset tokens as possible
        SwapParams memory params = SwapParams({
            zeroForOne:        zeroForOne,
            amountSpecified:   -int256(usdcIn), // negative = exact-in
            sqrtPriceLimitX96: zeroForOne
                ? 4_295_128_740            // MIN_SQRT_RATIO + 1
                : 1_461_446_703_485_210_103_172_823_403_640 // MAX_SQRT_RATIO - 1
        });

        BalanceDelta delta = poolManager.swap(key, params, "");

        // delta signs: negative = we owe the pool; positive = pool owes us
        int128 usdcDeltaI  = zeroForOne ? delta.amount0() : delta.amount1();
        int128 tokenDeltaI = zeroForOne ? delta.amount1() : delta.amount0();

        // Settle USDC debt: sync → transfer → settle (V4 ERC-20 settlement pattern)
        uint256 usdcOwed = uint256(uint128(-usdcDeltaI));
        poolManager.sync(USDC);
        USDC.safeTransfer(address(poolManager), usdcOwed);
        poolManager.settle();

        // Take asset tokens
        uint256 tokenOut = uint256(uint128(tokenDeltaI));
        if (tokenOut > 0) {
            poolManager.take(asset, address(this), tokenOut);
            // Burn immediately
            IDopplerERC20V1(asset).burn(tokenOut);
        }

        return abi.encode(tokenOut);
    }

    // ── Burn accumulated token balance ────────────────────────────────────────
    /// @notice Burn any asset tokens that accumulated in the vault (from collect).
    function burnTokens(address asset) external nonReentrant {
        AssetData storage d = _assets[asset];
        if (!d.registered) revert AssetNotRegistered();
        uint256 bal = uint256(d.tokenBalance);
        if (bal == 0) return;
        d.tokenBalance = 0;
        IDopplerERC20V1(asset).burn(bal);
        emit TokensBurned(asset, bal);
    }

    // ── View ──────────────────────────────────────────────────────────────────
    function assetData(address asset) external view returns (AssetData memory) {
        return _assets[asset];
    }
}
