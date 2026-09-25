/** Links to the Monad explorer (monadscan.com): /address, /tx, /token. Opens in a new tab. */
import type { CSSProperties, ReactNode } from 'react';
import { EXPLORER_URL } from '../env.js';
import { shortAddr } from '../lib/format.js';

export const explorerUrl = {
  address: (a: string) => `${EXPLORER_URL}/address/${a}`,
  tx: (h: string) => `${EXPLORER_URL}/tx/${h}`,
  token: (a: string) => `${EXPLORER_URL}/token/${a}`,
};

const base: CSSProperties = { color: 'inherit', textDecoration: 'none', borderBottom: '1px dotted rgba(196,181,253,0.45)' };

function Ext({ href, title, children, style }: { href: string; title: string; children: ReactNode; style?: CSSProperties }) {
  return <a href={href} target="_blank" rel="noreferrer" title={title} style={{ ...base, ...style }}>{children}</a>;
}

export const AddrLink = ({ a, label, style }: { a: string; label?: ReactNode; style?: CSSProperties }) =>
  <Ext href={explorerUrl.address(a)} title={`${a} on Monadscan`} style={style}>{label ?? shortAddr(a)}</Ext>;
export const TxLink = ({ h, label, style }: { h: string; label?: ReactNode; style?: CSSProperties }) =>
  <Ext href={explorerUrl.tx(h)} title={`Transaction ${h} on Monadscan`} style={style}>{label ?? shortAddr(h)}</Ext>;
export const TokenLink = ({ a, label, style }: { a: string; label?: ReactNode; style?: CSSProperties }) =>
  <Ext href={explorerUrl.token(a)} title={`Token ${a} on Monadscan`} style={style}>{label ?? shortAddr(a)}</Ext>;
