// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {RevpadConstants as C} from "./RevpadConstants.sol";
import {IInitializer} from "./interfaces/IInitializer.sol";

/// @title  PlatformFeeReceiver
/// @notice Singleton that sits as the 30% Doppler beneficiary, Airlock integrator,
///         and RevenueRouter treasury destination for every Revpad token.
///
///         On `collect(asset)` it calls `initializer.collectFees(poolId)` to pull
///         the platform's trading-fee share, then forwards ALL USDC and ALL asset
///         tokens to the current `treasury`.
///
///         Treasury changes use a two-step pattern with a 48-hour delay:
///         `proposeTreasury → (wait 48h) → acceptTreasury`.
///         This makes treasury changes effective for ALL tokens (old and new).
contract PlatformFeeReceiver is ReentrancyGuard {
    using SafeTransferLib for address;

    // ── Immutables ──────────────────────────────────────────────────────────────
    address   public immutable registry;
    IInitializer public immutable initializer;
    address   constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    // ── Mutable state ───────────────────────────────────────────────────────────
    address public admin;
    address public treasury;
    address public proposedTreasury;
    uint256 public proposalExecutableAt;

    // ── Per-asset state ─────────────────────────────────────────────────────────
    mapping(address asset => bytes32 poolId) public assetPoolIds;

    // ── Errors ──────────────────────────────────────────────────────────────────
    error NotAdmin();
    error NotRegistry();
    error ZeroAddress();
    error NoActiveProposal();
    error ProposalNotReady();
    error ProposalAlreadyActive();
    error AssetNotRegistered();

    // ── Events ──────────────────────────────────────────────────────────────────
    event AssetRegistered(address indexed asset, bytes32 indexed poolId);
    event Collected(address indexed asset, uint256 usdcForwarded, uint256 tokenForwarded);
    event TreasuryProposed(address indexed proposed, uint256 executableAt);
    event TreasuryAccepted(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryProposalCancelled(address indexed cancelled);

    // ── Modifiers ───────────────────────────────────────────────────────────────
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyRegistry() {
        if (msg.sender != registry) revert NotRegistry();
        _;
    }

    // ── Constructor ─────────────────────────────────────────────────────────────
    constructor(address _registry, address _initializer, address _treasury, address _admin) {
        if (_registry == address(0)) revert ZeroAddress();
        if (_initializer == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();

        registry    = _registry;
        initializer = IInitializer(_initializer);
        treasury    = _treasury;
        admin       = _admin;
    }

    // ── Registry hook ───────────────────────────────────────────────────────────
    /// @notice Called by RevpadRegistry after a successful register().
    function registerAsset(address asset, bytes32 poolId) external onlyRegistry {
        assetPoolIds[asset] = poolId;
        emit AssetRegistered(asset, poolId);
    }

    // ── Collect + forward ───────────────────────────────────────────────────────
    /// @notice Permissionless. Collects Doppler fees for `asset`, then forwards
    ///         all USDC and token balances to the current treasury.
    function collect(address asset) external nonReentrant {
        bytes32 poolId = assetPoolIds[asset];
        if (poolId == bytes32(0)) revert AssetNotRegistered();

        // Pull platform's share from the Doppler initializer
        initializer.collectFees(poolId);

        // Forward everything to treasury
        address dest = treasury;
        uint256 usdcBal  = USDC.balanceOf(address(this));
        uint256 tokenBal = asset.balanceOf(address(this));

        if (usdcBal > 0)  USDC.safeTransfer(dest, usdcBal);
        if (tokenBal > 0) asset.safeTransfer(dest, tokenBal);

        emit Collected(asset, usdcBal, tokenBal);
    }

    // ── Two-step treasury change ────────────────────────────────────────────────
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

    /// @notice Cancel a pending treasury proposal.
    function cancelProposal() external onlyAdmin {
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
}
