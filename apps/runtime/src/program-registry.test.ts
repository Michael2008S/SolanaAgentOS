import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { getAddressDecoder } from '@solana/kit';
import { scanProgramRegistry } from './program-registry.js';
const key = (n: number) => getAddressDecoder().decode(createHash('sha256').update(String(n)).digest());
const program = key(-1), bytes = Buffer.from([0, 9, 10]);
const metadata = (data: string) => ({ owner: program, executable: false, data: [data, 'base64'] });
function fixture(count = 1007, alter?: (method: string, value: any) => any) {
  const calls: { method: string; params: unknown[] }[] = [];
  const keys = Array.from({ length: count }, (_, index) => key(index));
  const rpc = async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    const value = method === 'getProgramAccounts' ? { context: { slot: 50 }, value: keys.map(pubkey => ({ pubkey, account: metadata('') })) } :
      { context: { slot: 51 }, value: (params[0] as string[]).map(() => metadata(bytes.toString('base64'))) };
    return alter ? alter(method, value) : value;
  };
  return { rpc, calls, keys };
}
test('registry reads every account beyond 1,000 in batches of at most 100 at the selected commitment', async () => {
  const { rpc, calls, keys } = fixture();
  const rows = await scanProgramRegistry(rpc, program, [{ offset: 0, bytes: '1' }], 'finalized');
  assert.equal(rows.length, 1007); assert.deepEqual(rows.map(row => row.address), keys.sort());
  assert.ok(rows.every(row => row.data.equals(bytes)));
  assert.equal(calls.length, 12);
  assert.deepEqual((calls[0].params[1] as any).dataSlice, { offset: 0, length: 0 });
  for (const call of calls.slice(1)) {
    assert.ok((call.params[0] as string[]).length <= 100);
    assert.deepEqual(call.params[1], { encoding: 'base64', commitment: 'finalized', minContextSlot: 50 });
  }
});
test('registry rejects malformed, duplicate, stale, closed or changed accounts instead of partial results', async () => {
  const cases = [
    (method: string, row: any) => { if (method === 'getProgramAccounts') row.value.push(row.value[0]); return row; },
    (method: string, row: any) => { if (method === 'getProgramAccounts') row.value[0].pubkey = 'bad'; return row; },
    (method: string, row: any) => { if (method === 'getProgramAccounts') row.value[0].account.data[0] = 'AA=='; return row; },
    (method: string, row: any) => { if (method === 'getMultipleAccounts') row.context.slot = 49; return row; },
    (method: string, row: any) => { if (method === 'getMultipleAccounts') row.value[0] = null; return row; },
    (method: string, row: any) => { if (method === 'getMultipleAccounts') row.value[0].owner = key(-2); return row; },
    (method: string, row: any) => { if (method === 'getMultipleAccounts') row.value[0].executable = true; return row; },
    (method: string, row: any) => { if (method === 'getMultipleAccounts') row.value[0].data[0] = 'invalid'; return row; },
    (method: string, row: any) => { if (method === 'getMultipleAccounts') row.value[0].data[0] = 'AQkK'; return row; },
    (method: string, row: any) => { if (method === 'getMultipleAccounts') row.value.pop(); return row; },
  ];
  for (const alter of cases) await assert.rejects(scanProgramRegistry(fixture(101, alter).rpc, program, [{ offset: 0, bytes: '1' }], 'confirmed'));
  const { calls, rpc } = fixture(20_001);
  await assert.rejects(scanProgramRegistry(rpc, program, [], 'finalized'), /scan budget/);
  assert.equal(calls.length, 1);
});
test('empty registry requires valid context, and later batch errors discard the whole scan', async () => {
  assert.deepEqual(await scanProgramRegistry(fixture(0).rpc, program, [], 'finalized'), []);
  await assert.rejects(scanProgramRegistry(async () => ({ context: { slot: NaN }, value: [] }), program, [], 'finalized'), /context/);
  const { rpc } = fixture(101); let calls = 0;
  await assert.rejects(scanProgramRegistry(async (method, params) => { if (++calls === 3) throw new Error('RPC unavailable'); return rpc(method, params); }, program, [], 'finalized'), /unavailable/);
});
