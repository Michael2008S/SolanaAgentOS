import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { request as httpRequest,type IncomingMessage,type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createPublicApiServer } from './autonomous-public-server.js';
import type { AutonomousController } from './autonomous-controller.js';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSigner,getAddressDecoder } from '@solana/kit';
import { canonicalJson } from './canonical-json.js';
import { WorkerProfileStore,verifyWorkerProfile,verifyWorkerProfileConflict,WorkerProfileEquivocationError,type WorkerProfile } from './worker-profiles.js';
import { workerProfileHandler,workerProfileRoute,workerProfileCatalogSchema } from './worker-profile-catalog.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const key=(value:string)=>getAddressDecoder().decode(createHash('sha256').update(value).digest());
async function fixture(){
 const owner=await generateKeyPairSigner(),now=1791550000,chain={programId:key('program'),network:'localnet' as const,genesis:key('genesis')};
 const sign=async(agent:string=key('agent'),changes:Partial<WorkerProfile['payload']>={}):Promise<WorkerProfile>=>{
  const payload:WorkerProfile['payload']={domain:'agentos-worker-profile-v1',...chain,agent,owner:owner.address,issuedAt:now-10,expiresAt:now+100,profile:{description:'Research',tags:[],languages:[],models:[],availability:'available',minimumSol:'0',minimumUsdc:'0'},...changes};
  return {payload,signature:Buffer.from(await crypto.subtle.sign('Ed25519',owner.keyPair.privateKey,Buffer.from(canonicalJson(payload)))).toString('base64')};
 };
 return {owner,now,chain,sign};
}
test('profile storage scopes chains and migrates original v1 records without losing watermarks',async()=>{
 const f=await fixture(),root=await mkdtemp(join(tmpdir(),'agentos-profile-migration-')),file=join(root,'profiles.sqlite'),profile=await f.sign();
 const db=new DatabaseSync(file);db.exec('CREATE TABLE profiles(agent TEXT PRIMARY KEY,issued_at INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL) STRICT;PRAGMA application_id=1095190360;PRAGMA user_version=1;');const body=JSON.stringify(profile);db.prepare('INSERT INTO profiles VALUES(?,?,?,?)').run(profile.payload.agent,profile.payload.issuedAt,body,hash(body));db.close();
 const corruptFile=join(root,'corrupt.sqlite'),corrupt=new DatabaseSync(corruptFile);corrupt.exec('CREATE TABLE profiles(agent TEXT PRIMARY KEY,issued_at INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL) STRICT;PRAGMA application_id=1095190360;PRAGMA user_version=1;');corrupt.prepare('INSERT INTO profiles VALUES(?,?,?,?)').run(profile.payload.agent,profile.payload.issuedAt,body,'0'.repeat(64));corrupt.close();assert.throws(()=>new WorkerProfileStore(corruptFile,f.chain),/corrupt/);const preserved=new DatabaseSync(corruptFile);assert.equal(preserved.prepare('PRAGMA user_version').get()?.user_version,1);assert.equal(preserved.prepare('SELECT COUNT(*) AS count FROM profiles').get()?.count,1);preserved.close();
 const first=new WorkerProfileStore(file,f.chain),otherChain={...f.chain,genesis:key('other-genesis')},other=new WorkerProfileStore(file,otherChain);
 try{assert.deepEqual(first.loadAll(),[profile]);assert.deepEqual(other.loadAll(),[]);assert.throws(()=>other.saveVerified(profile),/chain scope/);const second=await f.sign(profile.payload.agent,{...otherChain,issuedAt:f.now-20});await verifyWorkerProfile(second,{address:profile.payload.agent,owner:f.owner.address},otherChain,f.now);other.saveVerified(second);assert.deepEqual(first.loadAll(),[profile]);assert.deepEqual(other.loadAll(),[second]);assert.throws(()=>first.saveVerified({...profile,payload:{...profile.payload,issuedAt:f.now-20}}),/newer/);}
 finally{first.close();other.close();await rm(root,{recursive:true,force:true});}
});
test('signed profile admission, paginated catalog and stale/revoked/expired claims enforce canonical identities',async()=>{
 const f=await fixture(),root=await mkdtemp(join(tmpdir(),'agentos-profile-catalog-')),store=new WorkerProfileStore(join(root,'profiles.sqlite'),f.chain);
 let now=f.now,reads=0;const agents:Array<{address:string;owner:string;active:boolean}>=[];
 const handler=workerProfileHandler({chain:()=>f.chain,store:()=>store,agents:async()=>{reads++;return agents;},origin:()=> 'https://directory.example',now:()=>now});
 async function request(path:string,method='GET',value?:unknown){let status=200,raw='';const req=Readable.from(value===undefined?[]:[Buffer.from(JSON.stringify(value))]) as IncomingMessage;req.method=method;req.headers={'content-type':'application/json'};
 const res={setHeader(){},writeHead(code:number){status=code;return this;},end(value=''){raw=value;}} as unknown as ServerResponse;await handler(req,res,new URL(path,'https://directory.example'));return {status,body:raw?JSON.parse(raw):null};}
 try{
  const original=await f.sign();agents.push({address:original.payload.agent,owner:f.owner.address,active:true});
  assert.equal((await request('/api/marketplace/profile','POST',{...original,payload:{...original.payload,owner:key('forged')}})).status,400);assert.equal(reads,0);
  assert.equal((await request('/api/marketplace/profile','POST',original)).status,200);
  for(let n=0;n<201;n++){const p=await f.sign(key('a'+n));agents.push({address:p.payload.agent,owner:f.owner.address,active:true});store.saveVerified(p);}
  const first=await request('/api/marketplace/profiles/catalog');assert.equal(first.status,200);workerProfileCatalogSchema.parse(first.body);assert.equal(first.body.profiles.length,200);assert.equal(first.body.genesis,f.chain.genesis);
  const second=await request(new URL(first.body.next).pathname+new URL(first.body.next).search);assert.equal(second.body.profiles.length,2);assert.equal(second.body.next,undefined);
  agents[0].owner=key('new-owner');assert.equal((await request(new URL(first.body.next).pathname+new URL(first.body.next).search)).status,502);
  const revoked=await request('/api/marketplace/profiles/catalog');assert.equal(revoked.body.profiles.some((p:WorkerProfile)=>p.payload.agent===original.payload.agent),false);
  agents.forEach(agent=>agent.active=false);assert.deepEqual((await request('/api/marketplace/profiles/catalog')).body.profiles,[]);agents.forEach(agent=>agent.active=true);now=f.now+101;assert.deepEqual((await request('/api/marketplace/profiles/catalog')).body.profiles,[]);assert.equal(store.loadAll().length,202);
  for(const target of ['/api/marketplace/profiles/catalog?token=secret','/api/marketplace/%70rofile','/api/marketplace/profile/../profiles/catalog'])assert.equal(workerProfileRoute(target,'GET'),false);
  assert.equal(workerProfileRoute('/api/marketplace/profile','POST'),true);assert.equal(workerProfileRoute('/api/autonomous/jobs','GET'),false);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('public profile routes accept signatures without tenant tokens and cannot reach private autonomous handlers',async()=>{
 const f=await fixture(),root=await mkdtemp(join(tmpdir(),'agentos-profile-public-')),store=new WorkerProfileStore(join(root,'profiles.sqlite'),f.chain),profile=await f.sign();
 const handler=workerProfileHandler({chain:()=>f.chain,store:()=>store,agents:async()=>[{address:profile.payload.agent,owner:f.owner.address,active:true}],origin:()=> 'http://127.0.0.1',now:()=>f.now});
 const controller={authorized:()=>false,handle:async()=>{throw new Error('Public metadata cannot invoke the private controller.');}} as unknown as AutonomousController;
 const server=await createPublicApiServer(controller,{port:0,bind:'127.0.0.1',origin:'http://127.0.0.1',browserOrigins:['http://localhost']},{matches:workerProfileRoute,handle:handler});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const listenerPort=address.port;
 async function request(path:string,method='GET',body?:unknown,headers:Record<string,string>={}){return new Promise<{status:number;body:any}>((resolve,reject)=>{
  const req=httpRequest({hostname:'127.0.0.1',port:listenerPort,path,method,headers:{host:'127.0.0.1','content-type':'application/json',...headers}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode!,body:raw?JSON.parse(raw):null});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });}
 try{
  assert.equal((await request('/api/marketplace/profile','POST',profile)).status,200);
  assert.deepEqual((await request('/api/marketplace/profiles/catalog')).body.profiles,[profile]);
  assert.equal((await request('/api/autonomous/jobs')).status,401);
  assert.equal((await request('/api/marketplace/workers')).status,404);
  assert.equal((await request('/api/marketplace/profiles/catalog?token=secret')).status,404);
  assert.equal((await request('/api/marketplace/profile','OPTIONS',undefined,{origin:'http://localhost','access-control-request-method':'POST','access-control-request-headers':'content-type'})).status,204);
  assert.equal((await request('/api/marketplace/profile','POST',profile,{origin:'https://untrusted.example'})).status,403);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close();await rm(root,{recursive:true,force:true});}
});

test('signed profile equivocation survives storage restart, expires as a shared proof and resolves only with a newer version',async()=>{
 const f=await fixture(),root=await mkdtemp(join(tmpdir(),'agentos-profile-equivocation-')),file=join(root,'profiles.sqlite'),original=await f.sign(),conflicting=await f.sign(original.payload.agent,{profile:{...original.payload.profile,description:'Conflicting claim'},expiresAt:f.now+5});let store=new WorkerProfileStore(file,f.chain);
 const agent={address:original.payload.agent,owner:f.owner.address,active:true},pair:[WorkerProfile,WorkerProfile]=[original,conflicting];
 try{
  await verifyWorkerProfileConflict(pair,agent,f.chain,f.now+10);await assert.rejects(verifyWorkerProfileConflict([original,original],agent,f.chain,f.now));await assert.rejects(verifyWorkerProfileConflict(pair,{...agent,owner:key('other')},f.chain,f.now));await assert.rejects(verifyWorkerProfileConflict(pair,agent,f.chain,original.payload.issuedAt+30*86400));
  store.saveVerified(original);assert.throws(()=>store.saveVerified(conflicting),WorkerProfileEquivocationError);assert.deepEqual(store.loadAll(),[]);store.close();store=new WorkerProfileStore(file,f.chain);assert.throws(()=>store.load(agent.address),WorkerProfileEquivocationError);assert.throws(()=>store.saveVerified(original),WorkerProfileEquivocationError);assert.deepEqual(store.loadRecords()[0].conflict,conflicting);
  let now=f.now+10;const handler=workerProfileHandler({chain:()=>f.chain,store:()=>store,agents:async()=>[agent],origin:()=> 'https://directory.example',now:()=>now});
  async function catalog(){let raw='';const request=Readable.from([]) as IncomingMessage;request.method='GET';const response={setHeader(){},writeHead(){return this;},end(value:string){raw=value;}} as unknown as ServerResponse;await handler(request,response,new URL('https://directory.example/api/marketplace/profiles/catalog'));return JSON.parse(raw);}
  const proof=await catalog();assert.equal(proof.version,2);assert.deepEqual(proof.profiles,[]);assert.deepEqual(proof.conflicts,[pair]);workerProfileCatalogSchema.parse(proof);assert.equal(workerProfileCatalogSchema.safeParse({...proof,version:1}).success,false);
  now=original.payload.issuedAt+30*86400;assert.equal((await catalog()).conflicts,undefined);assert.throws(()=>store.load(agent.address),WorkerProfileEquivocationError);
  const updated=await f.sign(agent.address,{issuedAt:f.now-5});assert.equal(store.saveVerified(updated),true);assert.deepEqual(store.loadAll(),[updated]);assert.equal(store.loadRecords()[0].conflict,null);assert.throws(()=>store.saveVerified(original),/newer/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
