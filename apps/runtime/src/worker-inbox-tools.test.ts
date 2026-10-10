import test from 'node:test';
import assert from 'node:assert/strict';
import { workerInboxToolRequests } from './worker-inbox-tools.js';
import { runtimeWorkerToolProfiles } from './remote-worker-tool.js';
const worker='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',escrow='11111111111111111111111111111111',hash='a'.repeat(64),request={skill:worker,asset:'SOL' as const,prompt:'Public source',endpoint:'https://provider.example/skill',maxAmount:'1'};
test('Inbox imports only exact configured tool requests and snapshots them without allowing task data to add scope',()=>{
 const profiles=runtimeWorkerToolProfiles.parse([{tenant:'worker',workerAgent:worker,session:worker,feePayer:escrow,escrow,taskHash:hash,taskId:'0',tools:[{request,executionId:'0',actionId:'0'}]}]);const selected=workerInboxToolRequests(profiles,worker,escrow,hash);assert.deepEqual(selected,[request]);selected[0].prompt='changed';assert.equal(profiles[0].tools[0].request.prompt,'Public source');
 for(const [agent,key,commitment] of [[escrow,escrow,hash],[worker,worker,hash],[worker,escrow,'b'.repeat(64)]])assert.deepEqual(workerInboxToolRequests(profiles,agent,key,commitment),[]);
 assert.deepEqual(workerInboxToolRequests([],worker,escrow,hash),[]);assert.throws(()=>workerInboxToolRequests([...profiles,...profiles],worker,escrow,hash),/ambiguous/);
});
