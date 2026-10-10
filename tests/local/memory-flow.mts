import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalHarness, digest, hex } from './harness.mts';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
const h=new LocalHarness();
try {
 await h.start();
 if(process.argv.includes('--sqlite')) {process.env.AGENTOS_STORAGE_BACKEND='sqlite';process.env.AGENTOS_DATABASE_PATH=join(h.root,'runtime-data','agentos.sqlite');}
 const init=await h.prepareReview();await h.authorize();
 const {payer,session,provider}=h.signers;const a=init.accounts;
 await h.tx('fund Memory fixture Provider',[sdk.buildFundSessionFeeReserve(payer.address,provider.address,0.02)]);
 await h.tx('initialize Memory Agent',[init.instruction]);
 await h.tx('deposit Memory Vault',[await sdk.buildDeposit(payer.address,a.agent,a.vault,0.01)]);
 const s=await sdk.buildCreateSession(payer.address,a.agent,a.policy,session.address,BigInt(Math.floor(Date.now()/1000)+120),0.01,0.02,1,2,['api']);await h.tx('create Memory Session',[s.instruction]);
 const skill=await sdk.buildRegisterSkill(provider.address,digest('memory recovery fixture'),digest('http://127.0.0.1:19788/fixture'),0.001,'0.1');await h.tx('register Memory source Skill',[skill.instruction],[provider]);
 const paid=await sdk.buildPaySkill(payer.address,a.agent,a.policy,a.vault,s.session,session,skill.skill,provider.address,1_000_000n,digest('memory input'),0n);await h.tx('pay Memory source Skill',[paid.instruction]);
 const content='LOCAL TEST FIXTURE: archive and restore provenance test.';
 await h.tx('commit Memory fixture result',[await sdk.buildRecordSkillResult(payer.address,a.agent,s.session,session,paid.execution,digest(content))]);
 // This fixture tests committed provenance; provider HTTP execution was covered by full-flow.
 await h.runtime();const input={agent:a.agent,execution:paid.execution,title:'Recovery fixture',content,tags:['local','restore']};
 const saved=await h.api('/api/memory',input);assert.equal(saved.contentHash,hex(digest(content)));
 const snapshot=()=>h.api(`/api/memory/export?agent=${a.agent}`);assert.equal((await snapshot()).count,1);
 await h.api('/api/memory/archive',{agent:a.agent,execution:paid.execution,contentHash:hex(digest('wrong'))},422);assert.equal((await snapshot()).count,1);h.pass('Stale archive hash cannot remove live Memory');
 const archive=await h.api('/api/memory/archive',{agent:a.agent,execution:paid.execution,contentHash:saved.contentHash});assert.equal(dirname(archive.archiveFile),join(h.root,'runtime-data','memory-archives'));
 const raw=await readFile(archive.archiveFile,'utf8');assert.equal(hex(digest(raw)),archive.archiveSha256);const record=JSON.parse(raw);assert.equal(record.entry.content,content);assert.equal((await snapshot()).count,0);h.pass('Memory archive conserves exact text and removes active entry');
 await h.restartRuntime();assert.equal((await snapshot()).count,0);h.pass('Archived Memory remains removed after restart');
 await h.api('/api/memory',{...input,content:content+' tampered'},422);assert.equal((await snapshot()).count,0);h.pass('Restore rechecks chain commitment and rejects changed text');
 await h.api('/api/memory',{...input,execution:a.agent},422);assert.equal((await snapshot()).count,0);h.pass('Restore rejects a non-Execution source');
 const restored=await h.api('/api/memory',{agent:record.entry.agent,execution:record.entry.execution,title:record.entry.title,content:record.entry.content,tags:record.entry.tags});assert.equal(restored.contentHash,saved.contentHash);assert.equal((await snapshot()).count,1);
 await h.api('/api/memory',input);assert.equal((await snapshot()).count,1);await h.restartRuntime();assert.equal((await snapshot()).entries[0].content,content);h.pass('Exact restore verifies chain source, is idempotent and survives restart');
 await h.finish();
}catch(e){console.error(e);if(h.root)await h.finish(e);process.exitCode=1;}
