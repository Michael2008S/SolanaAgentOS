import assert from 'node:assert/strict';
import { spawn,type ChildProcess } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomBytes,createHash,randomUUID } from 'node:crypto';
import { getAddressDecoder } from '@solana/kit';
import { RemoteAutonomousStore } from '../../apps/runtime/src/remote-autonomous-store.js';
import { AutonomousLoop,type AutonomousJob } from '../../apps/runtime/src/autonomous-loop.js';
if(!process.argv.includes('--run'))throw new Error('Run explicitly with --run. Loopback protocol fixture only; no model or transaction requests.');
const port=19791,endpoint='http://127.0.0.1:'+port,dir=await mkdtemp(join(tmpdir(),'agentos-central-flow-'));
const evidence=resolve('docs/evidence/autonomous-coordinator-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(evidence,{recursive:true});
const pub=()=>getAddressDecoder().decode(randomBytes(32)),token=randomBytes(32).toString('base64url'),input={tenant:'owner',goal:'Collect public fixture evidence',agent:pub(),session:pub(),program:pub(),genesis:pub(),limits:{sol:'1',usdc:'0',maxCycles:2,maxActions:2,maxModelRequests:4,deadline:Math.floor(Date.now()/1000)+600,tools:['research']}};
const profile={tenant:input.tenant,agent:input.agent,session:input.session,tokenSha256:createHash('sha256').update(randomBytes(32)).digest('hex'),maxDurationSeconds:600,limits:{...input.limits,deadline:undefined}};
let child:ChildProcess|undefined;const pids:number[]=[],snapshots:AutonomousJob[]=[];
async function start(){
 let ready=false,error='';child=spawn(process.execPath,['--import','tsx','apps/runtime/src/autonomous-coordinator-server.ts'],{cwd:process.cwd(),env:{...process.env,AGENTOS_COORDINATOR_TOKEN:token,AGENTOS_AUTONOMOUS_TENANTS:JSON.stringify([profile]),AGENTOS_PROGRAM_ID:input.program,AGENTOS_COORDINATOR_GENESIS:input.genesis,AGENTOS_COORDINATOR_PORT:String(port),AGENTOS_AUTONOMOUS_DATABASE_PATH:join(dir,'central.sqlite'),AGENTOS_AUTONOMOUS_NOTIFICATIONS:'[]'},stdio:['ignore','pipe','pipe']});
 child.stdout?.on('data',data=>{if(String(data).includes('listening on loopback'))ready=true;});child.stderr?.on('data',data=>{error+=String(data);});
 for(let i=0;i<100&&!ready;i++){if(child.exitCode!==null)throw new Error('Coordinator startup failed: '+error.slice(0,1000));await new Promise(r=>setTimeout(r,100));}assert.ok(ready);pids.push(child.pid!);
}
async function kill(signal:NodeJS.Signals){if(!child)return;if(child.exitCode!==null||child.signalCode!==null){child=undefined;return;}const current=child;const exit=new Promise<void>(r=>current.once('exit',()=>r()));current.kill(signal);await exit;child=undefined;}
try{
 // Preflight: never stop or reuse an unknown process already at the fixture port.
 try{await fetch(endpoint,{signal:AbortSignal.timeout(1000)});throw new Error('Fixture port already in use.');}catch(cause){if(cause instanceof Error&&cause.message==='Fixture port already in use.')throw cause;}
 await start();const a=new RemoteAutonomousStore(endpoint,token),b=new RemoteAutonomousStore(endpoint,token);
 const unauthorized=await fetch(endpoint+'/coordination',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401);
 const job=await new AutonomousLoop(a,{validate:async()=>{}} as any).create(input),releaseA=await a.acquire(job.tenant,job.id);await a.load(job.tenant,job.id);
 const intent={id:randomUUID(),phase:'reserved' as const,cycle:1,executionId:'8',action:{key:'original',tool:'research',input:'Public fixture query',asset:'SOL' as const,amount:'1'}};
 const reserved:AutonomousJob={...job,state:'executing',cycle:1,modelRequests:1,spent:{sol:'1',usdc:'0'},intents:[intent]};await a.save(reserved);snapshots.push(await b.load(job.tenant,job.id));
 await assert.rejects(()=>b.acquire(job.tenant,job.id),/already running/);
 await kill('SIGKILL');await start();await assert.rejects(()=>a.save({...reserved,modelRequests:2}),/422/);await assert.rejects(()=>releaseA(),/422/);
 let executions=0,reconciliations=0,modelCalls=0;
 const output='Original fixture result',receipt={id:'fixture:'+intent.id,output,outputHash:createHash('sha256').update(output).digest('hex'),verified:true as const};
 const loop=new AutonomousLoop(b,{validate:async()=>{},plan:async()=>{modelCalls++;throw new Error('Original plan must not run again.');},execute:async()=>{executions++;throw new Error('Original tool must not execute again.');},reconcile:async(_job,id)=>{assert.equal(id,intent.id);reconciliations++;return receipt;},evaluate:async()=>{modelCalls++;return {complete:true,feedback:'Original evidence collected'};}});
 const complete=await loop.run(job.tenant,job.id);assert.equal(complete.state,'completed');assert.equal(complete.spent.sol,'1');assert.equal(complete.modelRequests,2);assert.equal(complete.intents[0].id,intent.id);assert.equal(executions,0);assert.equal(reconciliations,1);assert.equal(modelCalls,1);snapshots.push(complete);
 await kill('SIGTERM');await start();assert.equal((await b.load(job.tenant,job.id)).state,'completed');await loop.run(job.tenant,job.id);assert.equal(modelCalls,1);
 const report={status:'passed',fixture:'central HTTP process restart and remote store clients',chainRpcRequests:0,transactionRequests:0,realModelRequests:0,pids,executionsAfterRestart:executions,reconciliations,localEvaluationCalls:modelCalls,unauthenticatedStatus:unauthorized.status,oldLeaseWriteRejected:true,originalIntentPreserved:true,grossBudgetPreserved:true,completedRestartNoReplay:true,snapshots,limitations:['Clients ran on one host; no production HTTPS proxy or multi-host deployment was exercised.','Original provider receipt uses a fixture adapter; shared MCP recovery has separate Localnet acceptance.']};
 await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:'passed',evidence}));
}catch(cause){await writeFile(join(evidence,'report.json'),JSON.stringify({status:'failed',message:cause instanceof Error?cause.message:'Fixture failed',pids,snapshots},null,2)+'\n');throw cause;}
finally{await kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
