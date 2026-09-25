// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {AstralaunchConstants as C} from "./AstralaunchConstants.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";
import {IBuybackVault, SOURCE_REVENUE} from "./interfaces/IBuybackVault.sol";

/// @title  RevenueRouter
/// @notice Per-asset contract used as the x402 `payTo` address.
///         Deployed as an EIP-1167 minimal proxy clone by AstralaunchRegistry.
///         Splits every USDC inflow between provider, cost recipient, buyback, and treasury.
///
/// Split rule (SPEC §4.2, CLAUDE.md rule 1):
///   provider     = (6000 − costBps) bps
///   costRecipient = costBps bps        (hosted services only; 0 for BYO)
///   BuybackVault = 3000 bps
///   treasury     = 1000 bps
///   dust (< 1e-4 USDC per recipient per distribute) stays in contract, carried to next round.
contract RevenueRouter {
    using SafeTransferLib for address;

    // ── Storage ───────────────────────────────────────────────────────────────
    address public asset;
    address public provider;
    address public costRecipient;
    address public creator;       // only address that may call setProvider
    address public registry;      // only address that may call setCost
    address public feeEscrow;
    address public buybackVault;
    address public treasury;
    uint16  public costBps;       // 0..MAX_COST_BPS; taken from provider share
    bool    private _initialized;
    uint256 private _locked;      // reentrancy guard (1 = unlocked, 2 = locked)

    // ── Constants ─────────────────────────────────────────────────────────────
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    // ── Errors ────────────────────────────────────────────────────────────────
    error AlreadyInitialized();
    error NotCreator();
    error NotRegistry();
    error CostBpsTooHigh();
    error Reentrancy();

    // ── Events ────────────────────────────────────────────────────────────────
    event Initialized(address indexed asset, address indexed creator, address indexed provider);
    event Distributed(
        address indexed asset,
        uint256 total,
        uint256 providerAmt,
        uint256 costAmt,
        uint256 buybackAmt,
        uint256 treasuryAmt
    );
    event ProviderChanged(address indexed asset, address indexed oldProvider, address indexed newProvider);
    event CostSet(address indexed asset, address indexed costRecipient, uint16 costBps);

    // ── Reentrancy guard ──────────────────────────────────────────────────────
    modifier nonReentrant() {
        if (_locked == 2) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ── Initializer (called by clone factory, not constructor) ────────────────
    /// @notice One-time setup. Called by AstralaunchRegistry immediately after cloning.
    function initialize(
        address _asset,
        address _creator,
        address _provider,
        address _registry,
        address _feeEscrow,
        address _buybackVault,
        address _treasury
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _locked      = 1;

        asset        = _asset;
        creator      = _creator;
        provider     = _provider;
        registry     = _registry;
        feeEscrow    = _feeEscrow;
        buybackVault = _buybackVault;
        treasury     = _treasury;

        emit Initialized(_asset, _creator, _provider);
    }

    // ── Core: distribute ──────────────────────────────────────────────────────
    /// @notice Split the contract's entire USDC balance according to the revenue split.
    ///         Permissionless; anyone may call (keeper, creator, anyone).
    ///         Amounts below MIN_DISTRIBUTE are ignored and dust accumulates.
    function distribute() external nonReentrant {
        uint256 amt = USDC.balanceOf(address(this));
        if (amt < C.MIN_DISTRIBUTE) return;

        // Compute each share (integer division; remainder stays in contract as dust)
        uint256 providerBps = C.PROVIDER_BPS - uint256(costBps);
        uint256 providerAmt = (amt * providerBps) / 10_000;
        uint256 costAmt     = (amt * uint256(costBps)) / 10_000;
        uint256 buybackAmt  = (amt * C.BUYBACK_BPS)  / 10_000;
        uint256 treasuryAmt = (amt * C.TREASURY_BPS) / 10_000;
        // dust = amt - sum(above) stays in this contract for next round

        // Transfers: checks-effects-interactions — record revenue first
        // (FeeEscrow.recordRevenue is a state update with no external transfer,
        //  so calling it before transfers is safe and avoids reentrancy from transfer callbacks.)
        IFeeEscrow(feeEscrow).recordRevenue(asset, amt);

        if (providerAmt > 0) USDC.safeTransfer(provider, providerAmt);
        if (costAmt     > 0) USDC.safeTransfer(costRecipient, costAmt);
        if (buybackAmt  > 0) {
            USDC.safeTransfer(buybackVault, buybackAmt);
            IBuybackVault(buybackVault).creditUSDC(asset, buybackAmt, SOURCE_REVENUE);
        }
        if (treasuryAmt > 0) USDC.safeTransfer(treasury, treasuryAmt);

        emit Distributed(asset, amt, providerAmt, costAmt, buybackAmt, treasuryAmt);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    /// @notice Creator may change the provider payout address.
    function setProvider(address newProvider) external {
        if (msg.sender != creator) revert NotCreator();
        emit ProviderChanged(asset, provider, newProvider);
        provider = newProvider;
    }

    /// @notice Registry admin may set a cost split for hosted services.
    ///         `bps` is taken from the provider share (provider gets 6000 − bps).
    function setCost(address recipient, uint16 bps) external {
        if (msg.sender != registry) revert NotRegistry();
        if (bps > C.MAX_COST_BPS) revert CostBpsTooHigh();
        costRecipient = recipient;
        costBps       = bps;
        emit CostSet(asset, recipient, bps);
    }
}
