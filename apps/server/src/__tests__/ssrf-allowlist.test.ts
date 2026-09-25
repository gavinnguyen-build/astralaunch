import { describe, it, expect, vi } from 'vitest';

describe('UPSTREAM_ALLOWLIST', () => {
  it('allows only the exact allowlisted origin; other private targets stay blocked', async () => {
    vi.resetModules();
    vi.stubEnv('UPSTREAM_ALLOWLIST', 'http://127.0.0.1:4001, http://localhost:4001/');
    vi.stubEnv('ALLOW_LOCAL_UPSTREAMS', '');
    const { assertSafeUpstream, SsrfError } = await import('../lib/ssrf.js');
    await expect(assertSafeUpstream('http://127.0.0.1:4001')).resolves.toBeUndefined();
    await expect(assertSafeUpstream('http://127.0.0.1:4001/feed/digest')).resolves.toBeUndefined();
    for (const bad of ['http://127.0.0.1:4002', 'https://127.0.0.1:4001', 'http://10.0.0.1:4001', 'http://169.254.169.254/latest']) {
      await expect(assertSafeUpstream(bad)).rejects.toBeInstanceOf(SsrfError);
    }
    vi.unstubAllEnvs();
  });

  it('is empty by default', async () => {
    vi.resetModules();
    vi.stubEnv('UPSTREAM_ALLOWLIST', '');
    vi.stubEnv('ALLOW_LOCAL_UPSTREAMS', '');
    const { assertSafeUpstream, SsrfError } = await import('../lib/ssrf.js');
    await expect(assertSafeUpstream('http://127.0.0.1:4001')).rejects.toBeInstanceOf(SsrfError);
    vi.unstubAllEnvs();
  });
});
