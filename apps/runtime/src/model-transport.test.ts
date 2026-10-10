import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchModelResponse } from './model-transport.js';
test('local fixture transport isolates network and never forwards a real API secret', async () => {
 const previous={cluster:process.env.AGENTOS_CLUSTER,genesis:process.env.AGENTOS_LOCALNET_GENESIS_HASH,url:process.env.AGENTOS_LOCAL_MODEL_URL};
 const fetch=globalThis.fetch;const calls:{url:string;authorization:string|null}[]=[];
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),authorization:new Headers(init?.headers).get('authorization')});return new Response('{}');};
 try {
  process.env.AGENTOS_CLUSTER='localnet';process.env.AGENTOS_LOCALNET_GENESIS_HASH='11111111111111111111111111111111';process.env.AGENTOS_LOCAL_MODEL_URL='http://127.0.0.1:19789/v1/responses';
  await fetchModelResponse({method:'POST',headers:{Authorization:'Bearer example-secret'},body:'{}'});
  assert.equal(calls[0].authorization,'Bearer local-test-fixture');assert.equal(calls[0].url,process.env.AGENTOS_LOCAL_MODEL_URL);
  process.env.AGENTOS_CLUSTER='devnet';await assert.rejects(()=>fetchModelResponse({}),/require localnet/);
  process.env.AGENTOS_CLUSTER='localnet';
  for(const url of ['https://example.com/v1/responses','http://user:pass@localhost/v1/responses','http://localhost/#fragment']){process.env.AGENTOS_LOCAL_MODEL_URL=url;await assert.rejects(()=>fetchModelResponse({}));}
  assert.equal(calls.length,1);
  delete process.env.AGENTOS_LOCAL_MODEL_URL;await fetchModelResponse({headers:{Authorization:'Bearer example-secret'}});assert.equal(calls[1].url,'https://api.openai.com/v1/responses');assert.equal(calls[1].authorization,'Bearer example-secret');
 }finally{
  globalThis.fetch=fetch;
  for(const [key,value] of [['AGENTOS_CLUSTER',previous.cluster],['AGENTOS_LOCALNET_GENESIS_HASH',previous.genesis],['AGENTOS_LOCAL_MODEL_URL',previous.url]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}
 }
});
