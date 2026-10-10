import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Runtime retains redacted parser diagnostics for a malformed successful model response',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agentos-model-diagnostics-'));
 const fixture=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'invalid-json-with-local-test-fixture'}]}]}));});
 fixture.listen(0,'127.0.0.1');await once(fixture,'listening');const address=fixture.address();assert.ok(address&&typeof address!=='string');
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const selected=reservation.address();assert.ok(selected&&typeof selected!=='string');await new Promise<void>(resolve=>reservation.close(()=>resolve()));
 const diagnostics=join(directory,'diagnostics.jsonl');
 const child=spawn(process.execPath,['--import','tsx','apps/runtime/src/index.ts'],{stdio:'ignore',env:{...process.env,PORT:String(selected.port),AGENTOS_CLUSTER:'localnet',AGENTOS_LOCALNET_GENESIS_HASH:'EhmZWnZngz2DsXT4d8ykg9sf1L5byYj7HfVnbPwrbK4v',AGENTOS_DATA_DIR:directory,AGENTOS_STORAGE_BACKEND:'json',AGENTOS_WORKER_AUTORUN:'',AGENTOS_PROGRAM_ID:'',AGENTOS_MODEL_PROVIDER:'openai',OPENAI_API_KEY:'local-test-fixture',OPENAI_MODEL:'local-test-fixture',DEEPSEEK_API_KEY:'',AGENTOS_MODEL_BUDGET_PATH:'',AGENTOS_MODEL_REQUEST_LIMIT:'',AGENTOS_MODEL_DIAGNOSTICS_PATH:diagnostics,AGENTOS_LOCAL_MODEL_URL:`http://127.0.0.1:${address.port}/v1/responses`,AGENTOS_SERVICE_CATALOG_URL:'',AGENTOS_PERSIST_MEMORY:'false',AGENTOS_PERSIST_HISTORY:'false',AGENTOS_PERSIST_ESCROW_HANDOFFS:'false'}});
 try{
  const url=`http://127.0.0.1:${selected.port}`;let ready=false;
  for(let n=0;n<100;n++){try{const response=await fetch(url+'/api/health',{signal:AbortSignal.timeout(500)});if(response.ok){ready=true;break;}}catch{}if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(ready,'Runtime did not start');
  const response=await fetch(url+'/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:'Public research question',skills:[]})});assert.equal(response.status,502);
  const result=await response.json();assert.match(result.error,/JSON/);assert.ok(!result.error.includes('local-test-fixture'));
  const saved=await readFile(diagnostics,'utf8');assert.ok(!saved.includes('local-test-fixture'));assert.equal(JSON.parse(saved.trim()).phase,'validation');
 }finally{child.kill('SIGTERM');if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,2000))]);if(child.exitCode===null)child.kill('SIGKILL');await new Promise<void>(resolve=>fixture.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
