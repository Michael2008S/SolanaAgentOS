import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

test('Memory and Worker archives stay inside their isolated archive directories',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-archive-test-'));
 const names=['AGENTOS_CLUSTER','AGENTOS_LOCALNET_GENESIS_HASH','AGENTOS_DATA_DIR','AGENTOS_PROGRAM_ID','AGENTOS_STORAGE_BACKEND','AGENTOS_PERSIST_MEMORY'];
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const agent='11111111111111111111111111111111',execution='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',program='HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv';
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 try{
  Object.assign(process.env,{AGENTOS_CLUSTER:'localnet',AGENTOS_LOCALNET_GENESIS_HASH:agent,AGENTOS_DATA_DIR:root,AGENTOS_PROGRAM_ID:program,AGENTOS_STORAGE_BACKEND:'json',AGENTOS_PERSIST_MEMORY:'true'});
  // Storage fixtures only. These records do not claim actual on-chain execution.
  const memory={programId:program,agent,execution,title:'Storage fixture',content:'Archive placement fixture',contentHash:hash('Archive placement fixture'),tags:[],storedAt:new Date().toISOString(),source:'skill'};
  await writeFile(join(root,'memory.json'),JSON.stringify([memory]));
  const {archiveMemoryRecord}=await import('./memory.js');
  const result=await archiveMemoryRecord(agent,execution,memory.contentHash);
  assert.equal(dirname(result.archiveFile),join(root,'memory-archives'));assert.equal(JSON.parse(await readFile(result.archiveFile,'utf8')).entry.content,memory.content);assert.deepEqual(JSON.parse(await readFile(join(root,'memory.json'),'utf8')),[]);
  const task='Local archive storage test',resultText='Terminal fixture result',time=new Date().toISOString();
  const job={escrow:execution,workerAgent:agent,task,evidence:'',sourceExecutions:[],toolRequests:[],programId:program,taskHash:hash(task),tools:[],state:'delivered',result:resultText,resultHash:hash(resultText),model:null,generatedAt:null,evidenceUsed:[],limitations:[],error:null,attempts:1,createdAt:time,updatedAt:time};
  await writeFile(join(root,'worker-jobs.json'),JSON.stringify([job]));
  const {WorkerJobQueue}=await import('./worker-jobs.js');
  const queue=new WorkerJobQueue(async()=>({workerAgent:agent,taskHash:hash(task),resultHash:hash(resultText),status:1,deadline:Math.floor(Date.now()/1000)+60}),()=>program,async()=>{});
  const archived=await queue.archive(execution,agent,time);
  assert.equal(dirname(archived.archiveFile),join(root,'worker-archives'));assert.equal(JSON.parse(await readFile(archived.archiveFile,'utf8')).job.result,resultText);assert.deepEqual(JSON.parse(await readFile(join(root,'worker-jobs.json'),'utf8')),[]);
 }finally{for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}await rm(root,{recursive:true,force:true});}
});
