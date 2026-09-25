/**
 * x402 header names, shared by the gateway and CORS. The SDK's HTTP client (x402HTTPClient in
 * @x402/core/client) uses these names but exports no constants: v2 = PAYMENT-SIGNATURE /
 * PAYMENT-REQUIRED / PAYMENT-RESPONSE. The legacy X-PAYMENT* names are kept for existing clients (D-GW1).
 */
export const PAYMENT_HEADERS          = ['PAYMENT-SIGNATURE', 'X-PAYMENT'] as const;
export const PAYMENT_REQUIRED_HEADERS = ['PAYMENT-REQUIRED', 'X-PAYMENT-REQUIRED'] as const;
export const PAYMENT_RESPONSE_HEADERS = ['PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'] as const;
export const PAYMENT_RESPONSE_HEADER  = PAYMENT_RESPONSE_HEADERS[0];
