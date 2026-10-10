import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,rm,writeFile,readFile,mkdir,stat } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpsRequest } from 'node:https';
import { TenantCredentialRegistry,tenantCredentialChange } from './tenant-credentials.js';
import { AutonomousController,parseAutonomousTenants } from './autonomous-controller.js';
import { AutonomousLoop } from './autonomous-loop.js';
import { SQLiteAutonomousStore } from './autonomous-sqlite.js';
import { createPublicApiServer } from './autonomous-public-server.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),chain={program:'C'.repeat(32),genesis:'D'.repeat(32)},tokenA='a'.repeat(40),tokenB='b'.repeat(40),tokenC='c'.repeat(40),otherToken='o'.repeat(40);
const tenants=()=>parseAutonomousTenants(JSON.stringify([tokenA,otherToken].map((token,i)=>({tenant:i?'other':'owner',tokenSha256:sha(token),agent:'11111111111111111111111111111111',session:'11111111111111111111111111111111',maxDurationSeconds:600,limits:{sol:'0',usdc:'0',maxCycles:1,maxActions:1,maxModelRequests:2,tools:['fixture']}}))));
const edit=(revision:number,state:'active'|'revoked',extra:object={})=>({tenant:'owner',expectedRevision:revision,state,actor:'Fixture operator',reason:'Review fixture change',...extra});

test('live independent readers observe CAS rotation, revocation, expiry and permanent hash retirement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-credentials-')),path=join(root,'credentials.sqlite');let now=1000000;const runtime=new TenantCredentialRegistry(path,()=>now),operator=new TenantCredentialRegistry(path,()=>now);
 const auth=(token:string)=>runtime.authenticate(Buffer.from(sha(token),'hex'));
 try{assert.equal((await stat(path)).mode&0o777,0o600);runtime.seed(tenants(),chain);assert.equal(auth(tokenA),'owner');assert.equal(auth(otherToken),'other');operator.change(edit(0,'active',{tokenSha256:sha(tokenB),expiresAt:1001}));assert.equal(auth(tokenA),null);assert.equal(auth(tokenB),'owner');assert.throws(()=>operator.change(edit(0,'revoked')),/revision/);assert.equal(runtime.history('owner').length,2);
  now=1001000;assert.equal(auth(tokenB),null);assert.throws(()=>operator.change(edit(1,'active',{expiresAt:null})),/fresh/);operator.change(edit(1,'revoked'));assert.throws(()=>operator.change(edit(2,'active',{expiresAt:null})),/fresh/);operator.change(edit(2,'active',{tokenSha256:sha(tokenC),expiresAt:null}));assert.equal(auth(tokenC),'owner');assert.throws(()=>operator.change(edit(3,'active',{tokenSha256:sha(tokenA)})),/reused/);assert.equal(auth(otherToken),'other');
  runtime.seed(tenants(),chain);assert.equal(auth(tokenA),null);assert.equal(auth(tokenC),'owner');assert.throws(()=>runtime.seed([{...tenants()[0],session:tenants()[0].agent,limits:{...tenants()[0].limits,sol:'1'}}],chain),/authority/);assert.throws(()=>runtime.seed([{...tenants()[0],tenant:'new',tokenSha256:sha(tokenB)}],chain),/reused/);assert.throws(()=>runtime.snapshot('new'),/not registered/);assert.equal(runtime.snapshot('owner').revision,3);assert.deepEqual(runtime.history('owner').map(r=>r.revision),[0,1,2,3]);assert.ok(!JSON.stringify(runtime.history('owner')).includes(sha(tokenC)));
  for(const bad of [{...edit(3,'active'),token:tokenA},{...edit(3,'active'),tokenSha256:tokenA},{...edit(3,'active'),actor:'newline\noperator'}])assert.throws(()=>tenantCredentialChange.parse(bad));
 }finally{operator.close();runtime.close();await rm(root,{recursive:true,force:true});}
});

test('managed authentication fails closed instead of accepting the bootstrap credential when registry is unavailable',()=>{
 const controller=new AutonomousController({} as any,{} as any,tenants(),chain,undefined,()=>{throw new Error('Registry unavailable');});assert.equal(controller.authorized({headers:{authorization:'Bearer '+tokenA}} as any),false);
});

