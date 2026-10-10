import type { JudgeDirectoryTask } from './judge-directory.js';
export const WORKER_REPUTATION_METHOD='independent-judge-v2';
export type ReputationAgent = { address: string; owner: string };
export type RecentReputation = { quality: number | null; confidence: number; rankScore: number; effectiveSamples: number;
  acceptedOutcomes: number; independentEmployers: number; independentJudges: number; ignored: Record<string, number>;
  counterpartyConcentration: number; judgeConcentration: number; risks: string[]; halfLifeDays: number;
  evidence: { escrow: string; decision: string; verdict: 'pass' | 'fail'; recordedAt: number; weight: number }[]; evidenceTruncated: boolean };

type Candidate = {task:JudgeDirectoryTask;employer:string;judge:string;pass:boolean;time:number};
function eligible(task:JudgeDirectoryTask,owners:Map<string,string>,now:number):Candidate|string {
  const decision=task.decision;
  if(!decision?.settled||!['pass','fail'].includes(decision.verdict)||task.escrowStatus!==(decision.verdict==='pass'?'released':'refunded')||!task.resultHash)return 'no-final-judge-outcome';
  const worker=owners.get(task.worker),employer=owners.get(task.employer),judge=owners.get(task.judge);
  if(!worker||!employer||!judge)return 'unknown-owner';
  if(worker===employer||worker===judge||employer===judge)return 'related-owner';
  if(!Number.isSafeInteger(decision.recordedAt)||decision.recordedAt<=0||decision.recordedAt>now)return 'invalid-time';
  return {task,employer,judge,pass:decision.verdict==='pass',time:decision.recordedAt};
}
type TradingGraph={edges:Map<string,Set<string>>;component:Map<string,number>};
/** Recent successful, independently judged Owner trades only. Iterative SCC
 * traversal avoids recursion limits for a large registry or a long ring. */
function tradingGraph(owners:Map<string,string>,outcomes:JudgeDirectoryTask[],now:number):TradingGraph {
  const edges=new Map<string,Set<string>>(),reverse=new Map<string,Set<string>>(),seen=new Set<string>();
  for(const task of outcomes){
    if(seen.has(task.escrow))continue;seen.add(task.escrow);
    const item=eligible(task,owners,now);
    if(typeof item==='string'||!item.pass||now-item.time>90*86400)continue;
    const worker=owners.get(task.worker)!;
    if(!edges.has(item.employer))edges.set(item.employer,new Set());edges.get(item.employer)!.add(worker);
    if(!edges.has(worker))edges.set(worker,new Set());
    if(!reverse.has(worker))reverse.set(worker,new Set());reverse.get(worker)!.add(item.employer);
  }
  const visited=new Set<string>(),order:string[]=[];
  for(const root of edges.keys()){
    if(visited.has(root))continue;visited.add(root);
    const stack:{node:string;next:Iterator<string>}[]=[{node:root,next:edges.get(root)!.values()}];
    while(stack.length){const frame=stack[stack.length-1],next=frame.next.next();
      if(next.done){order.push(frame.node);stack.pop();}
      else if(!visited.has(next.value)){visited.add(next.value);stack.push({node:next.value,next:edges.get(next.value)!.values()});}
    }
  }
  const component=new Map<string,number>();let index=0;
  for(const root of order.reverse()){
    if(component.has(root))continue;index++;component.set(root,index);const stack=[root];
    while(stack.length){const node=stack.pop()!;for(const parent of reverse.get(node)??[]){if(!component.has(parent)){component.set(parent,index);stack.push(parent);}}}
  }
  return {edges,component};
}
/** Compute one graph and one evaluation timestamp for the entire directory. */
export function createWorkerReputationIndex(agents:ReputationAgent[],outcomes:JudgeDirectoryTask[],now=Math.floor(Date.now()/1000)){
  const owners=new Map(agents.map(agent=>[agent.address,agent.owner])),graph=tradingGraph(owners,outcomes,now);
  const byWorker=new Map<string,JudgeDirectoryTask[]>();
  for(const task of outcomes){if(!byWorker.has(task.worker))byWorker.set(task.worker,[]);byWorker.get(task.worker)!.push(task);}
  return {evaluatedAt:now,score:(worker:string)=>scoreWorker(worker,owners,byWorker.get(worker)??[],now,graph)};
}
/** Takes only canonically verified, finalized Judge/Escrow snapshots. Owner
 * releases, expiry refunds and catalog reviews never become quality ratings. */
