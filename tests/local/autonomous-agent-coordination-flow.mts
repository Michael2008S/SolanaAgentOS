import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalHarness,digest,hex } from './harness.mts';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
if(process.argv.length!==3||process.argv[2]!=='--run')throw new Error('Use --run for isolated two-Runtime Agent coordination acceptance; two preparation transactions and no real-model requests.');
const h=new LocalHarness(),directory=resolve('docs/evidence/autonomous-agent-coordination-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory);
const quota=resolve('docs/evidence/deepseek-goal-20261009-quota.json'),beforeQuota=await readFile(quota,'utf8');
const report:any={status:'running',network:'isolated-localnet',model:'local-protocol-fixture',limitations:['Two processes on one central host and database; does not establish cross-host distributed coordination.','No paid tools exercised; original in-flight effect exclusion is verified separately in storage tests.'],modelCalls:[],transactions:[]};
let release!:()=>void,firstStarted!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{firstStarted=resolve;});let calls=0,active=0,maxActive=0,sends=0;
const model=createServer(async(req,res)=>{try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const input=JSON.parse(Buffer.concat(chunks).toString());assert.equal(req.headers.authorization,'Bearer local-test-fixture');const context=JSON.parse(input.input[1].content),planning=input.text.format.name==='agentos_autonomous_plan';assert.ok(++calls<=4);active++;maxActive=Math.max(maxActive,active);report.modelCalls.push({goal:context.goal,phase:planning?'planning':'evaluating',cycle:context.cycle,activeAtDispatch:active,receivedAt:new Date().toISOString()});
 if(calls===1){firstStarted();await held;}
 const result=planning?{actions:[]}:{complete:true,feedback:'Local coordination fixture complete',answer:'Local fixture greeting for '+context.goal};res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]}));active--;
}catch(cause){report.modelError=cause instanceof Error?cause.message:String(cause);res.writeHead(500).end();}});
try{
 model.listen(0,'127.0.0.1');await once(model,'listening');const port=(model.address() as any).port;
 await h.start();h.approved=true;for(let n=0;n<150;n++){if(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32)break;if(n===149)throw new Error('Local validator did not reach its readiness slot');await new Promise(resolve=>setTimeout(resolve,200));}const rpc=h.rpc.bind(h);h.rpc=async(method,params=[])=>{if(method==='sendTransaction')assert.ok(++sends<=2);return rpc(method,params);};
 const {payer,session}=h.signers,init=await sdk.buildInitializeAgent(payer.address,'Shared Agent coordination',0.001,0.001,0.001,0.001,['api']);
 const delegated=await sdk.buildCreateSession(payer.address,init.accounts.agent,init.accounts.policy,session.address,BigInt(Math.floor(Date.now()/1000)+1800),0.001,0.001,0.001,0.001,['api']);
 await h.tx('initialize shared Agent',[init.instruction]);await h.tx('create shared API Session',[delegated.instruction]);
 const token='agent-coordination-local-device-token-20261010',profile={tenant:'owner',tokenSha256:hex(digest(token)),agent:init.accounts.agent,session:delegated.session,maxDurationSeconds:600,limits:{sol:'0',usdc:'0',maxCycles:1,maxActions:1,maxModelRequests:2,tools:['mcp:unused:tool']}};
 const database=join(h.root,'shared-autonomous.sqlite');Object.assign(process.env,{AGENTOS_AUTONOMOUS_TENANTS:JSON.stringify([profile]),AGENTOS_AUTONOMOUS_DATABASE_PATH:database,AGENTOS_LOCAL_MODEL_URL:`http://127.0.0.1:${port}/v1/responses`,AGENTOS_MODEL_PROVIDER:'openai',AGENTOS_EXTERNAL_MCP_SERVERS:'[]',AGENTOS_STANDARD_HTTP_TOOLS:'[]',AGENTOS_AUTONOMOUS_NOTIFICATIONS:'[]',AGENTOS_PUBLIC_PORT:'',AGENTOS_AUTONOMOUS_COMBINED_EVALUATION:'false'});
 const a=await h.runtime(),originA=h.runtimeUrl,originB='http://127.0.0.1:19788';
 const b=await h.launch('runtime-peer',process.execPath,['--import','tsx','apps/runtime/src/index.ts'],{PORT:'19788',AGENTOS_DATA_DIR:join(h.root,'runtime-peer-data'),AGENTOS_WEB_ORIGINS:'http://127.0.0.1:15173'});
 for(let n=0;n<100;n++){try{assert.equal((await (await fetch(originB+'/api/health')).json()).network,'localnet-preview');break;}catch(cause){if(b.exitCode!==null||n===99)throw cause;await new Promise(resolve=>setTimeout(resolve,200));}}
 assert.notEqual(a.pid,b.pid);report.runtimePids=[a.pid,b.pid];
 const call=async(origin:string,path:string,value?:unknown)=>{const response=await fetch(origin+'/api/autonomous/'+path,{...(value?{method:'POST',body:JSON.stringify(value)}:{}),headers:{authorization:'Bearer '+token,'content-type':'application/json'},signal:AbortSignal.timeout(10000)});const result=await response.json() as any;assert.equal(response.ok,true,JSON.stringify(result));return result;};
 const first=(await call(originA,'jobs',{goal:'First local greeting without invoking tools'})).job;
 await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('First model dispatch missing')),15000))]);
 const second=(await call(originB,'jobs',{goal:'Second local greeting without invoking tools'})).job;
 await new Promise(resolve=>setTimeout(resolve,1000));
 const blocked=await call(originB,'jobs/'+second.id),running=await call(originA,'jobs/'+first.id);
 assert.equal(blocked.error,undefined);assert.equal(blocked.job.state,'planning');assert.equal(blocked.job.cycle,0);assert.equal(blocked.job.modelRequests,0);assert.equal(calls,1);assert.equal(maxActive,1);assert.equal(running.job.modelRequests,1);
 report.contention={first:running.job,second:blocked.job,modelCalls:1,reportedFailure:false};release();
 let jobs:any[]=[];
 for(let n=0;n<150;n++){jobs=await Promise.all([call(originA,'jobs/'+first.id),call(originB,'jobs/'+second.id)]);assert.ok(jobs.every(item=>!item.error),JSON.stringify(jobs));if(jobs.every(item=>item.job.state==='completed'))break;await new Promise(resolve=>setTimeout(resolve,1000));}
 assert.ok(jobs.every(item=>item.job.state==='completed'),JSON.stringify(jobs));assert.equal(calls,4);assert.equal(maxActive,1);assert.equal(sends,2);
 assert.deepEqual(report.modelCalls.map((item:any)=>item.goal),[first.goal,first.goal,second.goal,second.goal]);
 const db=new DatabaseSync(database);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_leases').get()!.n,0);}finally{db.close();}
 await h.restartRuntime();assert.equal((await call(originA,'jobs/'+first.id)).job.state,'completed');assert.equal((await call(originA,'jobs/'+second.id)).job.state,'completed');assert.equal(calls,4);assert.equal(sends,2);assert.equal(await readFile(quota,'utf8'),beforeQuota);
 const agent=await h.data(init.accounts.agent);assert.equal(agent.readBigUInt64LE(113),0n);
 report.jobs=jobs.map(item=>item.job);report.identity={program:sdk.PROGRAM_ADDRESS,genesis:h.genesis,agent:profile.agent,session:profile.session};report.modelFixtureRequests=calls;report.maximumConcurrentModelCalls=maxActive;report.automaticRetryAfterAgentRelease=true;report.restartWithoutModelReplay=true;report.agentExecutionCounter='0';report.realModelQuotaUnchanged=true;
 report.status='passed';
}catch(cause){report.status='failed';report.error=cause instanceof Error?cause.message:String(cause);process.exitCode=1;
}finally{release();if(h.root){try{ for(const tx of h.transactions as any[]){for(let n=0;n<300;n++){const status=(await h.rpc('getSignatureStatuses',[[tx.signature],{searchTransactionHistory:true}])).value[0];if(status?.confirmationStatus==='finalized')break;await new Promise(resolve=>setTimeout(resolve,100));}const result=await h.rpc('getTransaction',[tx.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);assert.equal(result.meta.err,null);assert.ok(result.meta.fee<=10000);const raw=JSON.stringify({jsonrpc:'2.0',result},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,tx.signature+'.json'),raw);report.transactions.push({signature:tx.signature,sha256:hex(digest(raw)),slot:result.slot,fee:result.meta.fee});}
}catch(cause){report.captureError=cause instanceof Error?cause.message:String(cause);}}report.modelFixtureRequests=calls;report.maximumConcurrentModelCalls=maxActive;report.totalTransactions=sends;report.preparationAttempts=h.transactions;await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));if(h.root)await h.finish(report.status==='passed'?undefined:report.error);console.log(JSON.stringify({status:report.status,evidence:directory}));}
