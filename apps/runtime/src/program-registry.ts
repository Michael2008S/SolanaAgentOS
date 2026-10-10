import { getAddressEncoder } from '@solana/kit';

export type RegistryAccount = { address: string; data: Buffer };
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type Filter = { offset: number; bytes: string };
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decode(value: string): Buffer {
  if (!value || value.length > 180) throw new Error('Invalid registry filter.');
  let number = 0n;
  for (const char of value) { const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('Invalid registry filter.'); number = number * 58n + BigInt(digit); }
  const bytes: number[] = [];
  while (number) { bytes.unshift(Number(number % 256n)); number /= 256n; }
  return Buffer.from([...Array(value.match(/^1*/)?.[0].length ?? 0).fill(0), ...bytes]);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Registry RPC returned invalid data.');
  return value as Record<string, unknown>;
}
function context(value: unknown, minimum = 0): { slot: number; value: unknown[] } {
  const row = object(value), slot = object(row.context).slot;
  if (!Number.isSafeInteger(slot) || (slot as number) < minimum || !Array.isArray(row.value)) throw new Error('Registry RPC returned invalid or stale context.');
  return { slot: slot as number, value: row.value };
}
function address(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Registry RPC returned an invalid address.');
  try { getAddressEncoder().encode(value as Parameters<ReturnType<typeof getAddressEncoder>['encode']>[0]); }
  catch { throw new Error('Registry RPC returned an invalid address.'); }
  return value;
}
function account(value: unknown, program: string): Record<string, unknown> {
  const row = object(value);
  if (row.owner !== program || row.executable !== false) throw new Error('Registry account owner or executable flag changed; retry the scan.');
  return row;
}

// Standard RPC has no paging token. Enumerate zero-length account data, then read
// at most 100 keys per request. Resource failures must never return a partial registry.
export async function scanProgramRegistry(rpc: Rpc, program: string, filters: Filter[], commitment: 'confirmed' | 'finalized'): Promise<RegistryAccount[]> {
  address(program);
  const checks = filters.map(filter => {
    if (!Number.isSafeInteger(filter.offset) || filter.offset < 0) throw new Error('Invalid registry filter.');
    return { offset: filter.offset, bytes: decode(filter.bytes) };
  });
  const listing = context(await rpc('getProgramAccounts', [program, {
    encoding: 'base64', commitment, withContext: true, dataSlice: { offset: 0, length: 0 }, filters: filters.map(memcmp => ({ memcmp })),
  }]));
  if (listing.value.length > 20_000) throw new Error('Registry exceeds the 20,000-account scan budget; configure a full history index before serving this directory.');
  const keys = listing.value.map(value => {
    const row = object(value), key = address(row.pubkey), metadata = account(row.account, program);
    if (!Array.isArray(metadata.data) || metadata.data.length !== 2 || metadata.data[0] !== '' || metadata.data[1] !== 'base64') throw new Error('Registry RPC did not honor the zero-length data slice.');
    return key;
  }).sort();
  if (new Set(keys).size !== keys.length) throw new Error('Registry RPC returned duplicate addresses.');
  const results: RegistryAccount[] = [];
  const deadline = Date.now() + 120_000;
  for (let offset = 0; offset < keys.length; offset += 100) {
    if (Date.now() > deadline) throw new Error('Registry scan exceeded its time budget; no partial directory is available.');
    const batch = keys.slice(offset, offset + 100);
    const loaded = context(await rpc('getMultipleAccounts', [batch, { encoding: 'base64', commitment, minContextSlot: listing.slot }]), listing.slot);
    if (loaded.value.length !== batch.length) throw new Error('Registry RPC returned an incomplete account batch.');
    for (let index = 0; index < batch.length; index++) {
      const row = account(loaded.value[index], program), encoded = row.data;
      if (!Array.isArray(encoded) || encoded.length !== 2 || encoded[1] !== 'base64' || typeof encoded[0] !== 'string') throw new Error('Registry RPC returned invalid account encoding.');
      const data = Buffer.from(encoded[0], 'base64');
      if (data.toString('base64') !== encoded[0] || checks.some(check => !data.subarray(check.offset, check.offset + check.bytes.length).equals(check.bytes))) throw new Error('Registry account data or filters changed; retry the scan.');
      results.push({ address: batch[index], data });
    }
  }
  return results;
}
