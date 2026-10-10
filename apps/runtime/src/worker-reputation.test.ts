import test from 'node:test';
import assert from 'node:assert/strict';
import type { JudgeDirectoryTask } from './judge-directory.js';
import { createWorkerReputationIndex,recentWorkerReputation } from './worker-reputation.js';
const now = 1791550000;
const agents = [{ address: 'worker', owner: 'w' }, { address: 'employer', owner: 'e' }, { address: 'judge', owner: 'j' }];
const outcome = (id: string, changes: Partial<JudgeDirectoryTask> = {}): JudgeDirectoryTask => ({ escrow: id, employer: 'employer', worker: 'worker', judge: 'judge',
  escrowStatus: 'released', resultHash: 'a'.repeat(64), decision: { address: id, verdict: 'pass', judgmentHash: 'b'.repeat(64), recordedAt: now - 10, settled: true }, ...changes } as JudgeDirectoryTask);
test('related Owners and ambiguous release/refund snapshots cannot earn reputation', () => {
  const related = [...agents, { address: 'same-owner-employer', owner: 'w' }, { address: 'same-owner-judge', owner: 'e' }];
  const rep = recentWorkerReputation('worker', related, [outcome('a', { employer: 'same-owner-employer' }), outcome('b', { judge: 'same-owner-judge' }), outcome('c', { decision: null })], now);
  assert.equal(rep.quality, null); assert.equal(rep.effectiveSamples, 0); assert.equal(rep.ignored['related-owner'], 2);
});
test('a burst cannot wash out a same-day failure, or evade the three-per-pair window cap', () => {
  const failure = outcome('fail', { escrowStatus: 'refunded', decision: { address: 'fail', verdict: 'fail', judgmentHash: 'b'.repeat(64), recordedAt: now - 20, settled: true } });
  const burst = Array.from({ length: 300 }, (_, n) => outcome(String(n)));
  const rep = recentWorkerReputation('worker', agents, [...burst, failure], now);
  assert.equal(rep.acceptedOutcomes, 1); assert.equal(rep.ignored['repeated-pair-day'], 300); assert.ok(rep.quality! < 60);
  const days = Array.from({ length: 10 }, (_, n) => outcome(String(n), { decision: { ...outcome('').decision!, recordedAt: now - n * 86400 - 100 } }));
  assert.equal(recentWorkerReputation('worker', agents, days, now).acceptedOutcomes, 3);
});
test('time decay and independent employers/judges affect confidence; reciprocal passes are discounted', () => {
  const fresh = recentWorkerReputation('worker', agents, [outcome('fresh')], now);
  const old = recentWorkerReputation('worker', agents, [outcome('old', { decision: { ...outcome('').decision!, recordedAt: now - 90 * 86400 } })], now);
  assert.ok(old.effectiveSamples < fresh.effectiveSamples); assert.ok(old.confidence < fresh.confidence);
  const reciprocal = recentWorkerReputation('worker', agents, [outcome('fresh'), outcome('reverse', { worker: 'employer', employer: 'worker' })], now);
  assert.ok(reciprocal.effectiveSamples <= 0.25); assert.ok(reciprocal.risks.includes('reciprocal-trading'));
  const manyAgents = [...agents, ...Array.from({ length: 10 }, (_, n) => ({ address: `e${n}`, owner: `eo${n}` })), ...Array.from({ length: 10 }, (_, n) => ({ address: `j${n}`, owner: `jo${n}` }))];
  const independent = recentWorkerReputation('worker', manyAgents, Array.from({ length: 10 }, (_, n) => outcome(String(n), { employer: `e${n}`, judge: `j${n}` })), now);
  assert.ok(independent.confidence > fresh.confidence); assert.equal(independent.independentEmployers, 10); assert.equal(independent.independentJudges, 10); assert.deepEqual(independent.risks, []);
});

