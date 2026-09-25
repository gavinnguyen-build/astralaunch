import { createPublicClient, createTestClient, http, defineChain, hashTypedData } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const MNEMONIC = 'test test test test test test test test test test test junk';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as `0x${string}`;
const monadFork = defineChain({ id: 143, name: 'Monad Fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } } });
const pub = createPublicClient({ chain: monadFork, transport: http('http://127.0.0.1:8545') });
const testClient = createTestClient({ chain: monadFork, mode: 'anvil', transport: http('http://127.0.0.1:8545') });

const erc20Abi = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;

async function main() {
  // Check all Anvil mnemonic accounts for ERC-7702 code
  for (let i = 0; i <= 9; i++) {
    const acct = mnemonicToAccount(MNEMONIC, { addressIndex: i });
    const code = await pub.getCode({ address: acct.address });
    const isErc7702 = code && code !== '0x' && code.startsWith('0xef0100');
    console.log(`Account ${i}: ${acct.address} code=${code ?? '0x'} ERC7702=${isErc7702}`);
  }
  
  // Check USDC contract's domain info
  try {
    const name = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'name' });
    console.log('USDC name:', name);
  } catch (e) { console.log('USDC name: error', e); }
  
  try {
    const version = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'version' });
    console.log('USDC version:', version);
  } catch (e) { console.log('USDC version(): not available'); }
  
  const domSep = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'DOMAIN_SEPARATOR' });
  console.log('USDC DOMAIN_SEPARATOR:', domSep);
  
  // Try different versions
  for (const version of ['1', '2', '3']) {
    const h = hashTypedData({
      domain: { name: 'USD Coin', version, chainId: 143, verifyingContract: USDC },
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] },
      primaryType: 'EIP712Domain',
      message: { name: 'USD Coin', version, chainId: 143n, verifyingContract: USDC }
    });
    console.log(`Domain hash (version=${version}): ${h} match=${h === domSep}`);
  }
  
  // Try USDC without chainId (some USDC versions omit chainId)
  for (const version of ['1', '2']) {
    const h = hashTypedData({
      domain: { name: 'USD Coin', version, verifyingContract: USDC },
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'verifyingContract', type: 'address' }] },
      primaryType: 'EIP712Domain',
      message: { name: 'USD Coin', version, verifyingContract: USDC }
    });
    console.log(`Domain hash (no chainId, version=${version}): ${h} match=${h === domSep}`);
  }
}
main().catch(console.error);
