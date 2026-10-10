import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AutonomousLoop } from './autonomous-loop.js';
import { SQLiteAutonomousStore } from './autonomous-sqlite.js';
import { AutonomousNotifier,parseNotificationDestinations } from './autonomous-notifications.js';
const secret='local-notification-test-credential-20261010',env={NOTIFY_TEST_SECRET:secret};
const input={tenant:'owner',goal:'Private goal must never leave in notification',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),limits:{sol:'2',usdc:'0',maxCycles:3,maxActions:3,maxModelRequests:6,deadline:Math.floor(Date.now()/1000)+600,tools:['research']}};
const adapter:any={validate:async()=>{},plan:async()=>[],execute:async()=>{throw new Error('No paid work in notification tests');},reconcile:async()=>null,evaluate:async()=>({complete:true,feedback:'Private original output'})};
async function complete(store:SQLiteAutonomousStore){const loop=new AutonomousLoop(store,adapter),job=await loop.create(input);return loop.run(job.tenant,job.id);}
test('notification destinations are fixed operator configuration and do not widen tenant access',()=>{
 const raw=(value:unknown)=>JSON.stringify(value),valid={tenant:'owner',endpoint:'https://receiver.example.com/events',secretEnv:'NOTIFY_TEST_SECRET'};
 assert.equal(parseNotificationDestinations(raw([valid]),['owner'],env).length,1);
 for(const value of [{...valid,tenant:'other'},{...valid,endpoint:'http://external.example.com'},{...valid,endpoint:'https://user:password@receiver.example.com'},{...valid,endpoint:'https://receiver.example.com/#fragment'}])assert.throws(()=>parseNotificationDestinations(raw([value]),['owner'],env));
 assert.throws(()=>parseNotificationDestinations(raw([valid,valid]),['owner'],env),/unique/);assert.throws(()=>parseNotificationDestinations(raw([valid]),['owner'],{}),/credential/);
});
test('actual authenticated HTTP notification survives retry and journal reopen without job replay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-notifications-'));let calls=0;const bodies:string[]=[],ids:string[]=[];
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString(),id=String(req.headers['x-agentos-event']),timestamp=String(req.headers['x-agentos-timestamp']);
  assert.equal(req.headers['idempotency-key'],id);assert.equal(req.headers['x-agentos-signature'],'v1='+createHmac('sha256',secret).update(timestamp+'.'+id+'.'+body).digest('hex'));assert.equal(req.headers.authorization,undefined);
  bodies.push(body);ids.push(id);calls++;res.writeHead(calls===1?429:204).end();});
 server.listen(0,'127.0.0.1');await once(server,'listening');const listener=server.address();assert.ok(listener&&typeof listener!=='string');
 const destinations=parseNotificationDestinations(JSON.stringify([{tenant:'owner',endpoint:`http://127.0.0.1:${listener.port}/events`,secretEnv:'NOTIFY_TEST_SECRET'}]),['owner'],env),scopes=new Map(destinations.map(value=>[value.tenant,value.hash])),file=join(root,'jobs.sqlite');let store=new SQLiteAutonomousStore(file,scopes),clock=Date.now()+1000;
 try{const job=await complete(store),original=JSON.stringify(job),notifier=new AutonomousNotifier(store,destinations,fetch,()=>clock,env);assert.equal(job.state,'completed');
  assert.equal(await notifier.runOnce(),1);assert.equal(calls,1);assert.equal((await store.notificationStatus('owner')).deliveries[0].status,'pending');assert.equal(await notifier.runOnce(),0);
  assert.deepEqual((await store.notificationStatus('other')).deliveries,[]);assert.ok(!bodies[0].includes(input.goal));assert.ok(!bodies[0].includes('Private original output'));assert.ok(!bodies[0].includes(secret));
  store.close();store=new SQLiteAutonomousStore(file,scopes);clock+=2000;const reopened=new AutonomousNotifier(store,destinations,fetch,()=>clock,env);assert.equal(await reopened.runOnce(),1);assert.equal(calls,2);assert.equal(ids[0],ids[1]);assert.equal(bodies[0],bodies[1]);assert.equal((await store.notificationStatus('owner')).deliveries[0].status,'sent');
  const release=await store.acquire(job.tenant,job.id);await store.save(job);await release();assert.equal(await reopened.runOnce(),0);assert.equal(JSON.stringify(await store.load(job.tenant,job.id)),original);
 }finally{store.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
test('notification lease rejects a live competing worker and recovers only a dead local process',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-notification-crash-')),file=join(root,'jobs.sqlite'),destination=parseNotificationDestinations(JSON.stringify([{tenant:'owner',endpoint:'http://127.0.0.1:19801/events',secretEnv:'NOTIFY_TEST_SECRET'}]),['owner'],env),scopes=new Map(destination.map(value=>[value.tenant,value.hash]));
 let store=new SQLiteAutonomousStore(file,scopes);try{await complete(store);const claim=await store.claimNotification(Date.now()+1000);assert.ok(claim);const other=new SQLiteAutonomousStore(file,scopes);try{assert.equal(await other.claimNotification(Date.now()+1000),null);assert.throws(()=>store.close(),/notification deliveries/);await assert.rejects(()=>other.settleNotification({...claim,token:'wrong'},'sent'),/ownership/);}finally{other.close();}
  await store.settleNotification(claim,'retry',Date.now());store.close();
  const child=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`import {SQLiteAutonomousStore} from './apps/runtime/src/autonomous-sqlite.ts';const store=new SQLiteAutonomousStore(process.argv[1],new Map(JSON.parse(process.argv[2])));const claim=await store.claimNotification(Date.now()+10000);console.log(JSON.stringify({id:claim.id,attempts:claim.attempts}));process.exit(0);`,file,JSON.stringify([...scopes])]);
  store=new SQLiteAutonomousStore(file,scopes);const recovered=await store.claimNotification(Date.now()+10000),old=JSON.parse(child.stdout);assert.ok(recovered);assert.equal(recovered.id,old.id);assert.equal(recovered.attempts,old.attempts+1);await store.settleNotification(recovered,'sent');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('redirects, permanent rejection, retry exhaustion and changed destinations cannot leak credentials or replay jobs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-notification-rejection-')),file=join(root,'jobs.sqlite'),destinations=parseNotificationDestinations(JSON.stringify([{tenant:'owner',endpoint:'https://receiver.example.com/events',secretEnv:'NOTIFY_TEST_SECRET'}]),['owner'],env),scopes=new Map(destinations.map(value=>[value.tenant,value.hash]));let store=new SQLiteAutonomousStore(file,scopes),clock=Date.now()+1000,calls=0;
 try{const job=await complete(store),original=JSON.stringify(job);
  const transport=(async(url,options)=>{calls++;assert.equal(url,destinations[0].endpoint);assert.equal(options?.redirect,'error');assert.equal(options?.headers&&JSON.stringify(options.headers).includes(secret),false);return new Response('Untrusted credential echo '+secret,{status:503});}) as typeof fetch;
  const notifier=new AutonomousNotifier(store,destinations,transport,()=>clock,env);for(let n=0;n<8;n++){assert.equal(await notifier.runOnce(),1);clock+=2_000_000;}assert.equal(calls,8);assert.equal((await store.notificationStatus('owner')).deliveries[0].failure,'retry_exhausted');assert.equal(await notifier.runOnce(),0);assert.equal(JSON.stringify(await store.load(job.tenant,job.id)),original);
  const second=await complete(store),changedHash='b'.repeat(64);store.close();store=new SQLiteAutonomousStore(file,new Map([['owner',changedHash]]));assert.equal(await store.claimNotification(clock),null);assert.equal((await store.notificationStatus('owner')).deliveries.some(value=>value.jobId===second.id&&value.destinationChanged),true);
  store.close();store=new SQLiteAutonomousStore(file,scopes);const rejected=new AutonomousNotifier(store,destinations,(async()=>new Response(null,{status:401})) as typeof fetch,()=>clock,env);assert.equal(await rejected.runOnce(),1);assert.equal((await store.notificationStatus('owner')).deliveries.find(value=>value.jobId===second.id)?.failure,'receiver_rejected');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('actual HTTP redirects never forward signed notifications to another route',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-notification-redirect-'));let originalCalls=0,forwardedCalls=0;
 const server=createServer((req,res)=>{if(req.url==='/capture'){forwardedCalls++;res.writeHead(204).end();return;}originalCalls++;res.writeHead(307,{location:'/capture'}).end();});server.listen(0,'127.0.0.1');await once(server,'listening');const listener=server.address();assert.ok(listener&&typeof listener!=='string');
 const destinations=parseNotificationDestinations(JSON.stringify([{tenant:'owner',endpoint:`http://127.0.0.1:${listener.port}/events`,secretEnv:'NOTIFY_TEST_SECRET'}]),['owner'],env),store=new SQLiteAutonomousStore(join(root,'jobs.sqlite'),new Map(destinations.map(value=>[value.tenant,value.hash])));
 try{await complete(store);assert.equal(await new AutonomousNotifier(store,destinations,fetch,()=>Date.now()+1000,env).runOnce(),1);assert.equal(originalCalls,1);assert.equal(forwardedCalls,0);assert.equal((await store.notificationStatus('owner')).deliveries[0].status,'pending');}finally{store.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
test('an accepted delivery with a transient checkpoint failure is persisted without another HTTP call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-notification-checkpoint-')),destinations=parseNotificationDestinations(JSON.stringify([{tenant:'owner',endpoint:'https://receiver.example.com/events',secretEnv:'NOTIFY_TEST_SECRET'}]),['owner'],env),store=new SQLiteAutonomousStore(join(root,'jobs.sqlite'),new Map(destinations.map(value=>[value.tenant,value.hash])));let calls=0,writes=0;
 try{await complete(store);const original=store.settleNotification.bind(store);store.settleNotification=async(...args)=>{if(++writes===1)throw new Error('Temporary SQLite busy');return original(...args);};const notifier=new AutonomousNotifier(store,destinations,(async()=>{calls++;return new Response(null,{status:204});}) as typeof fetch,()=>Date.now()+1000,env);
  await assert.rejects(()=>notifier.runOnce(),/SQLite busy/);assert.equal(calls,1);assert.equal((await store.notificationStatus('owner')).deliveries[0].status,'pending');assert.equal(await notifier.runOnce(),0);assert.equal(calls,1);assert.equal((await store.notificationStatus('owner')).deliveries[0].status,'sent');assert.equal(writes,2);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
