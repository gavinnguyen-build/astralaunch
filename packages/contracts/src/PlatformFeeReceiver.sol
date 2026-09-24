// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {AstralaunchConstants as C} from "./AstralaunchConstants.sol";
import {IFeeAdapter} from "./interfaces/IFeeAdapter.sol";

/// @title  PlatformFeeReceiver
/// @notice Singleton that sits as the 30% Doppler beneficiary, Airlock integrator,
///         and RevenueRouter treasury destination for every Astralaunch token.
///
///         On `collect(asset)` it calls `adapter.collectFees(poolId)` to pull
///         the platform's trading-fee share, then forwards ALL USDC, ALL WMON,
///         and ALL asset tokens to the current `treasury`.
///
///         v2 changes:
///         - Guardian role (Decision #4): can cancel treasury proposals and admin transfers.
///         - Per-token numeraire: forwards USDC + WMON + asset to treasury.
///         - Uses IFeeAdapter instead of direct IInitializer.
///
///         Treasury changes use a two-step pattern with a 48-hour delay:
///         `proposeTreasury → (wait 48h) → acceptTreasury`.
contract PlatformFeeReceiver is ReentrancyGuard {
    using SafeTransferLib for address;

    // ── Immutables ────────────────────────────────────────────────────────────
    address   public immutable registry;
    address   public immutable guardian;
    address   constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address   constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    // ── Mutable state ─────────────────────────────────────────────────────────
    address public admin;
    address public treasury;
    address public proposedTreasury;
    uint256 public proposalExecutableAt;
    address public pendingAdmin;

    // ── Per-asset state ───────────────────────────────────────────────────────
    mapping(address asset => bytes32 poolId)    public assetPoolIds;
    mapping(address asset => address numeraire) public assetNumeraires;
    mapping(address asset => IFeeAdapter)       private _adapters;

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotAdmin();
    error NotRegistry();
    error NotAdminOrGuardian();
    error ZeroAddress();
    error NoActiveProposal();
    error ProposalNotReady();
    error ProposalAlreadyActive();
    error AssetNotRegistered();
    error NotPendingAdmin();
    error NoActiveTransfer();

    // ── Events ────────────────────────────────────────────────────────────────
    event AssetRegistered(address indexed asset, bytes32 indexed poolId, address numeraire);
    event Collected(address indexed asset, uint256 usdcForwarded, uint256 tokenForwarded, uint256 numeraireForwarded);
    event TreasuryProposed(address indexed proposed, uint256 executableAt);
    event TreasuryAccepted(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryProposalCancelled(address indexed cancelled);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event AdminTransferCancelled(address indexed cancelledPendingAdmin);

    // ── Modifiers ─────────────────────────────────────────────────────────────
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyRegistry() {
        if (msg.sender != registry) revert NotRegistry();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _registry, address _treasury, address _admin, address _guardian) {
        if (_registry == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        if (_guardian == address(0)) revert ZeroAddress();

        registry = _registry;
        treasury = _treasury;
        admin    = _admin;
        guardian  = _guardian;
    }

    // ── Registry hook ─────────────────────────────────────────────────────────
    /// @notice Called by AstralaunchRegistry after a successful register().
    function registerAsset(address asset, bytes32 poolId, address numeraire) external onlyRegistry {
        assetPoolIds[asset]    = poolId;
        assetNumeraires[asset] = numeraire;
        emit AssetRegistered(asset, poolId, numeraire);
    }

    /// @notice Set the fee adapter for an asset. Called by AstralaunchRegistry at registration.
    function setAdapter(address asset, address adapter) external onlyRegistry {
        _adapters[asset] = IFeeAdapter(adapter);
    }

    // ── Collect + forward ─────────────────────────────────────────────────────
    /// @notice Permissionless. Collects Doppler fees for `asset`, then forwards
    ///         all USDC, WMON, and token balances to the current treasury.
    function collect(address asset) external nonReentrant {
        bytes32 poolId = assetPoolIds[asset];
        if (poolId == bytes32(0)) revert AssetNotRegistered();

        // Pull platform's share from the Doppler initializer via adapter
        _adapters[asset].collectFees(poolId);

        // Forward everything to treasury
        address dest = treasury;
        uint256 usdcBal  = USDC.balanceOf(address(this));
        uint256 tokenBal = asset.balanceOf(address(this));

        address num = assetNumeraires[asset];
        uint256 numeraireBal;
        if (num != USDC) {
            numeraireBal = num.balanceOf(address(this));
        }

        if (usdcBal > 0)      USDC.safeTransfer(dest, usdcBal);
        if (tokenBal > 0)     asset.safeTransfer(dest, tokenBal);
        if (numeraireBal > 0) num.safeTransfer(dest, numeraireBal);

        emit Collected(asset, usdcBal, tokenBal, numeraireBal);
    }

    // ── Two-step treasury change ──────────────────────────────────────────────
    /// @notice Propose a new treasury. Reverts if a proposal is already active.
    function proposeTreasury(address newTreasury) external onlyAdmin {
        if (newTreasury == address(0)) revert ZeroAddress();
        if (proposedTreasury != address(0)) revert ProposalAlreadyActive();

        proposedTreasury    = newTreasury;
        proposalExecutableAt = block.timestamp + C.TREASURY_CHANGE_DELAY;

        emit TreasuryProposed(newTreasury, proposalExecutableAt);
    }

    /// @notice Accept the pending treasury change after the 48h delay.
    function acceptTreasury() external onlyAdmin {
        if (proposedTreasury == address(0)) revert NoActiveProposal();
        if (block.timestamp < proposalExecutableAt) revert ProposalNotReady();

        address oldTreasury = treasury;
        treasury = proposedTreasury;

        // Clear proposal
        proposedTreasury     = address(0);
        proposalExecutableAt = 0;

        emit TreasuryAccepted(oldTreasury, treasury);
    }

    /// @notice Cancel a pending treasury proposal. Admin or guardian (Decision #4).
    function cancelProposal() external {
        if (msg.sender != admin && msg.sender != guardian) revert NotAdminOrGuardian();
        if (proposedTreasury == address(0)) revert NoActiveProposal();

        address cancelled = proposedTreasury;
        proposedTreasury     = address(0);
        proposalExecutableAt = 0;

        emit TreasuryProposalCancelled(cancelled);
    }

    /// @notice Returns the pending treasury proposal details.
    function pendingTreasury() external view returns (address proposed, uint256 executableAt) {
        return (proposedTreasury, proposalExecutableAt);
    }

    // ── Two-step admin transfer ───────────────────────────────────────────────
    /// @notice Start a two-step admin transfer. Only current admin.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Accept admin role. Only pendingAdmin.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address oldAdmin = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(oldAdmin, admin);
    }

    /// @notice Cancel a pending admin transfer. Admin or guardian (Decision #4).
    function cancelAdminTransfer() external {
        if (msg.sender != admin && msg.sender != guardian) revert NotAdminOrGuardian();
        if (pendingAdmin == address(0)) revert NoActiveTransfer();
        address cancelled = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferCancelled(cancelled);
    }
}
