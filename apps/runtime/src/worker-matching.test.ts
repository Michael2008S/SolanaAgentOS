import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesWorker, parseWorkerSearch, workerSearchSchema } from './worker-matching.js';
import type { WorkerProfile } from './worker-profiles.js';
const worker = { address: 'worker', owner: '11111111111111111111111111111111', name: 'Research', active: true,
  profile: { payload: { profile: { description:'Public facts',tags:['Research'],languages:['中文','English'],models:['DeepSeek'],availability:'available',minimumSol:'9007199254740993',minimumUsdc:'1000' } } } as WorkerProfile,
  recentReputation: { quality: 85, confidence: 0.7 } };
test('matches verified claims conjunctively, with exact u64 prices and normalized labels', () => {
  const filters=workerSearchSchema.parse({language:' english ',model:'ＤｅｅｐＳｅｅｋ',tag:'research',available:true,asset:'USDC',maxAmount:'1000',minimumQuality:85,minimumConfidence:0.7});
  assert.equal(matchesWorker(worker,filters),true);
  for(const change of [{language:'Spanish'},{model:'Other'},{tag:'search'},{maxAmount:'999'},{minimumQuality:86},{minimumConfidence:0.71},{employerOwner:worker.owner}]) assert.equal(matchesWorker(worker,{...filters,...change}),false);
  assert.equal(matchesWorker(worker,{asset:'SOL',maxAmount:'9007199254740992'}),false);
  assert.equal(matchesWorker(worker,{asset:'SOL',maxAmount:'9007199254740993'}),true);
  assert.equal(matchesWorker(worker,{query:'deepseek'}),true);
});
test('absent, quarantined or expired profiles cannot meet capability, price or availability requirements',()=>{
  const absent={...worker,profile:null};
  assert.equal(matchesWorker(absent,{}),true);
  for(const filter of [{language:'English'},{model:'DeepSeek'},{tag:'Research'},{asset:'SOL' as const,maxAmount:'18446744073709551615'},{available:true}]) assert.equal(matchesWorker(absent,filter),false);
  assert.equal(matchesWorker({...worker,active:false},{available:true}),false);
  assert.equal(matchesWorker({...worker,recentReputation:{quality:null,confidence:0}},{minimumQuality:0}),false);
});
test('HTTP and MCP validation reject weakened, malformed and duplicate requirements',()=>{
  assert.deepEqual(parseWorkerSearch(new URLSearchParams('q=facts&language=English&asset=USDC&maxAmount=1000&minimumConfidence=0.7&available=true')),
    {query:'facts',language:'English',asset:'USDC',maxAmount:'1000',minimumConfidence:0.7,available:true});
  for(const params of ['asset=SOL','maxAmount=0','asset=SOL&maxAmount=18446744073709551616','asset=SOL&maxAmount=01','asset=USDC&maxAmount=0.1','language=','available=1','minimumConfidence=1.1','minimumQuality=NaN','minimumQuality=','tag=a&tag=b','unknown=x','employerOwner=bad']) assert.throws(()=>parseWorkerSearch(new URLSearchParams(params)),params);
  for(const params of [{asset:'SOL'},{maxAmount:'0'},{minimumConfidence:NaN},{minimumQuality:101},{minimumQuality:null},{extra:true}]) assert.equal(workerSearchSchema.safeParse(params).success,false);
});
