import test from 'node:test';
import assert from 'node:assert/strict';
import { redactModelError } from './model-diagnostics.js';
import { fetchDeepseekResponse } from './deepseek-transport.js';

test('upstream errors retain actionable detail without configured credentials',async()=>{
 const oldFetch=globalThis.fetch;
 const previous={key:process.env.DEEPSEEK_API_KEY,budget:process.env.AGENTOS_MODEL_BUDGET_PATH,limit:process.env.AGENTOS_MODEL_REQUEST_LIMIT,diagnostics:process.env.AGENTOS_MODEL_DIAGNOSTICS_PATH};
 const secret='configured-credential-do-not-persist';process.env.DEEPSEEK_API_KEY=secret;delete process.env.AGENTOS_MODEL_BUDGET_PATH;delete process.env.AGENTOS_MODEL_REQUEST_LIMIT;delete process.env.AGENTOS_MODEL_DIAGNOSTICS_PATH;
 globalThis.fetch=async()=>Response.json({error:{message:'Insufficient balance; token '+secret}},{status:402});
 try {
  await assert.rejects(()=>fetchDeepseekResponse({method:'POST',body:JSON.stringify({model:'deepseek-flash',max_output_tokens:100,input:[{role:'user',content:'Public research'}]})}),error=>{assert.ok(error instanceof Error);assert.match(error.message,/HTTP 402: Insufficient balance/);assert.ok(!error.message.includes(secret));return true;});
  assert.equal(redactModelError('Bearer some-long-token sk-abcdefghijklmnop'),'Bearer [redacted] [redacted]');
 } finally {
  globalThis.fetch=oldFetch;
  for(const [name,value] of [['DEEPSEEK_API_KEY',previous.key],['AGENTOS_MODEL_BUDGET_PATH',previous.budget],['AGENTOS_MODEL_REQUEST_LIMIT',previous.limit],['AGENTOS_MODEL_DIAGNOSTICS_PATH',previous.diagnostics]]){if(value===undefined)delete process.env[name!];else process.env[name!]=value;}
 }
});
