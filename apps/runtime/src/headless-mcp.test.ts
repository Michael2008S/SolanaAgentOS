import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSigner,getAddressEncoder,getProgramDerivedAddress } from '@solana/kit';
import { HeadlessSkillExecutor } from './headless-executor.js';
import { HeadlessJournal } from './headless-journal.js';
import type { AutonomousJob } from './autonomous-loop.js';
test('shared MCP validates fresh canonical API delegation and refuses revoked, expired or changed authority without signing',async()=>{
 const [program,owner,sessionSigner,feePayer,genesis]=await Promise.all(Array.from({length:5},()=>generateKeyPairSigner())),encode=getAddressEncoder(),disc=(name:string)=>createHash('sha256').update('account:'+name).digest().subarray(0,8),id=Buffer.alloc(32,1);
 const [agent,agentBump]=await getProgramDerivedAddress({programAddress:program.address,seeds:[Buffer.from('agent'),encode.encode(owner.address),id]}),[session,sessionBump]=await getProgramDerivedAddress({programAddress:program.address,seeds:[Buffer.from('session'),encode.encode(agent),encode.encode(sessionSigner.address)]}),[policy]=await getProgramDerivedAddress({programAddress:program.address,seeds:[Buffer.from('policy'),encode.encode(agent)]});
 const a=Buffer.alloc(138);disc('Agent').copy(a);Buffer.from(encode.encode(owner.address)).copy(a,8);id.copy(a,40);a[121]=agentBump;a.writeBigUInt64LE(9n,113);
 const s=Buffer.alloc(147);disc('Session').copy(s);Buffer.from(encode.encode(agent)).copy(s,8);Buffer.from(encode.encode(sessionSigner.address)).copy(s,40);s.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)+1200),72);s[104]=4;s[106]=sessionBump;
 const p=Buffer.alloc(123);disc('Policy').copy(p);Buffer.from(encode.encode(agent)).copy(p,8);p[72]=4;
 const accounts=new Map<string,Buffer>([[agent,a],[session,s],[policy,p]]),root=await mkdtemp(join(tmpdir(),'agentos-mcp-authority-')),journal=new HeadlessJournal(join(root,'journal.sqlite'));let network:string=genesis.address,signs=0;
 const signer=(address:typeof sessionSigner.address)=>({address,signTransactions:async()=>{signs++;throw new Error('Free MCP must never sign.');}}),action={key:'original',tool:'mcp:public:lookup',input:'{}',asset:'SOL' as const,amount:'0'},intentId=randomUUID(),limits={sol:'0',usdc:'0',maxCycles:1,maxActions:1,maxModelRequests:2,tools:[action.tool]},job:AutonomousJob={version:1,id:randomUUID(),tenant:'owner',goal:'Read public fact',agent,session,program:program.address,genesis:genesis.address,state:'executing',limits:{...limits,deadline:Math.floor(Date.now()/1000)+600},spent:{sol:'0',usdc:'0'},cycle:1,modelRequests:1,intents:[{id:intentId,phase:'reserved',action,executionId:'0'}],pending:[],evaluations:[]};
 const options={program:program.address,genesis:genesis.address,feePayer:signer(feePayer.address),signers:new Map([['owner',signer(sessionSigner.address)]]),tenants:[{tenant:'owner',agent,session,tokenSha256:'0'.repeat(64),limits,maxDurationSeconds:600}],tools:new Map<string,string>(),mcpTools:new Map([[action.tool,'https://source.example.com/mcp']]),journal,rpc:async(method:string,params:unknown[])=>{if(method==='getGenesisHash')return network;if(method==='getAccountInfo'){const data=accounts.get(String(params[0]));return {value:data?{owner:program.address,data:[data.toString('base64'),'base64']}:null};}throw new Error('Free MCP cannot use signing or transaction RPC');}};
 const executor=new HeadlessSkillExecutor(options);
 try{await executor.validateMcp(job,action,intentId);assert.equal(a.readBigUInt64LE(113),9n);
  for(const [data,index,value] of [[s,105,1],[s,104,0],[p,73,1],[p,72,0],[a,104,1]] as const){const old=data[index];data[index]=value;await assert.rejects(executor.validateMcp(job,action,intentId));data[index]=old;}
  const expiry=s.readBigInt64LE(72);s.writeBigInt64LE(1n,72);await assert.rejects(executor.validateMcp(job,action,intentId));s.writeBigInt64LE(expiry,72);
  Buffer.from('AGTASK01').copy(s,115);await assert.rejects(executor.validateMcp(job,action,intentId));s.fill(0,115,123);
  network=owner.address;await assert.rejects(executor.validateMcp(job,action,intentId));network=genesis.address;
  await assert.rejects(executor.execute(job,action,intentId),/separate shared MCP/);assert.equal(signs,0);assert.equal(journal.load(job.tenant,job.id,intentId),null);
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});
