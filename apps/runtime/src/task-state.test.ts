import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { decodeTaskSnapshot } from './task-state.js';
const program='HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv';
async function fixture(completed=false) {
 const bytes=Buffer.alloc(227);createHash('sha256').update('account:Task').digest().copy(bytes,0,0,8);
 const agent=address('11111111111111111111111111111111');Buffer.from(getAddressEncoder().encode(agent)).copy(bytes,8);Buffer.from(getAddressEncoder().encode(agent)).copy(bytes,40);
 bytes.writeBigUInt64LE(1n,72);bytes.fill(1,80,112);bytes.writeBigUInt64LE(100n,112);bytes.writeBigUInt64LE(200n,120);bytes.writeBigUInt64LE(10n,128);bytes.writeBigUInt64LE(20n,136);
 bytes[144]=completed?3:1;bytes[145]=completed?1:0;if(completed)bytes.fill(2,146,178);
 const offset=completed?178:146;for(const at of [0,8,16])bytes.writeBigInt64LE(1000n,offset+at);bytes.writeBigUInt64LE(2n,offset+24);
 const [key,bump]=await getProgramDerivedAddress({programAddress:address(program),seeds:[Buffer.from('task'),getAddressEncoder().encode(agent),bytes.subarray(72,80)]});bytes[offset+40]=bump;
 return {key,bytes,offset};
}
test('227-byte Task decodes pending Skill and Escrow counters',async()=>{
 const {key,bytes,offset}=await fixture();bytes.writeBigUInt64LE(1n,offset+32);bytes.writeBigUInt64LE(1n,offset+41);
 const task=await decodeTaskSnapshot(key,bytes,program);assert.equal(task.pendingEscrows,'1');assert.equal(task.pendingSkillResults,'1');assert.equal(task.sol.remaining,'90');assert.equal(task.usdc.remaining,'180');
});
test('Task rejects old layout and invalid canonical identity',async()=>{
 const {key,bytes,offset}=await fixture();await assert.rejects(()=>decodeTaskSnapshot(key,bytes.subarray(0,219),program));bytes[offset+40]^=1;await assert.rejects(()=>decodeTaskSnapshot(key,bytes,program),/canonical/);
});
test('Task rejects impossible pending counters and excessive spend',async()=>{
 const {key,bytes,offset}=await fixture();bytes.writeBigUInt64LE(3n,offset+41);await assert.rejects(()=>decodeTaskSnapshot(key,bytes,program),/pending/);bytes.writeBigUInt64LE(0n,offset+41);bytes.writeBigUInt64LE(101n,128);await assert.rejects(()=>decodeTaskSnapshot(key,bytes,program),/spending/);
});
test('Completed Task requires empty pending counters',async()=>{
 const {key,bytes,offset}=await fixture(true);assert.equal((await decodeTaskSnapshot(key,bytes,program)).status,'completed');
 for(const at of [offset+32,offset+41]){bytes.writeBigUInt64LE(1n,at);await assert.rejects(()=>decodeTaskSnapshot(key,bytes,program),/pending/);bytes.writeBigUInt64LE(0n,at);}
});
