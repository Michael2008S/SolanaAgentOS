import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { RemoteMcp } from './remote-mcp.js';
import { mcpExecutionScope } from './mcp-execution-scope.js';
import type { AutonomousJob } from './autonomous-loop.js';
const token='shared-mcp-test-credential-20261010';
function fixture(){const intentId=randomUUID(),action={key:'original',tool:'mcp:public:lookup',input:'{"query":"public"}',asset:'SOL' as const,amount:'0'},job={version:1,id:randomUUID(),tenant:'owner',agent:'A'.repeat(32),session:'B'.repeat(32),program:'C'.repeat(32),genesis:'D'.repeat(32),goal:'Public test',state:'executing',limits:{sol:'0',usdc:'0',tools:[action.tool],maxActions:1,maxCycles:1,maxModelRequests:2,deadline:Math.floor(Date.now()/1000)+600},spent:{sol:'0',usdc:'0'},cycle:1,modelRequests:1,intents:[{id:intentId,action,phase:'reserved'}],pending:[],evaluations:[]} as AutonomousJob;
 const output=JSON.stringify({source:action.tool,assurance:'authenticated-mcp-response',result:{content:[{type:'text',text:'Public result'}]}}),receipt={id:'mcp:'+intentId,output,outputHash:createHash('sha256').update(output).digest('hex'),verified:true as const};return {job,action,intentId,receipt,scopeHash:mcpExecutionScope(job,action)};}
test('remote MCP pins its credential origin and recovers using a read-only original-scope request',async()=>{
 const f=fixture(),routes:string[]=[];const client=new RemoteMcp('https://gateway.example.com',token,async(url,init)=>{routes.push(String(url));assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+token);if(String(url).endsWith('/catalog'))return Response.json([{id:f.action.tool,description:'Public tool',prices:{SOL:'0',USDC:'0'}}]);const input=JSON.parse(String(init?.body));assert.equal(input.intentId,f.intentId);assert.equal(input.job.answer,undefined);return Response.json({scopeHash:f.scopeHash,receipt:f.receipt});});
 assert.equal((await client.catalog())[0].id,f.action.tool);assert.deepEqual(await client.execute(f.job,f.action,f.intentId),f.receipt);assert.deepEqual(await client.reconcile({...f.job,state:'cancelled'},f.intentId),f.receipt);assert.deepEqual(routes,['https://gateway.example.com/mcp/catalog','https://gateway.example.com/mcp/execute','https://gateway.example.com/mcp/reconcile']);
 for(const endpoint of ['http://remote.example.com','https://user:pass@example.com','https://example.com/path','https://example.com/?credential=1'])assert.throws(()=>new RemoteMcp(endpoint,token));assert.throws(()=>new RemoteMcp('https://gateway.example.com','short'));
});
test('wrong intent, scope, output hash, assurance and protected credential echoes cannot become verified MCP evidence',async()=>{
 const f=fixture(),hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 for(const value of [{scopeHash:'0'.repeat(64),receipt:f.receipt},{scopeHash:f.scopeHash,receipt:{...f.receipt,id:'mcp:'+randomUUID()}},{scopeHash:f.scopeHash,receipt:{...f.receipt,outputHash:'0'.repeat(64)}},...['wrong-source','wrong-assurance','wrong-outcome'].map(mode=>{const output=JSON.stringify({source:mode==='wrong-source'?'mcp:other:tool':f.action.tool,assurance:mode==='wrong-assurance'?'untrusted':'authenticated-mcp-response',result:{isError:mode==='wrong-outcome',content:[]}});return {scopeHash:f.scopeHash,receipt:{...f.receipt,output,outputHash:hash(output)}};})])await assert.rejects(new RemoteMcp('https://gateway.example.com',token,async()=>Response.json(value)).reconcile(f.job,f.intentId));
 await assert.rejects(new RemoteMcp('https://gateway.example.com',token,async()=>new Response(token,{status:500})).execute(f.job,f.action,f.intentId),/HTTP 500/);
 await assert.rejects(new RemoteMcp('https://gateway.example.com',token,async()=>Response.json({error:token})).reconcile(f.job,f.intentId),/credential/);
 const unknown=new RemoteMcp('https://gateway.example.com',token,async()=>Response.json({scopeHash:f.scopeHash,receipt:null}));assert.equal(await unknown.reconcile(f.job,f.intentId),null);await assert.rejects(unknown.execute(f.job,f.action,f.intentId),/unavailable/);
});

test('caller mutation while awaiting the service cannot replace the originally transmitted budget scope',async()=>{
 const f=fixture(),client=new RemoteMcp('https://gateway.example.com',token,async(_url,init)=>{const original=JSON.parse(String(init?.body));assert.equal(original.job.limits.maxModelRequests,2);f.job.limits.maxModelRequests=1;return Response.json({scopeHash:mcpExecutionScope(f.job,f.action),receipt:f.receipt});});
 await assert.rejects(client.reconcile(f.job,f.intentId),/another authorization scope/);
});

test('JSON-escaped gateway credentials cannot be returned through catalogs or nested receipt content',async()=>{
 const f=fixture(),escaped=[...token].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 const catalog='[{"id":"'+f.action.tool+'","description":"'+escaped+'","prices":{"SOL":"0","USDC":"0"}}]';
 await assert.rejects(new RemoteMcp('https://gateway.example.com',token,async()=>new Response(catalog)).catalog(),/credential/);
 const output='{"source":"'+f.action.tool+'","assurance":"authenticated-mcp-response","result":{"content":[{"type":"text","text":"'+escaped+'"}]}}',receipt={...f.receipt,output,outputHash:createHash('sha256').update(output).digest('hex')};
 await assert.rejects(new RemoteMcp('https://gateway.example.com',token,async()=>Response.json({scopeHash:f.scopeHash,receipt})).reconcile(f.job,f.intentId),/credential/);
});
