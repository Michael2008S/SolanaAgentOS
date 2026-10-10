import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { AutonomousLoop,type AutonomousJob } from './autonomous-loop.js';
import { AutonomousCoordinator,checkpointHash } from './autonomous-coordination.js';
import { RemoteAutonomousStore } from './remote-autonomous-store.js';
import { SQLiteAutonomousStore,AutonomousLeaseBusyError } from './autonomous-sqlite.js';
const input={tenant:'owner',goal:'Obtain public research',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{sol:'2',usdc:'0',maxCycles:3,maxActions:3,maxModelRequests:6,deadline:2000,tools:['research']}};
const scope={...input,tokenSha256:'a'.repeat(64),maxDurationSeconds:1000};
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'agentos-coordinator-')),store=new SQLiteAutonomousStore(join(dir,'central.sqlite'));let clock=1000000;const coordinator=new AutonomousCoordinator(store,[scope],input,()=>clock);const transport=(async(_url,options)=>{try{return Response.json(await coordinator.dispatch(JSON.parse(String(options?.body))));}catch(cause){return Response.json({}, {status:cause instanceof AutonomousLeaseBusyError?409:422});}}) as typeof fetch;const a=new RemoteAutonomousStore('http://127.0.0.1:8791','x'.repeat(32),transport),b=new RemoteAutonomousStore('http://127.0.0.1:8791','x'.repeat(32),transport);
return {store,coordinator,a,b,transport,advance:()=>{clock+=61000;},close:async()=>{await coordinator.close();store.close();await rm(dir,{recursive:true,force:true});}};}
test('remote takeover preserves original reservations and rejects expired or reordered checkpoints',async()=>{
 const f=await fixture();try{
 const job=await new AutonomousLoop(f.a,{validate:async()=>{}} as any).create(input),releaseA=await f.a.acquire(job.tenant,job.id);await f.a.load(job.tenant,job.id);
 await assert.rejects(()=>f.b.acquire(job.tenant,job.id),AutonomousLeaseBusyError);
 const intent={id:randomUUID(),phase:'reserved' as const,cycle:1,executionId:'9',action:{key:'original',tool:'research',input:'Query',asset:'SOL' as const,amount:'1'}};
 const reserved:AutonomousJob={...job,state:'executing',cycle:1,modelRequests:1,intents:[intent],spent:{sol:'1',usdc:'0'}};await f.a.save(reserved);
 f.advance();const releaseB=await f.b.acquire(job.tenant,job.id),restored=await f.b.load(job.tenant,job.id);assert.deepEqual(restored,reserved);
 await assert.rejects(()=>f.a.save({...reserved,modelRequests:2}),/422/);
 await assert.rejects(()=>releaseA(),/422/);
 await assert.rejects(()=>f.b.save({...restored,modelRequests:0}),/422/);
 await assert.rejects(()=>f.b.save({...restored,intents:[],spent:{sol:'0',usdc:'0'}}),/422/);
 await assert.rejects(()=>f.b.save({...restored,intents:[{...intent,action:{...intent.action,input:'Changed'}}]}),/422/);
 await assert.rejects(()=>f.b.save({...restored,limits:{...restored.limits,sol:'3'}}),/422/);
 const receipt={id:'original',output:'Evidence',outputHash:createHash('sha256').update('Evidence').digest('hex'),verified:true as const};
 await f.b.save({...restored,state:'evaluating',intents:[{...intent,phase:'complete',receipt}]});assert.equal((await f.store.load(job.tenant,job.id)).spent.sol,'1');
 await assert.rejects(()=>f.coordinator.dispatch({op:'save',tenant:job.tenant,id:job.id,token:randomUUID(),hash:checkpointHash(restored),job:restored}),/lease/);await releaseB();
 }finally{await f.close();}
});
test('remote loop evaluates and replans with durable counters; cancellation and tenant isolation survive workers',async()=>{
 const f=await fixture();let executions=0,evaluations=0;try{
 const loop=new AutonomousLoop(f.a,{validate:async()=>{},plan:async job=>[{key:'cycle'+job.cycle,tool:'research',input:'Query',asset:'SOL',amount:'1'}],execute:async()=>{executions++;return {id:'result'+executions,output:'Evidence',outputHash:createHash('sha256').update('Evidence').digest('hex'),verified:true};},reconcile:async()=>null,evaluate:async()=>({complete:++evaluations===2,feedback:'Continue then complete'})},()=>1000000);
 const job=await loop.create(input),done=await loop.run(job.tenant,job.id);assert.equal(done.state,'completed');assert.equal(done.cycle,2);assert.equal(done.modelRequests,4);assert.equal(done.spent.sol,'2');assert.equal(executions,2);
 assert.equal((await f.b.list('owner'))[0].state,'completed');assert.ok((await f.b.events('owner')).events.length);await f.b.requestCancellation('owner',job.id);assert.equal(await f.b.cancelled('owner',job.id),true);
 await assert.rejects(()=>f.b.list('other'),/422/);await assert.rejects(()=>f.b.save(job),/422/);
 }finally{await f.close();}
});
test('initial checkpoints cannot import spent history or exceed operator scope; stale same-lease versions fail',async()=>{
 const f=await fixture();try{
 const job=await new AutonomousLoop(f.a,{validate:async()=>{}} as any).create(input);
 await assert.rejects(()=>f.coordinator.dispatch({op:'create',tenant:'owner',job:{...job,id:randomUUID(),modelRequests:1}}),/authorization/);
 await assert.rejects(()=>f.coordinator.dispatch({op:'create',tenant:'owner',job:{...job,id:randomUUID(),session:'Z'.repeat(32)}}),/authorization/);
 const lease=await f.coordinator.dispatch({op:'acquire',tenant:'owner',id:job.id}) as {token:string};
 await f.coordinator.dispatch({op:'save',tenant:'owner',id:job.id,token:lease.token,hash:checkpointHash(job),job:{...job,modelRequests:1}});
 await assert.rejects(()=>f.coordinator.dispatch({op:'save',tenant:'owner',id:job.id,token:lease.token,hash:checkpointHash(job),job:{...job,modelRequests:2}}),/checkpoint changed/);
 }finally{await f.close();}
});

