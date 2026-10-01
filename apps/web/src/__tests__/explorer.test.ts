import { describe, it, expect } from 'vitest';
import { explorerBase, explorerLinks } from '../lib/explorer.js';

const TX = '0x711fcc3146e69c71cf66ad31f049054f29da468d0acea088046718c6b230f4f4';

describe('explorerBase', () => {
  it('falls back to Monadscan for undefined, null, empty and blank values', () => {
    for (const v of [undefined, null, '', '   ', '\n']) expect(explorerBase(v)).toBe('https://monadscan.com');
  });
  it('falls back for invalid, relative or non-http(s) values', () => {
    for (const v of ['monadscan.com', '/tx', 'not a url', 'ftp://monadscan.com', 'javascript:alert(1)', 'https://']) {
      expect(explorerBase(v), v).toBe('https://monadscan.com');
    }
  });
  it('keeps a valid absolute URL, trimmed and without trailing slashes', () => {
    expect(explorerBase(' https://monadscan.com/ ')).toBe('https://monadscan.com');
    expect(explorerBase('https://testnet.monadscan.com')).toBe('https://testnet.monadscan.com');
    expect(explorerBase('http://localhost:5100/explorer//')).toBe('http://localhost:5100/explorer');
  });
  it('links are always absolute', () => {
    for (const v of [undefined, '', 'https://monadscan.com']) {
      const l = explorerLinks(explorerBase(v));
      expect(l.tx(TX)).toBe(`https://monadscan.com/tx/${TX}`);
      expect(l.address('0xabc')).toBe('https://monadscan.com/address/0xabc');
      expect(l.token('0xdef')).toBe('https://monadscan.com/token/0xdef');
    }
  });
});
