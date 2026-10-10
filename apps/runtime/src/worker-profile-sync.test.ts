import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSigner,getAddressDecoder } from '@solana/kit';
import { canonicalJson } from './canonical-json.js';
import { WorkerProfileStore,WorkerProfileEquivocationError,verifyWorkerProfileConflict,type WorkerProfile } from './worker-profiles.js';
import { WorkerProfileSync,configuredWorkerProfileCatalogs } from './worker-profile-sync.js';
const key=(value:string)=>getAddressDecoder().decode(createHash('sha256').update(value).digest());
async function fixture(){
 const owner=await generateKeyPairSigner(),now=1791550000,chain={programId:key('program'),genesis:key('genesis'),network:'localnet' as const};
 const sign=async(index:number,issuedAt=now-10,description='Research',expiresAt=now+100):Promise<WorkerProfile>=>{
  const payload:WorkerProfile['payload']={domain:'agentos-worker-profile-v1',...chain,agent:key('agent'+index),owner:owner.address,issuedAt,expiresAt,profile:{description,tags:[],languages:[],models:[],availability:'available',minimumSol:'0',minimumUsdc:'0'}};
  return {payload,signature:Buffer.from(await crypto.subtle.sign('Ed25519',owner.keyPair.privateKey,Buffer.from(canonicalJson(payload)))).toString('base64')};};
 const manifest=(profiles:WorkerProfile[],next?:string)=>({format:'agentos-worker-profile-catalog',version:1,...chain,profiles,...(next?{next}:{})});
 return {owner,now,chain,sign,manifest};
}
test('replicates all 1,007 signed profiles, survives outage/reopen and preserves expired newer watermarks',async()=>{
 const f=await fixture(),profiles=await Promise.all(Array.from({length:1007},(_,n)=>f.sign(n))),agents=profiles.map(p=>({address:p.payload.agent,owner:p.payload.owner,active:true}));
 const directory=await mkdtemp(join(tmpdir(),'agentos-profile-sync-')),file=join(directory,'profiles.sqlite');let store=new WorkerProfileStore(file,f.chain),offline=false,calls=0;
 const transport:typeof fetch=async(input,init)=>{assert.equal(init?.redirect,'error');assert.ok(init?.signal);calls++;if(offline)throw new Error('Source offline');const page=Number(new URL(String(input)).searchParams.get('page')??0);return Response.json(f.manifest(profiles.slice(page*200,(page+1)*200),page<5?'https://catalog.example/profiles?page='+(page+1):undefined));};
 const options={urls:['https://catalog.example/profiles'],chain:()=>f.chain,agents:async()=>agents,store:()=>store,now:()=>f.now,transport},sync=new WorkerProfileSync(options);
 try{const report=await sync.sync();assert.equal(report.imported,1007);assert.deepEqual(report.failures,[]);assert.equal(calls,6);assert.equal(store.loadAll().length,1007);assert.equal((await sync.sync()).unchanged,1007);
 offline=true;assert.equal((await sync.sync()).failures.length,1);store.close();store=new WorkerProfileStore(file,f.chain);assert.equal(store.loadAll().length,1007);
 const newer=await f.sign(0,f.now-5,'Latest busy profile',f.now+1);store.saveVerified(newer);const staleSync=new WorkerProfileSync({...options,now:()=>f.now+2,transport:async()=>Response.json(f.manifest([profiles[0]]))});assert.equal((await staleSync.sync()).unchanged,1);assert.deepEqual(store.load(profiles[0].payload.agent),newer);await staleSync.stop();
 }finally{await sync.stop();store.close();await rm(directory,{recursive:true,force:true});}
});
test('incomplete, wrong-chain, repeated and cross-endpoint catalogs do not import a fetched prefix',async()=>{
 const f=await fixture(),profile=await f.sign(0),directory=await mkdtemp(join(tmpdir(),'agentos-profile-confinement-')),store=new WorkerProfileStore(join(directory,'profiles.sqlite'),f.chain),agents=[{address:profile.payload.agent,owner:f.owner.address,active:true}];
 try{for(const next of ['https://other.example/profiles','https://catalog.example/other','https://catalog.example/profiles']){
 let calls=0;const sync=new WorkerProfileSync({urls:['https://catalog.example/profiles'],chain:()=>f.chain,agents:async()=>agents,store:()=>store,now:()=>f.now,transport:async()=>{calls++;return Response.json(f.manifest([profile],next));}});assert.equal((await sync.sync()).failures.length,1);assert.equal(calls,1);assert.deepEqual(store.loadAll(),[]);await sync.stop();}
 for(const transport of [async()=>Response.json({...f.manifest([profile]),genesis:key('other')}),async(input:unknown)=>new URL(String(input)).search?new Response('offline',{status:503}):Response.json(f.manifest([profile],'https://catalog.example/profiles?page=2'))]){
 const sync=new WorkerProfileSync({urls:['https://catalog.example/profiles'],chain:()=>f.chain,agents:async()=>agents,store:()=>store,now:()=>f.now,transport});assert.equal((await sync.sync()).failures.length,1);assert.deepEqual(store.loadAll(),[]);await sync.stop();}
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
test('rejects forgery, missing/changed Owners and inactive Agents; quarantines equal-version conflicts without replacing original proof',async()=>{
 const f=await fixture(),original=await f.sign(0),conflict=await f.sign(0,f.now-10,'Conflicting claim'),other=await f.sign(1),directory=await mkdtemp(join(tmpdir(),'agentos-profile-validation-')),store=new WorkerProfileStore(join(directory,'profiles.sqlite'),f.chain);
 let agents=[{address:original.payload.agent,owner:f.owner.address,active:true}],claims=[original],now=f.now;
 const sync=new WorkerProfileSync({urls:['https://catalog.example/profiles'],chain:()=>f.chain,agents:async()=>agents,store:()=>store,now:()=>now,transport:async()=>Response.json(f.manifest(claims))});
 try{assert.equal((await sync.sync()).imported,1);claims=[conflict];assert.equal((await sync.sync()).conflicts,1);assert.throws(()=>store.load(original.payload.agent),WorkerProfileEquivocationError);assert.deepEqual(store.loadRecords()[0].profile,original);assert.deepEqual(store.loadRecords()[0].conflict,conflict);
 claims=[{...other,payload:{...other.payload,profile:{...other.payload.profile,description:'Tampered'}}}];agents.push({address:other.payload.agent,owner:f.owner.address,active:true});assert.equal((await sync.sync()).rejected,1);assert.equal(store.loadRecords().length,1);
 claims=[other];agents[1].owner=key('wrong-owner');assert.equal((await sync.sync()).rejected,1);agents[1].owner=f.owner.address;agents[1].active=false;assert.equal((await sync.sync()).rejected,1);agents=[];assert.equal((await sync.sync()).rejected,1);
 claims=[await f.sign(2),await f.sign(2,f.now-10,'second')];agents=[{address:claims[0].payload.agent,owner:f.owner.address,active:true}];assert.equal((await sync.sync()).conflicts,1);assert.throws(()=>store.load(claims[0].payload.agent),WorkerProfileEquivocationError);
 }finally{await sync.stop();store.close();await rm(directory,{recursive:true,force:true});}
});
test('coalesces live synchronization and stop waits before callers close storage',async()=>{
 const f=await fixture();let release!:()=>void,calls=0;const gate=new Promise<void>(resolve=>release=resolve),directory=await mkdtemp(join(tmpdir(),'agentos-profile-stop-')),store=new WorkerProfileStore(join(directory,'profiles.sqlite'),f.chain);
 const sync=new WorkerProfileSync({urls:['https://catalog.example/profiles'],chain:()=>f.chain,agents:async()=>[],store:()=>store,now:()=>f.now,transport:async()=>{calls++;await gate;return Response.json(f.manifest([]));}});
 try{const a=sync.sync(),b=sync.sync();assert.equal(a,b);await new Promise(resolve=>setImmediate(resolve));let stopped=false;const stopping=sync.stop().then(()=>stopped=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);assert.equal(calls,1);release();await stopping;await a;assert.equal(stopped,true);await assert.rejects(sync.sync(),/stopped/);}finally{release();await sync.stop();store.close();await rm(directory,{recursive:true,force:true});}
});
test('bootstrap configuration validates exact public URLs and refuses duplicates, credentials and unbounded peers',()=>{
 assert.deepEqual(configuredWorkerProfileCatalogs({}),[]);
 for(const urls of [['https://catalog.example/profiles','https://catalog.example/profiles'],['http://remote.example/profiles'],['https://user:secret@catalog.example/profiles'],Array(21).fill('https://catalog.example/profiles')])assert.throws(()=>configuredWorkerProfileCatalogs({AGENTOS_WORKER_PROFILE_CATALOG_URLS:JSON.stringify(urls)}));
});

test('replicates expired-claim conflict witnesses atomically and restores only newer signed versions',async()=>{
 const f=await fixture(),a=await f.sign(0),b=await f.sign(0,f.now-10,'Conflicting',f.now+1),root=await mkdtemp(join(tmpdir(),'agentos-profile-proof-sync-')),file=join(root,'profiles.sqlite');let store=new WorkerProfileStore(file,f.chain),now=f.now+2;
 const agent={address:a.payload.agent,owner:f.owner.address,active:true};let manifest:any={...f.manifest([]),version:2,conflicts:[[a,b]]};
 const sync=new WorkerProfileSync({urls:['https://catalog.example/profiles'],chain:()=>f.chain,agents:async()=>[agent],store:()=>store,now:()=>now,transport:async()=>Response.json(manifest)});
 try{await verifyWorkerProfileConflict([a,b],agent,f.chain,now);assert.equal((await sync.sync()).conflicts,1);assert.deepEqual(store.loadAll(),[]);assert.deepEqual(store.loadRecords()[0],{profile:a,conflict:b});store.close();store=new WorkerProfileStore(file,f.chain);assert.equal((await sync.sync()).conflicts,1);assert.equal(store.loadRecords().length,1);
 manifest=f.manifest([a]);assert.equal((await sync.sync()).conflicts,1);assert.throws(()=>store.load(a.payload.agent),WorkerProfileEquivocationError);
 manifest={...f.manifest([]),version:2,conflicts:[[a,{...b,payload:{...b.payload,owner:key('forged')}}]]};assert.equal((await sync.sync()).rejected,1);assert.deepEqual(store.loadRecords()[0].conflict,b);
 const updated=await f.sign(0,f.now-5,'Resolved');manifest=f.manifest([updated]);assert.equal((await sync.sync()).imported,1);assert.deepEqual(store.loadAll(),[updated]);manifest={...f.manifest([]),version:2,conflicts:[[a,b]]};assert.equal((await sync.sync()).unchanged,1);assert.deepEqual(store.loadAll(),[updated]);
 }finally{await sync.stop();store.close();await rm(root,{recursive:true,force:true});}
});
