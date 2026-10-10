import { getBase58Encoder } from '@solana/kit';
import { pathToFileURL } from 'node:url';

const base58 = getBase58Encoder();
function publicValue(value, bytes, label) {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value) || base58.encode(value).length !== bytes) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function historyOptions(args, endpoint = 'http://127.0.0.1:18899') {
  const rpc = new URL(endpoint);
  if (!['http:', 'https:'].includes(rpc.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname) || rpc.username || rpc.password || rpc.hash) {
    throw new Error('History checks require a loopback HTTP(S) RPC URL.');
  }
  let genesis;
  const receipts = [];
  for (const arg of args) {
    if (arg.startsWith('--genesis=') && !genesis) {
      genesis = publicValue(arg.slice(10), 32, 'genesis hash');
    } else if (arg.startsWith('--receipt=')) {
      const parts = arg.slice(10).split(':');
      if (parts.length !== 2 || !/^(0|[1-9]\d*)$/.test(parts[1]) || !Number.isSafeInteger(Number(parts[1]))) throw new Error('Use --receipt=SIGNATURE:SLOT with a safe nonnegative slot.');
      receipts.push({ signature: publicValue(parts[0], 64, 'transaction signature'), slot: Number(parts[1]) });
    } else {
      throw new Error('Use --genesis=HASH and one or more --receipt=SIGNATURE:SLOT options.');
    }
  }
  if (!genesis || !receipts.length || receipts.length > 32 || new Set(receipts.map(r => r.signature)).size !== receipts.length) {
    throw new Error('Specify the expected genesis and one to 32 distinct transaction receipts.');
  }
  return { rpc: rpc.href, genesis, receipts };
}

export function inspectReceipt(receipt, transaction, firstAvailableBlock) {
  if (!transaction) return { ...receipt, status: receipt.slot < firstAvailableBlock ? 'pruned' : 'unavailable' };
  if (transaction.slot !== receipt.slot || transaction.transaction?.signatures?.[0] !== receipt.signature || !transaction.meta || transaction.meta.err !== null) {
    return { ...receipt, status: 'mismatch-or-failed' };
  }
  return { ...receipt, status: 'available', blocksUntilHistoryBoundary: receipt.slot - firstAvailableBlock };
}

export async function checkHistory(options) {
  let id = 0;
  async function request(method, params = []) {
    const response = await fetch(options.rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(10000) });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(`Local RPC ${method} failed.`);
    return payload.result;
  }
  if (await request('getHealth') !== 'ok') throw new Error('Local validator is not healthy.');
  const genesis = await request('getGenesisHash');
  if (genesis !== options.genesis) throw new Error('Genesis mismatch: stop the demo and check the ledger before using these receipts.');
  const firstAvailableBlock = await request('getFirstAvailableBlock');
  const currentSlot = await request('getSlot', [{ commitment: 'finalized' }]);
  if (![firstAvailableBlock, currentSlot].every(n => Number.isSafeInteger(n) && n >= 0) || firstAvailableBlock > currentSlot) throw new Error('Invalid local history range.');
  const receipts = [];
  for (const receipt of options.receipts) {
    const transaction = await request('getTransaction', [receipt.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
    receipts.push(inspectReceipt(receipt, transaction, firstAvailableBlock));
  }
  return { checkedAt: new Date().toISOString(), rpc: options.rpc, genesis, firstAvailableBlock, currentSlot,
    allAvailable: receipts.every(r => r.status === 'available'), receipts,
    scope: 'Read-only finalized transaction availability. Does not replace instruction, account, plan, or role verification; does not guarantee future retention.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await checkHistory(historyOptions(process.argv.slice(2), process.env.AGENTOS_LOCAL_RPC_URL));
    console.log(JSON.stringify(report, null, 2));
    if (!report.allAvailable) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Local history check failed.');
    process.exitCode = 1;
  }
}
