import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutonomousLoop,type AutonomousAdapter } from './autonomous-loop.js';
import { SQLiteAutonomousStore } from './autonomous-sqlite.js';
import { AutonomousController,parseAutonomousTenants } from './autonomous-controller.js';
const token='local-owner-token-with-at-least-32-characters';
const profile={tenant:'owner',tokenSha256:createHash('sha256').update(token).digest('hex'),agent:'11111111111111111111111111111111',session:'11111111111111111111111111111111',maxDurationSeconds:600,limits:{sol:'2',usdc:'0',maxCycles:3,maxActions:3,maxModelRequests:6,tools:['research']}};
test('authenticated background execution outlives the creation response and does not cross tenant boundaries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-controller-')),store=new SQLiteAutonomousStore(join(dir,'jobs.sqlite'),new Map([['owner','a'.repeat(64)]]));
 let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let executions=0;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async job=>[{key:'cycle-'+job.cycle,tool:'research',input:'Query',asset:'SOL',amount:'1'}],execute:async()=>{await wait;const text='receipt-'+(++executions);return {id:text,output:text,outputHash:createHash('sha256').update(text).digest('hex'),verified:true};},reconcile:async()=>null,evaluate:async job=>({complete:job.cycle===2,feedback:job.cycle===2?'Supported answer':'Need a second source'})};
 const other={...profile,tenant:'other',tokenSha256:createHash('sha256').update('x'.repeat(40)).digest('hex')};
 const controller=new AutonomousController(store,new AutonomousLoop(store,adapter,()=>1000000),parseAutonomousTenants(JSON.stringify([profile,other])),{program:'C'.repeat(32),genesis:'D'.repeat(32)},()=>1000000);
 async function request(path:string,method='GET',value?:unknown,bearer=token){
  const req=Readable.from(value===undefined?[]:[Buffer.from(JSON.stringify(value))]) as IncomingMessage;req.method=method;req.headers={authorization:'Bearer '+bearer,'content-type':'application/json'};
  let status=200,content='';const response={setHeader(){},writeHead(code:number){status=code;return this;},end(text:string){content=text;}} as unknown as ServerResponse;
  assert.equal(await controller.handle(req,response,new URL('http://localhost/api/autonomous/'+path)),true);return {status,body:JSON.parse(content)};
 }
 try{
  assert.equal((await request('jobs','GET',undefined,'unknown')).status,401);
  assert.equal((await request('notifications','GET',undefined,'unknown')).status,401);
  assert.equal((await request('jobs','POST',{goal:'Research',limits:{sol:'3'}})).status,422);
  assert.equal((await request('jobs','POST',{goal:'Research',agent:profile.agent})).status,422);
  const created=await request('jobs','POST',{goal:'Research'});assert.equal(created.status,202);const id=created.body.job.id;
  assert.notEqual((await request('jobs/'+id)).body.job.state,'completed');
  assert.equal((await request('jobs/'+id,'GET',undefined,'x'.repeat(40))).status,422);
  assert.deepEqual((await request('jobs','GET',undefined,'x'.repeat(40))).body.jobs,[]);
  release();await controller.idle();const completed=(await request('jobs/'+id)).body.job;
  assert.equal(completed.state,'completed');assert.equal(completed.cycle,2);assert.equal(completed.answer,'Supported answer');assert.equal(completed.spent.sol,'2');
  const notifications=(await request('events')).body;assert.equal(notifications.events.at(-1).state,'completed');assert.ok(notifications.cursor>0);
  assert.deepEqual((await request('events?after='+notifications.cursor)).body.events,[]);
  assert.deepEqual((await request('events','GET',undefined,'x'.repeat(40))).body.events,[]);
  const deliveries=(await request('notifications')).body;assert.equal(deliveries.configured,true);assert.equal(deliveries.deliveries.length,1);assert.equal(deliveries.deliveries[0].jobId,id);assert.equal(deliveries.deliveries[0].state,'completed');assert.equal(deliveries.deliveries[0].status,'pending');
  assert.deepEqual((await request('notifications','GET',undefined,'x'.repeat(40))).body,{configured:false,deliveries:[]});
  await request('jobs/'+id+'/resume','POST');await controller.idle();assert.equal(executions,2);
 }finally{release();await controller.idle();store.close();await rm(dir,{recursive:true,force:true});}
});

test('startup watches cancelled jobs with unresolved original effects without planning or executing again',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-terminal-reconciliation-')),store=new SQLiteAutonomousStore(join(dir,'jobs.sqlite'));let reconciliations=0;
 const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>{throw new Error('Cancelled work cannot plan');},execute:async()=>{throw new Error('Cancelled work cannot execute');},reconcile:async()=>{reconciliations++;const output='Original verified receipt';return {id:'original',output,outputHash:createHash('sha256').update(output).digest('hex'),verified:true};},evaluate:async()=>{throw new Error('Cancelled work cannot evaluate');}};
 const loop=new AutonomousLoop(store,adapter,()=>1000000),controller=new AutonomousController(store,loop,[profile],{program:'C'.repeat(32),genesis:'D'.repeat(32)},()=>1000000);
 try{const job=await loop.create({tenant:profile.tenant,goal:'Original cancelled task',agent:profile.agent,session:profile.session,program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{...profile.limits,deadline:2000}}),release=await store.acquire(job.tenant,job.id);
  await store.save({...job,state:'cancelled',cycle:1,modelRequests:1,spent:{sol:'1',usdc:'0'},intents:[{id:(await import('node:crypto')).randomUUID(),action:{key:'original',tool:'research',input:'Original input',asset:'SOL',amount:'1'},phase:'reserved',cycle:1,executionId:'0'}]});await release();
  await controller.resume();await controller.idle();const recovered=await store.load(job.tenant,job.id);assert.equal(reconciliations,1);assert.equal(recovered.state,'cancelled');assert.equal(recovered.modelRequests,1);assert.equal(recovered.intents[0].phase,'complete');assert.equal(recovered.spent.sol,'1');
 }finally{await controller.idle();store.close();await rm(dir,{recursive:true,force:true});}
});
