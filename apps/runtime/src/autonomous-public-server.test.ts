import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,writeFile,mkdir,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AutonomousLoop } from './autonomous-loop.js';
import { SQLiteAutonomousStore } from './autonomous-sqlite.js';
import { AutonomousController,parseAutonomousTenants } from './autonomous-controller.js';
import { createPublicApiServer,parsePublicApiConfig } from './autonomous-public-server.js';
import { backgroundApiUrl } from '../../web/src/lib/backgroundApi.js';
test('public configuration and browser URLs pin TLS, hosts and dedicated routes',()=>{
 const env={AGENTOS_PUBLIC_PORT:'8791',AGENTOS_PUBLIC_API_ORIGIN:'https://api.agentos.test',AGENTOS_PUBLIC_BROWSER_ORIGINS:'["https://app.agentos.test"]'};
 assert.equal(parsePublicApiConfig({}),undefined);assert.equal(parsePublicApiConfig(env)?.bind,'127.0.0.1');
 for(const bad of [{AGENTOS_PUBLIC_PORT:'0'},{AGENTOS_PUBLIC_PORT:'65536'},{AGENTOS_PUBLIC_BIND:'0.0.0.0'},{AGENTOS_PUBLIC_API_ORIGIN:'http://api.agentos.test'},{AGENTOS_PUBLIC_API_ORIGIN:'https://user:password@api.agentos.test'},{AGENTOS_PUBLIC_API_ORIGIN:'https://api.agentos.test/private'},{AGENTOS_PUBLIC_BROWSER_ORIGINS:'["*"]'},{AGENTOS_PUBLIC_TLS_CERT:'unpaired'}])assert.throws(()=>parsePublicApiConfig({...env,...bad}));
 assert.equal(backgroundApiUrl('scope'),' /api/autonomous/scope'.trim());assert.equal(backgroundApiUrl('jobs','https://api.agentos.test'),'https://api.agentos.test/api/autonomous/jobs');
 for(const origin of ['http://external.test','https://token@api.agentos.test','https://api.agentos.test/path','https://api.agentos.test/?token=secret'])assert.throws(()=>backgroundApiUrl('scope',origin));
 for(const path of ['../memory','jobs/../../run','scope?token=secret','jobs/%2e%2e','https://external.test'])assert.throws(()=>backgroundApiUrl(path,'https://api.agentos.test'));
});
test('actual TLS public entry isolates tenants and excludes local preview, bodies and forwarded identities',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-public-api-')),cert=join(root,'transport.crt'),key=join(root,'transport.key');
 // Transport TLS credentials only. No wallet key generation, export or files.
 await promisify(execFile)('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=api.agentos.test','-addext','subjectAltName=DNS:api.agentos.test']);
 const ca=await readFile(cert),store=new SQLiteAutonomousStore(join(root,'jobs.sqlite')),tokenA='owner-a-public-api-test-token-20261010',tokenB='owner-b-public-api-test-token-20261010';let effects=0;
 const tenants=parseAutonomousTenants(JSON.stringify([tokenA,tokenB].map((token,index)=>({tenant:index?'owner_b':'owner_a',tokenSha256:createHash('sha256').update(token).digest('hex'),agent:'11111111111111111111111111111111',session:'11111111111111111111111111111111',maxDurationSeconds:600,limits:{sol:'0',usdc:'0',maxCycles:1,maxActions:1,maxModelRequests:2,tools:['fixture']}}))));
 const controller=new AutonomousController(store,new AutonomousLoop(store,{validate:async()=>{},plan:async()=>[],execute:async()=>{effects++;throw new Error('No external effects expected');},reconcile:async()=>null,evaluate:async job=>({complete:true,feedback:'Fixture answer for '+job.tenant})}),tenants,{program:'C'.repeat(32),genesis:'D'.repeat(32)});
 const server=await createPublicApiServer(controller,{port:0,bind:'127.0.0.1',origin:'https://api.agentos.test',browserOrigins:['https://app.agentos.test'],cert,key});server.listen(0,'127.0.0.1');await once(server,'listening');const listener=server.address();assert.ok(listener&&typeof listener!=='string');
 const connectionPort=listener.port;
 function call(path:string,options:{token?:string;method?:string;headers?:Record<string,string|string[]>;body?:string;trusted?:boolean}={}){
  return new Promise<{status:number;headers:any;body:string}>((resolve,reject)=>{const req=httpsRequest({hostname:'127.0.0.1',port:connectionPort,servername:'api.agentos.test',...(options.trusted===false?{}:{ca}),path,method:options.method||'GET',headers:{host:'api.agentos.test',...(options.token?{authorization:'Bearer '+options.token}:{}),...options.headers}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(options.body);});
 }
 try{
  await assert.rejects(()=>call('/api/autonomous/scope',{trusted:false}));
  assert.equal((await call('/api/autonomous/scope')).status,401);assert.equal((await call('/api/autonomous/scope',{token:tokenA,headers:{host:'evil.test'}})).status,421);
  assert.equal((await call('/api/autonomous/scope',{headers:{authorization:['Bearer '+tokenA,'Bearer '+tokenB]}})).status,400);
  assert.equal((await call('/api/autonomous/scope',{token:tokenA,headers:{'content-length':'2'},body:'{}'})).status,400);
  assert.equal((await call('/api/autonomous/scope',{token:tokenA,headers:{origin:'https://evil.test'}})).status,403);
  const scope=await call('/api/autonomous/scope',{token:tokenA,headers:{origin:'https://app.agentos.test'}});assert.equal(scope.status,200);assert.equal(JSON.parse(scope.body).tenant,'owner_a');assert.equal(scope.headers['access-control-allow-origin'],'https://app.agentos.test');assert.equal(scope.headers['cache-control'],'no-store');assert.ok(!scope.body.includes(tokenA));
  const preflight=await call('/api/autonomous/jobs',{method:'OPTIONS',headers:{origin:'https://app.agentos.test','access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});assert.equal(preflight.status,204);
  assert.equal((await call('/api/autonomous/jobs',{method:'OPTIONS',headers:{origin:'https://app.agentos.test','access-control-request-method':'DELETE'}})).status,403);
  for(const path of ['/mcp','/api/run','/api/memory','/api/health','/identity','/execute','/api/autonomous/../memory','/api/autonomous/%2e%2e/run','/api/autonomous/scope?token=secret','//api/autonomous/scope'])assert.equal((await call(path,{token:tokenA})).status,404,path);
  assert.equal((await call('/api/autonomous/jobs',{token:tokenA,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({goal:'Outside budget',limits:{sol:'1'}})})).status,422);
  assert.equal((await call('/api/autonomous/jobs',{token:tokenA,method:'POST',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await call('/api/autonomous/jobs',{token:tokenA,method:'POST',headers:{'content-type':'application/json'},body:'{"goal":"'+ 'x'.repeat(21000)+'"}'})).status,413);
  assert.equal((await call('/api/autonomous/jobs',{token:tokenA,method:'POST',headers:{'content-type':'application/json','transfer-encoding':'chunked'},body:'{"goal":"'+ 'x'.repeat(21000)+'"}'})).status,413);
  assert.equal((await call('/api/autonomous/jobs',{token:tokenA,method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:'{}'})).status,415);
  const created=await call('/api/autonomous/jobs',{token:tokenA,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({goal:'Owner A public fixture'})});assert.equal(created.status,202);const id=JSON.parse(created.body).job.id;await controller.idle();
  const completed=JSON.parse((await call('/api/autonomous/jobs/'+id,{token:tokenA})).body).job;assert.equal(completed.state,'completed');assert.equal(completed.answer,'Fixture answer for owner_a');
  assert.equal((await call('/api/autonomous/jobs/'+id,{token:tokenB})).status,422);assert.deepEqual(JSON.parse((await call('/api/autonomous/jobs',{token:tokenB})).body).jobs,[]);
  assert.deepEqual(JSON.parse((await call('/api/autonomous/events',{token:tokenB})).body).events,[]);assert.deepEqual(JSON.parse((await call('/api/autonomous/notifications',{token:tokenB})).body).deliveries,[]);
  assert.equal((await call('/api/autonomous/jobs/'+id+'/resume',{token:tokenB,method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,422);
  // Forwarded headers are not identity or origin authority.
  for(let n=0;n<65;n++){const response=await call('/api/autonomous/scope',{headers:{'x-forwarded-for':'192.0.2.'+n,'x-forwarded-host':'api.agentos.test'}});if(n===64)assert.equal(response.status,429);}
  assert.equal((await call('/api/autonomous/scope',{token:tokenB})).status,200);assert.equal(effects,0);
  if(process.env.AGENTOS_PUBLIC_ACCEPTANCE_EVIDENCE){const directory=resolve(process.env.AGENTOS_PUBLIC_ACCEPTANCE_EVIDENCE);await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify({status:'passed',transport:'actual TLS with explicit fixture CA and verified DNS identity',tenantCount:2,jobState:completed.state,externalEffects:effects,modelRequests:'local adapter only',transactions:0,checks:['untrusted certificate rejected','authenticated own scope and job','cross-tenant job/list/event/notification/resume isolation','fixed browser CORS and preflight','local preview and signing routes excluded','normalized/encoded path and token query rejected','budget widening and oversized bodies rejected','unauthenticated rate limit cannot be evaded with forwarded headers'],limitations:['Local dedicated-server acceptance, not public-domain deployment or distributed coordination.','Transport test certificate is generated in a temporary private directory and removed.']},null,2)+'\n');}
 }finally{await controller.idle();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await rm(root,{recursive:true,force:true});}
});