test('operator CLI changes live TLS authentication without changing accepted jobs or tenant scope',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-credential-tls-')),path=join(root,'credentials.sqlite'),cert=join(root,'transport.crt'),key=join(root,'transport.key');
 // Ephemeral transport TLS key only; no wallet files or signing capability.
 await promisify(execFile)('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=api.agentos.test','-addext','subjectAltName=DNS:api.agentos.test']);
 const ca=await readFile(cert),store=new SQLiteAutonomousStore(join(root,'jobs.sqlite'));let registry=new TenantCredentialRegistry(path);registry.seed(tenants(),chain);let release!:()=>void,modelCalls=0;const blocked=new Promise<void>(r=>{release=r;});
 const loop=new AutonomousLoop(store,{validate:async()=>{},plan:async()=>{modelCalls++;await blocked;return [];},execute:async()=>{throw new Error('No tool or signing capability');},reconcile:async()=>null,evaluate:async()=>{modelCalls++;return {complete:true,feedback:'Accepted local fixture completed'};}});
 let controller=new AutonomousController(store,loop,tenants(),chain,undefined,h=>registry.authenticate(h));
 const config={port:0,bind:'127.0.0.1',origin:'https://api.agentos.test',browserOrigins:[],cert,key};let server=await createPublicApiServer(controller,config);server.listen(0,'127.0.0.1');await once(server,'listening');
 const call=(token:string,path='/api/autonomous/scope',value?:unknown)=>new Promise<{status:number;body:any}>((resolve,reject)=>{const req=httpsRequest({hostname:'127.0.0.1',port:(server.address() as any).port,servername:'api.agentos.test',ca,path,method:value===undefined?'GET':'POST',headers:{host:'api.agentos.test',authorization:'Bearer '+token,'content-type':'application/json'}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(raw)}));});req.on('error',reject);req.end(value===undefined?undefined:JSON.stringify(value));});
 const cli=async(command:string,arg:string)=>JSON.parse((await promisify(execFile)(process.execPath,['--import','tsx','apps/runtime/src/manage-tenant-credentials.ts',command,arg],{cwd:resolve('.'),env:{...process.env,AGENTOS_TENANT_CREDENTIAL_DATABASE:path}})).stdout);
 const change=async(value:object)=>{const file=join(root,'change.json');await writeFile(file,JSON.stringify(value));return cli('change',file);};
 const close=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));};
 try{
  const scope=(await call(tokenA)).body,created=await call(tokenA,'/api/autonomous/jobs',{goal:'Continue accepted work across access credential changes'});assert.equal(created.status,202);const id=created.body.job.id;
  const rotated=await change(edit(0,'active',{tokenSha256:sha(tokenB)}));assert.equal(rotated.scope.revision,1);assert.equal(rotated.signingAuthorityChanged,false);assert.equal((await call(tokenA)).status,401);assert.deepEqual((await call(tokenB)).body,scope);assert.equal((await call(otherToken,'/api/autonomous/jobs/'+id)).status,422);
  await change(edit(1,'revoked'));assert.equal((await call(tokenB)).status,401);assert.equal((await call(otherToken)).status,200);release();await controller.idle();assert.equal((await store.load('owner',id)).state,'completed');assert.equal(modelCalls,2);
  await assert.rejects(change(edit(1,'active',{tokenSha256:sha(tokenC)})));assert.equal(registry.snapshot('owner').revision,2);await change(edit(2,'active',{tokenSha256:sha(tokenC)}));assert.equal((await call(tokenB)).status,401);assert.equal((await call(tokenC,'/api/autonomous/jobs/'+id)).body.job.state,'completed');
  const viewed=await cli('view','owner');assert.equal(viewed.scope.revision,3);assert.deepEqual(viewed.audit.map((r:any)=>r.revision),[0,1,2,3]);
  await close();registry.close();registry=new TenantCredentialRegistry(path);registry.seed(tenants(),chain);controller=new AutonomousController(store,loop,tenants(),chain,undefined,h=>registry.authenticate(h));server=await createPublicApiServer(controller,config);server.listen(0,'127.0.0.1');await once(server,'listening');assert.equal((await call(tokenA)).status,401);assert.equal((await call(tokenB)).status,401);assert.deepEqual((await call(tokenC)).body,scope);assert.equal((await call(tokenC,'/api/autonomous/jobs/'+id)).body.job.state,'completed');assert.equal(modelCalls,2);
  if(process.env.AGENTOS_CREDENTIAL_ACCEPTANCE_EVIDENCE){const dir=resolve(process.env.AGENTOS_CREDENTIAL_ACCEPTANCE_EVIDENCE);await mkdir(dir,{recursive:true});await writeFile(join(dir,'report.json'),JSON.stringify({status:'passed',transport:'Actual TLS with verified fixture CA and DNS identity',tenantCount:2,credentialAudit:viewed.audit,scopeUnchanged:true,oldCredentialsRejectedAfterLiveRotationAndRestart:true,otherTenantUnaffected:true,staleCliRevisionRejected:true,acceptedJobCompletedWhileCredentialRevoked:true,completedJobReadableAfterRestore:true,localAdapterRequests:modelCalls,realModelRequests:0,transactions:0,limitations:['Dedicated local TLS handler and real operator CLI, not full Runtime or cross-host deployment.','Credential revocation controls access; it does not revoke on-chain Sessions or cancel accepted jobs.','Ephemeral TLS fixture transport key removed; no wallet signer.']},null,2)+'\n');}
 }finally{release();await controller.idle();await close();registry.close();store.close();await rm(root,{recursive:true,force:true});}
});
