import { usePrivy, useWallets } from '@privy-io/react-auth';
import { fmtAddr } from '../lib/format.js';

export default function ConnectButton() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();

  if (!ready) return null;

  if (!authenticated) {
    return (
      <button className="btn btn-primary btn-sm" onClick={login}>
        Connect
      </button>
    );
  }

  const addr = wallets[0]?.address;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{
        padding: '4px 10px',
        borderRadius: '6px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        fontSize: '12px',
        fontFamily: 'monospace',
      }}>
        {fmtAddr(addr)}
      </span>
      <button className="btn btn-outline btn-sm" onClick={logout}>
        Sign out
      </button>
    </div>
  );
}
