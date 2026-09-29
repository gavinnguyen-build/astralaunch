/**
 * A server pointed at a local fork must not talk to a real x402 facilitator: signed test payments
 * (chain id 143, same USDC domain as mainnet) would be verified, and could be settled, on Monad mainnet.
 */
export const isLocalUrl = (u: string) => /^https?:\/\/(127\.|localhost|0\.0\.0\.0|\[::1\])/.test(u);

/** Error message when the RPC is a local fork but the facilitator is not local; null when fine. */
export function forkFacilitatorError(rpcUrl: string, facilitatorUrl: string): string | null {
  if (!isLocalUrl(rpcUrl) || isLocalUrl(facilitatorUrl)) return null;
  return `MONAD_RPC_URL is a local fork (${rpcUrl}) but X402_FACILITATOR_URL is ${facilitatorUrl}. ` +
    'Set X402_FACILITATOR_URL to a local facilitator (e.g. http://127.0.0.1:4021) so fork payments never reach mainnet.';
}
