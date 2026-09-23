// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {RevpadConstants as C} from "./RevpadConstants.sol";
import {IInitializer, PoolKey} from "./interfaces/IInitializer.sol";
import {IPoolManager, IUnlockCallback, SwapParams, BalanceDelta, BalanceDeltaLib} from "./interfaces/IPoolManager.sol";
import {IDopplerERC20V1} from "./interfaces/IDopplerERC20V1.sol";
import {SOURCE_TRADING} from "./interfaces/IBuybackVault.sol";

/// @title  BuybackVault
/// @notice Singleton that holds buyback funds per asset.
///         Collects its 10 % trading-fee share from Doppler and receives 30 % of service
///         revenue from RevenueRouter. Swaps USDC → asset via PoolManager.unlock and burns.
///
///         Swap path: PoolManager.unlock → unlockCallback → swap → settle USDC → take asset.
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
        uint128  balanceUSDC;          // USDC pending for buyback
        uint128  buybackFromRevenue;   // cumulative USDC swapped tagged SOURCE_REVENUE/FORFEIT
        uint128  buybackFromTrading;   // cumulative USDC swapped tagged SOURCE_TRADING
        uint128  tokenBalance;         // asset tokens accumulated (from collect); burned separately
        uint64   lastExecuteTime;
    }

    mapping(address asset => AssetData) private _assets;

    // ── Singletons ────────────────────────────────────────────────────────────
    address          public immutable registry;
    IInitializer     public immutable initializer;
    IPoolManager     public immutable poolManager;
    address          constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

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
    error CapWindowActive();
    error ExceedsMaxPerCall();
    error SlippageTooHigh();
    error SwapFailed();
    error InsufficientBalance();

    // ── Events ────────────────────────────────────────────────────────────────
    event AssetRegistered(address indexed asset, bytes32 poolId);
    event CallerAuthorized(address indexed caller);
    event FeeCollected(address indexed asset, uint256 usdcDelta, uint256 tokenDelta);
    event USDCCredited(address indexed asset, uint256 amt, uint8 sourceTag);
    event BuybackExecuted(address indexed asset, uint256 usdcIn, uint256 tokensBurned, uint8 sourceTag);
    event TokensBurned(address indexed asset, uint256 amt);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _registry, address _initializer, address _poolManager) {
        registry    = _registry;
        initializer = IInitializer(_initializer);
        poolManager = IPoolManager(_poolManager);
    }

    // ── Registry callbacks ────────────────────────────────────────────────────
    function registerAsset(address asset, PoolKey calldata poolKey, bytes32 poolId)
        external
    {
        if (msg.sender != registry) revert NotRegistry();
        if (_assets[asset].registered) revert AlreadyRegistered();
        _assets[asset].poolKey    = poolKey;
        _assets[asset].poolId     = poolId;
        _assets[asset].registered = true;
        emit AssetRegistered(asset, poolId);
    }

    function authorize(address caller) external {
        if (msg.sender != registry) revert NotRegistry();
        authorizedCallers[caller] = true;
        emit CallerAuthorized(caller);
    }

    // ── Collect trading fees ──────────────────────────────────────────────────
    /// @notice Pull the vault's 10 % Doppler trading-fee share for `asset`.
    function collect(address asset) external nonReentrant {
        AssetData storage d = _assets[asset];
        if (!d.registered) revert AssetNotRegistered();

        uint256 usdcBefore  = USDC.balanceOf(address(this));
        uint256 tokenBefore = asset.balanceOf(address(this));

        initializer.collectFees(d.poolId);

        uint256 usdcDelta  = USDC.balanceOf(address(this)) - usdcBefore;
        uint256 tokenDelta = asset.balanceOf(address(this)) - tokenBefore;

        if (usdcDelta  > 0) {
            d.balanceUSDC        += uint128(usdcDelta);
            d.buybackFromTrading += uint128(usdcDelta);
        }
        if (tokenDelta > 0) d.tokenBalance += uint128(tokenDelta);

        emit FeeCollected(asset, usdcDelta, tokenDelta);
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
    ///         Constraints: usdcIn ≤ MAX_PER_CALL; at most once per MIN_INTERVAL per asset.
    function execute(address asset, uint256 usdcIn, uint256 minTokenOut)
        external
        nonReentrant
    {
        AssetData storage d = _assets[asset];
        if (!d.registered) revert AssetNotRegistered();
        // Refuse during the DopplerERC20V1 per-wallet balance-cap window.
        // At launch price (~$0.00001/token), even 0.1 USDC buys ≥1% of supply,
        // which exceeds the vault's own balance limit and reverts inside the swap.
        // Guard here gives a clear error instead of a cryptic ERC-20 revert.
        if (block.timestamp < uint256(IDopplerERC20V1(asset).balanceLimitEnd())) revert CapWindowActive();
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
        // After selling USDC (currency0 or 1):
        //   the USDC side of delta is negative (we owe)
        //   the asset side of delta is positive (pool owes us)
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