test('lost heartbeat cannot authorize another checkpoint or silently acquire another lease',async t=>{
 const f=await fixture();let denyRenew=false,acquires=0;const client=new RemoteAutonomousStore('http://127.0.0.1:8791','x'.repeat(32),(async(url,options)=>{
  const command=JSON.parse(String(options?.body));if(command.op==='acquire')acquires++;if(denyRenew&&command.op==='renew')return Response.json({}, {status:422});return f.transport(url,options);
 }) as typeof fetch);
 let release:(()=>Promise<void>)|undefined;
 try{
  const job=await new AutonomousLoop(client,{validate:async()=>{}} as any).create(input);
  t.mock.timers.enable({apis:['setTimeout']});release=await client.acquire(job.tenant,job.id);await client.load(job.tenant,job.id);denyRenew=true;t.mock.timers.tick(15000);
  for(let i=0;i<20;i++)await Promise.resolve();
  await assert.rejects(()=>client.save({...job,modelRequests:1}),/lease is lost/);assert.equal(acquires,1);assert.equal((await f.store.load(job.tenant,job.id)).modelRequests,0);
 }finally{await release?.();t.mock.timers.reset();await f.close();}
});
test('remote coordinator rejects redirected, nonlocal insecure and credential-echoing transports',async()=>{
 assert.throws(()=>new RemoteAutonomousStore('http://example.com','x'.repeat(32)),/fixed HTTPS/);
 assert.throws(()=>new RemoteAutonomousStore('https://example.com/path','x'.repeat(32)),/fixed HTTPS/);
 const client=new RemoteAutonomousStore('https://example.com','x'.repeat(32),(async(_url,options)=>{assert.equal(options?.redirect,'error');return new Response(JSON.stringify('x'.repeat(32)));}) as typeof fetch);
 await assert.rejects(()=>client.list('owner'),/echoed/);
});
