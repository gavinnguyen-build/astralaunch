// Local x402 facilitator for the Anvil fork (the real Monad facilitator cannot settle on a fork).
// Endpoints: GET /supported, POST /verify, POST /settle  ({ paymentPayload, paymentRequirements }).
import { createServer, type IncomingMessage } from 'node:http';
import { x402Facilitator } from '@x402/core/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { NETWORK, account, assertFork, wallet } from './env.js';

const PORT = Number(process.env.FACILITATOR_PORT ?? 4020);

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function json(res: import('node:http').ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

async function main() {
  await assertFork();
  const w = wallet('facilitator');
  const signer = toFacilitatorEvmSigner({
    address: account('facilitator').address,
    readContract: (a) => w.readContract(a as any),
    verifyTypedData: (a) => w.verifyTypedData(a as any),
    writeContract: (a) => w.writeContract(a as any),
    sendTransaction: (a) => w.sendTransaction(a as any),
    waitForTransactionReceipt: (a) => w.waitForTransactionReceipt(a as any),
    getCode: (a) => w.getCode(a),
  });

  const facilitator = new x402Facilitator();
  registerExactEvmScheme(facilitator, { signer, networks: NETWORK });

  createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/supported') return json(res, 200, facilitator.getSupported());
      if (req.method === 'POST' && (req.url === '/verify' || req.url === '/settle')) {
        const { paymentPayload, paymentRequirements } = await readJson(req);
        const out = req.url === '/verify'
          ? await facilitator.verify(paymentPayload, paymentRequirements)
          : await facilitator.settle(paymentPayload, paymentRequirements);
        console.log(`${req.url} ->`, JSON.stringify(out));
        return json(res, 200, out);
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error(e);
      json(res, 500, { error: String(e) });
    }
  }).listen(PORT, () => {
    console.log(`Local x402 facilitator on http://127.0.0.1:${PORT}  (network ${NETWORK}, submitter ${account('facilitator').address})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
