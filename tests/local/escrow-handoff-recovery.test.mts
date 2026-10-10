import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { EscrowHandoffStore } from '../../apps/runtime/src/escrow-handoff.js';

test('persisted Worker handoff survives restart and requires fresh commitments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentos-handoff-recovery-'));
  try {
    const program = address('HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv');
    const agent = address('Gd4a8KNBnaxM4kcpuH9cPZEat2gW2ooHXrsor3GqFhgK');
    const id = new Uint8Array(8);
    new DataView(id.buffer).setBigUint64(0, 42n, true);
    const [escrow] = await getProgramDerivedAddress({ programAddress: program, seeds: [new TextEncoder().encode('escrow'), getAddressEncoder().encode(agent), id] });
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const task = 'Check the local workflow.';
    const result = 'Local workflow checked.';
    let live = { address: escrow, agent, id: '42', taskHash: hash(task), resultHash: null as string | null };
    const options = { persistent: true, file: join(directory, 'handoffs.json') };
    const store = () => new EscrowHandoffStore(async () => live, () => program, options);
    await store().save(escrow, task, null);
    assert.equal((await store().read(escrow, true)).task, task);
    await assert.rejects(store().read(escrow), /no Worker result/);
    live = { ...live, resultHash: hash(result) };
    await store().save(escrow, task, result);
    assert.equal((await store().read(escrow)).result, result);
    await store().save(escrow, task, null);
    assert.equal((await store().read(escrow)).result, result);
    live = { ...live, resultHash: hash('Changed result') };
    await assert.rejects(store().read(escrow), /does not match/);
    live = { ...live, resultHash: hash(result), id: '43' };
    await assert.rejects(store().read(escrow), /canonical PDA/);
    live = { ...live, id: '42' };
    const anotherProgram = new EscrowHandoffStore(async () => live, () => '11111111111111111111111111111111', options);
    await assert.rejects(anotherProgram.read(escrow), /No local handoff/);
    const persisted = JSON.parse(await readFile(options.file, 'utf8'));
    persisted[0].result = 'Tampered text';
    await writeFile(options.file, JSON.stringify(persisted));
    await assert.rejects(store().read(escrow), /invalid entries/);
    assert.equal(JSON.parse(await readFile(options.file, 'utf8'))[0].result, 'Tampered text', 'invalid storage is preserved for explicit recovery');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