export function recentWorkerReputation(worker: string, agents: ReputationAgent[], outcomes: JudgeDirectoryTask[], now = Math.floor(Date.now() / 1000)): RecentReputation {
  return createWorkerReputationIndex(agents,outcomes,now).score(worker);
}
function scoreWorker(worker:string,owners:Map<string,string>,outcomes:JudgeDirectoryTask[],now:number,graph:TradingGraph):RecentReputation {
  const workerOwner = owners.get(worker);
  const ignored: Record<string, number> = {}; const ignore = (reason: string) => { ignored[reason] = (ignored[reason] ?? 0) + 1; };
  const candidates:Candidate[]=[];const seen=new Set<string>();
  for(const task of outcomes.filter(task=>task.worker===worker)){
    if(seen.has(task.escrow)){ignore('duplicate-escrow');continue;}seen.add(task.escrow);
    const item=eligible(task,owners,now);if(typeof item==='string'){ignore(item);continue;}candidates.push(item);
  }
  // One conservative outcome per employer-owner/day. A failure wins over a
  // same-day pass so a burst of successes cannot wash out that day's failure.
  const byDay = new Map<string, typeof candidates[number]>();
  for (const item of candidates.sort((a, b) => Number(a.pass) - Number(b.pass) || b.time - a.time || a.task.escrow.localeCompare(b.task.escrow))) {
    const key = item.employer + ':' + Math.floor(item.time / 86400);
    if (byDay.has(key)) { ignore('repeated-pair-day'); continue; } byDay.set(key, item);
  }
  const counts = new Map<string, number>(), positiveJudgeDays=new Set<string>(),positiveJudgeWindows=new Map<string,number>(), employers = new Map<string, number>(), judges = new Map<string, number>();
  let total = 0, passed = 0, accepted = 0; const risks = new Set<string>(); const evidence: RecentReputation['evidence'] = [];
  for (const item of [...byDay.values()].sort((a, b) => Number(a.pass) - Number(b.pass) || b.time - a.time || a.task.escrow.localeCompare(b.task.escrow))) {
    const window = item.employer + ':' + Math.floor((now - item.time) / (30 * 86400));
    if ((counts.get(window) ?? 0) >= 3) { ignore('repeated-pair-window'); continue; }
    // Different Employer keys cannot turn one Judge Owner into unlimited
    // positive evidence. Failures never lose weight under this new cap.
    const judgeDay=item.judge+':'+Math.floor(item.time/86400),judgeWindow=item.judge+':'+Math.floor((now-item.time)/(30*86400));
    if(item.pass&&positiveJudgeDays.has(judgeDay)){ignore('repeated-judge-day');risks.add('concentrated-positive-judgments');continue;}
    if(item.pass&&(positiveJudgeWindows.get(judgeWindow)??0)>=3){ignore('repeated-judge-window');risks.add('concentrated-positive-judgments');continue;}
    let weight = 2 ** (-(now - item.time) / (90 * 86400));
    if(item.pass&&now-item.time<=90*86400&&graph.component.has(workerOwner!)&&graph.component.get(workerOwner!)===graph.component.get(item.employer)){
      weight*=0.25;risks.add(graph.edges.get(workerOwner!)?.has(item.employer)?'reciprocal-trading':'circular-trading');
    }
    if (weight < 0.001) { ignore('decayed-below-threshold'); continue; }
    counts.set(window,(counts.get(window)??0)+1);
    if(item.pass){positiveJudgeDays.add(judgeDay);positiveJudgeWindows.set(judgeWindow,(positiveJudgeWindows.get(judgeWindow)??0)+1);}
    accepted++; total += weight; if (item.pass) passed += weight;
    if(evidence.length<50)evidence.push({escrow:item.task.escrow,decision:item.task.decision!.address,verdict:item.pass?'pass':'fail',recordedAt:item.time,weight:Math.round(weight*1000000)/1000000});
    employers.set(item.employer, (employers.get(item.employer) ?? 0) + weight); judges.set(item.judge, (judges.get(item.judge) ?? 0) + weight);
  }
  const concentration = (values: Map<string, number>) => total ? Math.max(...values.values()) / total : 0;
  const counterpartyConcentration = concentration(employers), judgeConcentration = concentration(judges);
  if (counterpartyConcentration > 0.5) risks.add('concentrated-employers'); if (judgeConcentration > 0.5) risks.add('concentrated-judges');
  const confidence = total / (total + 10) * (1 - 0.5 * Math.max(counterpartyConcentration, judgeConcentration));
  const quality = total ? (passed + 3) / (total + 5) * 100 : null;
  return { quality: quality === null ? null : Math.round(quality * 100) / 100, confidence: Math.round(confidence * 10000) / 10000,
    rankScore: Math.round(((quality ?? 60) - 30 * (1 - confidence)) * 100), effectiveSamples: Math.round(total * 1000) / 1000,
    acceptedOutcomes: accepted, independentEmployers: employers.size, independentJudges: judges.size, ignored,
    counterpartyConcentration: Math.round(counterpartyConcentration * 10000) / 10000, judgeConcentration: Math.round(judgeConcentration * 10000) / 10000,
    risks: [...risks].sort(), halfLifeDays: 90, evidence, evidenceTruncated: accepted>evidence.length };
}
