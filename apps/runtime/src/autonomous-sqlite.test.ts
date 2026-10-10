import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { AutonomousLoop, type AutonomousAdapter } from './autonomous-loop.js';
import { SQLiteAutonomousStore } from './autonomous-sqlite.js';
const input={tenant:'owner',goal:'Obtain public research',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{sol:'2',usdc:'0',maxCycles:3,maxActions:3,maxModelRequests:6,deadline:2000,tools:['research']}};
const output=(text:string)=>({id:text,output:text,outputHash:createHash('sha256').update(text).digest('hex'),verified:true as const});
const adapter:AutonomousAdapter={validate:async()=>{},plan:async()=>[],execute:async()=>output('unused'),reconcile:async()=>null,evaluate:async()=>({complete:true,feedback:'Answer'})};
test('SQLite fences competing writers and separates tenant snapshots',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-autonomous-db-')),file=join(dir,'jobs.sqlite');
 const a=new SQLiteAutonomousStore(file),b=new SQLiteAutonomousStore(file);
 try{const job=await new AutonomousLoop(a,adapter,()=>1000000).create(input);const release=await a.acquire(job.tenant,job.id);
 await assert.rejects(()=>b.acquire(job.tenant,job.id),/already running/);await assert.rejects(()=>b.save({...job,goal:'Unauthorized overwrite'}),/current lease/);
 await assert.rejects(()=>b.load('another',job.id),/missing/);assert.deepEqual(await b.list('another'),[]);
 await a.save({...job,goal:'Authorized update'});assert.equal((await b.load(job.tenant,job.id)).goal,'Authorized update');await release();
 const next=await b.acquire(job.tenant,job.id);await b.save({...job,goal:'Next lease'});await next();
 }finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}
});
test('a crashed local process lease is recovered atomically without time-based theft',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-autonomous-crash-')),file=join(dir,'jobs.sqlite');
 try{
 const child=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',
  `import {SQLiteAutonomousStore} from './apps/runtime/src/autonomous-sqlite.ts';import {AutonomousLoop} from './apps/runtime/src/autonomous-loop.ts';const store=new SQLiteAutonomousStore(process.argv[1]);const job=await new AutonomousLoop(store,{validate:async()=>{}}).create(JSON.parse(process.argv[2]));await store.acquire(job.tenant,job.id);console.log(job.id);process.exit(0);`,file,JSON.stringify(input)]);
 const store=new SQLiteAutonomousStore(file),id=child.stdout.trim();try{const release=await store.acquire('owner',id);assert.equal((await store.load('owner',id)).modelRequests,0);await release();}finally{store.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('cancellation keeps an in-flight original receipt and prevents later actions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-autonomous-cancel-')),store=new SQLiteAutonomousStore(join(dir,'jobs.sqlite'));
 let finish!:()=>void,started!:()=>void,calls=0;const waiting=new Promise<void>(resolve=>{finish=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
 const executor:AutonomousAdapter={...adapter,plan:async()=>[1,2].map(n=>({key:String(n),tool:'research',input:'Query '+n,asset:'SOL',amount:'1'})),execute:async()=>{calls++;started();await waiting;return output('Original receipt');},evaluate:async()=>{throw new Error('Cancelled work must not call evaluation');}};
 try{const loop=new AutonomousLoop(store,executor,()=>1000000),job=await loop.create(input),run=loop.run(job.tenant,job.id);await ready;await store.requestCancellation(job.tenant,job.id);finish();const stopped=await run;assert.equal(stopped.state,'cancelled');assert.equal(stopped.intents[0].phase,'complete');assert.equal(stopped.spent.sol,'1');assert.equal(calls,1);}finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('Agent leases serialize different jobs across tenant and Session scopes while independent chains and Agents proceed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-agent-leases-')),file=join(dir,'jobs.sqlite'),a=new SQLiteAutonomousStore(file),b=new SQLiteAutonomousStore(file);const releases:(()=>Promise<void>)[]=[];
 try{
  const first=await new AutonomousLoop(a,adapter,()=>1000000).create(input),second=await new AutonomousLoop(b,adapter,()=>1000000).create({...input,tenant:'other',session:'E'.repeat(32)});
  releases.push(await a.acquire(first.tenant,first.id));await assert.rejects(b.acquire(second.tenant,second.id),/already running/);
  for(const changed of [{agent:'F'.repeat(32)},{genesis:'G'.repeat(32)},{program:'H'.repeat(32)}]){const job=await new AutonomousLoop(b,adapter,()=>1000000).create({...input,...changed});releases.push(await b.acquire(job.tenant,job.id));await b.save({...job,cycle:1});}
  for(const changed of [{agent:'I'.repeat(32)},{session:'J'.repeat(32)},{program:'K'.repeat(32)},{genesis:'L'.repeat(32)},{limits:{...first.limits,sol:'3'}},{evaluationMode:undefined}])await assert.rejects(a.save({...first,...changed}),/cannot change/);
  await releases.shift()!();const releaseSecond=await b.acquire(second.tenant,second.id);await b.save({...second,cycle:1});await releaseSecond();assert.equal((await a.load(second.tenant,second.id)).cycle,1);
 }finally{for(const release of releases)await release();a.close();b.close();await rm(dir,{recursive:true,force:true});}
});

