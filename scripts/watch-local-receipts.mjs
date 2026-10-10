import { createHash } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getBase58Encoder } from '@solana/kit';

const base58 = getBase58Encoder();
const publicValue = (value, size) => {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value) || base58.encode(value).length !== size) throw new Error('Invalid public address or signature.');
  return value;
};
const integer = (text, minimum, maximum) => {
  if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < minimum || Number(text) > maximum) throw new Error('Invalid capture limit or slot.');
  return Number(text);
};
export function receiptWatchOptions(args, endpoint = 'http://127.0.0.1:18899') {
  const rpc = new URL(endpoint);
  if (!['http:', 'https:'].includes(rpc.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname) || rpc.username || rpc.password || rpc.hash) throw new Error('Receipt capture requires a loopback RPC.');
  const values = new Map(), addresses = [];
  for (const arg of args) {
    const match = /^--(genesis|address|output|seconds|from-slot)=(.+)$/.exec(arg);
    if (!match) throw new Error('Use --genesis=HASH, --address=ADDRESS, --output=docs/evidence/NEW-DIRECTORY and optional --seconds=N / --from-slot=N.');
    if (match[1] === 'address') addresses.push(publicValue(match[2], 32));
    else { if (values.has(match[1])) throw new Error('Duplicate capture option.'); values.set(match[1], match[2]); }
  }
  if (!values.has('genesis') || !addresses.length || addresses.length > 8 || new Set(addresses).size !== addresses.length) throw new Error('Specify an expected genesis and one to eight distinct public addresses.');
  const output = values.get('output');
  if (!output || !/^docs\/evidence\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(output)) throw new Error('Use a new named directory directly inside docs/evidence.');
  return { rpc: rpc.href, genesis: publicValue(values.get('genesis'), 32), addresses, output,
    seconds: integer(values.get('seconds') ?? '60', 1, 7200),
    ...(values.has('from-slot') ? { fromSlot: integer(values.get('from-slot'), 0, Number.MAX_SAFE_INTEGER) } : {}) };
}
export function inspectLocalReceipt(row, transaction, addresses) {
  publicValue(row.signature, 64);
  if (!Number.isSafeInteger(row.slot) || row.slot < 0 || !transaction || transaction.slot !== row.slot || transaction.transaction?.signatures?.[0] !== row.signature || !transaction.meta || !Object.hasOwn(transaction.meta, 'err')) throw new Error('Receipt does not match its original transaction and slot.');
  const keys = transaction.transaction.message?.accountKeys;
  if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string')) throw new Error('Expected the original JSON transaction account keys.');
  const loaded = transaction.meta.loadedAddresses ?? { writable: [], readonly: [] };
  if (!Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly) || ![...loaded.writable, ...loaded.readonly].every(key => typeof key === 'string')) throw new Error('Invalid loaded transaction addresses.');
  const used = new Set([...keys, ...loaded.writable, ...loaded.readonly]);
  const matchedAddresses = addresses.filter(key => used.has(key));
  if (!matchedAddresses.length) throw new Error('Transaction does not involve a watched public address.');
  return { signature: row.signature, slot: row.slot, successful: transaction.meta.err === null, matchedAddresses };
}

