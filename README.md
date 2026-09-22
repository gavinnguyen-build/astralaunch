# Revpad — bộ test trên Anvil fork (Monad mainnet)

Bộ này kiểm tra các giả định của Revpad trên **Anvil fork từ Monad mainnet**, dùng contract Doppler, Uniswap v4 và USDC thật đang có trên Monad. Nó chưa chứa contract của Revpad (Router, FeeEscrow, BuybackVault). Vai trò của các contract đó được giả lập bằng ví test, gọi là "stub".

> Tình trạng: toàn bộ script đã typecheck với đúng phiên bản SDK và import chạy được. **Chưa chạy trên fork Monad thật.** Lần chạy đầu có thể phải chỉnh nhỏ.

## Cần cài

- Foundry (`anvil`, `cast`): `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- Node 20 trở lên
- Một RPC Monad mainnet có giới hạn request cao (fork gọi RPC rất nhiều)

## Cài đặt

```bash
npm install
cp .env.anvil.example .env.anvil   # điền MONAD_RPC_URL
```

Mở thư mục bằng VS Code, bấm `Cmd/Ctrl+Shift+P`, chọn **Tasks: Run Task**.

## Thứ tự chạy

| # | Task | Kiểm tra gì |
|---|---|---|
| 0 | Anvil: start Monad fork | Chạy fork ở terminal riêng, để nguyên |
| 1 | Anvil: fund test wallets (USDC) | Nạp USDC cho creator, trader, agent (tự dò storage slot) |
| 2 | Test 01: check environment | Chain id, các module Doppler có code không, Airlock owner, USDC 6 decimals, EIP-3009 |
| 3 | Anvil: snapshot save | Lưu trạng thái sạch để quay lại |
| 4 | **Test 07: x402 payment** | Agent ký EIP-3009 → facilitator local verify rồi settle → tiền về payTo. Chống replay, chống đổi số tiền |
| 5 | Test 02: launch token | Launch đúng cấu hình Revpad: phí 2%, 5/35/20/10/30, 85/15, vesting (cliff 30 ngày, 1 năm), không migrate, giới hạn 1% mỗi ví trong 10 phút. In gas |
| 6 | Test 03: buy + sell | Mua bằng USDC, bán một nửa, qua Universal Router |
| 7 | Test 04: fee split | Từng beneficiary tự gọi `collectFees`, kiểm tra tỷ lệ và tổng khoảng 2% |
| 8 | Test 05: vesting | Tua thời gian trong snapshot: ngày 29 = 0, ngày 31 > 0, khoảng 50% ở 6 tháng, đủ 100% sau 1 năm; sau đó revert |

Có thể chạy task **Revpad: full flow** để làm lần lượt bước 1, 2 và 5–8.

**Chạy test 07 trước khi tua thời gian.** Chữ ký EIP-3009 dùng giờ thực. Nếu fork đã bị tua tới tương lai, chữ ký sẽ bị coi là hết hạn.

**Test giới hạn số dư mỗi ví (O3):** trong 10 phút đầu sau launch, chạy Test 03 với khoảng 200 USDC (nhiều hơn 1% supply ở mcap khởi điểm 10K). Kỳ vọng giao dịch bị revert. Sau đó tua qua 10 phút và chạy lại, kỳ vọng thành công.

## Những gì bộ này KHÔNG kiểm được

- **Gas thật của Monad.** Monad tính phí theo gas limit và giá opcode khác Ethereum. Con số gas trên Anvil chỉ để tham khảo.
- **Facilitator x402 thật của Monad.** Ở đây dùng facilitator local chạy bằng SDK x402.
- Thực thi bất đồng bộ, finality, Envio hosted, Doppler indexer API.

Những thứ này cần test trên Monad testnet (SDK có địa chỉ cho chain 10143) hoặc mainnet với số tiền nhỏ.

## Phát hiện từ SDK (ảnh hưởng SPEC)

1. **Monad không có multicurve initializer loại thường, cũng không có loại decay** trong SDK 1.0.43. Chỉ có **Scheduled multicurve** và DopplerHook/Rehype. Script launch vì vậy dùng `withSchedule`, và **không dùng được phí chống sniper giảm dần** (ảnh hưởng O2).
2. **Phí tùy chỉnh tối đa 10%.** Mức 2% hợp lệ nhưng cần khai báo tick spacing tường minh (mặc định trong bộ này là 200).
3. **DopplerERC20V1 có sẵn vesting có cliff, `burn`, và giới hạn số dư mỗi ví theo thời gian.** Có thể không cần contract CreatorVesting dự phòng; O3 làm được natively.
4. **Beneficiary chỉ nhận phần của mình khi tự gọi `collectFees()`.** FeeEscrow và BuybackVault phải tự gọi.
5. **Hook Rehype** có phí thay đổi theo thời gian và định tuyến buyback sẵn. Nên đánh giá trước khi tự viết BuybackVault và cơ chế chống sniper.
6. **USDC Monad** theo SDK x402: `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, version EIP-712 "2". Test 01 in giá trị thật trên chain để đối chiếu.

## Cấu trúc

```
anvil/        start-fork.sh · fund.sh · snapshot.sh · time-travel.sh
src/          env.ts (roles, hằng số kinh tế, state) · 01..07 test scripts
.vscode/      tasks · launch (debug file đang mở) · extensions · settings
.anvil-state/ state.json giữa các script (tự tạo, không commit)
```

Vai trò (ví dev mặc định của Anvil, chỉ dùng cho local): 0 creator · 1 treasury · 2 escrow stub · 3 buyback stub · 4 trader · 5 agent · 6 facilitator · 7 router stub (payTo).

## Khi lỗi

- `chainId ... expected 143`: fork chưa chạy, hoặc sai `ANVIL_RPC_URL`.
- Fork chậm hoặc bị giới hạn request: đổi RPC, hoặc đặt `FORK_BLOCK` để Anvil cache được.
- `Could not find the USDC balance slot`: USDC dùng layout khác. Nạp USDC bằng cách giả làm một ví đang giữ nhiều USDC (`cast rpc anvil_impersonateAccount`).
- Launch revert: xem lỗi `simulateCreateMulticurve`. Thường do mức phí hoặc tick spacing (điểm 1–2 ở trên). Thử `POOL_FEE=10000 TICK_SPACING=200` để khoanh vùng.