test('dead local Agent owner permits a different job takeover but never steals a live replacement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-agent-crash-')),file=join(dir,'jobs.sqlite');
 try{
  const child=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`import {SQLiteAutonomousStore} from './apps/runtime/src/autonomous-sqlite.ts';import {AutonomousLoop} from './apps/runtime/src/autonomous-loop.ts';const store=new SQLiteAutonomousStore(process.argv[1]);const job=await new AutonomousLoop(store,{validate:async()=>{}}).create(JSON.parse(process.argv[2]));await store.acquire(job.tenant,job.id);console.log(job.id);process.exit(0);`,file,JSON.stringify(input)]);
  const a=new SQLiteAutonomousStore(file),b=new SQLiteAutonomousStore(file);
  try{const replacement=await new AutonomousLoop(a,adapter,()=>1000000).create(input),release=await a.acquire(replacement.tenant,replacement.id);await assert.rejects(b.acquire('owner',child.stdout.trim()),/already running/);await release();const oldRelease=await b.acquire('owner',child.stdout.trim());assert.equal((await b.load('owner',child.stdout.trim())).modelRequests,0);await oldRelease();}finally{a.close();b.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('each checkpoint and release fences both leases atomically, including pre-migration live owners',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-agent-fence-')),file=join(dir,'jobs.sqlite'),store=new SQLiteAutonomousStore(file),db=new DatabaseSync(file);
 let release:(()=>Promise<void>)|undefined;
 try{const job=await new AutonomousLoop(store,adapter,()=>1000000).create(input);release=await store.acquire(job.tenant,job.id);
  const original=db.prepare('SELECT token FROM agent_leases').get()!.token;
  db.prepare('UPDATE agent_leases SET token=?').run('replacement-token');
  await assert.rejects(store.save({...job,cycle:1}),/current lease/);await assert.rejects(release(),/ownership changed/);
  assert.equal(db.prepare('SELECT token FROM jobs WHERE id=?').get(job.id)!.token,original);assert.equal((await store.load(job.tenant,job.id)).cycle,0);
  db.prepare('UPDATE agent_leases SET token=?').run(original);await release();release=undefined;
  // Legacy active job has no Agent row. A new job still cannot bypass it.
  db.prepare('UPDATE jobs SET token=?,pid=?,host=? WHERE id=?').run('legacy-token',process.pid,(await import('node:os')).hostname(),job.id);
  const other=await new AutonomousLoop(store,adapter,()=>1000000).create(input);await assert.rejects(store.acquire(other.tenant,other.id),/already running/);
  assert.equal(db.prepare('SELECT token FROM jobs WHERE id=?').get(other.id)!.token,null);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_leases').get()!.n,0);
  db.prepare('UPDATE jobs SET token=NULL,pid=NULL,host=NULL WHERE id=?').run(job.id);
 }finally{if(release)await release();db.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('unresolved original effects hold the Agent across process-lease release until the original job reconciles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-agent-unresolved-')),file=join(dir,'jobs.sqlite'),a=new SQLiteAutonomousStore(file),b=new SQLiteAutonomousStore(file);
 try{const loop=new AutonomousLoop(a,adapter,()=>1000000),first=await loop.create(input),second=await new AutonomousLoop(b,adapter,()=>1000000).create({...input,tenant:'other'}),release=await a.acquire(first.tenant,first.id);
  const reserved={...first,state:'needs_reconciliation' as const,cycle:1,spent:{sol:'1',usdc:'0'},intents:[{id:(await import('node:crypto')).randomUUID(),action:{key:'original',tool:'research',input:'Query',asset:'SOL' as const,amount:'1'},phase:'reserved' as const,cycle:1,executionId:'0'}]};
  await a.save(reserved);await release();await assert.rejects(b.acquire(second.tenant,second.id),/reconciliation/);
  // A failed reconciliation is still unresolved; a cancellation is not proof of no effects.
  const unknown=await loop.run(first.tenant,first.id);assert.equal(unknown.state,'needs_reconciliation');await assert.rejects(b.acquire(second.tenant,second.id),/reconciliation/);
  const result=await new AutonomousLoop(a,{...adapter,reconcile:async()=>output('Original finalized effect')},()=>1000000).run(first.tenant,first.id);assert.equal(result.state,'completed');assert.equal(result.intents[0].phase,'complete');assert.equal(result.spent.sol,'1');
  const next=await b.acquire(second.tenant,second.id);await next();
 }finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}
});

