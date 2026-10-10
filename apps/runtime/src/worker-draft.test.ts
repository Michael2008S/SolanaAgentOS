import test from 'node:test';
import assert from 'node:assert/strict';
import {generateWorkerDraft} from './worker-draft.js';
const good={status:'draft',result:'Processed may roll back. Excerpt only.',limitations:['Only supplied evidence.'],evidenceUsed:['Processed may roll back.']};
async function scenario(outputs: unknown[], execute: (calls: any[])=>Promise<void>){
 const original=globalThis.fetch, env={...process.env},calls:any[]=[];
 Object.assign(process.env,{OPENAI_API_KEY:'isolated-test-key',OPENAI_MODEL:'isolated-model',AGENTOS_MODEL_PROVIDER:'openai',AGENTOS_LOCAL_MODEL_URL:'',AGENTOS_MODEL_DIAGNOSTICS_PATH:''});
 globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));const output=outputs[calls.length-1];assert.notEqual(output,undefined,'No unbounded model retries.');return output instanceof Response?output:Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]});};
 try{await execute(calls);}finally{globalThis.fetch=original;process.env=env;}
}
test('Worker format correction is bounded and reuses original task/evidence before any delivery',async()=>{
 await scenario([{...good,result:'x'.repeat(401)},good],async calls=>{
  const result=await generateWorkerDraft('Summarize the source','Processed may roll back.');assert.equal(result.result,good.result);assert.equal(calls.length,2);
  const first=JSON.parse(calls[0].input[1].content),second=JSON.parse(calls[1].input[1].content);assert.equal(first.task,second.task);assert.equal(first.suppliedEvidence,second.suppliedEvidence);assert.match(second.formatCorrection,/SAME supplied evidence/);assert.equal(calls[1].text.format.schema.properties.result.maxLength,400);
 });
});
test('Worker still rejects invalid output after exactly two model attempts',async()=>{
 await scenario([{...good,result:'x'.repeat(401)},{...good,result:'x'.repeat(401)}],async calls=>{await assert.rejects(generateWorkerDraft('Summarize','Processed may roll back.'),/format validation/);assert.equal(calls.length,2);});
});
test('Worker correction preserves exact evidence quote validation',async()=>{
 await scenario([{...good,evidenceUsed:['Invented quote']},good],async calls=>{const result=await generateWorkerDraft('Summarize','Processed may roll back.');assert.deepEqual(result.evidenceUsed,good.evidenceUsed);assert.equal(calls.length,2);});
});
test('Worker does not retry HTTP failures as format correction',async()=>{
 await scenario([new Response('',{status:502})],async calls=>{await assert.rejects(generateWorkerDraft('Summarize','Processed may roll back.'),/502/);assert.equal(calls.length,1);});
});
