import { describe, it, expect, vi } from 'vitest';

vi.mock('../env.js', () => ({
  CHAIN_ID: 143,
  REGISTRY_ADDR: '0x0000000000000000000000000000000000000001',
  ESCROW_ADDR:   '0x0000000000000000000000000000000000000002',
  VAULT_ADDR:    '0x0000000000000000000000000000000000000003',
  LAUNCH_HELPER_ADDR: null,
}));
const app = (await import('../routes/config.js')).default;

describe('GET /api/config', () => {
  it('exposes deployment addresses, tokens and the launch fee', async () => {
    vi.stubEnv('PLATFORM_FEE_RECEIVER_ADDRESS', '0x0000000000000000000000000000000000000004');
    const body = await (await app.request('/')).json() as any;
    expect(body).toMatchObject({
      chainId: 143,
      contracts: { registry: '0x0000000000000000000000000000000000000001', platformFeeReceiver: '0x0000000000000000000000000000000000000004' },
      launchFee: { mon: 10, wei: '10000000000000000000', treasury: '0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C', maxPer24h: 3 },
      launchHelper: null,   // not configured: the web uses the multi-transaction flow
    });
    vi.unstubAllEnvs();
  });

  it('503 without a PlatformFeeReceiver (launch would be misconfigured)', async () => {
    vi.stubEnv('PLATFORM_FEE_RECEIVER_ADDRESS', '');
    expect((await app.request('/')).status).toBe(503);
    vi.unstubAllEnvs();
  });
});
