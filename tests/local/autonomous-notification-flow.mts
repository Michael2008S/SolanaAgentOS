import assert from 'node:assert/strict';
import { createServer,type Server } from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { LocalHarness,digest,hex } from './harness.mts';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
if(process.argv.length!==3||process.argv[2]!=='--run')throw new Error('Use --run for isolated Runtime notification acceptance.');
const h=new LocalHarness(),servers:Server[]=[],directory=resolve('docs/evidence/autonomous-notifications-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory);
const report:any={status:'running',network:'isolated-localnet',scope:'Actual Runtime HTTP outbox delivery and restart after receiver acceptance; no paid tool or real model',transactions:[]};
const quotaPath=resolve('docs/evidence/deepseek-goal-20261009-quota.json'),quotaBefore=await readFile(quotaPath,'utf8'),secret='local-runtime-notification-acceptance-20261010',deviceToken='owner-notification-acceptance-token-20261010';
let sends=0,models=0,calls=0;const events:any[]=[],bodies:string[]=[],accepted=new Set<string>();let received!:()=>void;const firstReceived=new Promise<void>(resolve=>{received=resolve;});
async function body(req:AsyncIterable<unknown>){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));return Buffer.concat(chunks).toString();}
async function listen(server:Server){servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const listener=server.address();assert.ok(listener&&typeof listener!=='string');return listener.port;}
try{
 await h.start();h.approved=true;const original=h.rpc.bind(h);h.rpc=async(method,params=[])=>{if(method==='sendTransaction')assert.ok(++sends<=2);return original(method,params);};
 for(let n=0;n<150;n++){if(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32)break;await new Promise(resolve=>setTimeout(resolve,200));}
 const {payer,session}=h.signers,init=await sdk.buildInitializeAgent(payer.address,'Notification runtime acceptance',0.001,0.001,0.001,0.001,['api']),agent=init.accounts;
 const delegation=await sdk.buildCreateSession(payer.address,agent.agent,agent.policy,session.address,BigInt(Math.floor(Date.now()/1000)+1800),0.001,0.001,0.001,0.001,['api']);
 await h.tx('initialize API Agent',[init.instruction]);await h.tx('create API-only Session',[delegation.instruction]);
 const receiverPort=await listen(createServer(async(req,res)=>{try{
  const raw=await body(req),id=String(req.headers['x-agentos-event']),timestamp=String(req.headers['x-agentos-timestamp']);assert.equal(req.headers['idempotency-key'],id);assert.equal(req.headers['x-agentos-signature'],'v1='+createHmac('sha256',secret).update(timestamp+'.'+id+'.'+raw).digest('hex'));
  const event=JSON.parse(raw);assert.equal(event.id,id);assert.equal(event.tenant,'owner');assert.equal(event.state,'completed');assert.equal(event.goal,undefined);assert.equal(event.answer,undefined);assert.ok(!raw.includes(secret));
  calls++;events.push(event);bodies.push(raw);accepted.add(id);
  if(calls===1){received();return;} // Accepted effect, but acknowledgement is lost when Runtime stops.
  res.writeHead(204).end();
 }catch(cause){report.receiverError=cause instanceof Error?cause.message:'Failed';res.writeHead(422).end();}}));
 const modelPort=await listen(createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer local-test-fixture');const request=JSON.parse(await body(req));models++;const result=request.text.format.name==='agentos_autonomous_plan'?{actions:[]}:{complete:true,feedback:'Simple arithmetic requires no external tool.',answer:'LOCAL FIXTURE: 2 + 2 = 4.'};res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]}));}));
 const profile={tenant:'owner',tokenSha256:hex(digest(deviceToken)),agent:agent.agent,session:delegation.session,maxDurationSeconds:600,limits:{sol:'0',usdc:'0',maxCycles:1,maxActions:1,maxModelRequests:2,tools:['mcp:fixture:unused']}};
 Object.assign(process.env,{AGENTOS_AUTONOMOUS_TENANTS:JSON.stringify([profile]),AGENTOS_AUTONOMOUS_DATABASE_PATH:join(h.root,'notification-autonomous.sqlite'),AGENTOS_AUTONOMOUS_NOTIFICATIONS:JSON.stringify([{tenant:'owner',endpoint:`http://127.0.0.1:${receiverPort}/events`,secretEnv:'FIXTURE_NOTIFY_SECRET'}]),FIXTURE_NOTIFY_SECRET:secret,AGENTOS_LOCAL_MODEL_URL:`http://127.0.0.1:${modelPort}/v1/responses`,AGENTOS_EXECUTION_GATEWAY:'',AGENTOS_EXTERNAL_MCP_SERVERS:'[]',AGENTOS_STANDARD_HTTP_TOOLS:'[]'});
 await h.runtime();const call=async(path:string,value?:unknown,token=deviceToken)=>{const response=await fetch(h.runtimeUrl+'/api/autonomous/'+path,{...(value?{method:'POST',body:JSON.stringify(value)}:{}),headers:{authorization:'Bearer '+token,'content-type':'application/json'}});return {status:response.status,payload:await response.json() as any};};
 const created=await call('jobs',{goal:'Answer the public arithmetic expression 2 + 2.'});assert.equal(created.status,202);
 // No browser, no polling client and no further model requests are needed for delivery.
 await Promise.race([firstReceived,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Original notification was not received.')),20000).unref())]);
 assert.equal(models,2);assert.equal(calls,1);assert.equal(events[0].jobId,created.payload.job.id);await h.restartRuntime();
 for(let n=0;n<100&&calls<2;n++)await new Promise(resolve=>setTimeout(resolve,200));assert.equal(calls,2);assert.equal(bodies[0],bodies[1]);assert.equal(accepted.size,1);
 let status:any;for(let n=0;n<30;n++){status=await call('notifications');if(status.payload.deliveries?.[0]?.status==='sent')break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(status.status,200);assert.equal(status.payload.deliveries[0].status,'sent');assert.equal(status.payload.deliveries[0].attempts,2);
 assert.equal((await call('notifications',undefined,'invalid-token')).status,401);
 await call('jobs/'+created.payload.job.id+'/resume',{});const completed=await call('jobs/'+created.payload.job.id);assert.equal(completed.payload.job.state,'completed');assert.equal(models,2);assert.equal(sends,2);assert.equal(await readFile(quotaPath,'utf8'),quotaBefore);
 await writeFile(join(directory,'notification-events.json'),JSON.stringify(events,null,2)+'\n');await writeFile(join(directory,'notification-status.json'),JSON.stringify(status.payload,null,2)+'\n');await writeFile(join(directory,'completed-job.json'),JSON.stringify(completed.payload.job,null,2)+'\n');
 Object.assign(report,{status:'passed',notificationHttpRequests:calls,receiverEffectsAfterDeduplication:accepted.size,modelFixtureRequests:models,realModelQuotaUnchanged:true,receiverAuthenticationVerified:true,originalEventPreserved:true,restartedAfterAcceptedBeforeAcknowledged:true,originalJobNotReexecuted:true,unauthenticatedStatusRejected:true});
}catch(cause){report.status='failed';report.error=cause instanceof Error?cause.message:'Failed';process.exitCode=1;
}finally{
 for(const item of h.transactions as {signature:string}[]){try{for(let n=0;n<200;n++){const status=(await h.rpc('getSignatureStatuses',[[item.signature],{searchTransactionHistory:true}])).value[0];if(status?.confirmationStatus==='finalized')break;await new Promise(resolve=>setTimeout(resolve,100));}const tx=await h.rpc('getTransaction',[item.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);assert.ok(tx);const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,item.signature+'.json'),raw);report.transactions.push({signature:item.signature,sha256:hex(digest(raw)),fee:tx.meta.fee});}catch{}}
 Object.assign(report,{totalTransactions:sends,modelFixtureRequests:models,notificationHttpRequests:calls});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}if(h.root)await h.finish(report.status==='passed'?undefined:'Runtime notification acceptance failed');console.log(JSON.stringify({status:report.status,evidence:directory}));
}