export async function watchLocalReceipts(options) {
  let requestId = 0;
  async function rpc(method, params = []) {
    const response = await fetch(options.rpc, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(10000) });
    if (!response.ok || !response.body) throw new Error(`Local RPC ${method} failed.`);
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_000_000) { await reader.cancel(); throw new Error('Local RPC response exceeds 2 MB.'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks), payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (payload.error || !Object.hasOwn(payload, 'result')) throw new Error(`Local RPC ${method} returned an error.`);
    return { value: payload.result, bytes };
  }
  if ((await rpc('getHealth')).value !== 'ok' || (await rpc('getGenesisHash')).value !== options.genesis) throw new Error('Expected healthy validator and exact genesis.');
  const startSlot = options.fromSlot ?? (await rpc('getSlot', [{ commitment: 'finalized' }])).value;
  if (!Number.isSafeInteger(startSlot) || startSlot < 0) throw new Error('Invalid starting slot.');
  const directory = resolve(options.output);
  await mkdir(directory, { mode: 0o700 }); // Existing captures are never overwritten.
  const report = { format: 'agentos-local-receipts', version: 1, status: 'running', rpc: options.rpc, genesis: options.genesis,
    addresses: options.addresses, startSlot, startedAt: new Date().toISOString(), receipts: [], missing: [], bytes: 0,
    scope: 'Original finalized RPC responses for explicitly watched local addresses. Storage integrity only; not role, instruction, task-plan or model-quality verification. Does not replace live RPC checks or authorize transactions.' };
  const captured = new Set(), missing = new Map(); let stopped = false, lastCheckedSlot = startSlot;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  async function snapshot() {
    report.updatedAt = new Date().toISOString(); report.missing = [...missing.values()];
    const file = await open(resolve(directory, 'report.tmp'), 'w', 0o600);
    try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(resolve(directory, 'report.tmp'), resolve(directory, 'report.json'));
    const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  try {
    await snapshot();
    console.log(JSON.stringify({ watching: options.addresses, genesis: options.genesis, startSlot, output: options.output }));
    const deadline = Date.now() + options.seconds * 1000;
    do {
      if ((await rpc('getGenesisHash')).value !== options.genesis) throw new Error('Genesis changed during capture.');
      const first = (await rpc('getFirstAvailableBlock')).value;
      if (!Number.isSafeInteger(first) || first < 0) throw new Error('Invalid history boundary.');
      if (first > lastCheckedSlot) throw new Error('History moved beyond the last observed slot; capture cannot prove complete coverage.');
      report.firstAvailableBlock = first;
      const candidates = new Map(missing);
      for (const key of options.addresses) {
        const rows = (await rpc('getSignaturesForAddress', [key, { commitment: 'finalized', limit: 100 }])).value;
        if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !Number.isSafeInteger(row.slot) || row.slot < 0 || row.confirmationStatus !== 'finalized')) throw new Error('Invalid finalized signature directory.');
        if (rows.length === 100 && rows.at(-1).slot >= startSlot) throw new Error('Signature window is truncated; capture cannot prove complete coverage.');
        for (const row of rows) if (row.slot >= startSlot && !captured.has(row.signature)) { publicValue(row.signature, 64); candidates.set(row.signature, { signature: row.signature, slot: row.slot }); }
      }
      for (const row of [...candidates.values()].sort((a, b) => a.slot - b.slot)) {
        if (captured.has(row.signature)) continue;
        if (report.receipts.length >= 100) throw new Error('Capture reached its 100-transaction limit.');
        const response = await rpc('getTransaction', [row.signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
        if (response.value === null) { missing.set(row.signature, { ...row, reason: row.slot < first ? 'pruned' : 'unavailable' }); continue; }
        const receipt = inspectLocalReceipt(row, response.value, options.addresses);
        if (report.bytes + response.bytes.length > 50_000_000) throw new Error('Capture reached its 50 MB limit.');
        const filename = `${row.signature}.json`, file = await open(resolve(directory, filename), 'wx', 0o600);
        try { await file.writeFile(response.bytes); await file.sync(); } finally { await file.close(); }
        report.receipts.push({ ...receipt, filename, bytes: response.bytes.length, sha256: createHash('sha256').update(response.bytes).digest('hex') });
        report.bytes += response.bytes.length; captured.add(row.signature); missing.delete(row.signature);
        await snapshot(); console.log(`Captured ${receipt.signature} at finalized slot ${receipt.slot}.`);
      }
      lastCheckedSlot = (await rpc('getSlot', [{ commitment: 'finalized' }])).value;
      if (!Number.isSafeInteger(lastCheckedSlot) || lastCheckedSlot < startSlot) throw new Error('Invalid current finalized slot.');
      report.lastCheckedSlot = lastCheckedSlot;
      await snapshot(); if (Date.now() >= deadline || stopped) break;
      await delay(1000);
    } while (!stopped);
    report.status = stopped ? 'stopped' : missing.size ? 'incomplete' : 'complete';
  } catch (error) { report.status = 'error'; report.error = error.message; throw error; }
  finally { report.endedAt = new Date().toISOString(); await snapshot(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const report = await watchLocalReceipts(receiptWatchOptions(process.argv.slice(2), process.env.AGENTOS_LOCAL_RPC_URL)); if (report.status === 'incomplete') process.exitCode = 2; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
