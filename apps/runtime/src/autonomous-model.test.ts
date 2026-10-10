import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousModel } from './autonomous-model.js';
import type { AutonomousJob } from './autonomous-loop.js';
const job = {goal:'Find public evidence',cycle:2,limits:{tools:['skill'],sol:'8',usdc:'0'},spent:{sol:'3',usdc:'0'},evaluations:[{complete:false,feedback:'Need another source'}],intents:[]} as unknown as AutonomousJob;
const tools=[{id:'skill',description:'Untrusted title',prices:{SOL:'3',USDC:'0'}}];
const result=(value:unknown)=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}));
test('model replans from feedback and server-owned atomic prices; unauthorized choices fail',async()=>{
 const original=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='local-model-test';
 try{let value:unknown={actions:[{tool:'skill',input:'Another source',asset:'SOL'}]};const model=new AutonomousModel(async init=>{const body=JSON.parse(String(init.body));assert.equal(body.max_output_tokens,1200);assert.match(body.input[1].content,/Need another source/);assert.match(body.input[1].content,/grossReserved/);return result(value);});
 const actions=await model.plan(job,tools);assert.equal(actions[0].amount,'3');assert.equal(actions[0].key,(await model.plan(job,tools))[0].key);
 value={actions:[{tool:'unknown',input:'Query',asset:'SOL'}]};await assert.rejects(()=>model.plan(job,tools),/unauthorized/);
 value={actions:[{tool:'skill',input:'Query',asset:'USDC'}]};await assert.rejects(()=>model.plan(job,tools),/unsupported/);
 value={actions:[{tool:'skill',input:'Query',asset:'SOL',amount:'1'}]};await assert.rejects(()=>model.plan(job,tools));
 }finally{if(original===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=original;}
});
test('evaluation distinguishes missing evidence from a supported answer',async()=>{
 const original=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='local-model-test';
 try{let value={complete:false,feedback:'Need official source',answer:''};const model=new AutonomousModel(async()=>result(value));assert.deepEqual(await model.evaluate(job),{complete:false,feedback:'Need official source'});
 value={complete:true,feedback:'Enough evidence',answer:'Answer with receipt attribution'};assert.deepEqual(await model.evaluate(job),{complete:true,feedback:'Answer with receipt attribution'});
 value={complete:false,feedback:'Incomplete',answer:'Invented completion'};await assert.rejects(()=>model.evaluate(job),/contradicts/);
 value={complete:true,feedback:'Enough',answer:''};await assert.rejects(()=>model.evaluate(job),/contradicts/);
 }finally{if(original===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=original;}
});
test('listed free MCP tools use zero SOL reservations without opening a zero-price paid asset',async()=>{
 const original=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='local-model-test';
 try{
  const id='mcp:research:search',scope={...job,limits:{...job.limits,tools:[id]}};
  let asset='SOL';const model=new AutonomousModel(async()=>result({actions:[{tool:id,input:'{"query":"Public research"}',asset}]}));
  const catalog=[{id,description:'{"inputSchema":{"type":"object"}}',prices:{SOL:'0',USDC:'0'}}];
  assert.equal((await model.plan(scope,catalog))[0].amount,'0');
  asset='USDC';await assert.rejects(()=>model.plan(scope,catalog),/unsupported/);
 }finally{if(original===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=original;}
});
test('combined evaluation resolves next actions from current catalog and rejects invented permissions or completion with effects',async()=>{
 const original=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='local-model-test';
 try{
  let value:any={complete:false,feedback:'Need another source',answer:'',actions:[{tool:'skill',input:'Another query',asset:'SOL'}]};
  const model=new AutonomousModel(async init=>{const request=JSON.parse(String(init.body));assert.ok(request.text.format.schema.required.includes('actions'));assert.match(request.input[1].content,/Untrusted title/);return result(value);});
  const next=await model.evaluate(job,tools);assert.equal(next.nextPlan?.[0].amount,'3');
  value.actions[0].tool='unknown';await assert.rejects(model.evaluate(job,tools),/unauthorized/);
  value={complete:true,feedback:'Complete',answer:'Evidence-based answer',actions:[{tool:'skill',input:'Extra effect',asset:'SOL'}]};await assert.rejects(model.evaluate(job,tools),/schedule/);
  value.actions=[];assert.deepEqual(await model.evaluate(job,tools),{complete:true,feedback:'Evidence-based answer'});
 }finally{if(original===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=original;}
});

test('model receives explicit failed-tool status even when the original MCP error flag is beyond its excerpt',async()=>{
 const original=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='local-model-test';
 try{
  const receipt={id:'mcp:legacy',output:JSON.stringify({source:'mcp:public:lookup',assurance:'authenticated-mcp-response',result:{content:[{type:'text',text:'x'.repeat(3000)}],isError:true}}),outputHash:'a'.repeat(64),verified:true as const};
  const scope={...job,intents:[{id:'intent',phase:'complete' as const,action:{key:'first',tool:'skill',input:'query',asset:'SOL' as const,amount:'3'},receipt}]};
  const model=new AutonomousModel(async init=>{const body=JSON.parse(String(init.body)),context=JSON.parse(body.input[1].content);assert.equal(context.priorActions[0].outcome,'error');assert.equal(context.priorActions[0].truncated,true);assert.ok(!context.priorActions[0].excerpt.includes('isError'));assert.match(body.input[0].content,/not successful research/);return result({complete:false,feedback:'Need a successful source',answer:''});});
  assert.deepEqual(await model.evaluate(scope),{complete:false,feedback:'Need a successful source'});
 }finally{if(original===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=original;}
});
