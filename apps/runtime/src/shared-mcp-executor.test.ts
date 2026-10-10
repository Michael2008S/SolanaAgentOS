import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SharedMcpExecutor } from './shared-mcp-executor.js';
import type { ExternalMcp } from './external-mcp.js';
import type { AutonomousJob } from './autonomous-loop.js';
import type { AutonomousTenant } from './autonomous-controller.js';
function fixture(){const action={tool:'mcp:public:lookup',input:'{}',key:'original',asset:'SOL' as const,amount:'0'},intentId=randomUUID(),tenant:AutonomousTenant={tenant:'owner',tokenSha256:'0'.repeat(64),agent:'A'.repeat(32),session:'B'.repeat(32),maxDurationSeconds:600,limits:{sol:'0',usdc:'0',maxCycles:1,maxActions:1,maxModelRequests:2,tools:[action.tool]}},job:AutonomousJob={version:1,id:randomUUID(),tenant:tenant.tenant,agent:tenant.agent,session:tenant.session,program:'C'.repeat(32),genesis:'D'.repeat(32),goal:'Public fact',state:'executing',cycle:1,modelRequests:1,limits:{...tenant.limits,deadline:Math.floor(Date.now()/1000)+600},spent:{sol:'0',usdc:'0'},pending:[],evaluations:[],intents:[{id:intentId,action,phase:'reserved'}]};return {tenant,job,intentId};}
test('shared MCP coalesces identical pending requests and rejects scope changes before another dispatch',async()=>{
 const f=fixture();let unlock!:()=>void,validations=0,calls=0;const held=new Promise<void>(resolve=>{unlock=resolve;}),receipt={id:'mcp:'+f.intentId,output:'original',outputHash:'a'.repeat(64),verified:true as const};
 const client={catalog:async()=>[],execute:async(...[job,action,intentId,validate]:Parameters<ExternalMcp['execute']>)=>{await validate!(job,action,intentId);calls++;return receipt;},reconcile:async()=>receipt} as unknown as ExternalMcp;
 const executor=new SharedMcpExecutor(client,[f.tenant],{program:f.job.program,genesis:f.job.genesis},async()=>{validations++;await held;});
 const first=executor.execute(f.job,f.intentId),second=executor.execute(structuredClone(f.job),f.intentId);
 await assert.rejects(executor.execute({...f.job,limits:{...f.job.limits,maxModelRequests:1}},f.intentId),/cannot change/);assert.equal(validations,1);assert.equal(calls,0);unlock();assert.deepEqual(await first,await second);assert.equal(calls,1);
 assert.equal((await executor.reconcile({...f.job,state:'cancelled'},f.intentId)).receipt,receipt);assert.equal(validations,1);
});
test('shared MCP rejects another delegation, budget, paid action or unreserved dispatch',async()=>{
 const f=fixture();let calls=0;const executor=new SharedMcpExecutor({catalog:async()=>[],execute:async()=>{calls++;},reconcile:async()=>null} as unknown as ExternalMcp,[f.tenant],{program:f.job.program,genesis:f.job.genesis},async()=>{calls++;});
 for(const changed of [{tenant:'other'},{agent:'E'.repeat(32)},{session:'F'.repeat(32)},{genesis:'G'.repeat(32)},{limits:{...f.job.limits,sol:'1'}},{state:'cancelled' as const},{intents:[{...f.job.intents[0],phase:'complete' as const}]},{intents:[{...f.job.intents[0],action:{...f.job.intents[0].action,amount:'1'}}]}])await assert.rejects(executor.execute({...f.job,...changed},f.intentId));assert.equal(calls,0);
});
