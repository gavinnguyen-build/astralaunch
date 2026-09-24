// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {RevpadConstants as C} from "./RevpadConstants.sol";
import {IInitializer} from "./interfaces/IInitializer.sol";
import {IBuybackVault, SOURCE_FORFEIT} from "./interfaces/IBuybackVault.sol";

/// @title  FeeEscrow
/// @notice Singleton that holds the 20 % escrowed creator fee share for every Revpad asset.
///         Trading fees (from Doppler) accumulate here when `collect` is called.
///         Service revenue (from distribute) unlocks escrowed USDC at 0.2 : 1 ratio.
///
///         SPEC §4.3 / §6.3.
contract FeeEscrow is ReentrancyGuard {
    using SafeTransferLib for address;

    // ── Storage per asset ─────────────────────────────────────────────────────
    struct TokenData {
        address creator;
        uint48  launchTime;
        bool    forfeited;
        uint128 usdcAccrued;      // USDC collected from Doppler trading fees
        uint128 usdcClaimed;      // USDC already paid to creator
        uint128 tokenPending;     // asset-denominated fees not yet swapped to USDC (O4)
        uint128 recordedRevenue;  // cumulative USDC recorded by router.distribute()
        bytes32 poolId;           // Uniswap v4 pool id for collectFees
    }

    mapping(address asset => TokenData) private _data;

    // ── Singletons ────────────────────────────────────────────────────────────
    address         public immutable registry;
    address         public immutable buybackVault;
    IInitializer    public immutable initializer;
    address         constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

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
    event AssetRegistered(address indexed asset, address indexed creator, uint48 launchTime);
    event FeeCollected(address indexed asset, uint256 usdcDelta, uint256 tokenDelta);
    event RevenueRecorded(address indexed asset, uint256 amt, uint256 newTotal);
    event Claimed(address indexed asset, address indexed creator, uint256 amt);
    event Forfeited(address indexed asset, uint256 usdcMoved, uint256 tokenMoved);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _registry, address _buybackVault, address _initializer) {
        registry     = _registry;
        buybackVault = _buybackVault;
        initializer  = IInitializer(_initializer);
    }

    // ── Registry callbacks ────────────────────────────────────────────────────
    /// @notice Register a new asset. Called once by RevpadRegistry after deploying the router.
    function registerAsset(address asset, address creator, uint48 launchTime, bytes32 poolId)
        external
    {
        if (msg.sender != registry) revert NotRegistry();
        if (_data[asset].launchTime != 0) revert AlreadyRegistered();
        _data[asset] = TokenData({
            creator:         creator,
            launchTime:      launchTime,
            forfeited:       false,
            usdcAccrued:     0,
            usdcClaimed:     0,
            tokenPending:    0,
            recordedRevenue: 0,
            poolId:          poolId
        });
        emit AssetRegistered(asset, creator, launchTime);
    }

    /// @notice Authorize a router to call recordRevenue. Called by RevpadRegistry.
    function authorizeRouter(address router) external {
        if (msg.sender != registry) revert NotRegistry();
        authorizedRouters[router] = true;
    }

    // ── Collect trading fees ──────────────────────────────────────────────────
    /// @notice Pull the escrow's share of Doppler trading fees for `asset`.
    ///         Anyone may trigger; the escrow calls collectFees as the beneficiary.
    ///         Attribution: USDC and token deltas around the call belong to this asset.
    function collect(address asset) external nonReentrant {
        TokenData storage d = _data[asset];
        if (d.launchTime == 0) revert AssetNotRegistered();

        uint256 usdcBefore  = USDC.balanceOf(address(this));
        uint256 tokenBefore = asset.balanceOf(address(this));

        initializer.collectFees(d.poolId);

        uint256 usdcDelta  = USDC.balanceOf(address(this)) - usdcBefore;
        uint256 tokenDelta = asset.balanceOf(address(this)) - tokenBefore;

        if (d.forfeited) {
            // Post-forfeit: route any new accruals directly to BuybackVault
            if (usdcDelta > 0) {
                USDC.safeTransfer(buybackVault, usdcDelta);
                IBuybackVault(buybackVault).creditUSDC(asset, usdcDelta, SOURCE_FORFEIT);
            }
            // Token fees post-forfeit: just leave in contract; keeper can call forfeit again
        } else {
            if (usdcDelta  > 0) d.usdcAccrued   += uint128(usdcDelta);
            if (tokenDelta > 0) d.tokenPending   += uint128(tokenDelta);
        }

        emit FeeCollected(asset, usdcDelta, tokenDelta);
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

        uint256 usdcRemaining  = uint256(d.usdcAccrued) - uint256(d.usdcClaimed);
        uint256 tokenRemaining = uint256(d.tokenPending);

        if (usdcRemaining > 0) {
            d.usdcAccrued = d.usdcClaimed; // zero out available balance
            USDC.safeTransfer(buybackVault, usdcRemaining);
            IBuybackVault(buybackVault).creditUSDC(asset, usdcRemaining, SOURCE_FORFEIT);
        }
        if (tokenRemaining > 0) {
            d.tokenPending = 0;
            asset.safeTransfer(buybackVault, tokenRemaining);
        }

        emit Forfeited(asset, usdcRemaining, tokenRemaining);
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
