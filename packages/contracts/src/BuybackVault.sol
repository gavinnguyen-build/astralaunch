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

/// @notice Minimal interface for WMON (Wrapped MON) deposit.
interface IWMON {
    function deposit() external payable;
}

/// @title  BuybackVault
/// @notice Singleton that holds buyback funds per asset.
///         Collects its 10% trading-fee share from Doppler and receives 30% of service
///         revenue from RevenueRouter. Swaps USDC → asset via PoolManager.unlock and burns.
///
///         v2: dual numeraire. USDC pairs: single-hop. WMON pairs: two-hop
///         (USDC → native MON → wrap → WMON → token → burn).
///
///         The MON/USDC v4 pool key used for leg-1 swaps is set at construction and
///         changeable only via propose → 48h delay → accept (guardian can cancel).
///
///         SPEC §6.4.
contract BuybackVault is ReentrancyGuard, IUnlockCallback {
    using SafeTransferLib for address;
    using BalanceDeltaLib for BalanceDelta;

    // ── Per-asset state ───────────────────────────────────────────────────────
    struct AssetData {
        bytes32  poolId;
        bool     registered;
        address  numeraire;
        uint128  balanceUSDC;
        uint128  buybackFromRevenue;
        uint128  buybackFromTrading;
        uint128  tokenBalance;
        uint64   lastExecuteTime;
    }

    mapping(address asset => AssetData) private _assets;
    mapping(address asset => PoolKey)   private _poolKeys;

    // ── Singletons ────────────────────────────────────────────────────────────
    address          public immutable registry;
    address          public immutable guardian;
    IPoolManager     public immutable poolManager;
    address          constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address          constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    mapping(address asset => IFeeAdapter) private _adapters;
    mapping(address => bool) public authorizedCallers;

    // ── MON/USDC pool key (governed) ────────────────────────────────────────
    PoolKey  public monUsdcPoolKey;
    PoolKey  private _proposedMonUsdcKey;
    uint256  public  monUsdcProposalExecAt;

    // Transient swap context
    uint256  private _swapMinMonOut;

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotRegistry();
    error NotAuthorized();
    error NotRegistryOrGuardian();
    error AssetNotRegistered();
    error AlreadyRegistered();
    error CooldownActive();
    error ExceedsMaxPerCall();
    error SlippageTooHigh();
    error InsufficientBalance();
    error CollectFeesFailed();
    error Leg1SlippageTooHigh();
    error ZeroAddress();
    error NoActiveProposal();
    error ProposalNotReady();
    error ProposalAlreadyActive();

    // ── Events ────────────────────────────────────────────────────────────────
    event AssetRegistered(address indexed asset, bytes32 poolId, address numeraire);
    event CallerAuthorized(address indexed caller);
    event FeeCollected(address indexed asset, uint256 numeraireDelta, uint256 tokenDelta);
    event USDCCredited(address indexed asset, uint256 amt, uint8 sourceTag);
    event BuybackExecuted(address indexed asset, uint256 usdcIn, uint256 tokensBurned, uint8 sourceTag);
    event TokensBurned(address indexed asset, uint256 amt);
    event MonUsdcKeyProposed(bytes32 indexed poolId, uint256 executableAt);
    event MonUsdcKeyAccepted(bytes32 indexed oldPoolId, bytes32 indexed newPoolId);
    event MonUsdcKeyProposalCancelled(bytes32 indexed cancelledPoolId);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _registry, address _poolManager, address _guardian, PoolKey memory _monUsdcKey) {
        if (_guardian == address(0)) revert ZeroAddress();
        registry    = _registry;
        poolManager = IPoolManager(_poolManager);
        guardian    = _guardian;
        monUsdcPoolKey = _monUsdcKey;
    }

    receive() external payable {}

    // ── Registry callbacks ────────────────────────────────────────────────────
    function registerAsset(address asset, PoolKey calldata poolKey, bytes32 poolId, address numeraire) external {
        if (msg.sender != registry) revert NotRegistry();
        if (_assets[asset].registered) revert AlreadyRegistered();
        _poolKeys[asset]          = poolKey;
        _assets[asset].poolId     = poolId;
        _assets[asset].registered = true;
        _assets[asset].numeraire  = numeraire;
        emit AssetRegistered(asset, poolId, numeraire);
    }

    function setAdapter(address asset, address adapter) external {
        if (msg.sender != registry) revert NotRegistry();
        _adapters[asset] = IFeeAdapter(adapter);
    }

    function authorize(address caller) external {
        if (msg.sender != registry) revert NotRegistry();
        authorizedCallers[caller] = true;
        emit CallerAuthorized(caller);
    }

    // ── MON/USDC pool key governance (propose → 48h → accept, guardian cancel) ──

    /// @notice Propose a new MON/USDC v4 pool key. Registry-only.
    function proposeMonUsdcKey(PoolKey calldata newKey) external {
        if (msg.sender != registry) revert NotRegistry();
        if (monUsdcProposalExecAt != 0) revert ProposalAlreadyActive();
        _proposedMonUsdcKey = newKey;
        monUsdcProposalExecAt = block.timestamp + C.TREASURY_CHANGE_DELAY;
        bytes32 proposedId = keccak256(abi.encode(newKey));
        emit MonUsdcKeyProposed(proposedId, monUsdcProposalExecAt);
    }

    /// @notice Accept the proposed MON/USDC key after 48h delay. Registry-only.
    function acceptMonUsdcKey() external {
        if (msg.sender != registry) revert NotRegistry();
        if (monUsdcProposalExecAt == 0) revert NoActiveProposal();
        if (block.timestamp < monUsdcProposalExecAt) revert ProposalNotReady();

        bytes32 oldId = keccak256(abi.encode(monUsdcPoolKey));
        monUsdcPoolKey = _proposedMonUsdcKey;
        bytes32 newId = keccak256(abi.encode(monUsdcPoolKey));

        // Clear proposal
        delete _proposedMonUsdcKey;
        monUsdcProposalExecAt = 0;

        emit MonUsdcKeyAccepted(oldId, newId);
    }

    /// @notice Cancel a pending MON/USDC key proposal. Registry or guardian.
    function cancelMonUsdcKeyProposal() external {
        if (msg.sender != registry && msg.sender != guardian) revert NotRegistryOrGuardian();
        if (monUsdcProposalExecAt == 0) revert NoActiveProposal();

        bytes32 cancelledId = keccak256(abi.encode(_proposedMonUsdcKey));
        delete _proposedMonUsdcKey;
        monUsdcProposalExecAt = 0;

        emit MonUsdcKeyProposalCancelled(cancelledId);
    }

    /// @notice View the pending MON/USDC key proposal.
    function pendingMonUsdcKey() external view returns (PoolKey memory key, uint256 executableAt) {
        return (_proposedMonUsdcKey, monUsdcProposalExecAt);
    }

    // ── Collect trading fees ──────────────────────────────────────────────────
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

        if (num == USDC && numeraireDelta > 0) {
            d.balanceUSDC        += uint128(numeraireDelta);
            d.buybackFromTrading += uint128(numeraireDelta);
        }
        if (tokenDelta > 0) d.tokenBalance += uint128(tokenDelta);

        emit FeeCollected(asset, numeraireDelta, tokenDelta);
    }

    // ── USDC accounting hook ──────────────────────────────────────────────────
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
    function execute(address asset, uint256 usdcIn, uint256 minMonOut, uint256 minTokenOut) external nonReentrant {
        AssetData storage d = _assets[asset];
        if (!d.registered) revert AssetNotRegistered();
        if (block.timestamp < uint256(d.lastExecuteTime) + C.BUYBACK_MIN_INTERVAL) revert CooldownActive();
        if (usdcIn > C.BUYBACK_MAX_PER_CALL) revert ExceedsMaxPerCall();
        if (usdcIn > uint256(d.balanceUSDC)) revert InsufficientBalance();

        uint8 tag = (d.buybackFromRevenue >= d.buybackFromTrading) ? uint8(1) : SOURCE_TRADING;
        d.balanceUSDC    -= uint128(usdcIn);
        d.lastExecuteTime = uint64(block.timestamp);

        _swapMinMonOut = minMonOut;
        bool isWmonPair = d.numeraire == WMON;

        bytes memory result = poolManager.unlock(abi.encode(asset, usdcIn, minTokenOut, isWmonPair));
        uint256 tokensBurned = abi.decode(result, (uint256));
        if (tokensBurned < minTokenOut) revert SlippageTooHigh();

        emit BuybackExecuted(asset, usdcIn, tokensBurned, tag);
    }

    // ── IUnlockCallback ───────────────────────────────────────────────────────
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotAuthorized();

        (address asset, uint256 usdcIn, , bool isWmonPair) =
            abi.decode(data, (address, uint256, uint256, bool));

        if (!isWmonPair) {
            return _singleHopBuyback(asset, usdcIn);
        }
        // Two-hop: USDC → native MON → wrap → WMON → token → burn
        uint256 monOut = _leg1_usdcToMon(usdcIn);
        IWMON(WMON).deposit{value: monOut}();
        uint256 tokenOut = _leg2_wmonToToken(asset, monOut);
        return abi.encode(tokenOut);
    }

    // ── Shared swap primitive ────────────────────────────────────────────────
    function _swapAndSettle(
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn,
        address inputToken,
        address outputToken
    ) internal returns (uint256 outputReceived) {
        BalanceDelta delta = poolManager.swap(key, SwapParams({
            zeroForOne:        zeroForOne,
            amountSpecified:   -int256(amountIn),
            sqrtPriceLimitX96: zeroForOne ? 4_295_128_740 : 1_461_446_703_485_210_103_172_823_403_640
        }), "");

        // Settle input debt
        {
            int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
            uint256 owed = uint256(uint128(-inputDelta));
            poolManager.sync(inputToken);
            inputToken.safeTransfer(address(poolManager), owed);
            poolManager.settle();
        }

        // Take output
        {
            int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
            outputReceived = uint256(uint128(outputDelta));
            if (outputReceived > 0) {
                poolManager.take(outputToken, address(this), outputReceived);
            }
        }
    }

    /// @notice Single-hop: USDC → token (for USDC-paired assets).
    function _singleHopBuyback(address asset, uint256 usdcIn) internal returns (bytes memory) {
        PoolKey memory key = _poolKeys[asset];
        bool zeroForOne = key.currency0 == USDC;
        uint256 tokenOut = _swapAndSettle(key, zeroForOne, usdcIn, USDC, asset);
        if (tokenOut > 0) IDopplerERC20V1(asset).burn(tokenOut);
        return abi.encode(tokenOut);
    }

    /// @notice Leg 1: USDC → native MON via governed MON/USDC v4 pool.
    function _leg1_usdcToMon(uint256 usdcIn) internal returns (uint256 monOut) {
        PoolKey memory monKey = monUsdcPoolKey;
        // native MON is currency0 (address(0)), USDC is currency1; zeroForOne=false
        monOut = _swapAndSettle(monKey, false, usdcIn, USDC, address(0));
        if (monOut < _swapMinMonOut) revert Leg1SlippageTooHigh();
    }

    /// @notice Leg 2: WMON → token via Doppler pool.
    function _leg2_wmonToToken(address asset, uint256 wmonIn) internal returns (uint256 tokenOut) {
        PoolKey memory tokenKey = _poolKeys[asset];
        bool zeroForOne = tokenKey.currency0 == WMON;
        tokenOut = _swapAndSettle(tokenKey, zeroForOne, wmonIn, WMON, asset);
        if (tokenOut > 0) IDopplerERC20V1(asset).burn(tokenOut);
    }

    // ── Burn accumulated token balance ────────────────────────────────────────
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

    function getPoolKey(address asset) external view returns (PoolKey memory) {
        return _poolKeys[asset];
    }
}