test('three-party and long successful trade rings are discounted without discounting failures',()=>{
 const parties=[...agents,{address:'third',owner:'t'}];
 const ring=[outcome('a'),outcome('b',{employer:'worker',worker:'third'}),outcome('c',{employer:'third',worker:'employer'})];
 const scores=createWorkerReputationIndex(parties,ring,now);assert.equal(scores.evaluatedAt,now);
 for(const worker of ['worker','employer','third']){const rep=scores.score(worker);assert.ok(rep.effectiveSamples<=0.25);assert.ok(rep.risks.includes('circular-trading'));assert.equal(rep.acceptedOutcomes,1);}
 const failure=outcome('failure',{escrowStatus:'refunded',decision:{...outcome('').decision!,address:'failure',verdict:'fail'}});
 const failed=recentWorkerReputation('worker',parties,[...ring,failure],now);assert.equal(failed.effectiveSamples,1);assert.equal(failed.evidence[0].verdict,'fail');assert.equal(failed.risks.includes('circular-trading'),false);
 const size=12000,longAgents=[{address:'judge',owner:'judge-owner'},...Array.from({length:size},(_,n)=>({address:'a'+n,owner:'o'+n}))];
 const longRing=Array.from({length:size},(_,n)=>outcome('r'+n,{employer:'a'+n,worker:'a'+((n+1)%size)}));
 const longScore=createWorkerReputationIndex(longAgents,longRing,now).score('a1');assert.equal(longScore.effectiveSamples,0.25);assert.ok(longScore.risks.includes('circular-trading'));
});
test('unsettled, mismatched, related, future, old and failed reverse trades cannot create a collusion edge',()=>{
 const base=outcome('forward');
 const reverse=outcome('reverse',{worker:'employer',employer:'worker'});
 const invalid=[{...reverse,decision:null},{...reverse,escrowStatus:'refunded'},
  {...reverse,judge:'worker'}, {...reverse,decision:{...reverse.decision!,recordedAt:now+1}},
  {...reverse,decision:{...reverse.decision!,recordedAt:now-91*86400}},
  {...reverse,escrowStatus:'refunded',decision:{...reverse.decision!,verdict:'fail' as const}}];
 for(const task of invalid){const rep=recentWorkerReputation('worker',agents,[base,task],now);assert.equal(rep.effectiveSamples,1);assert.equal(rep.risks.includes('reciprocal-trading'),false);}
});
test('directed chains and shared counterparties are not mistaken for circular trades',()=>{
 const parties=[...agents,{address:'third',owner:'t'},{address:'fourth',owner:'f'}];
 const chain=[outcome('a'),outcome('b',{employer:'worker',worker:'third'}),outcome('c',{employer:'employer',worker:'third'}),outcome('d',{employer:'third',worker:'fourth'})];
 const rep=recentWorkerReputation('worker',parties,chain,now);assert.equal(rep.effectiveSamples,1);assert.equal(rep.risks.includes('circular-trading'),false);
 assert.deepEqual(createWorkerReputationIndex(parties,chain,now).score('worker'),rep);
 assert.deepEqual(recentWorkerReputation('worker',parties,[...chain].reverse(),now),rep);
});
test('rotating Employer and Judge Agents cannot amplify one Judge Owner positive reputation',()=>{
 const farmAgents=[...agents,...Array.from({length:60},(_,n)=>({address:'e'+n,owner:'employer-owner-'+n})),...Array.from({length:60},(_,n)=>({address:'j'+n,owner:'j'}))];
 const burst=Array.from({length:60},(_,n)=>outcome('burst-'+n,{employer:'e'+n,judge:'j'+n}));
 const sameDay=recentWorkerReputation('worker',farmAgents,burst,now);assert.equal(sameDay.acceptedOutcomes,1);assert.equal(sameDay.ignored['repeated-judge-day'],59);assert.ok(sameDay.risks.includes('concentrated-positive-judgments'));
 const days=burst.map((task,n)=>({...task,decision:{...task.decision!,recordedAt:now-(n%20)*86400-10}}));
 const capped=recentWorkerReputation('worker',farmAgents,days,now);assert.equal(capped.acceptedOutcomes,3);assert.ok(capped.ignored['repeated-judge-window']>0);assert.ok(capped.effectiveSamples<=3);
 assert.deepEqual(recentWorkerReputation('worker',farmAgents,[...days].reverse(),now),capped);
});
test('Judge positive caps preserve failures and allow independent Judges and later age buckets',()=>{
 const parties=[...agents,...Array.from({length:8},(_,n)=>({address:'e'+n,owner:'eo'+n})),{address:'independent',owner:'ji'}];
 const passes=Array.from({length:4},(_,n)=>outcome('pass-'+n,{employer:'e'+n,decision:{...outcome('').decision!,address:'pass-'+n,recordedAt:now-n*86400-10}}));
 const failures=Array.from({length:2},(_,n)=>outcome('fail-'+n,{employer:'e'+(n+4),escrowStatus:'refunded',decision:{...outcome('').decision!,address:'fail-'+n,verdict:'fail',recordedAt:now-10}}));
 const older=outcome('older',{employer:'e6',decision:{...outcome('').decision!,address:'older',recordedAt:now-31*86400}}),independent=outcome('independent',{employer:'e7',judge:'independent'});
 const score=recentWorkerReputation('worker',parties,[...passes,...failures,older,independent],now);
 assert.equal(score.acceptedOutcomes,7);assert.equal(score.evidence.filter(item=>item.verdict==='fail').length,2);assert.ok(score.evidence.filter(item=>item.verdict==='fail').every(item=>item.weight>0.99));assert.ok(score.evidence.some(item=>item.escrow==='older'));assert.ok(score.evidence.some(item=>item.escrow==='independent'));assert.equal(score.independentJudges,2);
});