test('older simultaneous reservations can reconcile without deadlock or authorizing new model and tool dispatch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentos-legacy-reservations-')),file=join(dir,'jobs.sqlite'),store=new SQLiteAutonomousStore(file),db=new DatabaseSync(file);
 try{const loop=new AutonomousLoop(store,adapter,()=>1000000),first=await loop.create(input),second=await loop.create(input),intent=(id:string)=>({id,action:{key:id,tool:'research',input:'Original input',asset:'SOL' as const,amount:'1'},phase:'reserved' as const,cycle:1,executionId:'0'});
  for(const job of [first,second]){const value={...job,state:'needs_reconciliation',cycle:1,modelRequests:1,spent:{sol:'1',usdc:'0'},intents:[intent((await import('node:crypto')).randomUUID())]},body=JSON.stringify(value);db.prepare('UPDATE jobs SET body=?,hash=? WHERE id=?').run(body,createHash('sha256').update(body).digest('hex'),job.id);}
  let evaluations=0;const recovery=new AutonomousLoop(store,{...adapter,reconcile:async()=>output('Original verified receipt'),evaluate:async()=>{evaluations++;return {complete:true,feedback:'Reconciled'};}},()=>1000000);
  await assert.rejects(recovery.run(first.tenant,first.id),/before new model/);const partiallyRecovered=await store.load(first.tenant,first.id);assert.equal(partiallyRecovered.intents[0].phase,'complete');assert.equal(partiallyRecovered.modelRequests,1);assert.equal(evaluations,0);
  assert.equal((await recovery.run(second.tenant,second.id)).state,'completed');assert.equal((await recovery.run(first.tenant,first.id)).state,'completed');assert.equal(evaluations,2);assert.equal((await store.load(first.tenant,first.id)).spent.sol,'1');
 }finally{db.close();store.close();await rm(dir,{recursive:true,force:true});}
});
