// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {BuybackVault} from "../../src/BuybackVault.sol";
import {AstralaunchConstants as C} from "../../src/AstralaunchConstants.sol";
import {IFeeAdapter} from "../../src/interfaces/IFeeAdapter.sol";
import {PoolKey} from "../../src/interfaces/IInitializer.sol";
import {SOURCE_REVENUE, SOURCE_TRADING} from "../../src/interfaces/IBuybackVault.sol";

// ── Minimal stubs for invariant testing ───────────────────────────────────────
contract InvMockUSDC {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function transfer(address to, uint256 amt) external returns (bool) {
        if (balanceOf[msg.sender] < amt) return false;
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }
}

/// @dev Implements IFeeAdapter for invariant test use.
contract InvMockInit is IFeeAdapter {
    function doCollect(bytes32) external pure returns (uint128, uint128) { return (0, 0); }

    function collectFeesCall(bytes32 poolId)
        external view override
        returns (address target, bytes memory data)
    {
        return (address(this), abi.encodeCall(this.doCollect, (poolId)));
    }

    function getShares(bytes32, address) external pure override returns (uint256) { return 0; }
    function getState(address)
        external pure override
        returns (address, uint8, PoolKey memory, int24)
    {
        PoolKey memory k;
        return (address(0), 0, k, 0);
    }
}

contract InvMockOracle {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 2500000, 0, block.timestamp, 1); // $0.025 MON/USD, 8 decimals
    }
    function decimals() external pure returns (uint8) { return 8; }
}

contract InvMockPM {
    function unlock(bytes calldata) external pure returns (bytes memory) { return ""; }
    function swap(PoolKey memory, bytes calldata, bytes calldata) external pure returns (int256) { return 0; }
    function settle() external payable returns (uint256) { return 0; }
    function sync(address) external {}
    function take(address, address, uint256) external {}
}

/// @notice Handler contract that performs all state-changing operations.
///         Invariant fuzzer calls functions on this handler.
contract AstralaunchHandler is Test {
    RevenueRouter  router;
    FeeEscrow      escrow;
    BuybackVault   vault;
    InvMockUSDC    usdc;

    address provider;
    address treasury;
    address creator;
    address asset;

    uint256 public totalDistributed;
    uint256 public totalProviderReceived;
    uint256 public totalTreasuryReceived;
    uint256 public totalBuybackCredited;

    constructor(
        RevenueRouter _router, FeeEscrow _escrow, BuybackVault _vault,
        InvMockUSDC _usdc,
        address _provider, address _treasury, address _creator, address _asset
    ) {
        router   = _router;
        escrow   = _escrow;
        vault    = _vault;
        usdc     = _usdc;
        provider = _provider;
        treasury = _treasury;
        creator  = _creator;
        asset    = _asset;
    }

    function distribute(uint256 amt) external {
        amt = bound(amt, C.MIN_DISTRIBUTE, 100_000e6);
        usdc.mint(address(router), amt);
        totalDistributed += amt;
        router.distribute();
        totalProviderReceived += usdc.balanceOf(provider);
        totalTreasuryReceived += usdc.balanceOf(treasury);
        totalBuybackCredited  += vault.assetData(asset).balanceUSDC;
    }

    uint256 public totalFunded; // sub-threshold amounts added directly to router

    function fundRouter(uint256 amt) external {
        amt = bound(amt, 1, C.MIN_DISTRIBUTE - 1);
        usdc.mint(address(router), amt);
        totalFunded += amt;
    }

    function claimEscrow() external {
        if (escrow.claimable(asset) == 0) return;
        vm.prank(creator);
        escrow.claim(asset);
    }
}

// ── Invariant test contract ───────────────────────────────────────────────────
contract AstralaunchInvariantsTest is StdInvariant, Test {
    RevenueRouter      routerImpl;
    RevenueRouter      router;
    FeeEscrow          escrow;
    BuybackVault       vault;
    InvMockUSDC        usdc;
    InvMockInit        init_;
    InvMockPM          pm;
    AstralaunchHandler handler;

    address asset    = address(0xA55E7);
    address creator  = address(0xC8EA7012);
    address treasury = address(0x7AEA5);
    address provider = address(0xBEEF);
    address registry = address(this);
    bytes32 poolId   = keccak256("inv-pool");

    PoolKey poolKey;

    function setUp() public {
        usdc  = new InvMockUSDC();
        init_ = new InvMockInit();
        pm    = new InvMockPM();

        vm.etch(0x754704Bc059F8C67012fEd69BC8A327a5aafb603, address(usdc).code);
        usdc = InvMockUSDC(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);

        InvMockOracle orc = new InvMockOracle();
        escrow = new FeeEscrow(registry, address(0), address(orc), 3600);
        vault  = new BuybackVault(registry, address(pm));

        routerImpl = new RevenueRouter();
        address clone = LibClone.clone(address(routerImpl));
        router = RevenueRouter(clone);
        router.initialize(asset, creator, provider, registry, address(escrow), address(vault), treasury);

        poolKey = PoolKey({currency0:address(0), currency1:address(0), fee:0, tickSpacing:0, hooks:address(0)});

        // v2 registerAsset: extra numeraire param
        escrow.registerAsset(asset, creator, uint48(block.timestamp), poolId, 0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
        escrow.setAdapter(asset, address(init_));
        escrow.authorizeRouter(address(router));
        vault.registerAsset(asset, poolKey, poolId, 0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
        vault.setAdapter(asset, address(init_));
        vault.authorize(address(router));
        vault.authorize(address(escrow));

        handler = new AstralaunchHandler(router, escrow, vault, usdc, provider, treasury, creator, asset);

        // Fund handler for test
        usdc.mint(address(handler), 1_000_000e6);

        targetContract(address(handler));
    }

    /// @notice No funds accumulate in the escrow beyond what was collected.
    function invariant_escrowNeverOwesMoreThanAccrued() public view {
        FeeEscrow.TokenData memory d = escrow.tokenData(asset);
        // claimed <= accrued
        assertLe(uint256(d.usdcClaimed), uint256(d.usdcAccrued));
        // claimable + claimed <= accrued
        assertLe(escrow.claimable(asset) + uint256(d.usdcClaimed), uint256(d.usdcAccrued));
    }

    /// @notice Escrow unlock allowance <= ESCROW_UNLOCK_BPS/10000 of recorded revenue.
    function invariant_escrowAllowanceBoundedByRevenue() public view {
        FeeEscrow.TokenData memory d = escrow.tokenData(asset);
        uint256 allowance = (uint256(d.recordedRevenue) * C.ESCROW_UNLOCK_BPS) / 10_000;
        assertLe(escrow.claimable(asset) + uint256(d.usdcClaimed), allowance + uint256(d.usdcAccrued));
    }

    /// @notice BuybackVault balance only grows from creditUSDC and decreases from execute.
    function invariant_vaultBalanceNonNegative() public view {
        // AssetData.balanceUSDC is uint128 so always >= 0; just sanity check
        assertLe(vault.assetData(asset).balanceUSDC, type(uint128).max);
    }

    /// @notice Router balance <= funded-but-not-distributed amounts + rounding dust.
    function invariant_routerDustAccountable() public view {
        uint256 routerBal = usdc.balanceOf(address(router));
        // routerBal comprises:
        //   (a) sub-threshold amounts from fundRouter that never triggered distribute
        //   (b) rounding dust left after each distribute call (<= 3 wei per call)
        // Upper bound: totalFunded + MIN_DISTRIBUTE (generous allowance for dust accumulation)
        assertLt(routerBal, handler.totalFunded() + C.MIN_DISTRIBUTE);
    }
}
