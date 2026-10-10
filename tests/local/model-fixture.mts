import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
export async function startModelFixture(port = 19789, failJudgeRequests = false) {
 const requests: string[] = [];
 const inputs: Record<string, unknown>[] = [];
 const server=createServer(async(req,res)=>{
  try {
   assert.equal(req.url,'/v1/responses');assert.equal(req.headers.authorization,'Bearer local-test-fixture');
   let raw='';for await(const b of req){raw+=b.toString();assert.ok(raw.length<100000);}
   const body=JSON.parse(raw);const name=body.text?.format?.name;const user=JSON.parse(body.input.find((i:any)=>i.role==='user').content);requests.push(name);inputs.push(user);
   if(failJudgeRequests && name==='agentos_escrow_judgment'){res.writeHead(503).end('LOCAL TEST interrupted Judge model response');return;}
   let value:unknown;
   if(name==='agentos_task_plan') {
    if (typeof user.task === 'string' && user.task.startsWith('LOCAL TEST HIRE')) {
     const terms = /^LOCAL TEST HIRE ([1-9A-HJ-NP-Za-km-z]{32,44}) for ((?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?) (SOL|USDC) within ([1-9][0-9]{0,2})h$/.exec(user.task);
     assert.ok(terms, 'Local hire fixture requires exact explicit terms.');
     const [,workerAgent,amount,asset,hours] = terms;
     assert.ok(Number(amount)>0 && Number(hours)<=720, 'Invalid local hire amount or deadline.');
     assert.ok(user.registeredAgents.some((agent:any)=>agent.address===workerAgent), 'Local hire Worker is absent from the registered directory.');
     value={summary:'LOCAL TEST FIXTURE explicit Worker hire',actions:[{kind:'hire',label:'Local fixture Worker',amount:Number(amount),detail:'Deterministic local hire with exact supplied terms',skillId:'',asset,workerAgent,recipient:'',durationHours:Number(hours)}]};
    } else {const skill=user.registeredSkills[0];assert.ok(skill);value={summary:'LOCAL TEST FIXTURE planning',actions:[{kind:'api',label:'Local fixture Skill',amount:0,detail:'Deterministic protocol fixture',skillId:skill.address,asset:'SOL',workerAgent:'',recipient:'',durationHours:0}]};}
   }
   else if(name==='agentos_worker_draft') value=typeof user.task==='string'&&user.task.startsWith('LOCAL TEST AUTO ROLE:')?{status:'draft',result:'Solana uses accounts.',limitations:['Deterministic self-contained quotation fixture.'],evidenceUsed:[]}:user.task==='LOCAL TEST BACKGROUND WORKER: summarize supplied text.'?{status:'draft',result:'LOCAL TEST FIXTURE: Solana uses accounts.',limitations:['Deterministic fixture, not real model reasoning.'],evidenceUsed:['Solana uses accounts.']}:{status:'draft',result:'LOCAL TEST FIXTURE: task completed using the paid Skill evidence.',limitations:['Deterministic fixture, not real model reasoning.'],evidenceUsed:[]};
   else if(name==='agentos_escrow_judgment') {const verdict=user.task.includes('needs_review')?'needs_review':user.task.includes('fail')?'fail':'pass';value={verdict,confidence:1,summary:`LOCAL TEST FIXTURE ${verdict}`,checks:[{criterion:'Protocol fixture case',status:verdict==='pass'?'met':verdict==='fail'?'not_met':'unclear',evidence:user.workerResult.slice(0,60)}],limitations:['Fixture decision for protocol tests only.']};}
   else if(name==='agentos_final_response')value={answer:'LOCAL TEST FIXTURE final answer: '+user.providerResponses.map((r:any)=>r.content).join(' ')};
   else throw new Error(`Unsupported schema ${name}`);
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}));
  }catch(error){res.writeHead(500).end(String(error));}
 });server.listen(port,'127.0.0.1');await once(server,'listening');
 const listening = server.address();
 if (!listening || typeof listening === 'string') throw new Error('Local model fixture has no TCP port.');
 return {server,requests,inputs,url:`http://127.0.0.1:${listening.port}/v1/responses`};
}
